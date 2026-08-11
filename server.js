require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = Number(process.env.PORT) || 10000;

// ================= BASIC =================

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
  const result = await pool.query(query, params);
  return result.rows;
}

// ================= DATABASE INIT =================

async function initDatabase() {
  console.log("Database tekshirilmoqda...");

  await db(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT DEFAULT '',
      password_hash TEXT NOT NULL,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen TIMESTAMPTZ
    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,
      sender TEXT NOT NULL
        CHECK (sender IN ('user', 'assistant', 'admin')),
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      system_prompt TEXT,
      temperature NUMERIC DEFAULT 0.7,
      max_tokens INTEGER DEFAULT 1024,
      model TEXT DEFAULT 'gemini-2.5-flash',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db(`
    ALTER TABLE settings
    ADD COLUMN IF NOT EXISTS system_prompt TEXT
  `);

  await db(`
    ALTER TABLE settings
    ADD COLUMN IF NOT EXISTS temperature NUMERIC DEFAULT 0.7
  `);

  await db(`
    ALTER TABLE settings
    ADD COLUMN IF NOT EXISTS max_tokens INTEGER DEFAULT 1024
  `);

  await db(`
    ALTER TABLE settings
    ADD COLUMN IF NOT EXISTS model TEXT DEFAULT 'gemini-2.5-flash'
  `);

  await db(`
    ALTER TABLE settings
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()
  `);

  const settings = await db(`
    SELECT id
    FROM settings
    WHERE id = 1
    LIMIT 1
  `);

  if (!settings.length) {
    await db(
      `
      INSERT INTO settings
      (
        id,
        system_prompt,
        temperature,
        max_tokens,
        model,
        updated_at
      )
      VALUES
      (
        1,
        $1,
        0.7,
        1024,
        'gemini-2.5-flash',
        NOW()
      )
      `,
      [
        "Siz Qamir AI nomli O'zbek tilida so'zlashuvchi aqlli yordamchisiz. Foydalanuvchiga foydali, xushmuomala va aniq javob bering.",
      ]
    );
  } else {
    await db(
      `
      UPDATE settings
      SET
        system_prompt = COALESCE(
          system_prompt,
          $1
        ),
        temperature = COALESCE(
          temperature,
          0.7
        ),
        max_tokens = COALESCE(
          max_tokens,
          1024
        ),
        model = COALESCE(
          model,
          'gemini-2.5-flash'
        ),
        updated_at = COALESCE(
          updated_at,
          NOW()
        )
      WHERE id = 1
      `,
      [
        "Siz Qamir AI nomli O'zbek tilida so'zlashuvchi aqlli yordamchisiz. Foydalanuvchiga foydali, xushmuomala va aniq javob bering.",
      ]
    );
  }

  // ================= ADMIN =================

  const adminPassword = process.env.ADMIN_PASSWORD;

  if (adminPassword) {
    const adminHash = crypto
      .createHash("sha256")
      .update(String(adminPassword))
      .digest("hex");

    const existingAdmin = await db(`
      SELECT id
      FROM users
      WHERE username = 'admin'
      LIMIT 1
    `);

    if (!existingAdmin.length) {
      await db(
        `
        INSERT INTO users
        (
          username,
          email,
          password_hash,
          is_admin,
          last_seen
        )
        VALUES
        (
          'admin',
          'admin@qamir.ai',
          $1,
          TRUE,
          NOW()
        )
        `,
        [adminHash]
      );

      console.log("Admin account yaratildi.");
    } else {
      await db(
        `
        UPDATE users
        SET
          password_hash = $1,
          is_admin = TRUE,
          last_seen = NOW()
        WHERE username = 'admin'
        `,
        [adminHash]
      );

      console.log("Admin account yangilandi.");
    }
  } else {
    console.log(
      "WARNING: ADMIN_PASSWORD Render Environment'da topilmadi."
    );
  }

  console.log("Database tayyor.");
}

// ================= PASSWORD =================

function hashPassword(password) {
  return crypto
    .createHash("sha256")
    .update(String(password))
    .digest("hex");
}

// ================= USER =================

function safeUser(row) {
  if (!row) return null;

  return {
    id: row.id,
    username: row.username,
    email: row.email,
    is_admin: row.is_admin,
    created_at: row.created_at,
    last_seen: row.last_seen,
  };
}

// ================= AUTH =================

function getBearer(req) {
  const header = req.headers.authorization || "";

  if (header.startsWith("Bearer ")) {
    return header.slice(7);
  }

  return null;
}

async function getUserFromRequest(req) {
  const token = getBearer(req);

  if (!token) {
    return null;
  }

  const userId = Number(token);

  if (!Number.isInteger(userId) || userId <= 0) {
    return null;
  }

  const rows = await db(
    `
    SELECT
      id,
      username,
      email,
      is_admin,
      created_at,
      last_seen
    FROM users
    WHERE id = $1
    LIMIT 1
    `,
    [userId]
  );

  return rows[0] || null;
}

async function requireUser(req, res, next) {
  try {
    const user = await getUserFromRequest(req);

    if (!user) {
      return res.status(401).json({
        error: "Kirish talab qilinadi",
      });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error("AUTH ERROR:", error);

    res.status(500).json({
      error: "Server xatosi",
    });
  }
}

async function requireAdmin(req, res, next) {
  try {
    const user = await getUserFromRequest(req);

    if (!user || !user.is_admin) {
      return res.status(403).json({
        error: "Admin huquqi talab qilinadi",
      });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error("ADMIN AUTH ERROR:", error);

    res.status(500).json({
      error: "Server xatosi",
    });
  }
}

// =====================================================
// GEMINI AI
// ================= GEMINI AI =================

async function askGemini(userText, history = []) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY Render Environment'da sozlanmagan."
    );
  }

  // Database'dan AI sozlamalarini olamiz
  const settingsRows = await db(`
    SELECT
      system_prompt,
      temperature,
      max_tokens,
      model
    FROM settings
    WHERE id = 1
    LIMIT 1
  `);

  const settings = settingsRows[0] || {};

  // Gemini modeli
  const model =
    process.env.GEMINI_MODEL ||
    settings.model ||
    "gemini-2.5-flash";

  const systemPrompt =
    settings.system_prompt ||
    "Siz Qamir AI nomli O'zbek tilida so'zlashuvchi aqlli yordamchisiz. Foydalanuvchiga foydali, xushmuomala va aniq javob bering.";

  console.log("Gemini model:", model);
  console.log(
    "Gemini API key:",
    apiKey ? "configured" : "NOT configured"
  );

  // Suhbat tarixini Gemini formatiga o'tkazamiz
  const contents = [];

  for (const item of history.slice(-20)) {
    const text = String(item.text || "").trim();

    if (!text) continue;

    // Faqat user va assistant xabarlarini yuboramiz
    if (
      item.sender !== "user" &&
      item.sender !== "assistant"
    ) {
      continue;
    }

    contents.push({
      role:
        item.sender === "assistant"
          ? "model"
          : "user",

      parts: [
        {
          text: text,
        },
      ],
    });
  }

  // Hozirgi user xabari
  contents.push({
    role: "user",
    parts: [
      {
        text: String(userText),
      },
    ],
  });

  // MUHIM: Gemini API URL
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) +
    ":generateContent";

  console.log("Gemini URL:", url);

  try {
    const response = await fetch(url, {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },

      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: systemPrompt,
            },
          ],
        },

        contents: contents,

        generationConfig: {
          temperature: Number(
            settings.temperature ?? 0.7
          ),

          maxOutputTokens: Number(
            settings.max_tokens ?? 1024
          ),
        },
      }),
    });

    const data = await response.json();

    console.log(
      "Gemini HTTP status:",
      response.status
    );

    if (!response.ok) {
      console.error(
        "GEMINI ERROR:",
        JSON.stringify(data, null, 2)
      );

      throw new Error(
        data?.error?.message ||
        `Gemini HTTP ${response.status}`
      );
    }

    const answer =
      data?.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || "")
        .join("")
        .trim();

    if (!answer) {
      console.error(
        "Gemini bo'sh javob:",
        JSON.stringify(data, null, 2)
      );

      throw new Error(
        "Gemini bo'sh javob qaytardi."
      );
    }

    return answer;

  } catch (error) {
    console.error(
      "GEMINI REQUEST ERROR:",
      error
    );

    throw error;
  }
}
// =====================================================

