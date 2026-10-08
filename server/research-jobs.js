const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { diagnostic } = require('./diagnostics');

function safeJson(value) {try{return JSON.parse(value);}catch{return null;}}

function createResearchJobs(db) {
  const emitters=new Map();
  const now=()=>new Date().toISOString();
  db.prepare("UPDATE research_jobs SET status='failed',error=?,updated_at=? WHERE status IN ('queued','running')")
    .run('البحث اتوقف لأن الخادم اتعاد تشغيله. اطلب تحديث البحث علشان نبدأه من جديد.',now());

  const emitter=id=>{
    if(!emitters.has(id))emitters.set(id,new EventEmitter());
    return emitters.get(id);
  };
  function snapshot(job) {
    return {id:job.id,projectId:job.project_id,conversationId:job.conversation_id,status:job.status,
      result:safeJson(job.result_json),error:job.error,updatedAt:Date.parse(job.updated_at)};
  }
  function get(id,projectId) {
    return db.prepare('SELECT * FROM research_jobs WHERE id=? AND project_id=?').get(String(id),Number(projectId))||null;
  }
  function latest(projectId,conversationId) {
    const row=db.prepare('SELECT * FROM research_jobs WHERE project_id=? AND conversation_id=? ORDER BY updated_at DESC LIMIT 1')
      .get(Number(projectId),Number(conversationId));
    return row&&Date.now()-Date.parse(row.updated_at)<=10*60*1000?row:null;
  }
  function publish(id) {
    const row=db.prepare('SELECT * FROM research_jobs WHERE id=?').get(id);
    if(row)emitter(id).emit('change',snapshot(row));
  }
  function start(projectId,conversationId,work) {
    const id=randomUUID(),timestamp=now();
    db.prepare("INSERT INTO research_jobs(id,project_id,conversation_id,status,created_at,updated_at) VALUES(?,?,?,'queued',?,?)")
      .run(id,Number(projectId),Number(conversationId),timestamp,timestamp);
    diagnostic('tool.queued',{tool:'market_research',jobId:id,projectId:Number(projectId),conversationId:Number(conversationId)});
    setImmediate(async()=>{
      const startedAt=Date.now();
      db.prepare("UPDATE research_jobs SET status='running',updated_at=? WHERE id=?").run(now(),id);publish(id);
      diagnostic('tool.started',{tool:'market_research',jobId:id,projectId:Number(projectId),conversationId:Number(conversationId)});
      try {
        const result=await work();
        const stored=result&&typeof result==='object'?{...result}:result;
        if(stored&&typeof stored==='object')delete stored.speechStreamUrl;
        db.prepare("UPDATE research_jobs SET status='completed',result_json=?,error=NULL,updated_at=? WHERE id=?")
          .run(JSON.stringify(stored),now(),id);
        diagnostic('tool.completed',{tool:'market_research',jobId:id,projectId:Number(projectId),conversationId:Number(conversationId),durationMs:Date.now()-startedAt});
      } catch(error) {
        const providerStatus=Number(error?.status||error?.statusCode);
        const message=providerStatus===429?'بحث الإنترنت وصل لحد الاستخدام مؤقتًا. نقدر نكمل بحساب مشروط أو نعيد المحاولة بعدين.'
          :error?.code==='SEARCH_TIMEOUT'?'بحث السوق اتأخر، فوقفت الانتظار. نقدر نكمل بحساب مشروط بأسعار تحددها أو نعيد المحاولة.'
            :'تعذر إكمال بحث السوق دلوقتي. نقدر نكمل بافتراضات واضحة بدل الانتظار.';
        db.prepare("UPDATE research_jobs SET status='failed',error=?,updated_at=? WHERE id=?").run(message,now(),id);
        diagnostic('tool.failed',{tool:'market_research',jobId:id,projectId:Number(projectId),conversationId:Number(conversationId),durationMs:Date.now()-startedAt,errorCode:error?.code||error?.status||'unknown'});
      }
      publish(id);
    });
    return id;
  }
  function subscribe(job,listener) {
    const events=emitter(job.id);
    events.on('change',listener);
    return()=>events.off('change',listener);
  }
  return {start,get,latest,subscribe,snapshot};
}

module.exports={createResearchJobs};
