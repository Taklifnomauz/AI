require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ================= DATABASE =================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

async function db(query, params = []) {
  try {
    const result = await pool.query(query, params);
    return result.rows;
  } catch (error) {
    console.error("❌ DB ERROR:", error.message);
    throw error;
  }
}

// ================= INIT DATABASE =================

async function initDatabase() {
  try {
    console.log("⏳ Initializing database...");

    // 1. USERS
    await db(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        email TEXT,
        password_hash TEXT NOT NULL,
        is_admin BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen TIMESTAMPTZ
      );
    `);
    console.log("✅ Users table ready");

    // 2. MESSAGES
    await db(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        sender TEXT NOT NULL CHECK (sender IN ('user', 'assistant', 'admin')),
        text TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log("✅ Messages table ready");

    // 3. SETTINGS
    await db(`
      CREATE TABLE IF NOT EXISTS settings (
        id SERIAL PRIMARY KEY,
        system_prompt TEXT NOT NULL DEFAULT 
          'Siz Qamir AI nomli O''zbek tilida so''zlashuvchi aqlli yordamchisiz. Foydalanuvchiga foydali, xushmuomala va aniq javob bering.',
        temperature NUMERIC NOT NULL DEFAULT 0.7,
        max_tokens INTEGER NOT NULL DEFAULT 1024,
        model TEXT NOT NULL DEFAULT 'gemini-3.6-flash',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log("✅ Settings table ready");

    // 4. SETTINGS ga default qiymat qo'shish
    const setting = await db(`SELECT * FROM settings WHERE id = 1`);

    if (!setting.length) {
      await db(`
        INSERT INTO settings (id, system_prompt, temperature, max_tokens, model, updated_at)
        VALUES (
          1,
          'Siz Qamir AI nomli O''zbek tilida so''zlashuvchi aqlli yordamchisiz. Foydalanuvchiga foydali, xushmuomala va aniq javob bering.',
          0.7,
          1024,
          'gemini-3.6-flash',
          NOW()
        )
      `);
      console.log("✅ Default settings inserted");
    }

    // 5. ADMIN yaratish
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (adminPassword) {
      const adminHash = crypto
        .createHash("sha256")
        .update(adminPassword)
        .digest("hex");

      const existing = await db(
        `SELECT id FROM users WHERE username = 'admin' LIMIT 1`
      );

      if (!existing.length) {
        await db(
          `INSERT INTO users
          (username, email, password_hash, is_admin, last_seen)
          VALUES ('admin', 'admin@qamir.ai', $1, TRUE, NOW())`,
          [adminHash]
        );
        console.log("✅ Admin user created");
      } else {
        await db(
          `UPDATE users
           SET password_hash = $1, is_admin = TRUE
           WHERE username = 'admin'`,
          [adminHash]
        );
        console.log("✅ Admin user updated");
      }
    }

    console.log("✅ Database initialized successfully!");
  } catch (error) {
    console.error("❌ Database init error:", error.message);
    throw error;
  }
}

// ================= AUTH =================

function hashPassword(password) {
  return crypto
    .createHash("sha256")
    .update(password)
    .digest("hex");
}

function safeUser(row) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    is_admin: row.is_admin,
    created_at: row.created_at,
    last_seen: row.last_seen,
  };
}

function getBearer(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) {
    return header.slice(7);
  }
  return null;
}

async function getUserFromRequest(req) {
  const token = getBearer(req);
  if (!token) return null;

  const rows = await db(
    `SELECT id, username, email, is_admin, created_at, last_seen
     FROM users
     WHERE id = $1`,
    [Number(token)]
  );

  return rows[0] || null;
}

async function requireUser(req, res, next) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return res.status(401).json({ error: "Kirish talab qilinadi" });
    }
    req.user = user;
    next();
  } catch (error) {
    console.error("AUTH ERROR:", error);
    res.status(500).json({ error: "Server xatosi" });
  }
}

async function requireAdmin(req, res, next) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || !user.is_admin) {
      return res.status(403).json({ error: "Admin huquqi talab qilinadi" });
    }
    req.user = user;
    next();
  } catch (error) {
    console.error("ADMIN AUTH ERROR:", error);
    res.status(500).json({ error: "Server xatosi" });
  }
}

// ================= GEMINI AI =================

