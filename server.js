// Aguacate AI v4.0.0 - backend
const express = require('express');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const rateLimit = require('express-rate-limit');

const app = express();
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'aguacate-data.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(ROOT));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const AI_BASE_URL = process.env.AI_BASE_URL || 'https://openrouter.ai/api/v1';
const AI_MODEL = process.env.AI_MODEL || 'openrouter/auto';
const MAX_FILE_MB = Math.max(1, Math.min(15, Number(process.env.MAX_FILE_MB || 10)));
const ECO_MAX_LITRES = Number(process.env.ECOGUACATE_MAX_LITRES || 100);
const ONLINE_TIMEOUT_MS = 90 * 1000;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY, baseURL: AI_BASE_URL }) : null;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_MB * 1024 * 1024 } });

const DEFAULT_DATA = { users: {}, conversations: {}, memories: {}, adminLogs: [] };
let data = loadData();

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return { ...DEFAULT_DATA, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
  } catch (e) { console.error('[data] lecture impossible:', e.message); }
  return JSON.parse(JSON.stringify(DEFAULT_DATA));
}
function saveData() {
  try {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) { console.error('[data] sauvegarde impossible:', e.message); }
}
function now() { return Date.now(); }
function genToken() { return crypto.randomBytes(32).toString('hex'); }
function genUserId() {
  let id;
  do id = String(Math.floor(1000 + Math.random() * 9000)); while (Object.values(data.users).some(u => u.id === id));
  return id;
}
function safeText(v, max = 30000) { return typeof v === 'string' ? v.slice(0, max) : ''; }
function hashPassword(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
function passwordMatches(provided, configured) {
  if (!configured || !provided) return false;
  return crypto.timingSafeEqual(Buffer.from(hashPassword(provided)), Buffer.from(hashPassword(configured)));
}
function userRecord(id) {
  if (!data.users[id]) {
    data.users[id] = { id, role: 'user', warnings: [], bannedUntil: 0, connected: false, lastSeen: 0, token: genToken(), sessionVersion: 1, consumptionLitres: 0, createdAt: now() };
    saveData();
  }
  return data.users[id];
}
function publicUser(u) {
  const { token, ...safe } = u;
  return { ...safe, online: isOnline(u) };
}
function isOnline(u) {
  return !!u.connected && !!u.lastSeen && now() - u.lastSeen < ONLINE_TIMEOUT_MS && !isBanned(u);
}
function isBanned(u) { return Number(u.bannedUntil || 0) > now(); }
function banFor24h(u, reason, by = 'system') {
  u.bannedUntil = now() + 24 * 60 * 60 * 1000;
  u.connected = false;
  u.sessionVersion = (u.sessionVersion || 1) + 1;
  u.token = genToken();
  data.adminLogs.push({ type: 'ban', reason, user: u.id, by, date: now(), until: u.bannedUntil });
  saveData();
}
function addWarning(u, reason, by = 'admin') {
  const item = { id: crypto.randomBytes(5).toString('hex'), reason: safeText(reason, 300), date: now(), by };
  if (!Array.isArray(u.warnings)) u.warnings = [];
  u.warnings.push(item);
  if (u.warnings.length >= 3) banFor24h(u, `Avertissement n°${u.warnings.length}`, by);
  data.adminLogs.push({ type: 'warning', user: u.id, by, reason: item.reason, warningNumber: u.warnings.length, date: item.date });
  saveData();
  return item;
}
function removeWarning(u, warningId) {
  const before = Array.isArray(u.warnings) ? u.warnings.length : 0;
  u.warnings = (u.warnings || []).filter(w => w.id !== warningId);
  if (before !== u.warnings.length) {
    if (!isBanned(u)) u.bannedUntil = 0;
    data.adminLogs.push({ type: 'warning-removed', user: u.id, warningId, date: now() });
    saveData();
    return true;
  }
  return false;
}
function getUserFromRequest(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.token || req.body?.token);
  if (!token) return null;
  return Object.values(data.users).find(u => u.token === token) || null;
}
function ensureAuth(req, res, next) {
  const u = getUserFromRequest(req);
  if (!u) return res.status(401).json({ ok: false, error: 'unauthenticated' });
  if (isBanned(u)) return res.status(403).json({ ok: false, error: 'banned', bannedUntil: u.bannedUntil });
  if (!isOnline(u)) u.connected = true;
  u.lastSeen = now();
  req.authUser = u;
  next();
}
function ensureAdmin(req, res, next) {
  ensureAuth(req, res, () => {
    if (req.authUser.role !== 'admin') return res.status(403).json({ ok: false, error: 'forbidden' });
    next();
  });
}
function ensureProfessor(req, res, next) {
  ensureAuth(req, res, () => {
    if (!['professeur', 'admin'].includes(req.authUser.role)) return res.status(403).json({ ok: false, error: 'forbidden' });
    next();
  });
}

