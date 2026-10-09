function createSerperClient({ apiKey, fetchImpl = fetch, timeoutMs = 12000, cacheTtlMs = 600000 }) {
  const cache = new Map();
  return async function search({ query, location = 'مصر', searchType = 'search', projectId = 0 }) {
    if (!apiKey) throw Object.assign(new Error('مفتاح البحث غير مضبوط.'), { code: 'SERPER_NOT_CONFIGURED' });
    const clean = String(query || '').trim().slice(0, 220);
    if (!clean) throw new Error('عبارة البحث مطلوبة.');
    if (!['search', 'shopping'].includes(searchType)) throw new Error('نوع البحث غير مدعوم.');
    const key = JSON.stringify([projectId, clean, location, searchType]);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return { ...cached.result, cached: true };
    if (cached) cache.delete(key);
    const startedAt = Date.now(), deadline = startedAt + timeoutMs;
    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw Object.assign(new Error('انتهت مهلة البحث.'), { code: 'SEARCH_TIMEOUT' });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      try {
        const response = await fetchImpl(`https://google.serper.dev/${searchType}`, {
          method: 'POST', headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: `${clean} ${location}`.trim(), gl: 'eg', hl: 'ar', num: 8 }), signal: controller.signal,
        });
        if (!response.ok) {
          const status = Number(response.status) || 0;
          const retryAfter = Number(response.headers?.get?.('retry-after'));
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
          if (attempt === 0 && (status === 429 || status === 503) && waitMs > 0 && Date.now() + waitMs < deadline) {
            await new Promise(resolve => setTimeout(resolve, waitMs));
            continue;
          }
          throw Object.assign(new Error(`مزود البحث أعاد HTTP ${status}.`), { code: status === 429 ? 'RATE_LIMITED' : 'SEARCH_PROVIDER_ERROR', status });
        }
        const data = await response.json();
        const rows = searchType === 'shopping' ? data.shopping : data.organic;
        if (!Array.isArray(rows)) throw Object.assign(new Error('استجابة البحث غير متوقعة.'), { code: 'INVALID_SEARCH_RESPONSE' });
        const items = rows.slice(0, 8).map(item => ({ title: String(item.title || '').slice(0, 200), snippet: String(item.snippet || item.description || '').slice(0, 500), url: safeUrl(item.link || item.url), price: String(item.price || ''), date: String(item.date || '') })).filter(item => item.url);
        const result = { provider: 'serper', receivedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt, resultCount: items.length, results: items, sufficient: items.length > 0, cached: false };
        cache.set(key, { result, expiresAt: Date.now() + cacheTtlMs });
        if (cache.size > 120) cache.delete(cache.keys().next().value);
        return result;
      } catch (error) {
        if (error.name === 'AbortError') throw Object.assign(new Error('انتهت مهلة البحث.'), { code: 'SEARCH_TIMEOUT' });
        throw error;
      } finally { clearTimeout(timer); }
    }
  };
}
function safeUrl(value) { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } }
module.exports = { createSerperClient };
