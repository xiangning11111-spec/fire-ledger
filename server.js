const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== 存储后端选择 =====
const MONGO_URI = process.env.MONGO_URI || '';
const USE_MONGO = !!MONGO_URI;

let mongoClient = null;
let db = null;

// 文件存储备用（本地开发）
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// ===== 公用工具函数 =====
function hashPassword(pwd) { return crypto.createHash('sha256').update(pwd + '_fire_salt_2026').digest('hex'); }
function generateToken() { return crypto.randomBytes(32).toString('hex'); }

// ===== 文件存储（备用）=====
function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { return { users: {}, sessions: {} }; }
}
function writeDB(dbData) { fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2)); }

// ===== MongoDB 存储 =====
async function getUsersCollection() {
  return db.collection('users');
}
async function getSessionsCollection() {
  return db.collection('sessions');
}

// 清理过期session (>30天)
async function cleanSessionsMongo() {
  const sessions = await getSessionsCollection();
  const expiry = Date.now() - 30 * 24 * 60 * 60 * 1000;
  await sessions.deleteMany({ createdAt: { $lt: expiry } });
}
async function cleanSessionsFile() {
  const dbData = readDB();
  const now = Date.now();
  const expiry = 30 * 24 * 60 * 60 * 1000;
  for (const token in dbData.sessions) {
    if (now - dbData.sessions[token].createdAt > expiry) delete dbData.sessions[token];
  }
  writeDB(dbData);
}

async function cleanSessions() {
  if (USE_MONGO) await cleanSessionsMongo();
  else cleanSessionsFile();
}

// ===== 统一用户操作接口 =====
async function findUser(username) {
  if (USE_MONGO) {
    const users = await getUsersCollection();
    return users.findOne({ _id: username });
  } else {
    const dbData = readDB();
    return dbData.users[username] ? { _id: username, ...dbData.users[username] } : null;
  }
}

async function saveUser(username, userData) {
  if (USE_MONGO) {
    const users = await getUsersCollection();
    const { _id, ...data } = userData; // 去掉 _id，MongoDB 不允许 $set _id
    await users.updateOne(
      { _id: username },
      { $set: data },
      { upsert: true }
    );
  } else {
    const dbData = readDB();
    dbData.users[username] = userData;
    writeDB(dbData);
  }
}

async function deleteUser(username) {
  if (USE_MONGO) {
    const users = await getUsersCollection();
    await users.deleteOne({ _id: username });
  } else {
    const dbData = readDB();
    delete dbData.users[username];
    writeDB(dbData);
  }
}

async function findSession(token) {
  if (USE_MONGO) {
    const sessions = await getSessionsCollection();
    return sessions.findOne({ _id: token });
  } else {
    const dbData = readDB();
    return dbData.sessions[token] ? { _id: token, ...dbData.sessions[token] } : null;
  }
}

async function saveSession(token, sessionData) {
  if (USE_MONGO) {
    const sessions = await getSessionsCollection();
    const { _id, ...data } = sessionData;
    await sessions.updateOne(
      { _id: token },
      { $set: data },
      { upsert: true }
    );
  } else {
    const dbData = readDB();
    dbData.sessions[token] = sessionData;
    writeDB(dbData);
  }
}

async function deleteSession(token) {
  if (USE_MONGO) {
    const sessions = await getSessionsCollection();
    await sessions.deleteOne({ _id: token });
  } else {
    const dbData = readDB();
    delete dbData.sessions[token];
    writeDB(dbData);
  }
}

async function getAllSessionsForUser(username) {
  if (USE_MONGO) {
    const sessions = await getSessionsCollection();
    const docs = await sessions.find({ username }).toArray();
    return docs.map(d => d._id);
  } else {
    const dbData = readDB();
    return Object.keys(dbData.sessions).filter(t => dbData.sessions[t].username === username);
  }
}

// ===== Auth 中间件 =====
async function requireAuth(req, res, next) {
  const token = (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '请先登录' });
  await cleanSessions();
  const session = await findSession(token);
  if (!session) return res.status(401).json({ error: '登录已过期，请重新登录' });
  req.username = session.username;
  req.token = token;
  // 刷新session时间
  await saveSession(token, { ...session, createdAt: Date.now() });
  next();
}

// ===== 初始化 =====
async function initStorage() {
  if (USE_MONGO) {
    mongoClient = new MongoClient(MONGO_URI);
    await mongoClient.connect();
    db = mongoClient.db('fire_ledger');
    console.log('✅ MongoDB Atlas 连接成功');

    // 创建索引
    const sessions = await getSessionsCollection();
    await sessions.createIndex({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

    const users = await getUsersCollection();
    await users.createIndex({ _id: 1 });
  } else {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify({ users: {}, sessions: {} }, null, 2));
    }
    console.log('⚠️  使用本地文件存储（非持久化），生产环境请设置 MONGO_URI');
  }
}

// ===== Middleware =====
app.use(express.json({ limit: '5mb' }));

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// ===== API Endpoints =====

