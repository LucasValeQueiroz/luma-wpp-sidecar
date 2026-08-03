/**
 * =====================================================================
 *  LUMA WPP SIDECAR — v2 (Gestor de Grupos + Entrada de Fornecedores)
 * =====================================================================
 *
 *  O que mudou em relação à v1:
 *
 *  1) ESCUTA SELETIVA DE GRUPOS (novidade principal)
 *     A v1 não escutava mensagem nenhuma, de propósito. Agora ele escuta —
 *     mas SOMENTE os grupos que o Apps Script mandar na allowlist
 *     (/api/config-entrada). Qualquer outra conversa continua sendo
 *     descartada antes mesmo de ser lida, então não há risco de conflito
 *     com o atendimento humano nem com a IA da API oficial.
 *
 *  2) DOWNLOAD DE MÍDIA
 *     Quando um fornecedor posta a foto do produto num grupo de entrada,
 *     o sidecar baixa a imagem, converte para base64 e entrega ao Apps
 *     Script junto com a legenda.
 *
 *  3) FILA DE REENVIO
 *     Se o Apps Script estiver fora do ar (deploy, cota, timeout), a
 *     mensagem vai para a coleção `entrada_fila` no Mongo e um worker
 *     tenta de novo a cada minuto. Nada de produto perdido.
 *
 *  4) ENVIO DE IMAGEM PARA GRUPO
 *     /api/enviar-grupo-midia publica foto + legenda no grupo de clientes.
 *     É o passo que fecha o ciclo (estoque → clientes → número oficial).
 *
 *  5) AUTENTICAÇÃO
 *     Todas as rotas /api/* exigem o header x-api-key igual à variável de
 *     ambiente API_SECRET (se ela estiver definida).
 *
 *  ---------------------------------------------------------------------
 *  VARIÁVEIS DE AMBIENTE (Render → Environment)
 *  ---------------------------------------------------------------------
 *  MONGO_URI    (obrigatória) Connection string do MongoDB Atlas.
 *  API_SECRET   (recomendada) Mesma chave salva no Apps Script em
 *               Propriedades do Script > SIDECAR_API_KEY.
 *  PORT         (opcional) O Render define sozinho.
 * =====================================================================
 */

