require('dotenv').config();
const path = require('node:path');
const express = require('express');
const { loadConfig } = require('./config');
const db = require('./db');
const { extract, summarizeConversation, deterministicFallback, isOutOfDomain } = require('./agent');
const { amountFromText } = require('./finance');
const B = require('./business');
const { createBusinessTools, executeBusinessTool } = require('./business-tools');
const { randomUUID } = require('node:crypto');
const { createGeminiClient } = require('./gemini-client');
const quota = require('./gemini-quota');
const config = loadConfig();
if (config.issues.length) console.warn('Configuration values need attention:', config.issues.join(' '));
// Ensure the first visit has a selectable local project, including on a fresh database.
B.getProject(1);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname,'..','public')));
const chatInFlight = new Set();
const lastChatAt = new Map();

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
function upsertFact(projectId,key,value,source='conversation') {
  const k=String(key||'other').trim().slice(0,80); const v=String(value||'').trim().slice(0,300);
  if(!k||!v)throw new Error('اكتبي المعلومة اللي حابة تحفظيها.');
  db.prepare('DELETE FROM project_facts WHERE project_id=? AND key=?').run(projectId,k);
  const result=db.prepare('INSERT INTO project_facts(project_id,key,value,source,confirmed) VALUES(?,?,?, ?,1)').run(projectId,k,v,source);
  return db.prepare('SELECT * FROM project_facts WHERE id=?').get(result.lastInsertRowid);
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
function currentContext(conversation,project,currentMessage='') {
  const contextConfig = config.agent;
  const all=db.prepare('SELECT id,role,content,input_type FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT ?').all(conversation.id,contextConfig.recentMessageLimit+1).reverse();
  const history=all.slice(0,-1);
  const relevantTerms = String(currentMessage || history.at(-1)?.content || '').toLocaleLowerCase();
  const allFacts=db.prepare('SELECT key,value FROM project_facts WHERE project_id=? AND confirmed=1 ORDER BY updated_at DESC LIMIT 80').all(project.id);
  const matchingFacts=allFacts.filter(f=>!relevantTerms||`${f.key} ${f.value}`.toLocaleLowerCase().split(/\s+/).some(term=>term.length>2&&relevantTerms.includes(term)));
  const facts=(matchingFacts.length?matchingFacts:allFacts).slice(0,12);
  const wantsInventory=/(?:مخزون|موجود|فاضل|عندي كام|منتج|منتجات|كرتون|علبة|قطعة|سعر بيع)/u.test(relevantTerms);
  const products=wantsInventory?B.getProducts(project.id).slice(0,15).map(p=>({name:p.name,unit:p.unit,current_quantity:p.current_quantity,unit_cost:p.unit_cost,markup_percent:p.markup_percent})):[];
  return {history,summary:conversation.summary||'',facts,products,pending:pendingFor(conversation.id),profile:{name:project.name,activity:project.activity,products:project.products,capital:project.capital,costs:project.costs,sales_method:project.sales_method,household_use:project.household_use}};
}
function parsePeriod(text, parsed) {
  if (/النهارده|اليوم|دلوقتي|اليومين/.test(text)) return 'today';
  if (/الأسبوع|الاسبوع|أسبوع|اسبوع/.test(text)) return 'week';
  if (/الشهر|شهري/.test(text)) return 'month';
  return parsed.period||'today';
}
function periodLabel(period) { return period==='week'?'الأسبوع ده':period==='month'?'الشهر ده':period==='all'?'كل الفترة':'النهارده'; }
function scalarAmount(parsed, raw) { return parsed.amount!=null?Number(parsed.amount):amountFromText(raw); }
function questionForPending(p) {
  return ({transaction_type:'نوع العملية بيع ولا شراء ولا مصروف؟',amount:'المبلغ كام بالجنيه؟',product_name:'اشتريتي أو بعتي إيه؟',quantity:'الكمية كام وبأي وحدة؟',unit_price:'سعر الوحدة كام؟',due_date:'تحبي أذكرك إمتى؟',reminder_title:'أفكرك تعملي إيه؟',markup_percent:'تحبي تضيفي كام في المية فوق التكلفة؟'})[p.waiting_for]||'ممكن توضحيلي معلومة واحدة كمان؟';
}
function mergePendingTransaction(pending,parsed,raw) {
  const next={...pending};
  for(const [key,value] of Object.entries({type:parsed.transaction_type,amount:parsed.amount,date:parsed.date,description:parsed.description,estimated:parsed.estimated,productName:parsed.product_name,quantity:parsed.quantity,unit:parsed.unit,unitPrice:parsed.unit_price,amountKind:parsed.amount_kind})) if(value!==null&&value!==undefined&&value!==''&&!(key==='estimated'&&value===false)) next[key]=value;
  const n=scalarAmount(parsed,raw);
  if(pending.waiting_for==='product_name'&&!next.productName)next.productName=raw.trim();
  if(pending.waiting_for==='transaction_type'&&!next.type&&parsed.transaction_type)next.type=parsed.transaction_type;
  if(pending.waiting_for==='quantity'&&next.quantity==null&&n!=null)next.quantity=n;
  if(pending.waiting_for==='unit_price'&&next.unitPrice==null&&n!=null){next.unitPrice=n;next.amountKind='unit_price';}
  if(pending.waiting_for==='amount'&&next.amount==null&&n!=null){next.amount=n;next.amountKind='total';}
  if(pending.waiting_for==='unit'&&!next.unit)next.unit=raw.trim();
  delete next.waiting_for;
  return next;
}
function transactionPending(parsed,projectId,existing,raw) {
  let x=existing?.action_type==='transaction'?mergePendingTransaction(existing.payload,parsed,raw):{
    type:parsed.transaction_type,amount:parsed.amount,date:parsed.date,description:parsed.description||raw,
    estimated:parsed.estimated,productName:parsed.product_name,quantity:parsed.quantity,unit:parsed.unit,unitPrice:parsed.unit_price,amountKind:parsed.amount_kind
  };
  if(!x.date||!/^\d{4}-\d{2}-\d{2}$/.test(x.date))x.date=B.localDate();
  if(!x.description)x.description=raw;
  if(x.amountKind==='unit_price'&&x.quantity&&x.amount!=null&&x.unitPrice==null){x.unitPrice=x.amount;x.amount=null;}
  if(x.quantity&&x.amount!=null&&x.unitPrice==null&&x.amountKind==='total')x.unitPrice=Number(x.amount)/Number(x.quantity);
  if(x.quantity&&x.unitPrice!=null)x.amount=Math.round(Number(x.quantity)*Number(x.unitPrice)*100)/100;
  let missing=null;
  if(!x.type)missing='transaction_type';
  else if(x.quantity!=null&&!x.productName)missing='product_name';
  else if(x.productName&&x.quantity!=null&&!x.unit)missing='unit';
  else if(x.productName&&x.quantity!=null&&x.unitPrice==null)missing='unit_price';
  else if(!Number.isFinite(Number(x.amount))||Number(x.amount)<=0)missing='amount';
  if(missing){x.waiting_for=missing;return {status:'waiting_for_details',payload:x,reply:questionForPending(x)};}
  delete x.waiting_for;
  const operation={income:'بيع',stock_cost:'شراء أو تكلفة إنتاج',operating_expense:'مصروف تشغيل',withdrawal:'سحب للبيت'}[x.type]||'عملية';
  const item=x.productName?` ${x.quantity||''} ${x.unit||''} ${x.productName}`.trim():'';
  return {status:'awaiting_confirmation',payload:x,reply:`فهمت إن دي ${operation}${item} بقيمة ${x.amount} جنيه. أحفظها؟ قولي «أيوه» للتأكيد، أو صححي البيانات بالكلام، أو قولي «إلغاء».`};
}

app.get('/api/projects',(req,res)=>res.json({projects:db.prepare('SELECT id,name,activity FROM projects ORDER BY id').all()}));
app.post('/api/projects',(req,res)=>{
  const name=String(req.body.name||'').trim().slice(0,80);if(!name)return res.status(400).json({error:'اكتبي اسمًا بسيطًا للمشروع.'});
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
  const project=projectOr404(req.query.projectId||1,res);if(!project)return;
  const conversation=B.getConversation(project.id,req.query.conversationId);if(!conversation)return res.status(404).json({error:'المحادثة مش موجودة في المشروع ده.'});
  const messages=db.prepare('SELECT id,role,content,input_type,created_at FROM messages WHERE conversation_id=? ORDER BY id LIMIT 300').all(conversation.id);
  res.json({conversation,messages,pending:pendingFor(conversation.id)});
});
app.post('/api/conversation/new',(req,res)=>{
  const project=projectOr404(req.body.projectId||1,res);if(!project)return;
  const id=db.prepare('INSERT INTO conversations(project_id,title) VALUES(?,?)').run(project.id,'محادثة جديدة').lastInsertRowid;
  res.status(201).json({conversation:db.prepare('SELECT * FROM conversations WHERE id=?').get(id)});
});
app.delete('/api/conversation/:id',(req,res)=>{
  const project=projectOr404(req.query.projectId||1,res);if(!project)return;
  const conversation=conversationOr404(project.id,req.params.id,res);if(!conversation)return;
  const clear=db.transaction(()=>{db.prepare('DELETE FROM messages WHERE conversation_id=?').run(conversation.id);db.prepare('DELETE FROM pending_actions WHERE conversation_id=?').run(conversation.id);db.prepare("UPDATE conversations SET summary='',summary_message_count=0,updated_at=datetime('now') WHERE id=?").run(conversation.id);});clear();
  res.json({ok:true});
});
app.get('/api/project-facts',(req,res)=>{
  const project=projectOr404(req.query.projectId||1,res);if(!project)return;
  res.json({facts:db.prepare('SELECT id,key,value,source,confirmed,created_at,updated_at FROM project_facts WHERE project_id=? ORDER BY updated_at DESC').all(project.id)});
});
app.post('/api/project-facts',(req,res)=>{
  const project=projectOr404(req.body.projectId||1,res);if(!project)return;
  try{res.status(201).json({fact:upsertFact(project.id,req.body.key,req.body.value,'user')});}catch(e){res.status(400).json({error:e.message});}
});
app.delete('/api/project-facts',(req,res)=>{
  const project=projectOr404(req.query.projectId||1,res);if(!project)return;
  db.prepare('DELETE FROM project_facts WHERE project_id=?').run(project.id);res.json({ok:true});
});
app.delete('/api/project-facts/:id',(req,res)=>{
  const project=projectOr404(req.query.projectId||1,res);if(!project)return;
  const result=db.prepare('DELETE FROM project_facts WHERE id=? AND project_id=?').run(Number(req.params.id),project.id);if(!result.changes)return res.status(404).json({error:'المعلومة دي مش موجودة.'});res.json({ok:true});
});
app.put('/api/project',(req,res)=>{
  const project=projectOr404(req.body.id||1,res);if(!project)return;
  const allowed=['activity','products','capital','costs','sales_method','household_use'];const data={};
  for(const k of allowed)if(Object.hasOwn(req.body,k))data[k]=req.body[k];
  if(Object.hasOwn(data,'capital')&&data.capital!==null&&(!Number.isFinite(Number(data.capital))||Number(data.capital)<0))return res.status(400).json({error:'راجعي المبلغ المتاح واكتبيه كرقم موجب.'});
  const update=db.transaction(()=>{if(Object.keys(data).length)db.prepare(`UPDATE projects SET ${Object.keys(data).map(k=>`${k}=@${k}`).join(',')} WHERE id=@id`).run({...data,id:project.id});for(const [k,v] of Object.entries(data)){db.prepare('DELETE FROM project_facts WHERE project_id=? AND key=?').run(project.id,k);if(v!==null&&v!==undefined&&String(v).trim())upsertFact(project.id,k,String(v),'profile');}});update();
  res.json({project:B.getProject(project.id)});
});
app.get('/api/init',(req,res)=>{
  const project=projectOr404(req.query.projectId||1,res);if(!project)return;
  const conversation=B.getConversation(project.id,req.query.conversationId);if(!conversation)return res.status(404).json({error:'المحادثة مش موجودة.'});
  const bounds=B.periodBounds('month');const facts=db.prepare('SELECT * FROM project_facts WHERE project_id=? AND confirmed=1 ORDER BY updated_at DESC').all(project.id);
  res.json({project,conversationId:conversation.id,transactions:B.getTransactions(project.id,bounds.from,bounds.to),summary:B.getSummary(project.id,bounds.from,bounds.to),period:bounds,products:B.getProducts(project.id),facts,reminders:B.getReminders(project.id)});
});

app.post('/api/tts',async(req,res)=>{
  const text=String(req.body.text||'').trim();
  if(!text||text.length>3000)return res.status(400).json({error:'مفيش نص صالح لتحويله لصوت.'});
  if(!config.geminiApiKey)return res.status(503).json({error:'تحويل الرد لصوت محتاج GEMINI_API_KEY.'});
  let lastError=null;
  try{
    const client=createGeminiClient(config);
    for(let attempt=0;attempt<2;attempt++){
      let usageId=null;
      try{
        usageId=quota.reserve(Math.ceil(text.length/4)+800);
        const interaction=await client.interactions.create({
          model:'gemini-3.8-flash-lite-tts',
          input:[{type:'user_input',content:[{type:'text',text,annotations:[{type:'speech_metadata',style:'Speak in a warm, natural Egyptian Arabic feminine voice. Read the text verbatim.'}]}]}],
          response_format:{type:'audio',mime_type:'audio/wav'},
          generation_config:{speech_config:[{voice:'Aoede'}]},
        });
        const audio=interaction?.output_audio?.data;
        if(!audio)throw new Error('Gemini returned no audio.');
        quota.finish(usageId,{status:'success'});
        return res.type('audio/wav').send(Buffer.from(audio,'base64'));
      }catch(error){
        if(usageId)quota.finish(usageId,{status:Number(error?.status)===429?'provider_429':'error'});
        lastError=error;
        const status=Number(error?.status||error?.statusCode||error?.response?.status||error?.cause?.status||0);
        const detail=`${error?.message||''} ${error?.error?.message||''} ${JSON.stringify(error?.error?.details||error?.details||'')}`;
        const dailyLimit=/(?:per\s*day|requests?\s*(?:\/|per)\s*day|\bRPD\b|daily quota|day limit|PerDayPerProject)/i.test(detail);
        if(attempt===0&&status===429&&!dailyLimit){await new Promise(resolve=>setTimeout(resolve,300+Math.floor(Math.random()*500)));continue;}
        break;
      }
    }
    throw lastError||new Error('Gemini speech generation did not complete.');
  }catch(error){
    const providerStatus=Number(error?.status||error?.statusCode||error?.response?.status||error?.cause?.status||0);
    const status=error?.code==='LOCAL_GEMINI_RATE_LIMIT'||error?.code==='LOCAL_GEMINI_DAILY_LIMIT'?429:providerStatus===429?429:503;
    console.error('Speech generation failed:',[error?.name||'Error',error?.code||null,providerStatus?`HTTP ${providerStatus}`:null].filter(Boolean).join(' / '));
    return res.status(status).json({error:status===429?'Gemini وصل لحد الاستخدام الصوتي مؤقتًا. الرد مكتوب؛ جربي زر الصوت بعد شوية.':'تعذر تجهيز صوت الرد من Gemini. الرد النصي موجود؛ جربي زر الصوت مرة تانية.'});
  }
});
app.post('/api/chat',async(req,res)=>{
  const text=String(req.body.message||'').trim();if(!text||text.length>1500)return res.status(400).json({error:'اكتبي رسالة قصيرة للمساعد.'});
  const project=projectOr404(req.body.projectId||1,res);if(!project)return;
  const conversation=B.getConversation(project.id,req.body.conversationId);if(!conversation)return res.status(404).json({error:'المحادثة مش موجودة في المشروع ده.'});
  db.prepare("DELETE FROM chat_requests WHERE created_at < datetime('now','-2 minutes') AND response_json IS NULL").run();
  const requestId=String(req.body.requestId||randomUUID()).slice(0,80);
  const existingRequest=db.prepare('SELECT conversation_id,response_json,status_code FROM chat_requests WHERE request_id=?').get(requestId);
  if(existingRequest){
    if(existingRequest.conversation_id!==conversation.id)return res.status(409).json({error:'معرّف الرسالة مستخدم لمحادثة تانية.'});
    if(existingRequest.response_json)return res.status(existingRequest.status_code).json(safeJson(existingRequest.response_json)||{});
    return res.status(409).json({error:'الرسالة لسه بتتعالج. استني رد فهيمه قبل ما تبعتيها تاني.'});
  }
  if(chatInFlight.has(conversation.id))return res.status(429).json({error:'لسه برد على رسالتك اللي فاتت. استني لحظة.'});
  const lastRequestAt=lastChatAt.get(conversation.id)||0;
  if(Date.now()-lastRequestAt<700)return res.status(429).json({error:'استني لحظة صغيرة بين الرسائل علشان ألحق أراجع طلبك.'});
  lastChatAt.set(conversation.id,Date.now());
  chatInFlight.add(conversation.id);
  db.prepare('INSERT INTO chat_requests(request_id,conversation_id) VALUES(?,?)').run(requestId,conversation.id);
  const originalJson=res.json.bind(res);
  res.json=(body)=>{
    db.prepare('UPDATE chat_requests SET response_json=?,status_code=? WHERE request_id=?').run(JSON.stringify(body),res.statusCode,requestId);
    return originalJson(body);
  };
  res.on('finish',()=>chatInFlight.delete(conversation.id));
  db.prepare("DELETE FROM chat_requests WHERE created_at < datetime('now','-2 days')").run();
  const inputType=req.body.inputType==='voice'?'voice':'text';const userMessage=saveMessage(conversation.id,'user',text,inputType);const active=pendingFor(conversation.id);
  const affirmative=/^(أيوه|ايوه|نعم|تمام|موافق(?:ة)?|سجل(?:ي)?|أكد(?:ي)?|اه)$/u.test(text);
  const negative=/^(لأ|لا|الغ(?:ي|اء)|مش دلوقتي|إلغاء|الغاء)$/u.test(text);
  if(active?.status==='awaiting_confirmation'&&affirmative){
    try{const result=await commitPending(project,conversation,active,{});const reply=result.reply;addAssistant(conversation.id,reply);await maybeSummarize(conversation);return res.json({kind:'saved',reply,transaction:result.transaction,conversationId:conversation.id,inputType});}
    catch(e){const reply=e.message;addAssistant(conversation.id,reply);return res.json({kind:'clarify',reply,conversationId:conversation.id,inputType});}
  }
  if(active&&negative){db.prepare('DELETE FROM pending_actions WHERE conversation_id=?').run(conversation.id);const reply='تمام، لغيت العملية المعلقة وماتسجلتش.';addAssistant(conversation.id,reply);return res.json({kind:'answer',reply,conversationId:conversation.id,inputType});}
  const context=currentContext(conversation,project,text);let parsed;
  const tools=createBusinessTools(project.id);
  try{
    const domainCheck=isOutOfDomain(text);
    if(domainCheck) parsed={intent:'question',answer:'أنا فهيمه، شغلي أساعدك في مشروعك والبيع والمصاريف والمشتريات والمخزون وتنظيم الشغل. احكيلي عن حاجة تخص مشروعك وأنا أساعدك.'};
    else parsed=await extract(text,context);
  }catch(e){
    const status=Number(e?.status||e?.statusCode||e?.response?.status||e?.cause?.status||0);
    console.error('Agent request failed:',[e?.name||'Error',e?.code||null,status?`HTTP ${status}`:null].filter(Boolean).join(' / '));
    parsed=status===429?deterministicFallback(text):null;
    if(!parsed){
      const reply=e?.code==='LOCAL_GEMINI_DAILY_LIMIT'
        ?'وصلنا لحد الاستخدام الآمن للمساعد النهارده. بيانات مشروعك محفوظة، وتقدري تكملي تسجيل العمليات والوظائف الأساسية.'
      :e?.code==='LOCAL_GEMINI_RATE_LIMIT'
          ?'فهيمه عليها ضغط شوية دلوقتي. استني لحظة وجربي تاني.'
        :status===429
        ?'وصلنا مؤقتًا لحد استخدام Gemini المجاني. قولي طلبك كتسجيل بيع أو شراء أو مصروف، أو جربي الأسئلة العامة لما تتجدد الحصة.'
        :process.env.GEMINI_API_KEY?'حصلت مشكلة مؤقتة في المساعد. جربي تاني أو اكتبي طلبك بشكل أوضح.':'المحادثة الحرة محتاجة GEMINI_API_KEY. تقدري تستخدمي التسجيل أو الحسابات الأساسية.';
      addAssistant(conversation.id,reply);
      if(status===429)return res.json({kind:'answer',reply,conversationId:conversation.id,inputType});
      return res.status(503).json({error:reply});
    }
  }
  if(active){
    const expectedIntent={transaction:'record_transaction',reminder:'create_reminder',project_fact:'project_fact'}[active.action_type];
    if(expectedIntent&&parsed.intent!==expectedIntent)db.prepare('DELETE FROM pending_actions WHERE conversation_id=?').run(conversation.id);
  }
  let result;
  try{
    switch(parsed.intent){
      case 'record_transaction': {
        const tx=transactionPending(parsed,project.id,active,text);setPending(conversation.id,project.id,'transaction',tx.status,tx.payload);
        result={kind:tx.status==='awaiting_confirmation'?'confirm':'clarify',reply:tx.reply,pending:{action_type:'transaction',status:tx.status,payload:tx.payload}};break;
      }
      case 'daily_sales_summary':
      case 'period_summary': {
        const period=parsePeriod(text,parsed);const bounds=B.periodBounds(period);
        const toolResult=executeBusinessTool(tools,parsed.intent==='daily_sales_summary'?'get_sales_summary':'get_project_summary',{period});
        const s=toolResult.summary;
        if(parsed.intent==='daily_sales_summary'){
          result={kind:'answer',reply:`مبيعاتك المسجلة ${periodLabel(period)} ${toolResult.total.toLocaleString('ar-EG')} جنيه من ${toolResult.count} عملية.`,summary:{total:toolResult.total,count:toolResult.count},period:toolResult.period};
        } else result={kind:'answer',reply:B.formatSummary(s,periodLabel(period)),summary:s,period:toolResult.period};
        break;
      }
      case 'inventory_query': {
        const inventory=executeBusinessTool(tools,'get_inventory',{product_name:parsed.product_name});
        result={kind:'answer',reply:inventory.product?`المسجل عندي ${inventory.product.current_quantity} ${inventory.product.unit} من ${inventory.product.name}.`:inventory.products.length?`ما لقيتش المنتج بالاسم ده. المنتجات المسجلة: ${inventory.products.map(p=>p.name).join('، ')}.`:'لسه مفيش منتجات مسجلة في المخزون.'};break;
      }
      case 'product_sales_query': {
        const productSales=executeBusinessTool(tools,'get_product_sales',{period:parsePeriod(text,parsed)});const rows=productSales.sales;
        result={kind:'answer',reply:rows.length?`أعلى المنتجات حسب الكمية المسجلة في وحدتها: ${rows.slice(0,3).map((x,i)=>`${i+1}) ${x.name}: ${x.quantity} ${x.unit}`).join('، ')}. ده من المبيعات المفصلة المسجلة بس.`:'مفيش مبيعات بمنتجات وكميات مفصلة في الفترة دي.'};break;
      }
      case 'create_report': {
        const bounds=B.periodBounds(parsePeriod(text,{...parsed,period:parsed.period||'month'}));
        result={kind:'report',reply:'حاضر، بجهز تقرير PDF للفترة دي. هتلاقيه اتحمّل على جهازك.',period:bounds};break;
      }
      case 'create_reminder': {
        const payload={title:parsed.reminder_title||parsed.description||'',dueAt:parsed.due_date||''};
        if(!payload.title||!/^\d{4}-\d{2}-\d{2}$/.test(payload.dueAt)){result={kind:'clarify',reply:!payload.title?'أفكرك تعملي إيه؟':'تحبي أذكرك في أنهي يوم؟'};break;}
        setPending(conversation.id,project.id,'reminder','awaiting_confirmation',payload);result={kind:'confirm',reply:`أفكرك بـ${payload.title} يوم ${payload.dueAt}؟ قولي «أيوه» للحفظ أو صححيها بالكلام.`,pending:{action_type:'reminder',status:'awaiting_confirmation',payload}};break;
      }
      case 'price_estimate': {
        const product=parsed.product_name?B.findProduct(project.id,parsed.product_name):null;const cost=parsed.amount??parsed.unit_price??product?.unit_cost;const markup=parsed.markup_percent??product?.markup_percent;
        if(!Number.isFinite(Number(cost))||Number(cost)<=0)result={kind:'clarify',reply:'تكلفة الوحدة كام؟'};
        else if(!Number.isFinite(Number(markup))||Number(markup)<0)result={kind:'clarify',reply:'تحبي تضيفي كام في المية فوق التكلفة؟'};
        else {const estimate=executeBusinessTool(tools,'estimate_price',{cost,markup_percent:markup});result={kind:'answer',reply:`لو التكلفة ${estimate.cost} جنيه والإضافة ${estimate.markup_percent}%، السعر الحسابي يبقى ${estimate.price} جنيه. ده حساب على بياناتك بس، مش سعر سوق.`};}
        break;
      }
      case 'project_fact': {
        if(!parsed.fact_key||!parsed.fact_value){result={kind:'clarify',reply:'إيه المعلومة اللي تحبي أحفظها عن مشروعك؟'};break;}
        const payload={key:parsed.fact_key,value:parsed.fact_value};setPending(conversation.id,project.id,'project_fact','awaiting_confirmation',payload);result={kind:'confirm_fact',reply:`أحفظ في ذاكرة المشروع إن ${payload.key}: ${payload.value}؟ قولي «أيوه» للحفظ أو صححيها بالكلام.`,pending:{action_type:'project_fact',status:'awaiting_confirmation',payload}};break;
      }
      case 'profile': result={kind:'profile',reply:'نكمّل بيانات المشروع واحدة واحدة. ما نوع نشاطك؟'};break;
      default: result={kind:'answer',reply:parsed.answer||'قوليلي عايزة تسجلي بيع أو شراء أو مصروف، تسألي عن حساباتك، أو أجهزلك تقرير PDF.'};
    }
  }catch(e){result={kind:'clarify',reply:e.message||'مش قادر أتعامل مع الطلب دلوقتي.'};}
  addAssistant(conversation.id,result.reply);if(result.pending){const saved=pendingFor(conversation.id);if(saved)result.pending.id=saved.id;}await maybeSummarize(conversation);
  res.json({...result,conversationId:conversation.id,inputType});
});

