const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Data directory (use /tmp for cloud deployment or local data dir)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// Middleware
app.use(express.json({ limit: '5mb' }));

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Initialize database
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({ users: {}, sessions: {} }, null, 2));
}

// ===== Helper Functions =====
function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { return { users: {}, sessions: {} }; }
}
function writeDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
function hashPassword(pwd) { return crypto.createHash('sha256').update(pwd + '_fire_salt_2026').digest('hex'); }
function generateToken() { return crypto.randomBytes(32).toString('hex'); }

// Clean expired sessions (>30 days)
function cleanSessions(db) {
  const now = Date.now();
  const expiry = 30 * 24 * 60 * 60 * 1000;
  for (const token in db.sessions) {
    if (now - db.sessions[token].createdAt > expiry) delete db.sessions[token];
  }
}

// Auth middleware
function requireAuth(req, res, next) {
  const token = (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '请先登录' });
  const db = readDB();
  cleanSessions(db);
  const session = db.sessions[token];
  if (!session) return res.status(401).json({ error: '登录已过期，请重新登录' });
  req.username = session.username;
  req.token = token;
  writeDB(db);
  next();
}

// ===== API Endpoints =====

app.post('/api/auth/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
  if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名需要2-20个字符' });
  if (/[^a-zA-Z0-9_\u4e00-\u9fa5]/.test(username)) return res.status(400).json({ error: '用户名只能含中文、字母、数字、下划线' });
  if (password.length < 4) return res.status(400).json({ error: '密码至少4位' });
  const db = readDB();
  if (db.users[username]) return res.status(400).json({ error: '该用户名已被注册' });
  db.users[username] = {
    password: hashPassword(password), partner: null,
    records: [], netAssets: { deposit: 0, investments: [], lastUpdate: '' },
    config: { inflationRate: 0.03, returnRate: 0.07 }
  };
  const token = generateToken();
  db.sessions[token] = { username, createdAt: Date.now() };
  writeDB(db);
  res.json({ success: true, token, username, inviteCode: username });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
  const db = readDB();
  const user = db.users[username];
  if (!user || user.password !== hashPassword(password)) return res.status(400).json({ error: '用户名或密码错误' });
  const token = generateToken();
  db.sessions[token] = { username, createdAt: Date.now() };
  writeDB(db);
  res.json({ success: true, token, username, inviteCode: username, partner: user.partner });
});

app.get('/api/sync', requireAuth, (req, res) => {
  const db = readDB();
  const user = db.users[req.username];
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json({ success: true, records: user.records || [], netAssets: user.netAssets || { deposit: 0, investments: [], lastUpdate: '' }, config: user.config || { inflationRate: 0.03, returnRate: 0.07 }, partner: user.partner || null });
});

app.post('/api/sync', requireAuth, (req, res) => {
  const { records, netAssets, config } = req.body;
  const db = readDB();
  const user = db.users[req.username];
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (records) user.records = records;
  if (netAssets) user.netAssets = netAssets;
  if (config) user.config = config;
  writeDB(db);
  res.json({ success: true });
});

app.post('/api/bind', requireAuth, (req, res) => {
  const { partnerCode } = req.body;
  if (!partnerCode) return res.status(400).json({ error: '请输入对方的邀请码' });
  const db = readDB();
  if (!db.users[partnerCode]) return res.status(400).json({ error: '该邀请码不存在，请确认对方已注册' });
  if (partnerCode === req.username) return res.status(400).json({ error: '不能绑定自己' });
  const user = db.users[req.username];
  if (user.partner) return res.status(400).json({ error: '你已经绑定了 ' + user.partner + '，请先解绑' });
  const partnerUser = db.users[partnerCode];
  if (partnerUser.partner && partnerUser.partner !== req.username) return res.status(400).json({ error: partnerCode + ' 已绑定了其他人' });
  user.partner = partnerCode;
  partnerUser.partner = req.username;
  writeDB(db);
  res.json({ success: true, partner: partnerCode });
});

app.post('/api/unbind', requireAuth, (req, res) => {
  const db = readDB();
  const user = db.users[req.username];
  if (!user.partner) return res.status(400).json({ error: '当前没有绑定关系' });
  const partnerName = user.partner;
  if (db.users[partnerName]) db.users[partnerName].partner = null;
  user.partner = null;
  writeDB(db);
  res.json({ success: true });
});

app.get('/api/partner/stats', requireAuth, (req, res) => {
  const db = readDB();
  const user = db.users[req.username];
  if (!user.partner) return res.json({ success: true, bound: false });
  if (!db.users[user.partner]) return res.status(400).json({ error: '对方账号不存在' });
  const partner = db.users[user.partner];
  const records = partner.records || [];
  const expenses = records.filter(r => r.type === 'expense');
  const incomes = records.filter(r => r.type === 'income');
  const totalExpense = expenses.reduce((s, r) => s + r.amount, 0);
  const totalIncome = incomes.reduce((s, r) => s + r.amount, 0);
  const expenseByCategory = {};
  expenses.forEach(r => { expenseByCategory[r.categoryId || r.category] = (expenseByCategory[r.categoryId || r.category] || 0) + r.amount; });
  const incomeByCategory = {};
  incomes.forEach(r => { incomeByCategory[r.categoryId || r.category] = (incomeByCategory[r.categoryId || r.category] || 0) + r.amount; });
  res.json({ success: true, bound: true, partnerName: user.partner, totalExpense, totalIncome, balance: totalIncome - totalExpense, expenseByCategory, incomeByCategory, netAssets: partner.netAssets || { deposit: 0, investments: [] } });
});

// SPA fallback - serve index.html for all unknown routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('🔥 FIRE记账服务器运行在端口 ' + PORT);
});
