const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgent } = require('../src/agent/agent');
const { createTestDb, toolCall, waitForTask } = require('./helpers');

test('Gemini observes a calculation before choosing plan persistence, and revisions reuse project context', async () => {
  const db = createTestDb();
  const projectId = Number(db.prepare('INSERT INTO projects(name,activity,capital) VALUES(?,?,?)').run('مشروع تجريبي','تجارة',1000).lastInsertRowid);
  const conversationId = Number(db.prepare('INSERT INTO conversations(project_id,title) VALUES(?,?)').run(projectId,'محادثة').lastInsertRowid);
  const plan = { objective: 'بدء نشاط تجاري صغير', assumptions: ['التكاليف المذكورة تقديرات أولية'], steps: ['اختبار الطلب قبل التوسع'], risks: ['تغير الأسعار'], missingInformation: [], budget: { items: [{ name: 'مستلزمات', quantity: 2, unitCost: 100, totalCost: 200 }], subtotal: 200, reserve: 50, total: 250, capital: 1000, remaining: 750 } };
  let decision = 0;
  let toolObservationSeen = false;
  let activePlanSeen = false;
  const model = { async decide({ contents }) {
    decision++;
    if (decision === 1) return toolCall('calculate_startup_budget', { capital: 1000, reserve: 50, reserveRationale: 'احتياطي مبدئي لمواجهة تفاوت تكلفة التوريد.', items: [{ name: 'مستلزمات', quantity: 2, unitCost: 100, basis: 'user_provided' }] });
    if (decision === 2) {
      toolObservationSeen = contents.some(message => message.parts?.some(part => part.functionResponse?.name === 'calculate_startup_budget' && part.functionResponse.response.status === 'succeeded'));
      return toolCall('deliver_business_plan', { plan, answer: 'دي خطة مبدئية قابلة للتعديل.', status: 'PROVISIONAL' });
    }
    const context = JSON.parse(contents[0].parts[0].text.split('\n').slice(1).join('\n'));
    activePlanSeen = context.activePlan?.body?.objective === plan.objective;
    return toolCall('deliver_business_plan', { plan: { ...plan, steps: ['اختبار الطلب', 'مراجعة المصروفات أسبوعيًا'] }, answer: 'عدلت الخطوات بناءً على طلبك.', status: 'PROVISIONAL' });
  } };
  const agent = createAgent({ db, config: { taskMaxDecisions: 5, taskMaxTools: 5, taskTimeoutMs: 5000, leaseMs: 5000 }, model, search: async () => ({ resultCount: 0 }) });
  const first = await agent.run({ projectId, conversationId, message: 'احسبي الميزانية واعملي خطة.', requestId: 'test-plan-1' });
  const completed = await waitForTask(agent, first.taskId, projectId);
  assert.equal(completed.status, 'PROVISIONAL', JSON.stringify({ error: completed.error, result: completed.result_json }));
  assert.equal(toolObservationSeen, true);
  assert.equal(agent.plans.latest(projectId).revision, 1);
  const second = await agent.run({ projectId, conversationId, message: 'عدلي الخطة.', requestId: 'test-plan-2' });
  const revised = await waitForTask(agent, second.taskId, projectId);
  assert.equal(revised.status, 'PROVISIONAL', JSON.stringify({ error: revised.error, result: revised.result_json }));
  assert.equal(activePlanSeen, true);
  assert.equal(agent.plans.latest(projectId).revision, 2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE role='assistant'").get().n, 2);
  db.close();
});

test('a missing Gemini key fails as a controlled unavailable error', () => {
  const { createGeminiModel } = require('../src/llm/gemini-client');
  assert.throws(() => createGeminiModel({ geminiApiKey: '' }), error => error.code === 'GEMINI_NOT_CONFIGURED');
});

test('saved search evidence and deterministic calculator outputs are consumed by validated plan delivery', async () => {
  const db = createTestDb();
  const projectId = Number(db.prepare('INSERT INTO projects(name,capital) VALUES(?,?)').run('اختبار مصادر',1000).lastInsertRowid);
  const conversationId = Number(db.prepare('INSERT INTO conversations(project_id) VALUES(?)').run(projectId).lastInsertRowid);
  const retrievedAt = new Date().toISOString();
  const url = 'https://example.test/offer';
  const agent = createAgent({ db, config: { taskMaxDecisions: 5, taskMaxTools: 5, taskTimeoutMs: 5000, leaseMs: 5000 }, model: { decide: async () => { throw new Error('not used'); } }, search: async () => ({ provider: 'serper', receivedAt: retrievedAt, resultCount: 1, results: [{ title: 'عبوة صيانة للهواتف', snippet: 'عرض 20 EGP لكل عبوة', price: '20 EGP', date: '', url }] }) });
  const taskId = agent.tasks.create({ projectId, conversationId, objective: 'خطة اختبار' });
  agent.tasks.claim(taskId);
  const context = { projectId, conversationId, task: { id: taskId }, memory: agent.memory.context(projectId, conversationId), observations: [], isProjectAuthorized: true, toolSequence: 1 };
  const search = await agent.registry.execute({ name: 'search_market', input: { query: 'عبوة صيانة', location: 'القاهرة', searchType: 'shopping' }, context });
  assert.equal(search.status, 'succeeded', JSON.stringify(search));
  context.observations.push({ tool: 'search_market', observation: search });
  context.toolSequence++;
  const calculation = await agent.registry.execute({ name: 'calculate_startup_budget', input: { capital: 1000, reserve: 50, reserveRationale: 'احتياطي مبدئي لمصاريف نقل غير محسومة.', items: [{ name: 'عبوة صيانة', quantity: 1, unitCost: 20, basis: 'researched' }] }, context });
  context.observations.push({ tool: 'calculate_startup_budget', observation: calculation });
  assert.equal(require('../src/tools/register-tools').priceSupported(db, projectId, taskId, { product: 'عبوة صيانة', amount: 20, unit: 'عبوة', sourceUrl: url, observedAt: retrievedAt }), true);
  assert.deepEqual(db.prepare('SELECT source_url,retrieved_at,result_json FROM fahima_v2_research').all().map(row => ({ url: row.source_url, retrievedAt: row.retrieved_at, item: JSON.parse(row.result_json) })), [{ url, retrievedAt, item: { title: 'عبوة صيانة للهواتف', snippet: 'عرض 20 EGP لكل عبوة', price: '20 EGP', date: '', url } }]);
  const delivery = await agent.registry.execute({ name: 'deliver_business_plan', input: { plan: { objective: 'بدء بيع عبوات صيانة', assumptions: [], steps: ['اختبار مورد واحد'], risks: ['سعر المصدر قد يتغير'], missingInformation: ['يلزم التحقق من أكثر من مورد'], budget: {}, prices: [{ product: 'عبوة صيانة', amount: 20, unit: 'عبوة', sourceUrl: url, observedAt: retrievedAt }] }, answer: 'خطة مبدئية بمصدر بحث وحساب محفوظين.', status: 'COMPLETE' }, context });
  assert.equal(delivery.status, 'succeeded', JSON.stringify(delivery));
  assert.equal(delivery.output.terminalResult.status, 'PROVISIONAL');
  assert.equal(delivery.output.terminalResult.plan.plan.budget.total, 70);
  assert.equal(delivery.output.terminalResult.plan.plan.prices[0].amount, 20);
  assert.equal(delivery.output.terminalResult.plan.plan.sources[0].url, url);
  db.close();
});

test('transient model failure resumes with persisted tool observation and does not repeat the calculation', async () => {
  const db = createTestDb();
  const projectId = Number(db.prepare('INSERT INTO projects(name) VALUES(?)').run('اختبار استعادة').lastInsertRowid);
  const conversationId = Number(db.prepare('INSERT INTO conversations(project_id) VALUES(?)').run(projectId).lastInsertRowid);
  let decision = 0;
  let resumedWithObservation = false;
  const model = { async decide({ contents }) {
    decision++;
    if (decision === 1) return toolCall('calculate_revenue', { quantity: 4, unitPrice: 5 });
    if (decision === 2) { const error = new Error('simulated transient model timeout'); error.name = 'TimeoutError'; throw error; }
    resumedWithObservation = contents.some(message => message.parts?.some(part => part.functionResponse?.name === 'calculate_revenue' && part.functionResponse.response.output.revenue === 20));
    return toolCall('deliver_response', { taskType: 'question', answer: 'الإيراد المحسوب 20 جنيه.', status: 'COMPLETE' });
  } };
  const agent = createAgent({ db, config: { taskMaxDecisions: 4, taskMaxTools: 3, taskTimeoutMs: 10000, leaseMs: 5000 }, model, search: async () => ({ results: [] }) });
  const accepted = await agent.run({ projectId, conversationId, message: 'احسبي أربعة في خمسة.', requestId: 'recovery-case-1' });
  const final = await waitForTask(agent, accepted.taskId, projectId, 4000);
  assert.equal(final.status, 'COMPLETE');
  assert.equal(resumedWithObservation, true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM fahima_v2_observations WHERE task_id=? AND tool_name='calculate_revenue'").get(final.id).n, 1);
  const metrics = JSON.parse(final.result_json).metrics;
  assert.equal(decision, 3);
  assert.equal(metrics.decisions, 2);
  assert.ok(metrics.elapsedMs >= 900);
  db.close();
});

test('task can wait for input while a validated provisional plan remains available', async () => {
  const db = createTestDb();
  const projectId = Number(db.prepare('INSERT INTO projects(name) VALUES(?)').run('خطة ناقصة').lastInsertRowid);
  const conversationId = Number(db.prepare('INSERT INTO conversations(project_id) VALUES(?)').run(projectId).lastInsertRowid);
  const plan = { objective: 'بدء نشاط مناسب', assumptions: [], steps: ['تحديد المورد بعد معرفة المدينة'], risks: ['اختلاف الأسعار حسب المكان'], missingInformation: ['موقع المشروع'] };
  const model = { decide: async () => toolCall('deliver_business_plan', { plan, answer: 'الخطة المبدئية جاهزة، محتاجة أعرف المشروع في أي مدينة عشان أحدد الموردين.', status: 'WAITING_FOR_INPUT' }) };
  const agent = createAgent({ db, config: { taskMaxDecisions: 3, taskMaxTools: 3, taskTimeoutMs: 5000, leaseMs: 5000 }, model, search: async () => ({ results: [] }) });
  const accepted = await agent.run({ projectId, conversationId, message: 'ساعديني أبدأ مشروع.', requestId: 'waiting-plan-1' });
  const final = await waitForTask(agent, accepted.taskId, projectId);
  assert.equal(final.status, 'WAITING_FOR_INPUT', JSON.stringify({ error: final.error, result: final.result_json, observations: db.prepare('SELECT outcome_json FROM fahima_v2_observations WHERE task_id=?').all(final.id) }));
  assert.equal(agent.plans.latest(projectId).quality_status, 'PROVISIONAL');
  assert.equal(JSON.parse(final.result_json).plan.qualityStatus, 'PROVISIONAL');
  db.close();
});