async function commitPending(project,conversation,active,changes) {
  const payload={...active.payload,...changes};
  if(active.action_type==='transaction'){
    const transaction=B.recordTransaction(project.id,payload);
    db.prepare('DELETE FROM pending_actions WHERE conversation_id=?').run(conversation.id);
    return {transaction,reply:`اتسجلت العملية بقيمة ${transaction.amount} جنيه. هتفضل المشتريات منفصلة عن المصروفات، ومش هنحسب ربح من غير تكلفة البضاعة المباعة.`};
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
app.post('/api/pending-actions',(req,res)=>{
  const project=projectOr404(req.body.projectId||1,res);if(!project)return;
  const conversation=conversationOr404(project.id,req.body.conversationId,res);if(!conversation)return;
  const x=req.body.payload||{};if(!['income','stock_cost','operating_expense','withdrawal'].includes(x.type))return res.status(400).json({error:'اختاري نوع العملية.'});
  const row=setPending(conversation.id,project.id,'transaction','awaiting_confirmation',{...x});res.status(201).json({pending:row});
});
app.post('/api/pending-actions/:id/confirm',async(req,res)=>{
  const project=projectOr404(req.body.projectId||1,res);if(!project)return;
  const conversation=conversationOr404(project.id,req.body.conversationId,res);if(!conversation)return;
  const active=pendingFor(conversation.id);if(!active||active.id!==Number(req.params.id)||active.status!=='awaiting_confirmation')return res.status(409).json({error:'العملية المعلقة انتهت أو تغيرت. راجعي المحادثة.'});
  try{const result=await commitPending(project,conversation,active,req.body.changes||{});addAssistant(conversation.id,result.reply);res.json(result);}catch(e){res.status(400).json({error:e.message});}
});
app.delete('/api/pending-actions/:id',(req,res)=>{const project=projectOr404(req.query.projectId||1,res);if(!project)return;const conversation=conversationOr404(project.id,req.query.conversationId,res);if(!conversation)return;db.prepare('DELETE FROM pending_actions WHERE id=? AND conversation_id=?').run(Number(req.params.id),conversation.id);res.json({ok:true});});
app.post('/api/transactions',(req,res)=>{
  res.status(403).json({error:'قولي تفاصيل العملية في المحادثة، وفهيمه هتراجعها معاكي قبل التسجيل.'});
});
app.delete('/api/transactions/:id',(req,res)=>{const project=projectOr404(req.query.projectId||1,res);if(!project)return;const row=db.prepare('SELECT * FROM transactions WHERE id=? AND project_id=?').get(Number(req.params.id),project.id);if(!row)return res.status(404).json({error:'العملية دي مش موجودة.'});const hasItems=db.prepare('SELECT 1 FROM transaction_items WHERE transaction_id=? LIMIT 1').get(row.id);if(hasItems)return res.status(409).json({error:'العملية مرتبطة بحركة مخزون؛ لا يمكن حذفها حاليًا حتى لا تختلف الكميات المسجلة.'});db.prepare('DELETE FROM transactions WHERE id=? AND project_id=?').run(row.id,project.id);res.json({ok:true});});

app.get('/api/products',(req,res)=>{const project=projectOr404(req.query.projectId||1,res);if(!project)return;res.json({products:B.getProducts(project.id)});});
app.post('/api/products',(req,res)=>{const project=projectOr404(req.body.projectId||1,res);if(!project)return;try{res.status(201).json({product:B.createProduct(project.id,req.body)});}catch(e){res.status(400).json({error:e.message});}});
app.put('/api/products/:id',(req,res)=>{
  const project=projectOr404(req.body.projectId||1,res);if(!project)return;const id=Number(req.params.id);const current=db.prepare('SELECT * FROM products WHERE id=? AND project_id=?').get(id,project.id);if(!current)return res.status(404).json({error:'المنتج مش موجود.'});
  const threshold=req.body.lowStockThreshold===''?null:req.body.lowStockThreshold==null?current.low_stock_threshold:Number(req.body.lowStockThreshold);
  const cost=req.body.unitCost===''?null:req.body.unitCost==null?current.unit_cost:Number(req.body.unitCost);
  const markup=req.body.markupPercent===''?null:req.body.markupPercent==null?current.markup_percent:Number(req.body.markupPercent);
  if([threshold,cost,markup].some(v=>v!==null&&(!Number.isFinite(v)||v<0)))return res.status(400).json({error:'راجعي حد التنبيه والتكلفة ونسبة الإضافة.'});
  db.prepare('UPDATE products SET low_stock_threshold=?,unit_cost=?,markup_percent=?,updated_at=datetime(\'now\') WHERE id=? AND project_id=?').run(threshold,cost,markup,id,project.id);res.json({product:db.prepare('SELECT * FROM products WHERE id=?').get(id)});
});
app.post('/api/products/:id/adjust',(req,res)=>{const project=projectOr404(req.body.projectId||1,res);if(!project)return;try{res.json({product:B.adjustInventory(project.id,Number(req.params.id),req.body.quantity,req.body.description)});}catch(e){res.status(400).json({error:e.message});}});
app.get('/api/products/sales',(req,res)=>{const project=projectOr404(req.query.projectId||1,res);if(!project)return;const from=String(req.query.from||B.periodBounds('month').from),to=String(req.query.to||B.localDate());if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||from>to)return res.status(400).json({error:'اختاري فترة صحيحة.'});res.json({sales:B.getProductSales(project.id,from,to)});});
app.get('/api/reminders',(req,res)=>{const project=projectOr404(req.query.projectId||1,res);if(!project)return;res.json({reminders:B.getReminders(project.id)});});
app.post('/api/reminders',(req,res)=>{const project=projectOr404(req.body.projectId||1,res);if(!project)return;try{const id=B.addReminder(project.id,req.body.title,req.body.dueAt).lastInsertRowid;res.status(201).json({reminder:db.prepare('SELECT * FROM reminders WHERE id=?').get(id)});}catch(e){res.status(400).json({error:e.message});}});
app.post('/api/reminders/:id/complete',(req,res)=>{const project=projectOr404(req.body.projectId||1,res);if(!project)return;const result=db.prepare('UPDATE reminders SET completed=1 WHERE id=? AND project_id=?').run(Number(req.params.id),project.id);if(!result.changes)return res.status(404).json({error:'التذكير مش موجود.'});res.json({ok:true});});
app.get('/api/report',(req,res)=>{const project=projectOr404(req.query.projectId||1,res);if(!project)return;const from=String(req.query.from||''),to=String(req.query.to||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||from>to)return res.status(400).json({error:'اختاري فترة صحيحة للتقرير.'});const rows=B.getTransactions(project.id,from,to);res.json({project:{name:project.name,activity:project.activity},period:{from,to},transactions:rows,summary:require('./finance').summary(rows),products:B.getProductSales(project.id,from,to)});});

const port=config.port;const server=app.listen(port,'127.0.0.1',()=>console.log(`Server run on: http://localhost:${port}`));
function shutdown(){server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),2500).unref();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
