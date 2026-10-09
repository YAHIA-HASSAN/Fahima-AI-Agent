const { validatePlan } = require('./plan-validator');
function createPlanService(db) {
  return {
    save(projectId, taskId, plan, forcedQuality) {
      const validation = validatePlan(plan);
      if (!validation.valid) throw Object.assign(new Error('الخطة محتاجة استكمال أو تصحيح قبل الحفظ.'), { code: 'INVALID_PLAN', details: validation });
      const prior = taskId ? db.prepare('SELECT id,project_id,revision,quality_status,body_json FROM fahima_v2_plan_versions WHERE task_id=? AND project_id=?').get(taskId, projectId) : null;
      if (prior) return { id: prior.id, projectId, revision: prior.revision, qualityStatus: prior.quality_status, plan: JSON.parse(prior.body_json) };
      const revision = Number(db.prepare('SELECT COALESCE(MAX(revision),0)+1 AS revision FROM fahima_v2_plan_versions WHERE project_id=?').get(projectId).revision);
      const qualityStatus = forcedQuality === 'PROVISIONAL' ? 'PROVISIONAL' : validation.quality;
      const row = db.prepare('INSERT INTO fahima_v2_plan_versions(project_id,revision,task_id,quality_status,body_json) VALUES(?,?,?,?,?)').run(projectId, revision, taskId || null, qualityStatus, JSON.stringify(plan));
      return { id: row.lastInsertRowid, projectId, revision, qualityStatus, plan };
    },
    latest(projectId) {
      const row = db.prepare('SELECT id,project_id,revision,task_id,quality_status,body_json,created_at FROM fahima_v2_plan_versions WHERE project_id=? ORDER BY revision DESC LIMIT 1').get(projectId);
      return row ? { ...row, plan: JSON.parse(row.body_json) } : null;
    },
    setStep(projectId, revision, index, complete, note) {
      const version=db.prepare('SELECT body_json FROM fahima_v2_plan_versions WHERE project_id=? AND revision=?').get(projectId,revision);
      if(!version) throw Object.assign(new Error('نسخة الخطة غير موجودة.'),{code:'PLAN_NOT_FOUND'});
      const plan=JSON.parse(version.body_json);
      if(!Number.isInteger(index)||index<0||index>=plan.steps.length) throw new Error('رقم خطوة الخطة غير صحيح.');
      db.prepare(`INSERT INTO fahima_v2_plan_step_status(project_id,plan_revision,step_index,status,note,updated_at) VALUES(?,?,?,?,?,datetime('now')) ON CONFLICT(project_id,plan_revision,step_index) DO UPDATE SET status=excluded.status,note=excluded.note,updated_at=datetime('now')`).run(projectId,revision,index,complete?'complete':'pending',note||null);
      return this.steps(projectId,revision);
    },
    steps(projectId,revision) {
      const version=db.prepare('SELECT body_json FROM fahima_v2_plan_versions WHERE project_id=? AND revision=?').get(projectId,revision);
      if(!version) return null;
      const plan=JSON.parse(version.body_json), saved=db.prepare('SELECT step_index,status,note FROM fahima_v2_plan_step_status WHERE project_id=? AND plan_revision=?').all(projectId,revision);
      return plan.steps.map((title,index)=>({index,title,status:saved.find(row=>row.step_index===index)?.status||'pending',note:saved.find(row=>row.step_index===index)?.note||null}));
    },
    recordOutcome(projectId,revision,metric,actualValue,note,idempotencyKey) {
      if(idempotencyKey){const prior=db.prepare('SELECT id,plan_revision,metric,planned_value,actual_value,note FROM fahima_v2_plan_outcomes WHERE project_id=? AND idempotency_key=?').get(projectId,idempotencyKey);if(prior)return {id:prior.id,revision:prior.plan_revision,metric:prior.metric,planned:prior.planned_value,actual:prior.actual_value,note:prior.note,duplicate:true};}
      const version=revision?db.prepare('SELECT body_json FROM fahima_v2_plan_versions WHERE project_id=? AND revision=?').get(projectId,revision):this.latest(projectId);
      if(!version) throw Object.assign(new Error('احفظي خطة الأول عشان نقدر نقارن النتيجة.'),{code:'PLAN_NOT_FOUND'});
      const body=typeof version.body_json==='string'?JSON.parse(version.body_json):version.plan;
      const planned=body.outcomes?.[metric]??body.budget?.[metric]??null;
      const id=db.prepare('INSERT INTO fahima_v2_plan_outcomes(project_id,plan_revision,metric,planned_value,actual_value,note,idempotency_key) VALUES(?,?,?,?,?,?,?)').run(projectId,revision||version.revision||null,String(metric).slice(0,100),planned==null?null:String(planned),String(actualValue).slice(0,300),note||null,idempotencyKey||null);
      return {id:id.lastInsertRowid,revision:revision||version.revision,metric,planned,actual:actualValue,note:note||null};
    },
    outcomes(projectId) { return db.prepare('SELECT * FROM fahima_v2_plan_outcomes WHERE project_id=? ORDER BY id DESC').all(projectId); },
  };
}
module.exports = { createPlanService };
