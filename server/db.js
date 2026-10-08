const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { defaultDbPath } = require('./config');

const dbPath = path.resolve(defaultDbPath(process.env));
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
  if (db.pragma('user_version', { simple: true }) < 3) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE project_facts ADD COLUMN label TEXT NOT NULL DEFAULT '';
        ALTER TABLE project_facts ADD COLUMN kind TEXT NOT NULL DEFAULT 'fact';
        ALTER TABLE project_facts ADD COLUMN certainty TEXT NOT NULL DEFAULT 'confirmed';
        ALTER TABLE project_facts ADD COLUMN numeric_value REAL;
        ALTER TABLE project_facts ADD COLUMN unit TEXT;
        ALTER TABLE project_facts ADD COLUMN observed_on TEXT;
        ALTER TABLE project_facts ADD COLUMN source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL;
        ALTER TABLE project_facts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
        CREATE TABLE fact_history (
          id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          fact_key TEXT NOT NULL, snapshot TEXT NOT NULL, source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE business_goals (
          id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          goal_key TEXT NOT NULL, title TEXT NOT NULL, target REAL, unit TEXT, horizon TEXT,
          status TEXT NOT NULL DEFAULT 'active', source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(project_id,goal_key)
        );
        CREATE TABLE advisor_state (
          project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
          objective TEXT NOT NULL DEFAULT '', capability TEXT NOT NULL DEFAULT '', next_action TEXT NOT NULL DEFAULT '',
          pending_question TEXT, progress TEXT NOT NULL DEFAULT '[]',
          source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE business_plans (
          id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft', stale INTEGER NOT NULL DEFAULT 0,
          source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(project_id,revision)
        );
        CREATE INDEX plans_project_idx ON business_plans(project_id,revision DESC);
        ALTER TABLE chat_requests ADD COLUMN request_hash TEXT;
      `);
      // Backfill only facts already supplied by the user. Keep all legacy rows.
      for (const project of db.prepare('SELECT * FROM projects').all()) {
        for (const key of ['activity','products','capital','costs','sales_method','household_use']) {
          const value = project[key];
          if (value == null || String(value).trim() === '') continue;
          if (!db.prepare('SELECT 1 FROM project_facts WHERE project_id=? AND key=?').get(project.id,key)) {
            db.prepare("INSERT INTO project_facts(project_id,key,value,source) VALUES(?,?,?,'profile')").run(project.id,key,String(value));
          }
        }
      }
      for (const row of db.prepare("SELECT id,value FROM project_facts WHERE key IN ('capital','starting_capital','available_cash','total_invested','obligations')").all()) {
        const value = Number(row.value);
        if (row.value.trim() && Number.isFinite(value)) db.prepare("UPDATE project_facts SET numeric_value=?,unit='جنيه' WHERE id=?").run(value,row.id);
      }
      db.pragma('user_version = 3');
    })();
  }
  if (db.pragma('user_version', { simple: true }) < 4) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE market_research (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          research_key TEXT NOT NULL,
          query TEXT NOT NULL,
          purpose TEXT NOT NULL,
          product_name TEXT NOT NULL DEFAULT '',
          specification TEXT NOT NULL DEFAULT '',
          description TEXT NOT NULL DEFAULT '',
          price REAL,
          currency TEXT,
          quantity REAL,
          unit TEXT,
          normalized_price REAL,
          normalized_unit TEXT,
          seller TEXT,
          source_title TEXT NOT NULL DEFAULT '',
          source_url TEXT NOT NULL DEFAULT '',
          source_kind TEXT NOT NULL DEFAULT 'other',
          observed_on TEXT,
          retrieved_at TEXT NOT NULL,
          valid_until TEXT NOT NULL,
          location TEXT,
          confidence TEXT NOT NULL DEFAULT 'low',
          availability TEXT,
          delivery_cost REAL,
          total_cost REAL,
          selected INTEGER NOT NULL DEFAULT 0 CHECK(selected IN (0,1)),
          raw_excerpt TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX market_research_project_idx ON market_research(project_id,research_key,retrieved_at DESC);
        PRAGMA user_version = 4;
      `);
    })();
  }
  if (db.pragma('user_version', { simple: true }) < 5) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE research_jobs (
          id TEXT PRIMARY KEY,
          project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed')),
          result_json TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX research_jobs_scope_idx ON research_jobs(project_id,conversation_id,updated_at DESC);
        PRAGMA user_version = 5;
      `);
    })();
  }
}
migrate();
module.exports = db;
