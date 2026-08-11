const express = require('express');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT || 10000);
const HOST = '0.0.0.0';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL topilmadi. Render Postgres ulanishini env ga ulang.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const q = (text, params = []) => pool.query(text, params);

async function initDb() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sender TEXT NOT NULL CHECK(sender IN ('user','bot','admin')),
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
    CREATE INDEX IF NOT EXISTS idx_messages_user_id_id ON messages(user_id, id);
    CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const admin = envAdmin();
  const existing = await q('SELECT id FROM users WHERE username=$1', [admin.username]);
  if (existing.rowCount === 0) {
    const hash = bcrypt.hashSync(admin.password, 12);
    await q(
      'INSERT INTO users(username,email,password_hash,is_admin) VALUES($1,$2,$3,TRUE)',
      [admin.username, `${admin.username}@qamir.local`, hash]
    );
  } else {
    await q('UPDATE users SET is_admin=TRUE WHERE username=$1', [admin.username]);
  }

  const defaults = {
    system_prompt: "Siz Qamir AI nomli O'zbek tilida so'zlashuvchi yordamchi agentsiz. Foydalanuvchiga ravon, aniq, foydali va xushmuomala javob bering.",
    temperature: '0.7',
    max_tokens: '1024',
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'
  };

  for (const [key, value] of Object.entries(defaults)) {
    await q(
      'INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING',
      [key, String(value)]
    );
  }
}

function envAdmin() {
  return {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || ''
  };
}

if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 8) {
  console.error('ADMIN_PASSWORD env o‘rnatilishi va kamida 8 belgidan iborat bo‘lishi kerak.');
  process.exit(1);
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function getSettings() {
  const { rows } = await q('SELECT key,value FROM settings');
  const s = {};
  rows.forEach(r => { s[r.key] = r.value; });
  return {
    system_prompt: s.system_prompt || '',
    temperature: Number(s.temperature ?? 0.7),
    max_tokens: Number(s.max_tokens ?? 1024),
    model: s.model || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'
  };
}

async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Kirish talab qilinadi.' });

    const { rows } = await q(`
      SELECT u.id,u.username,u.email,u.is_admin,u.last_seen
      FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token=$1 AND s.expires_at > NOW()
    `, [token]);

    if (!rows[0]) return res.status(401).json({ error: 'Sessiya tugagan. Qayta kiring.' });
    req.user = {
      id: rows[0].id,
      username: rows[0].username,
      email: rows[0].email,
      isAdmin: rows[0].is_admin
    };

    await q('UPDATE users SET last_seen=NOW() WHERE id=$1', [req.user.id]);
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server autentifikatsiya xatosi.' });
  }
}

function adminOnly(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).json({ error: 'Faqat admin uchun.' });
  next();
}

async function issueSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await q(
    "INSERT INTO sessions(token,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '30 days')",
    [token, userId]
  );
  return token;
}

function publicUser(row, token) {
  return {
    token,
    username: row.username,
    email: row.email,
    isAdmin: !!row.is_admin
  };
}

app.post('/api/auth/register', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (username.length < 3 || username.length > 32) {
      return res.status(400).json({ error: 'Foydalanuvchi nomi 3–32 belgidan iborat bo‘lsin.' });
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: 'Email noto‘g‘ri formatda.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Parol kamida 6 belgidan iborat bo‘lsin.' });
    }

    const hash = bcrypt.hashSync(password, 12);
    const result = await q(
      'INSERT INTO users(username,email,password_hash) VALUES($1,$2,$3) RETURNING *',
      [username, email, hash]
    );
    const user = result.rows[0];
    const token = await issueSession(user.id);
    res.json(publicUser(user, token));
  } catch (e) {
    if (e.code === '23505') {
      if (e.constraint?.includes('username')) return res.status(409).json({ error: 'Bu foydalanuvchi nomi band.' });
      if (e.constraint?.includes('email')) return res.status(409).json({ error: 'Bu email allaqachon ro‘yxatdan o‘tgan.' });
    }
    console.error(e);
    res.status(500).json({ error: 'Ro‘yxatdan o‘tishda xato.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const result = await q('SELECT * FROM users WHERE username=$1', [username]);
    const user = result.rows[0];
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Login yoki parol noto‘g‘ri.' });
    }
    const token = await issueSession(user.id);
    await q('UPDATE users SET last_seen=NOW() WHERE id=$1', [user.id]);
    res.json(publicUser(user, token));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Kirishda server xatosi.' });
  }
});

app.post('/api/auth/logout', auth, async (req, res) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    await q('DELETE FROM sessions WHERE token=$1', [token]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Chiqishda xato.' });
  }
});

app.get('/api/me', auth, (req,res) => res.json(req.user));

app.get('/api/messages', auth, async (req,res) => {
  try {
    const { rows } = await q(
      'SELECT sender,text,created_at FROM messages WHERE user_id=$1 ORDER BY id ASC',
      [req.user.id]
    );
    res.json(rows.map(r => ({ sender:r.sender, text:r.text, time:new Date(r.created_at).toLocaleTimeString('uz-UZ',{hour:'2-digit',minute:'2-digit'}) })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Xabarlarni yuklashda xato.' });
  }
});

async function saveMessage(userId, sender, text) {
  await q('INSERT INTO messages(user_id,sender,text) VALUES($1,$2,$3)', [userId,sender,text]);
}

async function generateAIReply(userText, userId) {
  const settings = await getSettings();
  if (!process.env.GROQ_API_KEY) {
    return 'Salom! Men Qamir AI yordamchingizman. Server ishlayapti. AI API kaliti ulanmaguncha test rejimida javob beraman.';
  }

  const history = await q(
    'SELECT sender,text FROM messages WHERE user_id=$1 ORDER BY id DESC LIMIT 20',
    [userId]
  );

  const messages = [
    { role: 'system', content: settings.system_prompt },
    ...history.rows.reverse().map(r => ({
      role: r.sender === 'user' ? 'user' : 'assistant',
      content: r.text
    }))
  ];

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: settings.temperature,
      max_tokens: settings.max_tokens,
      messages
    })
  });

  if (!response.ok) throw new Error(`Groq API ${response.status}: ${await response.text()}`);
  const data = await response.json();
  return data?.choices?.[0]?.message?.content || 'Javob olishda muammo yuz berdi.';
}