async function askGemini(userText, history = []) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY Render Environment'da sozlanmagan."
    );
  }

  const settingsRows = await db(`
    SELECT
      system_prompt,
      temperature,
      max_tokens,
      model
    FROM settings
    WHERE id = 1
    LIMIT 1
  `);

  const settings = settingsRows[0] || {};

  // Ishonchli model
  const model =
    process.env.GEMINI_MODEL ||
    settings.model ||
    "gemini-2.5-flash";

  const systemPrompt =
    settings.system_prompt ||
    "Siz Qamir AI nomli O'zbek tilida so'zlashuvchi aqlli yordamchisiz. Foydalanuvchiga foydali, xushmuomala va aniq javob bering.";

  // ================= HISTORY =================

  const contents = [];

  for (const item of history.slice(-20)) {
    const text = String(item.text || "").trim();

    if (!text) continue;

    // Faqat user va assistant tarixini yuboramiz.
    // Admin xabarlarini user sifatida yubormaymiz.
    let role = "user";

    if (item.sender === "assistant") {
      role = "model";
    } else if (item.sender === "user") {
      role = "user";
    } else {
      continue;
    }

    contents.push({
      role,
      parts: [
        {
          text,
        },
      ],
    });
  }

  // Hozirgi savol
  contents.push({
    role: "user",
    parts: [
      {
        text: String(userText),
      },
    ],
  });

  // ================= GEMINI URL =================