function resetDailyConsumption() {
  Object.values(data.users).forEach(u => { u.consumptionLitres = 0; });
  data.adminLogs.push({ type: 'reset-consumption', date: now() });
  saveData();
}
function scheduleReset() {
  const d = new Date();
  const next = new Date(d); next.setHours(24, 0, 0, 0);
  setTimeout(() => { resetDailyConsumption(); setInterval(resetDailyConsumption, 86400000); }, Math.max(1000, next - d + 1000));
}
scheduleReset();
setInterval(() => { Object.values(data.users).forEach(u => { if (u.connected && now() - u.lastSeen > ONLINE_TIMEOUT_MS) u.connected = false; }); saveData(); }, 30000);

const chatLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

// Moderation: keep the list server-side and extend it as needed.
const GROSS_WORD_PATTERNS = [
  /\b(?:putain|merde|connard|connasse|encule|enculé|salope|fdp|nique|niquer)\b/i,
  /\b(?:fuck|shit|bitch|asshole)\b/i
];
function containsGrossLanguage(text) { return GROSS_WORD_PATTERNS.some(re => re.test(text)); }

app.get('/health', (req, res) => res.json({ ok: true, version: '4.0.0', ai: !!openai }));

app.post('/login', (req, res) => {
  const requested = String(req.body.deviceId || '').slice(0, 64);
  const id = requested && data.users[requested] ? requested : (requested || genUserId());
  const u = userRecord(id);
  if (isBanned(u)) return res.status(403).json({ ok: false, error: 'banned', bannedUntil: u.bannedUntil });
  u.connected = true;
  u.lastSeen = now();
  u.token = genToken();
  u.sessionVersion = (u.sessionVersion || 1) + 1;
  data.adminLogs.push({ type: 'login', user: u.id, date: now() });
  saveData();
  res.json({ ok: true, id: u.id, role: u.role, token: u.token, consumptionLitres: u.consumptionLitres || 0, version: '4.0.0' });
});
app.post('/heartbeat', ensureAuth, (req, res) => { req.authUser.connected = true; req.authUser.lastSeen = now(); saveData(); res.json({ ok: true, online: true }); });
app.post('/logout', ensureAuth, (req, res) => { req.authUser.connected = false; req.authUser.lastSeen = now(); saveData(); res.json({ ok: true }); });

app.post('/modes/verify', ensureAuth, (req, res) => {
  const mode = safeText(req.body.mode, 30), password = String(req.body.password || '');
  const u = req.authUser;
  if (mode === 'Professeur' && passwordMatches(password, process.env.PROFESSOR_PASSWORD)) { u.role = 'professeur'; saveData(); return res.json({ ok: true, role: u.role }); }
  if (mode === 'Admin' && passwordMatches(password, process.env.ADMIN_PASSWORD)) { u.role = 'admin'; saveData(); return res.json({ ok: true, role: u.role }); }
  return res.status(401).json({ ok: false, error: 'invalid-password' });
});

