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
      assert.equal(pending.body.kind, 'saved');
      assert.equal(count('transactions'), 1);
      assert.equal(count('products'), 1);
      const result = pending;
      assert.equal(result.body.kind, 'saved');
      assert.equal(result.body.transaction.amount, 100);
      assert.equal(result.body.reply,'تمام، سجلت شراء بضاعة بـ١٠٠ جنيه.');
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
      const saved = await chat({ intent: 'record_transaction', transaction_type: 'stock_cost', product_name: name, amount: 217, amount_kind: 'total', description: 'شراء' });
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
      assert.equal(result.body.kind, 'saved');
      assert.equal(result.body.transaction.amount, 60);
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
        tx({ transaction_type: 'income', amount: 0, product_name: randomUUID(), quantity: 1, unit: randomUUID() }),
      ] });
      assert.equal(result.body.kind, 'clarify');
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

    await t.test('incomplete unit price is resolved from the next answer and recorded without confirmation', async () => {
      await freshConversation();
      const product = `بيض ${randomUUID()}`;
      const unit = `بيضة ${randomUUID().slice(0,8)}`;
      const incomplete = await chat({ intent: 'record_transaction', transaction_type: 'income', amount: null,
        product_name: product, quantity: 5, unit }, 'أنا بعت ٥ بيضات');
      assert.equal(incomplete.body.kind, 'clarify');
      assert.equal(incomplete.body.pending.payload.waiting_for, 'unit_price');
      assert.equal(incomplete.body.reply, `٥ ${unit} ${product} اتباعوا بكام كلهم؟`);
      assert.equal((incomplete.body.reply.match(/[؟?]/gu)||[]).length,1);
      next = interpreted({ intent: 'record_transaction', transaction_type: null, amount: 5 });
      const completed = await api('/api/chat', { projectId, conversationId, message: '٥', requestId: randomUUID() });
      assert.equal(completed.body.kind, 'saved');
      assert.equal(completed.body.transaction.amount, 25);
      assert.equal(db.prepare('SELECT quantity FROM transaction_items WHERE transaction_id=?').get(completed.body.transaction.id).quantity, 5);
      assert.match(completed.body.reply,/٢٥/u);
      assert.equal(completed.body.transaction.inventory_tracked,false);
    });

    await t.test('unit price alone needs quantity, and impossible dates are not replaced with today', async () => {
      await freshConversation();
      let result = await chat({ intent: 'record_transaction', transaction_type: 'stock_cost', amount: 20,
        amount_kind: 'unit_price', product_name: randomUUID(), unit: randomUUID() });
      assert.equal(result.body.pending.payload.waiting_for, 'quantity');
      result = await chat({ intent: 'record_transaction', quantity: 4 });
      assert.equal(result.body.kind, 'saved');
      assert.equal(result.body.transaction.amount, 80);
      await freshConversation();
      result = await chat({ intent: 'record_transaction', transaction_type: 'operating_expense', amount: 15,
        amount_kind: 'total', date: '2026-02-30' });
      assert.equal(result.body.kind, 'clarify');
      assert.equal(result.body.pending.payload.waiting_for, 'date');
      result = await chat({ intent: 'price_estimate', amount: 25, markup_percent: null });
      assert.equal(result.body.kind, 'clarify');
    });

    await t.test('unambiguous correction and undo are audited and update reports without deleting history', async () => {
      await freshConversation();
      const name=`بيض ${randomUUID()}`,unit=`بيضة ${randomUUID().slice(0,8)}`;
      const sale=await chat({intent:'record_transaction',transaction_type:'income',amount:25,amount_kind:'total',
        product_name:name,quantity:5,unit,description:'بيع بيض'});
      next=interpreted({intent:'correct_transaction',transaction_type:'income',product_name:name,amount:30,amount_kind:'total',quantity:5,unit,description:'تصحيح البيع'});
      const corrected=await api('/api/chat',{projectId,conversationId,message:'البيض كان بـ٦ للواحدة',requestId:randomUUID()});
      assert.equal(corrected.body.kind,'saved');assert.equal(corrected.body.reply.includes('٣٠'),true);
      assert.equal(db.prepare('SELECT amount FROM transactions WHERE id=?').get(sale.body.transaction.id).amount,30);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM transaction_audit WHERE transaction_id=? AND action=?').get(sale.body.transaction.id,'correction').n,1);
      next=interpreted({intent:'undo_transaction',transaction_type:'income',product_name:name,transaction_reference:'latest'});
      const undone=await api('/api/chat',{projectId,conversationId,message:'امسحي آخر عملية بيض',requestId:randomUUID()});
      assert.equal(undone.body.kind,'saved');
      assert.equal(db.prepare('SELECT voided_at FROM transactions WHERE id=?').get(sale.body.transaction.id).voided_at!==null,true);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM transaction_audit WHERE transaction_id=? AND action=?').get(sale.body.transaction.id,'undo').n,1);
      assert.equal(B.getTransactions(projectId,'0001-01-01',B.localDate()).some(row=>row.id===sale.body.transaction.id),false);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM transactions WHERE id=?').get(sale.body.transaction.id).n,1);
    });

    await t.test('completed batch saves every operation immediately and duplicate request IDs do not duplicate it', async () => {
      await freshConversation();
      const item = (type, amount) => ({ transaction_type: type, amount, amount_kind: 'total', date: B.localDate(),
        description: randomUUID(), estimated: false, product_name: null, quantity: null, unit: null, unit_price: null });
      const before = count('transactions');
      const body = { projectId, conversationId, message: 'تم بيع ٨٥ جنيه ودفع ١٧ جنيه مصروف', requestId: randomUUID() };
      next=interpreted({ intent: 'record_transactions', transactions: [item('income', 85), item('operating_expense', 17)] });
      const saved = await api('/api/chat', body);
      assert.equal(saved.body.transactions.length, 2);
      assert.equal(count('transactions'), before + 2);
      const repeated = await api('/api/chat', body);
      assert.deepEqual(repeated.body.transactions, saved.body.transactions);
      assert.equal(count('transactions'), before + 2);
    });

    await t.test('reminder asks for missing details then saves the requested reminder directly', async () => {
      await freshConversation();
      const title = randomUUID();
      let result = await chat({ intent: 'create_reminder', reminder_title: title });
      assert.equal(result.body.kind, 'clarify');
      assert.equal(count('reminders'), 0);
      result = await chat({ intent: 'create_reminder', due_date: B.localDate() });
      assert.equal(result.body.kind, 'saved');
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
    await app.locals.agentTasks.close();
    await new Promise(resolve => server.close(resolve));
    db.close();
    if (oldPath === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = oldPath;
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