const url =
  "https://generativelanguage.googleapis.com/v1beta/models/" +
  encodeURIComponent(model) +
  ":generateContent";

console.log("Gemini model:", model);

  // ================= REQUEST =================

  const response = await fetch(url, {
    method: "POST",

    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },

    body: JSON.stringify({
      systemInstruction: {
        parts: [
          {
            text: systemPrompt,
          },
        ],
      },

      contents,

      generationConfig: {
        temperature: Number(
          settings.temperature ?? 0.7
        ),

        maxOutputTokens: Number(
          settings.max_tokens ?? 1024
        ),
      },
    }),
  });

  // ================= RESPONSE =================

  const rawText = await response.text();

  let data;

  try {
    data = JSON.parse(rawText);
  } catch {
    console.error(
      "Gemini JSON parse error:",
      rawText
    );

    throw new Error(
      "Gemini serveridan noto'g'ri javob keldi."
    );
  }

  if (!response.ok) {
    console.error(
      "GEMINI HTTP ERROR:",
      response.status,
      JSON.stringify(data)
    );

    throw new Error(
      data?.error?.message ||
        `Gemini HTTP ${response.status}`
    );
  }

  const candidates = data?.candidates || [];

  if (!candidates.length) {
    console.error(
      "Gemini candidates yo'q:",
      JSON.stringify(data)
    );

    throw new Error(
      "Gemini javob qaytarmadi."
    );
  }

  const parts =
    candidates[0]?.content?.parts || [];

  const text = parts
    .map((part) => part?.text || "")
    .join("")
    .trim();

  if (!text) {
    console.error(
      "Gemini bo'sh text qaytardi:",
      JSON.stringify(data)
    );

    throw new Error(
      "Gemini bo'sh javob qaytardi."
    );
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
      gemini: Boolean(
        process.env.GEMINI_API_KEY
      ),
      model:
        process.env.GEMINI_MODEL ||
        "gemini-2.5-flash",
    });
  } catch (error) {
    console.error(
      "HEALTH ERROR:",
      error
    );

    res.status(500).json({
      ok: false,
      database: "error",
      error: error.message,
    });
  }
});

