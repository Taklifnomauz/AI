# Qamir AI — GitHub + Render + PostgreSQL

Bu versiya GitHub + Render uchun tayyorlangan. Foydalanuvchilar, xabarlar va AI sozlamalari Render PostgreSQL bazasida saqlanadi.

## Ishlaydigan qismlar

- Foydalanuvchi ro‘yxatdan o‘tishi va login
- Parollar bcrypt bilan hash qilinadi
- Barcha chat xabarlari server bazasida saqlanadi
- Admin panelda foydalanuvchilar ro‘yxati
- Foydalanuvchini tanlab uning to‘liq suhbatini ko‘rish
- Admin foydalanuvchiga xabar yozishi
- Foydalanuvchilar / xabarlar / online statistikasi
- System Prompt, Temperature, Max Tokens va Model serverda saqlanadi
- Groq API server tomonda ishlaydi; API key brauzerga chiqmaydi
- So‘nggi 20 ta xabar AI kontekstiga beriladi
- Qamir AI purple/neon dizayn
- Telegram Mini App `ready()` va `expand()`
- `/health` health-check endpoint
- Render Blueprint (`render.yaml`) web service + PostgreSQL'ni birga yaratishga tayyor

## 1. GitHub

ZIP'ni oching va **QamirAI_Server** ichidagi fayllarni GitHub repository root'iga yuklang:

```text
package.json
server.js
render.yaml
.env.example
.gitignore
README.md
public/index.html
```

`.env` faylni GitHub'ga yuklamang.

## 2. Render

Render Dashboard → **New → Blueprint** orqali repository'ni tanlang. `render.yaml` web service va PostgreSQL bazasini sozlaydi.

Agar Blueprint ishlatmasangiz, qo‘lda Web Service yarating:

- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Health Check: `/health`

Keyin PostgreSQL yarating va `DATABASE_URL` ni web service environment'iga ulang.

## 3. Environment variables

Render'da quyidagilarni kiriting:

```text
ADMIN_USERNAME=admin
ADMIN_PASSWORD=BU_YERGA_KUCHLI_PAROL
GROQ_API_KEY=BU_YERGA_GROQ_KEY
GROQ_MODEL=llama-3.3-70b-versatile
```

`DATABASE_URL` ni Render PostgreSQL'dan oling yoki Blueprint avtomatik ulang.

## 4. Deploy

GitHub'ga push qiling. Render linked branch'dagi o‘zgarishlarni avtomatik deploy qila oladi.

Deploy tugagach:

```text
https://SIZNING-SERVICE-NOMINGIZ.onrender.com
```

Health tekshirish:

```text
https://SIZNING-SERVICE-NOMINGIZ.onrender.com/health
```

`{"ok":true,"database":"connected"}` chiqsa server va baza ulangan.

## 5. Admin

Saytga `ADMIN_USERNAME` va `ADMIN_PASSWORD` bilan kiring.

Admin panelda:

- foydalanuvchilarni ko‘rasiz;
- kim nima yozganini ko‘rasiz;
- suhbatni ochasiz;
- foydalanuvchiga admin sifatida javob yuborasiz;
- AI prompt/model/temperature/tokenlarni o‘zgartirasiz.

## Muhim xavfsizlik

- `.env` ni GitHub'ga yubormang.
- Groq API key'ni `index.html` ga yozmang.
- `ADMIN_PASSWORD` ni Render Environment Variables orqali kiriting.
- Real Telegram Mini App sifatida ishlatish uchun HTTPS Render URL'ini Telegram BotFather'dagi Web App URL sifatida ko‘rsating.