app.get('/users', ensureAdmin, (req, res) => res.json(Object.values(data.users).map(publicUser).sort((a,b) => Number(b.lastSeen||0) - Number(a.lastSeen||0))));
app.get('/users/online', ensureAdmin, (req, res) => res.json(Object.values(data.users).filter(isOnline).map(publicUser)));
app.get('/users/recent', ensureAdmin, (req, res) => res.json(Object.values(data.users).filter(u => u.lastSeen && now() - u.lastSeen <= RECENT_WINDOW_MS).map(publicUser).sort((a,b) => b.lastSeen - a.lastSeen)));
app.post('/users/:id/disconnect', ensureAdmin, (req, res) => {
  const u = data.users[String(req.params.id)]; if (!u) return res.status(404).json({ ok:false, error:'not-found' });
  u.connected = false; u.lastSeen = now(); u.sessionVersion = (u.sessionVersion || 1) + 1; u.token = genToken();
  data.adminLogs.push({ type:'disconnect', user:u.id, by:req.authUser.id, date:now() }); saveData();
  res.json({ ok:true });
});
app.post('/users/:id/ban', ensureAdmin, (req,res) => { const u=data.users[String(req.params.id)]; if(!u)return res.status(404).json({ok:false,error:'not-found'}); banFor24h(u, safeText(req.body.reason||'Bannissement manuel',300), req.authUser.id); res.json({ok:true,bannedUntil:u.bannedUntil}); });
app.post('/users/:id/unban', ensureAdmin, (req,res) => { const u=data.users[String(req.params.id)]; if(!u)return res.status(404).json({ok:false,error:'not-found'}); u.bannedUntil=0; data.adminLogs.push({type:'unban',user:u.id,by:req.authUser.id,date:now()}); saveData(); res.json({ok:true}); });
app.post('/users/:id/warnings', ensureAdmin, (req,res) => { const u=data.users[String(req.params.id)]; if(!u)return res.status(404).json({ok:false,error:'not-found'}); const w=addWarning(u, req.body.reason || 'Avertissement administrateur', req.authUser.id); res.json({ok:true,warning:w,warnings:u.warnings,bannedUntil:u.bannedUntil||0}); });
app.delete('/users/:id/warnings/:warningId', ensureAdmin, (req,res) => { const u=data.users[String(req.params.id)]; if(!u)return res.status(404).json({ok:false,error:'not-found'}); const ok=removeWarning(u,String(req.params.warningId)); res.json({ok}); });
app.get('/adminlogs', ensureAdmin, (req,res) => res.json(data.adminLogs.slice(-500).reverse()));

app.get('/admin/conversations', ensureAdmin, (req,res) => {
  const result = Object.entries(data.conversations).map(([userId, list]) => ({ userId, conversations:list })).filter(x => x.conversations.length);
  res.json(result);
});
app.get('/admin/conversations/:userId', ensureAdmin, (req,res) => res.json(data.conversations[String(req.params.userId)] || []));

app.post('/newConversation', ensureAuth, (req,res) => {
  const user=req.authUser.id, id=Date.now().toString(36)+crypto.randomBytes(3).toString('hex');
  if(!data.conversations[user]) data.conversations[user]=[];
  data.conversations[user].push({id,title:'Nouvelle conversation',messages:[],createdAt:now(),updatedAt:now()}); saveData();
  res.json({ok:true,id,conversations:data.conversations[user]});
});
app.get('/conversations', ensureAuth, (req,res) => res.json(data.conversations[req.authUser.id] || []));
app.post('/renameConversation', ensureAuth, (req,res) => {
  const user=req.authUser.id,id=String(req.body.conversationId||''),title=safeText(req.body.title||'Nouvelle conversation',80).trim();
  const c=(data.conversations[user]||[]).find(x=>x.id===id); if(!c)return res.status(404).json({ok:false,error:'not-found'});
  c.title=title||'Nouvelle conversation';c.updatedAt=now();saveData();res.json({ok:true,conversation:c});
});
app.post('/deleteConversation', ensureAuth, (req,res) => { const user=req.authUser.id,id=String(req.body.conversationId||'');data.conversations[user]=(data.conversations[user]||[]).filter(c=>c.id!==id);saveData();res.json({ok:true,conversations:data.conversations[user]}); });

