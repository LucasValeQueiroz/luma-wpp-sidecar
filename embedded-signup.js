/* =====================================================================
   EMBEDDED SIGNUP v4 — onboarding de clientes (Coexistence ou número novo)
   =====================================================================

   POR QUE ISTO VIVE AQUI, E NÃO NO APPS SCRIPT
   --------------------------------------------
   O HtmlService entrega a página dentro de um iframe sandbox, num
   subdomínio *.googleusercontent.com que MUDA a cada carregamento. O
   Login do Facebook para Empresas exige domínio fixo na allowlist — e o
   popup do FB.login morre no cross-origin. Aqui o domínio é fixo
   (lumairam.com → rewrite do Vercel → este serviço) e o HTTPS é válido.

   O QUE MUDOU NA v4 (prazo da Meta: 15/10/2026)
   ---------------------------------------------
   • A versão deixa de ser escolhida no código: ela vem da CONFIGURAÇÃO
     criada em "Login do Facebook para Empresas" (produtos, permissões,
     tipo de token). Basta trocar META_CONFIG_ID pelo ID da config v4.
   • `sessionInfoVersion` SAI do extras — a v4 devolve a sessão sempre.
   • Coexistence continua: extras.featureType = 'whatsapp_business_app_onboarding'.
     Sem ele o popup só oferece criar uma WABA nova.
   • O evento de conclusão da Coexistence (FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING)
     traz só o waba_id — o phone_number_id é descoberto no servidor.

   O QUE ESTE MÓDULO FAZ DEPOIS QUE O CLIENTE CONCLUI
   --------------------------------------------------
   1. Troca o `code` pelo token (só no servidor; o APP_SECRET nunca vai ao navegador).
   2. Descobre WABA e número se a sessão não trouxe (debug_token + phone_numbers).
   3. Assina o app na WABA do cliente (POST /<WABA>/subscribed_apps) — sem isso
      os webhooks do número dele não chegam.
   4. Coexistence: dispara a sincronização de CONTATOS e de HISTÓRICO
      (POST /<PHONE>/smb_app_data). A Meta dá 24h para isso; antes o código
      não chamava e o histórico nunca chegava.
      Número novo: registra o número, se META_REGISTER_PIN estiver definido.
   5. Entrega tudo ao Apps Script. Se o Apps Script estiver fora, guarda no
      Mongo (coleção onboarding_pendente) e reenvia depois — o token não se perde.

   VARIÁVEIS DE AMBIENTE (Render > Environment)
   --------------------------------------------
     META_APP_ID          ID do app CHATBOTIADENS
     META_APP_SECRET      Chave secreta do app  ⚠️ nunca vai para o browser
     META_CONFIG_ID       config_id da configuração **v4** de Login para Empresas
     META_CONFIG_ID_COEX  (opcional) config separada só para Coexistence
     META_ES_EXTRAS_COEX  (opcional) JSON do extras da Coexistence, se o
                          Embedded Signup Builder gerar algo diferente
     META_ES_EXTRAS       (opcional) JSON do extras do fluxo "número novo"
     META_REGISTER_PIN    (opcional) PIN de 6 dígitos para registrar número novo
     APPS_SCRIPT_URL      (opcional) URL /exec; vazio = a mesma que o Apps
                          Script sincronizou em /api/config-entrada
     APPS_SCRIPT_SECRET   (opcional) vazio = usa a própria API_SECRET
     GRAPH_VERSION        opcional; padrão v25.0
   ===================================================================== */

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();

const APP_ID         = process.env.META_APP_ID || '';
const APP_SECRET     = process.env.META_APP_SECRET || '';
const CONFIG_ID      = process.env.META_CONFIG_ID || '';
const CONFIG_ID_COEX = process.env.META_CONFIG_ID_COEX || CONFIG_ID;
const GRAPH_VERSION  = process.env.GRAPH_VERSION || 'v25.0';
const REGISTER_PIN   = String(process.env.META_REGISTER_PIN || '').replace(/\D/g, '');
// Se não definir APPS_SCRIPT_SECRET, usa a própria API_SECRET — é o mesmo valor
// que o Apps Script guarda em SIDECAR_API_KEY e confere no recebimento.
const GAS_SECRET     = process.env.APPS_SCRIPT_SECRET || process.env.API_SECRET || '';