// ================= REGISTER =================

async function registerHandler(req, res) {
  try {
    const {
      username,
      email = "",
      password,
    } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({
        error:
          "Username va parol kerak",
      });
    }

    if (String(password).length < 6) {
      return res.status(400).json({
        error:
          "Parol kamida 6 ta belgidan iborat bo'lsin",
      });
    }

    const cleanUsername =
      String(username).trim();

    if (!cleanUsername) {
      return res.status(400).json({
        error:
          "Username bo'sh bo'lmasin",
      });
    }

    const hash =
      hashPassword(password);

    const rows = await db(
      `
      INSERT INTO users
      (
        username,
        email,
        password_hash,
        last_seen
      )
      VALUES
      (
        $1,
        $2,
        $3,
        NOW()
      )
      RETURNING
        id,
        username,
        email,
        is_admin,
        created_at,
        last_seen
      `,
      [
        cleanUsername,
        String(email).trim(),
        hash,
      ]
    );

    res.status(201).json({
      success: true,
      user: safeUser(rows[0]),
      token: String(rows[0].id),
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        error:
          "Bu username allaqachon mavjud",
      });
    }

    console.error(
      "REGISTER ERROR:",
      error
    );

    res.status(500).json({
      error:
        "Ro'yxatdan o'tishda server xatosi",
    });
  }
}

// ================= LOGIN =================

