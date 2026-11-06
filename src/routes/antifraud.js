/**
 * 防沉迷实名认证接口 —— 阶段1 占位实现（mock）。
 *
 * 说明：
 *  - 使用内存 Map，服务重启即清空；阶段2 需换成 MongoDB 持久化
 *    （PlaySession / DailyPlay 模型，见 防沉迷系统接入方案.md）。
 *  - 年龄段由身份证号出生日期推算；正式接入国家防沉迷实名认证系统后，
 *    本文件替换为国家系统适配器（services/antifraud.js），字段以官方接口文档为准。
 *  - 未成年人可玩时段（mock 口径）：周五/周六/周日 20:00–21:00，单日累计 1 小时；
 *    正式接入后以国家系统跨游戏汇总为准。
 *  - 游客（无 JWT）通过 body 传 uid；手机/QQ/微信账号阶段2 改为从 JWT 解析。
 */
const express = require('express');
const crypto = require('crypto');

const router = express.Router();

const verifiedStore = new Map(); // uid -> { realNameVerified, ageBand, name, idHash, verifiedAt }
const dailyPlay = new Map();     // `${uid}:${dateKey}` -> seconds
const sessions = new Map();      // sessionId -> { uid, startAt, baseSec, playedSec }

const MINOR_DAILY_LIMIT_SEC = 3600;
const ADULT_DISPLAY_SEC = 3 * 3600;

function dateKey(d) {
  return d.toISOString().slice(0, 10);
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// GB 11643-1999 身份证校验
const WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const CHECK_CODES = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];

function isValidIdCard(id) {
  if (!id || id.length !== 18) return false;
  const upper = String(id).toUpperCase();
  for (let i = 0; i < 17; i++) {
    if (!/\d/.test(upper[i])) return false;
  }
  if (!/\d/.test(upper[17]) && upper[17] !== 'X') return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(upper[i]) * WEIGHTS[i];
  return upper[17] === CHECK_CODES[sum % 11];
}

function ageFromId(id) {
  const y = Number(id.substr(6, 4));
  const m = Number(id.substr(10, 2));
  const d = Number(id.substr(12, 2));
  const now = new Date();
  let age = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) age--;
  return Math.max(0, age);
}

function ageBandFromAge(age) {
  if (age >= 18) return 'adult';
  if (age >= 16) return 'under18';
  if (age >= 8) return 'under16';
  return 'under8';
}

function isMinor(band) {
  return band !== 'adult' && !!band;
}

// 可玩窗口（mock）：周五(5)/周六(6)/周日(0) 20:00–21:00，使用服务器本地时间
function inPlayWindow(d) {
  const day = d.getDay();
  if (day !== 5 && day !== 6 && day !== 0) return false;
  const minutes = d.getHours() * 60 + d.getMinutes();
  return minutes >= 20 * 60 && minutes < 21 * 60;
}

function playedToday(uid, d) {
  return dailyPlay.get(`${uid}:${dateKey(d)}`) || 0;
}

function canPlayFor(uid, band, d) {
  if (!isMinor(band)) return true;
  return inPlayWindow(d) && playedToday(uid, d) < MINOR_DAILY_LIMIT_SEC;
}

function remainingFor(uid, band, d) {
  if (!isMinor(band)) return ADULT_DISPLAY_SEC;
  return Math.max(0, MINOR_DAILY_LIMIT_SEC - playedToday(uid, d));
}

function unix(d) {
  return Math.floor(d.getTime() / 1000);
}

// GET /api/antifraud/status?uid=xxx
router.get('/status', (req, res) => {
  const uid = req.query.uid || '';
  const rec = verifiedStore.get(uid);
  const now = new Date();
  const band = rec ? rec.ageBand : '';
  res.json({
    realNameVerified: !!rec,
    ageBand: band,
    canPlay: rec ? canPlayFor(uid, band, now) : false,
    remainingSec: rec ? remainingFor(uid, band, now) : 0,
    serverNow: unix(now),
  });
});

// POST /api/antifraud/realname { uid, name, idCard }
router.post('/realname', (req, res) => {
  const { uid, name, idCard } = req.body || {};
  if (!uid) return res.status(400).json({ error: 'uid is required' });
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
  if (!isValidIdCard(idCard)) return res.status(400).json({ error: 'Invalid ID card' });

  const age = ageFromId(idCard);
  const band = ageBandFromAge(age);
  verifiedStore.set(uid, {
    realNameVerified: true,
    ageBand: band,
    name: String(name).trim(),
    idHash: sha256(String(idCard).toUpperCase()),
    verifiedAt: new Date().toISOString(),
  });
  res.json({ verified: true, ageBand: band, age });
});

// POST /api/antifraud/session/start { uid }
router.post('/session/start', (req, res) => {
  const { uid } = req.body || {};
  const rec = uid ? verifiedStore.get(uid) : null;
  const now = new Date();
  if (!rec) {
    return res.json({ canPlay: false, sessionId: '', remainingSec: 0, serverNow: unix(now) });
  }
  const band = rec.ageBand;
  if (!canPlayFor(uid, band, now)) {
    return res.json({
      canPlay: false,
      sessionId: '',
      remainingSec: remainingFor(uid, band, now),
      serverNow: unix(now),
    });
  }
  const sessionId = 's_' + crypto.randomBytes(8).toString('hex');
  sessions.set(sessionId, {
    uid,
    startAt: now.toISOString(),
    baseSec: playedToday(uid, now),
    playedSec: 0,
  });
  res.json({
    canPlay: true,
    sessionId,
    remainingSec: remainingFor(uid, band, now),
    serverNow: unix(now),
  });
});

// POST /api/antifraud/session/heartbeat { sessionId, playedSec }
// playedSec 为本次会话的累计在线秒数（服务端口径以会话时长为准）。
router.post('/session/heartbeat', (req, res) => {
  const { sessionId, playedSec } = req.body || {};
  const session = sessions.get(sessionId || '');
  const now = new Date();
  if (!session) return res.status(400).json({ error: 'Invalid session' });

  session.playedSec = Math.max(session.playedSec, Math.max(0, Number(playedSec) || 0));
  const total = session.baseSec + session.playedSec;
  dailyPlay.set(`${session.uid}:${dateKey(now)}`, total);

  const rec = verifiedStore.get(session.uid);
  const band = rec ? rec.ageBand : '';
  const forceOffline = isMinor(band) && (!inPlayWindow(now) || total >= MINOR_DAILY_LIMIT_SEC);
  res.json({
    remainingSec: isMinor(band) ? Math.max(0, MINOR_DAILY_LIMIT_SEC - total) : ADULT_DISPLAY_SEC,
    forceOffline,
    serverNow: unix(now),
  });
});

// POST /api/antifraud/session/end { sessionId, playedSec }
router.post('/session/end', (req, res) => {
  const { sessionId, playedSec } = req.body || {};
  const session = sessions.get(sessionId || '');
  const now = new Date();
  if (session) {
    session.playedSec = Math.max(session.playedSec, Math.max(0, Number(playedSec) || 0));
    dailyPlay.set(`${session.uid}:${dateKey(now)}`, session.baseSec + session.playedSec);
    sessions.delete(sessionId);
  }
  res.json({ ok: true });
});

module.exports = router;
