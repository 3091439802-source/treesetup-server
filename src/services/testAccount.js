const bcrypt = require('bcryptjs');

const GameSave = require('../models/GameSave');
const User = require('../models/User');

const PHONE_PATTERN = /^1[3-9]\d{9}$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 64;
const BCRYPT_ROUNDS = 12;

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function validateCredentials(phone, password) {
  if (!PHONE_PATTERN.test(phone)) {
    throw new Error('TEST_ACCOUNT_PHONE must be an 11-digit mainland China mobile number');
  }
  if (typeof password !== 'string'
      || password.length < MIN_PASSWORD_LENGTH
      || password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(
      `TEST_ACCOUNT_PASSWORD must contain ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters`
    );
  }
}

/**
 * Creates or repairs the shared phone/password test account configured in the
 * server environment. This runs after MongoDB connects, so the account lives in
 * the same persistent users collection used by every APK.
 */
async function ensureConfiguredTestAccount() {
  if (String(process.env.ENABLE_TEST_ACCOUNT || '').toLowerCase() !== 'true') {
    return null;
  }

  const phone = normalizePhone(process.env.TEST_ACCOUNT_PHONE);
  const password = process.env.TEST_ACCOUNT_PASSWORD || '';
  validateCredentials(phone, password);

  let user = await User.findOne({ phone }).select('+passwordHash');
  const passwordMatches = user && user.passwordHash
    ? await bcrypt.compare(password, user.passwordHash)
    : false;

  if (!user) {
    const uid = 'u_' + Date.now().toString(36)
      + Math.random().toString(36).slice(2, 8);
    user = await User.create({
      uid,
      phone,
      nickname: 'Player_' + phone.slice(-4),
      passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
      lastLoginPlatform: 'phone'
    });
    console.log(`[TEST-ACCOUNT] Created shared phone account ${phone}`);
    return user;
  }

  let changed = false;
  if (!passwordMatches) {
    user.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    changed = true;
  }
  if (user.isDeleted) {
    user.isDeleted = false;
    changed = true;
  }
  if (changed) {
    await user.save();
    console.log(`[TEST-ACCOUNT] Repaired shared phone account ${phone}`);
  } else {
    console.log(`[TEST-ACCOUNT] Shared phone account ${phone} is ready`);
  }
  return user;
}

function buildPremiumEntries() {
  const entries = [
    { key: 'cultivation_stage', type: 'int', value: '31' },
    { key: 'spiritStone', type: 'int', value: '1000000' },
    { key: 'huanYuStone', type: 'int', value: '1000000' },
    { key: 'huanYu', type: 'int', value: '1000000' },
    { key: 'totalCoins', type: 'int', value: '1000000' },
    { key: 'totalScore', type: 'int', value: '1000000' },
    { key: 'highscore', type: 'int', value: '1000000' },
    { key: 'store_char_active', type: 'int', value: '0' },
    { key: 'profile_nickname', type: 'string', value: '高级测试账号' }
  ];

  for (let level = 1; level <= 10; level++) {
    entries.push({
      key: `mainline_v1_clear_${level}`,
      type: 'int',
      value: '1'
    });
    entries.push({
      key: `mainline_v1_reward_${level}`,
      type: 'int',
      value: '1'
    });
  }
  for (let character = 0; character < 7; character++) {
    entries.push({
      key: `store_char_own_${character}`,
      type: 'int',
      value: '1'
    });
    entries.push({
      key: `runItem_${character}`,
      type: 'int',
      value: '20'
    });
  }
  return entries;
}

async function upsertConfiguredAccount(phone, password, nickname, entries) {
  validateCredentials(phone, password);
  let user = await User.findOne({ phone }).select('+passwordHash');
  const passwordMatches = user && user.passwordHash
    ? await bcrypt.compare(password, user.passwordHash)
    : false;

  if (!user) {
    const uid = 'u_' + Date.now().toString(36)
      + Math.random().toString(36).slice(2, 8);
    user = await User.create({
      uid,
      phone,
      nickname,
      passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
      lastLoginPlatform: 'phone'
    });
    console.log(`[TEST-ACCOUNT] Created shared phone account ${phone}`);
  } else {
    let changed = false;
    if (!passwordMatches) {
      user.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      changed = true;
    }
    if (user.nickname !== nickname) {
      user.nickname = nickname;
      changed = true;
    }
    if (user.isDeleted) {
      user.isDeleted = false;
      changed = true;
    }
    if (changed) {
      await user.save();
      console.log(`[TEST-ACCOUNT] Repaired shared phone account ${phone}`);
    } else {
      console.log(`[TEST-ACCOUNT] Shared phone account ${phone} is ready`);
    }
  }

  if (entries === null) {
    await GameSave.deleteOne({
      uid: user.uid,
      revision: 0,
      entries: { $size: 0 }
    });
    return user;
  }

  await GameSave.findOneAndUpdate(
    { uid: user.uid },
    {
      $setOnInsert: {
        uid: user.uid,
        revision: 0,
        schemaVersion: 1,
        entries,
        updatedAt: new Date()
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return user;
}

async function ensureConfiguredAccounts() {
  if (String(process.env.ENABLE_TEST_ACCOUNTS || '').toLowerCase() !== 'true') {
    return {
      testAccount: await ensureConfiguredTestAccount(),
      premiumAccount: null
    };
  }

  const testPhone = normalizePhone(process.env.TEST_ACCOUNT_PHONE);
  const testPassword = process.env.TEST_ACCOUNT_PASSWORD || '';
  const premiumPhone = normalizePhone(process.env.PREMIUM_ACCOUNT_PHONE);
  const premiumPassword = process.env.PREMIUM_ACCOUNT_PASSWORD || '';
  validateCredentials(testPhone, testPassword);
  validateCredentials(premiumPhone, premiumPassword);

  const testAccount = await upsertConfiguredAccount(
    testPhone,
    testPassword,
    'Player_' + testPhone.slice(-4),
    null
  );
  const premiumAccount = await upsertConfiguredAccount(
    premiumPhone,
    premiumPassword,
    '高级测试账号',
    buildPremiumEntries()
  );
  return { testAccount, premiumAccount };
}

module.exports = {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PHONE_PATTERN,
  buildPremiumEntries,
  ensureConfiguredAccounts,
  ensureConfiguredTestAccount,
  normalizePhone
};
