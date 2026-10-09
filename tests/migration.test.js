const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const Database=require('better-sqlite3');
const {ensureBaseTables,ensureRuntimeTables}=require('../src/database/connection');

test('additive runtime migration preserves existing messages, transactions, and correction history',()=>{
  const db=new Database(':memory:');
  db.exec(`CREATE TABLE projects(id INTEGER PRIMARY KEY,name TEXT NOT NULL);CREATE TABLE conversations(id INTEGER PRIMARY KEY,project_id INTEGER,title TEXT,summary TEXT DEFAULT '',summary_message_count INTEGER DEFAULT 0,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);CREATE TABLE messages(id INTEGER PRIMARY KEY,conversation_id INTEGER,role TEXT,content TEXT,input_type TEXT DEFAULT 'text',created_at TEXT DEFAULT CURRENT_TIMESTAMP);CREATE TABLE transactions(id INTEGER PRIMARY KEY,project_id INTEGER,type TEXT,amount REAL,date TEXT,description TEXT,estimated INTEGER DEFAULT 0,voided_at TEXT,void_reason TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);CREATE TABLE project_facts(id INTEGER PRIMARY KEY,project_id INTEGER,key TEXT,value TEXT);CREATE TABLE products(id INTEGER PRIMARY KEY,project_id INTEGER,name TEXT,unit TEXT,current_quantity REAL,low_stock_threshold REAL,unit_cost REAL);`);
  const project=Number(db.prepare('INSERT INTO projects(name) VALUES(?)').run('مشروع ترحيل').lastInsertRowid);
  const convo=Number(db.prepare('INSERT INTO conversations(project_id,title) VALUES(?,?)').run(project,'قديم').lastInsertRowid);
  db.prepare('INSERT INTO messages(conversation_id,role,content) VALUES(?,?,?)').run(convo,'user','اختبار حفظ الرسالة');
  db.prepare('INSERT INTO transactions(project_id,type,amount,date,description,voided_at,void_reason) VALUES(?,?,?,?,?,?,?)').run(project,'income',100,'2026-10-01','المعاملة المصححة','2026-10-02','تصحيح');
  db.prepare('INSERT INTO transactions(project_id,type,amount,date,description) VALUES(?,?,?,?,?)').run(project,'income',120,'2026-10-01','البديل المصحح');
  const before={projects:db.prepare('SELECT COUNT(*) n FROM projects').get().n,messages:db.prepare('SELECT COUNT(*) n FROM messages').get().n,transactions:db.prepare('SELECT COUNT(*) n FROM transactions').get().n,active:db.prepare('SELECT SUM(amount) n FROM transactions WHERE voided_at IS NULL').get().n};
  ensureBaseTables(db);ensureRuntimeTables(db);
  assert.deepEqual({projects:db.prepare('SELECT COUNT(*) n FROM projects').get().n,messages:db.prepare('SELECT COUNT(*) n FROM messages').get().n,transactions:db.prepare('SELECT COUNT(*) n FROM transactions').get().n,active:db.prepare('SELECT SUM(amount) n FROM transactions WHERE voided_at IS NULL').get().n},before);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='fahima_v2_transaction_audit'").get().n,1);
  db.close();
});

test('SQLite backup can be restored with integrity and important records intact',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fahima-restore-'));
  const source=new Database(':memory:');source.exec('CREATE TABLE projects(id INTEGER PRIMARY KEY,name TEXT);CREATE TABLE transactions(id INTEGER PRIMARY KEY,amount REAL);INSERT INTO projects(name) VALUES(\'تجريبي\');INSERT INTO transactions(amount) VALUES(75.5)');
  const file=path.join(dir,'restore.sqlite');await source.backup(file);source.close();
  const restored=new Database(file,{readonly:true});
  assert.equal(restored.pragma('integrity_check',{simple:true}),'ok');assert.equal(restored.prepare('SELECT COUNT(*) n FROM projects').get().n,1);assert.equal(restored.prepare('SELECT SUM(amount) n FROM transactions').get().n,75.5);restored.close();
  fs.rmSync(dir,{recursive:true,force:true});
});
