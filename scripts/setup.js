const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const envPath = path.join(projectRoot, '.env');
const examplePath = path.join(projectRoot, '.env.example');

if (Number(process.versions.node.split('.')[0]) < 20) {
  console.error('Faheema requires Node.js 20 or later.');
  process.exit(1);
}

for (const requiredFile of ['package.json', 'server/index.js', 'public/index.html', '.env.example']) {
  if (!fs.existsSync(path.join(projectRoot, requiredFile))) {
    console.error(`Missing required project file: ${requiredFile}`);
    process.exit(1);
  }
}

if (!fs.existsSync(envPath)) {
  if (!fs.existsSync(examplePath)) {
    console.error('Missing .env.example. Restore it before running setup.');
    process.exit(1);
  }
  fs.copyFileSync(examplePath, envPath, fs.constants.COPYFILE_EXCL);
  console.log('Created .env from .env.example. Add GEMINI_API_KEY only if you want Gemini features.');
} else {
  console.log('.env already exists; kept your current configuration.');
}

require('dotenv').config({ path: envPath });
try {
  const db = require('../server/db');
  const business = require('../server/business');
  business.getProject(1);
  business.ensureConversation(1);
  db.close();
  console.log('SQLite database is ready.');
  console.log('Setup complete. Start the app with npm run dev.');
} catch (error) {
  console.error(`Could not initialize the SQLite database: ${error.message}`);
  process.exitCode = 1;
}
