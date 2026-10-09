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

const fs = require('node:fs');
const path = require('node:path');

function defaultDbPath(env = process.env) {
  if (env.DB_PATH) return String(env.DB_PATH).trim();
  const current = path.resolve('./data/fahima.sqlite');
  const legacy = path.resolve('./data/fahim.sqlite');
  return !fs.existsSync(current) && fs.existsSync(legacy) ? './data/fahim.sqlite' : './data/fahima.sqlite';
}

function loadConfig(env = process.env) {
  const issues = [];
  const geminiModel = String(env.GEMINI_MODEL || 'gemini-3.5-flash-lite').trim();
  const geminiSearchModel = String(env.GEMINI_SEARCH_MODEL || geminiModel).trim();
  const searchProvider = String(env.SEARCH_PROVIDER || 'serper').trim().toLowerCase();
  const searchFallbackProvider = String(env.SEARCH_FALLBACK_PROVIDER || '').trim().toLowerCase();
  const dbPath = defaultDbPath(env);
  if (!geminiModel) issues.push('GEMINI_MODEL cannot be empty.');
  if (!geminiSearchModel) issues.push('GEMINI_SEARCH_MODEL cannot be empty.');
  if (!['serper','gemini'].includes(searchProvider)) issues.push('SEARCH_PROVIDER must be serper or gemini.');
  if (!['','gemini'].includes(searchFallbackProvider)) issues.push('SEARCH_FALLBACK_PROVIDER must be empty or gemini.');
  if (!dbPath) issues.push('DB_PATH cannot be empty.');

  const port = readNumber(env, 'PORT', 3000, { min: 1, max: 65535, integer: true }, issues);

  return {
    issues,
    port,
    dbPath: dbPath || './data/fahima.sqlite',
    geminiApiKey: String(env.GEMINI_API_KEY || '').trim(),
    geminiModel: geminiModel || 'gemini-3.5-flash-lite',
    geminiSearchModel: geminiSearchModel || geminiModel || 'gemini-3.5-flash-lite',
    searchProvider: ['serper','gemini'].includes(searchProvider)?searchProvider:'serper',
    searchFallbackProvider: searchFallbackProvider==='gemini'?'gemini':'',
    serperApiKey: String(env.SERPER_API_KEY || '').trim(),
    geminiTimeoutMs: readNumber(env, 'GEMINI_TIMEOUT_MS', 15000, { min: 1000, max: 300000, integer: true }, issues),
    geminiTtsTimeoutMs: readNumber(env, 'GEMINI_TTS_TIMEOUT_MS', 8000, { min: 1000, max: 60000, integer: true }, issues),
    geminiSearchTimeoutMs: readNumber(env, 'GEMINI_SEARCH_TIMEOUT_MS', 45000, { min: 1000, max: 60000, integer: true }, issues),
    searchCacheTtlMs: readNumber(env, 'SEARCH_CACHE_TTL_MS', 600000, { min: 1000, max: 3600000, integer: true }, issues),
    agent: {
      reserveGuidance: String(env.FAHIMA_RESERVE_GUIDANCE || 'اقترحي الاحتياطي من واقع المشروع والمخاطر والتكاليف المعروفة فقط، واكتبي أساسه؛ عند نقص البيانات اتركيه غير محسوم.').slice(0,500),
      recentMessageLimit: readNumber(env, 'AGENT_RECENT_MESSAGE_LIMIT', 8, { min: 2, max: 30, integer: true }, issues),
      contextTokenBudget: readNumber(env, 'AGENT_CONTEXT_TOKEN_BUDGET', 6000, { min: 512, max: 50000, integer: true }, issues),
      taskTimeoutMs: readNumber(env, 'AGENT_TASK_TIMEOUT_MS', 300000, { min: 10000, max: 300000, integer: true }, issues),
      taskLeaseMs: readNumber(env, 'AGENT_TASK_LEASE_MS', 30000, { min: 5000, max: 120000, integer: true }, issues),
      taskInputCostPerMillion: readNumber(env, 'GEMINI_INPUT_COST_PER_MILLION', 0, { min: 0, max: 100000 }, issues),
      taskOutputCostPerMillion: readNumber(env, 'GEMINI_OUTPUT_COST_PER_MILLION', 0, { min: 0, max: 100000 }, issues),
    },
  };
}

module.exports = { loadConfig, readBoolean, readNumber, defaultDbPath };
