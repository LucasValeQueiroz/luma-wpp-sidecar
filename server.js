const express = require('express');
const { default: makeWASocket, DisconnectReason, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
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
let mongoCollection; 
let reconnectTimeout; // Evita disparos múltiplos de reconexão

// Adaptador do MongoDB profissional usando BufferJSON oficial do Baileys
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
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    console.log('🔄 Inicializando instância estável do WhatsApp...');
    
    const { state, saveCreds } = await useMongoDBAuthState(mongoCollection);

    // Remove ouvintes antigos se a instância anterior ainda estiver fechando
    if (sock) {
        try {
            sock.ev.removeAllListeners('connection.update');
            sock.ev.removeAllListeners('creds.update');
        } catch (e) { /* silencioso */ }
    }

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
            console.log('⚡ QR Code estável gerado e pronto para o Google Apps Script!');
        }

        if (connection === 'close') {
            isConnected = false;
            qrCodeBase64 = '';
            const statusCode = lastDisconnect.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`🔴 Conexão encerrada (Status: ${statusCode}). Agendando reconexão: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                // Aguarda 7 segundos antes de tentar de novo para dar tempo ao banco de respirar
                reconnectTimeout = setTimeout(connectToWhatsApp, 7000); 
            } else {
                console.log('🔴 Aparelho desconectado pelo usuário. Limpando registros...');
                await mongoCollection.deleteMany({});
            }
        } else if (connection === 'open') {
            isConnected = true;
            qrCodeBase64 = '';
            console.log('✅ WhatsApp TOTALMENTE Autenticado e Pronto!');
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

async function startServer() {
    if (!MONGO_URI) {
        console.error("❌ ERRO CRÍTICO: MONGO_URI ausente!");
        return;
    }

    const mongoClient = new MongoClient(MONGO_URI);
    await mongoClient.connect();
    const db = mongoClient.db(DBNAME);
    mongoCollection = db.collection(COLLECTION);
    console.log('📦 Conectado ao MongoDB com sucesso!');

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`🚀 Servidor Express online na porta ${PORT}`);
        connectToWhatsApp();
    });
}

// Rotas da API para o Google Apps Script
// Rotas da API para o Google Apps Script
app.get('/api/qr', (req, res) => {
    if (isConnected) return res.json({ status: 'connected', message: 'WhatsApp conectado.' });
    if (qrCodeBase64) return res.json({ status: 'pending', qr: qrCodeBase64 });
    res.json({ status: 'starting', message: 'Aguarde, gerando QR Code estável...' });
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

// ✅ Listar grupos que o bot participa (Com filtro de pesquisa)
app.get('/api/listar-grupos', async (req, res) => {
    try {
        if (!isConnected) throw new Error("WhatsApp deslogado.");
        
        // Pega o termo de busca enviado na URL
        const termoBusca = req.query.busca ? req.query.busca.toLowerCase() : '';
        
        if (!termoBusca || termoBusca.length < 3) {
            return res.status(400).json({ status: 'error', message: 'Digite pelo menos 3 letras para buscar.' });
        }

        // Busca os grupos no WhatsApp
        const groups = await sock.groupFetchAllParticipating();
        
        // Formata os dados
        let groupList = Object.values(groups).map(g => ({
            id: g.id,
            subject: g.subject,
            participants: g.participants.length
        }));
        
        // FILTRA os grupos usando o termo de busca (deixando a resposta muito leve)
        groupList = groupList.filter(g => g.subject && g.subject.toLowerCase().includes(termoBusca));
        
        // Limita a 20 resultados para nunca travar o Apps Script
        groupList = groupList.slice(0, 20);
        
        res.json({ status: 'success', grupos: groupList });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.toString() });
    }
});

// ✅ Adicionar membros a um grupo JÁ EXISTENTE
app.post('/api/adicionar-membros-grupo', async (req, res) => {
    const { groupId, clientesPhones } = req.body; 
    try {
        if (!isConnected) throw new Error("WhatsApp deslogado.");
        if (!groupId || !clientesPhones || clientesPhones.length === 0) {
            throw new Error("ID do grupo ou lista de contatos ausente.");
        }

        // Formata os números para o padrão do Baileys/WhatsApp
        const participants = clientesPhones.map(num => `${String(num).replace(/\D/g, '')}@s.whatsapp.net`);
        
        // Função do Baileys para adicionar participantes a um grupo existente
        const action = await sock.groupParticipantsUpdate(
            groupId, 
            participants,
            "add" // Ação de adicionar
        );
        
        res.json({ status: 'success', action: action });
    } catch (error) {
        console.error("Erro ao adicionar membros no grupo:", error);
        res.status(500).json({ status: 'error', message: error.toString() });
    }
});

startServer();