async function askGemini(userText, history = []) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY sozlanmagan");
  }

  const settingsRows = await db(`SELECT * FROM settings WHERE id = 1`);
  const settings = settingsRows[0] || {};

  const model = process.env.GEMINI_MODEL || settings.model || "gemini-3.6-flash";
  const systemPrompt = settings.system_prompt || "Siz Qamir AI nomli O'zbek tilida so'zlashuvchi yordamchisiz.";

  const contents = history.slice(-20).map((item) => ({
    role: item.sender === "assistant" ? "model" : "user",
    parts: [{ text: String(item.text) }],
  }));

  contents.push({
    role: "user",
    parts: [{ text: userText }],
  });

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(model)}:generateContent`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      contents,
      generationConfig: {
        temperature: Number(settings.temperature ?? 0.7),
        maxOutputTokens: Number(settings.max_tokens ?? 1024),
      },
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("GEMINI ERROR:", JSON.stringify(data));
    throw new Error(data?.error?.message || `Gemini HTTP ${response.status}`);
  }

  const text = data?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim();

  if (!text) {
    throw new Error("Gemini bo'sh javob qaytardi");
  }

  return text;
}

// ================= HEALTH =================

app.get("/health", async (req, res) => {
  try {
    await db("SELECT 1");
    res.json({
      ok: true,
      database: "connected",
      gemini: Boolean(process.env.GEMINI_API_KEY),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      database: "error",
      error: error.message,
    });
  }
});

// ================= REGISTER =================

app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, email = "", password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: "Username va parol kerak" });
    }

    if (String(password).length < 6) {
      return res.status(400).json({ error: "Parol kamida 6 ta belgidan iborat bo'lsin" });
    }

    const hash = hashPassword(String(password));

    const rows = await db(
      `INSERT INTO users
      (username, email, password_hash, last_seen)
      VALUES ($1, $2, $3, NOW())
      RETURNING id, username, email, is_admin, created_at, last_seen`,
      [String(username).trim(), String(email).trim(), hash]
    );

    res.status(201).json({
      success: true,
      user: safeUser(rows[0]),
      token: String(rows[0].id),
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "Bu username allaqachon mavjud" });
    }
    console.error("REGISTER ERROR:", error);
    res.status(500).json({ error: "Ro'yxatdan o'tishda server xatosi" });
  }
});

app.post("/api/register", async (req, res) => {
  req.body = req.body || {};
  const { username, email, password } = req.body;
  return app._router.handle(
    { ...req, url: "/api/auth/register", body: { username, email, password } },
    res,
    (err) => { if (err) throw err; }
  );
});

// ================= LOGIN =================

app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: "Username va parol kerak" });
    }

    const hash = hashPassword(String(password));

    const rows = await db(
      `SELECT id, username, email, is_admin, created_at, last_seen
       FROM users
       WHERE username = $1 AND password_hash = $2
       LIMIT 1`,
      [String(username).trim(), hash]
    );

    if (!rows.length) {
      return res.status(401).json({ error: "Username yoki parol noto'g'ri" });
    }

    await db(`UPDATE users SET last_seen = NOW() WHERE id = $1`, [rows[0].id]);

    res.json({
      success: true,
      user: safeUser(rows[0]),
      token: String(rows[0].id),
    });
  } catch (error) {
    console.error("LOGIN ERROR:", error);
    res.status(500).json({ error: "Kirishda server xatosi" });
  }
});

app.post("/api/login", async (req, res) => {
  req.body = req.body || {};
  const { username, password } = req.body;
  return app._router.handle(
    { ...req, url: "/api/auth/login", body: { username, password } },
    res,
    (err) => { if (err) throw err; }
  );
});

// ================= ME =================

app.get("/api/me", requireUser, async (req, res) => {
  res.json({
    success: true,
    user: safeUser(req.user),
  });
});

// ================= CHAT HISTORY =================

app.get("/api/chat/history", requireUser, async (req, res) => {
  try {
    const rows = await db(
      `SELECT id, sender, text, created_at
       FROM messages
       WHERE user_id = $1
       ORDER BY created_at ASC
       LIMIT 200`,
      [req.user.id]
    );

    res.json({
      success: true,
      messages: rows,
    });
  } catch (error) {
    console.error("HISTORY ERROR:", error);
    res.status(500).json({ error: "Suhbat tarixini olishda xato" });
  }
});

// ================= CHAT =================

app.post("/api/chat", requireUser, async (req, res) => {
  try {
    const text = String(req.body?.message || req.body?.text || "").trim();

    if (!text) {
      return res.status(400).json({ error: "Xabar bo'sh" });
    }

    const previous = await db(
      `SELECT sender, text
       FROM messages
       WHERE user_id = $1
       ORDER BY created_at ASC
       LIMIT 40`,
      [req.user.id]
    );

    await db(
      `INSERT INTO messages (user_id, sender, text)
       VALUES ($1, 'user', $2)`,
      [req.user.id, text]
    );

    await db(`UPDATE users SET last_seen = NOW() WHERE id = $1`, [req.user.id]);

    let answer;

    try {
      answer = await askGemini(text, previous);
    } catch (aiError) {
      console.error("AI ERROR:", aiError);
      return res.status(502).json({
        error: "AI javobida xato",
        detail: aiError.message,
      });
    }

    const saved = await db(
      `INSERT INTO messages (user_id, sender, text)
       VALUES ($1, 'assistant', $2)
       RETURNING id, sender, text, created_at`,
      [req.user.id, answer]
    );

    res.json({
      success: true,
      message: saved[0],
      reply: answer,
    });
  } catch (error) {
    console.error("CHAT ERROR:", error);
    res.status(500).json({ error: "Xabar yuborishda server xatosi" });
  }
});

// ================= ADMIN =================

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    const rows = await db(`
      SELECT
        u.id,
        u.username,
        u.email,
        u.is_admin,
        u.created_at,
        u.last_seen,
        COUNT(m.id)::int AS message_count
      FROM users u
      LEFT JOIN messages m ON m.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);

    res.json({
      success: true,
      users: rows,
    });
  } catch (error) {
    console.error("ADMIN USERS ERROR:", error);
    res.status(500).json({ error: "Foydalanuvchilarni olishda xato" });
  }
});

