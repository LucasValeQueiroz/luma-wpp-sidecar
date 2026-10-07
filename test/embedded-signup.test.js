// Teste do Embedded Signup v4 SEM falar com a Meta: a Graph API e o Apps Script
// são dublês. Rode com:  node test/embedded-signup.test.js   (ou npm test)
process.env.META_APP_ID = '111';
process.env.META_APP_SECRET = 'segredo-do-app';
process.env.META_CONFIG_ID = 'CFG-V4';
process.env.API_SECRET = 'y'.repeat(32);
const assert = require('assert');
const express = require('express');
const fakeMongo = require('./fakemongo');

// ---- dublê da Graph API (intercepta o fetch global) ----
const chamadas = [];
let historicoFalha = false;
const fetchReal = globalThis.fetch;
globalThis.fetch = async (url, opt = {}) => {
  const u = new URL(String(url));
  if (u.hostname !== 'graph.facebook.com') return fetchReal(url, opt);
  const caminho = u.pathname.replace(/^\/v[\d.]+\//, '');
  const corpo = opt.body ? JSON.parse(opt.body) : null;
  chamadas.push({ metodo: opt.method || 'GET', caminho, corpo, versao: u.pathname.split('/')[1], auth: (opt.headers || {}).Authorization });
  const ok = (j) => new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } });
  const erro = (m, c) => new Response(JSON.stringify({ error: { message: m, code: c } }), { status: 400 });
  if (caminho === 'oauth/access_token') return u.searchParams.get('code') === 'CODE-OK' || u.searchParams.get('code') === 'CODE-2' ? ok({ access_token: 'TOKEN-CLIENTE' }) : erro('Invalid code', 100);
  if (caminho === 'debug_token') return ok({ data: { granular_scopes: [{ scope: 'whatsapp_business_messaging', target_ids: ['W9'] }, { scope: 'whatsapp_business_management', target_ids: ['W9'] }] } });
  if (/^W\d+$/.test(caminho)) return ok({ id: caminho, name: 'Loja do Cliente', phone_numbers: { data: [{ id: 'PN-' + caminho, display_phone_number: '+55 37 98888-0000', verified_name: 'Loja' }] } });
  if (caminho.endsWith('/subscribed_apps')) return ok({ success: true });
  if (caminho.endsWith('/smb_app_data')) return (historicoFalha && corpo.sync_type === 'history') ? erro('History sync is turned off by the business', 2593109) : ok({ messaging_product: 'whatsapp', request_id: 'REQ-' + corpo.sync_type });
  if (caminho.endsWith('/register')) return ok({ success: true });
  return erro('rota não simulada ' + caminho, 1);
};

