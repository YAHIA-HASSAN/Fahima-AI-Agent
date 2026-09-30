function cairoDay(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function createQuotaManager(database = null, getLimits = () => require('./config').loadConfig().geminiQuota) {
  database ||= require('./db');
  const reserveStatement = database.prepare(`
    INSERT INTO gemini_usage_events(local_day, estimated_tokens, status)
    VALUES (?, ?, 'reserved')
  `);
  const statsStatement = database.prepare(`
    SELECT COUNT(*) AS requests, COALESCE(SUM(estimated_tokens), 0) AS tokens
    FROM gemini_usage_events WHERE occurred_at >= datetime('now', '-60 seconds')
  `);
  const todayStatement = database.prepare(`SELECT COUNT(*) AS requests FROM gemini_usage_events WHERE local_day=?`);
  const finishStatement = database.prepare(`UPDATE gemini_usage_events SET status=?, prompt_tokens=?, output_tokens=?, estimated_tokens=COALESCE(?,estimated_tokens) WHERE id=?`);

  function reserve(estimatedTokens = 0) {
    const limits = getLimits();
    const estimated = Math.max(1, Math.ceil(Number(estimatedTokens) || 1));
    const action = database.transaction(() => {
      const minute = statsStatement.get();
      const today = todayStatement.get(cairoDay()).requests;
      const softRpm = Math.max(1, Math.floor(limits.maxRpm * 0.85));
      const softTpm = Math.max(1, Math.floor(limits.maxTpm * 0.85));
      if (today >= limits.dailyHardLimit || today >= limits.dailySoftLimit) {
        throw Object.assign(new Error('Local daily Gemini usage limit reached.'), { code: 'LOCAL_GEMINI_DAILY_LIMIT', usage: { requestsToday: today } });
      }
      if (minute.requests >= softRpm || minute.tokens + estimated > softTpm) {
        throw Object.assign(new Error('Local Gemini short-window usage limit reached.'), { code: 'LOCAL_GEMINI_RATE_LIMIT', usage: { requestsThisMinute: minute.requests, estimatedTokensThisMinute: minute.tokens } });
      }
      return reserveStatement.run(cairoDay(), estimated).lastInsertRowid;
    });
    return action();
  }

  function finish(id, { status = 'success', promptTokens = null, outputTokens = null, actualTokens = null } = {}) {
    finishStatement.run(status, Number.isFinite(promptTokens) ? promptTokens : null, Number.isFinite(outputTokens) ? outputTokens : null, Number.isFinite(actualTokens) ? actualTokens : null, id);
  }

  function usage() {
    const limits = getLimits();
    return {
      requestsToday: todayStatement.get(cairoDay()).requests,
      ...statsStatement.get(),
      limits: { ...limits },
      day: cairoDay(),
    };
  }
  return { reserve, finish, usage };
}

let manager;
function currentManager() {
  if (!manager) manager = createQuotaManager();
  return manager;
}
module.exports = {
  reserve: (...args) => currentManager().reserve(...args),
  finish: (...args) => currentManager().finish(...args),
  usage: (...args) => currentManager().usage(...args),
  createQuotaManager,
  cairoDay,
};
