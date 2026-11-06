const EXACT_KEYS = new Set([
  'spiritStone',
  'huanYuStone',
  'huanYu',
  'totalCoins',
  'totalScore',
  'highscore',
  'cultivation_stage',
  'store_char_active',
  'signin_v1_state',
  'profile_nickname',
  'profile_gender',
  'profile_birthday',
  'profile_avatar'
]);

const INT_PATTERNS = [
  /^mainline_v1_clear_(?:[1-9]|[12]\d|30)$/,
  /^mainline_v1_reward_(?:[1-9]|[12]\d|30)$/,
  /^mainline_v1_best_hits_(?:[1-9]|[12]\d|30)$/,
  /^store_char_own_[0-6]$/,
  /^runItem_[0-6]$/
];

const FLOAT_PATTERNS = [
  /^mainline_v1_best_time_(?:[1-9]|[12]\d|30)$/
];

function allowedTypeForKey(key) {
  if (EXACT_KEYS.has(key)) {
    if (key === 'signin_v1_state'
        || key === 'profile_nickname'
        || key === 'profile_gender'
        || key === 'profile_birthday') {
      return 'string';
    }
    return 'int';
  }
  if (INT_PATTERNS.some((pattern) => pattern.test(key))) return 'int';
  if (FLOAT_PATTERNS.some((pattern) => pattern.test(key))) return 'float';
  return null;
}

function validateEntries(entries) {
  if (!Array.isArray(entries)) {
    return { ok: false, error: 'entries must be an array' };
  }
  if (entries.length > 256) {
    return { ok: false, error: 'too many entries' };
  }

  const keys = new Set();
  const normalized = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      return { ok: false, error: 'invalid entry' };
    }
    const key = typeof entry.key === 'string' ? entry.key : '';
    const type = typeof entry.type === 'string' ? entry.type : '';
    const value = typeof entry.value === 'string' ? entry.value : null;
    const expectedType = allowedTypeForKey(key);

    if (!key || key.length > 64 || !expectedType || type !== expectedType) {
      return { ok: false, error: 'unsupported game save entry' };
    }
    if (keys.has(key)) {
      return { ok: false, error: 'duplicate game save key' };
    }
    if (value === null || value.length > 4096) {
      return { ok: false, error: 'invalid game save value' };
    }
    if (type === 'int') {
      const parsed = Number(value);
      if (!/^-?\d+$/.test(value)
          || !Number.isSafeInteger(parsed)
          || parsed < -2147483648
          || parsed > 2147483647) {
        return { ok: false, error: 'invalid int game save value' };
      }
    } else if (type === 'float' && !Number.isFinite(Number(value))) {
      return { ok: false, error: 'invalid float game save value' };
    }

    keys.add(key);
    normalized.push({ key, type, value });
  }
  return { ok: true, entries: normalized };
}

module.exports = {
  validateEntries
};
