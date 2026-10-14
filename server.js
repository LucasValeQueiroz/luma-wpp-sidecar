/**
 * =====================================================================
 *  LUMA WPP SIDECAR — v3 (Grupos + Entrada de Fornecedores + Fila Anti-Ban)
 * =====================================================================
 *
 *  Papel deste serviço no ecossistema:
 *
 *    API OFICIAL (Meta Cloud API)  → atendimento 1-a-1, IA de vendas, frete,
 *                                    pagamento. É o número que VENDE.
 *    ESTE SIDECAR (Baileys)        → só GRUPOS: escuta fornecedores, publica
 *                                    ofertas nos grupos de clientes e manda
 *                                    todo interessado para o número oficial.
 *
 *  O que mudou em relação à v2:
 *
 *  1) FILA DE ENVIO ANTI-BAN (coleção `envio_fila`)
 *     Nada mais sai "na hora" e em rajada. Toda publicação em grupo entra
 *     numa fila persistente e sai com cadência humana: intervalo aleatório
 *     entre mensagens, "digitando..." antes de enviar, limites por hora,
 *     por dia e por grupo, e janela de horário (não posta de madrugada).
 *     Reinício do Render não perde nada; idempotencyKey evita post duplicado.
 *
 *  2) RESPOSTA NO GRUPO → NÚMERO OFICIAL (opcional, por grupo)
 *     Cliente que responde "quero" citando um post nosso recebe, no próprio
 *     grupo, uma menção com o link do número oficial daquele produto.
 *     Ninguém fica sem caminho para comprar.
 *
 *  3) LID (Baileys v7)
 *     Participantes e remetentes que aparecem como @lid agora são resolvidos
 *     para o telefone real (phoneNumber / participantAlt / lidMapping).
 *
 *  4) CONEXÃO MAIS ESTÁVEL
 *     Socket antigo é encerrado antes de abrir outro; backoff progressivo;
 *     tratamento de 440 (outra instância assumiu) e 515 (restart);
 *     getMessage para reenvio de mensagens que falharam ao descriptografar;
 *     cache de metadados dos grupos; desligamento gracioso no deploy.
 *
 *  5) EMBEDDED SIGNUP (Coexistence) montado ANTES do guard da API,
 *     porque /conectar e /api/es/finalizar são chamados pelo navegador.
 *
 *  6) CONTATOS DO APARELHO + CRIAÇÃO COMPLETA DE GRUPO
 *     A agenda do celular auxiliar (só nome e número — nenhuma mensagem)
 *     fica disponível em /api/contatos para o painel montar grupos.
 *     /api/criar-grupo cria com descrição, permissões e link de convite.
 *
 *  ---------------------------------------------------------------------
 *  VARIÁVEIS DE AMBIENTE (Render → Environment) — veja .env.example
 *  ---------------------------------------------------------------------
 *  MONGO_URI, API_SECRET (obrigatórias)
 *  ENVIO_* (opcionais — limites da fila; também ajustáveis pelo painel)
 *  META_* / APPS_SCRIPT_* (opcionais — só para o Embedded Signup)
 *  WA_VERSION (opcional — força a versão do WhatsApp Web, ex.: 2.3000.1050340960)
 * =====================================================================
 */

const express = require('express');
const {
    default: makeWASocket,
    DisconnectReason,
    initAuthCreds,
    BufferJSON,
    downloadMediaMessage,
    fetchLatestWaWebVersion,
    jidNormalizedUser,
    S_WHATSAPP_NET
} = require('@whiskeysockets/baileys');
const { MongoClient, ObjectId } = require('mongodb');
const qrcode = require('qrcode');
const pino = require('pino');
const crypto = require('crypto');

const app = express();
// Limite alto porque as fotos dos produtos trafegam em base64 nas rotas de envio.
app.use(express.json({ limit: '30mb' }));

const MONGO_URI = process.env.MONGO_URI;
const API_SECRET = process.env.API_SECRET || '';
const DBNAME = 'whatsapp_auth';
const COLLECTION = 'auth_info';
const COL_ENTRADA_CFG = 'entrada_config';
const COL_ENTRADA_FILA = 'entrada_fila';
const COL_ENVIO_FILA = 'envio_fila';
const COL_ENVIO_CFG = 'envio_config';
const COL_CONTATOS = 'contatos_wa';

const TZ_ENVIO = process.env.TZ_ENVIO || 'America/Sao_Paulo';
// O Render informa o commit publicado; aparece no /ping para conferir se o deploy entrou.
const VERSAO_PUBLICADA = String(process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || 'local';
let processadorImagem = 'verificando';   // sharp carregou? (aparece no /ping e no /api/health)
const DIA_MS = 24 * 60 * 60 * 1000;

let sock;
let mongoClient;
let qrCodeBase64 = '';
let isConnected = false;
let mongoCollection;
let colEntradaCfg;
let colEntradaFila;
let colEnvioFila;
let colEnvioCfg;
let colContatos;
let reconnectTimeout;
let conectando = false;             // trava contra reconexões sobrepostas
let encerrando = false;             // SIGTERM recebido: não reconecta mais
let inicioTentativaConexao = 0;     // usado pelo watchdog e pelo diagnóstico
let ultimoMotivoQueda = '';         // código da última desconexão, para o painel
let quedasSeguidas = 0;             // para o backoff progressivo
let conectadoDesde = 0;
const timers = [];

// Cache em memória da configuração de entrada — evita ir ao Mongo a cada mensagem.
let entradaCfg = { webhookUrl: '', secret: '', grupos: [], gruposResposta: [] };
let entradaGruposSet = new Set();
let respostaGruposMap = new Map();  // groupId -> { nome, modo, link, texto }

// Mensagens já processadas nesta instância (anti-duplicata local).
const jaVistas = new Set();

// =====================================================================
// UTILITÁRIOS
// =====================================================================
const dormir = (ms) => new Promise(r => setTimeout(r, ms));
const numEnv = (v, padrao) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : padrao;
};
const aleatorio = (min, max) => min + Math.random() * Math.max(0, max - min);
const soDigitos = (v) => String(v || '').replace(/\D/g, '');

