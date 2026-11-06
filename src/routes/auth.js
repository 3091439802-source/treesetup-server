const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const axios = require('axios');
const bcrypt = require('bcryptjs');

const User = require('../models/User');
const SmsCode = require('../models/SmsCode');
const RefreshToken = require('../models/RefreshToken');
const GameSave = require('../models/GameSave');
const authMiddleware = require('../middleware/auth');
const { sendSms } = require('../services/sms');
const {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PHONE_PATTERN,
  normalizePhone
} = require('../services/testAccount');

const router = express.Router();

function generateAccessToken(uid) {
  return jwt.sign({ uid }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
}

async function createRefreshTokenForUid(uid) {
  const token = RefreshToken.generateToken();
  const expireDays = parseInt(process.env.REFRESH_TOKEN_EXPIRES_IN) || 30;
  await RefreshToken.create({ uid, token, expireAt: new Date(Date.now() + expireDays * 24 * 60 * 60 * 1000), deviceInfo: '' });
  return token;
}

function generateSmsCode() { return Math.floor(100000 + Math.random() * 900000).toString(); }

function formatUserResponse(user, accessToken, refreshToken, isNewUser) {
  const accountType = user.accountType || 'standard';
  return {
    loginType: user.lastLoginPlatform || 'phone', openId: '', unionId: '',
    phone: user.phone || '', accessToken, refreshToken,
    nickname: user.nickname || '', avatarUrl: user.avatar || '',
    accountType,
    isSharedTestAccount: accountType !== 'standard',
    expireTime: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60), isNewUser: isNewUser || false
  };
}

async function completePhoneLogin(user, isNewUser) {
  user.lastLoginAt = new Date();
  user.lastLoginPlatform = 'phone';
  await user.save();

  const accessToken = generateAccessToken(user.uid);
  const refreshToken = await createRefreshTokenForUid(user.uid);
  return formatUserResponse(user, accessToken, refreshToken, isNewUser);
}

const PASSWORD_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const PASSWORD_FAILURE_LIMIT = 20;
const passwordLoginFailures = new Map();

function passwordFailureKey(req) {
  return normalizePhone(req.body && req.body.phone) || 'invalid-phone';
}

function passwordLoginLimit(req) {
  const key = passwordFailureKey(req);
  const current = passwordLoginFailures.get(key);
  if (!current) return { limited: false, key };
  const elapsed = Date.now() - current.startedAt;
  if (elapsed >= PASSWORD_FAILURE_WINDOW_MS) {
    passwordLoginFailures.delete(key);
    return { limited: false, key };
  }
  return {
    limited: current.failures >= PASSWORD_FAILURE_LIMIT,
    key,
    retryAfterSec: Math.ceil((PASSWORD_FAILURE_WINDOW_MS - elapsed) / 1000)
  };
}

function recordPasswordLoginFailure(key) {
  const current = passwordLoginFailures.get(key);
  if (!current || Date.now() - current.startedAt >= PASSWORD_FAILURE_WINDOW_MS) {
    passwordLoginFailures.set(key, { failures: 1, startedAt: Date.now() });
    return;
  }
  current.failures += 1;
}

function clearPasswordLoginFailures(key) {
  passwordLoginFailures.delete(key);
}

// POST /api/auth/send-sms
router.post('/send-sms', async (req, res) => {
  try {
    let { phone } = req.body;
    phone = (phone || "").replace(/\D/g, "");
    if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }
    const recentCode = await SmsCode.findOne({ phone, createdAt: { $gt: new Date(Date.now() - 60 * 1000) } });
    if (recentCode) {
      return res.status(429).json({ error: 'Please wait before requesting another code' });
    }
    const code = generateSmsCode();
    await SmsCode.create({ phone, code, expireAt: new Date(Date.now() + 5 * 60 * 1000) });
    try { await sendSms(phone, code); } catch (smsErr) { console.warn('SMS send warning:', smsErr.message); console.log('[SMS-FALLBACK] Code for ' + phone + ': ' + code); }
    res.json({ success: true, devCode: code });
  } catch (err) {
    console.error('send-sms error:', err);
    res.status(500).json({ error: 'Failed to send SMS code' });
  }
});