app.get("/api/admin/users/:id/messages", requireAdmin, async (req, res) => {
  try {
    const userId = Number(req.params.id);

    const users = await db(
      `SELECT id, username, email, is_admin, created_at, last_seen
       FROM users
       WHERE id = $1`,
      [userId]
    );

    if (!users.length) {
      return res.status(404).json({ error: "Foydalanuvchi topilmadi" });
    }

    const messages = await db(
      `SELECT id, sender, text, created_at
       FROM messages
       WHERE user_id = $1
       ORDER BY created_at ASC
       LIMIT 1000`,
      [userId]
    );

    res.json({
      success: true,
      user: users[0],
      messages,
    });
  } catch (error) {
    console.error("ADMIN MESSAGES ERROR:", error);
    res.status(500).json({ error: "Suhbatni olishda xato" });
  }
});

app.post("/api/admin/reply", requireAdmin, async (req, res) => {
  try {
    const userId = Number(req.body?.user_id);
    const text = String(req.body?.message || req.body?.text || "").trim();

    if (!userId || !text) {
      return res.status(400).json({ error: "user_id va xabar kerak" });
    }

    const rows = await db(
      `INSERT INTO messages (user_id, sender, text)
       VALUES ($1, 'admin', $2)
       RETURNING id, sender, text, created_at`,
      [userId, text]
    );

    res.json({
      success: true,
      message: rows[0],
    });
  } catch (error) {
    console.error("ADMIN REPLY ERROR:", error);
    res.status(500).json({ error: "Admin xabarini saqlashda xato" });
  }
});

app.get("/api/admin/settings", requireAdmin, async (req, res) => {
  try {
    const rows = await db(`SELECT * FROM settings WHERE id = 1`);
    res.json({
      success: true,
      settings: rows[0] || null,
    });
  } catch (error) {
    console.error("ADMIN SETTINGS ERROR:", error);
    res.status(500).json({ error: "Sozlamalarni olishda xato" });
  }
});

app.post("/api/admin/settings", requireAdmin, async (req, res) => {
  try {
    const {
      system_prompt,
      temperature = 0.7,
      max_tokens = 1024,
      model = "gemini-3.6-flash",
    } = req.body || {};

    const exists = await db(`SELECT id FROM settings WHERE id = 1`);

    if (!exists.length) {
      await db(
        `INSERT INTO settings (id, system_prompt, temperature, max_tokens, model, updated_at)
         VALUES (1, $1, $2, $3, $4, NOW())`,
        [String(system_prompt || ""), Number(temperature), Number(max_tokens), String(model)]
      );
    } else {
      await db(
        `UPDATE settings
         SET system_prompt = $1, temperature = $2, max_tokens = $3, model = $4, updated_at = NOW()
         WHERE id = 1`,
        [String(system_prompt || ""), Number(temperature), Number(max_tokens), String(model)]
      );
    }

    const rows = await db(`SELECT * FROM settings WHERE id = 1`);

    res.json({
      success: true,
      settings: rows[0],
    });
  } catch (error) {
    console.error("ADMIN SETTINGS ERROR:", error);
    res.status(500).json({ error: "Sozlamalarni saqlashda xato" });
  }
});

// ================= FRONTEND =================

// Static fayllar
app.use(express.static(path.join(__dirname, "public")));

// ================= CATCH-ALL (Express 5 uchun to'g'ri) =================
// Express 5 da app.get('*') o'rniga app.use() ishlatiladi
app.use((req, res) => {
  // Agar so'rov API ga bo'lmasa, index.html ni qaytar
  if (!req.path.startsWith('/api/') && req.path !== '/health' && req.path !== '/admin') {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  } else {
    res.status(404).json({ error: "Not found" });
  }
});

// ================= START =================

async function start() {
  try {
    await initDatabase();
    console.log("✅ PostgreSQL: connected");
    console.log("✅ Gemini API key:", process.env.GEMINI_API_KEY ? "configured" : "NOT configured");

    app.listen(PORT, () => {
      console.log(`🚀 Qamir AI server running on port ${PORT}`);
      console.log(`📍 http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("❌ STARTUP ERROR:", error);
    process.exit(1);
  }
}

start();
