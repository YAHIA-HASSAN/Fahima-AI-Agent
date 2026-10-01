require('dotenv').config();
const path = require('node:path');
const express = require('express');
const { loadConfig } = require('./config');
const db = require('./db');
const { extract, summarizeConversation, isOutOfDomain } = require('./agent');
const B = require('./business');
const { TYPES, validDate } = require('./finance');
const { createBusinessTools, executeBusinessTool } = require('./business-tools');
const { randomUUID } = require('node:crypto');
const { createGeminiClient } = require('./gemini-client');

const config = loadConfig();
if (config.issues.length) console.warn('Configuration values need attention:', config.issues.join(' '));

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname,'..','public')));
const chatInFlight = new Set();

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
  if(!clean)throw new Error('اكتبي المعلومة اللي حابة تحفظيها.');
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
  return {history,summary:conversation.summary||'',facts,products,pending:pendingFor(conversation.id),profile:{name:project.name,activity:project.activity,products:project.products,capital:project.capital,costs:project.costs,sales_method:project.sales_method,household_use:project.household_use}};
}
function parsePeriod(parsed) {
  if (!['today','week','month','all'].includes(parsed.period)) throw new Error('اختاري الفترة: اليوم، الأسبوع، الشهر، أو كل الفترة.');
  return parsed.period;
}
function periodLabel(period) { return period==='week'?'الأسبوع ده':period==='month'?'الشهر ده':period==='all'?'كل الفترة':'النهارده'; }
function questionForPending(p) {
  return ({transaction_type:'دي كانت فلوس بيع، ولا شراء بضاعة، ولا مصروف؟',amount:'المبلغ كام بالجنيه؟',product_name:'اسم البضاعة إيه؟',quantity:'الكمية كام؟',unit:'وحدة الكمية إيه؟',date:'تاريخ العملية إيه؟',amount_kind:'المبلغ ده إجمالي العملية ولا سعر الوحدة؟',unit_price:'سعر الوحدة كام؟',due_date:'تحبي أذكرك إمتى؟',reminder_title:'أفكرك تعملي إيه؟',markup_percent:'تحبي تزودي كام على التكلفة؟'})[p.waiting_for]||'ممكن توضحيلي حاجة واحدة كمان؟';
}
function mergePendingTransaction(pending,parsed) {
  const next={...pending};
  if(parsed.unit_price==null&&pending.amountKind==='total'&&(parsed.amount!=null||parsed.quantity!=null))next.unitPrice=null;
  for(const [key,value] of Object.entries({type:parsed.transaction_type,amount:parsed.amount,date:parsed.date,description:parsed.description,estimated:parsed.estimated,productName:parsed.product_name,quantity:parsed.quantity,unit:parsed.unit,unitPrice:parsed.unit_price,amountKind:parsed.amount_kind})) if(value!==null&&value!==undefined&&value!==''&&!(key==='estimated'&&value===false)) next[key]=value;
  delete next.waiting_for;
  return next;
}
function transactionFromAgent(item, fallbackDescription = '') {
  return {
    transaction_type: item.transaction_type, amount: item.amount, amount_kind: item.amount_kind,
    date: item.date, period: 'today', description: item.description || fallbackDescription,
    estimated: item.estimated, product_name: item.product_name, quantity: item.quantity,
    unit: item.unit, unit_price: item.unit_price,
  };
}
function transactionKindLabel(type) {
  return ({income:'بيع',stock_cost:'شراء بضاعة',operating_expense:'مصروف',withdrawal:'سحب للبيت'})[type] || 'عملية';
}
function transactionBatchPending(items, active, raw, followup = null) {
  const batch = active?.action_type === 'transaction_batch'
    ? [...(active.payload.transactions || [])]
    : items.map(item => transactionPending(transactionFromAgent(item, transactionKindLabel(item.transaction_type)), null, null, '').payload);
  let startAt = 0;
  if (active?.action_type === 'transaction_batch' && active.status === 'waiting_for_details') {
    startAt = Math.max(0, Math.min(Number(active.payload.waitingIndex) || 0, batch.length - 1));
    const item = batch[startAt];
    const updated = transactionPending({
      transaction_type:followup?.transaction_type ?? item.type, amount:followup?.amount ?? item.amount,
      amount_kind:followup?.amount_kind ?? item.amountKind, date:followup?.date ?? item.date,
      period:'today', description:followup?.description || item.description, estimated:followup?.estimated ?? item.estimated,
      product_name:followup?.product_name ?? item.productName, quantity:followup?.quantity ?? item.quantity,
      unit:followup?.unit ?? item.unit, unit_price:followup?.unit_price ?? item.unitPrice,
    }, null, {action_type:'transaction', payload:item}, raw);
    batch[startAt] = updated.payload;
    if (updated.status !== 'awaiting_confirmation') {
      return {status:'waiting_for_details', payload:{transactions:batch,waitingIndex:startAt}, reply:`بالنسبة لـ${transactionKindLabel(item.type)}: ${updated.reply}`};
    }
    startAt += 1;
  }
  for (let i = startAt; i < batch.length; i += 1) {
    const item = batch[i];
    const normalized = transactionPending({
      transaction_type:item.type, amount:item.amount, amount_kind:item.amountKind, date:item.date,
      period:'today', description:item.description, estimated:item.estimated, product_name:item.productName,
      quantity:item.quantity, unit:item.unit, unit_price:item.unitPrice,
    }, null, {action_type:'transaction', payload:item}, '');
    batch[i] = normalized.payload;
    if (normalized.status !== 'awaiting_confirmation') {
      return {status:'waiting_for_details', payload:{transactions:batch,waitingIndex:i}, reply:`بالنسبة لـ${transactionKindLabel(item.type)}: ${normalized.reply}`};
    }
  }
  const preview = batch.map((item, index) => `${index + 1}) ${transactionKindLabel(item.type)} ${[item.quantity,item.unit,item.productName].filter(value=>value!=null&&value!=='').join(' ')}: ${Number(item.amount).toLocaleString('ar-EG')} جنيه`).join('، ');
  return {status:'awaiting_confirmation', payload:{transactions:batch}, reply:`فهمت العمليات دي: ${preview}. أحفظهم كلهم؟ قولي «أيوه» أو «إلغاء».`};
}
function transactionPending(parsed,projectId,existing,raw) {
  let x=existing?.action_type==='transaction'?mergePendingTransaction(existing.payload,parsed):{
    type:parsed.transaction_type,amount:parsed.amount,date:parsed.date,description:parsed.description||raw,
    estimated:parsed.estimated,productName:parsed.product_name,quantity:parsed.quantity,unit:parsed.unit,unitPrice:parsed.unit_price,amountKind:parsed.amount_kind
  };
  if(!x.date)x.date=B.localDate();
  if(!x.description)x.description=raw;
  if(x.amountKind==='unit_price'&&x.quantity&&x.amount!=null&&x.unitPrice==null){x.unitPrice=x.amount;x.amount=null;}
  if(x.quantity&&x.amount!=null&&x.unitPrice==null&&x.amountKind==='total')x.unitPrice=Number(x.amount)/Number(x.quantity);
  if(x.quantity&&x.unitPrice!=null&&x.amountKind!=='total')x.amount=Math.round(Number(x.quantity)*Number(x.unitPrice)*100)/100;
  let missing=null;
  if(!Object.hasOwn(TYPES,x.type))missing='transaction_type';
  else if(!validDate(x.date))missing='date';
  else if(x.quantity!=null&&(!Number.isFinite(x.quantity)||x.quantity<=0))missing='quantity';
  else if(x.amountKind==='unit_price'&&x.quantity==null)missing='quantity';
  else if(x.quantity!=null&&x.amount!=null&&!x.amountKind&&x.unitPrice==null)missing='amount_kind';
  else if(x.quantity!=null&&!x.productName)missing='product_name';
  else if(x.productName&&x.quantity!=null&&!x.unit)missing='unit';
  else if(x.productName&&x.quantity!=null&&(x.unitPrice==null||!Number.isFinite(x.unitPrice)||x.unitPrice<=0))missing='unit_price';
  else if(x.quantity!=null&&x.amountKind==='total'&&x.unitPrice!=null&&Math.abs(Math.round(x.quantity*x.unitPrice*100)-Math.round(x.amount*100))>1)missing='amount';
  else if(!Number.isFinite(Number(x.amount))||Number(x.amount)<=0)missing='amount';
  if(missing){x.waiting_for=missing;return {status:'waiting_for_details',payload:x,reply:questionForPending(x)};}
  delete x.waiting_for;
  const operation={income:'بيع',stock_cost:'شراء بضاعة',operating_expense:'مصروف',withdrawal:'سحب للبيت'}[x.type]||'عملية';
  const item=x.productName?' '+[x.quantity,x.unit,x.productName].filter(value=>value!=null&&value!=='').join(' '):'';
  return {status:'awaiting_confirmation',payload:x,reply:`فهمت: ${operation}${item} بـ${Number(x.amount).toLocaleString('ar-EG')} جنيه. أسجلها؟ قولي «أيوه» أو «إلغاء».`};
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
  res.json({facts:db.prepare('SELECT id,key,value,source,confirmed,created_at,updated_at FROM project_facts WHERE project_id=? ORDER BY updated_at DESC').all(project.id)});
});
app.delete('/api/project-facts',(req,res)=>{
  const project=projectOr404(req.query.projectId,res);if(!project)return;
  db.transaction(()=>{
    db.prepare('DELETE FROM project_facts WHERE project_id=?').run(project.id);
    db.prepare('UPDATE projects SET activity=NULL,products=NULL,capital=NULL,costs=NULL,sales_method=NULL,household_use=NULL WHERE id=?').run(project.id);
  })();res.json({ok:true});
});
app.delete('/api/project-facts/:id',(req,res)=>{
  const project=projectOr404(req.query.projectId,res);if(!project)return;
  const fact=db.prepare('SELECT key FROM project_facts WHERE id=? AND project_id=?').get(Number(req.params.id),project.id);
  if(!fact)return res.status(404).json({error:'المعلومة دي مش موجودة.'});
  db.transaction(()=>{
    db.prepare('DELETE FROM project_facts WHERE id=? AND project_id=?').run(Number(req.params.id),project.id);
    if(profileFields.has(fact.key))db.prepare(`UPDATE projects SET ${fact.key}=NULL WHERE id=?`).run(project.id);
  })();res.json({ok:true});
});
app.get('/api/init',(req,res)=>{
  const project=projectOr404(req.query.projectId,res);if(!project)return;
  const conversation=B.getConversation(project.id,req.query.conversationId);if(!conversation)return res.status(404).json({error:'المحادثة مش موجودة.'});
  const bounds=B.periodBounds('month');const facts=db.prepare('SELECT * FROM project_facts WHERE project_id=? AND confirmed=1 ORDER BY updated_at DESC').all(project.id);
  res.json({project,conversationId:conversation.id,transactions:B.getTransactions(project.id,bounds.from,bounds.to),summary:B.getSummary(project.id,bounds.from,bounds.to),period:bounds,products:B.getProducts(project.id),facts,reminders:B.getReminders(project.id)});
});

