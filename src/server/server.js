const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { loadConfig } = require('../shared/config');
const { openDatabase, ensureBaseTables, ensureRuntimeTables } = require('../database/connection');
const { createSerperClient } = require('../domain/research/serper-client');
const { createAgent } = require('../agent/agent');
const { createApp } = require('./app');
const { createTtsService } = require('../voice/tts');

function createServer({ config = loadConfig(), model, search } = {}) {
  const db = openDatabase(config.dbPath);
  ensureBaseTables(db);
  ensureRuntimeTables(db);
  const searchImpl = search || createSerperClient({ apiKey: config.serperApiKey, cacheTtlMs: config.searchCacheTtlMs });
  const agent = createAgent({ db, config, model, search: input => searchImpl(input) });
  const tts = createTtsService(config);
  const app = createApp({ db, config, agent, tts });
  return { app, db, agent, close: () => db.close() };
}

if (require.main === module) {
  const runtime = createServer();
  const server = runtime.app.listen(loadConfig().port, () => console.log(`Fahima clean runtime listening on http://localhost:${loadConfig().port}`));
  for (const id of runtime.agent.tasks.recoverable()) runtime.agent.orchestrator.start(id);
  const stop = () => server.close(() => { runtime.close(); process.exit(0); });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = { createServer };
