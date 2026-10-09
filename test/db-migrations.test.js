const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

function loadDatabase(dbPath) {
  const oldPath = process.env.DB_PATH;
  process.env.DB_PATH = dbPath;
  delete require.cache[require.resolve('../server/db')];
  const db = require('../server/db');
  return {
    db,
    restore() {
      if (db.open) db.close();
      delete require.cache[require.resolve('../server/db')];
      if (oldPath === undefined) delete process.env.DB_PATH;
      else process.env.DB_PATH = oldPath;
    },
  };
}

test('forward migration repairs a version-8 database without losing business data and tolerates restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fahima-db-migration-'));
  const dbPath = path.join(dir, 'existing.sqlite');
  let loaded;
  try {
    loaded=loadDatabase(dbPath); let db=loaded.db;
    db.prepare("INSERT INTO projects(id,name,activity) VALUES(1,'مشروعي','تجارة')").run();
    db.prepare("INSERT INTO transactions(id,project_id,type,amount,date,description) VALUES(1,1,'income',125,'2026-10-01','بيع قائم')").run();
    const conversation=db.prepare("INSERT INTO conversations(project_id,title) VALUES(1,'محادثة')").run();
    db.prepare("INSERT INTO business_plans(project_id,revision,title,body) VALUES(1,1,'خطة قائمة','{}')").run();
    db.exec('DROP TABLE agent_task_deliveries; PRAGMA user_version=8;');
    loaded.restore(); loaded=loadDatabase(dbPath); db=loaded.db;
    assert.equal(db.pragma('user_version',{simple:true}),10);
    assert.ok(db.prepare('PRAGMA table_info(transactions)').all().some(x=>x.name==='voided_at'));
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='transaction_audit'").get());
    assert.deepEqual(db.prepare('PRAGMA table_info(agent_task_deliveries)').all().map(x=>x.name).sort(),['delivered_at','message_id','task_id']);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM projects').get().n,1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM transactions').get().n,1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM business_plans').get().n,1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM conversations WHERE id=?').get(conversation.lastInsertRowid).n,1);
    loaded.restore(); loaded=loadDatabase(dbPath); db=loaded.db;
    assert.equal(db.pragma('user_version',{simple:true}),10);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM transactions').get().n,1);
  } finally { loaded?.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('invalid delivery schema aborts migration and does not advance schema version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fahima-db-invalid-'));
  const dbPath = path.join(dir, 'invalid.sqlite');
  const oldPath=process.env.DB_PATH;let db;
  try {
    process.env.DB_PATH=dbPath;
    db=new Database(dbPath);
    db.exec("CREATE TABLE projects(id INTEGER PRIMARY KEY,name TEXT NOT NULL,activity TEXT,products TEXT,capital REAL,costs TEXT,sales_method TEXT,household_use TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP); CREATE TABLE agent_task_deliveries(task_id TEXT PRIMARY KEY); PRAGMA user_version=8;");
    db.close();db=null;delete require.cache[require.resolve('../server/db')];
    assert.throws(()=>require('../server/db'),/Invalid agent_task_deliveries schema/);
    const check=new Database(dbPath);assert.equal(check.pragma('user_version',{simple:true}),8);check.close();
  } finally {
    if(db?.open)db.close();delete require.cache[require.resolve('../server/db')];
    if(oldPath===undefined)delete process.env.DB_PATH;else process.env.DB_PATH=oldPath;
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch (error) { if (error.code !== 'EPERM') throw error; }
  }
});
