const express = require('express');
const { default: makeWASocket, DisconnectReason } = require('@whiskeysockets/baileys');
const { MongoClient } = require('mongodb');
const qrcode = require('qrcode');
const pino = require('pino');

const app = express();
app.use(express.json());

const MONGO_URI = process.env.MONGO_URI; 
const DBNAME = 'whatsapp_auth';
const COLLECTION = 'auth_info';

let sock;
let qrCodeBase64 = '';
let isConnected = false;
let mongoCollection; // Variável global para reaproveitar a coleção

// Adaptador do MongoDB
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

async function connectToWhatsApp() {
    console.log('🔄 Inicializando instância do WhatsApp...');
    const { state, saveCreds } = await useMongoDBAuthState(mongoCollection);

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
        syncFullHistory: false
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrCodeBase64 = await qrcode.toDataURL(qr);
            console.log('⚡ Novo QR Code pronto para o Google Apps Script.');
        }

        if (connection === 'close') {
            isConnected = false;
            qrCodeBase64 = '';
            const statusCode = lastDisconnect.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`🔴 Conexão fechada (Motivo: ${statusCode}). Reconectando: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                // Reconecta reutilizando a mesma conexão do banco
                setTimeout(connectToWhatsApp, 5000); 
            } else {
                console.log('🔴 Desconectado permanentemente. Limpando banco...');
                await mongoCollection.deleteMany({});
            }
        } else if (connection === 'open') {
            isConnected = true;
            qrCodeBase64 = '';
            console.log('✅ WhatsApp Autenticado e Pronto!');
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

async function startServer() {
    if (!MONGO_URI) {
        console.error("❌ ERRO: MONGO_URI não configurada!");
        return;
    }

    // Liga ao Mongo apenas UMA vez no início do servidor
    const mongoClient = new MongoClient(MONGO_URI);
    await mongoClient.connect();
    const db = mongoClient.db(DBNAME);
    mongoCollection = db.collection(COLLECTION);
    console.log('📦 Conectado ao MongoDB de forma estável!');

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`🚀 Servidor Express na porta ${PORT}`);
        connectToWhatsApp();
    });
}

// Rotas da API
app.get('/api/qr', (req, res) => {
    if (isConnected) return res.json({ status: 'connected', message: 'WhatsApp conectado.' });
    if (qrCodeBase64) return res.json({ status: 'pending', qr: qrCodeBase64 });
    res.json({ status: 'starting', message: 'Aguarde, gerando QR Code ou ligando ao banco...' });
});

app.post('/api/adicionar-grupo', async (req, res) => {
    const { nomeGrupo, clientesPhones } = req.body; 
    try {
        if (!isConnected) throw new Error("WhatsApp deslogado.");
        const participants = clientesPhones.map(num => `${num.replace(/\D/g, '')}@s.whatsapp.net`);
        const group = await sock.groupCreate(nomeGrupo, participants);
        res.json({ status: 'success', groupId: group.id });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.toString() });
    }
});

startServer();