async function askAI(messages) {
  if (!openai) throw new Error('OPENAI_API_KEY manquante');
  const response=await openai.chat.completions.create({model:AI_MODEL,messages});
  return response.choices?.[0]?.message?.content || '🥑 Je n’ai pas reçu de réponse.';
}
function moderationHit(u, message) {
  if (!containsGrossLanguage(message)) return null;
  const warning = addWarning(u, 'Langage grossier détecté automatiquement', 'system');
  const warningNumber = u.warnings.length;
  if (warningNumber >= 3) {
    banFor24h(u, 'Troisième avertissement ou plus', 'system');
    return { banned: true, warning, warningNumber };
  }
  saveData();
  return { banned: false, warning, warningNumber };
}

app.post('/chat', chatLimiter, ensureAuth, async (req,res) => {
  try {
    const u=req.authUser,message=safeText(req.body.message).trim(),mode=safeText(req.body.mode)||'Kids';
    if(!message)return res.status(400).json({ok:false,error:'empty-message'});
    const moderation = moderationHit(u,message);
    if (moderation?.banned) return res.status(403).json({ok:false,error:'banned',bannedUntil:u.bannedUntil,message:'Ton message contient un langage interdit. Ton accès est suspendu pendant 24 heures.'});
    if (moderation) return res.status(400).json({ok:false,error:'warning',warningNumber:moderation.warningNumber,message:moderation.warningNumber===1?'⚠️ Avertissement sérieux : merci de respecter les règles.':'⚠️ Deuxième avertissement : un nouveau message interdit entraînera un bannissement de 24 heures.'});
    if(!data.memories[u.id])data.memories[u.id]=[];
    const system=mode==='Kids'?'Tu es Aguacate AI. Explique avec des mots simples, adaptés à un enfant, sans être infantilisant.':mode==='Collégien'?'Tu es Aguacate AI, un assistant pédagogique pour collégien. Explique clairement et aide à raisonner.':mode==='Professeur'?'Tu es Aguacate AI, assistant pédagogique pour enseignants. Sois structuré et précis.':'Tu es Aguacate AI, assistant polyvalent.';
    data.memories[u.id].push({role:'user',content:message});
    const reply=await askAI([{role:'system',content:system},...data.memories[u.id].slice(-16)]);
    data.memories[u.id].push({role:'assistant',content:reply});
    if(!data.conversations[u.id])data.conversations[u.id]=[];
    if(!data.conversations[u.id].length)data.conversations[u.id].push({id:Date.now().toString(36),title:'Conversation',messages:[],createdAt:now(),updatedAt:now()});
    const c=data.conversations[u.id][data.conversations[u.id].length-1];
    c.messages.push({role:'user',content:message,date:now()},{role:'assistant',content:reply,date:now()});c.updatedAt=now();
    u.consumptionLitres=Number(((u.consumptionLitres||0)+(1+Math.floor(reply.length/200))).toFixed(1));u.lastSeen=now();u.connected=true;saveData();
    res.json({ok:true,reply,consumptionLitres:u.consumptionLitres,ecoMaxLitres:ECO_MAX_LITRES});
  } catch(e){console.error('[chat]',e);res.status(500).json({ok:false,error:'ai-error',message:'🥑 Impossible de contacter l’IA. Vérifie la clé API et le modèle configurés dans Render.'});}
});