const FEATURE_COEX = 'whatsapp_business_app_onboarding';

function jsonDoEnv(nome, padrao) {
  const bruto = process.env[nome];
  if (!bruto) return padrao;
  try {
    const v = JSON.parse(bruto);
    return (v && typeof v === 'object') ? v : padrao;
  } catch (e) {
    console.warn(`[ES] ${nome} não é um JSON válido — usando o padrão.`);
    return padrao;
  }
}

// v4: sem sessionInfoVersion. A Coexistence continua pedindo o featureType.
const EXTRAS_COEX = jsonDoEnv('META_ES_EXTRAS_COEX', { setup: {}, featureType: FEATURE_COEX });
const EXTRAS_NOVO = jsonDoEnv('META_ES_EXTRAS', {});
delete EXTRAS_COEX.sessionInfoVersion;
delete EXTRAS_NOVO.sessionInfoVersion;

const configurado = Boolean(APP_ID && APP_SECRET && CONFIG_ID);

// URL do Apps Script: a fixa do ambiente ou a que o próprio Apps Script
// sincronizou em /api/config-entrada (server.js expõe em app.locals).
function urlAppsScript(req) {
  if (process.env.APPS_SCRIPT_URL) return process.env.APPS_SCRIPT_URL;
  try { return (req.app.locals.gasUrl && req.app.locals.gasUrl()) || ''; } catch (e) { return ''; }
}

function colecao(req, nome) {
  try { return req.app.locals.db ? req.app.locals.db.collection(nome) : null; } catch (e) { return null; }
}


/* =====================================================================
   1. A PÁGINA QUE O CLIENTE ABRE — e que aparece no vídeo do App Review
   ===================================================================== */

router.get('/conectar', (req, res) => {
  if (!configurado) {
    return res.status(503).send(
      '<h1>Onboarding indisponível</h1>' +
      '<p>Faltam META_APP_ID, META_APP_SECRET ou META_CONFIG_ID no ambiente.</p>'
    );
  }
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.send(paginaConectar());
});


/* =====================================================================
   2. RECEBE O RESULTADO DO FLUXO
   ===================================================================== */

// Freio simples: esta rota é pública (o navegador do cliente não tem chave).
const tentativas = new Map();
function limiteAtingido(ip) {
  const agora = Date.now();
  const lista = (tentativas.get(ip) || []).filter(t => agora - t < 60000);
  lista.push(agora);
  tentativas.set(ip, lista);
  if (tentativas.size > 500) tentativas.clear();
  return lista.length > 10;
}

