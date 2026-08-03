# 🚀 Luma WPP Sidecar v2 — Gestor de Grupos e Entrada de Estoque

Microserviço Node.js que estende o CRM Luma (Google Apps Script). A API Oficial da Meta
é excelente para atendimento 1‑a‑1 e cobrança, mas **não cria grupos, não adiciona
participantes e não lê grupos**. Este serviço cobre exatamente esse buraco, usando
[`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys) numa conexão
paralela — enquanto o número oficial continua responsável pelo atendimento e pelo dinheiro.

> ⚠️ **Não use o seu número pessoal.** A conexão é extraoficial: a Meta pode banir o
> número que cria grupos e dispara catálogo em volume. Use um chip dedicado
> (eSIM pré‑pago resolve) e ative a verificação em duas etapas nele.

---

## 🔄 O ciclo que este serviço sustenta

```
   FORNECEDOR                    ESTE SERVIÇO                  APPS SCRIPT
┌───────────────┐            ┌──────────────────┐          ┌────────────────┐
│ posta foto +  │  grupo de  │ escuta SÓ os     │ webhook  │ lê pelo layout │
│ legenda com   ├───────────►│ grupos da        ├─────────►│ (ou pela IA),  │
│ preço e qtd   │  entrada   │ allowlist e      │  POST    │ calcula preço  │
└───────────────┘            │ baixa a imagem   │          │ e enfileira    │
                             └──────────────────┘          └───────┬────────┘
                                                                   │ aprovação
                                                                   ▼
   CLIENTE                      ESTE SERVIÇO                 ┌────────────────┐
┌───────────────┐            ┌──────────────────┐            │ produto criado │
│ clica no      │  grupo de  │ publica foto +   │            │ no estoque +   │
│ link wa.me    │◄───────────┤ preço + botão    │◄───────────┤ link Mercado   │
│ [#vd-codigo]  │  clientes  │ /enviar-grupo-   │            │ Pago           │
└───────┬───────┘            │ midia            │            └────────────────┘
        │                    └──────────────────┘
        ▼
┌────────────────────────────────────────┐
│ NÚMERO OFICIAL (Meta Cloud API)        │
│ IA de vendas assume → pagamento ✅     │
└────────────────────────────────────────┘
```

---

## 🏗️ Arquitetura

### 1. Motor de mensageria (Baileys)

- `syncFullHistory: false` — não baixa histórico antigo, poupando RAM.
- **Escuta seletiva:** diferente da v1 (que não escutava nada), a v2 ouve
  `messages.upsert`, mas descarta tudo que **não** seja de um grupo presente na
  allowlist enviada pelo Apps Script — antes mesmo de baixar qualquer mídia.
  Nenhuma conversa pessoal ou de atendimento é lida.
- `printQRInTerminal: false` — o QR **nunca** vai para os logs do Render. Quem tivesse
  acesso a um print de log pareava o próprio aparelho na sua conta.

### 2. Persistência da sessão (MongoDB Atlas)

Plataformas como o Render limpam o disco ao hibernar ou reiniciar, o que forçaria a
leitura diária do QR Code. As chaves criptográficas da sessão são gravadas num
adaptador customizado direto no MongoDB (coleção `auth_info`).

> 🔑 Quem tem a `MONGO_URI` tem a sua sessão do WhatsApp. Use um usuário exclusivo,
> senha forte, e não reaproveite essa string em nenhum outro projeto.

### 3. Resiliência

| Mecanismo | O que resolve |
| --- | --- |
| **Reconexão em qualquer queda** | A v1 limpava a sessão no `loggedOut` e **parava** — nunca reconectava. O `/api/qr` respondia `starting` para sempre e só um restart manual resolvia. Agora reconecta nos dois casos: queda → restaura; logout → emite QR novo. |
| **Watchdog (30s)** | Se passar 2 minutos sem conexão e sem QR, força um socket novo. Um evento perdido não deixa mais o serviço mudo. |
| **`try/catch` na inicialização** | Se o `makeWASocket` estourar, nenhum listener existiria e o serviço morreria em silêncio. Agora reagenda em 15s. |
| **Fila de reenvio (`entrada_fila`)** | Se o Apps Script estiver fora do ar, a mensagem do fornecedor fica no Mongo e um worker tenta de novo a cada minuto (até 5 vezes). Nenhum produto se perde. |
| **Trava anti-duplicata** | IDs de mensagem já processados ficam em memória; o Apps Script também deduplica por `messageId`. |

---

## 🔐 Segurança

Este repositório é **público**. Qualquer pessoa lê quais rotas existem e o que cada uma
espera — e tudo bem: segurança que depende de "ninguém achar o código" não é segurança.
A proteção real é a chave.

- **`API_SECRET` é obrigatório** (mínimo 20 caracteres). Sem ele o serviço recusa 100%
  das rotas `/api` com **503** *e não conecta no WhatsApp*. Assim nunca existe uma janela
  em que a sessão está de pé e desprotegida — o cenário em que um estranho pediria
  `/api/qr`, escaneasse e passasse a agir como você.
- Comparação da chave em **tempo constante** (`crypto.timingSafeEqual`).
- Nenhum segredo no código: tudo vem de variáveis de ambiente.

---

## ⚙️ Variáveis de ambiente

| Chave | Obrigatória | Descrição |
| --- | :---: | --- |
| `MONGO_URI` | ✅ | Connection string do MongoDB Atlas (onde a sessão é salva). |
| `API_SECRET` | ✅ | Mínimo 20 caracteres. **O mesmo valor** vai no Apps Script em Propriedades do Script → `SIDECAR_API_KEY`. Gere com `openssl rand -hex 32`. |
| `PORT` | — | O Render define sozinho. |

**Node 18 ou superior** (o código usa `fetch` nativo).

---

## 📡 Endpoints

Todas as rotas `/api/*` exigem o header `x-api-key: <API_SECRET>`.

### Público (sem autenticação)

| Método | Rota | Para quê |
| --- | --- | --- |
| `GET` | `/ping` | Monitor de uptime. O Render grátis hiberna após ~15 min sem tráfego; aponte um pinger a cada 10 min para cá e ele nunca dorme. Devolve só `{ok, conectado}`. |

### Conexão

| Método | Rota | Para quê |
| --- | --- | --- |
| `GET` | `/api/qr` | Status (`connected` / `pending` / `starting`). Em `pending` devolve o QR em base64. Após 90s travado, informa há quanto tempo tenta e o último motivo de queda. |
| `GET` | `/api/health` | Diagnóstico geral. |
| `POST` | `/api/resetar-sessao` | Apaga a sessão e força QR novo. Use quando travar em "iniciando". |

### Grupos

| Método | Rota | Payload / Query |
| --- | --- | --- |
| `GET` | `/api/listar-grupos` | `?busca=` (mín. 3 letras, máx. 20 resultados) |
| `GET` | `/api/grupo-participantes` | `?groupId=` — devolve números e quantos estão ocultos por LID |
| `POST` | `/api/adicionar-grupo` | `{ nomeGrupo, clientesPhones: [] }` |
| `POST` | `/api/adicionar-membros-grupo` | `{ groupId, clientesPhones: [] }` |
| `POST` | `/api/enviar-grupo` | `{ groupId, message }` |
| `POST` | `/api/enviar-grupo-midia` | `{ groupId, imagemBase64, mimeType, caption }` |

### Entrada de fornecedores

| Método | Rota | Para quê |
| --- | --- | --- |
| `POST` | `/api/config-entrada` | `{ webhookUrl, secret, grupos: [{groupId, nome}] }` — define **o que escutar** e **para onde mandar**. Sem isto o serviço fica mudo. |
| `GET` | `/api/config-entrada` | Quantos grupos está escutando e quantos itens estão presos na fila. |
| `POST` | `/api/reprocessar-fila` | Força o reenvio do que estiver pendente. |

**Payload entregue ao Apps Script** quando um fornecedor posta:

```json
{
  "tipo": "entrada_grupo",
  "secret": "<ENTRADA_SECRET>",
  "groupId": "1203...@g.us",
  "groupNome": "Fábrica XYZ",
  "messageId": "3EB0...",
  "remetente": "5537999998888",
  "legenda": "Produto: Tênis Runner\nPreço: 120,00\nQtd: 15",
  "imagemBase64": "/9j/4AAQ...",
  "mimeType": "image/jpeg"
}
```

---

## 🚀 Deploy no Render

1. `Build Command`: `npm install`
2. `Start Command`: `npm start`
3. Em **Environment**, defina `MONGO_URI` e `API_SECRET`.
4. Deploy. Confira `https://SEU-APP.onrender.com/ping` — deve responder `{"ok":true}`.
5. No painel do CRM: **Gestão de Grupos → Entrada → 🔄 Sincronizar escuta**.

> Se os logs mostrarem `❌ BLOQUEADO`, o `API_SECRET` está ausente ou tem menos de
> 20 caracteres. O WhatsApp não conecta de propósito nessa situação.

---

## 🩺 Diagnóstico rápido

| Sintoma | Causa provável |
| --- | --- |
| `/api/qr` preso em `starting` para sempre | Versão antiga do `server.js` (bug do `loggedOut`). Atualize e reinicie. |
| Rotas respondendo **503** | `API_SECRET` ausente ou com menos de 20 caracteres. |
| Rotas respondendo **401** | `API_SECRET` (Render) ≠ `SIDECAR_API_KEY` (Apps Script). |
| "Escutando 0 grupos" | Faltou clicar em **Sincronizar escuta** no painel. |
| Fornecedor postou e nada chegou | Grupo pausado, ou fora da allowlist, ou o layout exige foto e a mensagem veio sem. |
| Itens acumulados em `entrada_fila` | Web App do Apps Script fora do ar. O worker reenvia sozinho. |
| Serviço demora 30–60s a cada acesso | Hibernação do Render. Configure o pinger em `/ping`. |

---

## 📄 Licença

ISC
