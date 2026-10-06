/* =====================================================================
   EMBEDDED SIGNUP — onboarding de clientes em modo Coexistence
   =====================================================================

   POR QUE ISTO VIVE AQUI, E NÃO NO APPS SCRIPT
   --------------------------------------------
   O HtmlService entrega a página dentro de um iframe sandbox, num
   subdomínio *.googleusercontent.com que MUDA a cada carregamento. O
   Login do Facebook para Empresas exige redirect URI fixo, domínio na
   allowlist e Strict Mode — nada disso fecha com domínio variável, e o
   popup do FB.login morre no cross-origin.

   Aqui no sidecar o domínio é fixo (lumairam.com) e o HTTPS é válido.

   COMO MONTAR NO server.js
   ------------------------
   Duas linhas, perto das outras rotas:

       const embeddedSignup = require('./embedded-signup');
       app.use(embeddedSignup);

   Nada mais no server.js precisa mudar.

   VARIÁVEIS DE AMBIENTE (Render > Environment)
   --------------------------------------------
     META_APP_ID          ID do app CHATBOTIADENS
     META_APP_SECRET      Chave secreta do app  ⚠️ nunca vai para o browser
     META_CONFIG_ID       config_id da configuração de Login para Empresas
     APPS_SCRIPT_URL      URL /exec do Web App do Apps Script
     APPS_SCRIPT_SECRET   Segredo compartilhado com o Apps Script
     GRAPH_VERSION        opcional; padrão v23.0 (a versão do seu app)

   NO PAINEL DA META
   -----------------
     URL de retorno OAuth ....... https://lumairam.com/conectar
     Gerenciador de Domínios .... lumairam.com
     Política de privacidade .... https://lumairam.com/politicadeprivacidade.html
     Exclusão de dados .......... https://lumairam.com/exclusao-de-dados.html

   O DOMÍNIO É DO VERCEL, NÃO DO RENDER
   ------------------------------------
   lumairam.com aponta para o site estático no Vercel. Para que
   https://lumairam.com/conectar caia aqui no sidecar, o repositório do
   site precisa de um vercel.json com rewrite para o Render — assim tudo
   fica na mesma origem e o redirect URI vive no domínio principal, que
   é o que o revisor da Meta espera ver.

   ⚠️ HIBERNAÇÃO DO RENDER: o plano grátis dorme após ~15 min. Um revisor
   que abrir /conectar frio espera 30 a 60 segundos numa tela em branco e
   reprova. Confirme que o pinger em /ping está ativo ANTES de gravar o
   vídeo e ANTES de enviar o App Review.

   ===================================================================== */

const express = require('express');
const router  = express.Router();

const APP_ID        = process.env.META_APP_ID || '';
const APP_SECRET    = process.env.META_APP_SECRET || '';
const CONFIG_ID     = process.env.META_CONFIG_ID || '';
const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v23.0';
const GAS_URL       = process.env.APPS_SCRIPT_URL || '';
// Se não definir APPS_SCRIPT_SECRET, usa a própria API_SECRET — é o mesmo valor
// que o Apps Script guarda em SIDECAR_API_KEY e confere no recebimento.
const GAS_SECRET    = process.env.APPS_SCRIPT_SECRET || process.env.API_SECRET || '';

const configurado = Boolean(APP_ID && APP_SECRET && CONFIG_ID);


/* =====================================================================
   1. A PÁGINA QUE O CLIENTE ABRE — e que você vai filmar
   ===================================================================== */

router.get('/conectar', (req, res) => {
  if (!configurado) {
    return res.status(503).send(
      '<h1>Onboarding indisponível</h1>' +
      '<p>Faltam META_APP_ID, META_APP_SECRET ou META_CONFIG_ID no ambiente.</p>'
    );
  }

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(paginaConectar());
});


/* =====================================================================
   2. RECEBE O RESULTADO DO FLUXO
   =====================================================================
   O browser manda o `code` e os dados da sessão. A troca do code pelo
   token acontece AQUI, no servidor: o APP_SECRET nunca pode circular
   pelo navegador do cliente.
   ===================================================================== */

