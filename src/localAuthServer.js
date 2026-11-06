require('dotenv').config();

const bcrypt = require('bcryptjs');
const cors = require('cors');
const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');

const antifraudRoutes = require('./routes/antifraud');

const PORT = Number(process.env.PORT) || 3000;
const PHONE_PATTERN = /^1[3-9]\d{9}$/;
const ACCESS_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const REFRESH_EXPIRES_IN = process.env.REFRESH_TOKEN_EXPIRES_IN || '30d';
const DATA_DIR = path.join(__dirname, '..', 'data');
const ACCOUNT_FILE = path.join(DATA_DIR, 'local-auth-account.json');

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, filePath);
}

function ensureConfiguredAccount() {
  const phone = normalizePhone(process.env.TEST_ACCOUNT_PHONE);
  const password = process.env.TEST_ACCOUNT_PASSWORD || '';
  if (!PHONE_PATTERN.test(phone) || password.length < 8) {
    throw new Error('TEST_ACCOUNT_PHONE/TEST_ACCOUNT_PASSWORD are not configured');
  }

  let account = null;
  try {
    account = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8'));
  } catch (_) {
    account = null;
  }

  const passwordMatches = account && account.passwordHash
    ? bcrypt.compareSync(password, account.passwordHash)
    : false;
  if (!account || account.phone !== phone || !passwordMatches) {
    account = {
      uid: account && account.phone === phone
        ? account.uid
        : `u_local_${phone}`,
      phone,
      nickname: `Player_${phone.slice(-4)}`,
      passwordHash: bcrypt.hashSync(password, 12),
      updatedAt: new Date().toISOString()
    };
    writeJsonAtomic(ACCOUNT_FILE, account);
    console.log(`[LOCAL-AUTH] Account ready: ${phone}`);
  } else {
    console.log(`[LOCAL-AUTH] Account ready: ${phone}`);
  }
  return account;
}

const account = ensureConfiguredAccount();
const app = express();
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' }
});

app.use(cors());
app.use(express.json({ limit: '256kb' }));

function createToken(uid, tokenType, expiresIn) {
  return jwt.sign(
    { uid, tokenType },
    process.env.JWT_SECRET,
    { expiresIn }
  );
}

function formatSession() {
  const accessToken = createToken(account.uid, 'access', ACCESS_EXPIRES_IN);
  const refreshToken = createToken(account.uid, 'refresh', REFRESH_EXPIRES_IN);
  return {
    loginType: 'phone',
    openId: '',
    unionId: '',
    phone: account.phone,
    accessToken,
    refreshToken,
    nickname: account.nickname,
    avatarUrl: '',
    expireTime: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60),
    isNewUser: false
  };
}

function requireAccess(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    if (decoded.tokenType !== 'access' || decoded.uid !== account.uid) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    req.user = decoded;
    next();
  } catch (_) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    storage: 'local-file',
    timestamp: new Date().toISOString()
  });
});

app.post('/api/auth/phone-password-login', loginLimiter, (req, res) => {
  const phone = normalizePhone(req.body && req.body.phone);
  const password = req.body && req.body.password;
  if (!PHONE_PATTERN.test(phone)
      || typeof password !== 'string'
      || phone !== account.phone
      || !bcrypt.compareSync(password, account.passwordHash)) {
    return res.status(401).json({ error: 'Invalid phone number or password' });
  }
  res.json(formatSession());
});

app.post('/api/auth/refresh', (req, res) => {
  try {
    const decoded = jwt.verify(
      String((req.body && req.body.refreshToken) || ''),
      process.env.JWT_SECRET
    );
    if (decoded.tokenType !== 'refresh' || decoded.uid !== account.uid) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }
    res.json(formatSession());
  } catch (_) {
    res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

app.get('/api/auth/profile', requireAccess, (req, res) => {
  res.json({
    uid: account.uid,
    nickname: account.nickname,
    avatar: '',
    phone: `${account.phone.slice(0, 3)}****${account.phone.slice(-4)}`,
    bindings: [],
    createdAt: account.updatedAt,
    lastLoginAt: new Date().toISOString()
  });
});

app.use('/api/antifraud', antifraudRoutes);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[LOCAL-AUTH] Server listening on http://0.0.0.0:${PORT}`);
});