router.post('/api/es/finalizar', express.json({ limit: '1mb' }), async (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  if (limiteAtingido(ip)) return res.status(429).json({ ok: false, erro: 'Muitas tentativas. Aguarde 1 minuto.' });

  const { code, modo } = req.body || {};
  let { waba_id, phone_number_id, business_id, event } = req.body || {};
  if (!code) return res.status(400).json({ ok: false, erro: 'code ausente' });

  const ehCoexistence = event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' || modo === 'coex';
  const etapas = {};

  try {
    // 1) code → token (só aqui no servidor)
    const token = await trocarCodePorToken(code);
    etapas.token = 'ok';

    // 2) WABA e número, quando a sessão não trouxe
    if (!waba_id) {
      waba_id = await descobrirWabaPeloToken(token).catch(e => { etapas.descobrirWaba = e.message; return null; });
    }
    let detalhes = null;
    try {
      detalhes = await lerDetalhesWaba(waba_id, token);
    } catch (e) {
      etapas.detalhes = 'falhou: ' + e.message;   // não é fatal
    }
    if (!phone_number_id && detalhes && detalhes.phone_numbers && detalhes.phone_numbers.data) {
      const nums = detalhes.phone_numbers.data;
      if (nums.length) phone_number_id = nums[0].id;
      if (nums.length > 1) etapas.avisoNumeros = nums.length + ' números na WABA — usei o primeiro (' + nums[0].display_phone_number + ').';
    }

    // 3) assina o app na WABA (webhooks do cliente passam a chegar)
    if (waba_id) {
      etapas.assinatura = await graphPost(`${waba_id}/subscribed_apps`, token, {})
        .then(() => 'ok').catch(e => 'falhou: ' + e.message);
    } else {
      etapas.assinatura = 'pulado: sem waba_id';
    }

    // 4) Coexistence: sincroniza contatos e histórico (janela de 24h)
    //    Número novo: registra, se houver PIN configurado.
    if (ehCoexistence) {
      if (phone_number_id) {
        etapas.syncContatos = await graphPost(`${phone_number_id}/smb_app_data`, token,
          { messaging_product: 'whatsapp', sync_type: 'smb_app_state_sync' })
          .then(r => 'ok ' + (r.request_id || '')).catch(e => 'falhou: ' + e.message);
        etapas.syncHistorico = await graphPost(`${phone_number_id}/smb_app_data`, token,
          { messaging_product: 'whatsapp', sync_type: 'history' })
          .then(r => 'ok ' + (r.request_id || '')).catch(e => 'falhou: ' + e.message);
      } else {
        etapas.syncContatos = etapas.syncHistorico = 'pulado: número não identificado — sincronize em até 24h';
      }
    } else if (phone_number_id && /^\d{6}$/.test(REGISTER_PIN)) {
      etapas.registro = await graphPost(`${phone_number_id}/register`, token,
        { messaging_product: 'whatsapp', pin: REGISTER_PIN })
        .then(() => 'ok').catch(e => 'falhou: ' + e.message);
    } else if (phone_number_id) {
      etapas.registro = 'pendente: defina META_REGISTER_PIN ou registre o número no Gerenciador do WhatsApp';
    }

    // 5) entrega ao Apps Script (com rede de segurança no Mongo)
    const payload = {
      tipo: 'onboarding_coexistence',            // nome mantido por compatibilidade
      waba_id: waba_id || null,
      phone_number_id: phone_number_id || null,
      business_id: business_id || null,
      coexistence: ehCoexistence,
      modo: ehCoexistence ? 'coex' : 'novo',
      versao_signup: 'v4',
      graph_version: GRAPH_VERSION,
      access_token: token,
      detalhes,
      etapas,
      recebido_em: new Date().toISOString()
    };
    etapas.appsScript = await avisarAppsScript(req, payload)
      .then(() => 'ok')
      .catch(async (e) => {
        const col = colecao(req, 'onboarding_pendente');
        if (col) {
          await col.insertOne({ payload, motivo: e.message, criadoEm: new Date() }).catch(() => {});
          return 'pendente (guardado para reenvio): ' + e.message;
        }
        return 'falhou: ' + e.message;
      });

    console.log('[ES] Onboarding v4 concluído. waba=%s phone=%s coex=%s etapas=%j',
      waba_id, phone_number_id, ehCoexistence, etapas);

    // O token NUNCA volta para o browser.
    res.json({
      ok: true,
      coexistence: ehCoexistence,
      historico: String(etapas.syncHistorico || '').startsWith('ok'),
      avisos: Object.entries(etapas)
        .filter(([, v]) => /falhou|pendente|pulado/.test(String(v)))
        .map(([k]) => k)
    });

  } catch (err) {
    console.error('[ES] Falha ao finalizar onboarding:', err.message, etapas);
    res.status(500).json({ ok: false, erro: 'Falha ao concluir a conexão.' });
  }
});

// Reenvia ao Apps Script os onboardings que ficaram guardados (rota protegida
// pela API_SECRET, porque está sob /api e é montada antes do guard só para
// o /api/es/finalizar — aqui conferimos a chave na mão).
router.post('/api/es/reenviar-pendentes', express.json(), async (req, res) => {
  const chave = Buffer.from(String(req.headers['x-api-key'] || ''));
  const certa = Buffer.from(String(process.env.API_SECRET || ''));
  if (certa.length < 20 || chave.length !== certa.length || !crypto.timingSafeEqual(chave, certa)) {
    return res.status(401).json({ status: 'error', message: 'Chave de API inválida.' });
  }
  const col = colecao(req, 'onboarding_pendente');
  if (!col) return res.json({ status: 'error', message: 'Mongo indisponível.' });
  const itens = await col.find({}).limit(20).toArray();
  let reenviados = 0;
  for (const it of itens) {
    try { await avisarAppsScript(req, it.payload); await col.deleteOne({ _id: it._id }); reenviados++; } catch (e) { /* tenta depois */ }
  }
  res.json({ status: 'success', reenviados, restantes: itens.length - reenviados });
});


