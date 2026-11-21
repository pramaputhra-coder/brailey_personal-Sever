const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const app = express();
app.use(express.json({ limit: '25mb' }));

// Allows your SaaS CRM frontend + per-business isolation headers
app.use(
  cors({
    origin: true,
    credentials: true,
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-business-id',
      'x-business-slug',
      'x-baileys-session',
    ],
  })
);

const SESSIONS_ROOT = path.join(__dirname, 'sessions');
fs.mkdirSync(SESSIONS_ROOT, { recursive: true });
const tenants = new Map();

function getSessionId(req) {
  const raw =
    req.headers['x-baileys-session'] ||
    req.headers['x-business-slug'] ||
    req.headers['x-business-id'] ||
    'default';
  return String(raw).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'default';
}

function getOrCreateTenant(sessionId) {
  if (!tenants.has(sessionId)) {
    tenants.set(sessionId, {
      sessionId,
      sock: null,
      status: 'disconnected',
      qrCodeUrl: null,
      phoneNumber: null,
      profileName: null,
      profilePicUrl: null,
      lastConnectedAt: null,
      error: null,
      queue: [],
      history: [],
      isProcessing: false,
    });
  }
  return tenants.get(sessionId);
}

async function initTenantSocket(sessionId) {
  const t = getOrCreateTenant(sessionId);
  if (t.status === 'connecting' || t.status === 'connected') return t;

  t.status = 'connecting';
  t.error = null;

  const authDir = path.join(SESSIONS_ROOT, sessionId);
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['SaaS CRM Bridge', 'Chrome', '1.0'],
    printQRInTerminal: false,
  });

  t.sock = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      t.qrCodeUrl = await QRCode.toDataURL(qr);
      t.status = 'qr_ready';
    }
    if (connection === 'open') {
      t.status = 'connected';
      t.qrCodeUrl = null;
      t.lastConnectedAt = new Date().toISOString();
      t.phoneNumber = sock.user?.id?.split(':')[0] || null;
      t.profileName = sock.user?.name || null;
      t.error = null;
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      t.sock = null;
      t.status = 'disconnected';
      if (code === DisconnectReason.loggedOut) {
        t.phoneNumber = null;
        t.qrCodeUrl = null;
        fs.rmSync(authDir, { recursive: true, force: true });
      } else {
        setTimeout(() => initTenantSocket(sessionId).catch(() => {}), 3000);
      }
    }
  });

  return t;
}

function formatJid(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10) digits = '91' + digits;
  return `${digits}@s.whatsapp.net`;
}

async function processQueue(t) {
  if (t.isProcessing || !t.sock || t.status !== 'connected') return;
  t.isProcessing = true;
  while (t.queue.length > 0 && t.sock && t.status === 'connected') {
    const item = t.queue.shift();
    try {
      const base64Data = item.imageBase64.replace(/^data:image\/\w+;base64,/, '');
      await t.sock.sendMessage(formatJid(item.phone), {
        image: Buffer.from(base64Data, 'base64'),
        caption: item.message || '',
      });
      item.status = 'sent';
      item.completedAt = new Date().toISOString();
    } catch (err) {
      item.status = 'failed';
      item.error = err?.message || 'Send failed';
      item.completedAt = new Date().toISOString();
    }
    t.history.unshift(item);
    t.history = t.history.slice(0, 100);
    await new Promise((r) => setTimeout(r, 3000));
  }
  t.isProcessing = false;
}

function publicState(t) {
  return {
    status: t.status,
    qrCodeUrl: t.qrCodeUrl,
    phoneNumber: t.phoneNumber,
    profilePicUrl: t.profilePicUrl,
    profileName: t.profileName,
    lastConnectedAt: t.lastConnectedAt,
    error: t.error,
    queueLength: t.queue.length,
    sessionId: t.sessionId,
  };
}

app.get('/', (_req, res) => res.json({ status: 'ok', service: 'baileys-bridge' }));
app.get('/api/health', (_req, res) => res.json({ status: 'ok', activeSessions: tenants.size }));

app.get('/api/whatsapp/status', async (req, res) => {
  const sessionId = getSessionId(req);
  const t = getOrCreateTenant(sessionId);
  if (t.status === 'disconnected') {
    await initTenantSocket(sessionId).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
  }
  res.json(publicState(t));
});

app.post('/api/whatsapp/init', async (req, res) => {
  const sessionId = getSessionId(req);
  await initTenantSocket(sessionId);
  await new Promise((r) => setTimeout(r, 2000));
  res.json(publicState(getOrCreateTenant(sessionId)));
});

app.get('/api/whatsapp/profile-pic', (req, res) => {
  const t = getOrCreateTenant(getSessionId(req));
  res.json({ profilePicUrl: t.profilePicUrl, profileName: t.profileName, phoneNumber: t.phoneNumber });
});

app.post('/api/whatsapp/disconnect', async (req, res) => {
  const sessionId = getSessionId(req);
  const t = getOrCreateTenant(sessionId);
  try { await t.sock?.logout(); } catch {}
  t.sock = null;
  t.status = 'disconnected';
  t.phoneNumber = null;
  t.qrCodeUrl = null;
  fs.rmSync(path.join(SESSIONS_ROOT, sessionId), { recursive: true, force: true });
  res.json({ success: true });
});

app.post('/api/whatsapp/send-label', (req, res) => {
  const t = getOrCreateTenant(getSessionId(req));
  const { phone, imageBase64, message, recipientName, transactionId, customerId } = req.body || {};
  if (!phone || !imageBase64) return res.status(400).json({ success: false, error: 'Missing phone or imageBase64' });
  if (t.status !== 'connected') return res.json({ success: false, status: t.status, error: 'WhatsApp not connected.' });

  const item = {
    id: `wa_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    phone, imageBase64, message: message || '', recipientName, transactionId, customerId,
    status: 'queued', createdAt: new Date().toISOString(),
  };
  t.queue.push(item);
  processQueue(t);
  res.json({ success: true, status: 'connected', itemId: item.id });
});

app.get('/api/whatsapp/queue', (req, res) => {
  const t = getOrCreateTenant(getSessionId(req));
  res.json({
    connectionStatus: t.status,
    phoneNumber: t.phoneNumber,
    queued: t.queue.map(({ imageBase64, ...rest }) => rest),
    history: t.history.map(({ imageBase64, ...rest }) => rest),
    bridgeLogs: [],
    stats: {
      inQueue: t.queue.length,
      isProcessing: t.isProcessing,
      totalSent: t.history.filter((h) => h.status === 'sent').length,
      totalProcessed: t.history.length,
    },
  });
});

app.post('/api/whatsapp/queue/clear-history', (req, res) => {
  getOrCreateTenant(getSessionId(req)).history = [];
  res.json({ success: true });
});

// Important: bind to 0.0.0.0 and process.env.PORT for Mapherix cloud hosting
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Baileys Bridge listening on port ${PORT}`);
});