function extractText(file){
  const ext=path.extname(file.originalname).toLowerCase();
  if(['.txt','.md','.csv','.json','.xml'].includes(ext))return Promise.resolve(file.buffer.toString('utf8').slice(0,50000));
  if(ext==='.pdf')return pdfParse(file.buffer).then(r=>r.text.slice(0,50000));
  if(ext==='.docx')return mammoth.extractRawText({buffer:file.buffer}).then(r=>r.value.slice(0,50000));
  if(['.xlsx','.xls'].includes(ext)){const wb=XLSX.read(file.buffer,{type:'buffer'});return Promise.resolve(wb.SheetNames.map(n=>`[${n}]\n${XLSX.utils.sheet_to_csv(wb.Sheets[n])}`).join('\n\n').slice(0,50000));}
  return Promise.reject(new Error('unsupported-type'));
}
const ALLOWED_EXT=['.pdf','.docx','.txt','.md','.csv','.json','.xml','.xlsx','.xls'];
app.post('/scan', ensureAuth, upload.single('file'), async (req,res)=>{try{if(!req.file)return res.status(400).json({ok:false,error:'no-file'});const ext=path.extname(req.file.originalname).toLowerCase();if(!ALLOWED_EXT.includes(ext))return res.status(415).json({ok:false,error:'unsupported-type'});const text=await extractText(req.file);res.json({ok:true,fileName:req.file.originalname,fileType:ext.slice(1),characters:text.length,text});}catch(e){console.error('[scan]',e);res.status(500).json({ok:false,error:'scan-error',message:'Impossible de lire ce fichier.'});}});
app.post('/scan-and-ask', chatLimiter, ensureAuth, upload.single('file'), async (req,res)=>{try{if(!req.file)return res.status(400).json({ok:false,error:'no-file'});const ext=path.extname(req.file.originalname).toLowerCase();if(!ALLOWED_EXT.includes(ext))return res.status(415).json({ok:false,error:'unsupported-type'});const text=await extractText(req.file);const question=safeText(req.body.question||'Analyse ce fichier et résume les points importants.');const reply=await askAI([{role:'system',content:'Tu es Aguacate AI. Analyse uniquement le contenu fourni et réponds clairement en français.'},{role:'user',content:`Fichier: ${req.file.originalname}\n\nContenu:\n${text}\n\nQuestion:\n${question}`}]);req.authUser.consumptionLitres=Number(((req.authUser.consumptionLitres||0)+(1+Math.floor(reply.length/200))).toFixed(1));req.authUser.lastSeen=now();req.authUser.connected=true;if(!data.conversations[req.authUser.id])data.conversations[req.authUser.id]=[];if(!data.conversations[req.authUser.id].length)data.conversations[req.authUser.id].push({id:Date.now().toString(36),title:'Conversation',messages:[],createdAt:now(),updatedAt:now()});const c=data.conversations[req.authUser.id].at(-1);c.messages.push({role:'user',content:`📎 ${req.file.originalname}\n${question}`,date:now()},{role:'assistant',content:reply,date:now()});c.updatedAt=now();saveData();res.json({ok:true,reply,fileName:req.file.originalname,characters:text.length,consumptionLitres:req.authUser.consumptionLitres,ecoMaxLitres:ECO_MAX_LITRES});}catch(e){console.error('[scan-and-ask]',e);res.status(500).json({ok:false,error:'scan-ai-error',message:'Le fichier a été lu mais l’analyse IA a échoué. Vérifie la configuration IA.'});}});

const RESET_SECRET=process.env.RESET_SECRET||'';
app.post('/internal/reset-consumption',(req,res)=>{const provided=req.headers['x-admin-secret']||req.query.secret;if(!RESET_SECRET||provided!==RESET_SECRET)return res.status(403).json({ok:false,error:'forbidden'});resetDailyConsumption();res.json({ok:true});});
app.get('*',(req,res)=>res.sendFile(path.join(ROOT,'index.html')));
module.exports=app;

const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] Aguacate AI Mobile v4.0.0 écoute sur le port ${PORT}`);
});