/* =====================================================================
   3. CHAMADAS À GRAPH API
   ===================================================================== */

async function lerJson(r) {
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const e = j.error || {};
    throw new Error((e.message || ('HTTP ' + r.status)) + (e.code ? ' (código ' + e.code + (e.error_subcode ? '/' + e.error_subcode : '') + ')' : ''));
  }
  return j;
}

/**
 * Troca o `code` do Embedded Signup por um token de acesso.
 * Neste fluxo NÃO se envia redirect_uri: o code vem do SDK JavaScript com
 * override_default_response_type. Mandar redirect_uri dá erro de mismatch.
 */
async function trocarCodePorToken(code) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`);
  url.searchParams.set('client_id', APP_ID);
  url.searchParams.set('client_secret', APP_SECRET);
  url.searchParams.set('code', code);
  const j = await lerJson(await fetch(url, { method: 'GET', signal: AbortSignal.timeout(20000) }))
    .catch(e => { throw new Error('troca de code falhou: ' + e.message); });
  if (!j.access_token) throw new Error('troca de code falhou: resposta sem access_token');
  return j.access_token;
}

/** Sem waba_id na sessão: descobre pela permissão concedida no token. */
async function descobrirWabaPeloToken(token) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/debug_token`);
  url.searchParams.set('input_token', token);
  url.searchParams.set('access_token', `${APP_ID}|${APP_SECRET}`);
  const j = await lerJson(await fetch(url, { signal: AbortSignal.timeout(20000) }));
  const escopos = (j.data && j.data.granular_scopes) || [];
  const gestao = escopos.find(s => s.scope === 'whatsapp_business_management');
  const id = gestao && gestao.target_ids && gestao.target_ids[0];
  if (!id) throw new Error('nenhuma WABA concedida no token');
  return id;
}

