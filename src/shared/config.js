const path = require('node:path');

function loadConfig(env = process.env, root = path.resolve(__dirname, '../..')) {
  const projectRoot = root;
  return {
    root,
    projectRoot,
    port: Number(env.FAHIMA_NEXT_PORT || env.PORT || 3001),
    dbPath: path.resolve(projectRoot, env.DB_PATH || 'data/fahima.sqlite'),
    geminiApiKey: String(env.GEMINI_API_KEY || '').trim(),
    geminiModel: String(env.GEMINI_MODEL || 'gemini-3.5-flash-lite').trim(),
    ttsModel: String(env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-lite-tts').trim(),
    ttsTimeoutMs: Number(env.GEMINI_TTS_TIMEOUT_MS || 8000),
    serperApiKey: String(env.SERPER_API_KEY || '').trim(),
    searchCacheTtlMs: Number(env.SEARCH_CACHE_TTL_MS || 600000),
    taskMaxDecisions: Number(env.AGENT_MAX_DECISIONS || 6),
    taskMaxTools: Number(env.AGENT_MAX_TOOLS || 6),
    taskTimeoutMs: Number(env.AGENT_TASK_TIMEOUT_MS || 300000),
    leaseMs: Number(env.AGENT_TASK_LEASE_MS || 30000),
  };
}

module.exports = { loadConfig };