app.post('/api/tts',async(req,res)=>{
  const text=String(req.body.text||'').trim();
  if(!text||text.length>3000)return res.status(400).json({error:'مفيش نص صالح لتحويله لصوت.'});
  if(!config.geminiApiKey)return res.status(503).json({error:'تحويل الرد لصوت محتاج GEMINI_API_KEY.'});

  try{
    const client=createGeminiClient(config);
    const interaction=await client.interactions.create({
      model:'gemini-3.8-flash-lite-tts',
      input:[{type:'user_input',content:[{type:'text',text,annotations:[{type:'speech_metadata',style:'Speak in a warm, natural Egyptian Arabic feminine voice. Read the text verbatim.'}]}]}],
      response_format:{type:'audio',mime_type:'audio/wav'},
      generation_config:{speech_config:[{voice:'Aoede'}]},
    });
    const audio=interaction?.output_audio?.data;
    if(!audio)throw new Error('Gemini returned no audio.');
    return res.type('audio/wav').send(Buffer.from(audio,'base64'));
  }catch(error){
    const providerStatus=Number(error?.status||error?.statusCode||error?.response?.status||error?.cause?.status||0);
    const status=providerStatus===429?429:503;
    console.error('Speech generation failed:',[error?.name||'Error',error?.code||null,providerStatus?`HTTP ${providerStatus}`:null].filter(Boolean).join(' / '));
    const message=providerStatus===429?'فهيمه خارج الخدمة مؤقتًا لأن Gemini وصل لحد الاستخدام. الرد مكتوب؛ جربي تاني بعد ما تتجدد الحصة.':'تعذر تجهيز صوت الرد من Gemini. الرد النصي موجود؛ جربي زر إعادة السماع مرة تانية.';
    return res.status(status).json({error:message});
  }
});
app.post('/api/chat',async(req,res)=>{
  const text=String(req.body.message||'').trim();if(!text||text.length>1500)return res.status(400).json({error:'اكتبي رسالة قصيرة للمساعد.'});
  const project=projectOr404(req.body.projectId,res);if(!project)return;
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
    try{const result=await commitPending(project,conversation,active);const reply=result.reply;addAssistant(conversation.id,reply);await maybeSummarize(conversation);return res.json({kind:'saved',reply,transaction:result.transaction,transactions:result.transactions,conversationId:conversation.id,inputType});}
    catch(e){const reply=e.message;addAssistant(conversation.id,reply);return res.json({kind:'clarify',reply,conversationId:conversation.id,inputType});}
  }
  if(active&&negative){db.prepare('DELETE FROM pending_actions WHERE conversation_id=?').run(conversation.id);const reply='تمام، ألغيت العملية وماتسجلتش.';addAssistant(conversation.id,reply);return res.json({kind:'answer',reply,conversationId:conversation.id,inputType});}
  if(active?.action_type==='transaction_batch'&&active.status==='awaiting_confirmation'){
    const reply='ماحفظتش أي حاجة لسه. قولي «أيوه» لحفظ كل العمليات، أو «إلغاء» وابعتيها من جديد لو محتاجة تصحيح.';
    addAssistant(conversation.id,reply);return res.json({kind:'clarify',reply,conversationId:conversation.id,inputType});
  }
  const context=currentContext(conversation,project,text);let parsed;
  const tools=createBusinessTools(project.id);
  try{
    const domainCheck=isOutOfDomain(text);
    if(domainCheck) parsed={intent:'question',answer:'أنا فهيمه، شغلي أساعدك في مشروعك والبيع والمصاريف والمشتريات والمخزون وتنظيم الشغل. احكيلي عن حاجة تخص مشروعك وأنا أساعدك.'};
    else parsed=await extract(text,context);
  }catch(e){
    const status=Number(e?.status||e?.statusCode||e?.response?.status||e?.cause?.status||0);
    console.error('Agent request failed:',[e?.name||'Error',e?.code||null,status?`HTTP ${status}`:null].filter(Boolean).join(' / '));
    parsed=null;
    if(!parsed){
      const reply=status===429
        ?'فهيمه خارج الخدمة مؤقتًا لأن Gemini وصل لحد الاستخدام. بيانات مشروعك محفوظة، جربي تاني بعد ما تتجدد الحصة.'
        :process.env.GEMINI_API_KEY?'حصلت مشكلة مؤقتة في المساعد. جربي تاني أو اكتبي طلبك بشكل أوضح.':'فهم الرسائل محتاج إعداد مفتاح Gemini. بياناتك وتقاريرك المحفوظة لسه متاحة.';
      addAssistant(conversation.id,reply);
      if(status===429)return res.json({kind:'answer',reply,conversationId:conversation.id,inputType});
      return res.status(503).json({error:reply});
    }
  }
  if(parsed.intent==='record_transactions'&&parsed.transactions?.length===1)parsed={...parsed,...parsed.transactions[0],intent:'record_transaction'};
  if(Array.isArray(parsed.transactions)&&parsed.transactions.length>1)parsed.intent='record_transactions';
  if(active?.action_type==='transaction_batch'&&active.status==='waiting_for_details')parsed.intent='record_transaction';
  if(active){
    const expectedIntent={transaction:'record_transaction',transaction_batch:'record_transactions',reminder:'create_reminder',project_fact:'project_fact'}[active.action_type];
    const batchFollowup=active.action_type==='transaction_batch'&&active.status==='waiting_for_details';
    if(expectedIntent&&parsed.intent!==expectedIntent&&!batchFollowup)db.prepare('DELETE FROM pending_actions WHERE conversation_id=?').run(conversation.id);
  }
  let result;
  try{
    if(active?.action_type==='transaction_batch'&&active.status==='waiting_for_details'){
      const tx=transactionBatchPending([],active,text,parsed);setPending(conversation.id,project.id,'transaction_batch',tx.status,tx.payload);
      result={kind:tx.status==='awaiting_confirmation'?'confirm':'clarify',reply:tx.reply,pending:{action_type:'transaction_batch',status:tx.status,payload:tx.payload}};
    } else switch(parsed.intent){
      case 'record_transactions': {
        if (!Array.isArray(parsed.transactions) || parsed.transactions.length < 2 || parsed.transactions.length > 50) { result={kind:'clarify',reply:'قوليلي كل عملية ومبلغها بوضوح، وعددهم ما يزيدش عن 50.'};break; }
        const tx=transactionBatchPending(parsed.transactions,null,text);setPending(conversation.id,project.id,'transaction_batch',tx.status,tx.payload);
        result={kind:tx.status==='awaiting_confirmation'?'confirm':'clarify',reply:tx.reply,pending:{action_type:'transaction_batch',status:tx.status,payload:tx.payload}};break;
      }
      case 'record_transaction': {
        if(active?.action_type==='transaction_batch'&&active.status==='waiting_for_details'){
          const tx=transactionBatchPending([],active,text,parsed);setPending(conversation.id,project.id,'transaction_batch',tx.status,tx.payload);
          result={kind:tx.status==='awaiting_confirmation'?'confirm':'clarify',reply:tx.reply,pending:{action_type:'transaction_batch',status:tx.status,payload:tx.payload}};break;
        }
        const tx=transactionPending(parsed,project.id,active,text);setPending(conversation.id,project.id,'transaction',tx.status,tx.payload);
        result={kind:tx.status==='awaiting_confirmation'?'confirm':'clarify',reply:tx.reply,pending:{action_type:'transaction',status:tx.status,payload:tx.payload}};break;
      }
      case 'daily_sales_summary':
      case 'period_summary': {
        const period=parsePeriod(parsed);const bounds=B.periodBounds(period);
        const toolResult=executeBusinessTool(tools,parsed.intent==='daily_sales_summary'?'get_sales_summary':'get_project_summary',{period});
        const s=toolResult.summary;
        if(parsed.intent==='daily_sales_summary'){
          result={kind:'answer',reply:`سجلتي ${periodLabel(period)} ${toolResult.total.toLocaleString('ar-EG')} جنيه من ${toolResult.count} عملية.`,summary:{total:toolResult.total,count:toolResult.count},period:toolResult.period};
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
        result={kind:'report',reply:'حاضر، بجهز تقرير PDF للفترة دي. هتلاقيه اتحمّل على جهازك.',period:bounds};break;
      }
      case 'create_reminder': {
        const old=active?.action_type==='reminder'?active.payload:{};
        const payload={title:parsed.reminder_title||old.title||parsed.description||'',dueAt:parsed.due_date||old.dueAt||''};
        if(!payload.title||!validDate(payload.dueAt)){setPending(conversation.id,project.id,'reminder','waiting_for_details',payload);result={kind:'clarify',reply:!payload.title?'أفكرك تعملي إيه؟':'تحبي أذكرك في أنهي يوم؟'};break;}
        setPending(conversation.id,project.id,'reminder','awaiting_confirmation',payload);result={kind:'confirm',reply:`أفكرك بـ${payload.title} يوم ${payload.dueAt}؟ قولي «أيوه» للحفظ أو صححيها بالكلام.`,pending:{action_type:'reminder',status:'awaiting_confirmation',payload}};break;
      }
      case 'price_estimate': {
        const product=parsed.product_name?B.findProduct(project.id,parsed.product_name):null;const cost=parsed.amount??parsed.unit_price??product?.unit_cost;const markup=parsed.markup_percent??product?.markup_percent;
        if(!Number.isFinite(Number(cost))||Number(cost)<=0)result={kind:'clarify',reply:'تكلفة الوحدة كام؟'};
        else if(!Number.isFinite(Number(markup))||Number(markup)<0||markup==null)result={kind:'clarify',reply:'تحبي تضيفي كام في المية فوق التكلفة؟'};
        else {const estimate=executeBusinessTool(tools,'estimate_price',{cost,markup_percent:markup});result={kind:'answer',reply:`لو تكلفة الوحدة ${estimate.cost} جنيه والإضافة ${estimate.markup_percent}%، يبقى السعر ${estimate.price} جنيه. ده حساب من أرقامك، مش سعر السوق.`};}
        break;
      }
      case 'project_fact': {
        if(!parsed.fact_key||!parsed.fact_value){result={kind:'clarify',reply:'إيه المعلومة اللي تحبي أحفظها عن مشروعك؟'};break;}
        const payload={key:parsed.fact_key,value:factValue(parsed.fact_key,parsed.fact_value)};setPending(conversation.id,project.id,'project_fact','awaiting_confirmation',payload);result={kind:'confirm_fact',reply:`أحفظ في ذاكرة المشروع إن ${payload.key}: ${payload.value}؟ قولي «أيوه» للحفظ أو صححيها بالكلام.`,pending:{action_type:'project_fact',status:'awaiting_confirmation',payload}};break;
      }
      case 'profile': result={kind:'profile',reply:'نكمّل بيانات المشروع واحدة واحدة. ما نوع نشاطك؟'};break;
      default: result={kind:'answer',reply:parsed.answer||'قوليلي عايزة تسجلي بيع أو شراء أو مصروف، تسألي عن حساباتك، أو أجهزلك تقرير PDF.'};
    }
  }catch(e){result={kind:'clarify',reply:e.message||'مش قادر أتعامل مع الطلب دلوقتي.'};}
  addAssistant(conversation.id,result.reply);if(result.pending){const saved=pendingFor(conversation.id);if(saved)result.pending.id=saved.id;}await maybeSummarize(conversation);
  res.json({...result,conversationId:conversation.id,inputType});
});