app.post('/api/chat', auth, async (req,res) => {
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error:'Xabar bo‘sh.' });
  if (text.length > 10000) return res.status(400).json({ error:'Xabar juda uzun.' });

  try {
    await saveMessage(req.user.id, 'user', text);
    const reply = await generateAIReply(text, req.user.id);
    await saveMessage(req.user.id, 'bot', reply);
    res.json({ reply });
  } catch (e) {
    console.error(e);
    const reply = 'Kechirasiz, AI serverida vaqtinchalik xatolik yuz berdi.';
    try { await saveMessage(req.user.id, 'bot', reply); } catch (_) {}
    res.status(502).json({ error: reply, reply });
  }
});

app.get('/api/admin/users', auth, adminOnly, async (req,res) => {
  try {
    const { rows } = await q(`
      SELECT u.id,u.username,u.email,u.is_admin,u.created_at,u.last_seen,
        lm.text AS last_message,
        lm.created_at AS last_message_at,
        COALESCE(mc.message_count,0) AS message_count
      FROM users u
      LEFT JOIN LATERAL (
        SELECT text,created_at FROM messages m
        WHERE m.user_id=u.id ORDER BY m.id DESC LIMIT 1
      ) lm ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS message_count FROM messages m
        WHERE m.user_id=u.id AND m.sender='user'
      ) mc ON TRUE
      ORDER BY COALESCE(lm.last_message_at,u.created_at) DESC
    `);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Foydalanuvchilarni yuklashda xato.' });
  }
});

app.get('/api/admin/users/:username/messages', auth, adminOnly, async (req,res) => {
  try {
    const userResult = await q('SELECT id,username,email FROM users WHERE username=$1', [req.params.username]);
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error:'Foydalanuvchi topilmadi.' });
    const messages = await q('SELECT sender,text,created_at FROM messages WHERE user_id=$1 ORDER BY id ASC', [user.id]);
    res.json({ user, messages: messages.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Suhbatni yuklashda xato.' });
  }
});

app.post('/api/admin/users/:username/message', auth, adminOnly, async (req,res) => {
  try {
    const text = String(req.body.text || '').trim();
    if (!text) return res.status(400).json({ error:'Xabar bo‘sh.' });
    if (text.length > 10000) return res.status(400).json({ error:'Xabar juda uzun.' });
    const userResult = await q('SELECT id FROM users WHERE username=$1', [req.params.username]);
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error:'Foydalanuvchi topilmadi.' });
    await saveMessage(user.id, 'admin', text);
    res.json({ ok:true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error:'Admin xabari yuborilmadi.' });
  }
});

app.get('/api/settings', auth, adminOnly, async (req,res) => {
  try { res.json(await getSettings()); }
  catch (e) { res.status(500).json({ error:'Sozlamalarni yuklashda xato.' }); }
});

app.put('/api/settings', auth, adminOnly, async (req,res) => {
  try {
    const allowed = ['system_prompt','temperature','max_tokens','model'];
    for (const key of allowed) {
      if (req.body[key] === undefined) continue;
      let value = String(req.body[key]);
      if (key === 'temperature') {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0 || n > 2) return res.status(400).json({error:'Temperature 0–2 oralig‘ida bo‘lsin.'});
        value = String(n);
      }
      if (key === 'max_tokens') {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 100 || n > 4096) return res.status(400).json({error:'Max Tokens 100–4096 oralig‘ida bo‘lsin.'});
        value = String(n);
      }
      await q(
        'INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value',
        [key,value]
      );
    }
    res.json(await getSettings());
  } catch (e) {
    console.error(e);
    res.status(500).json({ error:'Sozlamalarni saqlashda xato.' });
  }
});

app.get('/api/admin/stats', auth, adminOnly, async (req,res) => {
  try {
    const [users, messages, online] = await Promise.all([
      q('SELECT COUNT(*)::int AS c FROM users'),
      q('SELECT COUNT(*)::int AS c FROM messages'),
      q("SELECT COUNT(*)::int AS c FROM users WHERE last_seen IS NOT NULL AND last_seen >= NOW()-INTERVAL '5 minutes'")
    ]);
    res.json({ users:users.rows[0].c, messages:messages.rows[0].c, online:online.rows[0].c });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error:'Statistikani yuklashda xato.' });
  }
});

app.get('/health', async (req,res) => {
  try {
    await q('SELECT 1');
    res.json({ ok:true, service:'Qamir AI', database:'connected' });
  } catch (e) {
    res.status(503).json({ ok:false, service:'Qamir AI', database:'disconnected' });
  }
});

app.use((req,res,next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    return res.sendFile(path.join(__dirname,'public','index.html'));
  }
  next();
});

async function start() {
  try {
    await q('SELECT 1');
    await initDb();
    app.listen(PORT, HOST, () => {
      console.log(`Qamir AI server listening on ${HOST}:${PORT}`);
      console.log(`Admin: ${envAdmin().username}`);
    });
  } catch (e) {
    console.error('Server ishga tushmadi:', e);
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  await pool.end();
  process.exit(0);
});

start();
