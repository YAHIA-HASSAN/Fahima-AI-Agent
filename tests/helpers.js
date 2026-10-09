const Database = require('better-sqlite3');
const { ensureRuntimeTables } = require('../src/database/connection');

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,activity TEXT,products TEXT,capital REAL,costs TEXT,sales_method TEXT,household_use TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE conversations(id INTEGER PRIMARY KEY AUTOINCREMENT,project_id INTEGER NOT NULL REFERENCES projects(id),title TEXT,summary TEXT NOT NULL DEFAULT '',summary_message_count INTEGER NOT NULL DEFAULT 0,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id INTEGER NOT NULL REFERENCES conversations(id),role TEXT NOT NULL,content TEXT NOT NULL,input_type TEXT NOT NULL DEFAULT 'text',created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE transactions(id INTEGER PRIMARY KEY AUTOINCREMENT,project_id INTEGER NOT NULL REFERENCES projects(id),type TEXT NOT NULL,amount REAL NOT NULL,date TEXT NOT NULL,description TEXT NOT NULL,estimated INTEGER NOT NULL DEFAULT 0,voided_at TEXT,void_reason TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE project_facts(id INTEGER PRIMARY KEY,project_id INTEGER,key TEXT,value TEXT);
    CREATE TABLE products(id INTEGER PRIMARY KEY,project_id INTEGER,name TEXT,unit TEXT,current_quantity REAL,low_stock_threshold REAL,unit_cost REAL);
  `);
  ensureRuntimeTables(db);
  return db;
}

function toolCall(name, args) { return { candidate: { role: 'model', parts: [{ functionCall: { name, args } }] }, usage: { promptTokenCount: 20, candidatesTokenCount: 10 } }; }
function waitForTask(agent, id, projectId, timeoutMs = 1500) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const task = agent.tasks.get(id, projectId);
      if (task && !['QUEUED', 'RUNNING'].includes(task.status)) return resolve(task);
      if (Date.now() - started > timeoutMs) return reject(new Error('Task timeout'));
      setTimeout(check, 5);
    };
    check();
  });
}
module.exports = { createTestDb, toolCall, waitForTask };
