require('dotenv').config();
const path = require('node:path');
const express = require('express');
const { loadConfig } = require('./config');
const db = require('./db');
const { extract, summarizeConversation, isOutOfDomain } = require('./agent');
const B = require('./business');
const { TYPES, validDate } = require('./finance');
const { createBusinessTools, executeBusinessTool } = require('./business-tools');
const { randomUUID, createHash } = require('node:crypto');
const { createGeminiClient } = require('./gemini-client');
const { createAdvisor } = require('./advisor');
const { cleanLanguage } = require('./response-quality');
const { withDeadline } = require('./deadline');
const { createResearchJobs } = require('./research-jobs');
const { createAgentTasks } = require('./agent-tasks');
const { createTaskRunner,taskBudget,projectFingerprint } = require('./agent-task-runner');
const { diagnostic } = require('./diagnostics');
const { createBusinessRoutes } = require('./routes/business');
const { parsePeriod, periodLabel, transactionKindLabel, transactionPending, transactionBatchPending } = require('./transaction-flow');
const advisor = createAdvisor(db,B);
const researchJobs = createResearchJobs(db);

const config = loadConfig();
if (config.issues.length) console.warn('Configuration values need attention:', config.issues.join(' '));

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname,'..','public')));
const chatInFlight = new Set();
const ttsTickets = new Map();
function pruneTtsTickets() {const cutoff=Date.now()-120000;for(const [id,row] of ttsTickets)if(row.createdAt<cutoff)ttsTickets.delete(id);}
function issueTtsTicket(text) {
  const clean=String(text||'').trim();
  if(!clean||clean.length>3000||!config.geminiApiKey)return null;
  pruneTtsTickets();
  const id=randomUUID();
  ttsTickets.set(id,{text:clean,createdAt:Date.now()});
  return `/api/tts/stream/${id}`;
}
function withSpeechStream(body) {
  if(!body?.reply)return body;
  return {...body,speechStreamUrl:issueTtsTicket(body.speechText||body.reply)};
}

function projectOr404(id,res) { const project=B.getProject(id); if(!project){res.status(404).json({error:'المشروع مش موجود.'});return null;} return project; }
function conversationOr404(projectId,id,res) { const row=B.getConversation(projectId,id); if(!row){res.status(404).json({error:'المحادثة دي مش موجودة في المشروع المختار.'});return null;} return row; }
function safeJson(value) { try { return JSON.parse(value); } catch { return null; } }
function saveMessage(conversationId,role,content,inputType='text') {
  const clean=String(content||'').trim().slice(0,5000); if(!clean)return null;
  const result=db.prepare('INSERT INTO messages(conversation_id,role,content,input_type) VALUES(?,?,?,?)').run(conversationId,role,clean,inputType);
  db.prepare("UPDATE conversations SET updated_at=datetime('now') WHERE id=?").run(conversationId);
  return db.prepare('SELECT * FROM messages WHERE id=?').get(result.lastInsertRowid);
}
function setPending(conversationId,projectId,actionType,status,payload) {
  const json=JSON.stringify(payload);
  db.prepare(`INSERT INTO pending_actions(conversation_id,project_id,action_type,status,payload) VALUES(?,?,?,?,?)
    ON CONFLICT(conversation_id) DO UPDATE SET project_id=excluded.project_id,action_type=excluded.action_type,status=excluded.status,payload=excluded.payload,updated_at=datetime('now')`)
    .run(conversationId,projectId,actionType,status,json);
  return db.prepare('SELECT * FROM pending_actions WHERE conversation_id=?').get(conversationId);
}
function pendingFor(conversationId) { const row=db.prepare('SELECT * FROM pending_actions WHERE conversation_id=?').get(conversationId); return row ? {...row,payload:safeJson(row.payload)||{}} : null; }
const profileFields = new Set(['activity','products','capital','costs','sales_method','household_use']);
function factValue(key,value) {
  const clean=String(value??'').trim().slice(0,300);
  if(!clean)throw new Error('اكتب المعلومة اللي حابة تحفظيها.');
  if(key==='capital'&&(!Number.isFinite(Number(clean))||Number(clean)<0))throw new Error('المبلغ المتاح للمشروع كام بالجنيه؟');
  return clean;
}
function upsertFact(projectId,key,value,source='conversation') {
  const k=String(key||'').trim().slice(0,80);
  if(!k)throw new Error('إيه نوع المعلومة اللي حابة تحفظيها؟');
  const v=factValue(k,value);
  return db.transaction(()=>{
    db.prepare('DELETE FROM project_facts WHERE project_id=? AND key=?').run(projectId,k);
    const result=db.prepare('INSERT INTO project_facts(project_id,key,value,source,confirmed) VALUES(?,?,?, ?,1)').run(projectId,k,v,source);
    if(profileFields.has(k))db.prepare(`UPDATE projects SET ${k}=? WHERE id=?`).run(k==='capital'?Number(v):v,projectId);
    return db.prepare('SELECT * FROM project_facts WHERE id=? AND project_id=?').get(result.lastInsertRowid,projectId);
  })();
}
function addAssistant(conversationId,text) { saveMessage(conversationId,'assistant',text,'text'); }
async function maybeSummarize(conversation) {
  const messages=db.prepare('SELECT id,role,content FROM messages WHERE conversation_id=? ORDER BY id').all(conversation.id);
  const count=Number(conversation.summary_message_count||0);
  if(messages.length-count<24 || messages.length<=12)return;
  const toSummarize=messages.slice(count,messages.length-12);
  if(!toSummarize.length)return;
  const value = await summarizeConversation(conversation.summary,toSummarize);
  db.prepare("UPDATE conversations SET summary=?,summary_message_count=?,updated_at=datetime('now') WHERE id=?").run(value,messages.length-12,conversation.id);
}
function scheduleSummary(conversation) {
  setImmediate(()=>void maybeSummarize(conversation).catch(error=>console.error('Conversation summary failed:',error?.message||'Error')));
}
function currentContext(conversation,project,currentMessage='') {
  const contextConfig = config.agent;
  const all=db.prepare('SELECT id,role,content,input_type FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT ?').all(conversation.id,contextConfig.recentMessageLimit+1).reverse();
  const history=all.slice(0,-1);
  const relevantTerms = String(currentMessage || history.at(-1)?.content || '').toLocaleLowerCase();
  const allFacts=db.prepare('SELECT key,value FROM project_facts WHERE project_id=? AND confirmed=1 ORDER BY updated_at DESC LIMIT 80').all(project.id);
  const matchingFacts=allFacts.filter(f=>!relevantTerms||`${f.key} ${f.value}`.toLocaleLowerCase().split(/\s+/).some(term=>term.length>2&&relevantTerms.includes(term)));
  const facts=(matchingFacts.length?matchingFacts:allFacts).slice(0,12);
  const products=B.getProducts(project.id)
    .sort((a,b)=>Number(relevantTerms.includes(b.name.toLocaleLowerCase()))-Number(relevantTerms.includes(a.name.toLocaleLowerCase())))
    .slice(0,20).map(p=>({name:p.name,unit:p.unit,current_quantity:p.current_quantity,unit_cost:p.unit_cost,markup_percent:p.markup_percent}));
  return {advisor:advisor.context(project.id),availableProjects:db.prepare('SELECT name FROM projects ORDER BY id').all(),history,summary:conversation.summary||'',facts,products,pending:pendingFor(conversation.id),profile:{name:project.name,activity:project.activity,products:project.products,capital:project.capital,costs:project.costs,sales_method:project.sales_method,household_use:project.household_use}};
}
const taskRunner=createTaskRunner({db,advisor,config,contextFor:(conversationId,projectId,message)=>{
  const conversation=B.getConversation(projectId,conversationId),project=B.getProject(projectId);
  if(!conversation||!project)throw new Error('المشروع أو المحادثة مش موجودين لاستكمال المهمة.');
  return currentContext(conversation,project,message);
}});
const agentTasks=createAgentTasks(db,taskRunner.run,{leaseMs:config.agent.taskLeaseMs});
app.locals.agentTasks=agentTasks;