async function commitPending(project,conversation,active) {
  if(active.status!=='awaiting_confirmation')throw new Error('كمّلي البيانات وراجعيها قبل الحفظ.');
  const payload=active.payload;
  if(active.action_type==='transaction'){
    const transaction=B.recordTransaction(project.id,payload);
    db.prepare('DELETE FROM pending_actions WHERE conversation_id=?').run(conversation.id);
    return {transaction,reply:`تمام، سجلت العملية بـ${Number(transaction.amount).toLocaleString('ar-EG')} جنيه.`};
  }
  if(active.action_type==='transaction_batch'){
    const saveBatch=db.transaction(()=>{
      const transactions=(payload.transactions||[]).map(item=>B.recordTransaction(project.id,item));
      db.prepare('DELETE FROM pending_actions WHERE conversation_id=?').run(conversation.id);
      return transactions;
    });
    const transactions=saveBatch();
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
  const active=pendingFor(conversation.id);if(!active||active.id!==Number(req.params.id)||active.status!=='awaiting_confirmation')return res.status(409).json({error:'العملية المعلقة انتهت أو تغيرت. راجعي المحادثة.'});
  if(req.body.changes&&Object.keys(req.body.changes).length)return res.status(400).json({error:'قولي التصحيح في المحادثة عشان نراجعه قبل الحفظ.'});
  try{const result=await commitPending(project,conversation,active);addAssistant(conversation.id,result.reply);res.json(result);}catch(e){res.status(400).json({error:e.message});}
});
app.delete('/api/pending-actions/:id',(req,res)=>{const project=projectOr404(req.query.projectId,res);if(!project)return;const conversation=conversationOr404(project.id,req.query.conversationId,res);if(!conversation)return;db.prepare('DELETE FROM pending_actions WHERE id=? AND conversation_id=?').run(Number(req.params.id),conversation.id);res.json({ok:true});});
function requireConversation(req,res) {
  res.status(403).json({error:'قولي التفاصيل في المحادثة عشان فهيمه تفهمها وتراجعها معاكي قبل الحفظ.'});
}
app.post(['/api/transactions','/api/project-facts','/api/pending-actions','/api/products','/api/products/:id/adjust','/api/reminders'],requireConversation);
app.put(['/api/project','/api/products/:id'],requireConversation);
app.delete('/api/transactions/:id',(req,res)=>{const project=projectOr404(req.query.projectId,res);if(!project)return;const row=db.prepare('SELECT * FROM transactions WHERE id=? AND project_id=?').get(Number(req.params.id),project.id);if(!row)return res.status(404).json({error:'العملية دي مش موجودة.'});const hasItems=db.prepare('SELECT 1 FROM transaction_items WHERE transaction_id=? LIMIT 1').get(row.id);if(hasItems)return res.status(409).json({error:'العملية مرتبطة بحركة مخزون؛ لا يمكن حذفها حاليًا حتى لا تختلف الكميات المسجلة.'});db.prepare('DELETE FROM transactions WHERE id=? AND project_id=?').run(row.id,project.id);res.json({ok:true});});