const express = require('express');
const {
    default: makeWASocket,
    DisconnectReason,
    initAuthCreds,
    BufferJSON,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');
const { MongoClient } = require('mongodb');
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

let sock;
let qrCodeBase64 = '';
let isConnected = false;
let mongoCollection;
let colEntradaCfg;
let colEntradaFila;
let reconnectTimeout;
let conectando = false;             // trava contra reconexões sobrepostas
let inicioTentativaConexao = 0;     // usado pelo watchdog e pelo diagnóstico
let ultimoMotivoQueda = '';         // código da última desconexão, para o painel

// Cache em memória da configuração de entrada — evita ir ao Mongo a cada mensagem.
let entradaCfg = { webhookUrl: '', secret: '', grupos: [] };
let entradaGruposSet = new Set();

// Mensagens já processadas nesta instância (anti-duplicata local).
const jaVistas = new Set();

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
// Assim é impossível existir uma janela em que a sessão está de pé e
// desprotegida — que seria o cenário em que um estranho pediria /api/qr,
// escaneasse e passasse a agir como você no WhatsApp.
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
 *
 * O plano gratuito do Render hiberna o serviço após ~15 minutos sem tráfego, e
 * acordar leva de 30 a 60 segundos. Pior: cada hibernação derruba a sessão do
 * WhatsApp e obriga uma reconexão.
 *
 * Aponte um monitor de uptime gratuito (UptimeRobot, Better Stack, cron-job.org)
 * para https://SEU-APP.onrender.com/ping a cada 10 minutos e o serviço nunca
 * dorme. Não devolve nada sensível: só se está vivo e se o WhatsApp está pareado.
 */
app.get('/ping', (req, res) => {
    res.json({ ok: true, conectado: isConnected });
});

app.use('/api', apiKeyGuard);

// =====================================================================
// PERSISTÊNCIA DA SESSÃO NO MONGO (igual à v1)
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
// CONFIGURAÇÃO DA ESCUTA DE ENTRADA
// =====================================================================
async function carregarConfigEntrada() {
    try {
        const doc = await colEntradaCfg.findOne({ _id: 'config' });
        if (doc) {
            entradaCfg = {
                webhookUrl: doc.webhookUrl || '',
                secret: doc.secret || '',
                grupos: Array.isArray(doc.grupos) ? doc.grupos : []
            };
        }
        entradaGruposSet = new Set(entradaCfg.grupos.map(g => String(g.groupId)));
        console.log(`🎧 Escuta de entrada: ${entradaGruposSet.size} grupo(s) na allowlist.`);
    } catch (e) {
        console.error('Falha ao carregar config de entrada:', e.message);
    }
}

async function salvarConfigEntrada(cfg) {
    entradaCfg = {
        webhookUrl: cfg.webhookUrl || '',
        secret: cfg.secret || '',
        grupos: Array.isArray(cfg.grupos) ? cfg.grupos : []
    };
    entradaGruposSet = new Set(entradaCfg.grupos.map(g => String(g.groupId)));
    await colEntradaCfg.replaceOne({ _id: 'config' }, { _id: 'config', ...entradaCfg }, { upsert: true });
    console.log(`💾 Config de entrada salva: ${entradaGruposSet.size} grupo(s).`);
}

// =====================================================================
// ENTREGA AO APPS SCRIPT (com fila de reenvio)
// =====================================================================
async function entregarAoAppsScript(payload) {
    if (!entradaCfg.webhookUrl) {
        console.warn('⚠️ Sem webhookUrl configurada — guardando na fila.');
        await enfileirar(payload, 'sem webhookUrl');
        return false;
    }
    try {
        // O Apps Script responde com 302 para script.googleusercontent.com;
        // o fetch nativo do Node segue o redirecionamento automaticamente.
        const resp = await fetch(entradaCfg.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            redirect: 'follow'
        });

        const texto = await resp.text();
        if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${texto.slice(0, 200)}`);

        let json = null;
        try { json = JSON.parse(texto); } catch (e) { /* GAS pode devolver HTML em erro */ }

        if (json && json.status === 'error') {
            console.error('❌ Apps Script recusou:', json.message);
            // Erro de negócio (grupo não cadastrado, segredo errado) não adianta repetir.
            return false;
        }
        console.log('✅ Entrada entregue ao Apps Script.', json ? (json.entradaId || json.message || '') : '');
        return true;
    } catch (e) {
        console.error('❌ Falha ao entregar ao Apps Script:', e.message);
        await enfileirar(payload, e.message);
        return false;
    }
}

async function enfileirar(payload, motivo) {
    try {
        await colEntradaFila.insertOne({
            payload,
            motivo: String(motivo || ''),
            tentativas: 0,
            criadoEm: new Date()
        });
        console.log('📥 Mensagem guardada na fila de reenvio.');
    } catch (e) {
        console.error('Falha ao enfileirar:', e.message);
    }
}

// Worker: reprocessa a fila a cada minuto, no máximo 5 tentativas por item.
async function processarFilaPendente() {
    if (!colEntradaFila || !entradaCfg.webhookUrl) return;
    try {
        const pendentes = await colEntradaFila.find({ tentativas: { $lt: 5 } }).limit(5).toArray();
        for (const item of pendentes) {
            const ok = await entregarAoAppsScriptSemFila(item.payload);
            if (ok) {
                await colEntradaFila.deleteOne({ _id: item._id });
            } else {
                await colEntradaFila.updateOne(
                    { _id: item._id },
                    { $inc: { tentativas: 1 }, $set: { ultimaTentativa: new Date() } }
                );
            }
        }
    } catch (e) {
        console.error('Erro no worker da fila:', e.message);
    }
}

// Versão que NÃO re-enfileira (para não criar laço infinito dentro do worker).
async function entregarAoAppsScriptSemFila(payload) {
    try {
        const resp = await fetch(entradaCfg.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            redirect: 'follow'
        });
        return resp.ok;
    } catch (e) {
        return false;
    }
}

// =====================================================================
// LEITURA DAS MENSAGENS DOS GRUPOS DE ENTRADA
// =====================================================================
function extrairConteudo(msg) {
    const m = msg.message || {};
    // Mensagens efêmeras e "view once" vêm embrulhadas
    const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message ||
                  m.viewOnceMessageV2?.message || m.documentWithCaptionMessage?.message || m;

    if (inner.imageMessage) {
        return { tipo: 'imagem', legenda: inner.imageMessage.caption || '', mime: inner.imageMessage.mimetype || 'image/jpeg' };
    }
    if (inner.videoMessage) {
        return { tipo: 'video', legenda: inner.videoMessage.caption || '', mime: inner.videoMessage.mimetype || 'video/mp4' };
    }
    if (inner.conversation) {
        return { tipo: 'texto', legenda: inner.conversation, mime: '' };
    }
    if (inner.extendedTextMessage) {
        return { tipo: 'texto', legenda: inner.extendedTextMessage.text || '', mime: '' };
    }
    return null;
}

async function tratarMensagemDeGrupo(msg) {
    try {
        const jid = msg.key?.remoteJid || '';
        if (!jid.endsWith('@g.us')) return;                 // não é grupo
        if (!entradaGruposSet.has(jid)) return;             // não está na allowlist
        if (msg.key.fromMe) return;                         // não escuta a si mesmo

        const id = msg.key.id;
        if (!id || jaVistas.has(id)) return;
        jaVistas.add(id);
        if (jaVistas.size > 800) {                          // não deixa a memória crescer
            const it = jaVistas.values();
            for (let i = 0; i < 300; i++) jaVistas.delete(it.next().value);
        }

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
        const remetente = (msg.key.participant || '').split('@')[0] || '';

        console.log(`📸 Entrada detectada no grupo "${grupo.nome || jid}" (${conteudo.tipo}).`);

        await entregarAoAppsScript({
            tipo: 'entrada_grupo',
            secret: entradaCfg.secret,
            groupId: jid,
            groupNome: grupo.nome || '',
            messageId: id,
            remetente: remetente,
            legenda: conteudo.legenda || '',
            imagemBase64: imagemBase64,
            mimeType: mimeType
        });
    } catch (e) {
        console.error('Erro ao tratar mensagem de grupo:', e.message);
    }
}

// =====================================================================
// CONEXÃO COM O WHATSAPP
// =====================================================================
async function connectToWhatsApp() {
    if (reconnectTimeout) clearTimeout(reconnectTimeout);

    // Trava contra reconexões sobrepostas: o watchdog e o connection.update podem
    // disparar quase juntos, e dois sockets ao mesmo tempo derrubam um ao outro.
    if (conectando) {
        console.log('⏭️ Já existe uma conexão em andamento — ignorando chamada duplicada.');
        return;
    }
    conectando = true;
    inicioTentativaConexao = Date.now();
    console.log('🔄 Inicializando instância estável do WhatsApp...');

    try {
        await conectarInterno();
    } catch (e) {
        // Se o makeWASocket estourar, nenhum listener chega a existir e o serviço
        // ficaria mudo para sempre. Aqui garantimos uma nova tentativa.
        console.error('❌ Falha ao iniciar o socket:', e.message);
        ultimoMotivoQueda = 'erro ao iniciar: ' + e.message;
        reconnectTimeout = setTimeout(connectToWhatsApp, 15000);
    } finally {
        conectando = false;
    }
}

async function conectarInterno() {
    const { state, saveCreds } = await useMongoDBAuthState(mongoCollection);

    if (sock) {
        try {
            sock.ev.removeAllListeners('connection.update');
            sock.ev.removeAllListeners('creds.update');
            sock.ev.removeAllListeners('messages.upsert');
        } catch (e) { /* silencioso */ }
    }

    sock = makeWASocket({
        auth: state,
        // NUNCA imprimir o QR no terminal: os logs do Render ficam guardados e
        // quem tiver acesso ao painel (ou a um print de log) pareia o próprio
        // aparelho na sua conta. O QR só sai pela rota /api/qr, autenticada.
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        syncFullHistory: false
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrCodeBase64 = await qrcode.toDataURL(qr);
            console.log('⚡ QR Code estável gerado e pronto para o Google Apps Script!');
        }

        if (connection === 'close') {
            isConnected = false;
            qrCodeBase64 = '';
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            ultimoMotivoQueda = String(statusCode || 'desconhecido');
            const deslogado = statusCode === DisconnectReason.loggedOut;

            console.log(`🔴 Conexão encerrada (Status: ${statusCode}). Deslogado: ${deslogado}`);

            if (deslogado) {
                // 🐞 BUG HISTÓRICO CORRIGIDO AQUI:
                // a versão anterior limpava a sessão e PARAVA — nunca chamava
                // connectToWhatsApp() de novo. Resultado: `isConnected` ficava false
                // e `qrCodeBase64` ficava vazio para sempre, então /api/qr respondia
                // "starting" eternamente e o painel girava em looping sem nunca
                // mostrar QR. Só um restart manual no Render resolvia.
                console.log('🧹 Sessão inválida/deslogada. Limpando e gerando QR novo...');
                await mongoCollection.deleteMany({});
            }

            // Em QUALQUER caso reconectamos: se foi queda, para restaurar;
            // se foi logout, para emitir um QR Code novo.
            reconnectTimeout = setTimeout(connectToWhatsApp, deslogado ? 3000 : 7000);
        } else if (connection === 'open') {
            isConnected = true;
            qrCodeBase64 = '';
            ultimoMotivoQueda = '';
            console.log('✅ WhatsApp TOTALMENTE Autenticado e Pronto!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // 🎧 ESCUTA SELETIVA: só grupos da allowlist chegam a ser processados.
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;                  // ignora sincronização de histórico
        if (entradaGruposSet.size === 0) return;        // nada cadastrado = nada a fazer
        for (const msg of messages) {
            await tratarMensagemDeGrupo(msg);
        }
    });
}

// =====================================================================
// ROTAS DA API
// =====================================================================

app.get('/api/qr', (req, res) => {
    if (isConnected) return res.json({ status: 'connected', message: 'WhatsApp conectado.' });
    if (qrCodeBase64) return res.json({ status: 'pending', qr: qrCodeBase64 });

    // Diagnóstico honesto: em vez de repetir "aguarde" para sempre, dizemos há
    // quanto tempo estamos tentando e qual foi o último motivo de queda.
    const seg = inicioTentativaConexao ? Math.round((Date.now() - inicioTentativaConexao) / 1000) : 0;
    let msg = 'Aguarde, gerando QR Code estável...';
    if (seg > 90) {
        msg = `Tentando conectar há ${seg}s sem sucesso` +
              (ultimoMotivoQueda ? ` (última queda: ${ultimoMotivoQueda})` : '') +
              '. Use "Apagar sessão e gerar QR novo".';
    }
    res.json({ status: 'starting', message: msg, tentandoHaSegundos: seg, ultimoMotivoQueda: ultimoMotivoQueda });
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        conectado: isConnected,
        gruposEscutando: entradaGruposSet.size,
        webhookConfigurado: !!entradaCfg.webhookUrl
    });
});

// ---------- CRIAÇÃO / MEMBROS ----------

app.post('/api/adicionar-grupo', async (req, res) => {
    const { nomeGrupo, clientesPhones } = req.body;
    try {
        if (!isConnected) throw new Error('WhatsApp deslogado.');
        const participants = (clientesPhones || []).map(num => `${String(num).replace(/\D/g, '')}@s.whatsapp.net`);
        const group = await sock.groupCreate(nomeGrupo, participants);
        res.json({ status: 'success', groupId: group.id });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.toString() });
    }
});

app.post('/api/adicionar-membros-grupo', async (req, res) => {
    const { groupId, clientesPhones } = req.body;
    try {
        if (!isConnected) throw new Error('WhatsApp deslogado.');
        if (!groupId || !clientesPhones || clientesPhones.length === 0) {
            throw new Error('ID do grupo ou lista de contatos ausente.');
        }
        const participants = clientesPhones.map(num => `${String(num).replace(/\D/g, '')}@s.whatsapp.net`);
        const action = await sock.groupParticipantsUpdate(groupId, participants, 'add');
        res.json({ status: 'success', action: action });
    } catch (error) {
        console.error('Erro ao adicionar membros no grupo:', error);
        res.status(500).json({ status: 'error', message: error.toString() });
    }
});

app.get('/api/listar-grupos', async (req, res) => {
    try {
        if (!isConnected) throw new Error('WhatsApp deslogado.');

        const termoBusca = req.query.busca ? String(req.query.busca).toLowerCase() : '';
        if (!termoBusca || termoBusca.length < 3) {
            return res.status(400).json({ status: 'error', message: 'Digite pelo menos 3 letras para buscar.' });
        }

        const groups = await sock.groupFetchAllParticipating();
        let groupList = Object.values(groups).map(g => ({
            id: g.id,
            subject: g.subject,
            participants: g.participants.length
        }));

        groupList = groupList
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

        const meta = await sock.groupMetadata(groupId);
        const participantes = [];
        let naoResolvidos = 0;

        for (const p of (meta.participants || [])) {
            // Contas com privacidade de LID não expõem o telefone.
            const jid = p.jid || p.id || '';
            if (jid.includes('@lid')) { naoResolvidos++; continue; }
            const numero = jid.split('@')[0].replace(/\D/g, '');
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

// ---------- ENVIO PARA GRUPOS ----------

app.post('/api/enviar-grupo', async (req, res) => {
    const { groupId, message } = req.body;
    try {
        if (!isConnected) throw new Error('WhatsApp deslogado.');
        if (!groupId || !message) throw new Error('groupId ou message ausente.');
        await sock.sendMessage(groupId, { text: String(message) });
        res.json({ status: 'success', message: 'Mensagem enviada ao grupo.' });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.toString() });
    }
});

// NOVO: publica foto + legenda (usado para anunciar o produto no grupo de clientes)
app.post('/api/enviar-grupo-midia', async (req, res) => {
    const { groupId, imagemBase64, mimeType, caption } = req.body;
    try {
        if (!isConnected) throw new Error('WhatsApp deslogado.');
        if (!groupId) throw new Error('groupId ausente.');

        if (!imagemBase64) {
            // Sem imagem, não falha: manda só o texto.
            await sock.sendMessage(groupId, { text: String(caption || '') });
            return res.json({ status: 'success', message: 'Enviado como texto (sem imagem).' });
        }

        const limpo = String(imagemBase64).replace(/^data:[^;]+;base64,/, '');
        const buffer = Buffer.from(limpo, 'base64');

        await sock.sendMessage(groupId, {
            image: buffer,
            mimetype: mimeType || 'image/jpeg',
            caption: String(caption || '')
        });

        res.json({ status: 'success', message: 'Imagem publicada no grupo.' });
    } catch (error) {
        console.error('Erro ao enviar mídia para o grupo:', error);
        res.status(500).json({ status: 'error', message: error.toString() });
    }
});

// ---------- CONFIGURAÇÃO DA ESCUTA DE ENTRADA ----------

// O Apps Script chama esta rota para dizer o que escutar e para onde mandar.
app.post('/api/config-entrada', async (req, res) => {
    try {
        const { webhookUrl, secret, grupos } = req.body;
        if (!webhookUrl) throw new Error('webhookUrl ausente.');
        if (!secret) throw new Error('secret ausente.');

        await salvarConfigEntrada({ webhookUrl, secret, grupos: grupos || [] });

        res.json({
            status: 'success',
            gruposEscutando: entradaGruposSet.size,
            message: `Escutando ${entradaGruposSet.size} grupo(s) de entrada.`
        });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.toString() });
    }
});

// Diagnóstico: o painel usa para mostrar se a ponte está de pé.
app.get('/api/config-entrada', async (req, res) => {
    let naFila = 0;
    try { naFila = await colEntradaFila.countDocuments({}); } catch (e) { /* ignora */ }
    res.json({
        status: 'ok',
        conectado: isConnected,
        gruposEscutando: entradaGruposSet.size,
        grupos: entradaCfg.grupos.map(g => ({ groupId: g.groupId, nome: g.nome })),
        webhookConfigurado: !!entradaCfg.webhookUrl,
        pendentesNaFila: naFila
    });
});

/**
 * Apaga a sessão salva no Mongo e reconecta do zero, forçando um QR Code novo.
 *
 * Serve para o caso em que a sessão gravada está corrompida ou foi desconectada
 * pelo celular: o Baileys fica tentando restaurar em looping e nunca emite nem
 * 'open' nem 'qr', então o painel trava eternamente em "iniciando".
 *
 * Depois de chamar isto, o aparelho antigo perde o pareamento — é preciso
 * escanear o QR de novo.
 */
app.post('/api/resetar-sessao', async (req, res) => {
    try {
        console.log('♻️ Reset de sessão solicitado pelo painel.');

        try { if (sock) sock.ev.removeAllListeners('connection.update'); } catch (e) { /* ignora */ }
        try { if (sock) await sock.logout(); } catch (e) { /* a sessão já podia estar inválida */ }

        await mongoCollection.deleteMany({});
        isConnected = false;
        qrCodeBase64 = '';

        // Pequena folga para o socket antigo terminar de fechar antes de subir o novo.
        setTimeout(connectToWhatsApp, 2000);

        res.json({ status: 'success', message: 'Sessão apagada. Um QR Code novo será gerado em alguns segundos.' });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.toString() });
    }
});

// Reenvia manualmente o que estiver preso na fila.
app.post('/api/reprocessar-fila', async (req, res) => {
    try {
        await processarFilaPendente();
        const restantes = await colEntradaFila.countDocuments({});
        res.json({ status: 'success', pendentesNaFila: restantes });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.toString() });
    }
});

// =====================================================================
// BOOT
// =====================================================================
async function startServer() {
    if (!MONGO_URI) {
        console.error('❌ ERRO CRÍTICO: MONGO_URI ausente!');
        return;
    }

    const mongoClient = new MongoClient(MONGO_URI);
    await mongoClient.connect();
    const db = mongoClient.db(DBNAME);
    mongoCollection = db.collection(COLLECTION);
    colEntradaCfg = db.collection(COL_ENTRADA_CFG);
    colEntradaFila = db.collection(COL_ENTRADA_FILA);
    console.log('📦 Conectado ao MongoDB com sucesso!');

    await carregarConfigEntrada();

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`🚀 Servidor Express online na porta ${PORT}`);

        // 🔒 TRAVA DE SEGURANÇA: sem chave, não conecta no WhatsApp.
        // Melhor o serviço ficar inútil do que ficar exposto: enquanto não
        // houver API_SECRET, nenhum QR Code é gerado e nenhuma sessão sobe.
        if (!SEGREDO_VALIDO) {
            console.error('❌ BLOQUEADO: defina API_SECRET (mínimo 20 caracteres) nas variáveis de ambiente do Render.');
            console.error('   Enquanto isso, o WhatsApp NÃO será conectado e todas as rotas /api respondem 503.');
            return;
        }

        connectToWhatsApp();
        setInterval(processarFilaPendente, 60 * 1000);   // worker da fila de reenvio

        // 🐕 WATCHDOG: rede de segurança final.
        // Se por qualquer motivo ficarmos 2 minutos sem estar conectados E sem QR
        // na mão, algo travou no meio do caminho — força uma nova tentativa.
        // Sem isto, um único evento perdido deixava o serviço mudo até alguém
        // reiniciar o Render na mão.
        setInterval(() => {
            if (isConnected || qrCodeBase64 || conectando) return;
            const parado = Date.now() - (inicioTentativaConexao || 0);
            if (parado > 120000) {
                console.warn(`🐕 Watchdog: ${Math.round(parado / 1000)}s sem conexão e sem QR. Reiniciando o socket...`);
                connectToWhatsApp();
            }
        }, 30 * 1000);
    });
}

startServer();