app.get('/api/agent-tasks/:id',(req,res)=>{
  const project=projectOr404(req.query.projectId,res);if(!project)return;
  const task=agentTasks.get(req.params.id,project.id);
  if(!task)return res.status(404).json({error:'المهمة مش موجودة في المشروع ده.'});
  const {payload,budget,...publicTask}=task;
  res.json({...publicTask,steps:agentTasks.steps(task.id,project.id)});
});
app.get('/api/plans/:id',(req,res)=>{
  const project=projectOr404(req.query.projectId,res);if(!project)return;
  const row=db.prepare('SELECT * FROM business_plans WHERE id=? AND project_id=?').get(Number(req.params.id),project.id);
  if(!row)return res.status(404).json({error:'الخطة مش موجودة في المشروع ده.'});
  res.json({plan:{...row,body:JSON.parse(row.body)}});
});
app.get('/api/agent-tasks',(req,res)=>{
  const project=projectOr404(req.query.projectId,res);if(!project)return;
  const conversation=conversationOr404(project.id,req.query.conversationId,res);if(!conversation)return;
  res.json({tasks:agentTasks.list(project.id,conversation.id).map(({payload,budget,...task})=>task)});
});
app.get('/api/agent-metrics',(req,res)=>{
  const project=projectOr404(req.query.projectId,res);if(!project)return;
  const metrics=db.prepare(`SELECT m.metric,COUNT(*) AS samples,ROUND(AVG(m.value),2) AS average,ROUND(SUM(m.value),2) AS total
    FROM agent_task_metrics m JOIN agent_tasks t ON t.id=m.task_id WHERE t.project_id=? GROUP BY m.metric ORDER BY m.metric`).all(project.id);
  const outcomes=db.prepare(`SELECT COUNT(*) AS comparisons,ROUND(AVG(amount_variance),2) AS average_amount_variance
    FROM plan_outcomes WHERE project_id=?`).get(project.id);
  const statuses=db.prepare('SELECT status,COUNT(*) AS count FROM agent_tasks WHERE project_id=? GROUP BY status').all(project.id);
  res.json({projectId:project.id,metrics,outcomes,statuses});
});
app.get('/api/agent-tasks/:id/events',(req,res)=>{
  const project=projectOr404(req.query.projectId,res);if(!project)return;
  let task=agentTasks.get(req.params.id,project.id);
  if(!task)return res.status(404).json({error:'المهمة مش موجودة في المشروع ده.'});
  res.set({'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive'});res.flushHeaders();
  const envelope=value=>{const {payload,budget,...publicTask}=value;return {...publicTask,steps:agentTasks.steps(value.id,project.id),result:['COMPLETE','PROVISIONAL','WAITING_FOR_INPUT','FAILED'].includes(value.status)?withSpeechStream(value.result):value.result};};
  const send=value=>res.write(`data: ${JSON.stringify(envelope(value))}\n\n`);
  const finish=value=>{send(value);res.end();};
  task=agentTasks.get(req.params.id,project.id);
  if(['COMPLETE','PROVISIONAL','WAITING_FOR_INPUT','FAILED','CANCELLED'].includes(task.status))return finish(task);
  send(task);
  const unsubscribe=agentTasks.subscribe(task.id,project.id,latest=>{
    if(['COMPLETE','PROVISIONAL','WAITING_FOR_INPUT','FAILED','CANCELLED'].includes(latest.status)){unsubscribe();finish(latest);}
    else send(latest);
  });
  req.on('close',unsubscribe);
});
app.delete('/api/agent-tasks/:id',(req,res)=>{
  const project=projectOr404(req.query.projectId,res);if(!project)return;
  if(!agentTasks.cancel(req.params.id,project.id))return res.status(409).json({error:'المهمة انتهت أو مش موجودة.'});
  res.json({ok:true});
});
app.get('/api/projects',(req,res)=>res.json({projects:db.prepare('SELECT id,name,activity FROM projects ORDER BY id').all()}));
app.post('/api/projects',(req,res)=>{
  const name=String(req.body.name||'').trim().slice(0,80);if(!name)return res.status(400).json({error:'اكتب اسمًا بسيطًا للمشروع.'});
  const id=db.prepare('INSERT INTO projects(name) VALUES(?)').run(name).lastInsertRowid;const project=B.getProject(id);const conversation=B.ensureConversation(id);
  res.status(201).json({project,conversationId:conversation.id});
});
app.delete('/api/projects/:id',(req,res)=>{
  const project=projectOr404(req.params.id,res);if(!project)return;
  if(db.prepare('SELECT COUNT(*) AS count FROM projects').get().count<=1)return res.status(409).json({error:'لازم يفضل عندك مشروع واحد على الأقل.'});
  try {
    db.prepare('DELETE FROM projects WHERE id=?').run(project.id);
    res.json({ok:true});
  } catch (error) {
    console.error('Could not delete project:',error.message);
    res.status(409).json({error:'ماقدرتش أحذف المشروع بسبب بيانات مرتبطة بيه. بياناتك مازالت محفوظة.'});
  }
});
app.get('/api/conversation',(req,res)=>{
  const project=projectOr404(req.query.projectId,res);if(!project)return;
  const conversation=B.getConversation(project.id,req.query.conversationId);if(!conversation)return res.status(404).json({error:'المحادثة مش موجودة في المشروع ده.'});
  const messages=db.prepare('SELECT id,role,content,input_type,created_at FROM messages WHERE conversation_id=? ORDER BY id LIMIT 300').all(conversation.id);
  res.json({conversation,messages,pending:pendingFor(conversation.id)});
});
app.post('/api/conversation/new',(req,res)=>{
  const project=projectOr404(req.body.projectId,res);if(!project)return;
  const id=db.prepare('INSERT INTO conversations(project_id,title) VALUES(?,?)').run(project.id,'محادثة جديدة').lastInsertRowid;
  res.status(201).json({conversation:db.prepare('SELECT * FROM conversations WHERE id=?').get(id)});
});
app.delete('/api/conversation/:id',(req,res)=>{
  const project=projectOr404(req.query.projectId,res);if(!project)return;
  const conversation=conversationOr404(project.id,req.params.id,res);if(!conversation)return;
  const clear=db.transaction(()=>{db.prepare('DELETE FROM messages WHERE conversation_id=?').run(conversation.id);db.prepare('DELETE FROM pending_actions WHERE conversation_id=?').run(conversation.id);db.prepare("UPDATE conversations SET summary='',summary_message_count=0,updated_at=datetime('now') WHERE id=?").run(conversation.id);});clear();
  res.json({ok:true});
});
app.get('/api/project-facts',(req,res)=>{
  const project=projectOr404(req.query.projectId,res);if(!project)return;
  res.json({facts:advisor.memory.facts(project.id)});
});
app.delete('/api/project-facts',(req,res)=>{
  const project=projectOr404(req.query.projectId,res);if(!project)return;
  db.transaction(()=>{
    db.prepare('DELETE FROM project_facts WHERE project_id=?').run(project.id);
    advisor.memory.stalePlans(project.id);
    db.prepare('UPDATE projects SET activity=NULL,products=NULL,capital=NULL,costs=NULL,sales_method=NULL,household_use=NULL WHERE id=?').run(project.id);
  })();res.json({ok:true});
});
app.delete('/api/project-facts/:id',(req,res)=>{
  const project=projectOr404(req.query.projectId,res);if(!project)return;
  const fact=db.prepare('SELECT key FROM project_facts WHERE id=? AND project_id=?').get(Number(req.params.id),project.id);
  if(!fact)return res.status(404).json({error:'المعلومة دي مش موجودة.'});
  db.transaction(()=>{
    db.prepare('DELETE FROM project_facts WHERE id=? AND project_id=?').run(Number(req.params.id),project.id);
    advisor.memory.stalePlans(project.id);
    if(profileFields.has(fact.key))db.prepare(`UPDATE projects SET ${fact.key}=NULL WHERE id=?`).run(project.id);
  })();res.json({ok:true});
});
app.get('/api/init',(req,res)=>{
  const project=projectOr404(req.query.projectId,res);if(!project)return;
  const conversation=B.getConversation(project.id,req.query.conversationId);if(!conversation)return res.status(404).json({error:'المحادثة مش موجودة.'});
  const bounds=B.periodBounds('month');const facts=db.prepare('SELECT * FROM project_facts WHERE project_id=? AND confirmed=1 ORDER BY updated_at DESC').all(project.id);
  res.json({advisor:advisor.context(project.id),project,conversationId:conversation.id,transactions:B.getTransactions(project.id,bounds.from,bounds.to),summary:B.getSummary(project.id,bounds.from,bounds.to),period:bounds,products:B.getProducts(project.id),facts:advisor.memory.facts(project.id),reminders:B.getReminders(project.id)});
});

