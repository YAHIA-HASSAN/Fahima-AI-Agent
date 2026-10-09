const crypto = require('node:crypto');
function createTaskManager(db, { leaseMs = 30000 } = {}) {
  return {
    create({ projectId, conversationId, sourceMessageId, objective }) {
      const id = crypto.randomUUID();
      db.prepare(`INSERT INTO fahima_v2_tasks(id,project_id,conversation_id,source_message_id,status,objective,state_json)
        VALUES(?,?,?,?,'QUEUED',?,'{}')`).run(id, projectId, conversationId, sourceMessageId || null, objective);
      return id;
    },
    claim(id, worker = `worker-${process.pid}`) {
      const claim = db.transaction(() => {
        const now = new Date().toISOString();
        const result = db.prepare(`UPDATE fahima_v2_tasks SET status='RUNNING',lease_owner=?,lease_expires_at=?,attempt=attempt+1,updated_at=datetime('now')
          WHERE id=? AND (status='QUEUED' OR (status='RUNNING' AND (lease_expires_at IS NULL OR lease_expires_at<?)))`).run(worker, new Date(Date.now() + leaseMs).toISOString(), id, now);
        return result.changes === 1 ? db.prepare('SELECT * FROM fahima_v2_tasks WHERE id=?').get(id) : null;
      });
      return claim();
    },
    saveState(id, state) { db.prepare(`UPDATE fahima_v2_tasks SET state_json=?,updated_at=datetime('now') WHERE id=? AND status='RUNNING'`).run(JSON.stringify(state), id); },
    observation(id, sequence, toolName, outcome) {
      db.prepare('INSERT OR REPLACE INTO fahima_v2_observations(task_id,sequence,tool_name,outcome_json) VALUES(?,?,?,?)').run(id, sequence, toolName, JSON.stringify(outcome));
    },
    finish(id, status, result, error = null) {
      if (!['COMPLETE', 'PROVISIONAL', 'WAITING_FOR_INPUT', 'FAILED', 'CANCELLED'].includes(status)) throw new Error('Invalid terminal task state.');
      db.prepare(`UPDATE fahima_v2_tasks SET status=?,result_json=?,error=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=datetime('now'),completed_at=datetime('now') WHERE id=? AND status='RUNNING'`).run(status, result == null ? null : JSON.stringify(result), error, id);
    },
    retry(id, error) {
      return db.prepare(`UPDATE fahima_v2_tasks SET status='QUEUED',lease_owner=NULL,lease_expires_at=NULL,error=?,updated_at=datetime('now') WHERE id=? AND status='RUNNING'`).run(String(error || '').slice(0, 300), id).changes === 1;
    },
    get(id, projectId) { return db.prepare('SELECT * FROM fahima_v2_tasks WHERE id=? AND project_id=?').get(id, projectId) || null; },
    cancel(id, projectId) {
      const result=db.prepare(`UPDATE fahima_v2_tasks SET status='CANCELLED',error='أُلغي الطلب بواسطة المستخدم',lease_owner=NULL,lease_expires_at=NULL,completed_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND project_id=? AND status IN ('QUEUED','RUNNING')`).run(id,projectId);
      return result.changes===1 ? this.get(id,projectId) : null;
    },
    isCancelled(id) { return Boolean(db.prepare("SELECT 1 FROM fahima_v2_tasks WHERE id=? AND status='CANCELLED'").get(id)); },
    recoverable() { return db.prepare(`SELECT id,status,lease_expires_at FROM fahima_v2_tasks WHERE status='QUEUED' OR status='RUNNING' ORDER BY created_at`).all().filter(row => row.status === 'QUEUED' || !row.lease_expires_at || Date.parse(row.lease_expires_at) < Date.now()).map(row => row.id); },
  };
}
module.exports = { createTaskManager };
