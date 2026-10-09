const { createGeminiModel } = require('../llm/gemini-client');
const { createToolRegistry } = require('../tools/tool-registry');
const { registerTools } = require('../tools/register-tools');
const { createMemoryService } = require('../memory/memory-service');
const { createTransactionService } = require('../domain/finance/transaction-service');
const { createInventoryService } = require('../domain/inventory/inventory-service');
const { createPlanService } = require('../domain/planning/plan-service');
const { createTaskManager } = require('./task-manager');
const { createOrchestrator } = require('./orchestrator');

function createAgent({ db, config, model: injectedModel, search }) {
  const model = injectedModel || createGeminiModel(config);
  const memory = createMemoryService(db);
  const transactions = createTransactionService(db);
  const inventory = createInventoryService(db);
  const plans = createPlanService(db);
  const tasks = createTaskManager(db, { leaseMs: config.leaseMs });
  const registry = createToolRegistry();
  registerTools({ registry, db, memory, transactions, inventory, plans, search });
  const orchestrator = createOrchestrator({ db, config, model, registry, memory, tasks });
  const createRun = db.transaction(({ projectId, conversationId, message, inputMode, requestId }) => {
    const project = db.prepare('SELECT id FROM projects WHERE id=?').get(projectId);
    if (!project) throw Object.assign(new Error('المشروع غير موجود.'), { status: 404 });
    const prior = requestId && db.prepare('SELECT task_id,user_message_id,project_id,conversation_id FROM fahima_v2_requests WHERE request_id=?').get(requestId);
    if (prior) {
      if (prior.project_id !== Number(projectId) || (conversationId && prior.conversation_id !== Number(conversationId))) throw Object.assign(new Error('معرّف الطلب مستخدم في مشروع أو محادثة مختلفة.'), { status: 409, code: 'REQUEST_SCOPE_CONFLICT' });
      return { taskId: prior.task_id, conversationId: prior.conversation_id, reused: true };
    }
    let conversation = conversationId ? db.prepare('SELECT id FROM conversations WHERE id=? AND project_id=?').get(conversationId, projectId) : null;
    if (conversationId && !conversation) throw Object.assign(new Error('المحادثة لا تتبع هذا المشروع.'), { status: 403 });
    if (!conversation) {
      const conversationResult = db.prepare('INSERT INTO conversations(project_id,title) VALUES(?,?)').run(projectId, 'محادثة جديدة');
      conversation = { id: Number(conversationResult.lastInsertRowid) };
    }
    const userMessage = db.prepare('INSERT INTO messages(conversation_id,role,content,input_type) VALUES(?,?,?,?)').run(conversation.id, 'user', message, inputMode === 'voice' ? 'voice' : 'text');
    const taskId = tasks.create({ projectId, conversationId: conversation.id, sourceMessageId: userMessage.lastInsertRowid, objective: message.slice(0, 500) });
    db.prepare('UPDATE fahima_v2_tasks SET state_json=? WHERE id=?').run(JSON.stringify({ message, inputMode }), taskId);
    if (requestId) db.prepare('INSERT INTO fahima_v2_requests(request_id,project_id,conversation_id,user_message_id,task_id) VALUES(?,?,?,?,?)').run(requestId, projectId, conversation.id, userMessage.lastInsertRowid, taskId);
    db.prepare("UPDATE conversations SET updated_at=datetime('now') WHERE id=?").run(conversation.id);
    return { taskId, conversationId: conversation.id, reused: false };
  });
  return {
    async run({ projectId, conversationId, message, inputMode = 'text', requestId }) {
      const clean = String(message || '').trim();
      if (!clean || clean.length > 1500) throw Object.assign(new Error('اكتبي رسالة من 1 إلى 1500 حرف.'), { status: 400 });
      const record = createRun({ projectId: Number(projectId), conversationId: conversationId ? Number(conversationId) : null, message: clean, inputMode, requestId: requestId || null });
      if (!record.reused) orchestrator.start(record.taskId);
      return { taskId: record.taskId, conversationId: record.conversationId, status: 'QUEUED', reused: record.reused };
    },
    tasks, plans, transactions, inventory, orchestrator, registry, memory,
  };
}
module.exports = { createAgent };