router.post('/api/es/finalizar', express.json({ limit: '1mb' }), async (req, res) => {
  const { code, waba_id, phone_number_id, event } = req.body || {};

  if (!code) {
    return res.status(400).json({ ok: false, erro: 'code ausente' });
  }

  try {
    const token = await trocarCodePorToken(code);

    // Em Coexistence o número JÁ está registrado. Não chame /register:
    // a chamada falha e, pior, pode confundir o estado do onboarding.
    const ehCoexistence = event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING';

    let detalhes = null;
    try {
      detalhes = await lerDetalhesWaba(waba_id, token);
    } catch (e) {
      // Não é fatal: o essencial é não perder o token e o waba_id.
      console.warn('[ES] Não consegui ler detalhes da WABA:', e.message);
    }

    await avisarAppsScript({
      tipo: 'onboarding_coexistence',
      waba_id: waba_id || null,
      phone_number_id: phone_number_id || null,
      coexistence: ehCoexistence,
      access_token: token,
      detalhes,
      recebido_em: new Date().toISOString()
    });

    console.log(
      '[ES] Onboarding concluído. waba=%s phone=%s coexistence=%s',
      waba_id, phone_number_id, ehCoexistence
    );

    // O token NUNCA volta para o browser.
    res.json({ ok: true, coexistence: ehCoexistence });

  } catch (err) {
    console.error('[ES] Falha ao finalizar onboarding:', err.message);
    res.status(500).json({ ok: false, erro: 'Falha ao concluir a conexão.' });
  }
});


/* =====================================================================
   3. CHAMADAS À GRAPH API
   ===================================================================== */

/**
 * Troca o `code` do Embedded Signup por um token de acesso.
 *
 * Neste fluxo NÃO se envia redirect_uri: o code vem do SDK JavaScript
 * com override_default_response_type, não de um redirect de browser.
 * Mandar redirect_uri aqui faz a Meta devolver erro de mismatch.
 */
async function trocarCodePorToken(code) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`);
  url.searchParams.set('client_id', APP_ID);
  url.searchParams.set('client_secret', APP_SECRET);
  url.searchParams.set('code', code);

  const r = await fetch(url, { method: 'GET' });
  const j = await r.json().catch(() => ({}));

  if (!r.ok || !j.access_token) {
    const motivo = (j.error && j.error.message) || ('HTTP ' + r.status);
    throw new Error('troca de code falhou: ' + motivo);
  }
  return j.access_token;
}


/** Lê nome e números da WABA recém-conectada, para o CRM exibir. */
async function lerDetalhesWaba(wabaId, token) {
  if (!wabaId) return null;

  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}`);
  url.searchParams.set('fields', 'id,name,currency,timezone_id,phone_numbers{id,display_phone_number,verified_name,quality_rating}');

  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const j = await r.json().catch(() => ({}));

  if (!r.ok) {
    throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
  }
  return j;
}


/** Repassa o resultado para o Apps Script, com o segredo compartilhado. */
async function avisarAppsScript(payload) {
  if (!GAS_URL) {
    console.warn('[ES] APPS_SCRIPT_URL não definida — resultado não repassado.');
    return;
  }

  const r = await fetch(GAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, secret: GAS_SECRET })
  });

  if (!r.ok) {
    throw new Error('Apps Script respondeu HTTP ' + r.status);
  }
}