async function loginHandler(req, res) {
  try {
    const {
      username,
      password,
    } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({
        error:
          "Username va parol kerak",
      });
    }

    const hash =
      hashPassword(password);

    const rows = await db(
      `
      SELECT
        id,
        username,
        email,
        is_admin,
        created_at,
        last_seen
      FROM users
      WHERE username = $1
        AND password_hash = $2
      LIMIT 1
      `,
      [
        String(username).trim(),
        hash,
      ]
    );

    if (!rows.length) {
      return res.status(401).json({
        error:
          "Username yoki parol noto'g'ri",
      });
    }

    await db(
      `
      UPDATE users
      SET last_seen = NOW()
      WHERE id = $1
      `,
      [rows[0].id]
    );

    const freshUser = await db(
      `
      SELECT
        id,
        username,
        email,
        is_admin,
        created_at,
        last_seen
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
      [rows[0].id]
    );

    res.json({
      success: true,
      user: safeUser(
        freshUser[0] || rows[0]
      ),
      token: String(rows[0].id),
    });
  } catch (error) {
    console.error(
      "LOGIN ERROR:",
      error
    );

    res.status(500).json({
      error:
        "Kirishda server xatosi",
    });
  }
}

app.post(
  "/api/auth/register",
  registerHandler
);

app.post(
  "/api/register",
  registerHandler
);

app.post(
  "/api/auth/login",
  loginHandler
);

app.post(
  "/api/login",
  loginHandler
);

// ================= ME =================

app.get(
  "/api/me",
  requireUser,
  async (req, res) => {
    res.json({
      success: true,
      user: safeUser(req.user),
    });
  }
);

// ================= CHAT HISTORY =================

app.get(
  "/api/chat/history",
  requireUser,
  async (req, res) => {
    try {
      const rows = await db(
        `
        SELECT
          id,
          sender,
          text,
          created_at
        FROM messages
        WHERE user_id = $1
        ORDER BY created_at ASC
        LIMIT 200
        `,
        [req.user.id]
      );

      res.json({
        success: true,
        messages: rows,
      });
    } catch (error) {
      console.error(
        "HISTORY ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Suhbat tarixini olishda xato",
      });
    }
  }
);

// ================= CHAT =================

app.post(
  "/api/chat",
  requireUser,
  async (req, res) => {
    try {
      const text = String(
        req.body?.message ||
          req.body?.text ||
          ""
      ).trim();

      if (!text) {
        return res.status(400).json({
          error:
            "Xabar bo'sh",
        });
      }

      // Oldingi chat
      const previous = await db(
        `
        SELECT
          sender,
          text
        FROM messages
        WHERE user_id = $1
        ORDER BY created_at ASC
        LIMIT 40
        `,
        [req.user.id]
      );

      // User xabarini saqlash
      await db(
        `
        INSERT INTO messages
        (
          user_id,
          sender,
          text
        )
        VALUES
        (
          $1,
          'user',
          $2
        )
        `,
        [
          req.user.id,
          text,
        ]
      );

      // Last seen
      await db(
        `
        UPDATE users
        SET last_seen = NOW()
        WHERE id = $1
        `,
        [req.user.id]
      );

      let answer;

      try {
        answer =
          await askGemini(
            text,
            previous
          );
      } catch (aiError) {
        console.error(
          "AI ERROR:",
          aiError
        );

        return res.status(502).json({
          error:
            "AI javobida xato",
          detail:
            aiError.message,
        });
      }

      // AI javobini saqlash
      const saved = await db(
        `
        INSERT INTO messages
        (
          user_id,
          sender,
          text
        )
        VALUES
        (
          $1,
          'assistant',
          $2
        )
        RETURNING
          id,
          sender,
          text,
          created_at
        `,
        [
          req.user.id,
          answer,
        ]
      );

      res.json({
        success: true,
        message: saved[0],
        reply: answer,
      });
    } catch (error) {
      console.error(
        "CHAT ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Xabar yuborishda server xatosi",
      });
    }
  }
);

// ================= ADMIN PAGE =================

app.get(
  "/admin",
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    );
  }
);

// ================= ADMIN USERS =================

app.get(
  "/api/admin/users",
  requireAdmin,
  async (req, res) => {
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
        LEFT JOIN messages m
          ON m.user_id = u.id
        GROUP BY
          u.id,
          u.username,
          u.email,
          u.is_admin,
          u.created_at,
          u.last_seen
        ORDER BY
          u.created_at DESC
      `);

      res.json({
        success: true,
        users: rows,
      });
    } catch (error) {
      console.error(
        "ADMIN USERS ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Foydalanuvchilarni olishda xato",
      });
    }
  }
);

// ================= ADMIN USER CHAT =================

app.get(
  "/api/admin/users/:id/messages",
  requireAdmin,
  async (req, res) => {
    try {
      const userId =
        Number(req.params.id);

      if (
        !Number.isInteger(userId) ||
        userId <= 0
      ) {
        return res.status(400).json({
          error:
            "Noto'g'ri user ID",
        });
      }

      const users = await db(
        `
        SELECT
          id,
          username,
          email,
          is_admin,
          created_at,
          last_seen
        FROM users
        WHERE id = $1
        LIMIT 1
        `,
        [userId]
      );

      if (!users.length) {
        return res.status(404).json({
          error:
            "Foydalanuvchi topilmadi",
        });
      }

      const messages = await db(
        `
        SELECT
          id,
          sender,
          text,
          created_at
        FROM messages
        WHERE user_id = $1
        ORDER BY created_at ASC
        LIMIT 1000
        `,
        [userId]
      );

      res.json({
        success: true,
        user: users[0],
        messages,
      });
    } catch (error) {
      console.error(
        "ADMIN MESSAGES ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Suhbatni olishda xato",
      });
    }
  }
);

// ================= ADMIN REPLY =================