// POST /api/auth/phone-password-login
// Shared account login for installed APKs: phone is the account, password is
// compared against a bcrypt hash stored in MongoDB.
router.post('/phone-password-login', async (req, res) => {
  const limit = passwordLoginLimit(req);
  if (limit.limited) {
    res.set('Retry-After', String(limit.retryAfterSec || 1));
    return res.status(429).json({
      error: 'Too many login attempts. Please try again later.'
    });
  }
  try {
    const phone = normalizePhone(req.body && req.body.phone);
    const password = req.body && req.body.password;

    if (!PHONE_PATTERN.test(phone)
        || typeof password !== 'string'
        || password.length < MIN_PASSWORD_LENGTH
        || password.length > MAX_PASSWORD_LENGTH) {
      recordPasswordLoginFailure(limit.key);
      return res.status(401).json({ error: 'Invalid phone number or password' });
    }

    const user = await User.findOne({
      phone,
      isDeleted: { $ne: true }
    }).select('+passwordHash');

    if (!user || !user.passwordHash
        || !(await bcrypt.compare(password, user.passwordHash))) {
      recordPasswordLoginFailure(limit.key);
      return res.status(401).json({ error: 'Invalid phone number or password' });
    }

    clearPasswordLoginFailures(limit.key);
    const result = await completePhoneLogin(user, false);
    res.json(result);
  } catch (err) {
    console.error('phone-password-login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/phone-login
router.post('/phone-login', async (req, res) => {
  try {
    let { phone, code } = req.body;
    phone = (phone || "").replace(/\D/g, "");
    if (!phone || !code) {
      return res.status(400).json({ error: 'Phone and code are required' });
    }

    // 先查该手机号是否发过验证码
    const anyCode = await SmsCode.findOne({ phone }).sort({ createdAt: -1 });
    if (!anyCode) {
      return res.status(400).json({ error: 'Invalid verification code' });
    }

    // 检查是否过期
    if (anyCode.expireAt < new Date()) {
      return res.status(400).json({ error: 'Verification code expired' });
    }

    // 检查验证码是否匹配
    if (anyCode.code !== code) {
      return res.status(400).json({ error: 'Invalid verification code' });
    }

    // 检查是否已使用
    if (anyCode.used) {
      return res.status(400).json({ error: 'Verification code already used' });
    }

    // 标记已使用
    anyCode.used = true;
    await anyCode.save();

    // Find or create user
    let user = await User.findOne({ phone });
    let isNewUser = false;
    if (!user) {
      const uid = 'u_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 6); user = await User.create({ uid, phone, nickname: 'Player_' + phone.slice(-4), lastLoginPlatform: 'phone' });
      isNewUser = true;
    } else {
      user.lastLoginAt = new Date();
      user.lastLoginPlatform = 'phone';
      await user.save();
    }

    res.json(await completePhoneLogin(user, isNewUser));
  } catch (err) {
    console.error('phone-login error:', err); require('fs').appendFileSync('D:/TreeSetup/Server/phone-login-error.log', new Date().toISOString() + ' ERROR: ' + (err && err.message) + '\n' + (err && err.stack) + '\n\n'); console.error('phone-login stack:', err.stack); console.error('phone-login detail:', JSON.stringify(err, Object.getOwnPropertyNames(err)));
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/qq-login
router.post('/qq-login', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'QQ auth code is required' });
    const tokenRes = await axios.get('https://graph.qq.com/oauth2.0/token', {
      params: { grant_type: 'authorization_code', client_id: process.env.QQ_APP_ID, client_secret: process.env.QQ_APP_KEY, code, redirect_uri: process.env.QQ_REDIRECT_URI }
    });
    const tokenData = tokenRes.data;
    const accessToken = tokenData.access_token || (tokenData.match && tokenData.match(/access_token=([^&]+)/)?.[1]);
    if (!accessToken) return res.status(400).json({ error: 'Failed to get QQ access token' });
    const openIdRes = await axios.get('https://graph.qq.com/oauth2.0/me', { params: { access_token: accessToken } });
    const openIdMatch = openIdRes.data.match(/"openid":"([^"]+)"/);
    const openId = openIdMatch ? openIdMatch[1] : null;
    if (!openId) return res.status(400).json({ error: 'Failed to get QQ openId' });
    let qqNickname = '', qqAvatar = '';
    try {
      const userInfoRes = await axios.get('https://graph.qq.com/user/get_user_info', { params: { access_token: accessToken, openid: openId, oauth_consumer_key: process.env.QQ_APP_ID } });
      qqNickname = userInfoRes.data.nickname || '';
      qqAvatar = userInfoRes.data.figureurl_qq_2 || userInfoRes.data.figureurl_qq_1 || '';
    } catch (e) { console.warn('Failed to get QQ user info:', e.message); }
    let user = await User.findOne({ 'bindings': { $elemMatch: { platform: 'qq', openId } } });
    let isNewUser = false;
    if (!user) {
      const qqUid = 'u_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 6); user = await User.create({ uid: qqUid, nickname: qqNickname || 'QQ_Player', avatar: qqAvatar, bindings: [{ platform: 'qq', openId }], lastLoginPlatform: 'qq' });
      isNewUser = true;
    } else {
      user.lastLoginAt = new Date(); user.lastLoginPlatform = 'qq';
      if (qqNickname) user.nickname = qqNickname;
      if (qqAvatar) user.avatar = qqAvatar;
      await user.save();
    }
    const jwtToken = generateAccessToken(user.uid);
    const refreshToken = await createRefreshTokenForUid(user.uid);
    const result = formatUserResponse(user, jwtToken, refreshToken, isNewUser);
    result.loginType = 'qq'; result.openId = openId;
    res.json(result);
  } catch (err) { console.error('qq-login error:', err.message); res.status(500).json({ error: 'QQ login failed: ' + err.message }); }
});

// POST /api/auth/wechat-login
router.post('/wechat-login', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'WeChat auth code is required' });
    const tokenRes = await axios.get('https://api.weixin.qq.com/sns/oauth2/access_token', {
      params: { appid: process.env.WECHAT_APP_ID, secret: process.env.WECHAT_APP_SECRET, code, grant_type: 'authorization_code' }
    });
    const { access_token, openid, unionid } = tokenRes.data;
    if (!access_token || !openid) return res.status(400).json({ error: 'Failed to get WeChat token: ' + JSON.stringify(tokenRes.data) });
    let wxNickname = '', wxAvatar = '';
    try {
      const userInfoRes = await axios.get('https://api.weixin.qq.com/sns/userinfo', { params: { access_token, openid, lang: 'zh_CN' } });
      wxNickname = userInfoRes.data.nickname || ''; wxAvatar = userInfoRes.data.headimgurl || '';
    } catch (e) { console.warn('Failed to get WeChat user info:', e.message); }
    let user = await User.findOne({ 'bindings': { $elemMatch: { platform: 'wechat', openId: openid } } });
    let isNewUser = false;
    if (!user) {
      const wxUid = 'u_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 6); user = await User.create({ uid: wxUid, nickname: wxNickname || 'WX_Player', avatar: wxAvatar, bindings: [{ platform: 'wechat', openId: openid, unionId: unionid || '' }], lastLoginPlatform: 'wechat' });
      isNewUser = true;
    } else {
      user.lastLoginAt = new Date(); user.lastLoginPlatform = 'wechat';
      if (wxNickname) user.nickname = wxNickname;
      if (wxAvatar) user.avatar = wxAvatar;
      await user.save();
    }
    const jwtToken = generateAccessToken(user.uid);
    const refreshToken = await createRefreshTokenForUid(user.uid);
    const result = formatUserResponse(user, jwtToken, refreshToken, isNewUser);
    result.loginType = 'wechat'; result.openId = openid; result.unionId = unionid || '';
    res.json(result);
  } catch (err) { console.error('wechat-login error:', err.message); res.status(500).json({ error: 'WeChat login failed: ' + err.message }); }
});

// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token is required' });
    const stored = await RefreshToken.findOne({ token: refreshToken, expireAt: { $gt: new Date() } });
    if (!stored) return res.status(401).json({ error: 'Invalid or expired refresh token' });
    await RefreshToken.deleteOne({ _id: stored._id });
    const user = await User.findOne({ uid: stored.uid });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const newAccessToken = generateAccessToken(user.uid);
    const newRefreshToken = await createRefreshTokenForUid(user.uid);
    res.json(formatUserResponse(user, newAccessToken, newRefreshToken, false));
  } catch (err) { console.error('refresh error:', err); res.status(500).json({ error: 'Token refresh failed' }); }
});

// DELETE /api/auth/account
// Shared test accounts are protected as switch-only accounts. Other users are
// soft-deleted and their refresh tokens and cloud save are removed.
router.delete('/account', authMiddleware, async (req, res) => {
  try {
    const user = await User.findOne({
      uid: req.user.uid,
      isDeleted: { $ne: true }
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const accountType = user.accountType || 'standard';
    if (accountType !== 'standard') {
      return res.json({
        success: true,
        switched: true,
        accountType
      });
    }

    user.isDeleted = true;
    await user.save();
    await Promise.all([
      RefreshToken.deleteMany({ uid: user.uid }),
      GameSave.deleteOne({ uid: user.uid })
    ]);
    res.json({ success: true, deleted: true });
  } catch (err) {
    console.error('account deletion error:', err);
    res.status(500).json({ error: 'Account deletion failed' });
  }
});

// GET /api/auth/profile
router.get('/profile', authMiddleware, async (req, res) => {
  try {
    const user = await User.findOne({ uid: req.user.uid });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      uid: user.uid, nickname: user.nickname, avatar: user.avatar,
      phone: user.phone ? user.phone.slice(0, 3) + '****' + user.phone.slice(-4) : '',
      bindings: user.bindings.map(b => ({ platform: b.platform })),
      accountType: user.accountType || 'standard',
      isSharedTestAccount: (user.accountType || 'standard') !== 'standard',
      createdAt: user.createdAt, lastLoginAt: user.lastLoginAt
    });
  } catch (err) { console.error('profile error:', err); res.status(500).json({ error: 'Failed to get profile' }); }
});

module.exports = router;
