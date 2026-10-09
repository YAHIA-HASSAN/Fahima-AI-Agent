const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  return db;
}

function ensureBaseTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, activity TEXT, products TEXT,
      capital REAL, costs TEXT, sales_method TEXT, household_use TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('income','stock_cost','operating_expense','withdrawal')),
      amount REAL NOT NULL CHECK(amount>0), date TEXT NOT NULL, description TEXT NOT NULL,
      estimated INTEGER NOT NULL DEFAULT 0 CHECK(estimated IN (0,1)), created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT, summary TEXT NOT NULL DEFAULT '', summary_message_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system')), content TEXT NOT NULL,
      input_type TEXT NOT NULL DEFAULT 'text' CHECK(input_type IN ('text','voice','system')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS project_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      key TEXT NOT NULL, value TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'user', confirmed INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id,key,value)
    );
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL, unit TEXT NOT NULL, initial_quantity REAL NOT NULL DEFAULT 0,
      current_quantity REAL NOT NULL DEFAULT 0, low_stock_threshold REAL, unit_cost REAL,
      markup_percent REAL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(project_id,name,unit)
    );
  `);
  const columns = new Set(db.prepare('PRAGMA table_info(transactions)').all().map(row => row.name));
  if (!columns.has('voided_at')) db.exec('ALTER TABLE transactions ADD COLUMN voided_at TEXT');
  if (!columns.has('void_reason')) db.exec('ALTER TABLE transactions ADD COLUMN void_reason TEXT');
}

function ensureRuntimeTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fahima_v2_tasks (
      id TEXT PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','COMPLETE','PROVISIONAL','WAITING_FOR_INPUT','FAILED','CANCELLED')),
      objective TEXT NOT NULL, state_json TEXT NOT NULL DEFAULT '{}', result_json TEXT,
      error TEXT, lease_owner TEXT, lease_expires_at TEXT, attempt INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS fahima_v2_tasks_claim_idx ON fahima_v2_tasks(status,lease_expires_at,created_at);
    CREATE INDEX IF NOT EXISTS fahima_v2_tasks_project_idx ON fahima_v2_tasks(project_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS fahima_v2_task_steps (
      task_id TEXT NOT NULL REFERENCES fahima_v2_tasks(id) ON DELETE CASCADE,
      step_key TEXT NOT NULL, sequence INTEGER NOT NULL, kind TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','complete','failed')),
      input_hash TEXT NOT NULL, result_json TEXT, error TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT,
      PRIMARY KEY(task_id,step_key)
    );
    CREATE TABLE IF NOT EXISTS fahima_v2_transactions (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      task_id TEXT, idempotency_key TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('income','stock_cost','operating_expense','withdrawal')),
      amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), date TEXT NOT NULL, description TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(project_id,idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS fahima_v2_plan_versions (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, task_id TEXT REFERENCES fahima_v2_tasks(id) ON DELETE SET NULL,
      quality_status TEXT NOT NULL CHECK(quality_status IN ('COMPLETE','PROVISIONAL')),
      body_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id,revision)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS fahima_v2_plan_task_idx ON fahima_v2_plan_versions(task_id) WHERE task_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS fahima_v2_deliveries (
      task_id TEXT PRIMARY KEY REFERENCES fahima_v2_tasks(id) ON DELETE CASCADE,
      assistant_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      delivered_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS fahima_v2_requests (
      request_id TEXT PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES fahima_v2_tasks(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS fahima_v2_facts (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      fact_key TEXT NOT NULL, value_json TEXT NOT NULL, provenance TEXT NOT NULL,
      certainty TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id,fact_key)
    );
    CREATE TABLE IF NOT EXISTS fahima_v2_fact_history (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      fact_key TEXT NOT NULL, value_json TEXT NOT NULL, provenance TEXT NOT NULL,
      certainty TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS fahima_v2_goals (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      goal_key TEXT NOT NULL, title TEXT NOT NULL, target_json TEXT, status TEXT NOT NULL DEFAULT 'active',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(project_id,goal_key)
    );
    CREATE TABLE IF NOT EXISTS fahima_v2_observations (
      id INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES fahima_v2_tasks(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL, tool_name TEXT NOT NULL, outcome_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(task_id,sequence)
    );
    CREATE TABLE IF NOT EXISTS fahima_v2_decisions (
      id INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES fahima_v2_tasks(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL, action_type TEXT NOT NULL, tool_names_json TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(task_id,sequence)
    );
    CREATE TABLE IF NOT EXISTS fahima_v2_research (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES fahima_v2_tasks(id) ON DELETE CASCADE,
      query TEXT NOT NULL, source_url TEXT NOT NULL, result_json TEXT NOT NULL,
      retrieved_at TEXT NOT NULL, UNIQUE(task_id,source_url)
    );
    CREATE INDEX IF NOT EXISTS fahima_v2_research_scope_idx ON fahima_v2_research(project_id,retrieved_at DESC);
    CREATE TABLE IF NOT EXISTS fahima_v2_transaction_audit (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      transaction_id INTEGER NOT NULL REFERENCES transactions(id), action TEXT NOT NULL,
      before_json TEXT, after_json TEXT, reason TEXT NOT NULL, task_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS fahima_v2_inventory_movements (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id), transaction_id INTEGER REFERENCES transactions(id),
      quantity_delta REAL NOT NULL CHECK(quantity_delta != 0), reason TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, reverses_movement_id INTEGER REFERENCES fahima_v2_inventory_movements(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(project_id,idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS fahima_v2_plan_step_status (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      plan_revision INTEGER NOT NULL, step_index INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','complete')),
      note TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(project_id,plan_revision,step_index)
    );
    CREATE TABLE IF NOT EXISTS fahima_v2_plan_outcomes (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      plan_revision INTEGER, metric TEXT NOT NULL, planned_value TEXT, actual_value TEXT NOT NULL,
      note TEXT, idempotency_key TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS fahima_v2_customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL, phone TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id,name)
    );
    CREATE TABLE IF NOT EXISTS fahima_v2_sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      transaction_id INTEGER NOT NULL REFERENCES transactions(id), customer_id INTEGER REFERENCES fahima_v2_customers(id),
      product_id INTEGER REFERENCES products(id), quantity REAL, unit_price REAL NOT NULL,
      amount REAL NOT NULL, paid_amount REAL NOT NULL DEFAULT 0, sale_kind TEXT NOT NULL CHECK(sale_kind IN ('cash','credit')),
      effective_date TEXT NOT NULL, source_message_id INTEGER REFERENCES messages(id), created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id,transaction_id)
    );
    CREATE TABLE IF NOT EXISTS fahima_v2_customer_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      customer_id INTEGER NOT NULL REFERENCES fahima_v2_customers(id), amount REAL NOT NULL CHECK(amount>0),
      effective_date TEXT NOT NULL, description TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      source_message_id INTEGER REFERENCES messages(id), created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id,idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS fahima_v2_suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(project_id,name)
    );
    CREATE TABLE IF NOT EXISTS fahima_v2_purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      supplier_id INTEGER REFERENCES fahima_v2_suppliers(id), product_id INTEGER REFERENCES products(id),
      quantity REAL NOT NULL, unit_cost REAL NOT NULL, amount REAL NOT NULL, paid_amount REAL NOT NULL DEFAULT 0,
      effective_date TEXT NOT NULL, description TEXT NOT NULL, idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(project_id,idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS fahima_v2_supplier_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      supplier_id INTEGER NOT NULL REFERENCES fahima_v2_suppliers(id), amount REAL NOT NULL, effective_date TEXT NOT NULL,
      description TEXT NOT NULL, idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(project_id,idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS fahima_v2_opening_balances (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('cash','customer_receivable','supplier_payable')), amount REAL NOT NULL,
      party_id INTEGER, effective_date TEXT NOT NULL, description TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      UNIQUE(project_id,idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS fahima_v2_sales_scope_idx ON fahima_v2_sales(project_id,effective_date);
    CREATE INDEX IF NOT EXISTS fahima_v2_customer_payments_scope_idx ON fahima_v2_customer_payments(project_id,effective_date);
  `);
  const outcomeColumns=new Set(db.prepare('PRAGMA table_info(fahima_v2_plan_outcomes)').all().map(row=>row.name));
  if(!outcomeColumns.has('idempotency_key'))db.exec('ALTER TABLE fahima_v2_plan_outcomes ADD COLUMN idempotency_key TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS fahima_v2_outcome_idem_idx ON fahima_v2_plan_outcomes(project_id,idempotency_key) WHERE idempotency_key IS NOT NULL');
  const saleColumns = new Set(db.prepare('PRAGMA table_info(fahima_v2_sales)').all().map(row => row.name));
  if (!saleColumns.has('unit_cost')) db.exec('ALTER TABLE fahima_v2_sales ADD COLUMN unit_cost REAL');
}

module.exports = { openDatabase, ensureBaseTables, ensureRuntimeTables };
