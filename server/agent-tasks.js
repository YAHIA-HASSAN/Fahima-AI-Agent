const { randomUUID, createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');

const TERMINAL = new Set(['COMPLETE','PROVISIONAL','WAITING_FOR_INPUT','FAILED','CANCELLED']);
const json = value => JSON.stringify(value ?? null);
const parse = value => { try { return JSON.parse(value); } catch { return null; } };
const hash = value => createHash('sha256').update(json(value)).digest('hex');

function createAgentTasks(db, work, { leaseMs = 30000, pollMs = 2000, now = () => new Date() } = {}) {
  const workerId = randomUUID();
  const listeners = new Map();
  const active = new Set();
  let closed = false;
  const timestamp = () => now().toISOString();
  const emitter = id => { if (!listeners.has(id)) listeners.set(id,new EventEmitter()); return listeners.get(id); };
  const rowFor = (id, projectId) => db.prepare(`SELECT * FROM agent_tasks WHERE id=? ${projectId == null ? '' : 'AND project_id=?'}`).get(...(projectId == null ? [id] : [id,Number(projectId)]));
  const snapshot = row => row && ({id:row.id,projectId:row.project_id,conversationId:row.conversation_id,status:row.status,
    objective:row.objective,progress:row.progress,result:parse(row.result_json),error:row.error,
    errorCode:row.status==='FAILED'?'AGENT_TASK_EXECUTION_FAILED':null,decisionCount:row.decision_count,
    toolCount:row.tool_count,inputTokens:row.input_tokens,outputTokens:row.output_tokens,estimatedCost:row.estimated_cost,
    payload:parse(row.payload_json),budget:parse(row.budget_json),sourceMessageId:row.source_message_id,
    createdAt:row.created_at,updatedAt:row.updated_at,completedAt:row.completed_at});
  function publish(id) { const row=rowFor(id); if(row)emitter(id).emit('change',snapshot(row)); }
  function create(input) {
    const id=randomUUID(), at=timestamp();
    db.prepare(`INSERT INTO agent_tasks(id,project_id,conversation_id,source_message_id,task_type,status,objective,payload_json,budget_json,project_fingerprint,decision_count,input_tokens,output_tokens,created_at,updated_at)
      VALUES(?,?,?,?,?,'QUEUED',?,?,?,?,?,?,?,?,?)`).run(id,Number(input.projectId),Number(input.conversationId),input.sourceMessageId||null,
      input.type||'business_plan',String(input.objective||'مساعدة المشروع'),json(input.payload),json(input.budget),String(input.projectFingerprint||''),
      Number(input.decisionCount)||0,Number(input.inputTokens)||0,Number(input.outputTokens)||0,at,at);
    publish(id); setImmediate(()=>void run(id)); return snapshot(rowFor(id));
  }
  function claim(id) {
    const at=timestamp(),expires=new Date(now().getTime()+leaseMs).toISOString();
    const result=db.prepare(`UPDATE agent_tasks SET status='RUNNING',lease_owner=?,lease_expires_at=?,updated_at=?
      WHERE id=? AND status IN ('QUEUED','RUNNING') AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at<? OR lease_owner=?)`)
      .run(workerId,expires,at,id,at,workerId);
    return result.changes===1?rowFor(id):null;
  }
  function renew(id) {
    const expires=new Date(now().getTime()+leaseMs).toISOString();
    return db.prepare("UPDATE agent_tasks SET lease_expires_at=?,updated_at=? WHERE id=? AND status='RUNNING' AND lease_owner=?")
      .run(expires,timestamp(),id,workerId).changes===1;
  }
  function update(id, changes) {
    const fields=[],values=[];
    for(const [key,value] of Object.entries(changes)) {
      if(!['progress','decision_count','tool_count','input_tokens','output_tokens','estimated_cost','result_json','error','status'].includes(key))continue;
      fields.push(`${key}=?`); values.push(key==='result_json'&&typeof value!=='string'?json(value):value);
    }
    if(!fields.length)return;
    fields.push('updated_at=?');values.push(timestamp());
    if(changes.status&&TERMINAL.has(changes.status)){fields.push('completed_at=?','lease_owner=NULL','lease_expires_at=NULL');values.push(timestamp());}
    values.push(id,workerId);
    const result=db.prepare(`UPDATE agent_tasks SET ${fields.join(',')} WHERE id=? AND lease_owner=?`).run(...values);
    if(result.changes)publish(id);
    return result.changes===1;
  }
  function recordMetric(taskId, metric, value, details={}) {
    db.prepare('INSERT INTO agent_task_metrics(task_id,metric,value,details_json,created_at) VALUES(?,?,?,?,?)')
      .run(taskId,String(metric),Number(value)||0,json(details),timestamp());
  }
  function deliver(taskId, content) {
    const existing=db.prepare('SELECT message_id FROM agent_task_deliveries WHERE task_id=?').get(taskId);
    if(existing)return existing.message_id;
    const task=rowFor(taskId); if(!task||task.status!=='RUNNING'||task.lease_owner!==workerId)return null;
    return db.transaction(()=>{
      const already=db.prepare('SELECT message_id FROM agent_task_deliveries WHERE task_id=?').get(taskId);
      if(already)return already.message_id;
      const current=rowFor(taskId);if(!current||current.status!=='RUNNING'||current.lease_owner!==workerId)return null;
      const message=db.prepare("INSERT INTO messages(conversation_id,role,content,input_type) VALUES(?,'assistant',?,'text')")
        .run(task.conversation_id,String(content||'').slice(0,5000));
      db.prepare("UPDATE conversations SET updated_at=datetime('now') WHERE id=?").run(task.conversation_id);
      db.prepare('INSERT INTO agent_task_deliveries(task_id,message_id,delivered_at) VALUES(?,?,?)').run(taskId,message.lastInsertRowid,timestamp());
      return message.lastInsertRowid;
    })();
  }
  async function runStep(taskId, { key, sequence, kind, input }, execute) {
    const inputHash=hash(input);
    const previous=db.prepare('SELECT * FROM agent_task_steps WHERE task_id=? AND step_key=?').get(taskId,key);
    if(previous?.status==='completed'&&previous.input_hash===inputHash)return parse(previous.result_json);
    if(previous&&previous.input_hash!==inputHash)throw new Error('مدخلات خطوة محفوظة اتغيرت؛ لازم إنشاء خطوة جديدة.');
    const at=timestamp();
    db.transaction(()=>{
      const task=rowFor(taskId);if(!task||task.status!=='RUNNING'||task.lease_owner!==workerId)throw Object.assign(new Error('Task lease was lost.'),{code:'TASK_LEASE_LOST'});
      db.prepare(`INSERT INTO agent_task_steps(task_id,step_key,sequence,kind,status,input_hash,started_at)
      VALUES(?,?,?,?, 'running',?,?) ON CONFLICT(task_id,step_key) DO UPDATE SET status='running',error=NULL,started_at=excluded.started_at,completed_at=NULL`)
      .run(taskId,key,sequence,kind,inputHash,at);
    })();
    publish(taskId);
    const stepStarted=Date.now();
    try {
      const result=await execute();
      db.transaction(()=>{
        const changed=db.prepare(`UPDATE agent_task_steps SET status='completed',result_json=?,error=NULL,completed_at=?
          WHERE task_id=? AND step_key=? AND input_hash=? AND EXISTS(SELECT 1 FROM agent_tasks WHERE id=? AND status='RUNNING' AND lease_owner=?)`)
          .run(json(result),timestamp(),taskId,key,inputHash,taskId,workerId);
        if(!changed.changes)throw new Error('تعذر تثبيت نتيجة الخطوة.');
      })();
      recordMetric(taskId,'tool_step_duration_ms',Date.now()-stepStarted,{kind});
      publish(taskId); return result;
    } catch(error) {
      db.prepare("UPDATE agent_task_steps SET status='failed',error=?,completed_at=? WHERE task_id=? AND step_key=? AND EXISTS(SELECT 1 FROM agent_tasks WHERE id=? AND status='RUNNING' AND lease_owner=?)")
        .run(String(error?.code||error?.name||'step_failed').slice(0,120),timestamp(),taskId,key,taskId,workerId);
      publish(taskId); throw error;
    }
  }
  async function run(id) {
    if(closed||active.has(id))return;
    const before=rowFor(id),recovered=before?.status==='RUNNING'&&(!before.lease_expires_at||Date.parse(before.lease_expires_at)<now().getTime());
    const row=claim(id); if(!row)return;
    if(recovered)recordMetric(id,'task_recovered',1);
    active.add(id); publish(id);
    const heartbeat=setInterval(()=>renew(id),Math.max(1000,Math.floor(leaseMs/3)));
    heartbeat.unref?.();
    const control={
      runStep:(step,execute)=>runStep(id,step,execute),
      completedSteps:()=>steps(id,row.project_id).filter(step=>['completed','failed'].includes(step.status)),
      update:changes=>update(id,changes),
      metric:(name,value,details)=>recordMetric(id,name,value,details),
      deliver:content=>deliver(id,content),
      cancelled:()=>rowFor(id)?.status==='CANCELLED',
      renew:()=>renew(id),
    };
    try {
      const outcome=await work(snapshot(row),control);
      const current=rowFor(id);
      if(!current||current.status==='CANCELLED')return;
      let status=outcome?.status;
      if(!['COMPLETE','PROVISIONAL','WAITING_FOR_INPUT','FAILED'].includes(status))throw new Error('المهمة ماوصلتش لحالة انتهاء صالحة.');
      const result=outcome.result&&typeof outcome.result==='object'?{...outcome.result}:outcome.result;
      const quality=result?.validation?.status||result?.plan?.status;
      if(result?.validation?.taskStatus==='WAITING_FOR_INPUT'||quality==='INVALID'||quality==='WAITING_FOR_INPUT')status='WAITING_FOR_INPUT';
      else if(quality==='PROVISIONAL'&&status==='COMPLETE')status='PROVISIONAL';
      else if(quality&&quality!=='COMPLETE'&&status==='COMPLETE')status='PROVISIONAL';
      if(outcome.status==='COMPLETE'&&status!=='COMPLETE') {
        result.reply=quality==='PROVISIONAL'?'الخطة مبدئية، وفيه افتراضات أو معلومات محتاجة مراجعة قبل الاعتماد عليها.':'فيه مدخل أساسي ناقص أو نتيجة لم تجتز التحقق؛ مش هاعرض الخطة على إنها مكتملة.';
        result.speechText=result.reply;
        const delivery=db.prepare('SELECT message_id FROM agent_task_deliveries WHERE task_id=?').get(id);
        if(delivery)db.prepare('UPDATE messages SET content=? WHERE id=?').run(result.reply,delivery.message_id);
      }
      if(result&&typeof result==='object'){
        result.taskId=id;result.status=status;
        if(result.plan&&quality)result.plan.status=quality;
        if(result.planRef&&quality)result.planRef.status=quality;
      }
      update(id,{status,result_json:result??outcome,error:outcome.error||null,progress:outcome.progress||''});
    } catch(error) {
      const errorCode=String(error?.code||error?.name||'AGENT_TASK_EXECUTION_FAILED').replace(/[^A-Za-z0-9_-]/gu,'').slice(0,80)||'AGENT_TASK_EXECUTION_FAILED';
      console.error(JSON.stringify({component:'fahima',event:'agent.task.failed',taskId:id,code:errorCode}));
      const message='حصلت مشكلة أثناء تنفيذ الطلب. رسالتك محفوظة، لكن المهمة ماكملتش. جرّب تاني بعد شوية.';
      update(id,{status:'FAILED',error:message,progress:'المهمة توقفت بسبب مشكلة أثناء التنفيذ.'});
      recordMetric(id,'failed',1,{code:errorCode});
    } finally {clearInterval(heartbeat);active.delete(id);publish(id);}
  }
  function recover() {
    if(closed)return;
    const at=timestamp();
    const rows=db.prepare(`SELECT id FROM agent_tasks WHERE status='QUEUED' OR (status='RUNNING' AND (lease_expires_at IS NULL OR lease_expires_at<?)) ORDER BY created_at LIMIT 20`).all(at);
    for(const row of rows)void run(row.id);
  }
  const poller=setInterval(recover,pollMs);poller.unref?.();setImmediate(recover);
  function get(id,projectId) { const row=rowFor(String(id),Number(projectId)); return snapshot(row); }
  function list(projectId,conversationId) {
    return db.prepare("SELECT * FROM agent_tasks WHERE project_id=? AND conversation_id=? AND status IN ('QUEUED','RUNNING') ORDER BY created_at")
      .all(Number(projectId),Number(conversationId)).map(snapshot);
  }
  function latest(projectId,conversationId) {
    const row=db.prepare("SELECT * FROM agent_tasks WHERE project_id=? AND conversation_id=? AND created_at>=datetime('now','-10 minutes') ORDER BY created_at DESC LIMIT 1")
      .get(Number(projectId),Number(conversationId));return row&&snapshot(row);
  }
  function steps(id,projectId) {
    if(!rowFor(String(id),Number(projectId)))return null;
    return db.prepare('SELECT step_key AS key,sequence,kind,status,result_json,error,started_at,completed_at FROM agent_task_steps WHERE task_id=? ORDER BY sequence').all(String(id))
      .map(step=>({...step,result:parse(step.result_json)}));
  }
  function subscribe(id,projectId,listener) {
    const row=rowFor(String(id),Number(projectId)); if(!row)return null;
    const events=emitter(String(id)); events.on('change',listener); return()=>events.off('change',listener);
  }
  function cancel(id,projectId) {
    const changed=db.prepare("UPDATE agent_tasks SET status='CANCELLED',updated_at=?,completed_at=?,lease_owner=NULL,lease_expires_at=NULL WHERE id=? AND project_id=? AND status IN ('QUEUED','RUNNING')")
      .run(timestamp(),timestamp(),String(id),Number(projectId)).changes===1;
    if(changed)publish(String(id));return changed;
  }
  async function close() {
    closed=true;clearInterval(poller);
    const deadline=Date.now()+5000;
    while(active.size&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
  }
  return {create,get,list,latest,steps,subscribe,cancel,recover,close};
}

module.exports={createAgentTasks};
