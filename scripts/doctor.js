const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { loadConfig } = require('../src/shared/config');
const { chromium } = require('playwright');
const { openDatabase, ensureBaseTables, ensureRuntimeTables } = require('../src/database/connection');
const config = loadConfig();
const errors = [];
try {
  if (process.versions.node.split('.')[0] < 20) errors.push('Node.js 20 or newer is required.');
  const db = openDatabase(config.dbPath);
  const projectCount = db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
  ensureBaseTables(db);
  ensureRuntimeTables(db);
  const version = db.pragma('user_version', { simple: true });
  const runtimeTables = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name LIKE 'fahima_v2_%'").get().n;
  db.close();
  console.log(`✓ Node.js ${process.version}`);
  console.log(`✓ SQLite opens safely at ${config.dbPath}`);
  console.log(`✓ Existing database schema version ${version}; existing projects ${projectCount}`);
  console.log(`✓ ${runtimeTables} additive runtime tables ready`);
  console.log(`✓ Gemini ${config.geminiApiKey ? 'configured' : 'not configured (live reasoning unavailable)'}`);
  console.log(`✓ Serper ${config.serperApiKey ? 'configured' : 'not configured (live search unavailable)'}`);
  console.log(`✓ Chromium ${require('node:fs').existsSync(chromium.executablePath()) ? 'available' : 'missing; run npx playwright install chromium'}`);
  console.log(`→ Fahima listens on port ${config.port}`);
} catch (error) { errors.push(error.message); }
if (errors.length) { for (const error of errors) console.error(`✗ ${error}`); process.exitCode = 1; }
