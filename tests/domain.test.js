const test = require('node:test');
const assert = require('node:assert/strict');
const { revenue, budget } = require('../src/domain/finance/calculator');
const { createTransactionService } = require('../src/domain/finance/transaction-service');
const { createMemoryService } = require('../src/memory/memory-service');
const { createTaskManager } = require('../src/agent/task-manager');
const { createTestDb } = require('./helpers');

test('deterministic money calculations reject missing and unsupported amounts', () => {
  assert.equal(revenue(3, 2.5), 7.5);
  assert.throws(() => budget([], 100), /بنود التكلفة/);
  assert.throws(() => budget([{ quantity: 1, unitCost: Number.NaN }], 100), /تكلفة صحيحتين/);
  assert.deepEqual(budget([{ quantity: 2, unitCost: 10 }], 100, 5).remaining, 75);
});

test('actual records are project-scoped and idempotent', () => {
  const db = createTestDb();
  const projectId = Number(db.prepare('INSERT INTO projects(name) VALUES(?)').run('أ').lastInsertRowid);
  const service = createTransactionService(db);
  const input = { type: 'income', amount: 12.5, date: '2026-10-09', description: 'بيع فعلي', idempotencyKey: 'task-1:transaction:1' };
  const first = service.record(projectId, input);
  const retry = service.record(projectId, input);
  assert.equal(first.id, retry.id);
  assert.equal(retry.duplicate, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM transactions WHERE project_id=?').get(projectId).n, 1);
  db.close();
});

test('project memory stays scoped and preserves revision history', () => {
  const db = createTestDb();
  const first = Number(db.prepare('INSERT INTO projects(name) VALUES(?)').run('مشروع أ').lastInsertRowid);
  const second = Number(db.prepare('INSERT INTO projects(name) VALUES(?)').run('مشروع ب').lastInsertRowid);
  const conversation = Number(db.prepare('INSERT INTO conversations(project_id) VALUES(?)').run(first).lastInsertRowid);
  const memory = createMemoryService(db);
  memory.saveFact(first, 'capital', '1000', 'user');
  memory.saveFact(first, 'capital', '1500', 'correction');
  assert.equal(memory.context(first, conversation).facts[0].value, '1500');
  assert.equal(memory.context(second, Number(db.prepare('INSERT INTO conversations(project_id) VALUES(?)').run(second).lastInsertRowid)).facts.length, 0);
  assert.equal(db.prepare("SELECT revision FROM fahima_v2_facts WHERE project_id=? AND fact_key='capital'").get(first).revision, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM fahima_v2_fact_history WHERE project_id=?').get(first).n, 1);
  db.close();
});

test('task lease expires and permits safe recovery claim', async () => {
  const db = createTestDb();
  const projectId = Number(db.prepare('INSERT INTO projects(name) VALUES(?)').run('مشروع').lastInsertRowid);
  const conversationId = Number(db.prepare('INSERT INTO conversations(project_id) VALUES(?)').run(projectId).lastInsertRowid);
  const tasks = createTaskManager(db, { leaseMs: 10 });
  const id = tasks.create({ projectId, conversationId, objective: 'تجربة' });
  assert.ok(tasks.claim(id, 'worker-a'));
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.ok(tasks.claim(id, 'worker-b'));
  db.close();
});
