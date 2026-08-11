require("dotenv").config();
const express=require("express"),path=require("path"),crypto=require("crypto"),{Pool}=require("pg");
const app=express(),PORT=Number(process.env.PORT)||10000;
app.use(express.json({limit:"4mb"})); app.use(express.urlencoded({extended:true,limit:"4mb"}));
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.NODE_ENV==="production"?{rejectUnauthorized:false}:false});
const db=async(q,p=[])=> (await pool.query(q,p)).rows;
const hash=v=>crypto.createHash("sha256").update(String(v)).digest("hex");
const token=()=>crypto.randomBytes(32).toString("hex");
const safe=u=>u&&({id:u.id,username:u.username,email:u.email||"",is_admin:!!u.is_admin,full_name:u.full_name||"",birth_date:u.birth_date||null,birth_year:u.birth_year||null,location:u.location||"",avatar:u.avatar||null,created_at:u.created_at,last_seen:u.last_seen});
async function init(){
 await db(`CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY,username TEXT UNIQUE NOT NULL,email TEXT DEFAULT '',password_hash TEXT NOT NULL,is_admin BOOLEAN NOT NULL DEFAULT FALSE,full_name TEXT DEFAULT '',birth_date DATE,birth_year INTEGER,location TEXT DEFAULT '',avatar TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),last_seen TIMESTAMPTZ)`);
 for(const q of [
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT DEFAULT ''`,`ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_date DATE`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_year INTEGER`,`ALTER TABLE users ADD COLUMN IF NOT EXISTS location TEXT DEFAULT ''`,`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT`
 ]) await db(q);
 await db(`CREATE TABLE IF NOT EXISTS messages(id SERIAL PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,sender TEXT NOT NULL CHECK(sender IN ('user','assistant','admin')),text TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
 await db(`CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY,system_prompt TEXT,temperature NUMERIC DEFAULT .7,max_tokens INTEGER DEFAULT 2048,model TEXT DEFAULT 'gemini-2.5-flash',updated_at TIMESTAMPTZ DEFAULT NOW())`);
 await db(`CREATE TABLE IF NOT EXISTS sessions(id SERIAL PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,token_hash TEXT UNIQUE NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW(),expires_at TIMESTAMPTZ NOT NULL)`);
 const prompt="Siz Qamir AI nomli aqlli yordamchisiz. Foydalanuvchiga foydali, xushmuomala va aniq javob bering. Asosan o'zbek tilida javob bering.";
 await db(`INSERT INTO settings(id,system_prompt,temperature,max_tokens,model) VALUES(1,$1,.7,2048,'gemini-2.5-flash') ON CONFLICT(id) DO NOTHING`,[prompt]);
 if(process.env.ADMIN_PASSWORD){
  const h=hash(process.env.ADMIN_PASSWORD), a=await db(`SELECT id FROM users WHERE username='admin' LIMIT 1`);
  if(!a.length) await db(`INSERT INTO users(username,email,password_hash,is_admin,full_name,last_seen) VALUES('admin','admin@qamir.ai',$1,TRUE,'Qamir AI Agent',NOW())`,[h]);
  else await db(`UPDATE users SET password_hash=$1,is_admin=TRUE,last_seen=NOW() WHERE username='admin'`,[h]);
 } else console.warn("ADMIN_PASSWORD yo'q");
}
function bearer(req){const h=req.headers.authorization||"";return h.startsWith("Bearer ")?h.slice(7):null}
async function current(req){const t=bearer(req);if(!t)return null;return (await db(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW() LIMIT 1`,[hash(t)]))[0]||null}
async function auth(req,res,next){try{req.user=await current(req);if(!req.user)return res.status(401).json({error:"Kirish talab qilinadi."});next()}catch(e){res.status(500).json({error:"Server xatosi."})}}
async function admin(req,res,next){try{req.user=await current(req);if(!req.user||!req.user.is_admin)return res.status(403).json({error:"Agent huquqi talab qilinadi."});next()}catch(e){res.status(500).json({error:"Server xatosi."})}}
async function session(uid){const t=token();await db(`INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,NOW()+INTERVAL '30 days')`,[uid,hash(t)]);return t}
async function gemini(text,hist=[]){
 const key=process.env.GEMINI_API_KEY;if(!key)throw Error("GEMINI_API_KEY Render Environment'da sozlanmagan.");
 const s=(await db(`SELECT system_prompt,temperature,max_tokens,model FROM settings WHERE id=1`))[0]||{};
 const model=String(process.env.GEMINI_MODEL||s.model||"gemini-2.5-flash").replace(/^models\//,"");
 const contents=hist.slice(-30).filter(x=>x.text&&(x.sender==="user"||x.sender==="assistant")).map(x=>({role:x.sender==="assistant"?"model":"user",parts:[{text:String(x.text)}]}));
 contents.push({role:"user",parts:[{text:String(text)}]});
 const url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
 const r=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json","x-goog-api-key":key},body:JSON.stringify({
  systemInstruction:{parts:[{text:s.system_prompt||"Siz Qamir AI yordamchisisiz."}]},contents,
  generationConfig:{temperature:Number(s.temperature??.7),maxOutputTokens:Number(s.max_tokens??2048)}
 })});
 const raw=await r.text();let d;try{d=JSON.parse(raw)}catch{throw Error("Gemini noto'g'ri JSON qaytardi.")}
 if(!r.ok)throw Error(d?.error?.message||`Gemini HTTP ${r.status}`);
 const out=(d?.candidates?.[0]?.content?.parts||[]).map(x=>x?.text||"").join("").trim();
 if(!out)throw Error("Gemini bo'sh javob qaytardi."); return out;
}
app.get("/health",async(req,res)=>{try{await db("SELECT 1");res.json({ok:true,database:"connected",gemini:!!process.env.GEMINI_API_KEY,model:process.env.GEMINI_MODEL||"gemini-2.5-flash"})}catch(e){res.status(500).json({ok:false,error:e.message})}});
app.post("/api/auth/register",async(req,res)=>{try{const u=String(req.body?.username||"").trim(),email=String(req.body?.email||"").trim(),p=String(req.body?.password||"");if(u.length<3||p.length<6)return res.status(400).json({error:"Username 3+, parol 6+ belgi bo'lsin."});const r=await db(`INSERT INTO users(username,email,password_hash,last_seen) VALUES($1,$2,$3,NOW()) RETURNING *`,[u,email,hash(p)]);res.status(201).json({success:true,token:await session(r[0].id),user:safe(r[0])})}catch(e){if(e.code==="23505")return res.status(409).json({error:"Bu username mavjud."});console.error(e);res.status(500).json({error:"Ro'yxatdan o'tishda xato."})}});
app.post("/api/auth/login",async(req,res)=>{try{const u=String(req.body?.username||"").trim(),p=String(req.body?.password||"");const r=await db(`SELECT * FROM users WHERE username=$1 AND password_hash=$2 LIMIT 1`,[u,hash(p)]);if(!r.length)return res.status(401).json({error:"Username yoki parol noto'g'ri."});await db(`UPDATE users SET last_seen=NOW() WHERE id=$1`,[r[0].id]);res.json({success:true,token:await session(r[0].id),user:safe(r[0])})}catch(e){res.status(500).json({error:"Kirishda server xatosi."})}});
app.post("/api/auth/logout",auth,async(req,res)=>{const t=bearer(req);if(t)await db(`DELETE FROM sessions WHERE token_hash=$1`,[hash(t)]);res.json({success:true})});
app.get("/api/me",auth,(req,res)=>res.json({success:true,user:safe(req.user)}));
app.put("/api/profile",auth,async(req,res)=>{try{const n=String(req.body?.full_name||""),email=String(req.body?.email||""),bd=req.body?.birth_date?String(req.body.birth_date):null,by=req.body?.birth_year?Number(req.body.birth_year):null,loc=String(req.body?.location||""),av=req.body?.avatar?String(req.body.avatar):null;if(av&&av.length>2800000)return res.status(400).json({error:"Rasm 2 MB dan kichik bo'lsin."});const r=await db(`UPDATE users SET full_name=$1,email=$2,birth_date=$3,birth_year=$4,location=$5,avatar=COALESCE($6,avatar),last_seen=NOW() WHERE id=$7 RETURNING *`,[n,email,bd,by,loc,av,req.user.id]);res.json({success:true,user:safe(r[0])})}catch(e){console.error(e);res.status(500).json({error:"Profilni saqlashda xato."})}});
app.post("/api/profile/password",auth,async(req,res)=>{try{const oldp=String(req.body?.old_password||""),newp=String(req.body?.new_password||"");if(newp.length<6)return res.status(400).json({error:"Yangi parol 6+ belgi bo'lsin."});const c=await db(`SELECT id FROM users WHERE id=$1 AND password_hash=$2`,[req.user.id,hash(oldp)]);if(!c.length)return res.status(400).json({error:"Eski parol noto'g'ri."});await db(`UPDATE users SET password_hash=$1 WHERE id=$2`,[hash(newp),req.user.id]);await db(`DELETE FROM sessions WHERE user_id=$1`,[req.user.id]);res.json({success:true,token:await session(req.user.id)})}catch(e){res.status(500).json({error:"Parolni o'zgartirishda xato."})}});
app.get("/api/chat/history",auth,async(req,res)=>{try{res.json({success:true,messages:await db(`SELECT id,sender,text,created_at FROM messages WHERE user_id=$1 ORDER BY created_at ASC LIMIT 300`,[req.user.id])})}catch(e){res.status(500).json({error:"Tarixni olishda xato."})}});
app.post("/api/chat",auth,async(req,res)=>{try{const text=String(req.body?.message||"").trim();if(!text)return res.status(400).json({error:"Xabar bo'sh."});const hist=await db(`SELECT sender,text FROM messages WHERE user_id=$1 ORDER BY created_at ASC LIMIT 60`,[req.user.id]);await db(`INSERT INTO messages(user_id,sender,text) VALUES($1,'user',$2)`,[req.user.id,text]);let answer;try{answer=await gemini(text,hist)}catch(e){console.error("GEMINI",e);return res.status(502).json({error:"AI javobida xato.",detail:e.message})}const r=await db(`INSERT INTO messages(user_id,sender,text) VALUES($1,'assistant',$2) RETURNING id,sender,text,created_at`,[req.user.id,answer]);res.json({success:true,message:r[0],reply:answer})}catch(e){console.error(e);res.status(500).json({error:"Xabar yuborishda xato."})}});
app.get("/api/admin/users",admin,async(req,res)=>{try{res.json({success:true,users:await db(`SELECT u.id,u.username,u.email,u.is_admin,u.full_name,u.birth_date,u.birth_year,u.location,u.avatar,u.created_at,u.last_seen,COUNT(m.id)::int message_count FROM users u LEFT JOIN messages m ON m.user_id=u.id GROUP BY u.id ORDER BY u.created_at DESC`)})}catch(e){res.status(500).json({error:"Mijozlarni olishda xato."})}});
app.get("/api/admin/users/:id/messages",admin,async(req,res)=>{try{const id=Number(req.params.id),u=(await db(`SELECT * FROM users WHERE id=$1`,[id]))[0];if(!u)return res.status(404).json({error:"Mijoz topilmadi."});res.json({success:true,user:safe(u),messages:await db(`SELECT id,sender,text,created_at FROM messages WHERE user_id=$1 ORDER BY created_at ASC LIMIT 2000`,[id])})}catch(e){res.status(500).json({error:"Suhbatni olishda xato."})}});
app.post("/api/admin/reply",admin,async(req,res)=>{try{const id=Number(req.body?.user_id),text=String(req.body?.message||"").trim();if(!id||!text)return res.status(400).json({error:"Mijoz va xabar kerak."});const r=await db(`INSERT INTO messages(user_id,sender,text) VALUES($1,'admin',$2) RETURNING id,sender,text,created_at`,[id,text]);res.json({success:true,message:r[0]})}catch(e){res.status(500).json({error:"Agent xabarida xato."})}});
app.get("/api/admin/settings",admin,async(req,res)=>res.json({success:true,settings:(await db(`SELECT * FROM settings WHERE id=1`))[0]}));
app.put("/api/admin/settings",admin,async(req,res)=>{try{const p=String(req.body?.system_prompt||"").trim(),t=Number(req.body?.temperature??.7),mt=Number(req.body?.max_tokens??2048),m=String(req.body?.model||"gemini-2.5-flash").replace(/^models\//,"");if(!p)return res.status(400).json({error:"System prompt bo'sh."});const r=await db(`UPDATE settings SET system_prompt=$1,temperature=$2,max_tokens=$3,model=$4,updated_at=NOW() WHERE id=1 RETURNING *`,[p,t,mt,m]);res.json({success:true,settings:r[0]})}catch(e){res.status(500).json({error:"Sozlamani saqlashda xato."})}});
app.use(express.static(path.join(__dirname,"public")));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
(async()=>{try{await init();app.listen(PORT,"0.0.0.0",()=>console.log("Qamir AI running on",PORT))}catch(e){console.error("STARTUP",e);process.exit(1)}})();
