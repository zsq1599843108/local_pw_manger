const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { initDatabase } = require('./db');
const crypto = require('./crypto');
const { handshakeHandler: aoapHandshake } = require('./aoap-server');
const { probeHandler: lanProbe } = require('./lan-server');
const { openBridge } = require('./lan-ws-client');
const { installLanDeviceRoutes } = require('./lan-device-routes');

const app = express();
const server = http.createServer(app);
const PORT = 3000;
const activePhoneTokens = new Map();

// ---------- host validation (reviewer suggestion #4) ----------
// Only RFC1918 (10/8, 172.16/12, 192.168/16), link-local (169.254/16), and
// loopback (127/8). parseIp parses a bare IPv4 address (no DNS resolution).
function parseIp(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map(s => { const n = Number(s); return (Number.isInteger(n) && n >= 0 && n <= 255) ? n : null; });
  if (nums.some(n => n === null)) return null;
  const [a, b, c, d] = nums;
  return (a << 24) | (b << 16) | (c << 8) | d;  // treat as unsigned
}
const ALLOWED_PREFIXES = [
  [0x7f000000, 8],    // 127.0.0.0/8
  [0x0a000000, 8],    // 10.0.0.0/8
  [0xa9fe0000, 16],   // 169.254.0.0/16
  [0xac100000, 12],   // 172.16.0.0/12 (covers 172.16..172.31, incl. iPhone hotspot 172.20.10.x)
  [0xc0a80000, 16],   // 192.168.0.0/16
];
function isAllowedLanHost(host) {
  const ip = parseIp(host);
  if (ip === null) return false;
  for (const [prefix, bits] of ALLOWED_PREFIXES) {
    // Use >>> 0 to coerce to unsigned 32-bit; bits=32 would be a no-op anyway.
    const mask = bits === 0 ? 0 : (~((1 << (32 - bits)) - 1)) >>> 0;
    if ((ip & mask) >>> 0 === (prefix & mask) >>> 0) return true;
  }
  return false;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = initDatabase();

// AOAP server-side handshake (v0.3 M1.5) — Windows workaround for Chrome's
// inability to open() MTP-mode phones. See src/aoap-server.js for details.
// ⚠️ DEPRECATED on Win11 (MTP locks vendor xfer); kept for Linux/macOS.
app.post('/api/aoap/handshake', aoapHandshake);

// Wi-Fi-hotspot pairing (v0.3 M1', ADR-002) — the supported route.
app.post('/api/lan/probe', lanProbe);

// M2' — encrypted WebSocket channel. Browser opens
//   ws://localhost:3000/api/lan/socket?host=...&port=...
// and this route dials the phone's ws://<host>:<port>/socket, then bridges the
// two as a dumb byte pipe (see lan-ws-client.js). All crypto is end-to-end
// between browser WebCrypto and phone Tink; Node never sees a key.
const lanWss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/api/lan/socket') {
    socket.destroy();
    return;
  }
  lanWss.handleUpgrade(req, socket, head, (ws) => {
    handleLanSocket(ws, url.searchParams);
  });
});

async function handleLanSocket(browserWs, params) {
  const host = (params.get('host') || '192.168.43.1').toString();
  const port = Number(params.get('port') || 9876);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    browserWs.close(1008, 'bad port');
    return;
  }
  // Host whitelist: only RFC1918 private space (10/8, 172.16/12, 192.168/16),
  // link-local 169.254/16, and loopback 127/8 (for unit tests against a local
  // mock phone). This stops a malicious page from coercing the Node bridge
  // into dialling arbitrary internet hosts on the user's behalf.
  // Suggestion #4 from docs/review/feature-m2-encrypted-channel.md.
  if (!isAllowedLanHost(host)) {
    browserWs.close(1008, JSON.stringify({ ok: false, code: 'HOST_NOT_LAN', error: `refusing to dial ${host}; only RFC1918 / 127/8 / 169.254/16 allowed` }));
    return;
  }
  let bridge;
  try {
    bridge = await openBridge({ host, port });
  } catch (err) {
    // Map upstream dial failure to a code the browser can hint on.
    const code = err.code === 'NO_SOCKET_ROUTE' ? 1003    // unsupported data
               : err.code === 'REFUSED'         ? 1001    // going away
               : 1011;
    browserWs.close(code, JSON.stringify({ ok:false, code: err.code ?? 'UNKNOWN', error: err.message }));
    return;
  }
  bridge.attachBrowser(browserWs);
}