app.get('/api/research-jobs/:id/events',(req,res)=>{
  const project=projectOr404(req.query.projectId,res);if(!project)return;
  const task=agentTasks.get(req.params.id,project.id);
  if(task) {
    res.set({'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive'});res.flushHeaders();
    const legacy=value=>({id:value.id,status:value.status==='QUEUED'?'queued':value.status==='RUNNING'?'running':value.status==='CANCELLED'?'failed':value.status==='FAILED'&&!value.result?.reply?'failed':'completed',
      result:value.result,error:value.error,updatedAt:value.updatedAt});
    const send=value=>res.write(`data: ${JSON.stringify(legacy(value))}\n\n`),finish=value=>{send(value);res.end();};
    if(!['QUEUED','RUNNING'].includes(task.status))return finish(task);
    send(task);const unsubscribe=agentTasks.subscribe(task.id,project.id,value=>{if(!['QUEUED','RUNNING'].includes(value.status)){unsubscribe();finish(value);}else send(value);});
    req.on('close',unsubscribe);return;
  }
  const job=researchJobs.get(req.params.id,project.id);
  if(!job)return res.status(404).json({error:'متابعة البحث دي انتهت أو مش موجودة في المشروع.'});
  res.set({'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive'});
  res.flushHeaders();
  const addAudio=value=>value?.status==='completed'&&value.result?.reply
    ?{...value,result:withSpeechStream(value.result)}:value;
  const send=value=>res.write(`data: ${JSON.stringify(addAudio(value))}\n\n`);
  const finish=value=>{send(value);res.end();};
  const initial=researchJobs.snapshot(job);
  if(['completed','failed'].includes(initial.status))return finish(initial);
  send(initial);
  const unsubscribe=researchJobs.subscribe(job,value=>{
    if(['completed','failed'].includes(value.status)){unsubscribe();finish(value);}
    else send(value);
  });
  req.on('close',unsubscribe);
});

app.get('/api/research-jobs/:id',(req,res)=>{
  const project=projectOr404(req.query.projectId,res);if(!project)return;
  const task=agentTasks.get(req.params.id,project.id);
  if(task) {
    const status=task.status==='QUEUED'?'queued':task.status==='RUNNING'?'running':task.status==='CANCELLED'?'failed':task.status==='FAILED'&&!task.result?.reply?'failed':'completed';
    return res.json({id:task.id,status,result:task.result,error:task.error,updatedAt:task.updatedAt});
  }
  const job=researchJobs.get(req.params.id,project.id);
  if(!job)return res.status(404).json({error:'متابعة البحث دي انتهت أو مش موجودة في المشروع.'});
  const value=researchJobs.snapshot(job);
  if(value.status==='completed'&&value.result?.reply)value.result=withSpeechStream(value.result);
  res.json(value);
});

