# Qamir AI

Standalone AI website, Telegram Mini App emas.

Features:
- Register/login/logout
- Profile: photo, full name, email, birth date, birth year, location
- Password change
- Gemini chat and PostgreSQL history
- Separate Agent/Admin login
- Agent sees clients and their conversations
- Agent can reply to clients
- Agent can change Gemini system prompt, model, temperature and max tokens

Render variables:
DATABASE_URL = Render PostgreSQL Internal Database URL
GEMINI_API_KEY = Gemini API key (GitHubga yozmang)
GEMINI_MODEL = gemini-2.5-flash
ADMIN_PASSWORD = Agent paroli
NODE_ENV = production

Deploy:
1. ZIP ichidagi fayllarni GitHub repositoryga yuklang.
2. Render New Web Service orqali repo ulang.
3. Build: npm install
4. Start: npm start
5. PostgreSQL yarating va DATABASE_URL ulang.
6. Environment Variables ni kiriting.
7. Deploy.

Agent: /admin yoki oddiy login oynasida username "admin" va ADMIN_PASSWORD bilan kiradi.
