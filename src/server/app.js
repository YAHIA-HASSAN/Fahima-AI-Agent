const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const { createProjectRepository } = require('../database/repositories/project-repository');

function createApp({ db, config, agent, tts }) {
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use(express.static(path.join(config.root, 'src/public')));
  const projects = createProjectRepository(db);
  app.get('/api/projects', (req, res) => res.json({ projects: projects.list() }));
  app.post('/api/projects', (req, res) => {
    try { res.status(201).json({ project: projects.create(req.body?.name) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/api/chat', async (req, res, next) => {
    try {
      const { projectId, conversationId, message, inputMode, requestId } = req.body || {};
      const result = await agent.run({ projectId, conversationId, message, inputMode, requestId: requestId || crypto.randomUUID() });
      res.status(202).json(result);
    } catch (error) { next(error); }
  });
  app.get('/api/tasks/:id', (req, res) => {
    const task = agent.tasks.get(req.params.id, Number(req.query.projectId));
    if (!task) return res.status(404).json({ error: 'المهمة غير موجودة.' });
    const delivery = db.prepare('SELECT assistant_message_id FROM fahima_v2_deliveries WHERE task_id=?').get(task.id);
    const message = delivery ? db.prepare('SELECT id,content,created_at FROM messages WHERE id=?').get(delivery.assistant_message_id) : null;
    res.json({ task: { id: task.id, projectId: task.project_id, conversationId: task.conversation_id, status: task.status, objective: task.objective, result: parse(task.result_json), error: task.error, updatedAt: task.updated_at }, message });
  });
  app.post('/api/tasks/:id/cancel', (req,res)=>{
    const task=agent.tasks.cancel(req.params.id,Number(req.body?.projectId));
    if(!task) return res.status(409).json({error:'المهمة انتهت أو مش موجودة.'});
    agent.orchestrator.notify?.(task.id,{taskId:task.id,status:'CANCELLED',result:{answer:'تم إلغاء المهمة.'}});
    res.json({task:{id:task.id,status:task.status}});
  });
  app.get('/api/tasks/:id/events', (req, res) => {
    const task = agent.tasks.get(req.params.id, Number(req.query.projectId));
    if (!task) return res.status(404).end();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ taskId: task.id, status: task.status, result: parse(task.result_json) })}\n\n`);
    if (['COMPLETE', 'PROVISIONAL', 'WAITING_FOR_INPUT', 'FAILED', 'CANCELLED'].includes(task.status)) return res.end();
    agent.orchestrator.subscribe(task.id, res);
  });
  app.get('/api/conversations/:id/messages', (req, res) => {
    const conversation = db.prepare('SELECT id,project_id FROM conversations WHERE id=?').get(Number(req.params.id));
    if (!conversation || conversation.project_id !== Number(req.query.projectId)) return res.status(404).json({ error: 'المحادثة غير موجودة.' });
    const messages = db.prepare('SELECT id,role,content,input_type,created_at FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 100').all(conversation.id).reverse();
    res.json({ messages });
  });
  app.get('/api/projects/:id/plan', (req, res) => {
    const project = projects.get(req.params.id);
    if (!project) return res.status(404).json({ error: 'المشروع غير موجود.' });
    const plan=agent.plans.latest(project.id);
    res.json({ plan, steps:plan?agent.plans.steps(project.id,plan.revision):[], outcomes:agent.plans.outcomes(project.id) });
  });
  app.get('/api/projects/:id/inventory',(req,res)=>{const id=Number(req.params.id);if(!projects.get(id))return res.status(404).json({error:'المشروع غير موجود.'});res.json({items:agent.inventory.list(id)});});
  app.get('/api/projects/:id/transactions',(req,res)=>{const id=Number(req.params.id);if(!projects.get(id))return res.status(404).json({error:'المشروع غير موجود.'});const rows=db.prepare('SELECT * FROM transactions WHERE project_id=? ORDER BY date DESC,id DESC LIMIT 200').all(id);res.json({transactions:rows.map(row=>({...row,audit:agent.transactions.audit(id,row.id)}))});});
  app.get('/api/projects/:id/report', (req, res) => {
    const projectId = Number(req.params.id);
    if (!projects.get(projectId)) return res.status(404).json({ error: 'المشروع غير موجود.' });
    const from = String(req.query.from || ''), to = String(req.query.to || '');
    if (!validDate(from) || !validDate(to) || from > to) return res.status(400).json({ error: 'اختاري فترة زمنية صحيحة.' });
    const transactions = db.prepare('SELECT id,type,amount,date,description,estimated FROM transactions WHERE project_id=? AND voided_at IS NULL AND date>=? AND date<=? ORDER BY date DESC,id DESC').all(projectId, from, to);
    const inventory = db.prepare('SELECT name,unit,current_quantity,unit_cost FROM products WHERE project_id=? ORDER BY name').all(projectId);
    const totals = {};
    for (const row of transactions) {
      const group = totals[row.type] || (totals[row.type] = { confirmed: 0, estimated: 0, count: 0 });
      group[row.estimated ? 'estimated' : 'confirmed'] += row.amount;
      group.count++;
    }
    res.json({ projectId, from, to, totals, transactions, inventory, note: 'الإيراد والمشتريات والمصروفات معروضة كلٌ على حدة؛ لا يمثّل الفرق بينها صافي الربح.' });
  });
  app.get('/api/projects/:id/conversation', (req, res) => {
    const projectId = Number(req.params.id);
    if (!projects.get(projectId)) return res.status(404).json({ error: 'المشروع غير موجود.' });
    const conversation = db.prepare('SELECT id,title,updated_at FROM conversations WHERE project_id=? ORDER BY updated_at DESC,id DESC LIMIT 1').get(projectId);
    const messages = conversation ? db.prepare(`SELECT m.id,m.role,m.content,m.input_type,m.created_at,t.result_json
      FROM messages m LEFT JOIN fahima_v2_deliveries d ON d.assistant_message_id=m.id LEFT JOIN fahima_v2_tasks t ON t.id=d.task_id
      WHERE m.conversation_id=? ORDER BY m.id DESC LIMIT 100`).all(conversation.id).reverse().map(row=>{const result=parse(row.result_json);const message={id:row.id,role:row.role,content:row.content,input_type:row.input_type,created_at:row.created_at};if(row.role==='assistant'&&result?.plan)message.plan=result.plan;return message;}) : [];
    const activeTask = conversation ? db.prepare("SELECT id,status FROM fahima_v2_tasks WHERE project_id=? AND conversation_id=? AND status IN ('QUEUED','RUNNING') ORDER BY created_at DESC LIMIT 1").get(projectId, conversation.id) : null;
    res.json({ conversation: conversation || null, messages, activeTask: activeTask || null });
  });
  app.post('/api/tts/ticket', (req, res, next) => {
    try { res.json({ streamUrl: `/api/tts/stream/${tts.issue(req.body?.text)}` }); }
    catch (error) { next(error); }
  });
  app.get('/api/tts/stream/:id', (req, res) => tts.stream(req.params.id, req, res));
  app.get('/api/health', (req, res) => res.json({ status: 'ok', architecture: 'fahima', modelConfigured: Boolean(config.geminiApiKey), searchConfigured: Boolean(config.serperApiKey) }));
  app.use((error, req, res, next) => {
    const status = Number(error.status) || (error.code === 'GEMINI_NOT_CONFIGURED' ? 503 : 500);
    res.status(status).json({ error: status >= 500 ? 'حصلت مشكلة مؤقتة. جربي تاني.' : error.message, code: error.code || 'REQUEST_FAILED' });
  });
  return app;
}
function parse(value) { try { return value == null ? null : JSON.parse(value); } catch { return null; } }
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}
module.exports = { createApp };