app.post('/api/tts/ticket',(req,res)=>{
  const text=String(req.body.text||'').trim();
  if(!text||text.length>3000)return res.status(400).json({error:'مفيش نص صالح لتحويله لصوت.'});
  if(!config.geminiApiKey)return res.status(503).json({error:'تحويل الرد لصوت محتاج GEMINI_API_KEY.'});
  res.json({streamUrl:issueTtsTicket(text)});
});

app.get('/api/tts/stream/:id',async(req,res)=>{
  pruneTtsTickets();
  const ticket=ttsTickets.get(req.params.id);
  if(!ticket)return res.status(404).json({error:'رابط الصوت انتهى. اضغط إعادة السماع.'});
  ttsTickets.delete(req.params.id);
  let started=false;
  try{
    const client=createGeminiClient(config,{timeoutMs:config.geminiTtsTimeoutMs});
    const stream=await withDeadline(client.interactions.create({
      model:'gemini-3.8-flash-lite-tts',
      input:[{type:'user_input',content:[{type:'text',text:ticket.text,annotations:[{type:'speech_metadata',style:'Speak in a warm, natural Egyptian Arabic feminine voice. Read the text verbatim.'}]}]}],
      response_format:{type:'audio',mime_type:'audio/l16',sample_rate:24000},
      generation_config:{speech_config:[{voice:'Aoede'}]},
      stream:true,
    },{timeout:config.geminiTtsTimeoutMs}),config.geminiTtsTimeoutMs,'TTS_TIMEOUT');
    const iterator=stream[Symbol.asyncIterator]();
    while(true) {
      const next=await withDeadline(iterator.next(),config.geminiTtsTimeoutMs,'TTS_TIMEOUT');
      if(next.done)break;
      const event=next.value;
      const audio=event?.delta?.type==='audio'&&event.delta.data?Buffer.from(event.delta.data,'base64'):null;
      if(!audio?.length)continue;
      if(!started){started=true;res.status(200).set({'Content-Type':'audio/l16; rate=24000; channels=1','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Accel-Buffering':'no'});res.flushHeaders();}
      if(!res.write(audio))await new Promise(resolve=>res.once('drain',resolve));
    }
    if(!started)throw new Error('Gemini returned no streamed audio.');
    res.end();
  }catch(error){
    const providerStatus=Number(error?.status||error?.statusCode||error?.response?.status||error?.cause?.status||0);
    console.error('Speech stream failed:',[error?.name||'Error',error?.code||null,providerStatus?`HTTP ${providerStatus}`:null].filter(Boolean).join(' / '));
    if(res.headersSent)return res.destroy(error);
    const timedOut=error?.code==='TTS_TIMEOUT'||error?.code===23||error?.name==='TimeoutError';
    const status=providerStatus===429?429:timedOut?504:503;
    const message=providerStatus===429?'صوت Gemini وصل لحد الاستخدام مؤقتًا. الرد النصي موجود.':timedOut?'صوت Gemini اتأخر، فوقفت الانتظار. الرد النصي موجود.':'تعذر تجهيز صوت الرد من Gemini. الرد النصي موجود.';
    res.status(status).json({error:message});
  }
});

