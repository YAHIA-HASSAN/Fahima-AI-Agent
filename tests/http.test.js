const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTestDb, toolCall, waitForTask } = require('./helpers');
const { createAgent } = require('../src/agent/agent');
const { createApp } = require('../src/server/app');

test('text and transcribed voice use the same chat agent with durable delivery and project scope', async () => {
  const db = createTestDb();
  const projectId = Number(db.prepare('INSERT INTO projects(name) VALUES(?)').run('واجهة اختبار').lastInsertRowid);
  const otherProjectId = Number(db.prepare('INSERT INTO projects(name) VALUES(?)').run('مشروع آخر').lastInsertRowid);
  db.prepare('INSERT INTO transactions(project_id,type,amount,date,description) VALUES(?,?,?,?,?)').run(projectId,'income',100,'2026-10-09','بيع');
  db.prepare('INSERT INTO transactions(project_id,type,amount,date,description) VALUES(?,?,?,?,?)').run(otherProjectId,'operating_expense',9000,'2026-10-09','مصروف مشروع آخر');
  const model = { decide: async () => toolCall('deliver_response', { taskType: 'question', answer: 'الإجابة من محرك فهيمة.', status: 'COMPLETE' }) };
  const config = { root: path.resolve(__dirname, '..'), taskMaxDecisions: 3, taskMaxTools: 3, taskTimeoutMs: 5000, leaseMs: 5000 };
  const agent = createAgent({ db, config, model, search: async () => ({ results: [], receivedAt: new Date().toISOString() }) });
  const app = createApp({ db, config, agent });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const submitted = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId, message: 'سؤال تجريبي من الصوت', inputMode:'voice', requestId: 'http-request-1' }) });
    assert.equal(submitted.status, 202);
    const queued = await submitted.json();
    assert.equal(queued.status, 'QUEUED');
    const finalTask = await waitForTask(agent, queued.taskId, projectId);
    assert.equal(finalTask.status, 'COMPLETE');
    const messagesResponse = await fetch(`${base}/api/conversations/${queued.conversationId}/messages?projectId=${projectId}`);
    const messages = await messagesResponse.json();
    assert.deepEqual(messages.messages.map(row => row.role), ['user', 'assistant']);
    assert.equal(messages.messages.at(-1).content, 'الإجابة من محرك فهيمة.');
    assert.equal(messages.messages[0].input_type,'voice');
    const reportResponse = await fetch(`${base}/api/projects/${projectId}/report?from=2026-10-09&to=2026-10-09`);
    const report = await reportResponse.json();
    assert.equal(report.totals.income.confirmed, 100);
    assert.equal(report.totals.operating_expense, undefined);
    assert.equal(Object.hasOwn(report, 'profit'), false);
    const duplicate = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId, message: 'سؤال تجريبي', requestId: 'http-request-1' }) });
    assert.equal((await duplicate.json()).taskId, queued.taskId);
    const conflict = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: otherProjectId, message: 'طلب خارج النطاق', requestId: 'http-request-1' }) });
    assert.equal(conflict.status, 409);
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
});
