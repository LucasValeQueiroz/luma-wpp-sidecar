const express = require('express');
const { default: makeWASocket } = require('@whiskeysockets/baileys');
const { MongoClient } = require('mongodb');
const qrcode = require('qrcode');
const pino = require('pino');

const app = express();
app.use(express.json());

// Pega a URL do Banco de Dados pelas variáveis de ambiente do Render
const MONGO_URI = process.env.MONGO_URI; 
const DBNAME = 'whatsapp_auth';
const COLLECTION = 'auth_info';

let sock;
let qrCodeBase64 = '';
let isConnected = false;

// ---------------------------------------------------------
// ADAPTADOR: Ensina o Baileys a guardar os dados no MongoDB
// ---------------------------------------------------------
async function useMongoDBAuthState(collection) {
    const writeData = (data, id) => collection.replaceOne({ _id: id }, { _id: id, data: JSON.stringify(data, (k, v) => typeof v === 'bigint' ? v.toString() : v) }, { upsert: true });
    const readData = async (id) => {
        const doc = await collection.findOne({ _id: id });
        return doc ? JSON.parse(doc.data, (k, v) => (typeof v === 'string' && /^\d+n$/.test(v)) ? BigInt(v.slice(0, -1)) : v) : null;
    };
    const removeData = async (id) => collection.deleteOne({ _id: id });

    const creds = await readData('creds') || {
        noiseKey: { public: new Uint8Array(32), private: new Uint8Array(32) },
        signedIdentityKey: { public: new Uint8Array(32), private: new Uint8Array(32) },
        signedPreKey: { keyPair: { public: new Uint8Array(32), private: new Uint8Array(32) }, signature: new Uint8Array(64), keyId: 1 },
        registrationId: 0, advSecretKey: "", nextPreKeyId: 1, firstUnuploadedPreKeyId: 1, accountSettings: { unarchiveChats: false },
        deviceId: "", phoneId: "", identityId: new Uint8Array(20), backupToken: new Uint8Array(20), registered: false
    };

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async id => {
                        let value = await readData(`${type}-${id}`);
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

// ---------------------------------------------------------
// MOTOR PRINCIPAL DO WHATSAPP
// ---------------------------------------------------------
async function startWhatsApp() {
    if (!MONGO_URI) {
        console.error("❌ ERRO CRÍTICO: A variável MONGO_URI não foi configurada!");
        return;
    }

    const mongoClient = new MongoClient(MONGO_URI);
    await mongoClient.connect();
    const db = mongoClient.db(DBNAME);
    const collection = db.collection(COLLECTION);
    console.log('📦 Conectado ao MongoDB com sucesso!');

    const { state, saveCreds } = await useMongoDBAuthState(collection);

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }), // Deixa o terminal limpo
        syncFullHistory: false
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrCodeBase64 = await qrcode.toDataURL(qr);
            console.log('Novo QR Code gerado, pronto para leitura via API.');
        }

        if (connection === 'close') {
            isConnected = false;
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== 401;
            console.log('Conexão fechada. Reconectando:', shouldReconnect);
            if (shouldReconnect) {
                startWhatsApp();
            } else {
                console.log('🔴 Sessão encerrada manualmente. Limpando o banco de dados...');
                await collection.deleteMany({}); // Apaga os dados se deslogar pelo telemóvel
            }
        } else if (connection === 'open') {
            isConnected = true;
            qrCodeBase64 = ''; // Limpa o QR
            console.log('✅ WhatsApp Autenticado e Pronto para Operar!');
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// ---------------------------------------------------------
// ROTAS DO EXPRESS (API PARA O GOOGLE APPS SCRIPT)
// ---------------------------------------------------------

// Rota 1: Mostrar o QR Code no seu Painel de Admin
app.get('/api/qr', (req, res) => {
    if (isConnected) return res.json({ status: 'connected', message: 'WhatsApp já está conectado.' });
    if (qrCodeBase64) return res.json({ status: 'pending', qr: qrCodeBase64 });
    res.json({ status: 'starting', message: 'Aguarde, gerando QR Code ou conectando ao banco de dados...' });
});

// Rota 2: Criar Grupo
app.post('/api/adicionar-grupo', async (req, res) => {
    const { nomeGrupo, clientesPhones } = req.body; 
    try {
        if (!isConnected) throw new Error("WhatsApp não está conectado no servidor.");
        const participants = clientesPhones.map(num => `${num.replace(/\D/g, '')}@s.whatsapp.net`);
        const group = await sock.groupCreate(nomeGrupo, participants);
        res.json({ status: 'success', groupId: group.id, message: `Grupo "${nomeGrupo}" criado com sucesso!` });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.toString() });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor Express rodando na porta ${PORT}`);
    startWhatsApp();
});