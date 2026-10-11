const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { loadConfig } = require('../src/shared/config');
const { createSerperClient } = require('../src/domain/research/serper-client');

async function main() {
  const config = loadConfig();
  if (!config.serperApiKey) {
    console.log(JSON.stringify({ status: 'SKIPPED', reason: 'Serper credentials are unavailable.' }));
    return;
  }
  try {
    const search = createSerperClient({ apiKey: config.serperApiKey, timeoutMs: 12000 });
    const result = await search({ query: 'سعر كتكوت أبيض جنيه', location: 'مصر', searchType: 'shopping' });
    console.log(JSON.stringify({ status: result.resultCount ? 'LIVE_SEARCH_RESULTS' : 'NO_RESULTS', provider: result.provider, resultCount: result.resultCount, source: result.results[0]?.url || null, elapsedMs: result.elapsedMs || null }));
  } catch (error) {
    console.log(JSON.stringify({ status: 'LIVE_SEARCH_FAILED', code: error.code || error.name, message: String(error.message || '').slice(0, 240) }));
    process.exitCode = 1;
  }
}
main().catch(error => { console.error(JSON.stringify({ status: 'LIVE_SEARCH_FAILED', code: error.code || error.name })); process.exitCode = 1; });