app.get('/api/products',(req,res)=>{const project=projectOr404(req.query.projectId,res);if(!project)return;res.json({products:B.getProducts(project.id)});});
app.get('/api/products/sales',(req,res)=>{const project=projectOr404(req.query.projectId,res);if(!project)return;const from=String(req.query.from||B.periodBounds('month').from),to=String(req.query.to||B.localDate());if(!validDate(from)||!validDate(to)||from>to)return res.status(400).json({error:'اختاري فترة صحيحة.'});res.json({sales:B.getProductSales(project.id,from,to)});});
app.get('/api/reminders',(req,res)=>{const project=projectOr404(req.query.projectId,res);if(!project)return;res.json({reminders:B.getReminders(project.id)});});
app.post('/api/reminders/:id/complete',(req,res)=>{const project=projectOr404(req.body.projectId,res);if(!project)return;const result=db.prepare('UPDATE reminders SET completed=1 WHERE id=? AND project_id=?').run(Number(req.params.id),project.id);if(!result.changes)return res.status(404).json({error:'التذكير مش موجود.'});res.json({ok:true});});
app.get('/api/report',(req,res)=>{const project=projectOr404(req.query.projectId,res);if(!project)return;const from=String(req.query.from||''),to=String(req.query.to||'');if(!validDate(from)||!validDate(to)||from>to)return res.status(400).json({error:'اختاري فترة صحيحة للتقرير.'});const rows=B.getTransactions(project.id,from,to);res.json({project:{name:project.name,activity:project.activity},period:{from,to},transactions:rows,summary:require('./finance').summary(rows),products:B.getProductSales(project.id,from,to)});});

if (require.main === module) {
  const port=config.port;
  const server=app.listen(port,'127.0.0.1',()=>console.log(`Server run on: http://localhost:${port}`));
  function shutdown(){server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),2500).unref();}
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
module.exports = app;
