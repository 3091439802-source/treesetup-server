const bcrypt = require('bcryptjs');

const GameSave = require('../models/GameSave');
const User = require('../models/User');

const PHONE_PATTERN = /^1[3-9]\d{9}$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 64;
const BCRYPT_ROUNDS = 12;

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 13 && digits.startsWith('86')
    ? digits.slice(2)
    : digits;
}

function validateCredentials(phone, password) {
  if (!PHONE_PATTERN.test(phone)) {
    throw new Error('Shared account phone must be an 11-digit mainland China mobile number');
  }
  if (typeof password !== 'string'
      || password.length < MIN_PASSWORD_LENGTH
      || password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(
      `Shared account password must contain ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters`
    );
  }
}

function defaultNickname(phone, type) {
  return type === 'premium'
    ? `高级测试账号_${phone.slice(-4)}`
    : `Player_${phone.slice(-4)}`;
}

function parseSharedTestAccounts(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return [];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid SHARED_TEST_ACCOUNTS_JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Invalid SHARED_TEST_ACCOUNTS_JSON: expected an array');
  }

  const phones = new Set();
  return parsed.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Invalid SHARED_TEST_ACCOUNTS_JSON entry ${index + 1}`);
    }
    const phone = normalizePhone(item.phone);
    const password = typeof item.password === 'string' ? item.password : '';
    const type = item.type === undefined ? 'normal' : item.type;
    if (type !== 'normal' && type !== 'premium') {
      throw new Error(
        `Shared test account type must be normal or premium at entry ${index + 1}`
      );
    }
    validateCredentials(phone, password);
    if (phones.has(phone)) {
      throw new Error(`Duplicate shared test account phone: ${phone}`);
    }
    phones.add(phone);

    const nickname = typeof item.nickname === 'string'
      ? item.nickname.trim()
      : '';
    return {
      phone,
      password,
      nickname: nickname || defaultNickname(phone, type),
      type
    };
  });
}

function configuredAccountList(env = process.env) {
  const accounts = new Map();
  const legacy = [
    {
      phone: normalizePhone(env.TEST_ACCOUNT_PHONE),
      password: env.TEST_ACCOUNT_PASSWORD || '',
      type: 'normal'
    },
    {
      phone: normalizePhone(env.PREMIUM_ACCOUNT_PHONE),
      password: env.PREMIUM_ACCOUNT_PASSWORD || '',
      type: 'premium'
    }
  ];

  for (const account of legacy) {
    if (!account.phone && !account.password) continue;
    validateCredentials(account.phone, account.password);
    accounts.set(account.phone, {
      ...account,
      nickname: defaultNickname(account.phone, account.type)
    });
  }

  for (const account of parseSharedTestAccounts(env.SHARED_TEST_ACCOUNTS_JSON)) {
    accounts.set(account.phone, account);
  }
  return Array.from(accounts.values());
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
      lastLoginPlatform: 'phone',
      accountType: 'shared_test'
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

function buildPremiumEntries(nickname = '高级测试账号') {
  const entries = [
    { key: 'cultivation_stage', type: 'int', value: '31' },
    { key: 'spiritStone', type: 'int', value: '1000000' },
    { key: 'huanYuStone', type: 'int', value: '1000000' },
    { key: 'huanYu', type: 'int', value: '1000000' },
    { key: 'totalCoins', type: 'int', value: '1000000' },
    { key: 'totalScore', type: 'int', value: '1000000' },
    { key: 'highscore', type: 'int', value: '1000000' },
    { key: 'store_char_active', type: 'int', value: '0' },
    { key: 'profile_nickname', type: 'string', value: nickname }
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

async function upsertConfiguredAccount(account) {
  const { phone, password, nickname, type } = account;
  const accountType = type === 'premium' ? 'premium_test' : 'shared_test';
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
      lastLoginPlatform: 'phone',
      accountType
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
    if (user.accountType !== accountType) {
      user.accountType = accountType;
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

  if (type === 'normal') {
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
        entries: buildPremiumEntries(nickname),
        updatedAt: new Date()
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return user;
}

async function ensureConfiguredAccounts() {
  if (String(process.env.ENABLE_TEST_ACCOUNTS || '').toLowerCase() !== 'true') {
    return { accounts: [] };
  }

  const configured = configuredAccountList();
  const accounts = [];
  for (const account of configured) {
    accounts.push(await upsertConfiguredAccount(account));
  }
  return { accounts };
}

module.exports = {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PHONE_PATTERN,
  buildPremiumEntries,
  configuredAccountList,
  ensureConfiguredAccounts,
  ensureConfiguredTestAccount,
  normalizePhone,
  parseSharedTestAccounts
};
