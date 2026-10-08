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
  db.close();
} catch (error) {
  check('SQLite', false, 'run npm run setup; check DB_PATH configuration', true);
}

const configProblems = config.issues;
check('Configuration values', configProblems.length === 0, configProblems.join(' '));
check('Gemini API key', Boolean(config.geminiApiKey), 'stored data and reports remain readable without a key');

async function main() {
  check('Voice architecture', true, 'browser speech recognition; direct progressive Gemini MP3 playback');

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