/** Lê nome e números da WABA recém-conectada, para o CRM exibir. */
async function lerDetalhesWaba(wabaId, token) {
  if (!wabaId) return null;
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}`);
  url.searchParams.set('fields', 'id,name,currency,timezone_id,phone_numbers{id,display_phone_number,verified_name,quality_rating,platform_type,status}');
  return lerJson(await fetch(url, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(20000) }));
}

async function graphPost(caminho, token, corpo) {
  const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${caminho}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo || {}),
    signal: AbortSignal.timeout(20000)
  });
  return lerJson(r);
}

/** Repassa o resultado para o Apps Script, com o segredo compartilhado. */
async function avisarAppsScript(req, payload) {
  const url = urlAppsScript(req);
  if (!url) throw new Error('URL do Apps Script desconhecida (defina APPS_SCRIPT_URL ou sincronize a escuta no CRM)');
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, secret: GAS_SECRET }),
    redirect: 'follow',
    signal: AbortSignal.timeout(60000)
  });
  const texto = await r.text();
  if (!r.ok) throw new Error('Apps Script respondeu HTTP ' + r.status);
  let j = null;
  try { j = JSON.parse(texto); } catch (e) { /* HTML = página de erro/login do Google */ }
  if (!j) throw new Error('Apps Script respondeu sem JSON (URL /exec correta? nova versão publicada?)');
  if (j.ok === false) throw new Error('Apps Script recusou: ' + (j.erro || 'motivo não informado'));
}


/* =====================================================================
   4. O HTML
   =====================================================================
   Página única, sem dependência além do SDK da Meta. É esta tela que
   aparece no vídeo do App Review — por isso ela deixa visível QUEM está
   concedendo acesso a QUEM, e o que acontece com o app do celular.
   ===================================================================== */

function paginaConectar() {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Conectar seu WhatsApp — Luma CRM</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#f5f4f1;color:#1c1b19;padding:16px;
    font:16px/1.6 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
  .card{background:#fff;max-width:480px;width:100%;
    border:1px solid #e5e2dc;border-radius:14px;padding:32px 28px;
    box-shadow:0 1px 3px rgba(0,0,0,.04)}
  h1{margin:0 0 8px;font-size:23px;letter-spacing:-.02em}
  .sub{color:#6b6862;margin:0 0 20px;font-size:15px}
  .opcoes{display:grid;gap:10px;margin:0 0 20px}
  .op{display:flex;gap:12px;align-items:flex-start;border:1.5px solid #e5e2dc;border-radius:10px;
    padding:12px 14px;cursor:pointer}
  .op input{margin-top:5px;accent-color:#1877f2}
  .op b{display:block;font-size:15px}
  .op span{font-size:13.5px;color:#6b6862}
  .op:has(input:checked){border-color:#1877f2;background:#f3f8ff}
  ul{margin:0 0 22px;padding-left:20px;color:#3d3b37;font-size:14px}
  li{margin-bottom:6px}
  button{width:100%;padding:13px;border:0;border-radius:9px;background:#1877f2;
    color:#fff;font-size:15.5px;font-weight:600;cursor:pointer}
  button:hover{background:#166fe0}
  button:disabled{background:#9db8dd;cursor:default}
  .msg{margin-top:18px;padding:13px 15px;border-radius:9px;font-size:14.5px;display:none}
  .ok{background:#eaf3ee;color:#255c41;border:1px solid #2f6f4f}
  .erro{background:#fbeceb;color:#7d2a2a;border:1px solid #8c2f2f}
  .rodape{margin-top:22px;font-size:12.5px;color:#8b8880;text-align:center}
  .rodape a{color:#8b8880}
</style>
</head>
<body>
<div class="card">
  <h1>Conectar seu WhatsApp ao Luma CRM</h1>
  <p class="sub">Sua empresa autoriza o Luma CRM a atender pelo seu número oficial.</p>

  <div class="opcoes" role="radiogroup" aria-label="Como você usa o WhatsApp hoje">
    <label class="op">
      <input type="radio" name="modo" value="coex" checked>
      <div><b>Já uso o WhatsApp Business no celular</b>
      <span>Continue usando o app normalmente. Seus contatos e até 6 meses de conversas vêm junto, se você autorizar.</span></div>
    </label>
    <label class="op">
      <input type="radio" name="modo" value="novo">
      <div><b>Número novo, só para a plataforma</b>
      <span>O número fica dedicado ao atendimento pelo CRM.</span></div>
    </label>
  </div>

  <ul>
    <li>Sua equipe atende pela caixa compartilhada do CRM</li>
    <li>No celular, a tela de autorização mostra exatamente o que está sendo compartilhado</li>
    <li>Você pode revogar o acesso quando quiser, pelo Gerenciador de Negócios</li>
  </ul>

  <button id="btn" disabled>Carregando…</button>
  <div id="msg" class="msg" role="status"></div>

  <p class="rodape">
    Lumairam Info Tech Dev · CNPJ 61.868.004/0001-80<br>
    <a href="https://lumairam.com/politicadeprivacidade.html">Política de privacidade</a> ·
    <a href="https://lumairam.com/exclusao-de-dados.html">Exclusão de dados</a>
  </p>
</div>

<script>
  var APP_ID      = ${JSON.stringify(APP_ID)};
  var CONFIG      = { coex: ${JSON.stringify(CONFIG_ID_COEX)}, novo: ${JSON.stringify(CONFIG_ID)} };
  var EXTRAS      = { coex: ${JSON.stringify(EXTRAS_COEX)}, novo: ${JSON.stringify(EXTRAS_NOVO)} };
  var sessao      = {};   // preenchido pelo session logging da Meta

  var btn = document.getElementById('btn');
  var msg = document.getElementById('msg');

  function aviso(texto, tipo) {
    msg.textContent = texto;
    msg.className = 'msg ' + tipo;
    msg.style.display = 'block';
  }
  function modoEscolhido() {
    var m = document.querySelector('input[name=modo]:checked');
    return m ? m.value : 'coex';
  }
  function liberar() {
    btn.disabled = false;
    btn.textContent = 'Conectar com o Facebook';
  }

  // Session logging: a Meta manda os IDs por postMessage. Na Coexistence o
  // evento de conclusão traz só o waba_id — o servidor descobre o número.
  window.addEventListener('message', function (ev) {
    var origem = String(ev.origin || '');
    if (!/^https:\\/\\/([a-z0-9-]+\\.)?facebook\\.com$/.test(origem)) return;
    var d = ev.data;
    try { if (typeof d === 'string') d = JSON.parse(d); } catch (e) { return; }
    if (!d || d.type !== 'WA_EMBEDDED_SIGNUP') return;
    var dados = d.data || {};
    sessao.event = d.event || sessao.event;
    if (dados.waba_id) sessao.waba_id = dados.waba_id;
    if (dados.phone_number_id) sessao.phone_number_id = dados.phone_number_id;
    if (dados.business_id) sessao.business_id = dados.business_id;
    if (d.event === 'CANCEL') sessao.cancelouEm = dados.current_step || '';
    if (d.event === 'ERROR') sessao.erro = dados.error_message || 'erro no fluxo';
  });

  window.fbAsyncInit = function () {
    FB.init({ appId: APP_ID, autoLogAppEvents: true, xfbml: false, version: ${JSON.stringify(GRAPH_VERSION)} });
    liberar();
  };

  (function (d, s, id) {
    var js, fjs = d.getElementsByTagName(s)[0];
    if (d.getElementById(id)) return;
    js = d.createElement(s); js.id = id; js.async = true; js.defer = true; js.crossOrigin = 'anonymous';
    js.src = 'https://connect.facebook.net/pt_BR/sdk.js';
    fjs.parentNode.insertBefore(js, fjs);
  }(document, 'script', 'facebook-jssdk'));

  function finalizar(code, modo, tentativa) {
    // A mensagem da sessão às vezes chega um instante depois do callback.
    if (!sessao.event && tentativa < 6) {
      return setTimeout(function () { finalizar(code, modo, tentativa + 1); }, 300);
    }
    btn.textContent = 'Concluindo…';
    fetch('/api/es/finalizar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: code,
        modo: modo,
        waba_id: sessao.waba_id,
        phone_number_id: sessao.phone_number_id,
        business_id: sessao.business_id,
        event: sessao.event
      })
    })
    .then(function (r) { return r.json(); })
    .then(function (r) {
      if (!r.ok) throw new Error(r.erro || 'falha');
      btn.textContent = 'Conectado ✓';
      if (r.coexistence) {
        aviso(r.historico
          ? 'Pronto! Seu WhatsApp Business continua funcionando no celular, e o histórico começa a chegar nas próximas horas.'
          : 'Pronto! Seu número foi conectado. Nossa equipe vai confirmar a importação do histórico com você.', 'ok');
      } else {
        aviso('Pronto! Sua conta foi conectada ao Luma CRM.', 'ok');
      }
    })
    .catch(function () {
      liberar();
      aviso('Não foi possível concluir. Tente novamente em instantes.', 'erro');
    });
  }

  btn.onclick = function () {
    var modo = modoEscolhido();
    sessao = {};
    btn.disabled = true;
    btn.textContent = 'Aguardando autorização…';
    msg.style.display = 'none';

    FB.login(function (resposta) {
      var code = resposta && resposta.authResponse && resposta.authResponse.code;
      if (!code) {
        liberar();
        if (sessao.erro) aviso('A Meta informou um erro: ' + sessao.erro, 'erro');
        else aviso('Conexão cancelada' + (sessao.cancelouEm ? ' (na etapa ' + sessao.cancelouEm + ')' : '') + '. Você pode tentar de novo.', 'erro');
        return;
      }
      finalizar(code, modo, 0);
    }, {
      config_id: CONFIG[modo],
      response_type: 'code',
      override_default_response_type: true,
      extras: EXTRAS[modo]
    });
  };
</script>
</body>
</html>`;
}

module.exports = router;
