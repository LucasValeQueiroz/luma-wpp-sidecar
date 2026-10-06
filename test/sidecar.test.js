// Teste de ponta a ponta do sidecar SEM WhatsApp e SEM MongoDB de verdade:
// o Baileys e o driver do Mongo são trocados por dublês em memória.
// Rode com:  npm test
process.env.API_SECRET = 'x'.repeat(32);
process.env.MONGO_URI = 'mongodb://fake';
process.env.PORT = '3999';
process.env.ENVIO_INTERVALO_MIN_SEG = '0.2';
process.env.ENVIO_INTERVALO_MAX_SEG = '0.3';
process.env.ENVIO_DIGITANDO_SEG = '0';
const Module = require('module');
const EventEmitter = require('events');
const real = require('@whiskeysockets/baileys');
const fakeMongo = require('./fakemongo');
const enviados = [];
let sockAtual;
function makeWASocket(opts) {
  const ev = new EventEmitter();
  const s = {
    ev, opts,
    signalRepository: { lidMapping: { getPNForLID: async (lid) => lid === '999@lid' ? '5537988887777:3@s.whatsapp.net' : null } },
    updateMediaMessage: async () => {},
    sendPresenceUpdate: async () => {},
    groupMetadata: async (jid) => { if (jid === 'sumiu@g.us') throw new Error('item-not-found'); return { id: jid, subject: 'Grupo ' + jid, participants: [{ id: '5511911112222@s.whatsapp.net' }, { id: '999@lid' }, { id: '888@lid', phoneNumber: '5521977776666@s.whatsapp.net' }, { id: '777@lid' }] }; },
    groupFetchAllParticipating: async () => ({ 'a@g.us': { id: 'a@g.us', subject: 'Clientes VIP', participants: [1,2] } }),
    groupCreate: async (n, p) => ({ id: 'novo@g.us' }),
    groupParticipantsUpdate: async (g, p) => p.map((j, i) => ({ jid: j, status: i === 0 ? '200' : '403' })),
    groupInviteCode: async () => 'ABC123',
    sendMessage: async (jid, content) => { const id = 'MSG' + (enviados.length + 1); enviados.push({ jid, content, t: Date.now(), id }); return { key: { id, remoteJid: jid, fromMe: true }, message: { conversation: content.text || content.caption || '' } }; },
    logout: async () => {},
    end: () => { ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } }); }
  };
  sockAtual = s;
  setTimeout(() => ev.emit('connection.update', { connection: 'open' }), 50);
  return s;
}
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === '@whiskeysockets/baileys') return { ...real, default: makeWASocket, downloadMediaMessage: async () => Buffer.from('IMG') };
  if (req === 'mongodb') return fakeMongo;
  return origLoad.apply(this, arguments);
};
const assert = require('assert');
const express = require('express');
const srv = require('../server.js');
const H = { 'Content-Type': 'application/json', 'x-api-key': process.env.API_SECRET };
const B = 'http://127.0.0.1:3999';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const post = (p, b, h = H) => fetch(B + p, { method: 'POST', headers: h, body: JSON.stringify(b) }).then(async r => ({ code: r.status, j: await r.json() }));
const get = (p, h = H) => fetch(B + p, { headers: h }).then(async r => ({ code: r.status, j: await r.json() }));
async function esperar(cond, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { if (await cond()) return true; await sleep(100); } return false; }

