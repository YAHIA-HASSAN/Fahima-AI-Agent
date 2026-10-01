const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const dbPath = path.resolve(process.env.DB_PATH || './data/fahim.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, activity TEXT, products TEXT,
      capital REAL, costs TEXT, sales_method TEXT, household_use TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('income','stock_cost','operating_expense','withdrawal')),
      amount REAL NOT NULL CHECK(amount > 0), date TEXT NOT NULL, description TEXT NOT NULL,
      estimated INTEGER NOT NULL DEFAULT 0 CHECK(estimated IN (0,1)), created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const version = db.pragma('user_version', { simple: true });
  if (version < 1) {
    const upgrade = db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS conversations (
          id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          title TEXT, summary TEXT NOT NULL DEFAULT '', summary_message_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS conversations_project_idx ON conversations(project_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK(role IN ('user','assistant','system')), content TEXT NOT NULL,
          input_type TEXT NOT NULL DEFAULT 'text' CHECK(input_type IN ('text','voice','system')),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id,id);
        CREATE TABLE IF NOT EXISTS project_facts (
          id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          key TEXT NOT NULL, value TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'user', confirmed INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(project_id,key,value)
        );
        CREATE TABLE IF NOT EXISTS pending_actions (
          id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
          project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          action_type TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('waiting_for_details','awaiting_confirmation')),
          payload TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS products (
          id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL, unit TEXT NOT NULL, initial_quantity REAL NOT NULL DEFAULT 0,
          current_quantity REAL NOT NULL DEFAULT 0, low_stock_threshold REAL, unit_cost REAL, markup_percent REAL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(project_id,name,unit)
        );
        CREATE TABLE IF NOT EXISTS inventory_movements (
          id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          type TEXT NOT NULL CHECK(type IN ('purchase','sale','adjustment')),
          quantity REAL NOT NULL CHECK(quantity > 0), delta REAL NOT NULL,
          reference_type TEXT, reference_id INTEGER, description TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS movements_product_idx ON inventory_movements(project_id,product_id,created_at);
        CREATE TABLE IF NOT EXISTS transaction_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
          product_id INTEGER NOT NULL REFERENCES products(id), quantity REAL NOT NULL CHECK(quantity > 0),
          unit TEXT NOT NULL, unit_price REAL NOT NULL CHECK(unit_price >= 0), line_total REAL NOT NULL CHECK(line_total >= 0)
        );
        CREATE TABLE IF NOT EXISTS reminders (
          id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          title TEXT NOT NULL, due_at TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0,1)),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders(project_id,completed,due_at);
        PRAGMA user_version = 1;
      `);
      // Migrate already-confirmed profile fields as facts without changing the existing project rows.
      db.exec(`
        INSERT OR IGNORE INTO project_facts(project_id,key,value,source,confirmed)
          SELECT id,'activity',activity,'profile',1 FROM projects WHERE activity IS NOT NULL AND trim(activity)<>'';
        INSERT OR IGNORE INTO project_facts(project_id,key,value,source,confirmed)
          SELECT id,'products',products,'profile',1 FROM projects WHERE products IS NOT NULL AND trim(products)<>'';
        INSERT OR IGNORE INTO project_facts(project_id,key,value,source,confirmed)
          SELECT id,'sales_method',sales_method,'profile',1 FROM projects WHERE sales_method IS NOT NULL AND trim(sales_method)<>'';
        INSERT OR IGNORE INTO project_facts(project_id,key,value,source,confirmed)
          SELECT id,'household_use',household_use,'profile',1 FROM projects WHERE household_use IS NOT NULL AND trim(household_use)<>'';
      `);
    });
    upgrade();
  }
  const currentVersion = db.pragma('user_version', { simple: true });
  if (currentVersion < 2) {
    const upgrade = db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS gemini_usage_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
          local_day TEXT NOT NULL,
          estimated_tokens INTEGER NOT NULL DEFAULT 0,
          prompt_tokens INTEGER,
          output_tokens INTEGER,
          status TEXT NOT NULL DEFAULT 'reserved'
        );
        CREATE INDEX IF NOT EXISTS gemini_usage_day_idx ON gemini_usage_events(local_day, occurred_at);
        CREATE TABLE IF NOT EXISTS chat_requests (
          request_id TEXT PRIMARY KEY,
          conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          response_json TEXT,
          status_code INTEGER NOT NULL DEFAULT 200,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS chat_requests_created_idx ON chat_requests(created_at);
        PRAGMA user_version = 2;
      `);
    });
    upgrade();
  }
}
migrate();
module.exports = db;