app.post('/api/chat',async(req,res)=>{
  const text=String(req.body.message||'').trim();if(!text||text.length>1500)return res.status(400).json({error:'اكتب رسالة قصيرة للمساعد.'});
  const project=projectOr404(req.body.projectId,res);if(!project)return;
  const conversation=B.getConversation(project.id,req.body.conversationId);if(!conversation)return res.status(404).json({error:'المحادثة مش موجودة في المشروع ده.'});

  const requestId=String(req.body.requestId||randomUUID()).slice(0,80);
  const requestHash=createHash('sha256').update(JSON.stringify({projectId:project.id,conversationId:conversation.id,text})).digest('hex');
  const existingRequest=db.prepare('SELECT conversation_id,response_json,status_code,request_hash FROM chat_requests WHERE request_id=?').get(requestId);
  if(existingRequest){
    if(existingRequest.conversation_id!==conversation.id)return res.status(409).json({error:'معرّف الرسالة مستخدم لمحادثة تانية.'});
    if(existingRequest.request_hash&&existingRequest.request_hash!==requestHash)return res.status(409).json({error:'معرّف الرسالة مستخدم لرسالة مختلفة.'});
    if(existingRequest.response_json)return res.status(existingRequest.status_code).json(withSpeechStream(safeJson(existingRequest.response_json)||{}));
    return res.status(409).json({error:'الرسالة لسه بتتعالج. استني رد فهيمة قبل ما تبعتيها تاني.'});
  }
  if(chatInFlight.has(conversation.id))return res.status(429).json({error:'لسه برد على رسالتك اللي فاتت. استني لحظة.'});
  chatInFlight.add(conversation.id);
  const requestStartedAt=Date.now();
  diagnostic('agent.request.started',{requestId,projectId:project.id,conversationId:conversation.id,inputType:req.body.inputType==='voice'?'voice':'text'});
  db.prepare('INSERT INTO chat_requests(request_id,conversation_id,request_hash) VALUES(?,?,?)').run(requestId,conversation.id,requestHash);
  const originalJson=res.json.bind(res);
  res.json=(body)=>{
    const storedBody=body&&typeof body==='object'?{...body}:body;
    if(storedBody&&typeof storedBody==='object')delete storedBody.speechStreamUrl;
    db.prepare('UPDATE chat_requests SET response_json=?,status_code=? WHERE request_id=?').run(JSON.stringify(storedBody),res.statusCode,requestId);
    return originalJson(withSpeechStream(body));
  };
  res.on('finish',()=>{
    chatInFlight.delete(conversation.id);
    diagnostic('agent.response.delivered',{requestId,projectId:project.id,conversationId:conversation.id,statusCode:res.statusCode,durationMs:Date.now()-requestStartedAt});
  });

  const inputType=req.body.inputType==='voice'?'voice':'text';const userMessage=saveMessage(conversation.id,'user',text,inputType);const active=pendingFor(conversation.id);
  const affirmative=/^(أيوه|ايوه|نعم|تمام|موافق(?:ة)?|سجل(?:ي)?|أكد(?:ي)?|اه)$/u.test(text);
  const negative=/^(لأ|لا|الغ(?:ي|اء)|مش دلوقتي|إلغاء|الغاء)$/u.test(text);
  const waitingForResult=/^(?:فين(?:ها|ه)?|خلصت(?:ي)?|طب النتيجة|قولتلك احسب(?:ي)?|هجيب قد (?:إيه|ايه|اه))[؟?!.\s]*$/u.test(text);
  if(waitingForResult) {
    const latestTask=agentTasks.latest(project.id,conversation.id);
    if(latestTask) {
      const update=latestTask,status=update.status==='QUEUED'?'queued':update.status==='RUNNING'?'running':update.status==='FAILED'||update.status==='CANCELLED'?'failed':'completed';
      const reply=status==='completed'&&update.result?.reply?update.result.reply:status==='failed'?update.error
        :'فهيمة لسه بتكمل المهمة في الخلفية. هتظهر النتيجة هنا لما تخلص.';
      addAssistant(conversation.id,reply);
      return res.json({kind:status==='completed'?'advice':'answer',reply,speechText:update.result?.speechText||reply,
        research:update.result?.research||[],calculations:update.result?.calculations||[],agentTaskId:['queued','running'].includes(status)?update.id:null,
        researchJobId:['queued','running'].includes(status)?update.id:null,conversationId:conversation.id,inputType});
    }
    const latest=researchJobs.latest(project.id,conversation.id);
    if(latest) {
      const update=researchJobs.snapshot(latest);
      const reply=update.status==='completed'&&update.result?.reply?update.result.reply
        :update.status==='failed'?update.error
          :'البحث شغال فعلًا ولسه جوه المهلة. النتيجة هتظهر في المحادثة، ولو البحث فشل هقولك السبب والبديل بوضوح.';
      addAssistant(conversation.id,reply);
      return res.json({kind:update.status==='completed'?'advice':'answer',reply,
        speechText:update.result?.speechText||reply,research:update.result?.research||[],calculations:update.result?.calculations||[],
        researchJobId:['queued','running'].includes(update.status)?update.id:null,conversationId:conversation.id,inputType});
    }
  }
  const planIntent=/(?:دراسة جدوى|(?:عايز|عايزة)\s+خطة|(?:اعملي|اعمل|اكتبلي|اكتب لي|جهزلي|جهز لي).{0,25}خطة|(?:ابدأ|أبدأ)\s*(?:لي\s*)?مشروع|(?:عايز|عايزة|نفسي).{0,50}(?:أبدأ|ابدأ|أعمل|اعمل).{0,30}مشروع)/u.test(text);
  if(planIntent&&!active) {
    const fingerprint=projectFingerprint(db,project.id),budget=taskBudget('business_plan',config);
    let task;
    try {
      task=agentTasks.create({projectId:project.id,conversationId:conversation.id,sourceMessageId:userMessage.id,type:'business_plan',
        objective:text.slice(0,180),payload:{message:text,parsed:null,projectFingerprint:fingerprint,baselineDecisionCount:0,baselineInputTokens:0,baselineOutputTokens:0},projectFingerprint:fingerprint,budget});
    } catch(error) {
      const code=String(error?.code||error?.name||'AGENT_TASK_CREATE_FAILED').replace(/[^A-Za-z0-9_-]/gu,'').slice(0,80)||'AGENT_TASK_CREATE_FAILED';
      diagnostic('agent.task.create.failed',{requestId,projectId:project.id,conversationId:conversation.id,code});
      return res.status(503).json({error:'اتسجلت رسالتك، لكن ماقدرتش أبدأ تجهيز الخطة دلوقتي. جرّب الإرسال تاني بعد شوية.',code:'AGENT_TASK_CREATE_FAILED'});
    }
    const reply='بدأت أفهم ظروف المشروع وأجهز خطة مناسبة. هتظهر هنا النتيجة أو أهم معلومة محتاجاها علشان أكمل.';
    addAssistant(conversation.id,reply);scheduleSummary(conversation);
    return res.json({kind:'task',reply,agentTaskId:task.id,agentTaskStatus:task.status,conversationId:conversation.id,inputType});
  }
  if(active?.status==='awaiting_confirmation'&&affirmative){
    if(active.payload.needsReview) {
      const rows=active.action_type==='transaction_batch'?active.payload.transactions:active.action_type==='transaction'?[active.payload]:[];
      const details=rows.map(row=>`${transactionKindLabel(row.type)} ${row.productName||''} بـ${Number(row.amount).toLocaleString('ar-EG')} جنيه`).join('، ');
      const reply=details?`نرجع للعملية المعلقة: ${details}. تأكيد تسجيلها؟`:'لسه فيه طلب معلق. تأكيد حفظه؟';
      const payload={...active.payload,needsReview:false};
      setPending(conversation.id,project.id,active.action_type,active.status,payload);
      addAssistant(conversation.id,reply);
      return res.json({kind:'confirm',reply,conversationId:conversation.id,inputType});
    }
    try{const result=await commitPending(project,conversation,active);const reply=result.reply;addAssistant(conversation.id,reply);scheduleSummary(conversation);return res.json({kind:'saved',reply,transaction:result.transaction,transactions:result.transactions,conversationId:conversation.id,inputType});}
    catch(e){const reply=e.message;addAssistant(conversation.id,reply);return res.json({kind:'clarify',reply,conversationId:conversation.id,inputType});}
  }
  if(active&&negative){db.prepare('DELETE FROM pending_actions WHERE conversation_id=?').run(conversation.id);const reply='تمام، ألغيت العملية وماتسجلتش.';addAssistant(conversation.id,reply);return res.json({kind:'answer',reply,conversationId:conversation.id,inputType});}
  const context=currentContext(conversation,project,text);let parsed;
  const tools=createBusinessTools(project.id);
  try{
    const domainCheck=isOutOfDomain(text);
    if(domainCheck) parsed={intent:'question',answer:'أنا فهيمة، شغلي أساعدك في مشروعك والبيع والمصاريف والمشتريات والمخزون وتنظيم الشغل. احكي لي عن حاجة تخص مشروعك وأنا أساعدك.'};
    else parsed=await extract(text,context);
    const wantsReport=/(?:اعملي|اعمل|وريني|هات).{0,20}(?:تقرير|حسابات)/u.test(text);
    if(wantsReport&&!['create_report','daily_sales_summary','period_summary'].includes(parsed.intent))parsed.intent='create_report';
    const directAction=/(?:احسب(?:ي)?|قسم(?:ي)?لي|هجيب (?:كام|قد)|اعملي خطة|اعمل خطة|شوف(?:ي)? الأسعار|دور(?:ي)? على السعر)/u.test(text);
    const hasExecution=value=>(value?.calculations?.length||0)>0||(value?.research_requests?.length||0)>0||Boolean(value?.plan)||['create_report','daily_sales_summary','period_summary','inventory_query','product_sales_query','price_estimate'].includes(value?.intent);
    if(directAction&&!hasExecution(parsed)) {
      diagnostic('agent.action.retry',{requestId,projectId:project.id,conversationId:conversation.id,reason:'model_returned_no_action'});
      try {
        const retry=await extract(text,{...context,actionRequested:true});
        if(hasExecution(retry))parsed=retry;
        else {
          const knownFacts=advisor.memory.facts(project.id);
          const capital=knownFacts.find(fact=>fact.key==='capital'&&fact.numeric_value!=null);
          const activity=knownFacts.find(fact=>fact.key==='activity');
          const prices=knownFacts.filter(fact=>fact.kind==='price'&&fact.numeric_value!=null);
          const references=advisor.memory.research(project.id,{freshOnly:true}).filter(row=>row.price!=null);
          const hasPrice=prices.length||references.length;
          const hasProjectInputs=capital&&activity&&!hasPrice;
          const reply=hasProjectInputs
            ?`ميزانية مشروع ${activity.value} المحفوظة هي ${Number(capital.numeric_value).toLocaleString('ar-EG')} جنيه. عشان أطلع عدد مسؤول، لازم أراجع سعر المدخلات الأساسية؛ الأسعار مش محفوظة عندي ومش هخمنها.`
            :'مش لاقية بيانات كفاية أطلع منها حساب موثوق. هستخدم الأرقام المتاحة عندك ومش هخمن أي رقم ناقص.';
          const question=hasProjectInputs
            ?{text:'إيه أهم منتج أو خامة أراجع سعرها الأول؟',fact_key:null,reason:'اختيار المدخل الأساسي لحساب بداية المشروع'}
            :{text:'إيه المبلغ أو العدد اللي عايز تحسبه؟',fact_key:null,reason:'تحديد مدخل الحساب المطلوب'};
          parsed={...retry,answer:reply,question,calculations:[],research_requests:[],plan:null};
          diagnostic('agent.action.incomplete',{requestId,projectId:project.id,conversationId:conversation.id,reason:'no_supported_inputs'});
        }
      } catch(error) {
        parsed={...parsed,answer:'حاولت أكمّل الحساب من سياق كلامنا، لكن ماقدرتش أحدد مدخلات موثوقة. مش هخمن أسعار أو أرقام. قوليلي سعر المنتج أو الخامة اللي عايز تحسبها.',question:null};
        diagnostic('agent.action.retry_failed',{requestId,projectId:project.id,conversationId:conversation.id,errorCode:error?.code||error?.status||'unknown'});
      }
    }
    diagnostic('agent.action.selected',{requestId,projectId:project.id,conversationId:conversation.id,intent:parsed.intent,researchCount:parsed.research_requests?.length||0,calculationCount:parsed.calculations?.length||0});
  }catch(e){
    const status=Number(e?.status||e?.statusCode||e?.response?.status||e?.cause?.status||0);
    console.error('Agent request failed:',[e?.name||'Error',e?.code||null,status?`HTTP ${status}`:null].filter(Boolean).join(' / '));
    parsed=null;
    if(!parsed){
      const reply=status===429
        ?'فهيمة خارج الخدمة مؤقتًا لأن Gemini وصل لحد الاستخدام. بيانات مشروعك محفوظة، جرب تاني بعد ما تتجدد الحصة.'
        :process.env.GEMINI_API_KEY?'حصلت مشكلة مؤقتة في المساعد. جرب تاني أو اكتب طلبك بشكل أوضح.':'فهم الرسائل محتاج إعداد مفتاح Gemini. بياناتك وتقاريرك المحفوظة لسه متاحة.';
      addAssistant(conversation.id,reply);
      if(status===429)return res.json({kind:'answer',reply,conversationId:conversation.id,inputType});
      return res.status(503).json({error:reply});
    }
  }
  // Mixed messages retain proposals in plans and stage only completed operations.
  if(parsed.transactions?.some(item=>item.transaction_status)) {
    const proposed=parsed.transactions.filter(item=>item.transaction_status==='planned');
    parsed.planned_transactions=proposed;
    if(proposed.length&&!parsed.plan)parsed.plan={title:'خطوات مقترحة للمشروع',summary:'دي خطوات لسه ما اتنفذتش.',requirements:[],assumptions:[],risks:[],indicators:[],next_action:'مراجعة المتطلبات قبل التنفيذ.',steps:proposed.map((item,i)=>({key:'planned_'+i,text:item.description||'خطوة مقترحة للمشروع',status:'proposed',evidence:null}))};
    const completed=parsed.transactions.filter(item=>(item.transaction_status||parsed.transaction_status)==='actual');
    parsed.transactions=completed;
    parsed.transaction_status=completed.length?'actual':'planned';
    if(!completed.length)parsed.intent='advise';
  }
  if(parsed.intent==='record_transactions'&&parsed.transactions?.length===1)parsed={...parsed,...parsed.transactions[0],intent:'record_transaction'};
  if(Array.isArray(parsed.transactions)&&parsed.transactions.length>1)parsed.intent='record_transactions';
  let result,advice;
  try{
    if(parsed.intent==='switch_project') {
      const reference=String(parsed.project_reference||'').trim();
      const matches=db.prepare('SELECT id,name FROM projects WHERE name=?').all(reference);
      if(!reference||!text.includes(reference)||matches.length!==1) return res.json({kind:'clarify',reply:'اختار المشروع المقصود من قائمة المشروعات علشان نكمل عليه.',conversationId:conversation.id,inputType});
      const target=matches[0];
      return res.json({kind:'switch_project',projectId:target.id,reply:'هنكمل على مشروع «'+target.name+'».',conversationId:conversation.id,inputType});
    }
    advice=await advisor.process(project.id,userMessage.id,text,parsed,{deferResearch:true});
    if(['record_transaction','record_transactions'].includes(parsed.intent)&&parsed.transaction_status!=='actual') {
      parsed.intent='advise';
      if(!advice.plan)advice.reply='ده اقتراح لخطوة جاية، ومش هيتسجل كمصروف اتدفع. '+advice.reply;
    }

    if(active?.action_type==='transaction_batch'&&active.status==='waiting_for_details'&&parsed.intent==='record_transaction'){
      const tx=transactionBatchPending([],active,text,parsed);setPending(conversation.id,project.id,'transaction_batch',tx.status,tx.payload);
      result={kind:tx.status==='awaiting_confirmation'?'confirm':'clarify',reply:tx.reply,pending:{action_type:'transaction_batch',status:tx.status,payload:tx.payload}};
    } else switch(parsed.intent){
      case 'record_transactions': {
        if (!Array.isArray(parsed.transactions) || parsed.transactions.length < 2 || parsed.transactions.length > 50) { result={kind:'clarify',reply:'قول لي كل عملية ومبلغها بوضوح، وعددهم ما يزيدش عن 50.'};break; }
        const tx=transactionBatchPending(parsed.transactions,null,text);setPending(conversation.id,project.id,'transaction_batch',tx.status,tx.payload);
        result={kind:tx.status==='awaiting_confirmation'?'confirm':'clarify',reply:tx.reply,pending:{action_type:'transaction_batch',status:tx.status,payload:tx.payload}};break;
      }
      case 'record_transaction': {
        if(active?.action_type==='transaction_batch'&&active.status==='waiting_for_details'){
          const tx=transactionBatchPending([],active,text,parsed);setPending(conversation.id,project.id,'transaction_batch',tx.status,tx.payload);
          result={kind:tx.status==='awaiting_confirmation'?'confirm':'clarify',reply:tx.reply,pending:{action_type:'transaction_batch',status:tx.status,payload:tx.payload}};break;
        }
        const tx=transactionPending(parsed,active,text);setPending(conversation.id,project.id,'transaction',tx.status,tx.payload);
        result={kind:tx.status==='awaiting_confirmation'?'confirm':'clarify',reply:tx.reply,pending:{action_type:'transaction',status:tx.status,payload:tx.payload}};break;
      }
      case 'daily_sales_summary':
      case 'period_summary': {
        const period=parsePeriod(parsed);const bounds=B.periodBounds(period);
        const toolResult=executeBusinessTool(tools,parsed.intent==='daily_sales_summary'?'get_sales_summary':'get_project_summary',{period});
        const s=toolResult.summary;
        if(parsed.intent==='daily_sales_summary'){
          result={kind:'answer',reply:`سجلت ${periodLabel(period)} ${toolResult.total.toLocaleString('ar-EG')} جنيه من ${toolResult.count} عملية.`,summary:{total:toolResult.total,count:toolResult.count},period:toolResult.period};
        } else result={kind:'answer',reply:B.formatSummary(s,periodLabel(period)),summary:s,period:toolResult.period};
        break;
      }
      case 'inventory_query': {
        const inventory=executeBusinessTool(tools,'get_inventory',{product_name:parsed.product_name});
        result={kind:'answer',reply:inventory.product?`عندك ${inventory.product.current_quantity} ${inventory.product.unit} من ${inventory.product.name}.`:inventory.products.length?`${parsed.product_name?'مش لاقية المنتج ده. ':''}المخزون المسجل: ${inventory.products.map(p=>`${p.name}: ${p.current_quantity} ${p.unit}`).join('، ')}.`:'لسه مفيش منتجات مسجلة في المخزون.'};break;
      }
      case 'product_sales_query': {
        const productSales=executeBusinessTool(tools,'get_product_sales',{period:parsePeriod(parsed)});const rows=productSales.sales;
        result={kind:'answer',reply:rows.length?`أكتر المنتجات اللي اتباعت حسب الكمية: ${rows.slice(0,3).map((x,i)=>`${i+1}) ${x.name}: ${x.quantity} ${x.unit}`).join('، ')}. ده من المبيعات المفصلة المسجلة بس.`:'مفيش مبيعات بمنتجات وكميات مفصلة في الفترة دي.'};break;
      }
      case 'create_report': {
        const bounds=B.periodBounds(parsePeriod(parsed));
        result={kind:'report',reply:'حاضر، بجهز تقرير PDF للفترة دي. هيكون اتحمّل على جهازك.',period:bounds};break;
      }
      case 'create_reminder': {
        const old=active?.action_type==='reminder'?active.payload:{};
        const payload={title:parsed.reminder_title||old.title||parsed.description||'',dueAt:parsed.due_date||old.dueAt||''};
        if(!payload.title||!validDate(payload.dueAt)){setPending(conversation.id,project.id,'reminder','waiting_for_details',payload);result={kind:'clarify',reply:!payload.title?'أفكرك تعملي إيه؟':'تحب أذكرك في أنهي يوم؟'};break;}
        setPending(conversation.id,project.id,'reminder','awaiting_confirmation',payload);result={kind:'confirm',reply:`أفكرك بـ${payload.title} يوم ${payload.dueAt}؟ قول «أيوه» للحفظ أو صححيها بالكلام.`,pending:{action_type:'reminder',status:'awaiting_confirmation',payload}};break;
      }
      case 'price_estimate': {
        const product=parsed.product_name?B.findProduct(project.id,parsed.product_name):null;const cost=parsed.amount??parsed.unit_price??product?.unit_cost;const markup=parsed.markup_percent??product?.markup_percent;
        if(!Number.isFinite(Number(cost))||Number(cost)<=0)result={kind:'clarify',reply:'تكلفة الوحدة كام؟'};
        else if(!Number.isFinite(Number(markup))||Number(markup)<0||markup==null)result={kind:'clarify',reply:'تحب تضيفي كام في المية فوق التكلفة؟'};
        else {const estimate=executeBusinessTool(tools,'estimate_price',{cost,markup_percent:markup});result={kind:'answer',reply:`لو تكلفة الوحدة ${estimate.cost} جنيه والإضافة ${estimate.markup_percent}%، يبقى السعر ${estimate.price} جنيه. ده حساب من أرقامك، مش سعر السوق.`};}
        break;
      }
      case 'project_fact':
      case 'profile':
      case 'advise':
      default: result={kind:'advice',reply:advice.reply};


    }
  }catch(e){result={kind:'clarify',reply:/\p{Script=Arabic}/u.test(e.message||'')?e.message:'مش قادر أتعامل مع الطلب دلوقتي. ممكن نوضح التفاصيل؟'};}
  result.reply=cleanLanguage(result.reply);
  if(active?.status==='awaiting_confirmation'&&!result.pending&&['advice','answer','report'].includes(result.kind)) {
    setPending(conversation.id,project.id,active.action_type,active.status,{...active.payload,needsReview:true});
  }
  if(advice){
    result.factsChanged=advice.factsChanged;result.advisorState=advice.state;result.plan=advice.plan;result.calculations=advice.calculations;result.research=advice.research;result.marketResearchChanged=advice.marketResearchChanged;result.speechText=result.kind==='advice'?advice.speechText:result.reply;
    const needsAgentTask=!result.pending&&!active?.status&&(
      Boolean(advice.pendingResearch?.length)||Boolean(planIntent&&result.kind==='advice'));
    if(needsAgentTask) {
      const type=planIntent?'business_plan':'multi_step';
      const budget=taskBudget(type,config);
      const fingerprint=projectFingerprint(db,project.id);
      let task;
      try {
        task=agentTasks.create({projectId:project.id,conversationId:conversation.id,sourceMessageId:userMessage.id,type,
          objective:parsed.state_update?.objective||parsed.plan?.title||advisor.memory.state(project.id).objective||text.slice(0,180),
          payload:{message:text,parsed,initialAdvice:advice,projectFingerprint:fingerprint,baselineDecisionCount:1,
            baselineInputTokens:parsed.usage?.inputTokens||0,baselineOutputTokens:parsed.usage?.outputTokens||0},projectFingerprint:fingerprint,budget,decisionCount:1,
          inputTokens:parsed.usage?.inputTokens,outputTokens:parsed.usage?.outputTokens});
      } catch(error) {
        const code=String(error?.code||error?.name||'AGENT_TASK_CREATE_FAILED').replace(/[^A-Za-z0-9_-]/gu,'').slice(0,80)||'AGENT_TASK_CREATE_FAILED';
        diagnostic('agent.task.create.failed',{requestId,projectId:project.id,conversationId:conversation.id,code});
        return res.status(503).json({error:'اتسجلت رسالتك، لكن ماقدرتش أبدأ تنفيذ الطلب دلوقتي. جرّب الإرسال تاني بعد شوية.',code:'AGENT_TASK_CREATE_FAILED'});
      }
      result.agentTaskId=task.id;result.agentTaskStatus=task.status;
      result.researchJobId=task.id;
      result.reply='بدأت أراجع المعلومات والأسعار والحسابات علشان أطلع نتيجة وخطة مناسبة. هتظهر هنا أول ما تجهز.';
      result.speechText=result.reply;
    }
  }
  addAssistant(conversation.id,result.reply);if(result.pending){const saved=pendingFor(conversation.id);if(saved)result.pending.id=saved.id;}
  scheduleSummary(conversation);
  res.json({...result,conversationId:conversation.id,inputType});
});