// ---- M3'-A pairing persistence (TOFU). Browser, having just decrypted a
// PAIR_OK frame from the phone, posts the fingerprint + raw pubkey here so the
// server stamps it into paired_devices. Implementation lives in
// lan-device-routes.js so tests can mount it onto an in-memory sqlite.
installLanDeviceRoutes(app, db);


app.post('/api/auth/setup', (req, res) => {
  const { masterPassword } = req.body;
  
  if (!masterPassword || masterPassword.length < 8) {
    return res.status(400).json({ error: 'Master password must be at least 8 characters' });
  }
  
  const existing = db.prepare('SELECT id FROM master_keys LIMIT 1').get();
  if (existing) {
    return res.status(400).json({ error: 'Master password already set' });
  }
  
  const salt = crypto.generateSalt();
  const hash = crypto.hashPassword(masterPassword, salt);
  
  db.prepare('INSERT INTO master_keys (salt, verify_hash) VALUES (?, ?)').run(salt, hash);
  
  res.json({ success: true });
});

app.post('/api/auth/verify', (req, res) => {
  const { masterPassword } = req.body;
  
  const masterKey = db.prepare('SELECT * FROM master_keys LIMIT 1').get();
  if (!masterKey) {
    return res.status(400).json({ error: 'Please set master password first' });
  }
  
  const hash = crypto.hashPassword(masterPassword, masterKey.salt);
  
  if (!hash.equals(masterKey.verify_hash)) {
    return res.status(401).json({ error: 'Incorrect master password' });
  }
  
  const derivedKey = crypto.deriveKey(masterPassword, masterKey.salt);
  
  res.json({ 
    success: true, 
    sessionKey: derivedKey.toString('hex')
  });
});

