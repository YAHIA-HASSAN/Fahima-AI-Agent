function readBoolean(env, name, fallback, issues) {
  const value = env[name];
  if (value === undefined || value === '') return fallback;
  if (/^(true|1|yes|on)$/i.test(value)) return true;
  if (/^(false|0|no|off)$/i.test(value)) return false;
  issues.push(`${name} must be true or false.`);
  return fallback;
}

function readNumber(env, name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER, integer = false } = {}, issues) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    issues.push(`${name} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}.`);
    return fallback;
  }
  return value;
}

function loadConfig(env = process.env) {
  const issues = [];
  const geminiModel = String(env.GEMINI_MODEL || 'gemini-3.5-flash-lite').trim();
  const geminiMaxRpm = readNumber(env, 'GEMINI_MAX_RPM', 15, { min: 1, max: 10000, integer: true }, issues);
  const geminiMaxTpm = readNumber(env, 'GEMINI_MAX_TPM', 250000, { min: 1, max: 10000000, integer: true }, issues);
  const geminiMaxRpd = readNumber(env, 'GEMINI_MAX_RPD', 500, { min: 1, max: 1000000, integer: true }, issues);
  const geminiDailySoftLimit = readNumber(env, 'GEMINI_DAILY_SOFT_LIMIT', 450, { min: 1, max: geminiMaxRpd, integer: true }, issues);
  const geminiDailyHardLimit = readNumber(env, 'GEMINI_DAILY_HARD_LIMIT', 490, { min: 1, max: geminiMaxRpd, integer: true }, issues);
  const dbPath = String(env.DB_PATH || './data/fahim.sqlite').trim();
  if (!geminiModel) issues.push('GEMINI_MODEL cannot be empty.');
  if (!dbPath) issues.push('DB_PATH cannot be empty.');

  const port = readNumber(env, 'PORT', 3000, { min: 1, max: 65535, integer: true }, issues);

  return {
    issues,
    port,
    dbPath: dbPath || './data/fahim.sqlite',
    geminiApiKey: String(env.GEMINI_API_KEY || '').trim(),
    geminiModel: geminiModel || 'gemini-3.5-flash-lite',
    geminiQuota: { maxRpm: geminiMaxRpm, maxTpm: geminiMaxTpm, maxRpd: geminiMaxRpd, dailySoftLimit: geminiDailySoftLimit, dailyHardLimit: geminiDailyHardLimit },
    geminiTimeoutMs: readNumber(env, 'GEMINI_TIMEOUT_MS', 30000, { min: 1000, max: 300000, integer: true }, issues),
    agent: {
      recentMessageLimit: readNumber(env, 'AGENT_RECENT_MESSAGE_LIMIT', 8, { min: 2, max: 30, integer: true }, issues),
      contextTokenBudget: readNumber(env, 'AGENT_CONTEXT_TOKEN_BUDGET', 6000, { min: 512, max: 50000, integer: true }, issues),
    },
  };
}

module.exports = { loadConfig, readBoolean, readNumber };
