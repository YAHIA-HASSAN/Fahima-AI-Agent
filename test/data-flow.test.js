const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const agent = require('../server/agent');

function interpreted(fields = {}) {
  return { transaction_status:'actual', intent: 'question', transactions: [], transaction_type: null, amount: null,
    amount_kind: null, date: '', period: 'today', description: '', estimated: false,
    product_name: null, quantity: null, unit: null, unit_price: null, markup_percent: null,
    reminder_title: null, due_date: null, fact_key: null, fact_value: null, answer: '', ...fields };
}

test('validates untrusted LLM structure and rejects invented fields and invalid types', () => {
  assert.equal(agent.validateAgentResponse(interpreted()).intent, 'question');
  for (const fields of [{ amount: '500' }, { quantity: Infinity }, { projectId: 2 },
    { product_name: {} }, { intent: 'execute_sql' }, { transaction_type: 'profit' },
    { transactions: [null] }]) {
    assert.throws(() => agent.validateAgentResponse(interpreted(fields)));
  }
  assert.throws(() => agent.validateAgentResponse(null));
  assert.throws(() => agent.validateAgentResponse({ intent: 'question' }));
});

test('HTTP business data comes from confirmed LLM fields and scoped SQLite records', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fahima-data-flow-'));
  const oldPath = process.env.DB_PATH;
  const oldKey = process.env.GEMINI_API_KEY;
  process.env.DB_PATH = path.join(dir, 'test.sqlite');
  process.env.GEMINI_API_KEY = 'test-key';
  for (const module of ['../server/db', '../server/business', '../server/index']) delete require.cache[require.resolve(module)];
  const app = require('../server/index');
  const db = require('../server/db');
  const B = require('../server/business');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let next = interpreted();
  let prompt = '';
  let providerError = null;
  agent.__setGeminiClientForTests({ interactions: { async create(request) {
    prompt = request.input;
    if (providerError) throw providerError;
    return { output_text: JSON.stringify(next) };
  } } });
  async function api(route, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  const count = table => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
  try {
    assert.equal(count('projects'), 0);
    assert.equal(B.getProject(1), null);
    assert.equal(count('projects'), 0);
    const first = (await api('/api/projects', { name: randomUUID() })).body.project;
    const second = (await api('/api/projects', { name: randomUUID() })).body.project;
    const projectId = second.id;
    let conversationId;
    async function freshConversation() {
      conversationId = (await api('/api/conversation/new', { projectId })).body.conversation.id;
    }
    async function chat(fields, message = 'تفاصيل العملية', requestId = randomUUID()) {
      next = interpreted(fields);
      return api('/api/chat', { projectId, conversationId, message, requestId });
    }
    const confirm = () => api('/api/chat', { projectId, conversationId, message: 'أيوه', requestId: randomUUID() });
    const productName = `صنف ${randomUUID()}`;
    const unit = `عبوة ${randomUUID().slice(0,8)}`;

    await t.test('new arbitrary product and fractional unit cost preserve confirmed total', async () => {
      await freshConversation();
      const pending = await chat({ intent: 'record_transaction', transaction_type: 'stock_cost', amount: 100,
        amount_kind: 'total', product_name: productName, quantity: 3, unit, description: 'شراء جديد' });
      assert.equal(pending.body.kind, 'confirm');
      assert.equal(count('transactions'), 0);
      assert.equal(count('products'), 0);
      const result = await confirm();
      assert.equal(result.body.kind, 'saved');
      assert.equal(result.body.transaction.amount, 100);
      assert.equal(result.body.transaction.project_id, projectId);
      assert.equal(B.getProducts(first.id).length, 0);
      const product = B.getProducts(projectId)[0];
      assert.equal(product.name, productName);
      assert.equal(product.unit, unit);
      assert.equal(product.current_quantity, 3);
      assert.equal(product.unit_cost, 100 / 3);
      assert.equal(db.prepare('SELECT line_total FROM transaction_items').get().line_total, 100);
    });

    await t.test('inventory context is selected from database without fixed activity keywords', async () => {
      await freshConversation();
      await chat({ intent: 'inventory_query', product_name: productName }, productName);
      assert.ok(prompt.includes(productName));
      assert.ok(prompt.includes(unit));
      const response = await chat({ intent: 'period_summary', period: 'all', answer: 'أرقام مزيفة 999999' });
      assert.equal(response.body.summary.totals.stock_cost, 100);
      assert.ok(!response.body.reply.includes('999999'));
      const report = await api(`/api/report?projectId=${projectId}&from=${B.localDate()}&to=${B.localDate()}`);
      assert.equal(report.body.summary.totals.stock_cost, 100);
      assert.equal(report.body.transactions.length, 1);
    });

    await t.test('total-only purchase stores its name without inventing stock quantity', async () => {
      await freshConversation();
      const name = randomUUID();
      await chat({ intent: 'record_transaction', transaction_type: 'stock_cost', product_name: name, amount: 217, amount_kind: 'total', description: 'شراء' });
      const saved = await confirm();
      assert.equal(saved.body.transaction.amount, 217);
      assert.ok(saved.body.transaction.description.includes(name));
      assert.equal(count('products'), 1);
      assert.equal(count('inventory_movements'), 1);
    });

    await t.test('missing and invalid details remain pending instead of using default units or values', async () => {
      await freshConversation();
      let result = await chat({ intent: 'record_transaction', transaction_type: 'stock_cost', amount: 60,
        amount_kind: 'total', product_name: randomUUID(), quantity: 2 });
      assert.equal(result.body.kind, 'clarify');
      assert.equal(result.body.pending.payload.waiting_for, 'unit');
      const premature = await api(`/api/pending-actions/${result.body.pending.id}/confirm`, { projectId, conversationId });
      assert.equal(premature.status, 409);
      result = await chat({ intent: 'record_transaction', unit: 'وحدة من رسالة المستخدم' });
      assert.equal(result.body.kind, 'confirm');
      const before = count('transactions');
      const tampered = await api(`/api/pending-actions/${result.body.pending.id}/confirm`, { projectId, conversationId, changes: { amount: 9000 } });
      assert.equal(tampered.status, 400);
      assert.equal(count('transactions'), before);
      await freshConversation();
      result = await chat({ intent: 'record_transaction', transaction_type: 'stock_cost', amount: 10,
        amount_kind: 'total', product_name: randomUUID(), quantity: 0 });
      assert.equal(result.body.kind, 'clarify');
      assert.equal(result.body.pending.payload.waiting_for, 'quantity');
    });

    await t.test('clear facts save automatically and profile clears with them', async () => {
      await freshConversation();
      const activity = randomUUID();
      const result = await chat({ intent: 'project_fact', fact_key: 'activity', fact_value: activity }, `نشاطي ${activity}`);
      assert.equal(result.body.kind, 'advice');
      assert.equal(B.getProject(projectId).activity, activity);
      const fact = db.prepare('SELECT * FROM project_facts WHERE project_id=?').get(projectId);
      assert.equal(fact.value, activity);
      await api(`/api/project-facts/${fact.id}?projectId=${projectId}`, undefined, 'DELETE');
      assert.equal(B.getProject(projectId).activity, null);
    });

    await t.test('batch confirmation is atomic if one stock operation is invalid', async () => {
      await freshConversation();
      const tx = fields => ({ transaction_type: 'stock_cost', amount: 40, amount_kind: 'total', date: B.localDate(), description: 'عملية', estimated: false, product_name: null, quantity: null, unit: null, unit_price: null, ...fields });
      const before = count('transactions');
      const products = count('products');
      const result = await chat({ intent: 'record_transactions', transactions: [
        tx({ product_name: randomUUID(), quantity: 2, unit: randomUUID() }),
        tx({ transaction_type: 'income', product_name: randomUUID(), quantity: 1, unit: randomUUID() }),
      ] });
      assert.equal(result.body.kind, 'confirm');
      assert.equal((await confirm()).body.kind, 'clarify');
      assert.equal(count('transactions'), before);
      assert.equal(count('products'), products);
    });

    await t.test('malformed output and provider failures cannot create records', async () => {
      await freshConversation();
      const before = count('transactions');
      assert.equal((await chat({ intent: 'record_transaction', amount: '500' })).status, 503);
      assert.equal(count('transactions'), before);
      providerError = Object.assign(new Error('quota'), { status: 429 });
      assert.equal((await chat({})).body.kind, 'answer');
      providerError = null;
      delete process.env.GEMINI_API_KEY;
      try {
        assert.equal((await chat({ intent: 'record_transaction', transaction_type: 'income', amount: 500 }, 'بعت بخمسمية')).status, 503);
      } finally {
        process.env.GEMINI_API_KEY = 'test-key';
      }
      assert.equal(count('transactions'), before);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM pending_actions WHERE conversation_id=?').get(conversationId).n, 0);
    });

    await t.test('corrected amounts replace derived unit prices before reconfirmation', async () => {
      await freshConversation();
      await chat({ intent: 'record_transaction', transaction_type: 'stock_cost', amount: 100,
        amount_kind: 'total', product_name: randomUUID(), quantity: 3, unit: randomUUID() });
      const updated = await chat({ intent: 'record_transaction', amount: 150, amount_kind: 'total' }, 'صححي المبلغ');
      assert.equal(updated.body.kind, 'confirm');
      assert.equal(updated.body.pending.payload.unitPrice, 50);
      assert.equal((await confirm()).body.transaction.amount, 150);
    });

    await t.test('unit price alone needs quantity, and impossible dates are not replaced with today', async () => {
      await freshConversation();
      let result = await chat({ intent: 'record_transaction', transaction_type: 'stock_cost', amount: 20,
        amount_kind: 'unit_price', product_name: randomUUID(), unit: randomUUID() });
      assert.equal(result.body.pending.payload.waiting_for, 'quantity');
      result = await chat({ intent: 'record_transaction', quantity: 4 });
      assert.equal(result.body.kind, 'confirm');
      assert.equal(result.body.pending.payload.amount, 80);
      await freshConversation();
      result = await chat({ intent: 'record_transaction', transaction_type: 'operating_expense', amount: 15,
        amount_kind: 'total', date: '2026-02-30' });
      assert.equal(result.body.kind, 'clarify');
      assert.equal(result.body.pending.payload.waiting_for, 'date');
      result = await chat({ intent: 'price_estimate', amount: 25, markup_percent: null });
      assert.equal(result.body.kind, 'clarify');
    });

    await t.test('confirmed batch saves every operation and repeated request IDs do not duplicate it', async () => {
      await freshConversation();
      const item = (type, amount) => ({ transaction_type: type, amount, amount_kind: 'total', date: B.localDate(),
        description: randomUUID(), estimated: false, product_name: null, quantity: null, unit: null, unit_price: null });
      const before = count('transactions');
      await chat({ intent: 'record_transactions', transactions: [item('income', 85), item('operating_expense', 17)] });
      assert.equal(count('transactions'), before);
      const body = { projectId, conversationId, message: 'أيوه', requestId: randomUUID() };
      const saved = await api('/api/chat', body);
      assert.equal(saved.body.transactions.length, 2);
      assert.equal(count('transactions'), before + 2);
      const repeated = await api('/api/chat', body);
      assert.deepEqual(repeated.body.transactions, saved.body.transactions);
      assert.equal(count('transactions'), before + 2);
    });

    await t.test('reminder details persist between messages and require confirmation', async () => {
      await freshConversation();
      const title = randomUUID();
      let result = await chat({ intent: 'create_reminder', reminder_title: title });
      assert.equal(result.body.kind, 'clarify');
      assert.equal(count('reminders'), 0);
      result = await chat({ intent: 'create_reminder', due_date: B.localDate() });
      assert.equal(result.body.kind, 'confirm');
      await confirm();
      assert.equal(B.getReminders(projectId)[0].title, title);
      assert.equal(B.getReminders(first.id).length, 0);
    });

    await t.test('direct business writes and missing project scope do not bypass the chat flow', async () => {
      for (const route of ['/api/transactions','/api/products','/api/products/1/adjust','/api/project-facts','/api/pending-actions','/api/reminders']) {
        assert.equal((await api(route, { projectId, conversationId, amount: 500 })).status, 403);
      }
      assert.equal((await api('/api/project', { id: projectId, capital: 1000 }, 'PUT')).status, 403);
      assert.equal((await api('/api/init')).status, 404);
      assert.equal((await api(`/api/conversation?projectId=${first.id}&conversationId=${conversationId}`)).status, 404);
      db.prepare('DELETE FROM projects WHERE id=?').run(first.id);
      assert.equal(B.getProject(first.id), null);
      assert.equal(count('projects'), 1);
    });
  } finally {
    agent.__setGeminiClientForTests(null);
    await new Promise(resolve => server.close(resolve));
    db.close();
    if (oldPath === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = oldPath;
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