function horaLocal(d = new Date()) {
    // "HH:mm" no fuso das publicações (America/Sao_Paulo por padrão)
    return new Intl.DateTimeFormat('en-GB', {
        timeZone: TZ_ENVIO, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).format(d);
}

function minutosDe(hhmm) {
    const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// Extrai só o telefone de um JID (@s.whatsapp.net), ignorando sufixo de aparelho (":12").
function numeroDoJid(jid) {
    const s = String(jid || '');
    if (!s || s.includes('@lid') || s.includes('@g.us')) return '';
    return soDigitos(s.split('@')[0].split(':')[0]);
}

// Resolve um JID que pode estar em formato LID para o telefone real, quando possível.
async function resolverTelefone(jid, alternativo) {
    const direto = numeroDoJid(jid) || numeroDoJid(alternativo);
    if (direto) return direto;
    try {
        const repo = sock && sock.signalRepository && sock.signalRepository.lidMapping;
        if (repo && String(jid || '').includes('@lid')) {
            const pn = await repo.getPNForLID(jid);
            return numeroDoJid(pn);
        }
    } catch (e) { /* mapeamento ainda não conhecido */ }
    return '';
}

// =====================================================================
// AUTENTICAÇÃO
// ---------------------------------------------------------------------
// Este repositório é PÚBLICO. Todo mundo consegue ler exatamente quais
// rotas existem e qual payload cada uma espera — e tudo bem, desde que a
// segurança venha da CHAVE e não do segredo do código.
//
// Por isso o API_SECRET é OBRIGATÓRIO. Sem ele o serviço:
//   • recusa 100% das rotas /api com 503;
//   • NÃO conecta no WhatsApp (logo, não gera QR Code nenhum).
// =====================================================================
const SEGREDO_VALIDO = !!API_SECRET && API_SECRET.length >= 20;

// Comparação em tempo constante: evita descobrir a chave medindo o tempo
// de resposta byte a byte.
function chaveConfere(enviada) {
    const a = Buffer.from(String(enviada || ''));
    const b = Buffer.from(API_SECRET);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function apiKeyGuard(req, res, next) {
    if (!SEGREDO_VALIDO) {
        return res.status(503).json({
            status: 'error',
            message: 'Serviço bloqueado: defina a variável de ambiente API_SECRET (mínimo 20 caracteres) no Render.'
        });
    }
    if (!chaveConfere(req.headers['x-api-key'])) {
        console.warn(`🚫 Tentativa de acesso com chave inválida em ${req.path}`);
        return res.status(401).json({ status: 'error', message: 'Chave de API inválida.' });
    }
    next();
}

/**
 * ROTA PÚBLICA DE PING — de propósito fora do /api e sem autenticação.
 * Aponte um monitor de uptime (UptimeRobot, cron-job.org) para /ping a cada
 * 10 minutos: o Render grátis hiberna após ~15 min e cada hibernação derruba
 * a sessão do WhatsApp. Não devolve nada sensível.
 */
app.get('/ping', (req, res) => {
    // versão (commit que o Render publicou) e foto: para saber de fora se o deploy entrou.
    res.json({ ok: true, conectado: isConnected, versao: VERSAO_PUBLICADA, foto: processadorImagem });
});

// =====================================================================
// EMBEDDED SIGNUP (Coexistence) — rotas PÚBLICAS, montadas antes do guard.
// /conectar é a página que o cliente abre; /api/es/finalizar é chamado
// pelo navegador dele (que não tem, nem pode ter, a API_SECRET).
// =====================================================================
// O módulo usa a URL do Apps Script que o próprio CRM sincronizou (se APPS_SCRIPT_URL
// não estiver definida) e o Mongo para não perder um onboarding se o GAS estiver fora.
app.locals.gasUrl = () => entradaCfg.webhookUrl;
try {
    const embeddedSignup = require('./embedded-signup');
    app.use(embeddedSignup);
} catch (e) {
    console.warn('ℹ️ embedded-signup.js não carregado:', e.message);
}

app.use('/api', apiKeyGuard);

// =====================================================================
// PERSISTÊNCIA DA SESSÃO NO MONGO
// =====================================================================
async function useMongoDBAuthState(collection) {
    const writeData = (data, id) => collection.replaceOne(
        { _id: id },
        { _id: id, data: JSON.stringify(data, BufferJSON.replacer) },
        { upsert: true }
    );

    const readData = async (id) => {
        const doc = await collection.findOne({ _id: id });
        return doc ? JSON.parse(doc.data, BufferJSON.reviver) : null;
    };

    const removeData = async (id) => collection.deleteOne({ _id: id });

    const creds = await readData('creds') || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async id => {
                        const value = await readData(`${type}-${id}`);
                        if (value) data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) tasks.push(writeData(value, key));
                            else tasks.push(removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
}

// =====================================================================
// CACHE DE METADADOS DOS GRUPOS + MENSAGENS ENVIADAS
// ---------------------------------------------------------------------
// Sem cachedGroupMetadata, CADA envio para grupo dispara uma consulta extra
// ao WhatsApp (tráfego a mais, mais chance de "rate-overlimit").
// Sem getMessage, quando um participante não consegue descriptografar a
// mensagem e pede reenvio, o Baileys não tem o que reenviar — e a pessoa vê
// "Aguardando mensagem..." para sempre.
// =====================================================================
const cacheGrupos = new Map();          // jid -> { meta, ts }
const CACHE_GRUPO_MS = 5 * 60 * 1000;
const mensagensEnviadas = new Map();    // id -> proto.IMessage
const MAX_MSG_GUARDADAS = 400;

async function metadadosGrupo(jid, forcar) {
    const c = cacheGrupos.get(jid);
    if (!forcar && c && Date.now() - c.ts < CACHE_GRUPO_MS) return c.meta;
    const meta = await sock.groupMetadata(jid);
    cacheGrupos.set(jid, { meta, ts: Date.now() });
    return meta;
}

function guardarMensagemEnviada(msg) {
    if (!msg || !msg.key || !msg.key.id || !msg.message) return;
    mensagensEnviadas.set(msg.key.id, msg.message);
    if (mensagensEnviadas.size > MAX_MSG_GUARDADAS) {
        const primeiro = mensagensEnviadas.keys().next().value;
        mensagensEnviadas.delete(primeiro);
    }
}

// =====================================================================
// CONTATOS DO APARELHO AUXILIAR
// ---------------------------------------------------------------------
// Ao parear, o WhatsApp manda para o aparelho conectado a agenda do
// celular (nome salvo + número) e a lista de conversas. Guardamos SÓ
// isso — nome, número e de onde veio — para o painel montar grupos.
// Nenhuma mensagem é gravada. Ficam em memória (busca instantânea) e no
// Mongo (sobrevivem ao reinício do Render).
// =====================================================================
const contatosWa = new Map();           // chave (telefone ou LID) -> contato
const contatosAlterados = new Set();    // chaves a gravar no Mongo
const contatosRemovidos = new Set();    // chaves a apagar (LID que virou telefone)
let contatosAtualizadosEm = null;
let sincronizandoContatos = false;
const COLECAO_AGENDA = 'critical_unblock_low';   // coleção do app-state com a agenda

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const jidSemContato = (jid) => /@(g\.us|broadcast|newsletter)$/.test(jid);

/**
 * Junta contatos vindos do WhatsApp ao cadastro em memória.
 * origem: 'agenda' (nome salvo no celular) | 'conversa' (histórico de chats)
 */
async function registrarContatos(lista, origem) {
    if (!Array.isArray(lista) || !lista.length) return 0;
    const meuNumero = numeroDoJid(sock && sock.user && sock.user.id);
    let alterados = 0;

    for (const c of lista) {
        const id = String((c && c.id) || '');
        if (!id || jidSemContato(id)) continue;
        const lid = String(c.lid || (id.endsWith('@lid') ? id : ''));
        let numero = numeroDoJid(c.phoneNumber) || numeroDoJid(id);
        if (!numero && lid) numero = await resolverTelefone(lid);
        if (numero && (numero === meuNumero || numero.length < 8 || numero.length > 15)) continue;
        const chave = numero || lid;
        if (!chave) continue;

        const nome = String(c.name || '').trim();
        // Agenda sem nome = contato removido do celular: não cria cadastro novo.
        const conhecido = contatosWa.has(chave) || (lid && contatosWa.has(lid));
        if (origem === 'agenda' && !nome && !c.notify && !conhecido) continue;

        let atual = contatosWa.get(chave);
        // Contato que antes só tinha LID e agora tem telefone: troca de chave.
        if (!atual && numero && lid && contatosWa.has(lid)) {
            atual = contatosWa.get(lid);
            contatosWa.delete(lid);
            contatosAlterados.delete(lid);
            contatosRemovidos.add(lid);
        }
        atual = atual || { _id: chave, numero: '', lid: '', nome: '', notify: '', agenda: false, conversa: false };

        const novo = {
            ...atual,
            _id: chave,
            numero: numero || atual.numero,
            lid: lid || atual.lid,
            notify: String(c.notify || '').trim() || atual.notify
        };
        if (origem === 'agenda' && nome) { novo.nome = nome; novo.agenda = true; }
        if (origem === 'conversa') {
            novo.conversa = true;
            if (nome && !atual.agenda) novo.nome = nome;   // nome da agenda tem prioridade
        }

        if (JSON.stringify(novo) !== JSON.stringify(atual)) {
            contatosWa.set(chave, novo);
            contatosAlterados.add(chave);
            alterados++;
        }
    }
    if (alterados) contatosAtualizadosEm = new Date();
    return alterados;
}

// contacts.update chega a cada mensagem recebida (nome de perfil). Só
// atualiza quem já está no cadastro — senão todo membro de todo grupo
// viraria "contato".
function atualizarNomesDePerfil(lista) {
    for (const u of (lista || [])) {
        if (!u || !u.notify) continue;
        const chave = numeroDoJid(u.id) || String(u.id || '');
        const atual = contatosWa.get(chave);
        if (!atual || atual.notify === u.notify) continue;
        contatosWa.set(chave, { ...atual, notify: String(u.notify) });
        contatosAlterados.add(chave);
    }
}

async function gravarContatosPendentes() {
    if (!colContatos || (!contatosAlterados.size && !contatosRemovidos.size)) return;
    const ops = [];
    for (const chave of contatosRemovidos) ops.push({ deleteOne: { filter: { _id: chave } } });
    for (const chave of contatosAlterados) {
        const c = contatosWa.get(chave);
        if (c) ops.push({ replaceOne: { filter: { _id: chave }, replacement: { ...c, atualizadoEm: new Date() }, upsert: true } });
    }
    contatosRemovidos.clear();
    contatosAlterados.clear();
    try {
        for (let i = 0; i < ops.length; i += 500) await colContatos.bulkWrite(ops.slice(i, i + 500), { ordered: false });
    } catch (e) {
        console.warn('⚠️ Falha ao gravar contatos no Mongo:', e.message);
    }
}

async function carregarContatosSalvos() {
    contatosWa.clear();
    const docs = await colContatos.find({}).toArray();
    docs.forEach(d => contatosWa.set(String(d._id), {
        _id: String(d._id), numero: d.numero || '', lid: d.lid || '', nome: d.nome || '',
        notify: d.notify || '', agenda: !!d.agenda, conversa: !!d.conversa
    }));
    if (docs.length) console.log(`📇 ${docs.length} contato(s) do aparelho carregados.`);
}

// Sessão apagada ou deslogada: os contatos eram daquele número.
async function apagarContatosDoAparelho() {
    contatosWa.clear();
    contatosAlterados.clear();
    contatosRemovidos.clear();
    contatosAtualizadosEm = null;
    if (colContatos) await colContatos.deleteMany({});
}

// =====================================================================
// CONFIGURAÇÃO DA ESCUTA (entrada de fornecedores + resposta em grupos)
// =====================================================================
function aplicarConfigEntrada(cfg) {
    entradaCfg = {
        webhookUrl: cfg.webhookUrl || '',
        secret: cfg.secret || '',
        grupos: Array.isArray(cfg.grupos) ? cfg.grupos : [],
        gruposResposta: Array.isArray(cfg.gruposResposta) ? cfg.gruposResposta : []
    };
    entradaGruposSet = new Set(entradaCfg.grupos.map(g => String(g.groupId)));
    respostaGruposMap = new Map();
    entradaCfg.gruposResposta.forEach(g => {
        const id = String(g.groupId || '');
        const modo = String(g.modo || 'desligado');
        if (!id.endsWith('@g.us') || modo === 'desligado') return;
        respostaGruposMap.set(id, {
            nome: String(g.nome || ''),
            modo: modo,                       // 'citacao' | 'citacao_e_palavras'
            link: String(g.link || ''),       // link genérico do número oficial para o grupo
            texto: String(g.texto || '')      // modelo opcional da resposta
        });
    });
}

async function carregarConfigEntrada() {
    try {
        const doc = await colEntradaCfg.findOne({ _id: 'config' });
        if (doc) aplicarConfigEntrada(doc);
        console.log(`🎧 Escuta: ${entradaGruposSet.size} grupo(s) de entrada, ${respostaGruposMap.size} grupo(s) com resposta automática.`);
    } catch (e) {
        console.error('Falha ao carregar config de entrada:', e.message);
    }
}

async function salvarConfigEntrada(cfg) {
    aplicarConfigEntrada(cfg);
    await colEntradaCfg.replaceOne({ _id: 'config' }, { _id: 'config', ...entradaCfg }, { upsert: true });
    console.log(`💾 Config salva: ${entradaGruposSet.size} entrada(s), ${respostaGruposMap.size} resposta(s).`);
}

// =====================================================================
// ENTREGA AO APPS SCRIPT (com fila de reenvio)
// =====================================================================
async function postarNoAppsScript(payload) {
    // O Apps Script responde 302 para script.googleusercontent.com; o fetch
    // nativo segue o redirecionamento. Timeout: o GAS pode chamar o Gemini.
    const resp = await fetch(entradaCfg.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'follow',
        signal: AbortSignal.timeout(120000)
    });
    const texto = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${texto.slice(0, 200)}`);
    let json = null;
    try { json = JSON.parse(texto); } catch (e) { /* GAS pode devolver HTML em erro */ }
    if (!json) {
        // HTML com 200 = página de erro/login do Google (URL /dev, implantação errada).
        throw new Error('Apps Script respondeu sem JSON (confira se a URL é a /exec da implantação atual).');
    }
    return json;
}

async function entregarAoAppsScript(payload) {
    if (!entradaCfg.webhookUrl) {
        console.warn('⚠️ Sem webhookUrl configurada — guardando na fila.');
        await enfileirarEntrada(payload, 'sem webhookUrl');
        return false;
    }
    try {
        const json = await postarNoAppsScript(payload);
        if (json.status === 'error') {
            // Erro de negócio (grupo não cadastrado, segredo errado) não adianta repetir.
            console.error('❌ Apps Script recusou:', json.message);
            return false;
        }
        console.log('✅ Entrada entregue ao Apps Script.', json.entradaId || json.message || '');
        return true;
    } catch (e) {
        console.error('❌ Falha ao entregar ao Apps Script:', e.message);
        await enfileirarEntrada(payload, e.message);
        return false;
    }
}

async function enfileirarEntrada(payload, motivo) {
    try {
        await colEntradaFila.insertOne({
            payload,
            motivo: String(motivo || ''),
            status: 'pendente',
            tentativas: 0,
            criadoEm: new Date()
        });
        console.log('📥 Mensagem guardada na fila de reenvio.');
    } catch (e) {
        console.error('Falha ao enfileirar:', e.message);
    }
}

// Worker: reprocessa a fila a cada minuto, no máximo 5 tentativas por item.
// Depois disso o item fica como "falhou" (some sozinho em 14 dias) em vez de
// ficar contando como pendente para sempre.
async function processarFilaPendente() {
    if (!colEntradaFila || !entradaCfg.webhookUrl) return;
    try {
        const pendentes = await colEntradaFila
            .find({ status: { $ne: 'falhou' }, tentativas: { $lt: 5 } })
            .sort({ criadoEm: 1 }).limit(5).toArray();
        for (const item of pendentes) {
            let ok = false;
            try {
                await postarNoAppsScript(item.payload);
                ok = true;   // inclusive erro de negócio: não adianta insistir
            } catch (e) {
                ok = false;
            }
            if (ok) {
                await colEntradaFila.deleteOne({ _id: item._id });
            } else {
                const tentativas = (item.tentativas || 0) + 1;
                const set = { ultimaTentativa: new Date(), tentativas };
                if (tentativas >= 5) {
                    set.status = 'falhou';
                    set.expiraEm = new Date(Date.now() + 14 * DIA_MS);
                }
                await colEntradaFila.updateOne({ _id: item._id }, { $set: set });
            }
        }
    } catch (e) {
        console.error('Erro no worker da fila de entrada:', e.message);
    }
}

// =====================================================================
// LEITURA DAS MENSAGENS DOS GRUPOS
// =====================================================================
function desembrulhar(m) {
    // Mensagens efêmeras, "view once" e documento-com-legenda vêm embrulhadas
    return m.ephemeralMessage?.message || m.viewOnceMessage?.message ||
           m.viewOnceMessageV2?.message || m.viewOnceMessageV2Extension?.message ||
           m.documentWithCaptionMessage?.message || m;
}

function extrairConteudo(msg) {
    const inner = desembrulhar(msg.message || {});

    if (inner.imageMessage) {
        return { tipo: 'imagem', legenda: inner.imageMessage.caption || '', mime: inner.imageMessage.mimetype || 'image/jpeg', ctx: inner.imageMessage.contextInfo };
    }
    if (inner.videoMessage) {
        return { tipo: 'video', legenda: inner.videoMessage.caption || '', mime: inner.videoMessage.mimetype || 'video/mp4', ctx: inner.videoMessage.contextInfo };
    }
    if (inner.conversation) {
        return { tipo: 'texto', legenda: inner.conversation, mime: '', ctx: null };
    }
    if (inner.extendedTextMessage) {
        return { tipo: 'texto', legenda: inner.extendedTextMessage.text || '', mime: '', ctx: inner.extendedTextMessage.contextInfo };
    }
    return null;
}

function marcarVista(id) {
    if (!id || jaVistas.has(id)) return false;
    jaVistas.add(id);
    if (jaVistas.size > 800) {                          // não deixa a memória crescer
        const it = jaVistas.values();
        for (let i = 0; i < 300; i++) jaVistas.delete(it.next().value);
    }
    return true;
}

// ---- 1) GRUPOS DE ENTRADA (fornecedores) ---------------------------
async function tratarMensagemDeEntrada(msg) {
    try {
        const jid = msg.key.remoteJid;
        if (!marcarVista(msg.key.id)) return;

        const conteudo = extrairConteudo(msg);
        if (!conteudo) return;

        // Vídeo não vira produto: ignoramos para não gastar banda do Render.
        if (conteudo.tipo === 'video') return;

        let imagemBase64 = null;
        let mimeType = '';

        if (conteudo.tipo === 'imagem') {
            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
                    logger: pino({ level: 'silent' }),
                    reuploadRequest: sock.updateMediaMessage
                });
                // Guarda-chuva contra fotos gigantes (limite prático do Apps Script)
                if (buffer && buffer.length <= 6 * 1024 * 1024) {
                    imagemBase64 = buffer.toString('base64');
                    mimeType = conteudo.mime;
                } else {
                    console.warn('⚠️ Imagem maior que 6MB — enviando só a legenda.');
                }
            } catch (e) {
                console.error('Falha ao baixar a mídia:', e.message);
            }
        }

        const grupo = entradaCfg.grupos.find(g => String(g.groupId) === jid) || {};
        const remetente = await resolverTelefone(msg.key.participant, msg.key.participantAlt);

        console.log(`📸 Entrada detectada no grupo "${grupo.nome || jid}" (${conteudo.tipo}).`);

        await entregarAoAppsScript({
            tipo: 'entrada_grupo',
            secret: entradaCfg.secret,
            groupId: jid,
            groupNome: grupo.nome || '',
            messageId: msg.key.id,
            remetente: remetente,
            legenda: conteudo.legenda || '',
            imagemBase64: imagemBase64,
            mimeType: mimeType
        });
    } catch (e) {
        console.error('Erro ao tratar mensagem de entrada:', e.message);
    }
}

// ---- 2) GRUPOS DE CLIENTES: quem responde ao post vai para o oficial --
// Anti-spam da própria resposta: 1 por pessoa+produto a cada 6h e no
// máximo 1 resposta "genérica" por grupo a cada 3 minutos.
const respondidos = new Map();       // `${grupo}|${pessoa}|${ref}` -> ts
const ultimaRespostaGrupo = new Map(); // grupo -> ts
const RE_INTERESSE = /\b(quero|eu quero|tenho interesse|interess|valor|pre[cç]o|quanto|como (fa[cç]o|compr)|comprar|tem (no|em|na|tamanho|cor)|dispon[ií]vel|link)\b/i;
const MODELOS_RESPOSTA = [
    '@{numero} para garantir o seu é por aqui 👇\n{link}',
    '@{numero} te atendo agora no nosso WhatsApp oficial 👇\n{link}',
    '@{numero} é só tocar no link que já separo pra você 👇\n{link}',
    '@{numero} finaliza comigo por aqui, rapidinho 👇\n{link}'
];

function limparRespondidos() {
    if (respondidos.size < 2000) return;
    const limite = Date.now() - 6 * 3600 * 1000;
    for (const [k, ts] of respondidos) if (ts < limite) respondidos.delete(k);
}

async function tratarMensagemDeCliente(msg) {
    try {
        const jid = msg.key.remoteJid;
        const cfg = respostaGruposMap.get(jid);
        if (!cfg || !colEnvioFila) return;
        if (!marcarVista(msg.key.id)) return;

        const conteudo = extrairConteudo(msg);
        if (!conteudo) return;

        const pessoaJid = msg.key.participant || '';
        if (!pessoaJid) return;

        // a) Respondeu CITANDO um post nosso? Então sabemos exatamente o produto.
        let link = '', ref = '';
        const citado = conteudo.ctx && conteudo.ctx.stanzaId;
        if (citado) {
            const post = await colEnvioFila.findOne(
                { waMessageId: citado, groupId: jid },
                { projection: { linkResposta: 1, ref: 1 } }
            );
            if (post && post.linkResposta) { link = post.linkResposta; ref = post.ref || citado; }
        }

        // b) Sem citação: só no modo "citacao_e_palavras" e se a frase indicar interesse.
        if (!link) {
            if (cfg.modo !== 'citacao_e_palavras' || !cfg.link) return;
            if (!RE_INTERESSE.test(conteudo.legenda || '')) return;
            const ult = ultimaRespostaGrupo.get(jid) || 0;
            if (Date.now() - ult < 3 * 60 * 1000) return;
            link = cfg.link; ref = 'grupo';
        }

        const chave = `${jid}|${pessoaJid}|${ref}`;
        if (Date.now() - (respondidos.get(chave) || 0) < 6 * 3600 * 1000) return;
        respondidos.set(chave, Date.now());
        if (ref === 'grupo') ultimaRespostaGrupo.set(jid, Date.now());
        limparRespondidos();

        const modelo = cfg.texto && cfg.texto.includes('{link}')
            ? cfg.texto
            : MODELOS_RESPOSTA[Math.floor(Math.random() * MODELOS_RESPOSTA.length)];
        const usuarioMencao = String(pessoaJid).split('@')[0].split(':')[0];
        const texto = modelo.replace('{numero}', usuarioMencao).replace('{link}', link);

        await inserirNaFila({
            groupId: jid,
            tipo: 'texto',
            texto: texto,
            mencoes: [pessoaJid],
            origem: 'resposta-grupo',
            ref: ref,
            prioridade: 8,
            ignorarJanela: true
        });
        console.log(`💬 Resposta ao interessado agendada no grupo "${cfg.nome || jid}".`);
    } catch (e) {
        console.error('Erro ao tratar mensagem de cliente:', e.message);
    }
}

// =====================================================================
// FILA DE ENVIO ANTI-BAN
// =====================================================================
const CFG_ENVIO_PADRAO = {
    intervaloMinSeg: numEnv(process.env.ENVIO_INTERVALO_MIN_SEG, 25),
    intervaloMaxSeg: numEnv(process.env.ENVIO_INTERVALO_MAX_SEG, 60),
    maxPorHora: numEnv(process.env.ENVIO_MAX_POR_HORA, 40),
    maxPorDia: numEnv(process.env.ENVIO_MAX_POR_DIA, 250),
    maxPorGrupoDia: numEnv(process.env.ENVIO_MAX_POR_GRUPO_DIA, 15),
    janelaInicio: process.env.ENVIO_JANELA_INICIO || '08:00',
    janelaFim: process.env.ENVIO_JANELA_FIM || '21:30',
    digitandoSeg: numEnv(process.env.ENVIO_DIGITANDO_SEG, 3),
    pausado: false
};
let cfgEnvio = { ...CFG_ENVIO_PADRAO };

// Estado do worker, para o painel entender por que algo não saiu.
const estadoEnvio = {
    proximoEnvioPermitido: 0,
    ultimoEnvioEm: null,
    ultimoErro: '',
    bloqueio: ''          // motivo atual de espera: 'janela' | 'limite-hora' | 'limite-dia' | 'pausado' | 'desconectado' | ''
};
let workerEnvioRodando = false;
const aguardando = new Map();  // _id (string) -> { resolve, timer }

function validarCfgEnvio(c) {
    const out = { ...cfgEnvio };
    const faixa = (v, min, max, padrao) => {
        const n = parseFloat(v);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : padrao;
    };
    if (c.intervaloMinSeg !== undefined) out.intervaloMinSeg = faixa(c.intervaloMinSeg, 5, 600, out.intervaloMinSeg);
    if (c.intervaloMaxSeg !== undefined) out.intervaloMaxSeg = faixa(c.intervaloMaxSeg, 5, 900, out.intervaloMaxSeg);
    if (out.intervaloMaxSeg < out.intervaloMinSeg) out.intervaloMaxSeg = out.intervaloMinSeg;
    if (c.maxPorHora !== undefined) out.maxPorHora = Math.round(faixa(c.maxPorHora, 1, 500, out.maxPorHora));
    if (c.maxPorDia !== undefined) out.maxPorDia = Math.round(faixa(c.maxPorDia, 1, 3000, out.maxPorDia));
    if (c.maxPorGrupoDia !== undefined) out.maxPorGrupoDia = Math.round(faixa(c.maxPorGrupoDia, 1, 200, out.maxPorGrupoDia));
    if (c.digitandoSeg !== undefined) out.digitandoSeg = faixa(c.digitandoSeg, 0, 15, out.digitandoSeg);
    if (c.janelaInicio !== undefined && minutosDe(c.janelaInicio) !== null) out.janelaInicio = String(c.janelaInicio);
    if (c.janelaFim !== undefined && minutosDe(c.janelaFim) !== null) out.janelaFim = String(c.janelaFim);
    if (c.pausado !== undefined) out.pausado = c.pausado === true;
    return out;
}

async function carregarCfgEnvio() {
    try {
        const doc = await colEnvioCfg.findOne({ _id: 'config' });
        if (doc) cfgEnvio = validarCfgEnvio(doc);
    } catch (e) {
        console.error('Falha ao carregar config de envio:', e.message);
    }
}

function dentroDaJanela(cfg, d = new Date()) {
    const ini = minutosDe(cfg.janelaInicio), fim = minutosDe(cfg.janelaFim);
    if (ini === null || fim === null || ini === fim) return true;
    const agora = minutosDe(horaLocal(d));
    return ini < fim ? (agora >= ini && agora < fim) : (agora >= ini || agora < fim); // janela que cruza a meia-noite
}

function validarItemFila(it) {
    const groupId = String(it.groupId || '');
    // O número auxiliar SÓ fala em grupo. Conversa 1-a-1 é papel do número oficial —
    // e mandar privado pelo auxiliar é exatamente o comportamento que gera banimento.
    if (!groupId.endsWith('@g.us')) throw new Error('groupId inválido (o auxiliar só envia para grupos @g.us).');
    const tipo = it.tipo === 'imagem' ? 'imagem' : 'texto';
    const texto = String(it.texto || it.caption || it.message || '');
    if (tipo === 'texto' && !texto.trim()) throw new Error('Texto vazio.');
    let imagemBase64 = it.imagemBase64 ? String(it.imagemBase64).replace(/^data:[^;]+;base64,/, '') : '';
    if (imagemBase64 && imagemBase64.length > 11 * 1024 * 1024) throw new Error('Imagem maior que ~8MB.');
    const imagemUrl = it.imagemUrl ? String(it.imagemUrl) : '';
    if (tipo === 'imagem' && !imagemBase64 && !imagemUrl) throw new Error('Item de imagem sem imagemBase64/imagemUrl.');
    let agendadoPara = new Date();
    if (it.agendarPara) {
        const d = new Date(it.agendarPara);
        if (!isNaN(d.getTime())) agendadoPara = d;
    }
    return {
        groupId, tipo, texto,
        imagemBase64: imagemBase64 || undefined,
        imagemUrl: imagemUrl || undefined,
        mimeType: String(it.mimeType || 'image/jpeg'),
        mencoes: Array.isArray(it.mencoes) ? it.mencoes.map(String).slice(0, 20) : undefined,
        linkResposta: it.linkResposta ? String(it.linkResposta) : undefined,
        origem: String(it.origem || 'api'),
        ref: it.ref ? String(it.ref) : undefined,
        prioridade: Math.max(0, Math.min(10, parseInt(it.prioridade, 10) || 0)),
        ignorarJanela: it.ignorarJanela === true,
        idempotencyKey: it.idempotencyKey ? String(it.idempotencyKey).slice(0, 200) : undefined,
        status: 'pendente',
        tentativas: 0,
        criadoEm: new Date(),
        agendadoPara
    };
}

// Insere um item já validado (ou valida aqui). Devolve { id, duplicado }.
async function inserirNaFila(item) {
    const doc = item.status ? item : validarItemFila(item);
    Object.keys(doc).forEach(k => doc[k] === undefined && delete doc[k]);
    try {
        const r = await colEnvioFila.insertOne(doc);
        setImmediate(cicloFilaEnvio);
        return { id: String(r.insertedId), duplicado: false };
    } catch (e) {
        if (e && e.code === 11000 && doc.idempotencyKey) {
            const existente = await colEnvioFila.findOne({ idempotencyKey: doc.idempotencyKey }, { projection: { _id: 1 } });
            return { id: existente ? String(existente._id) : '', duplicado: true };
        }
        throw e;
    }
}

function aguardarResultado(id, ms) {
    return new Promise(resolve => {
        const timer = setTimeout(() => { aguardando.delete(id); resolve(null); }, ms);
        aguardando.set(id, { resolve, timer });
    });
}

function avisarAguardando(id, resultado) {
    const w = aguardando.get(String(id));
    if (!w) return;
    clearTimeout(w.timer);
    aguardando.delete(String(id));
    w.resolve(resultado);
}

async function baixarImagemUrl(url) {
    const resp = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ao baixar a imagem');
    const tipo = String(resp.headers.get('content-type') || '');
    // O Drive devolve HTML (página de aviso/login) quando o arquivo não é público.
    if (tipo.includes('text/html')) throw new Error('A URL da imagem devolveu uma página, não uma imagem (arquivo não público?)');
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024) throw new Error('Imagem maior que 8MB');
    return { buffer: buf, mime: tipo.startsWith('image/') ? tipo.split(';')[0] : '' };
}

async function contarEnviados(desde, groupId) {
    const filtro = { status: 'enviado', enviadoEm: { $gte: desde } };
    if (groupId) filtro.groupId = groupId;
    return colEnvioFila.countDocuments(filtro);
}

async function gruposNoLimite(cfg) {
    const agg = await colEnvioFila.aggregate([
        { $match: { status: 'enviado', enviadoEm: { $gte: new Date(Date.now() - DIA_MS) } } },
        { $group: { _id: '$groupId', n: { $sum: 1 } } },
        { $match: { n: { $gte: cfg.maxPorGrupoDia } } }
    ]).toArray();
    return agg.map(g => g._id);
}

async function enviarItem(item) {
    const jid = item.groupId;
    let usouFallbackTexto = false;
    try {
        // Garante metadados em cache (evita consulta extra dentro do sendMessage)
        try { await metadadosGrupo(jid); } catch (e) {
            throw new Error('Grupo inacessível (o número saiu ou foi removido?): ' + e.message);
        }

        // "digitando..." por alguns segundos: é o que um humano faz antes de postar
        if (cfgEnvio.digitandoSeg > 0) {
            try { await sock.sendPresenceUpdate('composing', jid); } catch (e) { /* opcional */ }
            await dormir(aleatorio(cfgEnvio.digitandoSeg * 700, cfgEnvio.digitandoSeg * 1300));
        }

        let conteudo;
        if (item.tipo === 'imagem') {
            let buffer = null, mime = item.mimeType || 'image/jpeg';
            try {
                if (item.imagemBase64) {
                    buffer = Buffer.from(item.imagemBase64, 'base64');
                } else if (item.imagemUrl) {
                    const b = await baixarImagemUrl(item.imagemUrl);
                    buffer = b.buffer; if (b.mime) mime = b.mime;
                }
            } catch (e) {
                console.warn('⚠️ Imagem indisponível, publicando só o texto:', e.message);
            }
            if (buffer && buffer.length) {
                conteudo = { image: buffer, mimetype: mime, caption: item.texto || '' };
            } else {
                conteudo = { text: item.texto || '' };
                usouFallbackTexto = true;
            }
        } else {
            conteudo = { text: item.texto };
        }
        if (item.mencoes && item.mencoes.length) conteudo.mentions = item.mencoes;

        const enviada = await sock.sendMessage(jid, conteudo);
        guardarMensagemEnviada(enviada);
        try { await sock.sendPresenceUpdate('paused', jid); } catch (e) { /* opcional */ }

        await colEnvioFila.updateOne({ _id: item._id }, {
            $set: {
                status: 'enviado', enviadoEm: new Date(),
                waMessageId: (enviada && enviada.key && enviada.key.id) || '',
                fallbackTexto: usouFallbackTexto,
                expiraEm: new Date(Date.now() + 30 * DIA_MS)
            },
            $unset: { imagemBase64: '' }
        });
        estadoEnvio.ultimoEnvioEm = new Date();
        estadoEnvio.ultimoErro = '';
        avisarAguardando(item._id, { status: 'success', message: usouFallbackTexto ? 'Publicado só como texto (imagem indisponível).' : 'Publicado no grupo.' });
        console.log(`📤 Publicado em ${jid} (${item.origem}${item.ref ? ' · ' + item.ref : ''}).`);
    } catch (e) {
        const msg = String(e && e.message || e);
        const tentativas = (item.tentativas || 0) + 1;
        // Queda de conexão no meio do envio NÃO é erro do item: volta para a fila.
        const caiuConexao = !isConnected || /connection (closed|lost)|timed? ?out|stream errored/i.test(msg);
        const definitivo = !caiuConexao && (tentativas >= 3 || /inacess|not-authorized|forbidden|item-not-found|not a participant|inv[aá]lid/i.test(msg));
        await colEnvioFila.updateOne({ _id: item._id }, {
            $set: definitivo
                ? { status: 'erro', erro: msg, tentativas, expiraEm: new Date(Date.now() + 30 * DIA_MS) }
                : { status: 'pendente', erro: msg, tentativas, agendadoPara: new Date(Date.now() + 2 * 60 * 1000 * tentativas) }
        });
        estadoEnvio.ultimoErro = msg;
        if (definitivo) avisarAguardando(item._id, { status: 'error', message: msg });
        console.error(`❌ Falha ao publicar em ${jid} (tentativa ${tentativas}):`, msg);
    }
}

async function cicloFilaEnvio() {
    if (workerEnvioRodando || encerrando || !colEnvioFila) return;
    workerEnvioRodando = true;
    try {
        if (!isConnected) { estadoEnvio.bloqueio = 'desconectado'; return; }
        if (cfgEnvio.pausado) { estadoEnvio.bloqueio = 'pausado'; return; }
        if (Date.now() < estadoEnvio.proximoEnvioPermitido) return;

        const agora = new Date();
        const [nHora, nDia] = await Promise.all([
            contarEnviados(new Date(Date.now() - 3600 * 1000)),
            contarEnviados(new Date(Date.now() - DIA_MS))
        ]);
        if (nDia >= cfgEnvio.maxPorDia) { estadoEnvio.bloqueio = 'limite-dia'; return; }
        if (nHora >= cfgEnvio.maxPorHora) { estadoEnvio.bloqueio = 'limite-hora'; return; }

        const filtro = { status: 'pendente', agendadoPara: { $lte: agora } };
        const lotados = await gruposNoLimite(cfgEnvio);
        if (lotados.length) filtro.groupId = { $nin: lotados };
        const naJanela = dentroDaJanela(cfgEnvio, agora);
        if (!naJanela) filtro.ignorarJanela = true;

        const item = await colEnvioFila.findOneAndUpdate(
            filtro,
            { $set: { status: 'enviando', iniciadoEm: agora } },
            { sort: { prioridade: -1, criadoEm: 1 }, returnDocument: 'after' }
        );
        if (!item) {
            estadoEnvio.bloqueio = naJanela ? '' : 'janela';
            return;
        }
        estadoEnvio.bloqueio = '';

        await enviarItem(item);
        estadoEnvio.proximoEnvioPermitido = Date.now() +
            aleatorio(cfgEnvio.intervaloMinSeg, cfgEnvio.intervaloMaxSeg) * 1000;
    } catch (e) {
        console.error('Erro no worker da fila de envio:', e.message);
    } finally {
        workerEnvioRodando = false;
    }
}

async function resumoFilaEnvio() {
    const [pendentes, nHora, nDia, porStatus] = await Promise.all([
        colEnvioFila.countDocuments({ status: 'pendente' }),
        contarEnviados(new Date(Date.now() - 3600 * 1000)),
        contarEnviados(new Date(Date.now() - DIA_MS)),
        colEnvioFila.aggregate([
            { $match: { criadoEm: { $gte: new Date(Date.now() - 7 * DIA_MS) } } },
            { $group: { _id: '$status', n: { $sum: 1 } } }
        ]).toArray()
    ]);
    const mediaSeg = (cfgEnvio.intervaloMinSeg + cfgEnvio.intervaloMaxSeg) / 2 + cfgEnvio.digitandoSeg;
    const contagem = {};
    porStatus.forEach(s => { contagem[s._id] = s.n; });
    return {
        pendentes,
        enviadosUltimaHora: nHora,
        enviadosUltimas24h: nDia,
        contagem7dias: contagem,
        dentroDaJanela: dentroDaJanela(cfgEnvio),
        horaLocal: horaLocal(),
        bloqueio: cfgEnvio.pausado ? 'pausado' : (isConnected ? estadoEnvio.bloqueio : 'desconectado'),
        proximoEnvioEmSeg: Math.max(0, Math.round((estadoEnvio.proximoEnvioPermitido - Date.now()) / 1000)),
        estimativaEsvaziarMin: Math.round((pendentes * mediaSeg) / 60),
        ultimoEnvioEm: estadoEnvio.ultimoEnvioEm,
        ultimoErro: estadoEnvio.ultimoErro
    };
}

// Usado pelas rotas antigas (/api/enviar-grupo e /api/enviar-grupo-midia):
// enfileira com prioridade e espera até ~40s pelo resultado real.
async function enfileirarEAguardar(item, res) {
    const r = await inserirNaFila(item);
    const resultado = r.duplicado ? null : await aguardarResultado(r.id, 40000);
    if (resultado) return res.json({ ...resultado, id: r.id });
    const resumo = await resumoFilaEnvio();
    return res.json({
        status: 'success',
        enfileirado: true,
        id: r.id,
        message: `Na fila de envio (cadência anti-ban). ${resumo.pendentes} item(ns) aguardando` +
                 (resumo.bloqueio === 'janela' ? ` — fora da janela de horário (${cfgEnvio.janelaInicio}–${cfgEnvio.janelaFim}).` : '.')
    });
}

// =====================================================================
// CONEXÃO COM O WHATSAPP
// =====================================================================
async function connectToWhatsApp() {
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    if (encerrando) return;

    // Trava contra reconexões sobrepostas: o watchdog e o connection.update podem
    // disparar quase juntos, e dois sockets ao mesmo tempo derrubam um ao outro.
    if (conectando) {
        console.log('⏭️ Já existe uma conexão em andamento — ignorando chamada duplicada.');
        return;
    }
    conectando = true;
    inicioTentativaConexao = Date.now();
    console.log('🔄 Inicializando instância do WhatsApp...');

    try {
        await conectarInterno();
    } catch (e) {
        console.error('❌ Falha ao iniciar o socket:', e.message);
        ultimoMotivoQueda = 'erro ao iniciar: ' + e.message;
        reconnectTimeout = setTimeout(connectToWhatsApp, 15000);
    } finally {
        conectando = false;
    }
}

function encerrarSocketAntigo() {
    if (!sock) return;
    try {
        sock.ev.removeAllListeners('connection.update');
        sock.ev.removeAllListeners('creds.update');
        sock.ev.removeAllListeners('messages.upsert');
        sock.ev.removeAllListeners('groups.update');
        sock.ev.removeAllListeners('group-participants.update');
        sock.ev.removeAllListeners('contacts.upsert');
        sock.ev.removeAllListeners('contacts.update');
        sock.ev.removeAllListeners('messaging-history.set');
    } catch (e) { /* silencioso */ }
    // Fecha de verdade o websocket anterior. Só remover os listeners deixava
    // o socket velho vivo, brigando com o novo pela mesma sessão (erro 440).
    try { sock.end(undefined); } catch (e) { /* já estava fechado */ }
}

// ---------------------------------------------------------------------
// VERSÃO DO WHATSAPP WEB
// O Baileys traz embutida a versão do WhatsApp Web da época em que foi
// publicado. Quando ela envelhece, o WhatsApp recusa a conexão com 405
// antes mesmo de gerar o QR — e apagar a sessão não resolve. Por isso a
// versão atual é lida de web.whatsapp.com e renovada a cada 6h (ou logo
// após um 405). WA_VERSION força uma versão manualmente, se a busca falhar.
// ---------------------------------------------------------------------
const STATUS_VERSAO_RECUSADA = 405;
const VERSAO_WA_CACHE_MS = 6 * 60 * 60 * 1000;
let versaoWa = null;                // [2, 3000, N] — null = usa a embutida no Baileys
let versaoWaEm = 0;

function versaoWaManual() {
    const partes = String(process.env.WA_VERSION || '').trim().split('.').map(Number);
    return partes.length === 3 && partes.every(n => Number.isInteger(n) && n >= 0) ? partes : null;
}

async function obterVersaoWa() {
    const manual = versaoWaManual();
    if (manual) return manual;
    if (versaoWa && Date.now() - versaoWaEm < VERSAO_WA_CACHE_MS) return versaoWa;

    // fetchLatestWaWebVersion não lança erro: em falha devolve isLatest=false.
    const r = await fetchLatestWaWebVersion({ signal: AbortSignal.timeout(10000) });
    if (r && r.isLatest && Array.isArray(r.version)) {
        if (!versaoWa || versaoWa.join('.') !== r.version.join('.')) {
            console.log(`🌐 Versão do WhatsApp Web: ${r.version.join('.')}`);
        }
        versaoWa = r.version;
        versaoWaEm = Date.now();
    } else {
        const motivo = r?.error?.message || String(r?.error || 'sem detalhes');
        console.warn(`⚠️ Não consegui ler a versão atual do WhatsApp Web (${motivo}). ` +
            (versaoWa ? 'Mantendo a última conhecida.' : 'Usando a embutida no Baileys.'));
    }
    return versaoWa;
}

function atrasoReconexao(statusCode) {
    if (statusCode === DisconnectReason.restartRequired) return 1000;
    if (statusCode === DisconnectReason.loggedOut) return 3000;
    // 440: outra conexão com a mesma sessão assumiu (ex.: deploy do Render
    // subindo a instância nova antes de matar a antiga). Esperar evita a briga.
    if (statusCode === DisconnectReason.connectionReplaced) return 60000;
    const base = Math.min(120000, 5000 * Math.pow(2, Math.min(quedasSeguidas, 5)));
    return Math.round(base * aleatorio(0.8, 1.2));
}

async function conectarInterno() {
    const { state, saveCreds } = await useMongoDBAuthState(mongoCollection);
    const versao = await obterVersaoWa();

    encerrarSocketAntigo();
    cacheGrupos.clear();

    sock = makeWASocket({
        auth: state,
        // Só passa a versão quando houver uma: `version: undefined` apagaria o padrão do Baileys.
        ...(versao ? { version: versao } : {}),
        // NUNCA imprimir o QR no terminal: os logs do Render ficam guardados e
        // quem tiver acesso a um print de log pareia o próprio aparelho na sua conta.
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        syncFullHistory: false,
        // Não aparece "online" o tempo todo e o celular continua recebendo notificações.
        markOnlineOnConnect: false,
        cachedGroupMetadata: async (jid) => {
            const c = cacheGrupos.get(jid);
            return (c && Date.now() - c.ts < CACHE_GRUPO_MS) ? c.meta : undefined;
        },
        getMessage: async (key) => mensagensEnviadas.get(key.id) || undefined
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrCodeBase64 = await qrcode.toDataURL(qr);
            console.log('⚡ QR Code gerado e pronto para o painel do Apps Script.');
        }

        if (connection === 'close') {
            isConnected = false;
            qrCodeBase64 = '';
            if (encerrando) return;

            const statusCode = lastDisconnect?.error?.output?.statusCode;
            ultimoMotivoQueda = String(statusCode || 'desconhecido');
            const deslogado = statusCode === DisconnectReason.loggedOut;

            // Queda logo depois de conectar conta como "seguida" (instabilidade);
            // queda depois de muito tempo conectado zera o contador.
            if (conectadoDesde && Date.now() - conectadoDesde > 10 * 60 * 1000) quedasSeguidas = 0;
            quedasSeguidas++;
            conectadoDesde = 0;

            const espera = atrasoReconexao(statusCode);
            console.log(`🔴 Conexão encerrada (Status: ${statusCode}). Deslogado: ${deslogado}. Reconectando em ${Math.round(espera / 1000)}s.`);

            if (statusCode === STATUS_VERSAO_RECUSADA) {
                // Versão recusada: na próxima tentativa busca a versão atual de novo.
                versaoWaEm = 0;
                console.log('🌐 405 = WhatsApp recusou a versão do cliente. A versão será buscada de novo.');
            }

            if (deslogado) {
                // Sessão inválida: limpa e reconecta para emitir um QR novo.
                console.log('🧹 Sessão inválida/deslogada. Limpando e gerando QR novo...');
                await mongoCollection.deleteMany({});
                await apagarContatosDoAparelho();
            }
            reconnectTimeout = setTimeout(connectToWhatsApp, espera);
        } else if (connection === 'open') {
            isConnected = true;
            qrCodeBase64 = '';
            ultimoMotivoQueda = '';
            conectadoDesde = Date.now();
            console.log('✅ WhatsApp autenticado e pronto!');
            setTimeout(cicloFilaEnvio, 5000);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // 📇 Contatos: agenda do celular (app-state) e conversas do histórico inicial.
    // Do histórico só aproveitamos quem é o contato — as mensagens são descartadas.
    sock.ev.on('contacts.upsert', (lista) => {
        registrarContatos(lista, 'agenda').catch(e => console.warn('⚠️ contatos (agenda):', e.message));
    });
    sock.ev.on('contacts.update', atualizarNomesDePerfil);
    sock.ev.on('messaging-history.set', ({ contacts }) => {
        registrarContatos(contacts, 'conversa').catch(e => console.warn('⚠️ contatos (conversas):', e.message));
    });

    // Metadados mudaram (nome, participantes): invalida o cache daquele grupo.
    sock.ev.on('groups.update', (updates) => {
        (updates || []).forEach(u => u && u.id && cacheGrupos.delete(u.id));
    });
    sock.ev.on('group-participants.update', (ev) => {
        if (ev && ev.id) cacheGrupos.delete(ev.id);
    });

    // 🎧 ESCUTA SELETIVA: só grupos da allowlist chegam a ser processados.
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;                  // ignora sincronização de histórico
        if (entradaGruposSet.size === 0 && respostaGruposMap.size === 0) return;
        for (const msg of messages) {
            const jid = msg.key?.remoteJid || '';
            if (!jid.endsWith('@g.us') || msg.key.fromMe) continue;
            if (entradaGruposSet.has(jid)) await tratarMensagemDeEntrada(msg);
            else if (respostaGruposMap.has(jid)) await tratarMensagemDeCliente(msg);
            // qualquer outra conversa é descartada sem ser lida
        }
    });
}

// =====================================================================
// ROTAS DA API
// =====================================================================

app.get('/api/qr', (req, res) => {
    if (isConnected) return res.json({ status: 'connected', message: 'WhatsApp conectado.' });
    if (qrCodeBase64) return res.json({ status: 'pending', qr: qrCodeBase64 });

    const seg = inicioTentativaConexao ? Math.round((Date.now() - inicioTentativaConexao) / 1000) : 0;
    let msg = 'Aguarde, gerando QR Code...';
    if (ultimoMotivoQueda === String(STATUS_VERSAO_RECUSADA)) {
        // Apagar a sessão não resolve um 405 — o problema é a versão, não o pareamento.
        msg = 'O WhatsApp recusou a versão do cliente (405). Buscando a versão atual e tentando de novo... ' +
              'Se persistir, defina WA_VERSION no Render.';
    } else if (seg > 90) {
        msg = `Tentando conectar há ${seg}s sem sucesso` +
              (ultimoMotivoQueda ? ` (última queda: ${ultimoMotivoQueda})` : '') +
              '. Use "Apagar sessão e gerar QR novo".';
    }
    res.json({ status: 'starting', message: msg, tentandoHaSegundos: seg, ultimoMotivoQueda: ultimoMotivoQueda });
});

app.get('/api/health', async (req, res) => {
    let fila = null, onboardingsPendentes = 0;
    try { fila = await resumoFilaEnvio(); } catch (e) { /* mongo indisponível */ }
    try { onboardingsPendentes = await app.locals.db.collection('onboarding_pendente').countDocuments({}); } catch (e) { /* idem */ }
    res.json({
        status: 'ok',
        versao: 3,
        commit: VERSAO_PUBLICADA,
        processadorImagem,
        conectado: isConnected,
        gruposEscutando: entradaGruposSet.size,
        gruposComResposta: respostaGruposMap.size,
        webhookConfigurado: !!entradaCfg.webhookUrl,
        embeddedSignup: {
            configurado: !!(process.env.META_APP_ID && process.env.META_APP_SECRET && process.env.META_CONFIG_ID),
            graphVersion: process.env.GRAPH_VERSION || 'v25.0',
            onboardingsPendentes
        },
        filaEnvio: fila
    });
});

// ---------- CRIAÇÃO / MEMBROS ----------

app.post('/api/adicionar-grupo', async (req, res) => {
    const { nomeGrupo, clientesPhones } = req.body || {};
    try {
        if (!isConnected) throw new Error('WhatsApp deslogado.');
        if (!nomeGrupo) throw new Error('nomeGrupo ausente.');
        const participants = (clientesPhones || []).map(num => `${soDigitos(num)}@s.whatsapp.net`);
        const group = await sock.groupCreate(String(nomeGrupo), participants);
        cacheListaGrupos.ts = 0;   // a busca seguinte já enxerga o grupo novo
        res.json({ status: 'success', groupId: group.id });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.toString() });
    }
});

app.post('/api/adicionar-membros-grupo', async (req, res) => {
    const { groupId, clientesPhones } = req.body || {};
    try {
        if (!isConnected) throw new Error('WhatsApp deslogado.');
        if (!groupId || !clientesPhones || clientesPhones.length === 0) {
            throw new Error('ID do grupo ou lista de contatos ausente.');
        }
        const participants = clientesPhones.map(num => `${soDigitos(num)}@s.whatsapp.net`);
        const action = await sock.groupParticipantsUpdate(groupId, participants, 'add');
        cacheGrupos.delete(groupId);
        // 403 = a privacidade da pessoa não deixa adicionar: mande o link de convite.
        const bloqueados = (action || []).filter(a => String(a.status) === '403').map(a => numeroDoJid(a.jid) || a.jid);
        res.json({ status: 'success', action: action, bloqueadosPorPrivacidade: bloqueados });
    } catch (error) {
        console.error('Erro ao adicionar membros no grupo:', error);
        res.status(500).json({ status: 'error', message: error.toString() });
    }
});

let cacheListaGrupos = { ts: 0, lista: [] };
app.get('/api/listar-grupos', async (req, res) => {
    try {
        if (!isConnected) throw new Error('WhatsApp deslogado.');

        const termoBusca = req.query.busca ? String(req.query.busca).toLowerCase() : '';
        if (!termoBusca || termoBusca.length < 3) {
            return res.status(400).json({ status: 'error', message: 'Digite pelo menos 3 letras para buscar.' });
        }

        // groupFetchAllParticipating é pesado: guardamos 60s para buscas seguidas.
        if (Date.now() - cacheListaGrupos.ts > 60000) {
            const groups = await sock.groupFetchAllParticipating();
            cacheListaGrupos = {
                ts: Date.now(),
                lista: Object.values(groups).map(g => ({
                    id: g.id,
                    subject: g.subject,
                    participants: (g.participants || []).length
                }))
            };
        }

        const groupList = cacheListaGrupos.lista
            .filter(g => g.subject && g.subject.toLowerCase().includes(termoBusca))
            .slice(0, 20);

        res.json({ status: 'success', grupos: groupList });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.toString() });
    }
});

app.get('/api/grupo-participantes', async (req, res) => {
    try {
        if (!isConnected) throw new Error('WhatsApp deslogado.');
        const groupId = req.query.groupId;
        if (!groupId) throw new Error('ID do grupo ausente.');

        const meta = await metadadosGrupo(groupId, true);
        const participantes = [];
        let naoResolvidos = 0;

        for (const p of (meta.participants || [])) {
            // Baileys v7: com privacidade de LID o "id" vem como @lid e o telefone
            // (quando conhecido) vem em phoneNumber — ou no mapeamento LID→PN.
            const numero = await resolverTelefone(p.phoneNumber || p.jid || p.id, p.id);
            if (!numero) { naoResolvidos++; continue; }
            participantes.push({ number: numero, admin: p.admin || null });
        }

        res.json({
            status: 'success',
            nome: meta.subject || '',
            participantes: participantes,
            naoResolvidos: naoResolvidos
        });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.toString() });
    }
});

// Link de convite do grupo (o número auxiliar precisa ser admin do grupo).
app.get('/api/grupo-convite', async (req, res) => {
    try {
        if (!isConnected) throw new Error('WhatsApp deslogado.');
        const groupId = String(req.query.groupId || '');
        if (!groupId.endsWith('@g.us')) throw new Error('groupId inválido.');
        const code = await sock.groupInviteCode(groupId);
        if (!code) throw new Error('O WhatsApp não devolveu o código (o número auxiliar é admin do grupo?).');
        res.json({ status: 'success', link: 'https://chat.whatsapp.com/' + code });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.toString() });
    }
});

// Criação completa: nome, descrição, permissões e link de convite numa chamada só.
// Teto de participantes por vez: adicionar muita gente de uma vez é o que mais
// derruba número — o resto entra pelo link de convite.
const MAX_PARTICIPANTES_CRIACAO = 50;

// ANTI-DUPLICAÇÃO: o mesmo pedido de criação pode chegar duas vezes (o UrlFetchApp
// do Apps Script repete a chamada quando o Render demora, ou alguém clica de novo
// depois de um erro de rede). Cada pedido traz uma "chave"; enquanto o primeiro
// estiver em andamento ou tiver terminado há pouco, o repetido recebe o MESMO
// resultado em vez de criar outro grupo. Sem chave, nome + participantes iguais
// em poucos minutos também contam como repetição.
const criacoesRecentes = new Map();      // chave -> { assinatura, ts, promessa }
const JANELA_CHAVE_MS = 15 * 60 * 1000;
const JANELA_REPETICAO_MS = 3 * 60 * 1000;

// Foto de grupo: o painel já manda 640x640 em JPEG; o Baileys (com sharp) só ajusta.
const MAX_FOTO_BYTES = 5 * 1024 * 1024;
const ESPERA_FOTO_MS = numEnv(process.env.FOTO_ESPERA_MS, 1500);

async function verificarProcessadorImagem() {
    try {
        const m = await import('sharp');
        const sharp = m.default || m;
        processadorImagem = 'sharp ' + ((sharp.versions && sharp.versions.sharp) || '');
    } catch (e) {
        processadorImagem = 'indisponível (' + String(e.message || e).split('\n')[0].slice(0, 120) + ')';
    }
    console.log('🖼️ Processador de imagem: ' + processadorImagem);
}

const ehJpeg = (buf) => buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;

// Foto do grupo pelo caminho do Baileys (sharp redimensiona). Se falhar, o painel já
// mandou 640x640 em JPEG: envia direto ao WhatsApp, sem depender do sharp.
async function definirFotoGrupo(groupId, buf) {
    try {
        await sock.updateProfilePicture(groupId, buf);
        return 'baileys';
    } catch (e) {
        console.warn(`⚠️ Foto do grupo ${groupId} pelo Baileys falhou: ${e.message}`);
        if (!ehJpeg(buf)) throw e;
        try {
            await sock.query({
                tag: 'iq',
                attrs: { target: groupId, to: S_WHATSAPP_NET, type: 'set', xmlns: 'w:profile:picture' },
                content: [{ tag: 'picture', attrs: { type: 'image' }, content: buf }]
            });
            console.log(`🖼️ Foto do grupo ${groupId} enviada direto (JPEG do painel).`);
            return 'direto';
        } catch (e2) {
            console.warn(`⚠️ Foto do grupo ${groupId} enviada direto também falhou: ${e2.message}`);
            throw e2;
        }
    }
}

function bufferDaImagem(base64) {
    const limpo = String(base64 || '').replace(/^data:[^;]+;base64,/, '');
    const buf = Buffer.from(limpo, 'base64');
    if (!buf.length) throw new Error('Imagem vazia ou inválida.');
    if (buf.length > MAX_FOTO_BYTES) throw new Error('A foto passa de 5 MB.');
    return buf;
}

// Erros do WhatsApp em português que dá para agir em cima.
function mensagemErroGrupo(e) {
    const m = String((e && e.message) || e);
    if (/not-authorized|forbidden|\b40[13]\b/i.test(m)) return 'O número auxiliar precisa ser ADMIN do grupo para fazer isso.';
    if (/item-not-found|\b404\b/i.test(m)) return 'Grupo não encontrado (o número auxiliar ainda participa dele?).';
    return m;
}

async function criarGrupoCompleto({ nome, descricao, numeros, somenteAdminsEnviam, somenteAdminsEditam, foto }) {
    let grupo;
    try {
        grupo = await sock.groupCreate(nome, numeros.map(n => `${n}@s.whatsapp.net`));
    } catch (e) {
        if (!numeros.length) throw new Error('O WhatsApp exigiu pelo menos 1 participante. Adicione 1 pessoa (pode ser o seu número pessoal) e convide o resto pelo link. Detalhe: ' + e.message);
        throw e;
    }
    const groupId = grupo.id;
    cacheListaGrupos.ts = 0;   // a busca seguinte já enxerga o grupo novo
    console.log(`🆕 Grupo criado: "${nome}" (${groupId}) com ${numeros.length} participante(s) pedidos.`);

    // Ajustes opcionais: se um falhar o grupo já existe, então só avisa.
    const avisos = [];
    const tentar = async (rotulo, fn) => { try { await fn(); } catch (e) { avisos.push(`${rotulo}: ${e.message}`); } };

    // Logo depois de criar, o WhatsApp às vezes ainda recusa mudar o grupo: espera um pouco
    // e tenta duas vezes. null = não pediram foto; false = pediram e não entrou.
    let fotoAplicada = null;
    if (foto) {
        fotoAplicada = false;
        await dormir(ESPERA_FOTO_MS);
        for (let tentativa = 1; tentativa <= 2 && !fotoAplicada; tentativa++) {
            try {
                await definirFotoGrupo(groupId, foto);
                fotoAplicada = true;
            } catch (e) {
                if (tentativa === 2) avisos.push('Foto do grupo: ' + mensagemErroGrupo(e));
                else await dormir(ESPERA_FOTO_MS * 2);
            }
        }
    }
    if (descricao) await tentar('Descrição', () => sock.groupUpdateDescription(groupId, descricao));
    if (somenteAdminsEnviam) await tentar('Só admins enviam', () => sock.groupSettingUpdate(groupId, 'announcement'));
    if (somenteAdminsEditam) await tentar('Só admins editam', () => sock.groupSettingUpdate(groupId, 'locked'));

    let link = '';
    await tentar('Link de convite', async () => {
        const code = await sock.groupInviteCode(groupId);
        if (code) link = 'https://chat.whatsapp.com/' + code;
    });

    // Quem não entrou costuma ser privacidade ("quem pode me adicionar").
    let naoAdicionados = [];
    await tentar('Conferência de membros', async () => {
        const meta = await metadadosGrupo(groupId, true);
        const dentro = new Set();
        for (const p of (meta.participants || [])) {
            const n = await resolverTelefone(p.phoneNumber || p.id, p.id);
            if (n) dentro.add(n);
        }
        naoAdicionados = numeros.filter(n => !dentro.has(n));
    });

    return {
        status: 'success',
        groupId,
        nome,
        link,
        adicionados: numeros.length - naoAdicionados.length,
        naoAdicionados,
        fotoAplicada,
        avisos
    };
}

app.post('/api/criar-grupo', async (req, res) => {
    try {
        if (!isConnected) throw new Error('WhatsApp deslogado.');
        const b = req.body || {};
        const nome = String(b.nome || '').trim();
        const descricao = String(b.descricao || '').trim();
        if (!nome) throw new Error('Informe o nome do grupo.');
        if (nome.length > 100) throw new Error('O nome do grupo pode ter no máximo 100 caracteres.');
        if (descricao.length > 2048) throw new Error('A descrição pode ter no máximo 2048 caracteres.');

        const meuNumero = numeroDoJid(sock.user && sock.user.id);
        const numeros = [...new Set((Array.isArray(b.participantes) ? b.participantes : [])
            .map(soDigitos).filter(n => n.length >= 10 && n.length <= 15 && n !== meuNumero))];
        if (numeros.length > MAX_PARTICIPANTES_CRIACAO) {
            throw new Error(`No máximo ${MAX_PARTICIPANTES_CRIACAO} participantes por vez. Convide o resto pelo link do grupo.`);
        }
        const foto = b.fotoBase64 ? bufferDaImagem(b.fotoBase64) : null;   // inválida: avisa antes de criar

        const agora = Date.now();
        for (const [k, v] of criacoesRecentes) if (agora - v.ts > JANELA_CHAVE_MS) criacoesRecentes.delete(k);

        const chave = String(b.chave || '').slice(0, 120) || `auto-${agora}-${Math.random()}`;
        const assinatura = semAcento(nome) + '|' + numeros.slice().sort().join(',');
        const anterior = criacoesRecentes.get(chave) ||
            [...criacoesRecentes.values()].find(v => v.assinatura === assinatura && agora - v.ts < JANELA_REPETICAO_MS);
        if (anterior) {
            console.log(`♻️ Pedido repetido de criação de "${nome}" — devolvendo o grupo já criado, sem criar outro.`);
            const r = await anterior.promessa;   // se o primeiro falhou, este falha igual
            return res.json({ ...r, repetido: true });
        }

        const registro = {
            assinatura,
            ts: agora,
            promessa: criarGrupoCompleto({ nome, descricao, numeros, foto, somenteAdminsEnviam: !!b.somenteAdminsEnviam, somenteAdminsEditam: !!b.somenteAdminsEditam })
        };
        criacoesRecentes.set(chave, registro);
        // Falhou: libera a chave para uma nova tentativa de verdade.
        registro.promessa.catch(() => { if (criacoesRecentes.get(chave) === registro) criacoesRecentes.delete(chave); });

        res.json(await registro.promessa);
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message || String(error) });
    }
});

// ---------- GERENCIAR GRUPO (foto, dados, participantes) ----------

function ehMeuJid(jid) {
    const me = sock && sock.user;
    if (!me || !jid) return false;
    const alvo = jidNormalizedUser(jid);
    return alvo === jidNormalizedUser(me.id) || (!!me.lid && alvo === jidNormalizedUser(me.lid));
}

function groupIdValido(v) {
    const id = String(v || '');
    if (!id.endsWith('@g.us')) throw new Error('groupId inválido.');
    return id;
}

// Tudo o que a tela "Gerenciar grupo" mostra, numa chamada só.
app.get('/api/grupo-detalhes', async (req, res) => {
    try {
        if (!isConnected) throw new Error('WhatsApp deslogado.');
        const groupId = groupIdValido(req.query.groupId);
        const meta = await metadadosGrupo(groupId, true);
        const meuNumero = numeroDoJid(sock.user && sock.user.id);

        const participantes = [];
        for (const p of (meta.participants || [])) {
            const numero = await resolverTelefone(p.phoneNumber || p.id, p.id);
            const contato = numero ? contatosWa.get(numero) : null;
            participantes.push({
                id: p.id,                                  // é este id que remove/promove
                numero,                                    // '' = oculto pela privacidade (LID)
                nome: contato ? (contato.nome || contato.notify) : '',
                admin: p.admin || null,                    // 'superadmin' | 'admin' | null
                eu: ehMeuJid(p.id) || (!!numero && numero === meuNumero)
            });
        }
        // Eu, donos, admins; depois por nome — sem nome e ocultos (LID) no fim.
        const peso = p => (p.eu ? 0 : p.admin === 'superadmin' ? 1 : p.admin ? 2 : 3);
        const ordem = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
        participantes.sort((a, b) => peso(a) - peso(b) || (!a.nome) - (!b.nome) || (!a.numero) - (!b.numero) ||
            ordem.compare(a.nome || a.numero, b.nome || b.numero));

        // Grupo sem foto: o WhatsApp responde 404. Não é erro, só fica sem.
        let foto = '';
        try { foto = (await sock.profilePictureUrl(groupId, 'image', 8000)) || ''; } catch (e) { /* sem foto */ }

        const eu = participantes.find(p => p.eu);
        res.json({
            status: 'success',
            groupId,
            nome: meta.subject || '',
            descricao: meta.desc || '',
            tamanho: meta.size || participantes.length,
            criadoEm: meta.creation ? meta.creation * 1000 : null,
            somenteAdminsEnviam: !!meta.announce,
            somenteAdminsEditam: !!meta.restrict,
            souAdmin: !!(eu && eu.admin),
            foto,
            participantes
        });
    } catch (error) {
        res.status(500).json({ status: 'error', message: mensagemErroGrupo(error) });
    }
});

// Troca (imagemBase64) ou tira (remover: true) a foto do grupo.
app.post('/api/grupo-foto', async (req, res) => {
    try {
        if (!isConnected) throw new Error('WhatsApp deslogado.');
        const b = req.body || {};
        const groupId = groupIdValido(b.groupId);
        if (b.remover) await sock.removeProfilePicture(groupId);
        else await definirFotoGrupo(groupId, bufferDaImagem(b.imagemBase64));
        let foto = '';
        if (!b.remover) {
            try { foto = (await sock.profilePictureUrl(groupId, 'image', 8000)) || ''; } catch (e) { /* ainda processando */ }
        }
        res.json({ status: 'success', foto });
    } catch (error) {
        res.status(500).json({ status: 'error', message: mensagemErroGrupo(error) });
    }
});

// Nome, descrição e permissões. Só mexe no que vier no pedido.
app.post('/api/grupo-editar', async (req, res) => {
    try {
        if (!isConnected) throw new Error('WhatsApp deslogado.');
        const b = req.body || {};
        const groupId = groupIdValido(b.groupId);
        const passos = [];
        if (b.nome !== undefined) {
            const nome = String(b.nome).trim();
            if (!nome || nome.length > 100) throw new Error('O nome do grupo precisa ter de 1 a 100 caracteres.');
            passos.push(['Nome', () => sock.groupUpdateSubject(groupId, nome)]);
        }
        if (b.descricao !== undefined) {
            const descricao = String(b.descricao).trim();
            if (descricao.length > 2048) throw new Error('A descrição pode ter no máximo 2048 caracteres.');
            passos.push(['Descrição', () => sock.groupUpdateDescription(groupId, descricao || undefined)]);
        }
        if (b.somenteAdminsEnviam !== undefined) {
            passos.push(['Quem envia mensagens', () => sock.groupSettingUpdate(groupId, b.somenteAdminsEnviam ? 'announcement' : 'not_announcement')]);
        }
        if (b.somenteAdminsEditam !== undefined) {
            passos.push(['Quem edita os dados', () => sock.groupSettingUpdate(groupId, b.somenteAdminsEditam ? 'locked' : 'unlocked')]);
        }
        if (!passos.length) throw new Error('Nada para alterar.');

        const feitos = [], erros = [];
        for (const [rotulo, fn] of passos) {
            try { await fn(); feitos.push(rotulo); } catch (e) { erros.push(`${rotulo}: ${mensagemErroGrupo(e)}`); }
        }
        cacheGrupos.delete(groupId);
        cacheListaGrupos.ts = 0;   // nome novo aparece na busca
        if (!feitos.length) throw new Error(erros.join(' · '));
        res.json({ status: 'success', feitos, erros });
    } catch (error) {
        res.status(500).json({ status: 'error', message: mensagemErroGrupo(error) });
    }
});

// Adicionar, remover, tornar admin ou tirar admin. "participantes" aceita números
// (para adicionar) ou os ids devolvidos por /api/grupo-detalhes (para os demais).
const ACOES_PARTICIPANTES = { add: 'adicionar', remove: 'remover', promote: 'tornar admin', demote: 'tirar admin' };
const MOTIVO_STATUS_PARTICIPANTE = {
    '401': 'o número auxiliar não é admin do grupo',
    '403': 'sem permissão (o número auxiliar é admin do grupo?)',
    '403-add': 'a privacidade da pessoa só permite entrar por convite',
    '404': 'não está no grupo',
    '406': 'número inválido ou sem WhatsApp',
    '408': 'saiu do grupo há pouco e ainda não pode voltar',
    '409': 'já está no grupo'
};
app.post('/api/grupo-participantes/alterar', async (req, res) => {
    try {
        if (!isConnected) throw new Error('WhatsApp deslogado.');
        const b = req.body || {};
        const groupId = groupIdValido(b.groupId);
        const acao = String(b.acao || '');
        if (!ACOES_PARTICIPANTES[acao]) throw new Error('Ação inválida.');

        const jids = [...new Set((Array.isArray(b.participantes) ? b.participantes : []).map(p => {
            const s = String(p || '').trim();
            if (s.includes('@')) return s;
            const n = soDigitos(s);
            return n.length >= 10 && n.length <= 15 ? `${n}@s.whatsapp.net` : '';
        }).filter(Boolean))];
        if (!jids.length) throw new Error('Nenhum participante válido.');
        if (jids.length > MAX_PARTICIPANTES_CRIACAO) throw new Error(`No máximo ${MAX_PARTICIPANTES_CRIACAO} por vez.`);
        if (acao !== 'add' && jids.some(ehMeuJid)) throw new Error('O número auxiliar não pode remover nem rebaixar a si mesmo por aqui.');

        const resultado = await sock.groupParticipantsUpdate(groupId, jids, acao);
        cacheGrupos.delete(groupId);
        const itens = [];
        for (const r of (resultado || [])) {
            const status = String(r.status || '200');
            itens.push({
                jid: r.jid,
                numero: await resolverTelefone(r.jid),
                ok: status === '200',
                status,
                motivo: status === '200' ? '' :
                    (MOTIVO_STATUS_PARTICIPANTE[status + '-' + acao] || MOTIVO_STATUS_PARTICIPANTE[status] || 'erro ' + status)
            });
        }
        const ok = itens.filter(i => i.ok).length;
        console.log(`👥 ${ACOES_PARTICIPANTES[acao]}: ${ok}/${itens.length} em ${groupId}`);
        res.json({ status: 'success', acao, ok, falhas: itens.length - ok, itens });
    } catch (error) {
        res.status(500).json({ status: 'error', message: mensagemErroGrupo(error) });
    }
});

// Link novo: o antigo para de funcionar (útil se o link vazou para quem não devia).
app.post('/api/grupo-convite/revogar', async (req, res) => {
    try {
        if (!isConnected) throw new Error('WhatsApp deslogado.');
        const groupId = groupIdValido((req.body || {}).groupId);
        const code = await sock.groupRevokeInvite(groupId);
        if (!code) throw new Error('O WhatsApp não devolveu o código novo.');
        res.json({ status: 'success', link: 'https://chat.whatsapp.com/' + code });
    } catch (error) {
        res.status(500).json({ status: 'error', message: mensagemErroGrupo(error) });
    }
});

// ---------- CONTATOS DO APARELHO ----------

// Lista os contatos sincronizados (funciona mesmo com o WhatsApp offline).
app.get('/api/contatos', (req, res) => {
    const busca = semAcento(String(req.query.busca || '').trim());
    const digitos = soDigitos(busca);
    const filtro = String(req.query.filtro || 'todos');
    const limite = Math.min(5000, Math.max(1, parseInt(req.query.limite, 10) || 500));

    const todos = [...contatosWa.values()];
    const comNumero = todos.filter(c => c.numero);
    let lista = comNumero;
    if (filtro === 'agenda') lista = lista.filter(c => c.agenda);
    else if (filtro === 'conversa') lista = lista.filter(c => c.conversa);
    if (busca) {
        lista = lista.filter(c => semAcento(c.nome + ' ' + c.notify).includes(busca) ||
                                  (digitos.length >= 3 && c.numero.includes(digitos)));
    }
    const rotulo = (c) => semAcento(c.nome || c.notify || '~' + c.numero);
    lista.sort((a, b) => rotulo(a).localeCompare(rotulo(b)));

    res.json({
        status: 'success',
        conectado: isConnected,
        total: todos.length,
        comNumero: comNumero.length,
        semNumero: todos.length - comNumero.length,
        naAgenda: comNumero.filter(c => c.agenda).length,
        encontrados: lista.length,
        atualizadoEm: contatosAtualizadosEm,
        contatos: lista.slice(0, limite).map(c => ({
            numero: c.numero, nome: c.nome, notify: c.notify, agenda: c.agenda, conversa: c.conversa
        }))
    });
});

// Pede ao celular a agenda inteira de novo (útil se o aparelho foi pareado
// antes desta versão, quando os contatos ainda não eram guardados).
app.post('/api/contatos/sincronizar', async (req, res) => {
    if (!isConnected) return res.status(500).json({ status: 'error', message: 'WhatsApp deslogado.' });
    if (sincronizandoContatos) {
        return res.status(409).json({ status: 'error', message: 'Já existe uma sincronização em andamento. Aguarde alguns segundos.' });
    }
    sincronizandoContatos = true;
    try {
        const antes = [...contatosWa.values()].filter(c => c.numero).length;

        // Sem versão salva, o WhatsApp devolve o snapshot completo da coleção.
        await sock.authState.keys.set({ 'app-state-sync-version': { [COLECAO_AGENDA]: null } });
        // Pode passar dos 40s da resposta: segue em segundo plano, sem nunca
        // deixar uma rejeição solta (derrubaria o processo).
        let erroSync = null;
        const sync = sock.resyncAppState([COLECAO_AGENDA], true)
            .then(() => true, (e) => { erroSync = e; return true; })
            .finally(() => { sincronizandoContatos = false; gravarContatosPendentes(); });
        const terminou = await Promise.race([sync, dormir(40000).then(() => false)]);
        if (erroSync) throw erroSync;
        await dormir(300);   // os eventos saem do buffer logo depois do resync
        await gravarContatosPendentes();

        const depois = [...contatosWa.values()].filter(c => c.numero).length;
        res.json({
            status: 'success',
            concluido: terminou,
            antes,
            depois,
            novos: Math.max(0, depois - antes),
            message: terminou
                ? `${depois} contato(s) com número (${Math.max(0, depois - antes)} novo(s)).`
                : 'O celular ainda está enviando a agenda. Atualize a lista em 1 minuto.'
        });
    } catch (error) {
        sincronizandoContatos = false;
        res.status(500).json({ status: 'error', message: 'Não consegui sincronizar a agenda: ' + (error.message || String(error)) });
    }
});

// ---------- ENVIO PARA GRUPOS (tudo passa pela fila anti-ban) ----------

// Rota nova: enfileira até 50 itens de uma vez e responde na hora.
app.post('/api/fila-envio', async (req, res) => {
    try {
        const body = req.body || {};
        const itens = Array.isArray(body.itens) ? body.itens : [];
        if (itens.length === 0) throw new Error('Nenhum item para enfileirar.');
        if (itens.length > 50) throw new Error('Máximo de 50 itens por chamada.');

        const resultados = [];
        for (const bruto of itens) {
            try {
                const item = validarItemFila({ origem: body.origem, ...bruto });
                const r = await inserirNaFila(item);
                resultados.push({ ok: true, id: r.id, duplicado: r.duplicado });
            } catch (e) {
                resultados.push({ ok: false, erro: e.message });
            }
        }
        const resumo = await resumoFilaEnvio();
        res.json({
            status: resultados.some(r => r.ok) ? 'success' : 'error',
            message: resultados.every(r => !r.ok) ? (resultados[0] && resultados[0].erro) : undefined,
            enfileirados: resultados.filter(r => r.ok && !r.duplicado).length,
            duplicados: resultados.filter(r => r.duplicado).length,
            falhas: resultados.filter(r => !r.ok).length,
            resultados,
            fila: resumo
        });
    } catch (error) {
        res.status(400).json({ status: 'error', message: error.message });
    }
});

app.get('/api/fila-envio', async (req, res) => {
    try {
        const filtro = {};
        if (req.query.status) filtro.status = String(req.query.status);
        if (req.query.groupId) filtro.groupId = String(req.query.groupId);
        const limite = Math.min(100, parseInt(req.query.limite, 10) || 30);
        const itens = await colEnvioFila.find(filtro, {
            projection: { imagemBase64: 0 }
        }).sort({ criadoEm: -1 }).limit(limite).toArray();
        res.json({
            status: 'success',
            config: cfgEnvio,
            resumo: await resumoFilaEnvio(),
            itens: itens.map(i => ({
                id: String(i._id), groupId: i.groupId, tipo: i.tipo, origem: i.origem, ref: i.ref || '',
                texto: String(i.texto || '').slice(0, 160), status: i.status, erro: i.erro || '',
                tentativas: i.tentativas || 0, criadoEm: i.criadoEm, agendadoPara: i.agendadoPara,
                enviadoEm: i.enviadoEm || null, fallbackTexto: !!i.fallbackTexto
            }))
        });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.toString() });
    }
});

app.post('/api/fila-envio/cancelar', async (req, res) => {
    try {
        const { ids, groupId, origem, todos } = req.body || {};
        const filtro = { status: 'pendente' };
        if (Array.isArray(ids) && ids.length) {
            filtro._id = { $in: ids.filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id)) };
        } else if (groupId) {
            filtro.groupId = String(groupId);
        } else if (origem) {
            filtro.origem = String(origem);
        } else if (todos !== true) {
            throw new Error('Informe ids, groupId, origem ou todos:true.');
        }
        if (groupId && filtro._id) filtro.groupId = String(groupId);
        const r = await colEnvioFila.updateMany(filtro, {
            $set: { status: 'cancelado', expiraEm: new Date(Date.now() + 7 * DIA_MS) },
            $unset: { imagemBase64: '' }
        });
        res.json({ status: 'success', cancelados: r.modifiedCount });
    } catch (error) {
        res.status(400).json({ status: 'error', message: error.message });
    }
});

app.get('/api/config-envio', (req, res) => {
    res.json({ status: 'success', config: cfgEnvio, padrao: CFG_ENVIO_PADRAO, fuso: TZ_ENVIO });
});

app.post('/api/config-envio', async (req, res) => {
    try {
        cfgEnvio = validarCfgEnvio(req.body || {});
        await colEnvioCfg.replaceOne({ _id: 'config' }, { _id: 'config', ...cfgEnvio }, { upsert: true });
        res.json({ status: 'success', config: cfgEnvio, message: 'Configuração de envio salva.' });
        setImmediate(cicloFilaEnvio);
    } catch (error) {
        res.status(400).json({ status: 'error', message: error.message });
    }
});

// Rotas antigas, mantidas por compatibilidade: agora passam pela fila
// (prioridade alta, ignoram a janela — são envios manuais do painel).
app.post('/api/enviar-grupo', async (req, res) => {
    const { groupId, message } = req.body || {};
    try {
        if (!groupId || !message) throw new Error('groupId ou message ausente.');
        await enfileirarEAguardar({
            groupId, tipo: 'texto', texto: String(message),
            origem: 'manual', prioridade: 5, ignorarJanela: true
        }, res);
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.toString() });
    }
});

app.post('/api/enviar-grupo-midia', async (req, res) => {
    const { groupId, imagemBase64, imagemUrl, mimeType, caption } = req.body || {};
    try {
        if (!groupId) throw new Error('groupId ausente.');
        const temImagem = !!(imagemBase64 || imagemUrl);
        await enfileirarEAguardar({
            groupId,
            tipo: temImagem ? 'imagem' : 'texto',
            texto: String(caption || ''),
            imagemBase64, imagemUrl, mimeType,
            origem: 'manual', prioridade: 5, ignorarJanela: true
        }, res);
    } catch (error) {
        console.error('Erro ao enviar mídia para o grupo:', error);
        res.status(500).json({ status: 'error', message: error.toString() });
    }
});

// ---------- CONFIGURAÇÃO DA ESCUTA ----------

// O Apps Script chama esta rota para dizer o que escutar e para onde mandar.
app.post('/api/config-entrada', async (req, res) => {
    try {
        const { webhookUrl, secret, grupos, gruposResposta } = req.body || {};
        if (!webhookUrl) throw new Error('webhookUrl ausente.');
        if (!secret) throw new Error('secret ausente.');
        if (/\/dev(\?|$)/.test(String(webhookUrl))) {
            throw new Error('A URL enviada é a /dev (só funciona logado). Use a URL /exec da implantação — defina WEBAPP_URL nas Propriedades do Script.');
        }

        await salvarConfigEntrada({ webhookUrl, secret, grupos: grupos || [], gruposResposta: gruposResposta || [] });

        res.json({
            status: 'success',
            gruposEscutando: entradaGruposSet.size,
            gruposComResposta: respostaGruposMap.size,
            message: `Escutando ${entradaGruposSet.size} grupo(s) de entrada e ${respostaGruposMap.size} grupo(s) de clientes com resposta automática.`
        });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message || error.toString() });
    }
});

// Diagnóstico: o painel usa para mostrar se a ponte está de pé.
app.get('/api/config-entrada', async (req, res) => {
    let naFila = 0, falhou = 0;
    try {
        naFila = await colEntradaFila.countDocuments({ status: { $ne: 'falhou' } });
        falhou = await colEntradaFila.countDocuments({ status: 'falhou' });
    } catch (e) { /* ignora */ }
    res.json({
        status: 'ok',
        conectado: isConnected,
        gruposEscutando: entradaGruposSet.size,
        grupos: entradaCfg.grupos.map(g => ({ groupId: g.groupId, nome: g.nome })),
        gruposComResposta: respostaGruposMap.size,
        webhookConfigurado: !!entradaCfg.webhookUrl,
        pendentesNaFila: naFila,
        falharamNaFila: falhou
    });
});

/**
 * Apaga a sessão salva no Mongo e reconecta do zero, forçando um QR Code novo.
 * Depois disto o aparelho antigo perde o pareamento — é preciso escanear de novo.
 */
app.post('/api/resetar-sessao', async (req, res) => {
    try {
        console.log('♻️ Reset de sessão solicitado pelo painel.');

        try { if (sock) sock.ev.removeAllListeners('connection.update'); } catch (e) { /* ignora */ }
        try { if (sock) await sock.logout(); } catch (e) { /* a sessão já podia estar inválida */ }
        try { if (sock) sock.end(undefined); } catch (e) { /* ignora */ }

        await mongoCollection.deleteMany({});
        await apagarContatosDoAparelho();   // voltam sozinhos ao parear de novo
        isConnected = false;
        qrCodeBase64 = '';
        quedasSeguidas = 0;

        // Pequena folga para o socket antigo terminar de fechar antes de subir o novo.
        setTimeout(connectToWhatsApp, 2000);

        res.json({ status: 'success', message: 'Sessão apagada. Um QR Code novo será gerado em alguns segundos.' });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.toString() });
    }
});

// Reenvia manualmente o que estiver preso na fila de entrada.
app.post('/api/reprocessar-fila', async (req, res) => {
    try {
        // "Reprocessar" também dá nova chance aos que já tinham desistido.
        await colEntradaFila.updateMany({ status: 'falhou' }, { $set: { status: 'pendente', tentativas: 0 }, $unset: { expiraEm: '' } });
        await processarFilaPendente();
        const restantes = await colEntradaFila.countDocuments({ status: { $ne: 'falhou' } });
        res.json({ status: 'success', pendentesNaFila: restantes });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.toString() });
    }
});

// =====================================================================
// BOOT
// =====================================================================
async function prepararColecoes(db) {
    mongoCollection = db.collection(COLLECTION);
    colEntradaCfg = db.collection(COL_ENTRADA_CFG);
    colEntradaFila = db.collection(COL_ENTRADA_FILA);
    colEnvioFila = db.collection(COL_ENVIO_FILA);
    colEnvioCfg = db.collection(COL_ENVIO_CFG);
    colContatos = db.collection(COL_CONTATOS);
    try { await carregarContatosSalvos(); } catch (e) { console.warn('⚠️ Contatos do aparelho não carregados:', e.message); }

    const indices = [
        colEnvioFila.createIndex({ status: 1, prioridade: -1, criadoEm: 1 }),
        colEnvioFila.createIndex({ status: 1, enviadoEm: 1 }),
        colEnvioFila.createIndex({ waMessageId: 1 }, { sparse: true }),
        colEnvioFila.createIndex({ idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }),
        colEnvioFila.createIndex({ expiraEm: 1 }, { expireAfterSeconds: 0 }),
        colEntradaFila.createIndex({ expiraEm: 1 }, { expireAfterSeconds: 0 })
    ];
    const r = await Promise.allSettled(indices);
    r.filter(x => x.status === 'rejected').forEach(x => console.warn('Índice não criado:', x.reason && x.reason.message));

    // Item que estava "enviando" quando o serviço caiu: pode ou não ter saído.
    // Não reenviamos às cegas (post duplicado em grupo pega mal); fica como erro
    // para você conferir no grupo e reenviar pelo painel se precisar.
    const presos = await colEnvioFila.updateMany(
        { status: 'enviando' },
        { $set: { status: 'erro', erro: 'Interrompido durante o envio (reinício do serviço). Confira no grupo antes de reenviar.', expiraEm: new Date(Date.now() + 30 * DIA_MS) } }
    );
    if (presos.modifiedCount) console.warn(`⚠️ ${presos.modifiedCount} envio(s) interrompido(s) marcados para conferência.`);
}

async function startServer() {
    if (!MONGO_URI) {
        console.error('❌ ERRO CRÍTICO: MONGO_URI ausente!');
        return;
    }

    try {
        mongoClient = new MongoClient(MONGO_URI);
        await mongoClient.connect();
    } catch (e) {
        console.error('❌ Não conectei no MongoDB:', e.message, '— nova tentativa em 15s.');
        setTimeout(startServer, 15000);
        return;
    }
    const db = mongoClient.db(DBNAME);
    app.locals.db = db;
    await prepararColecoes(db);
    verificarProcessadorImagem();   // só registra no log/ping se o sharp carregou; não bloqueia
    console.log('📦 Conectado ao MongoDB com sucesso!');

    await carregarConfigEntrada();
    await carregarCfgEnvio();

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`🚀 Servidor Express online na porta ${PORT}`);

        // 🔒 TRAVA DE SEGURANÇA: sem chave, não conecta no WhatsApp.
        if (!SEGREDO_VALIDO) {
            console.error('❌ BLOQUEADO: defina API_SECRET (mínimo 20 caracteres) nas variáveis de ambiente do Render.');
            console.error('   Enquanto isso, o WhatsApp NÃO será conectado e todas as rotas /api respondem 503.');
            return;
        }

        connectToWhatsApp();
        timers.push(setInterval(processarFilaPendente, 60 * 1000));   // reenvio de entradas ao Apps Script
        timers.push(setInterval(cicloFilaEnvio, 3000));               // fila de publicação anti-ban
        timers.push(setInterval(gravarContatosPendentes, 5000));      // contatos do aparelho → Mongo

        // 🐕 WATCHDOG: 2 minutos sem conexão e sem QR = algo travou no meio do caminho.
        timers.push(setInterval(() => {
            if (encerrando || isConnected || qrCodeBase64 || conectando) return;
            const parado = Date.now() - (inicioTentativaConexao || 0);
            if (parado > 120000) {
                console.warn(`🐕 Watchdog: ${Math.round(parado / 1000)}s sem conexão e sem QR. Reiniciando o socket...`);
                connectToWhatsApp();
            }
        }, 30 * 1000));
    });
}

// Desligamento gracioso: no deploy o Render manda SIGTERM. Fechar o socket
// (sem logout!) evita a instância velha brigar com a nova pela sessão.
async function encerrar(sinal) {
    if (encerrando) return;
    encerrando = true;
    console.log(`👋 ${sinal} recebido — encerrando com cuidado...`);
    timers.forEach(t => clearInterval(t));
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    // dá até 8s para um envio em andamento terminar
    const limite = Date.now() + 8000;
    while (workerEnvioRodando && Date.now() < limite) await dormir(200);
    try { if (sock) sock.end(undefined); } catch (e) { /* ignora */ }
    await gravarContatosPendentes();
    try { if (mongoClient) await mongoClient.close(); } catch (e) { /* ignora */ }
    process.exit(0);
}
process.on('SIGTERM', () => encerrar('SIGTERM'));
process.on('SIGINT', () => encerrar('SIGINT'));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e && e.message ? e.message : e));

if (require.main === module) {
    startServer();
}

module.exports = { app, _interno: { startServer, validarItemFila, dentroDaJanela, validarCfgEnvio, horaLocal, numeroDoJid, RE_INTERESSE, gravarContatosPendentes, estado: () => ({ isConnected, cfgEnvio, estadoEnvio }) } };