// 注册
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
  if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名需要2-20个字符' });
  if (/[^a-zA-Z0-9_\u4e00-\u9fa5]/.test(username)) return res.status(400).json({ error: '用户名只能含中文、字母、数字、下划线' });
  if (password.length < 4) return res.status(400).json({ error: '密码至少4位' });

  const existing = await findUser(username);
  if (existing) return res.status(400).json({ error: '该用户名已被注册' });

  await saveUser(username, {
    password: hashPassword(password),
    partner: null,
    records: [],
    netAssets: { deposit: 0, investments: [], lastUpdate: '' },
    config: { inflationRate: 0.03, returnRate: 0.07 }
  });

  const token = generateToken();
  await saveSession(token, { username, createdAt: Date.now() });

  res.json({ success: true, token, username, inviteCode: username });
});

// 登录
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });

  const user = await findUser(username);
  if (!user || user.password !== hashPassword(password)) {
    return res.status(400).json({ error: '用户名或密码错误' });
  }

  const token = generateToken();
  await saveSession(token, { username, createdAt: Date.now() });

  res.json({ success: true, token, username, inviteCode: username, partner: user.partner });
});

// 重置密码（不需要旧密码）
app.post('/api/auth/reset-password', async (req, res) => {
  const { username, newPassword } = req.body;
  if (!username || !newPassword) return res.status(400).json({ error: '请输入用户名和新密码' });
  if (newPassword.length < 4) return res.status(400).json({ error: '新密码至少4位' });

  const user = await findUser(username);
  if (!user) return res.status(400).json({ error: '该用户名不存在' });

  user.password = hashPassword(newPassword);
  await saveUser(username, user);

  // 清除该用户所有session，强制重新登录
  const tokens = await getAllSessionsForUser(username);
  for (const t of tokens) await deleteSession(t);

  res.json({ success: true });
});

// 获取/同步数据
app.get('/api/sync', requireAuth, async (req, res) => {
  const user = await findUser(req.username);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json({
    success: true,
    records: user.records || [],
    netAssets: user.netAssets || { deposit: 0, investments: [], lastUpdate: '' },
    config: user.config || { inflationRate: 0.03, returnRate: 0.07 },
    partner: user.partner || null
  });
});

// 上传数据
app.post('/api/sync', requireAuth, async (req, res) => {
  const { records, netAssets, config } = req.body;
  const user = await findUser(req.username);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (records !== undefined) user.records = records;
  if (netAssets !== undefined) user.netAssets = netAssets;
  if (config !== undefined) user.config = config;
  await saveUser(req.username, user);
  res.json({ success: true });
});

// 绑定对象
app.post('/api/bind', requireAuth, async (req, res) => {
  const { partnerCode } = req.body;
  if (!partnerCode) return res.status(400).json({ error: '请输入对方的邀请码' });
  if (partnerCode === req.username) return res.status(400).json({ error: '不能绑定自己' });

  const user = await findUser(req.username);
  if (user.partner) return res.status(400).json({ error: '你已经绑定了 ' + user.partner + '，请先解绑' });

  const partner = await findUser(partnerCode);
  if (!partner) return res.status(400).json({ error: '该邀请码不存在，请确认对方已注册' });
  if (partner.partner && partner.partner !== req.username) {
    return res.status(400).json({ error: partnerCode + ' 已绑定了其他人' });
  }

  user.partner = partnerCode;
  partner.partner = req.username;
  await saveUser(req.username, user);
  await saveUser(partnerCode, partner);

  res.json({ success: true, partner: partnerCode });
});

// 解绑
app.post('/api/unbind', requireAuth, async (req, res) => {
  const user = await findUser(req.username);
  if (!user.partner) return res.status(400).json({ error: '当前没有绑定关系' });

  const partnerName = user.partner;
  const partner = await findUser(partnerName);
  if (partner) {
    partner.partner = null;
    await saveUser(partnerName, partner);
  }

  user.partner = null;
  await saveUser(req.username, user);

  res.json({ success: true });
});

// 获取对象统计
app.get('/api/partner/stats', requireAuth, async (req, res) => {
  const user = await findUser(req.username);
  if (!user.partner) return res.json({ success: true, bound: false });

  const partner = await findUser(user.partner);
  if (!partner) return res.status(400).json({ error: '对方账号不存在' });

  const records = partner.records || [];
  const expenses = records.filter(r => r.type === 'expense');
  const incomes = records.filter(r => r.type === 'income');
  const totalExpense = expenses.reduce((s, r) => s + r.amount, 0);
  const totalIncome = incomes.reduce((s, r) => s + r.amount, 0);
  const expenseByCategory = {};
  expenses.forEach(r => { expenseByCategory[r.categoryId || r.category] = (expenseByCategory[r.categoryId || r.category] || 0) + r.amount; });
  const incomeByCategory = {};
  incomes.forEach(r => { incomeByCategory[r.categoryId || r.category] = (incomeByCategory[r.categoryId || r.category] || 0) + r.amount; });

  res.json({
    success: true, bound: true, partnerName: user.partner,
    totalExpense, totalIncome, balance: totalIncome - totalExpense,
    expenseByCategory, incomeByCategory,
    netAssets: partner.netAssets || { deposit: 0, investments: [] }
  });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 启动
initStorage().then(() => {
  app.listen(PORT, () => {
    console.log('🔥 FIRE记账服务器运行在端口 ' + PORT);
  });
}).catch(err => {
  console.error('启动失败:', err);
  process.exit(1);
});
