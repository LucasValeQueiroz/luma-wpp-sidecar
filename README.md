# 🚀 Luma WPP Sidecar - Gestor Dinâmico de Grupos

## 📌 O que é este projeto?

O **Luma WPP Sidecar** é um microserviço construído em Node.js para atuar como uma extensão do nosso CRM/Atendimento 

A API Oficial da Meta (WhatsApp Cloud API) é fantástica para estabilidade e atendimento 1 a 1, mas possui uma "disfunção" grave para o marketing digital: **ela não suporta a criação, gestão e adição de participantes a grupos de WhatsApp de forma dinâmica.**

Para resolver este "Calcanhar de Aquiles", este projeto utiliza a biblioteca `@whiskeysockets/baileys` para criar uma conexão paralela (extraoficial). Ele funciona como um braço operacional isolado: o número oficial foca no atendimento seguro pela Meta, enquanto este serviço foca exclusivamente em capturar clientes e organizá-los em grupos (ex: lançamentos, masterclasses, alunos vip).

---

## 🏗️ Arquitetura do Sistema (Sidecar Pattern)

A arquitetura foi desenhada para resolver dois grandes problemas de infraestrutura: **isolamento de responsabilidades** e **persistência de sessão em ambientes efêmeros (Cloud/Serverless)**.

### 1. Motor de Mensageria (Baileys)
Utilizamos o `@whiskeysockets/baileys` para simular uma conexão via WhatsApp Web. 
* **Otimização:** A propriedade `syncFullHistory` está desativada (`false`), o que significa que o robô não faz o download de mensagens antigas, poupando memória RAM e evitando sobrecarga no servidor.
* **Segurança:** O robô não escuta as mensagens recebidas (`messages.upsert`), garantindo que não haverá conflito com os atendentes humanos ou com a IA do sistema principal. Ele é reativo apenas às ordens do servidor.

### 2. Persistência Descentralizada (MongoDB Atlas)
A maior falha ao hospedar instâncias do Baileys em serviços modernos em nuvem (como Render, Vercel ou GitHub Actions) é que estas plataformas limpam o disco quando entram em "sleep" ou reiniciam, forçando a leitura diária do QR Code.
* **A Solução:** Criámos um Adaptador de Estado Customizado. Em vez de salvar a pasta `auth_info_groups` no disco local, todas as chaves criptográficas da sessão do WhatsApp são gravadas e atualizadas em tempo real num banco de dados **MongoDB (NoSQL)**. 

### 3. API REST (Express.js)
O serviço utiliza o `express` para abrir uma ponte de comunicação com o Cérebro do sistema, expondo apenas duas rotas fechadas.

---

## ⚙️ Variáveis de Ambiente (.env)

Para rodar este projeto localmente ou na nuvem (Render/Heroku), você precisará configurar apenas uma variável de ambiente:

| Chave | Descrição |
| :--- | :--- |
| `MONGO_URI` | A Connection String do seu banco de dados MongoDB Atlas (Onde a sessão será salva). |

---

## 📡 Endpoints da API

O servidor expõe as seguintes rotas para consumo:

### 1. Buscar Status / QR Code
* **Rota:** `GET /api/qr`
* **Retorno:** Retorna o status da conexão (`connected`, `starting` ou `pending`). Se estiver pendente, devolve a imagem do QR Code em `Base64` para ser desenhada diretamente no painel de administração (Frontend).

### 2. Criar e Adicionar a Grupo
* **Rota:** `POST /api/adicionar-grupo`
* **Payload Esperado:**
  ```json
  {
      "nomeGrupo": "Nome do seu Grupo Vip",
      "clientesPhones": ["5531999999999", "5537977777777"]
  }