function recordPlanOutcome(projectId,transaction,input) {
  if(transaction.estimated)return;
  const plan=advisor.memory.latestPlan(projectId);
  if(!plan)return;
  const proposals=plan.body.proposed_transactions||[];
  const norm=value=>String(value||'').toLocaleLowerCase('ar-EG').replace(/[\s\u0640]/gu,'').trim();
  const proposal=proposals.find(item=>item.type===transaction.type&&
    (input.productName?norm(item.product_name)===norm(input.productName):item.amount_kind==='total'&&item.amount!=null&&Math.abs(Number(item.amount)-transaction.amount)<0.01));
  if(!proposal)return;
  const actual={type:transaction.type,amount:transaction.amount,date:transaction.date,description:transaction.description,
    product_name:input.productName||null,quantity:input.quantity??null,unit:input.unit||null};
  db.prepare(`INSERT OR IGNORE INTO plan_outcomes(project_id,plan_id,transaction_id,planned_json,actual_json,amount_variance)
    VALUES(?,?,?,?,?,?)`).run(projectId,plan.id,transaction.id,JSON.stringify(proposal),JSON.stringify(actual),
    proposal.amount_kind==='total'&&proposal.amount!=null?Number(transaction.amount)-Number(proposal.amount):null);
}
async function commitPending(project,conversation,active) {
  if(active.status!=='awaiting_confirmation')throw new Error('كمّلي البيانات وراجعها قبل الحفظ.');
  const payload=active.payload;
  if(active.action_type==='transaction'){
    const transaction=B.recordTransaction(project.id,payload);
    recordPlanOutcome(project.id,transaction,payload);
    advisor.memory.stalePlans(project.id);
    db.prepare('DELETE FROM pending_actions WHERE conversation_id=?').run(conversation.id);
    return {transaction,reply:`تمام، سجلت العملية بـ${Number(transaction.amount).toLocaleString('ar-EG')} جنيه.`};
  }
  if(active.action_type==='transaction_batch'){
    const saveBatch=db.transaction(()=>{
      const transactions=(payload.transactions||[]).map(item=>{const transaction=B.recordTransaction(project.id,item);recordPlanOutcome(project.id,transaction,item);return transaction;});
      db.prepare('DELETE FROM pending_actions WHERE conversation_id=?').run(conversation.id);
      return transactions;
    });
    const transactions=saveBatch();
    advisor.memory.stalePlans(project.id);
    const reply=`تمام، سجلت ${transactions.map(row=>`${transactionKindLabel(row.type)} بـ${Number(row.amount).toLocaleString('ar-EG')} جنيه`).join('، ')}.`;
    return {transactions,reply};
  }
  if(active.action_type==='reminder'){
    B.addReminder(project.id,payload.title,payload.dueAt);db.prepare('DELETE FROM pending_actions WHERE conversation_id=?').run(conversation.id);
    return {reply:`حفظت التذكير: ${payload.title} يوم ${payload.dueAt}.`};
  }
  if(active.action_type==='project_fact'){
    const fact=upsertFact(project.id,payload.key,payload.value,'conversation');db.prepare('DELETE FROM pending_actions WHERE conversation_id=?').run(conversation.id);
    return {fact,reply:'حفظت المعلومة في ذاكرة المشروع.'};
  }
  throw new Error('الطلب المعلق مش معروف.');
}
app.post('/api/pending-actions/:id/confirm',async(req,res)=>{
  const project=projectOr404(req.body.projectId,res);if(!project)return;
  const conversation=conversationOr404(project.id,req.body.conversationId,res);if(!conversation)return;
  const active=pendingFor(conversation.id);if(!active||active.id!==Number(req.params.id)||active.status!=='awaiting_confirmation')return res.status(409).json({error:'العملية المعلقة انتهت أو تغيرت. راجع المحادثة.'});
  if(req.body.changes&&Object.keys(req.body.changes).length)return res.status(400).json({error:'قول التصحيح في المحادثة عشان نراجعه قبل الحفظ.'});
  try{const result=await commitPending(project,conversation,active);addAssistant(conversation.id,result.reply);res.json(result);}catch(e){res.status(400).json({error:e.message});}
});
app.delete('/api/pending-actions/:id',(req,res)=>{const project=projectOr404(req.query.projectId,res);if(!project)return;const conversation=conversationOr404(project.id,req.query.conversationId,res);if(!conversation)return;db.prepare('DELETE FROM pending_actions WHERE id=? AND conversation_id=?').run(Number(req.params.id),conversation.id);res.json({ok:true});});
function requireConversation(req,res) {
  res.status(403).json({error:'قول التفاصيل في المحادثة عشان فهيمة تفهمها وتراجعها معاك قبل الحفظ.'});
}
createBusinessRoutes({ app, db, business: B, validDate, projectOr404, requireConversation });

if (require.main === module) {
  const port=config.port;
  const server=app.listen(port,'127.0.0.1',()=>console.log(`Server run on: http://localhost:${port}`));
  function shutdown(){server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),2500).unref();}
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
module.exports = app;
