const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgent } = require('../src/agent/agent');
const { createTestDb, toolCall, waitForTask } = require('./helpers');

test('agent exposes market search but no project-plan creation tools', async () => {
  const db = createTestDb();
  const projectId = Number(db.prepare('INSERT INTO projects(name,capital) VALUES(?,?)').run('اختبار البحث', 1000).lastInsertRowid);
  const conversationId = Number(db.prepare('INSERT INTO conversations(project_id) VALUES(?)').run(projectId).lastInsertRowid);
  const retrievedAt = new Date().toISOString();
  const url = 'https://example.test/offer';
  const agent = createAgent({
    db,
    config: { taskMaxDecisions: 3, taskMaxTools: 3, taskTimeoutMs: 5000, leaseMs: 5000 },
    model: { decide: async () => { throw new Error('not used'); } },
    search: async () => ({ provider: 'serper', receivedAt: retrievedAt, resultCount: 1, results: [{ title: 'عبوة', snippet: '20 EGP', price: '20 EGP', date: '', url }] }),
  });
  assert.equal(agent.registry.has('search_market'), true);
  assert.equal(agent.registry.has('deliver_business_plan'), false);
  assert.equal(agent.registry.has('calculate_startup_budget'), false);
  assert.equal(agent.registry.has('update_plan_step'), false);
  assert.equal(agent.registry.has('record_plan_outcome'), false);
  const taskId = agent.tasks.create({ projectId, conversationId, objective: 'بحث سعر منتج' });
  agent.tasks.claim(taskId);
  const context = { projectId, conversationId, task: { id: taskId }, memory: agent.memory.context(projectId, conversationId), observations: [], isProjectAuthorized: true, toolSequence: 1 };
  const result = await agent.registry.execute({ name: 'search_market', input: { query: 'عبوة', location: 'القاهرة', searchType: 'shopping' }, context });
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  assert.equal(result.output.resultCount, 1);
  assert.deepEqual(db.prepare('SELECT source_url,retrieved_at FROM fahima_v2_research').all(), [{ source_url: url, retrieved_at: retrievedAt }]);
  db.close();
});
test('a missing Gemini key fails as a controlled unavailable error', () => {
  const { createGeminiModel } = require('../src/llm/gemini-client');
  assert.throws(() => createGeminiModel({ geminiApiKey: '' }), error => error.code === 'GEMINI_NOT_CONFIGURED');
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

test('plan requests are answered without creating a plan', async () => {
  const db = createTestDb();
  const projectId = Number(db.prepare('INSERT INTO projects(name) VALUES(?)').run('بدون خطة').lastInsertRowid);
  const conversationId = Number(db.prepare('INSERT INTO conversations(project_id) VALUES(?)').run(projectId).lastInsertRowid);
  const model = { decide: async () => toolCall('deliver_response', { taskType: 'question', answer: 'إنشاء خطة مشروع غير متاح. أقدر أساعدك في البحث والحسابات والقرارات التشغيلية.', status: 'COMPLETE' }) };
  const agent = createAgent({ db, config: { taskMaxDecisions: 3, taskMaxTools: 3, taskTimeoutMs: 5000, leaseMs: 5000 }, model, search: async () => ({ results: [] }) });
  const accepted = await agent.run({ projectId, conversationId, message: 'اعملي خطة للمشروع.', requestId: 'no-plan-1' });
  const final = await waitForTask(agent, accepted.taskId, projectId);
  assert.equal(final.status, 'COMPLETE', JSON.stringify({ error: final.error, result: final.result_json }));
  assert.match(JSON.parse(final.result_json).answer, /خطة مشروع غير متاح/);
  assert.equal(agent.plans.latest(projectId), null);
  db.close();
});
