# 🚀 Luma WPP Sidecar v3 — Grupos, Entrada de Estoque e Fila Anti-Ban

Microserviço Node.js que estende o CRM Luma (Google Apps Script). A API Oficial da Meta
é ótima para atendimento 1‑a‑1 e cobrança, mas **não cria grupos, não publica em grupos e
não lê grupos**. Este serviço cobre exatamente esse buraco usando
[`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys) num número auxiliar —
enquanto o **número oficial continua responsável pelo atendimento e pelo dinheiro**.

> ⚠️ **Não use o seu número pessoal.** A conexão é extraoficial: a Meta pode banir o
> número que cria grupos e dispara ofertas em volume. Use um chip dedicado (eSIM pré‑pago
> resolve), ative a verificação em duas etapas e mantenha a recarga em dia.

---

## 🔄 O ciclo completo

```
   FORNECEDOR                 SIDECAR (este serviço)              APPS SCRIPT
┌──────────────┐  grupo de  ┌───────────────────────┐ webhook ┌──────────────────┐
│ foto + preço ├───────────►│ escuta SÓ a allowlist ├────────►│ lê layout / IA,  │
└──────────────┘  entrada   │ baixa a imagem        │  POST   │ calcula preço,   │
                            └───────────────────────┘         │ fila de aprovação│
                                                              └────────┬─────────┘
                                                                       │ aprovado
   CLIENTE NO GRUPO          FILA ANTI-BAN (envio_fila)                ▼
┌──────────────────┐       ┌───────────────────────┐        ┌──────────────────┐
│ vê o post com    │◄──────┤ cadência humana,      │◄───────┤ vitrine / resumo │
│ foto + "Quero    │ grupo │ "digitando...", tetos │ /api/  │ com link por     │
│ este" (wa.me)    │       │ e janela de horário   │ fila-  │ produto          │
└───┬──────────┬───┘       └───────────────────────┘ envio  └──────────────────┘
    │ toca no   │ responde "quero" citando o post
    │ link      ▼
    │   ┌───────────────────────────────┐
    │   │ sidecar responde no grupo com │
    │   │ @menção + link do oficial     │
    │   └───────────────┬───────────────┘
    ▼                   ▼
┌───────────────────────────────────────────────────────────────┐
│ NÚMERO OFICIAL (Cloud API)  "Quero: Tênis 🛒 [#vd-a1b2c3:PROD-1]" │
│ doPost reconhece grupo + produto → fotos, variações, frete ou    │
│ link de pagamento → IA do grupo assume → pagamento ✅            │
└───────────────────────────────────────────────────────────────┘
```

O número auxiliar **só fala em grupo**. Conversa privada é sempre do oficial — é isso que
mantém o auxiliar longe do banimento. A rota de envio recusa qualquer destino que não seja
`@g.us`.

---

## 🆕 O que mudou na v3

| Novidade | Para quê |
| --- | --- |
| **Fila de envio anti-ban** (`envio_fila`) | Tudo que vai para grupo entra numa fila persistente no Mongo e sai com intervalo aleatório (25–60s), "digitando..." antes, teto por hora / 24h / grupo e **janela de horário** (08:00–21:30 por padrão). Reinício do Render não perde nada; `idempotencyKey` impede post duplicado. |
| **Resposta no grupo** | Quem responde **citando um post nosso** recebe, no próprio grupo, uma menção com o link do número oficial daquele produto. Opcional por grupo (ou também por palavras como "quero", "valor", "preço"), com anti-spam por pessoa. |
| **LID resolvido** | Baileys v7 mostra participantes como `@lid`. Agora o telefone vem de `phoneNumber`, `participantAlt` ou do mapeamento LID→PN — menos "ocultos" na importação e remetente correto na entrada. |
| **Conexão mais estável** | Socket antigo é fechado antes de abrir outro; backoff progressivo; espera de 60s no erro 440 (deploy com duas instâncias); `getMessage` para reenvio; cache de metadados dos grupos; desligamento gracioso no SIGTERM. |
| **Fila de entrada que desiste** | Entrega ao Apps Script que falhou 5 vezes vira `falhou` (some em 14 dias) em vez de ficar "pendente" para sempre. Resposta HTML do Google (URL `/dev`, implantação errada) agora conta como falha. |
| **Embedded Signup montado** | `embedded-signup.js` agora está no repositório e é montado **antes** do guard da API (o navegador do cliente chama `/api/es/finalizar` sem chave). |
| **Embedded Signup v4** | Sem `sessionInfoVersion`, Coexistence por `featureType`, opção "número novo", `subscribed_apps` + sincronização de contatos/histórico automáticos, Graph v25 e reenvio se o Apps Script estiver fora. |
| **Teste automatizado** | `npm test` sobe o servidor com dublês do WhatsApp, do Mongo e da Graph API e testa fila, janela, tetos, idempotência, resposta no grupo, entrada, LID e o onboarding v4. |

---

## 🔐 Segurança

- **`API_SECRET` é obrigatório** (mín. 20 caracteres). Sem ele todas as rotas `/api`
  respondem **503** *e o WhatsApp não conecta* — nunca existe janela com a sessão de pé e
  desprotegida.
- Comparação da chave em **tempo constante** (`crypto.timingSafeEqual`).
- O QR **nunca** vai para os logs do Render.
- Rotas públicas: só `/ping`, `/conectar` e `/api/es/finalizar` (Embedded Signup).

---

## ⚙️ Variáveis de ambiente

| Chave | Obrigatória | Descrição |
| --- | :---: | --- |
| `MONGO_URI` | ✅ | Connection string do MongoDB Atlas (sessão + filas). |
| `API_SECRET` | ✅ | Mín. 20 caracteres. **O mesmo valor** vai no Apps Script em `SIDECAR_API_KEY`. |
| `ENVIO_INTERVALO_MIN_SEG` / `ENVIO_INTERVALO_MAX_SEG` | — | Intervalo aleatório entre posts (padrão 25 / 60). |
| `ENVIO_MAX_POR_HORA` / `ENVIO_MAX_POR_DIA` / `ENVIO_MAX_POR_GRUPO_DIA` | — | Tetos (padrão 40 / 250 / 15), em janela móvel. |
| `ENVIO_JANELA_INICIO` / `ENVIO_JANELA_FIM` | — | Horário em que o auxiliar pode postar (padrão 08:00–21:30). |
| `ENVIO_DIGITANDO_SEG` | — | Segundos de "digitando..." antes de cada post (padrão 3). |
| `TZ_ENVIO` | — | Fuso da janela (padrão `America/Sao_Paulo`). |
| `META_APP_ID`, `META_APP_SECRET` | — | Só para o Embedded Signup (`/conectar`). |
| `META_CONFIG_ID` | — | ID da configuração **v4** de *Login do Facebook para Empresas* (variação WhatsApp Embedded Signup). |
| `META_CONFIG_ID_COEX` | — | Opcional: config separada só para Coexistence. |
| `META_ES_EXTRAS_COEX` / `META_ES_EXTRAS` | — | Opcional: o `extras` exato gerado pelo Embedded Signup Builder (JSON). Padrão Coexistence: `{"setup":{},"featureType":"whatsapp_business_app_onboarding"}`; número novo: `{}`. |
| `META_REGISTER_PIN` | — | Opcional: PIN de 6 dígitos para registrar números novos automaticamente. |
| `APPS_SCRIPT_URL` / `APPS_SCRIPT_SECRET` | — | Opcionais: vazio = a URL `/exec` sincronizada pelo CRM e a própria `API_SECRET`. |
| `GRAPH_VERSION` | — | Padrão `v25.0`. |

Os limites da fila também são ajustados pelo painel do CRM (**Gestão de Grupos → Saída →
🛡️ Fila de envio**). O que o painel salva fica no Mongo e vale mais que o `.env`.

**Node 22** (`engines: 22.x`). O Baileys 7 é ESM e o `require()` dele precisa de Node ≥ 20.19/22.12.

---

## 📡 Endpoints

Todas as rotas `/api/*` (exceto `/api/es/finalizar`) exigem `x-api-key: <API_SECRET>`.

### Públicas

| Método | Rota | Para quê |
| --- | --- | --- |
| `GET` | `/ping` | Monitor de uptime (aponte um pinger a cada 10 min — o Render grátis hiberna em ~15). |
| `GET` | `/conectar` | Página do Embedded Signup (Coexistence). |
| `POST` | `/api/es/finalizar` | Embedded Signup v4: troca o `code` pelo token **no servidor**, descobre WABA/número, assina o app na WABA (`subscribed_apps`), pede a sincronização de contatos e histórico (Coexistence) e avisa o Apps Script. |
| `POST` | `/api/es/reenviar-pendentes` | *(com `x-api-key`)* Reenvia ao Apps Script os onboardings guardados enquanto ele estava fora. |

### Conexão

| Método | Rota | Para quê |
| --- | --- | --- |
| `GET` | `/api/qr` | `connected` / `pending` (com QR base64) / `starting` (com diagnóstico). |
| `GET` | `/api/health` | Diagnóstico geral + resumo da fila de envio. |
| `POST` | `/api/resetar-sessao` | Apaga a sessão e força QR novo. |

### Grupos

| Método | Rota | Payload / Query |
| --- | --- | --- |
| `GET` | `/api/listar-grupos` | `?busca=` (mín. 3 letras, máx. 20 resultados, cache de 60s) |
| `GET` | `/api/grupo-participantes` | `?groupId=` — números (LID resolvido) e quantos seguem ocultos |
| `GET` | `/api/grupo-convite` | `?groupId=` — link `chat.whatsapp.com` (o auxiliar precisa ser admin) |
| `POST` | `/api/adicionar-grupo` | `{ nomeGrupo, clientesPhones: [] }` |
| `POST` | `/api/adicionar-membros-grupo` | `{ groupId, clientesPhones: [] }` → inclui `bloqueadosPorPrivacidade` |

### Fila de envio (anti-ban)

| Método | Rota | Payload / Query |
| --- | --- | --- |
| `POST` | `/api/fila-envio` | `{ origem, itens: [{ groupId, tipo: 'texto'\|'imagem', texto, imagemBase64?, imagemUrl?, mimeType?, ref?, linkResposta?, prioridade?, ignorarJanela?, idempotencyKey?, agendarPara? }] }` — até 50 itens; responde na hora com o resumo da fila. |
| `GET` | `/api/fila-envio` | `?status=&groupId=&limite=` — últimos itens + resumo + config. |
| `POST` | `/api/fila-envio/cancelar` | `{ ids? \| groupId? \| origem? \| todos: true }` — cancela pendentes. |
| `GET` / `POST` | `/api/config-envio` | Lê / salva intervalos, tetos, janela e `pausado`. |
| `POST` | `/api/enviar-grupo` | *(compatibilidade)* `{ groupId, message }` — passa pela fila e espera até ~40s. |
| `POST` | `/api/enviar-grupo-midia` | *(compatibilidade)* `{ groupId, imagemBase64\|imagemUrl, mimeType, caption }` |

`linkResposta` é o link do número oficial daquele post: é ele que o sidecar usa quando
alguém responde citando o post no grupo.

### Escuta (entrada de fornecedores + resposta em grupos de clientes)

| Método | Rota | Para quê |
| --- | --- | --- |
| `POST` | `/api/config-entrada` | `{ webhookUrl, secret, grupos: [{groupId, nome}], gruposResposta: [{groupId, nome, modo, link}] }` — recusa URL `/dev`. |
| `GET` | `/api/config-entrada` | Quantos grupos escuta, pendentes e desistências da fila de entrada. |
| `POST` | `/api/reprocessar-fila` | Reenvia o que estiver preso (inclusive os que tinham desistido). |

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

1. `Build Command`: `npm install` · `Start Command`: `npm start`
2. **Environment**: `MONGO_URI` e `API_SECRET` (e, se quiser, os `ENVIO_*`).
3. Deploy. Confira `https://SEU-APP.onrender.com/ping` → `{"ok":true}`.
4. No Apps Script: publique o `Grupos.gs` e uma **nova versão** do Web App; defina
   `WEBAPP_URL` (a URL `/exec`) nas Propriedades do Script.
5. No painel do CRM: **Gestão de Grupos → Entrada → 🔄 Sincronizar escuta**.

## 🧪 Teste local

```bash
npm install
npm test
```

Não precisa de WhatsApp nem de MongoDB: o teste troca os dois por dublês em memória.

---

## 🩺 Diagnóstico rápido

| Sintoma | Causa provável |
| --- | --- |
| Rotas respondendo **503** | `API_SECRET` ausente ou com menos de 20 caracteres. |
| Rotas respondendo **401** | `API_SECRET` (Render) ≠ `SIDECAR_API_KEY` (Apps Script). |
| Posts "na fila" mas nada sai | Veja o painel 🛡️: fora da janela, fila pausada, teto atingido ou aparelho desconectado. |
| Post saiu só com texto | A imagem não pôde ser baixada (arquivo do Drive não público e sem base64). |
| Erro `Grupo inacessível` | O número auxiliar saiu ou foi removido do grupo. |
| Quedas 440 em sequência | Duas instâncias com a mesma sessão (deploy sobreposto ou outro serviço usando o mesmo Mongo). |
| Fornecedor postou e nada chegou | Grupo pausado, fora da allowlist, URL `/dev` no Apps Script, ou layout exige foto e veio sem. |
| Itens em `entrada_fila` | Web App fora do ar. O worker reenvia sozinho a cada minuto (até 5 vezes). |
| Serviço demora 30–60s a cada acesso | Hibernação do Render. Configure o pinger em `/ping`. |

---

## 📄 Licença

ISC