app.post('/api/passwords', (req, res) => {
  const { sessionKey, title, username, password, url, notes, category } = req.body;
  
  if (!sessionKey || !title || !password) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  try {
    const key = Buffer.from(sessionKey, 'hex');
    const { encrypted, iv, authTag } = crypto.encrypt(password, key);
    
    const result = db.prepare(`
      INSERT INTO passwords (title, username, password_encrypted, iv, auth_tag, url, notes, category)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(title, username, encrypted, iv, authTag, url, notes, category || 'default');
    
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: 'Encryption failed' });
  }
});

app.get('/api/passwords', (req, res) => {
  const { sessionKey } = req.query;
  
  if (!sessionKey) {
    return res.status(400).json({ error: 'Session key required' });
  }
  
  try {
    const key = Buffer.from(sessionKey, 'hex');
    const passwords = db.prepare('SELECT * FROM passwords ORDER BY created_at DESC').all();
    
    const decrypted = passwords.map(p => {
      try {
        const decryptedPassword = crypto.decrypt(p.password_encrypted, key, p.iv, p.auth_tag);
        return {
          id: p.id,
          title: p.title,
          username: p.username,
          password: decryptedPassword,
          url: p.url,
          notes: p.notes,
          category: p.category,
          created_at: p.created_at,
          updated_at: p.updated_at
        };
      } catch {
        return { ...p, password: '*** Decryption failed ***' };
      }
    });
    
    res.json(decrypted);
  } catch (err) {
    res.status(500).json({ error: 'Decryption failed' });
  }
});

app.put('/api/passwords/:id', (req, res) => {
  const { id } = req.params;
  const { sessionKey, title, username, password, url, notes, category } = req.body;
  
  if (!sessionKey) {
    return res.status(400).json({ error: 'Session key required' });
  }
  
  try {
    const key = Buffer.from(sessionKey, 'hex');
    
    let updateFields = [];
    let updateValues = [];
    
    if (title !== undefined) { updateFields.push('title = ?'); updateValues.push(title); }
    if (username !== undefined) { updateFields.push('username = ?'); updateValues.push(username); }
    if (password !== undefined) {
      const { encrypted, iv, authTag } = crypto.encrypt(password, key);
      updateFields.push('password_encrypted = ?', 'iv = ?', 'auth_tag = ?');
      updateValues.push(encrypted, iv, authTag);
    }
    if (url !== undefined) { updateFields.push('url = ?'); updateValues.push(url); }
    if (notes !== undefined) { updateFields.push('notes = ?'); updateValues.push(notes); }
    if (category !== undefined) { updateFields.push('category = ?'); updateValues.push(category); }
    
    updateFields.push('updated_at = CURRENT_TIMESTAMP');
    updateValues.push(id);
    
    db.prepare(`UPDATE passwords SET ${updateFields.join(', ')} WHERE id = ?`).run(...updateValues);
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
  }
});

app.delete('/api/passwords/:id', (req, res) => {
  const { id } = req.params;
  
  db.prepare('DELETE FROM passwords WHERE id = ?').run(id);
  
  res.json({ success: true });
});

app.get('/api/generate', (req, res) => {
  const { length = 16, uppercase = true, lowercase = true, numbers = true, symbols = true } = req.query;
  
  const password = crypto.generatePassword(parseInt(length), {
    uppercase: uppercase === 'true',
    lowercase: lowercase === 'true',
    numbers: numbers === 'true',
    symbols: symbols === 'true'
  });
  
  res.json({ password });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/export', (req, res) => {
  const { sessionKey } = req.query;
  
  if (!sessionKey) {
    return res.status(400).json({ error: 'Session key required' });
  }
  
  try {
    const key = Buffer.from(sessionKey, 'hex');
    const passwords = db.prepare('SELECT * FROM passwords ORDER BY created_at DESC').all();
    
    const exported = passwords.map(p => ({
      title: p.title,
      username: p.username,
      password_encrypted: p.password_encrypted.toString('hex'),
      iv: p.iv.toString('hex'),
      auth_tag: p.auth_tag.toString('hex'),
      url: p.url,
      notes: p.notes,
      category: p.category,
      created_at: p.created_at,
      updated_at: p.updated_at
    }));
    
    res.setHeader('Content-Disposition', 'attachment; filename="passwords_export.json"');
    res.json({ version: 1, exported_at: new Date().toISOString(), count: exported.length, entries: exported });
  } catch (err) {
    res.status(500).json({ error: 'Export failed' });
  }
});

app.post('/api/import', (req, res) => {
  const { sessionKey, entries } = req.body;
  
  if (!sessionKey || !entries || !Array.isArray(entries)) {
    return res.status(400).json({ error: 'Session key and entries array required' });
  }
  
  try {
    let imported = 0;
    let skipped = 0;
    
    const insert = db.prepare(`
      INSERT INTO passwords (title, username, password_encrypted, iv, auth_tag, url, notes, category)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const insertMany = db.transaction((items) => {
      for (const entry of items) {
        if (!entry.title || !entry.password_encrypted || !entry.iv || !entry.auth_tag) {
          skipped++;
          continue;
        }
        
        insert.run(
          entry.title,
          entry.username || null,
          Buffer.from(entry.password_encrypted, 'hex'),
          Buffer.from(entry.iv, 'hex'),
          Buffer.from(entry.auth_tag, 'hex'),
          entry.url || null,
          entry.notes || null,
          entry.category || 'default'
        );
        imported++;
      }
    });
    
    insertMany(entries);
    
    res.json({ success: true, imported, skipped, total: entries.length });
  } catch (err) {
    res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

app.post('/api/phone/token', (req, res) => {
  const { token } = req.body;
  
  if (!token || token.length !== 4) {
    return res.status(400).json({ error: 'Token must be 4 digits' });
  }
  
  activePhoneTokens.set(token, { createdAt: Date.now() });
  
  setTimeout(() => {
    activePhoneTokens.delete(token);
  }, 5 * 60 * 1000);
  
  res.json({ success: true });
});

app.post('/api/phone/verify', (req, res) => {
  const { code, sessionKey } = req.body;
  
  if (!code || code.length !== 4) {
    return res.status(400).json({ error: 'Code must be 4 digits' });
  }
  
  if (!activePhoneTokens.has(code)) {
    return res.status(401).json({ error: 'Invalid or expired code' });
  }
  
  activePhoneTokens.delete(code);

  res.json({ success: true });
});

server.listen(PORT, () => {
  console.log(`Password Manager running at http://localhost:${PORT}`);
});