/* =====================================================================
   4. O HTML
   =====================================================================
   Página única, sem dependência além do SDK da Meta. É esta tela que
   aparece no vídeo do App Review — por isso ela precisa deixar visível
   QUEM está concedendo acesso a QUEM.
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
    background:#f5f4f1;color:#1c1b19;
    font:16px/1.6 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
  .card{background:#fff;max-width:460px;width:calc(100% - 32px);
    border:1px solid #e5e2dc;border-radius:14px;padding:36px 32px;
    box-shadow:0 1px 3px rgba(0,0,0,.04)}
  h1{margin:0 0 8px;font-size:23px;letter-spacing:-.02em}
  .sub{color:#6b6862;margin:0 0 24px;font-size:15px}
  ul{margin:0 0 26px;padding-left:20px;color:#3d3b37;font-size:14.5px}
  li{margin-bottom:7px}
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
  <p class="sub">Sua empresa autoriza o Luma CRM a atender pelo seu número —
     sem perder o app no celular.</p>

  <ul>
    <li>Seu WhatsApp Business continua funcionando normalmente</li>
    <li>Sua equipe passa a atender pela caixa compartilhada do CRM</li>
    <li>Até 6 meses do seu histórico vêm junto, se você autorizar</li>
    <li>Você pode revogar o acesso quando quiser, pelo Gerenciador de Negócios</li>
  </ul>

  <button id="btn" disabled>Carregando…</button>
  <div id="msg" class="msg"></div>

  <p class="rodape">
    Lumairam Info Tech Dev · CNPJ 61.868.004/0001-80<br>
    <a href="https://lumairam.com/politicadeprivacidade.html">Política de privacidade</a> ·
    <a href="https://lumairam.com/exclusao-de-dados.html">Exclusão de dados</a>
  </p>
</div>

<script>
  var APP_ID    = ${JSON.stringify(APP_ID)};
  var CONFIG_ID = ${JSON.stringify(CONFIG_ID)};
  var sessao    = {};   // preenchido pelo session logging da Meta

  var btn = document.getElementById('btn');
  var msg = document.getElementById('msg');

  function aviso(texto, tipo) {
    msg.textContent = texto;
    msg.className = 'msg ' + tipo;
    msg.style.display = 'block';
  }

  // Session logging: a Meta manda os IDs por postMessage ANTES do callback
  // do FB.login. Sem escutar isto, você fica sem o waba_id.
  window.addEventListener('message', function (ev) {
    if (ev.origin !== 'https://www.facebook.com' &&
        ev.origin !== 'https://web.facebook.com') return;
    try {
      var d = JSON.parse(ev.data);
      if (d.type === 'WA_EMBEDDED_SIGNUP') {
        if (d.data) {
          sessao.waba_id = d.data.waba_id || sessao.waba_id;
          sessao.phone_number_id = d.data.phone_number_id || sessao.phone_number_id;
        }
        if (d.event) sessao.event = d.event;
      }
    } catch (e) { /* mensagem de terceiro, ignora */ }
  });

  window.fbAsyncInit = function () {
    FB.init({ appId: APP_ID, cookie: true, xfbml: false, version: '${GRAPH_VERSION}' });
    btn.disabled = false;
    btn.textContent = 'Conectar com o Facebook';
  };

  (function (d, s, id) {
    var js, fjs = d.getElementsByTagName(s)[0];
    if (d.getElementById(id)) return;
    js = d.createElement(s); js.id = id;
    js.src = 'https://connect.facebook.net/pt_BR/sdk.js';
    fjs.parentNode.insertBefore(js, fjs);
  }(document, 'script', 'facebook-jssdk'));

  btn.onclick = function () {
    btn.disabled = true;
    btn.textContent = 'Aguardando autorização…';
    msg.style.display = 'none';

    FB.login(function (resposta) {
      var code = resposta && resposta.authResponse && resposta.authResponse.code;

      if (!code) {
        btn.disabled = false;
        btn.textContent = 'Conectar com o Facebook';
        aviso('Conexão cancelada. Você pode tentar de novo.', 'erro');
        return;
      }

      btn.textContent = 'Concluindo…';

      fetch('/api/es/finalizar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: code,
          waba_id: sessao.waba_id,
          phone_number_id: sessao.phone_number_id,
          event: sessao.event
        })
      })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (r.ok) {
          btn.textContent = 'Conectado ✓';
          aviso(r.coexistence
            ? 'Pronto! Seu histórico começa a chegar nos próximos minutos.'
            : 'Pronto! Sua conta foi conectada ao Luma CRM.', 'ok');
        } else {
          throw new Error(r.erro || 'falha');
        }
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = 'Conectar com o Facebook';
        aviso('Não foi possível concluir. Tente novamente em instantes.', 'erro');
      });

    }, {
      config_id: CONFIG_ID,
      response_type: 'code',
      override_default_response_type: true,
      extras: {
        setup: {},
        featureType: 'whatsapp_business_app_onboarding',
        sessionInfoVersion: '3'
      }
    });
  };
</script>
</body>
</html>`;
}

module.exports = router;
