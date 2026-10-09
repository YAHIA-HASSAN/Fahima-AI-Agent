const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const projectRoot = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(projectRoot, '.env') });

const { loadConfig } = require('../server/config');
const config = loadConfig();
let requiredFailure = false;

function check(label, ok, detail = '', required = false) {
  const mark = ok ? '✓' : required ? '✗' : '⚠';
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok && required) requiredFailure = true;
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
check('Node.js', nodeMajor >= 20, `v${process.versions.node}${nodeMajor < 20 ? '; install Node.js 20+' : ''}`, true);
let npmVersion = '';
const npmAgentVersion = String(process.env.npm_config_user_agent || '').match(/\bnpm\/([^\s]+)/)?.[1];
if (npmAgentVersion) npmVersion = npmAgentVersion;
else {
  try {
    npmVersion = process.platform === 'win32'
      ? execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm --version'], { encoding: 'utf8', windowsHide: true }).trim()
      : execFileSync('npm', ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
  } catch {}
}
check('npm', Boolean(npmVersion), npmVersion || 'install npm with Node.js', true);
check('Dependencies', ['express', 'dotenv', 'better-sqlite3'].every((name) => {
  try { require.resolve(name); return true; } catch { return false; }
}), 'run npm install if missing', true);
check('Gemini SDK', (() => {
  try { require.resolve('@google/genai'); return true; } catch { return false; }
})(), 'required for interpreting text and voice messages');

const envExists = fs.existsSync(path.join(projectRoot, '.env'));
check('Environment file', envExists, envExists ? '.env is present' : 'run npm run setup to create .env');

try {
  const db = require('../server/db');
  const result = db.prepare('PRAGMA quick_check').get();
  check('SQLite', result?.quick_check === 'ok', result?.quick_check || 'database check failed', true);
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  const requiredTables = ['projects','transactions','conversations','messages','project_facts','agent_tasks','agent_task_steps','agent_task_metrics','agent_task_deliveries','business_plans','chat_requests'];
  const missingTables = requiredTables.filter(name => !tables.has(name));
  const schemaVersion = db.pragma('user_version', { simple: true });
  check('Database path', Boolean(db.dbPath), db.dbPath || 'unavailable', true);
  check('Schema version', schemaVersion >= 9, `version ${schemaVersion}; latest migration 9`, true);
  check('Required tables', missingTables.length === 0, missingTables.length ? `missing: ${missingTables.join(', ')}` : `${requiredTables.length} core tables present`, true);
  const deliveryColumns = tables.has('agent_task_deliveries')
    ? db.prepare('PRAGMA table_info(agent_task_deliveries)').all().map(column => column.name).sort()
    : [];
  const deliveryReady = deliveryColumns.join(',') === 'delivered_at,message_id,task_id' &&
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND tbl_name='agent_task_deliveries'").get() != null;
  check('Agent task delivery schema', deliveryReady, deliveryReady ? 'delivery table and primary-key index ready' : 'delivery table contract is incomplete', true);
  const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(row => row.name));
  const taskIndexes = ['agent_tasks_claim_idx','agent_tasks_scope_idx'];
  check('Agent task indexes', taskIndexes.every(name => indexes.has(name)), taskIndexes.filter(name => !indexes.has(name)).join(', ') || 'claim and project-scope indexes ready', true);
  check('Pending migrations', schemaVersion >= 9, schemaVersion >= 9 ? 'none' : 'database migration required', true);
  check('Agent worker readiness', deliveryReady && schemaVersion >= 9 && requiredTables.every(name => tables.has(name)), 'database is initialized before worker startup', true);
  db.close();
} catch (error) {
  check('SQLite / schema initialization', false, 'database could not be opened or safely migrated; check DB_PATH and migration diagnostics', true);
}

const configProblems = config.issues;
check('Configuration values', configProblems.length === 0, configProblems.join(' '));
check('Gemini API key', Boolean(config.geminiApiKey), 'stored data and reports remain readable without a key');
check('Market search provider', true, config.searchProvider);
if(config.searchProvider==='serper')check('Serper API key',Boolean(config.serperApiKey),config.serperApiKey?'configured':'SERPER_API_KEY is missing; live search will remain unavailable until configured');
if(config.searchFallbackProvider)check('Market search fallback',true,config.searchFallbackProvider);

async function main() {
  check('Voice architecture', true, 'browser speech recognition; direct Gemini PCM streaming through Web Audio');

  if (process.argv.includes('--check-gemini')) {
    if (!config.geminiApiKey) {
      check('Gemini API connectivity', false, 'GEMINI_API_KEY is not configured');
    } else {
      try {
        const { GoogleGenAI } = require('@google/genai');
        const ai = new GoogleGenAI({
          apiKey: config.geminiApiKey,
          httpOptions: { timeout: config.geminiTimeoutMs, retryOptions: { attempts: 1 } },
        });
        await ai.interactions.create({ model: config.geminiModel, input: 'Reply with OK.' });
        check('Gemini API connectivity', true);
      } catch (error) {
        check('Gemini API connectivity', false, error?.status === 401 || error?.status === 403 ? 'check API key access' : 'check network, model access, quota, and timeout');
      }
    }
  } else {
    console.log('→ Use npm run doctor -- --check-gemini for an optional one-request connectivity check.');
  }

  if (!config.geminiApiKey) console.log('→ Stored records remain available. Add GEMINI_API_KEY to .env to interpret new messages.');
  if (requiredFailure) process.exitCode = 1;
}

main().catch(() => {
  console.error('Doctor could not complete its optional checks.');
  if (requiredFailure) process.exitCode = 1;
});
