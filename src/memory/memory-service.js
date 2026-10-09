function createMemoryService(db) {
  return {
    context(projectId, conversationId, limit = 10) {
      const project = db.prepare('SELECT id,name,activity,products,capital,costs,sales_method,household_use FROM projects WHERE id=?').get(projectId);
      if (!project) throw Object.assign(new Error('المشروع غير موجود.'), { status: 404 });
      const facts = db.prepare('SELECT fact_key,value_json,provenance,certainty,revision,updated_at FROM fahima_v2_facts WHERE project_id=? ORDER BY updated_at DESC').all(projectId);
      const goals = db.prepare("SELECT goal_key,title,target_json,status,updated_at FROM fahima_v2_goals WHERE project_id=? ORDER BY updated_at DESC").all(projectId).map(row => ({ ...row, target: parse(row.target_json) }));
      const plans = db.prepare('SELECT revision,quality_status,body_json,created_at FROM fahima_v2_plan_versions WHERE project_id=? ORDER BY revision DESC LIMIT 1').all(projectId).map(row => ({ ...row, body: parse(row.body_json) }));
      const messages = db.prepare(`SELECT role,content,created_at FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT ?`).all(conversationId, limit).reverse();
      const tasks = db.prepare(`SELECT id,status,objective,result_json,updated_at FROM fahima_v2_tasks WHERE project_id=? ORDER BY created_at DESC LIMIT 4`).all(projectId).map(row => ({ ...row, result: parse(row.result_json) }));
      const activeTasks = tasks.filter(task => ['QUEUED', 'RUNNING', 'WAITING_FOR_INPUT'].includes(task.status));
      const previousDecisions = db.prepare(`SELECT d.action_type,d.tool_names_json,d.input_tokens,d.output_tokens,d.created_at FROM fahima_v2_decisions d JOIN fahima_v2_tasks t ON t.id=d.task_id WHERE t.project_id=? ORDER BY d.id DESC LIMIT 12`).all(projectId).map(row => ({ ...row, tools: parse(row.tool_names_json) }));
      const research = db.prepare(`SELECT query,source_url,result_json,retrieved_at FROM fahima_v2_research WHERE project_id=? ORDER BY id DESC LIMIT 20`).all(projectId).map(row => ({ ...row, result: parse(row.result_json) }));
      const transactions = db.prepare(`SELECT type,amount,date,description FROM transactions WHERE project_id=? AND voided_at IS NULL ORDER BY id DESC LIMIT 10`).all(projectId);
      const inventory = db.prepare('SELECT id,name,unit,current_quantity,low_stock_threshold,unit_cost FROM products WHERE project_id=? ORDER BY name').all(projectId);
      return { project, facts: facts.map(row => ({ ...row, value: parse(row.value_json) })), goals, inventory, plans, messages, tasks, activeTasks, previousDecisions, research, transactions };
    },
    saveFact(projectId, key, value, provenance = 'user', certainty = 'confirmed') {
      const safeKey = String(key || '').trim().slice(0, 100);
      if (!safeKey || value === undefined) throw new Error('اسم المعلومة وقيمتها مطلوبان.');
      const prior = db.prepare('SELECT revision FROM fahima_v2_facts WHERE project_id=? AND fact_key=?').get(projectId, safeKey);
      const rev = prior?.revision || 0;
      const update = db.transaction(() => {
        if (prior) {
          const previous = db.prepare('SELECT * FROM fahima_v2_facts WHERE project_id=? AND fact_key=?').get(projectId, safeKey);
          db.prepare('INSERT INTO fahima_v2_fact_history(project_id,fact_key,value_json,provenance,certainty,revision) VALUES(?,?,?,?,?,?)').run(projectId, previous.fact_key, previous.value_json, previous.provenance, previous.certainty, previous.revision);
        }
        db.prepare(`INSERT INTO fahima_v2_facts(project_id,fact_key,value_json,provenance,certainty,revision) VALUES(?,?,?,?,?,?)
        ON CONFLICT(project_id,fact_key) DO UPDATE SET value_json=excluded.value_json,provenance=excluded.provenance,certainty=excluded.certainty,revision=excluded.revision,updated_at=datetime('now')`)
          .run(projectId, safeKey, JSON.stringify(value), String(provenance).slice(0, 100), certainty === 'confirmed' ? 'confirmed' : 'proposed', rev + 1);
      });
      update();
      return { key: safeKey, value, revision: rev + 1, certainty };
    },
    saveGoal(projectId, key, title, target = null) {
      const cleanKey = String(key || '').trim().slice(0, 100), cleanTitle = String(title || '').trim().slice(0, 200);
      if (!cleanKey || !cleanTitle) throw new Error('مفتاح الهدف وعنوانه مطلوبان.');
      db.prepare(`INSERT INTO fahima_v2_goals(project_id,goal_key,title,target_json) VALUES(?,?,?,?)
        ON CONFLICT(project_id,goal_key) DO UPDATE SET title=excluded.title,target_json=excluded.target_json,status='active',updated_at=datetime('now')`)
        .run(projectId, cleanKey, cleanTitle, target == null ? null : JSON.stringify(target));
      return { key: cleanKey, title: cleanTitle, target, status: 'active' };
    },
  };
}
function parse(value) { try { return value == null ? null : JSON.parse(value); } catch { return null; } }
module.exports = { createMemoryService };
