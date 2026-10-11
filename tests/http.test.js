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
    assert.equal(report.totals.other_income.confirmed, 100);
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

test('market search remains available through the HTTP chat path without creating plans', async () => {
  const db=createTestDb();
  const projectId=Number(db.prepare('INSERT INTO projects(name) VALUES(?)').run('بحث واجهة').lastInsertRowid);
  const conversationId=Number(db.prepare('INSERT INTO conversations(project_id) VALUES(?)').run(projectId).lastInsertRowid);
  let decisions=0;
  const model={decide:async()=>{ decisions++; if(decisions===1)return toolCall('search_market',{query:'سعر عبوة',location:'القاهرة',searchType:'search'}); return toolCall('deliver_response',{taskType:'question',answer:'لقيت نتيجة بحث مناسبة.',status:'COMPLETE'}); }};
  const config={root:path.resolve(__dirname,'..'),taskMaxDecisions:2,taskMaxTools:2,taskTimeoutMs:5000,leaseMs:5000};
  const agent=createAgent({db,config,model,search:async()=>({provider:'serper',receivedAt:new Date().toISOString(),resultCount:1,results:[{title:'عبوة',snippet:'20 EGP',price:'20 EGP',url:'https://example.test/offer'}]})});const app=createApp({db,config,agent});const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  try{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({projectId,conversationId,message:'ابحثي عن سعر عبوة',requestId:'search-http'})});const accepted=await response.json();const final=await waitForTask(agent,accepted.taskId,projectId);assert.equal(final.status,'COMPLETE',JSON.stringify(final));assert.equal(db.prepare('SELECT COUNT(*) n FROM fahima_v2_research WHERE project_id=?').get(projectId).n,1);assert.equal(agent.plans.latest(projectId),null);}finally{await new Promise(resolve=>server.close(resolve));db.close();}
});

test('project report PDF is generated from the scoped ledger report', async () => {
  const db=createTestDb();
  const projectId=Number(db.prepare('INSERT INTO projects(name) VALUES(?)').run('تقرير').lastInsertRowid);
  db.prepare('INSERT INTO transactions(project_id,type,amount,date,description) VALUES(?,?,?,?,?)').run(projectId,'income',75,'2026-10-10','بيع');
  const config={root:path.resolve(__dirname,'..')};
  const agent=createAgent({db,config,model:{decide:async()=>toolCall('deliver_response',{taskType:'question',answer:'تمام',status:'COMPLETE'})},search:async()=>({results:[]})});
  const app=createApp({db,config,agent});const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  try { const response=await fetch(`http://127.0.0.1:${server.address().port}/api/projects/${projectId}/report.pdf?from=2026-10-10&to=2026-10-10`); const bytes=Buffer.from(await response.arrayBuffer()); assert.equal(response.status,200); assert.equal(response.headers.get('content-type'),'application/pdf'); assert.match(bytes.subarray(0,8).toString(),/^%PDF-1\./); assert.ok(bytes.toString('latin1').includes('%%EOF')); } finally { await new Promise(resolve=>server.close(resolve)); db.close(); }
});

test('project deletion is explicit and cascades only the selected project', async () => {
  const db=createTestDb(); const first=Number(db.prepare('INSERT INTO projects(name) VALUES(?)').run('يمسح').lastInsertRowid); const second=Number(db.prepare('INSERT INTO projects(name) VALUES(?)').run('يبقى').lastInsertRowid);
  const config={root:path.resolve(__dirname,'..')}; const agent=createAgent({db,config,model:{decide:async()=>toolCall('deliver_response',{taskType:'question',answer:'تمام',status:'COMPLETE'})},search:async()=>({results:[]})}); const app=createApp({db,config,agent}); const server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
  try { const response=await fetch(`http://127.0.0.1:${server.address().port}/api/projects/${first}`,{method:'DELETE'}); assert.equal(response.status,200); assert.equal(db.prepare('SELECT COUNT(*) n FROM projects WHERE id=?').get(first).n,0); assert.equal(db.prepare('SELECT COUNT(*) n FROM projects WHERE id=?').get(second).n,1); } finally { await new Promise(resolve=>server.close(resolve)); db.close(); }
});

test('conversational PDF export tool uses the same scoped ledger totals', async () => {
  const db=createTestDb(); const projectId=Number(db.prepare('INSERT INTO projects(name) VALUES(?)').run('تقرير محادثة').lastInsertRowid); const conversationId=Number(db.prepare('INSERT INTO conversations(project_id) VALUES(?)').run(projectId).lastInsertRowid);
  const config={root:path.resolve(__dirname,'..')}; const agent=createAgent({db,config,model:{decide:async()=>toolCall('deliver_response',{taskType:'question',answer:'تمام',status:'COMPLETE'})},search:async()=>({results:[]})});
  const result=await agent.registry.execute({name:'request_pdf_report',input:{from:'2026-10-01',to:'2026-10-10'},context:{projectId,conversationId,task:{id:'pdf-task'},isProjectAuthorized:true}});
  assert.equal(result.status,'succeeded'); assert.equal(result.output.report.downloadReady,true); assert.equal(result.output.report.summary.invoicedSales,0); db.close();
});