(async () => {
  // ---- dublê do Apps Script ----
  const gas = express(); gas.use(express.json());
  const recebidos = []; let gasFora = false;
  gas.post('/exec', (req, res) => { if (gasFora) return res.status(500).send('fora'); recebidos.push(req.body); res.json({ ok: true }); });
  const gasSrv = gas.listen(3988);

  const app = express(); app.use(express.json());
  const client = new fakeMongo.MongoClient(); app.locals.db = client.db('t');
  app.locals.gasUrl = () => 'http://127.0.0.1:3988/exec';
  app.use(require('../embedded-signup'));
  const srv = app.listen(3987);
  const B = 'http://127.0.0.1:3987';
  const post = (p, b, h = {}) => fetchReal(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(b) }).then(async r => ({ code: r.status, j: await r.json() }));

  // 1) A página usa a config v4 e NÃO manda sessionInfoVersion
  const html = await fetchReal(B + '/conectar').then(r => r.text());
  assert.ok(html.includes('"CFG-V4"'));
  assert.ok(html.includes('whatsapp_business_app_onboarding'));
  assert.ok(!html.includes('sessionInfoVersion'), 'v4 não usa sessionInfoVersion');
  assert.ok(html.includes('"v25.0"'));
  console.log('1) página /conectar: config v4, featureType da Coexistence, sem sessionInfoVersion, SDK v25.0');

  // 2) Coexistence: sessão só com waba_id → descobre número, assina, sincroniza
  let r = await post('/api/es/finalizar', { code: 'CODE-OK', modo: 'coex', waba_id: 'W1', event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' });
  console.log('2) coexistence → navegador recebeu:', JSON.stringify(r.j));
  assert.equal(r.j.ok, true); assert.equal(r.j.historico, true);
  assert.ok(!JSON.stringify(r.j).includes('TOKEN'), 'token nunca vai ao navegador');
  const seq = chamadas.map(c => c.metodo + ' ' + c.caminho + (c.corpo && c.corpo.sync_type ? ' ' + c.corpo.sync_type : ''));
  console.log('   chamadas à Graph:', seq.join(' → '));
  assert.deepEqual(seq, ['GET oauth/access_token', 'GET W1', 'POST W1/subscribed_apps', 'POST PN-W1/smb_app_data smb_app_state_sync', 'POST PN-W1/smb_app_data history']);
  assert.ok(chamadas.every(c => c.versao === 'v25.0'));
  const g1 = recebidos[0];
  console.log('   Apps Script recebeu:', JSON.stringify({ tipo: g1.tipo, waba: g1.waba_id, phone: g1.phone_number_id, coex: g1.coexistence, etapas: g1.etapas, temToken: !!g1.access_token, temSecret: !!g1.secret }));
  assert.equal(g1.phone_number_id, 'PN-W1'); assert.equal(g1.access_token, 'TOKEN-CLIENTE'); assert.equal(g1.secret, process.env.API_SECRET);

  // 3) Número novo, sessão sem waba_id → debug_token; sem PIN o registro fica pendente
  chamadas.length = 0;
  r = await post('/api/es/finalizar', { code: 'CODE-OK', modo: 'novo', event: 'FINISH' });
  console.log('3) número novo → avisos:', r.j.avisos, '| chamadas:', chamadas.map(c => c.metodo + ' ' + c.caminho).join(' → '));
  assert.equal(recebidos[1].waba_id, 'W9'); assert.ok(String(recebidos[1].etapas.registro).startsWith('pendente'));
  assert.ok(!chamadas.some(c => c.caminho.endsWith('smb_app_data')), 'fluxo novo não sincroniza histórico');

  // 4) Cliente desligou o compartilhamento de histórico → conecta mesmo assim, com aviso
  historicoFalha = true;
  r = await post('/api/es/finalizar', { code: 'CODE-OK', modo: 'coex', waba_id: 'W2', event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' });
  console.log('4) histórico recusado → ok:', r.j.ok, 'historico:', r.j.historico, '| etapa:', recebidos[2].etapas.syncHistorico);
  assert.equal(r.j.ok, true); assert.equal(r.j.historico, false); assert.ok(recebidos[2].etapas.syncHistorico.includes('2593109'));
  historicoFalha = false;

  // 5) Apps Script fora do ar → guarda no Mongo; reenvio com a chave entrega
  gasFora = true;
  r = await post('/api/es/finalizar', { code: 'CODE-2', modo: 'coex', waba_id: 'W3', event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' });
  const pend = await app.locals.db.collection('onboarding_pendente').countDocuments({});
  console.log('5) Apps Script fora → ok para o cliente:', r.j.ok, '| guardados:', pend);
  assert.equal(pend, 1);
  gasFora = false;
  assert.equal((await post('/api/es/reenviar-pendentes', {}, { 'x-api-key': 'errada' })).code, 401);
  r = await post('/api/es/reenviar-pendentes', {}, { 'x-api-key': process.env.API_SECRET });
  console.log('   reenvio:', JSON.stringify(r.j)); assert.equal(r.j.reenviados, 1);
  assert.equal(recebidos[recebidos.length - 1].waba_id, 'W3');

  // 6) code inválido → 500 sem vazar detalhe; sem code → 400; excesso → 429
  r = await post('/api/es/finalizar', { code: 'CODE-RUIM' }); assert.equal(r.code, 500); assert.ok(!JSON.stringify(r.j).includes('segredo'));
  assert.equal((await post('/api/es/finalizar', {})).code, 400);
  let ultimo = 0; for (let i = 0; i < 6; i++) ultimo = (await post('/api/es/finalizar', {})).code;
  console.log('6) erros: code inválido=500, sem code=400, excesso de tentativas=' + ultimo); assert.equal(ultimo, 429);

  console.log('\n✅ TODOS OS TESTES DO EMBEDDED SIGNUP v4 PASSARAM');
  srv.close(); gasSrv.close(); process.exit(0);
})().catch(e => { console.error('❌ FALHOU:', e); process.exit(1); });
