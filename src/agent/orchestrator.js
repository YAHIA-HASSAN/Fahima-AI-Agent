const { runLoop } = require('./agent-loop');

function createOrchestrator({ db, config, model, registry, memory, tasks }) {
  const listeners = new Map();
  const notify = (taskId, event) => { for (const response of listeners.get(taskId) || []) response.write(`data: ${JSON.stringify(event)}\n\n`); };
  function subscribe(taskId, response) {
    if (!listeners.has(taskId)) listeners.set(taskId, new Set());
    listeners.get(taskId).add(response);
    response.on('close', () => { listeners.get(taskId)?.delete(response); if (!listeners.get(taskId)?.size) listeners.delete(taskId); });
    return () => listeners.get(taskId)?.delete(response);
  }
  function start(taskId) { setImmediate(() => runTask(taskId).catch(error => console.error('Fahima task worker failed:', error.code || error.name))); }
  async function runTask(taskId) {
    const task = tasks.claim(taskId);
    if (!task) return null;
    const state = parse(task.state_json) || {};
    const createdAt = Date.parse(/Z|[+-]\d\d:\d\d$/.test(task.created_at) ? task.created_at : `${String(task.created_at).replace(' ', 'T')}Z`);
    const taskAge = Number.isFinite(createdAt) ? Math.max(0, Date.now() - createdAt) : 0;
    const context = { projectId: task.project_id, conversationId: task.conversation_id, task: { id: task.id, objective: task.objective, decisionCount: Number(state.decisionCount) || 0 }, message: state.message || task.objective, inputMode: state.inputMode || 'text', memory: null, observations: state.observations || [], isProjectAuthorized: config.allowFinancialRecording !== false };
    try {
      context.memory = memory.context(task.project_id, task.conversation_id);
      const outcome = await runLoop({
        model, registry, context,
        budgets: { maxDecisions: config.taskMaxDecisions, maxTools: config.taskMaxTools, timeoutMs: Math.max(0, config.taskTimeoutMs - taskAge) },
        onProgress: progress => notify(taskId, { taskId, status: 'RUNNING', progress }),
        isCancelled: () => tasks.isCancelled(taskId),
        persistObservation: (toolName, observation, sequence) => {
          const next = [...context.observations];
          next.push({ tool: toolName, observation });
          context.observations = next;
          db.transaction(() => {
            tasks.observation(taskId, sequence, toolName, observation);
            tasks.saveState(taskId, { ...state, message: context.message, inputMode: context.inputMode, decisionCount: context.task.decisionCount, observations: next });
          })();
        },
        persistDecision: decision => db.transaction(() => {
          db.prepare('INSERT OR IGNORE INTO fahima_v2_decisions(task_id,sequence,action_type,tool_names_json,input_tokens,output_tokens) VALUES(?,?,?,?,?,?)').run(taskId, decision.sequence, decision.actionType, JSON.stringify(decision.toolNames), decision.inputTokens, decision.outputTokens);
          tasks.saveState(taskId, { ...state, message: context.message, inputMode: context.inputMode, decisionCount: decision.sequence, observations: context.observations });
        })(),
      });
      if (tasks.isCancelled(taskId)) {
        const cancelled=tasks.get(taskId,task.project_id);
        notify(taskId,{taskId,status:'CANCELLED',result:parse(cancelled?.result_json)});
        return cancelled;
      }
      const usage = db.prepare('SELECT COUNT(*) AS decisions,COALESCE(SUM(input_tokens),0) AS inputTokens,COALESCE(SUM(output_tokens),0) AS outputTokens FROM fahima_v2_decisions WHERE task_id=?').get(taskId);
      const toolCount = db.prepare('SELECT COUNT(*) AS count FROM fahima_v2_observations WHERE task_id=?').get(taskId).count;
      const totalElapsed = Math.max(0, Date.now() - createdAt);
      const metrics = { ...(outcome.metrics || {}), decisions: usage.decisions, toolCount, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, elapsedMs: totalElapsed };
      const finish = db.transaction(() => {
        const delivery = db.prepare('SELECT assistant_message_id FROM fahima_v2_deliveries WHERE task_id=?').get(taskId);
        let messageId = delivery?.assistant_message_id;
        if (!messageId) {
          const result = db.prepare('INSERT INTO messages(conversation_id,role,content,input_type) VALUES(?,?,?,?)').run(task.conversation_id, 'assistant', outcome.result?.answer || 'حصلت مشكلة وأنا بجهز الرد.', 'text');
          messageId = result.lastInsertRowid;
          db.prepare('INSERT INTO fahima_v2_deliveries(task_id,assistant_message_id) VALUES(?,?)').run(taskId, messageId);
        }
        tasks.finish(taskId, outcome.status, { ...outcome.result, metrics, deliveredMessageId: messageId }, outcome.status === 'FAILED' ? outcome.result?.answer : null);
        db.prepare("UPDATE conversations SET updated_at=datetime('now') WHERE id=?").run(task.conversation_id);
      });
      finish();
      const finalTask = tasks.get(taskId, task.project_id);
      notify(taskId, { taskId, status: finalTask.status, result: parse(finalTask.result_json) });
      return finalTask;
    } catch (error) {
      const retryable = Number(error.status || error.code) === 429 || error.code === 'RATE_LIMITED' || error.name === 'TimeoutError' || error.code === 'ETIMEDOUT';
      const age = taskAge;
      if (retryable && task.attempt < 2 && age < config.taskTimeoutMs && tasks.retry(taskId, error.code || error.status)) {
        const retryHeader = Number(error.retryAfterMs || error.retryAfter || error.response?.headers?.get?.('retry-after'));
        const wait = Math.max(1000, Math.min(30000, Number.isFinite(retryHeader) ? retryHeader > 1000 ? retryHeader : retryHeader * 1000 : 1000));
        notify(taskId, { taskId, status: 'QUEUED', retryInMs: wait });
        setTimeout(() => start(taskId), wait);
        return tasks.get(taskId, task.project_id);
      }
      tasks.finish(taskId, 'FAILED', { answer: 'حصلت مشكلة مؤقتة وأنا بجهز الرد. جربي تاني.' }, String(error.code || error.message).slice(0, 300));
      const failed = tasks.get(taskId, task.project_id);
      notify(taskId, { taskId, status: 'FAILED', result: parse(failed.result_json) });
      return failed;
    }
  }
  return { start, runTask, subscribe, notify };
}
function parse(value) { try { return value == null ? null : JSON.parse(value); } catch { return null; } }
module.exports = { createOrchestrator };