(async () => {
  // webhook fake do Apps Script
  const gas = express(); gas.use(express.json({ limit: '20mb' }));
  const recebidos = []; let gasFora = false;
  gas.post('/exec', (req, res) => { if (gasFora) return res.status(500).send('fora'); recebidos.push(req.body); res.json({ status: 'success', entradaId: 'ENT-1' }); });
  const gasSrv = gas.listen(3998);

  await srv._interno.startServer();
  await esperar(async () => srv._interno.estado().isConnected);
  console.log('conectado:', srv._interno.estado().isConnected);

  // 1) auth
  assert.equal((await get('/api/health', {})).code, 401);
  assert.equal((await fetch(B + '/ping').then(r => r.status)), 200);

  // 2) validação: só grupos
  let r = await post('/api/fila-envio', { itens: [{ groupId: '5537999999999@s.whatsapp.net', tipo: 'texto', texto: 'oi' }] });
  assert.equal(r.j.status, 'error'); console.log('1-a-1 recusado:', r.j.message);

  // 3) enfileira 3 itens com idempotência + ordem por prioridade
  r = await post('/api/fila-envio', { origem: 'teste', itens: [
    { groupId: 'a@g.us', tipo: 'texto', texto: 'primeiro', idempotencyKey: 'k1' },
    { groupId: 'a@g.us', tipo: 'imagem', texto: 'legenda img', imagemBase64: Buffer.from('xx').toString('base64'), idempotencyKey: 'k2', linkResposta: 'https://wa.me/5537000?text=x', ref: 'PROD-1' },
    { groupId: 'a@g.us', tipo: 'texto', texto: 'urgente', prioridade: 9 }
  ] });
  assert.equal(r.j.enfileirados, 3);
  r = await post('/api/fila-envio', { itens: [{ groupId: 'a@g.us', tipo: 'texto', texto: 'primeiro', idempotencyKey: 'k1' }] });
  assert.equal(r.j.duplicados, 1);
  await esperar(async () => enviados.length >= 3);
  console.log('ordem:', enviados.map(e => e.content.text || e.content.caption));
  assert.equal(enviados[0].content.text, 'urgente');
  assert.ok(Buffer.isBuffer(enviados[2].content.image));
  const gaps = enviados.slice(1).map((e, i) => e.t - enviados[i].t);
  console.log('intervalos(ms):', gaps); assert.ok(gaps.every(g => g >= 150));

  // getMessage guardou o que saiu
  const gm = await sockAtual.opts.getMessage({ id: enviados[0].id });
  assert.ok(gm, 'getMessage deveria devolver a mensagem');

  // 4) rota antiga espera o resultado
  r = await post('/api/enviar-grupo', { groupId: 'a@g.us', message: 'catalogo' });
  console.log('legacy:', r.j); assert.equal(r.j.status, 'success'); assert.ok(!r.j.enfileirado);

  // 5) grupo inacessível vira erro definitivo e a rota antiga devolve erro
  r = await post('/api/enviar-grupo', { groupId: 'sumiu@g.us', message: 'x' });
  console.log('grupo sumido:', r.j.status, r.j.message);
  assert.equal(r.j.status, 'error');

  // 6) janela fora do horário: item normal fica, ignorarJanela sai
  const h = srv._interno.horaLocal(); const [hh, mm] = h.split(':').map(Number);
  const mais = (m) => { const t = (hh * 60 + mm + m + 1440) % 1440; return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); };
  r = await post('/api/config-envio', { janelaInicio: mais(60), janelaFim: mais(120), intervaloMinSeg: 5, intervaloMaxSeg: 5 });
  assert.equal(r.j.config.intervaloMinSeg, 5);
  // volta intervalos curtos direto no estado (mínimo do painel é 5s)
  Object.assign(srv._interno.estado().cfgEnvio, { intervaloMinSeg: 0.2, intervaloMaxSeg: 0.3 });
  const antes = enviados.length;
  await post('/api/fila-envio', { itens: [{ groupId: 'b@g.us', tipo: 'texto', texto: 'fora da janela' }, { groupId: 'b@g.us', tipo: 'texto', texto: 'manual', ignorarJanela: true }] });
  await sleep(6500);
  const novos = enviados.slice(antes).map(e => e.content.text);
  console.log('fora da janela enviou:', novos);
  assert.deepEqual(novos, ['manual']);
  r = await get('/api/fila-envio');
  console.log('resumo:', r.j.resumo.bloqueio, 'pendentes', r.j.resumo.pendentes);
  assert.equal(r.j.resumo.bloqueio, 'janela');

  // 7) cancelar pendentes
  r = await post('/api/fila-envio/cancelar', { groupId: 'b@g.us' });
  assert.equal(r.j.cancelados, 1);
  await post('/api/config-envio', { janelaInicio: '00:00', janelaFim: '00:00', maxPorGrupoDia: 1 });
  Object.assign(srv._interno.estado().cfgEnvio, { intervaloMinSeg: 0.2, intervaloMaxSeg: 0.3 });

  // 8) limite por grupo: c@g.us só 1 por dia
  const a2 = enviados.length;
  await post('/api/fila-envio', { itens: [{ groupId: 'c@g.us', tipo: 'texto', texto: 'c1' }, { groupId: 'c@g.us', tipo: 'texto', texto: 'c2' }] });
  await sleep(2500);
  console.log('limite por grupo:', enviados.slice(a2).map(e => e.content.text));
  assert.deepEqual(enviados.slice(a2).map(e => e.content.text), ['c1']);
  await post('/api/config-envio', { maxPorGrupoDia: 50 });
  Object.assign(srv._interno.estado().cfgEnvio, { intervaloMinSeg: 0.2, intervaloMaxSeg: 0.3 });
  await esperar(async () => enviados.some(e => e.content.text === 'c2'), 4000);

  // 9) config de escuta: recusa /dev, aceita /exec com grupos de resposta
  r = await post('/api/config-entrada', { webhookUrl: 'https://script.google.com/macros/s/X/dev', secret: 's', grupos: [] });
  assert.equal(r.j.status, 'error');
  r = await post('/api/config-entrada', { webhookUrl: 'http://127.0.0.1:3998/exec', secret: 'seg', grupos: [{ groupId: 'forn@g.us', nome: 'Fábrica' }], gruposResposta: [{ groupId: 'a@g.us', nome: 'Clientes', modo: 'citacao_e_palavras', link: 'https://wa.me/5537000?text=GERAL' }] });
  console.log('config-entrada:', r.j.message);

  // 10) cliente responde citando o post com imagem (MSG3 = 'legenda img')
  const postImg = enviados.find(e => e.content.caption === 'legenda img');
  const a3 = enviados.length;
  sockAtual.ev.emit('messages.upsert', { type: 'notify', messages: [
    { key: { remoteJid: 'a@g.us', id: 'C1', participant: '999@lid', fromMe: false }, message: { extendedTextMessage: { text: 'eu quero', contextInfo: { stanzaId: postImg.id } } } },
    { key: { remoteJid: 'a@g.us', id: 'C2', participant: '999@lid', fromMe: false }, message: { extendedTextMessage: { text: 'eu quero', contextInfo: { stanzaId: postImg.id } } } },
    { key: { remoteJid: 'a@g.us', id: 'C3', participant: '111@lid', fromMe: false }, message: { conversation: 'qual o valor?' } },
    { key: { remoteJid: 'a@g.us', id: 'C4', participant: '222@lid', fromMe: false }, message: { conversation: 'bom dia pessoal' } }
  ] });
  await esperar(async () => enviados.length >= a3 + 2, 10000); await sleep(4000);
  const respostas = enviados.slice(a3);
  console.log('respostas no grupo:', respostas.map(e => [e.content.text, e.content.mentions]));
  assert.equal(respostas.length, 2);
  assert.ok(respostas.some(e => e.content.text.includes('PROD') || e.content.text.includes('text=x')));
  assert.ok(respostas.some(e => e.content.text.includes('GERAL')));

  // 11) fornecedor posta foto → webhook recebe com telefone resolvido do LID
  sockAtual.ev.emit('messages.upsert', { type: 'notify', messages: [
    { key: { remoteJid: 'forn@g.us', id: 'F1', participant: '999@lid', fromMe: false }, message: { imageMessage: { caption: 'Produto: X\nPreço: 10', mimetype: 'image/jpeg' } } },
    { key: { remoteJid: 'zzz@g.us', id: 'F2', participant: '1@s.whatsapp.net', fromMe: false }, message: { conversation: 'ignorado' } }
  ] });
  await esperar(async () => recebidos.length >= 1);
  console.log('webhook recebeu:', recebidos.map(x => [x.tipo, x.groupNome, x.remetente, x.legenda.slice(0, 12), !!x.imagemBase64]));
  assert.equal(recebidos[0].remetente, '5537988887777');

  // 12) GAS fora do ar → vai para a fila de entrada
  gasFora = true;
  sockAtual.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: 'forn@g.us', id: 'F3', participant: '5537911@s.whatsapp.net' }, message: { conversation: 'Produto: Y\nPreço: 20' } }] });
  await sleep(800);
  r = await get('/api/config-entrada');
  console.log('pendentes na fila de entrada:', r.j.pendentesNaFila); assert.equal(r.j.pendentesNaFila, 1);
  gasFora = false;
  r = await post('/api/reprocessar-fila', {});
  console.log('após reprocessar:', r.j.pendentesNaFila); assert.equal(r.j.pendentesNaFila, 0);

  // 13) participantes com LID
  r = await get('/api/grupo-participantes?groupId=a@g.us');
  console.log('participantes:', r.j.participantes.map(p => p.number), 'naoResolvidos', r.j.naoResolvidos);
  assert.equal(r.j.participantes.length, 3); assert.equal(r.j.naoResolvidos, 1);

  // 14) convite + adicionar membros com 403
  r = await get('/api/grupo-convite?groupId=a@g.us'); assert.equal(r.j.link, 'https://chat.whatsapp.com/ABC123');
  r = await post('/api/adicionar-membros-grupo', { groupId: 'a@g.us', clientesPhones: ['5511999990000', '5511888880000'] });
  console.log('bloqueados por privacidade:', r.j.bloqueadosPorPrivacidade);
  r = await get('/api/listar-grupos?busca=vip'); assert.equal(r.j.grupos.length, 1);
  r = await get('/api/health'); console.log('health:', JSON.stringify(r.j).slice(0, 300));

  console.log('\n✅ TODOS OS TESTES DO SIDECAR PASSARAM');
  gasSrv.close(); process.exit(0);
})().catch(e => { console.error('❌ FALHOU:', e); process.exit(1); });