app.post(
  "/api/admin/reply",
  requireAdmin,
  async (req, res) => {
    try {
      const userId =
        Number(req.body?.user_id);

      const text = String(
        req.body?.message ||
          req.body?.text ||
          ""
      ).trim();

      if (
        !Number.isInteger(userId) ||
        userId <= 0 ||
        !text
      ) {
        return res.status(400).json({
          error:
            "user_id va xabar kerak",
        });
      }

      const userExists = await db(
        `
        SELECT id
        FROM users
        WHERE id = $1
        LIMIT 1
        `,
        [userId]
      );

      if (!userExists.length) {
        return res.status(404).json({
          error:
            "Foydalanuvchi topilmadi",
        });
      }

      const rows = await db(
        `
        INSERT INTO messages
        (
          user_id,
          sender,
          text
        )
        VALUES
        (
          $1,
          'admin',
          $2
        )
        RETURNING
          id,
          sender,
          text,
          created_at
        `,
        [
          userId,
          text,
        ]
      );

      res.json({
        success: true,
        message: rows[0],
      });
    } catch (error) {
      console.error(
        "ADMIN REPLY ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Admin xabarini saqlashda xato",
      });
    }
  }
);

// ================= ADMIN SETTINGS =================

app.get(
  "/api/admin/settings",
  requireAdmin,
  async (req, res) => {
    try {
      const rows = await db(`
        SELECT
          id,
          system_prompt,
          temperature,
          max_tokens,
          model,
          updated_at
        FROM settings
        WHERE id = 1
        LIMIT 1
      `);

      res.json({
        success: true,
        settings:
          rows[0] || null,
      });
    } catch (error) {
      console.error(
        "ADMIN SETTINGS GET ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Sozlamalarni olishda xato",
      });
    }
  }
);

app.post(
  "/api/admin/settings",
  requireAdmin,
  async (req, res) => {
    try {
      const {
        system_prompt,
        temperature = 0.7,
        max_tokens = 1024,
        model = "gemini-2.5-flash",
      } = req.body || {};

      await db(
        `
        UPDATE settings
        SET
          system_prompt = $1,
          temperature = $2,
          max_tokens = $3,
          model = $4,
          updated_at = NOW()
        WHERE id = 1
        `,
        [
          String(
            system_prompt ||
              "Siz Qamir AI nomli O'zbek tilida so'zlashuvchi aqlli yordamchisiz."
          ),
          Number(temperature),
          Number(max_tokens),
          String(model),
        ]
      );

      const rows = await db(`
        SELECT
          id,
          system_prompt,
          temperature,
          max_tokens,
          model,
          updated_at
        FROM settings
        WHERE id = 1
        LIMIT 1
      `);

      res.json({
        success: true,
        settings:
          rows[0] || null,
      });
    } catch (error) {
      console.error(
        "ADMIN SETTINGS ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Sozlamalarni saqlashda xato",
      });
    }
  }
);

// ================= FRONTEND =================

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

// Express 5 fallback
app.use((req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
  );
});

// ================= START =================

async function start() {
  try {
    await initDatabase();

    console.log(
      "PostgreSQL: connected"
    );

    console.log(
      "Gemini API key:",
      process.env.GEMINI_API_KEY
        ? "configured"
        : "NOT configured"
    );

    console.log(
      "Gemini model:",
      process.env.GEMINI_MODEL ||
        "gemini-2.5-flash"
    );

    app.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          `Qamir AI server running on port ${PORT}`
        );
      }
    );
  } catch (error) {
    console.error(
      "STARTUP ERROR:",
      error
    );

    process.exit(1);
  }
}

// ================= SHUTDOWN =================

process.on(
  "SIGTERM",
  async () => {
    console.log(
      "SIGTERM received"
    );

    await pool.end();

    process.exit(0);
  }
);

process.on(
  "SIGINT",
  async () => {
    console.log(
      "SIGINT received"
    );

    await pool.end();

    process.exit(0);
  }
);

// ================= RUN =================

start();
