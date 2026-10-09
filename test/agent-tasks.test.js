const test=require('node:test');
const assert=require('node:assert/strict');
const Database=require('better-sqlite3');
const {createAgentTasks}=require('../server/agent-tasks');
const {validateBusinessPlan}=require('../server/plan-validator');
const {taskBudget,createTaskRunner,projectFingerprint}=require('../server/agent-task-runner');
const {calculate}=require('../server/planning');
const marketResearch=require('../server/market-research');
const {loadConfig}=require('../server/config');

function memoryDb() {
  const db=new Database(':memory:');
  db.exec(`CREATE TABLE projects(id INTEGER PRIMARY KEY);CREATE TABLE conversations(id INTEGER PRIMARY KEY,updated_at TEXT);
    CREATE TABLE project_facts(project_id INTEGER,key TEXT,value TEXT,numeric_value REAL,certainty TEXT,revision INTEGER,updated_at TEXT);
    CREATE TABLE business_goals(project_id INTEGER,goal_key TEXT,title TEXT,target REAL,unit TEXT,horizon TEXT,status TEXT,updated_at TEXT);
    CREATE TABLE transactions(id INTEGER PRIMARY KEY,project_id INTEGER);
    CREATE TABLE messages(id INTEGER PRIMARY KEY,conversation_id INTEGER,role TEXT,content TEXT,input_type TEXT);
    CREATE TABLE agent_tasks(id TEXT PRIMARY KEY,project_id INTEGER,conversation_id INTEGER,source_message_id INTEGER,task_type TEXT,status TEXT,objective TEXT,
      payload_json TEXT,result_json TEXT,error TEXT,progress TEXT,decision_count INTEGER DEFAULT 0,tool_count INTEGER DEFAULT 0,input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,estimated_cost REAL,budget_json TEXT,project_fingerprint TEXT,lease_owner TEXT,lease_expires_at TEXT,
      created_at TEXT,updated_at TEXT,completed_at TEXT);
    CREATE TABLE agent_task_steps(id INTEGER PRIMARY KEY,task_id TEXT,step_key TEXT,sequence INTEGER,kind TEXT,status TEXT,input_hash TEXT,
      result_json TEXT,error TEXT,started_at TEXT,completed_at TEXT,UNIQUE(task_id,step_key));
    CREATE TABLE agent_task_metrics(id INTEGER PRIMARY KEY,task_id TEXT,metric TEXT,value REAL,details_json TEXT,created_at TEXT);
    CREATE TABLE agent_task_deliveries(task_id TEXT PRIMARY KEY,message_id INTEGER,delivered_at TEXT);
    CREATE TABLE business_plans(id INTEGER PRIMARY KEY,project_id INTEGER,revision INTEGER,title TEXT,status TEXT,body TEXT,source_message_id INTEGER,change_reason TEXT);`);
  db.prepare('INSERT INTO projects(id) VALUES(1)').run();db.prepare('INSERT INTO conversations(id) VALUES(1)').run();
  return db;
}
async function waitFor(manager,id) {
  const end=Date.now()+2000;
  while(Date.now()<end){const task=manager.get(id,1);if(!['QUEUED','RUNNING'].includes(task.status))return task;await new Promise(resolve=>setTimeout(resolve,5));}
  throw new Error('Agent task did not finish.');
}

test('agent task stores an idempotent step result and delivers its final message once',async()=>{
  const db=memoryDb();let effects=0;
  const manager=createAgentTasks(db,async(task,control)=>{
    const value=await control.runStep({key:'calculate:one',sequence:1,kind:'calculation',input:{amount:20}},async()=>({total:40,effect:++effects}));
    control.deliver(`النتيجة ${value.total}`);control.metric('task_tokens',12);
    return {status:'COMPLETE',result:{reply:`النتيجة ${value.total}`}};
  },{pollMs:10000});
  const task=manager.create({projectId:1,conversationId:1,objective:'حساب تجربة',payload:{},budget:{tokens:8000},projectFingerprint:'x'});
  const done=await waitFor(manager,task.id);
  assert.equal(done.status,'COMPLETE');assert.equal(effects,1);
  assert.equal(manager.steps(task.id,1)[0].result.total,40);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_task_deliveries').get().n,1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE content='النتيجة 40'").get().n,1);
  await manager.close();db.close();
});

test('expired task leases can be reclaimed and stale workers cannot overwrite the recovered result',async()=>{
  const db=memoryDb();let nowMs=Date.now(),releaseOld,startedOld;
  const oldStarted=new Promise(resolve=>{startedOld=resolve;});
  const oldGate=new Promise(resolve=>{releaseOld=resolve;});
  const now=()=>new Date(nowMs);
  const oldManager=createAgentTasks(db,async(task,control)=>{startedOld();await oldGate;control.deliver('نسخة قديمة');return {status:'COMPLETE',result:{reply:'قديم'}};},{leaseMs:1000,pollMs:10000,now});
  const task=oldManager.create({projectId:1,conversationId:1,objective:'استعادة',payload:{},budget:{tokens:8000},projectFingerprint:'x'});
  await oldStarted;nowMs+=1500;
  const newManager=createAgentTasks(db,async(current,control)=>{control.deliver('النتيجة المستعادة');return {status:'COMPLETE',result:{reply:'النتيجة المستعادة'}};},{leaseMs:1000,pollMs:10000,now});
  newManager.recover();
  const done=await waitFor(newManager,task.id);
  releaseOld();await oldManager.close();await newManager.close();
  assert.equal(done.result.reply,'النتيجة المستعادة');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_task_deliveries').get().n,1);
  assert.equal(db.prepare('SELECT content FROM messages').get().content,'النتيجة المستعادة');
  db.close();
});

test('plan validation separates complete, provisional, and waiting states',()=>{
  const plan={title:'خطة',body:{summary:'ملخص',steps:[{text:'خطوة'}],requirements:['متطلب'],assumptions:['افتراض'],risks:['مخاطرة'],sources:[],calculations:[{id:'budget',values:{budget:1000},missing:[]} ]}};
  const calculation={tool:'analyze_scenario',invocationId:'budget',status:'succeeded',output:{id:'budget',values:{budget:1000},missing:[],scenario:false}};
  assert.equal(validateBusinessPlan(plan,{objective:'هدف',authoritativeToolResults:[calculation],requireFinancial:true}).status,'COMPLETE');
  const incomplete={tool:'analyze_scenario',invocationId:'budget',status:'insufficient_data',output:{id:'budget',missing:['price']},missingInputs:['price']};
  const waiting=validateBusinessPlan(plan,{objective:'هدف',authoritativeToolResults:[incomplete],requireFinancial:true});
  assert.equal(waiting.status,'PROVISIONAL');assert.equal(waiting.taskStatus,'WAITING_FOR_INPUT');
  assert.equal(validateBusinessPlan(null,{objective:'هدف'}).taskStatus,'WAITING_FOR_INPUT');
});

test('plan validator rejects unsupported calculations and keeps failed optional research provisional',()=>{
  const plan={id:7,title:'خطة',body:{summary:'ملخص',steps:[{text:'خطوة'}],requirements:['متطلب'],assumptions:['افتراض معلن'],risks:['مخاطرة'],sources:[],calculations:[{id:'budget',values:{budget:9000},missing:[]} ]}};
  const actual={tool:'analyze_scenario',invocationId:'budget',status:'succeeded',output:{id:'budget',values:{budget:10000},missing:[],scenario:false}};
  const conflict=validateBusinessPlan(plan,{objective:'مشروع',requireFinancial:true,authoritativeToolResults:[actual]});
  assert.equal(conflict.status,'INVALID');assert.ok(conflict.errors.some(value=>value.includes('قيمة حساب غير متطابقة')));
  plan.body.calculations[0].values.budget=10000;
  plan.body.summary='اشترِ 50 كتكوتًا بسعر 20 جنيهًا للوحدة.';
  const unsupported=validateBusinessPlan(plan,{objective:'مشروع',requireFinancial:true,authoritativeToolResults:[actual]});
  assert.equal(unsupported.status,'INVALID');assert.ok(unsupported.errors.some(value=>value.includes('رقم غير مدعوم')));
  plan.body.summary='ملخص مبدئي حسب الميزانية المحسوبة.';
  const failedSearch={tool:'market_search',invocationId:'feed',input:{key:'feed'},status:'recoverable_failure',errors:[{code:'SEARCH_TIMEOUT'}]};
  const provisional=validateBusinessPlan(plan,{objective:'مشروع',requireFinancial:true,authoritativeToolResults:[actual,failedSearch]});
  assert.equal(provisional.status,'PROVISIONAL');assert.ok(provisional.warnings.some(value=>value.includes('تعذر التحقق من البحث')));
});

test('task finalization cannot expose COMPLETE when plan validation is incomplete',async()=>{
  const db=memoryDb();
  const manager=createAgentTasks(db,async(task,control)=>{
    control.deliver('الحساب محتاج مدخل.');
    return {status:'COMPLETE',result:{status:'COMPLETE',reply:'الحساب محتاج مدخل.',validation:{status:'WAITING_FOR_INPUT'},plan:{id:3,status:'INVALID'}}};
  },{pollMs:10000});
  const task=manager.create({projectId:1,conversationId:1,objective:'تجربة',payload:{},budget:{tokens:8000},projectFingerprint:'x'});
  const done=await waitFor(manager,task.id);
  assert.equal(done.status,'WAITING_FOR_INPUT');assert.equal(done.result.status,'WAITING_FOR_INPUT');
  await manager.close();db.close();
});

test('normalized tool outcomes classify missing calculation inputs as insufficient data',()=>{
  const {toolOutcome}=require('../server/agent-task-runner');
  const outcome=toolOutcome({tool:'analyze_scenario',invocationId:'calc-1',input:{type:'budget'},output:{id:'calc-1',values:{},missing:['reserve']},projectId:1});
  assert.equal(outcome.status,'insufficient_data');assert.deepEqual(outcome.missingInputs,['reserve']);
  assert.equal(outcome.projectId,1);assert.equal(outcome.tool,'analyze_scenario');
});

test('failed research and missing reserve leave a provisional plan while task waits for input',async()=>{
  const db=memoryDb(),decisions=[];let savedPlan=null;
  const makePlan=()=>({title:'خطة مشروع',body:{summary:'خطة مبدئية بالأرقام المتاحة.',steps:[{text:'راجع المتطلبات قبل أي شراء.'}],requirements:['تأكيد الأسعار'],assumptions:['لا يوجد سعر موثوق للعلف.'],risks:['تغير تكلفة المدخلات.'],sources:[],calculations:[]}});
  const advisor={memory:{facts:()=>[],research:()=>[],saveResearch:()=>[],state:()=>({pending_question:null}),latestPlan:()=>savedPlan,
    setPlanValidation:(_project,_id,validation)=>{savedPlan.status=validation.status;savedPlan.body.validation=validation;}},
    process:async(_project,_message,_text,value)=>{
      const calculations=(value.calculations||[]).map(request=>({id:request.id,type:request.type,request,missing:['reserve'],display:'الحساب محتاج قيمة الاحتياطي.'}));
      if(value.plan)savedPlan={id:1,revision:1,title:value.plan.title,body:{...makePlan().body,...value.plan.body,calculations},stale:false};
      else if(savedPlan)savedPlan.body.calculations=calculations;
      return {reply:value.answer||'الخطة مبدئية.',plan:savedPlan,calculations,question:null,state:{pending_question:null}};
    }};
  const request={id:'budget',type:'budget',budget:{fact_key:null,value:10000,basis:'user',evidence:'10000'},reserve:null,lines:[{label:'تشغيل',weight:1,amount:null}]};
  const parsed={intent:'advise',answer:'الخطة كاملة وجاهزة.',question:null,plan:makePlan(),calculations:[request],
    research_requests:[{key:'feed',query:'سعر العلف',purpose:'price',product_name:'علف',unit:'كيس'},{key:'chicks',query:'سعر الكتكوت',purpose:'price',product_name:'كتكوت',unit:'طائر'}],facts:[],goals:[],state_update:null};
  const config={agent:{taskTimeoutMs:5000,taskInputCostPerMillion:0,taskOutputCostPerMillion:0}};
  const runner=createTaskRunner({db,advisor,config,contextFor:()=>({advisor:{},history:[]}),
    extractDecision:async(_message,context)=>{decisions.push(context.task);if(decisions.length>1)assert.equal(context.task.tool_results.filter(row=>row.kind==='market_search').length,2);return {...parsed,answer:decisions.length>1?'النتائج راجعتها والخطة كاملة.':parsed.answer,calculations:decisions.length>1?[]:parsed.calculations};},
    searchMarket:async()=>{throw Object.assign(new Error('timeout'),{code:'SEARCH_TIMEOUT'});}});
  const manager=createAgentTasks(db,runner.run,{leaseMs:1000,pollMs:10000});
  const task=manager.create({projectId:1,conversationId:1,type:'business_plan',objective:'خطة مشروع بميزانية 10000',payload:{message:'أريد خطة مشروع',baselineDecisionCount:0},
    projectFingerprint:projectFingerprint(db,1),budget:{decisions:4,tools:5,tokens:8000,timeoutMs:5000,inputCostPerMillion:0,outputCostPerMillion:0}});
  const done=await waitFor(manager,task.id);
  assert.equal(done.status,'WAITING_FOR_INPUT',JSON.stringify(done.result));
  assert.equal(done.result.validation.status,'PROVISIONAL',JSON.stringify(done.result.validation));
  assert.equal(done.result.plan.status,'PROVISIONAL');
  assert.equal(done.result.validation.taskStatus,'WAITING_FOR_INPUT');
  assert.ok(done.result.validation.missing.some(value=>value.includes('reserve')));
  assert.ok(done.result.reply.includes('ما استخدمتش سعر غير مؤكد'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM transactions WHERE project_id=1').get().n,0);
  assert.equal(manager.steps(task.id,1).filter(step=>step.kind==='market_search').length,2);
  await manager.close();db.close();
});

test('terminal multi-step result includes a persisted project plan reference',async()=>{
  const db=memoryDb(),savedPlan={id:9,project_id:1,revision:2,title:'الخطة الحالية',status:'draft',stale:0,body:{summary:'ملخص',steps:[{text:'الخطوة الجاية'}],requirements:['متطلب'],assumptions:['افتراض'],risks:['مخاطرة'],sources:[],calculations:[]}};
  const memory={facts:()=>[],goals:()=>[],research:()=>[],state:()=>({pending_question:null}),latestPlan:()=>savedPlan,
    setPlanValidation:(_project,_id,validation)=>{savedPlan.status=validation.status;savedPlan.body.validation=validation;}};
  const advisor={memory,process:async()=>({reply:'الخطة محفوظة.',calculations:[],plan:null,state:{pending_question:null}})};
  const runner=createTaskRunner({db,advisor,config:{agent:{taskTimeoutMs:5000,taskInputCostPerMillion:0,taskOutputCostPerMillion:0}},
    contextFor:()=>({advisor:{},history:[]}),extractDecision:async()=>({intent:'advise',answer:'تابعي الخطة المحفوظة.',calculations:[],research_requests:[],question:null})});
  const manager=createAgentTasks(db,runner.run,{leaseMs:1000,pollMs:10000});
  const task=manager.create({projectId:1,conversationId:1,type:'multi_step',objective:'متابعة الخطة',decisionCount:1,
    payload:{message:'كملي الخطة',baselineDecisionCount:1,parsed:{intent:'advise',answer:'متابعة',calculations:[],research_requests:[],question:null}},
    projectFingerprint:projectFingerprint(db,1),budget:{decisions:3,tools:3,tokens:8000,timeoutMs:5000,inputCostPerMillion:0,outputCostPerMillion:0}});
  const done=await waitFor(manager,task.id);
  assert.equal(done.status,'COMPLETE');assert.deepEqual(done.result.planRef,{planId:9,projectId:1,revision:2,status:'COMPLETE'});
  assert.equal(savedPlan.status,'COMPLETE');
  await manager.close();db.close();
});

test('task budgets stay complexity-aware and cost ceilings use configured token rates',()=>{
  const config={agent:{taskTimeoutMs:300000,taskInputCostPerMillion:1,taskOutputCostPerMillion:2}};
  assert.deepEqual([taskBudget('simple',config).decisions,taskBudget('multi_step',config).decisions,taskBudget('business_plan',config).decisions],[2,4,6]);
  assert.equal(taskBudget('business_plan',config).maxCost,0.048);
});

test('Serper search output reaches a new Gemini decision, calculation, and persisted plan',async()=>{
  const fakeFetch=async(url,request)=>({ok:true,status:200,headers:{get:()=>null},json:async()=>({shopping:[
    {title:'علف دواجن كيس',link:'https://supplier.example/feed',price:'EGP 700',source:'مورد تجريبي'},
  ]})});
  const db=memoryDb(),decisions=[],toolResult={product_name:'علف دواجن',price:700,currency:'EGP',unit:'كيس',normalized_unit:'كيس',source_title:'مصدر تجريبي',source_url:'https://example.test/feed',observed_on:new Date().toISOString().slice(0,10),selected:1,stale:false};
  let savedPlan=null,searchCalls=0;
  const makePlan=(summary,calculations=[])=>({title:'خطة مشروع',body:{summary,steps:[{text:'ابدأ بتجربة صغيرة'}],requirements:['تأكيد المكان'],assumptions:['احتياطي 1500 جنيه مقترح لمواجهة تأخر الدخل، وليس مبلغًا أكده المستخدم.'],risks:['تذبذب الأسعار'],sources:[{title:toolResult.source_title,url:toolResult.source_url}],calculations}});
  const parsed=(plan,extra={})=>({intent:'advise',answer:plan.body.summary,question:null,plan,calculations:[],research_requests:[],facts:[],goals:[],state_update:null,...extra});
  const capitalFact={key:'capital',label:'الميزانية',numeric_value:10000,value:'10000',certainty:'confirmed',unit:'جنيه'};
  const advisor={memory:{
    facts:()=>searchCalls?[capitalFact,{key:'market:feed',label:'علف دواجن',numeric_value:700,value:'700',certainty:'approximate',kind:'price',unit:'كيس',observed_on:toolResult.observed_on,source:toolResult.source_url}]:[capitalFact],research:()=>savedPlan? [toolResult]:[],saveResearch:(_project,result)=>{searchCalls++;return result.items.map(row=>({...row,selected:1}));},
    state:()=>({pending_question:null}),latestPlan:()=>savedPlan,setPlanValidation:(_project,id,validation)=>{savedPlan.status=validation.status;savedPlan.body.validation={status:validation.status,missing:validation.missing};db.prepare('UPDATE business_plans SET status=?,body=? WHERE id=?').run(savedPlan.status,JSON.stringify(savedPlan.body),id);},
  },process:async(_project,_message,_text,value)=>{
    const calculations=(value.calculations||[]).map(request=>({...calculate(request,{facts:advisor.memory.facts(),message:'خطة 10000 جنيه'}),request,display:'حساب متاح من رأس المال والأسعار الموثقة.'}));
    if(value.plan){const revision=(savedPlan?.revision||0)+1,body={...value.plan.body,calculations:calculations.length?calculations:savedPlan?.body?.calculations||[]};const inserted=db.prepare('INSERT INTO business_plans(project_id,revision,title,status,body) VALUES(?,?,?,?,?)').run(_project,revision,value.plan.title,'PROVISIONAL',JSON.stringify(body));savedPlan={id:Number(inserted.lastInsertRowid),project_id:_project,revision,title:value.plan.title,status:'PROVISIONAL',body,stale:false};}
    if(savedPlan&&calculations.length)savedPlan.body.calculations=calculations;
    return {reply:value.answer,plan:savedPlan,calculations,question:value.question,state:{pending_question:null}};
  }};
  const config={agent:{taskTimeoutMs:5000,taskInputCostPerMillion:0,taskOutputCostPerMillion:0}};
  const runner=createTaskRunner({db,advisor,config,contextFor:()=>({advisor:{},history:[]}),
    extractDecision:async(_message,context)=>{
      decisions.push(structuredClone(context.task));
      if(decisions.length===1)return parsed(makePlan('سأراجع سعر العلف.'),{research_requests:[{key:'feed',query:'سعر علف دواجن مصر',purpose:'price',product_name:'علف دواجن',specification:'',unit:'كيس',location:'مصر',freshness_days:14,search_type:'shopping',reason:'سعر الخامة'}]});
      assert.equal(context.task.tool_results[0].output.items[0].price,700);
      if(decisions.length===2)return parsed(makePlan('الخطة مبنية على السعر الذي وجدته.'),{
        calculations:[{id:'purchase',type:'purchase',budget:{fact_key:'capital',value:null,basis:'stored',evidence:null},reserve:{fact_key:null,value:1500,basis:'assumption',evidence:null},price:{fact_key:'market:feed',value:null,basis:'stored',evidence:null},quantity:null,unit_cost:null,fixed_cost:null,target:null,lines:[]} ]});
      const calc=context.task.tool_results.find(row=>row.kind==='calculation');
      assert.equal(calc.status,'succeeded');assert.equal(calc.output.values.quantity,12);
      return parsed(makePlan('راجعت نتيجة الحساب وأكملت الخطة.'));
    },
    searchMarket:(request,options)=>marketResearch.search(request,{...options,provider:'serper',config:{...loadConfig(),serperApiKey:'test-key'},fetch:fakeFetch}),
  });
  const manager=createAgentTasks(db,runner.run,{leaseMs:1000,pollMs:10000});
  const task=manager.create({projectId:1,conversationId:1,type:'business_plan',objective:'خطة مشروع',payload:{message:'عايز خطة مشروع',baselineDecisionCount:0,baselineInputTokens:0,baselineOutputTokens:0},
    projectFingerprint:projectFingerprint(db,1),budget:{decisions:4,tools:3,tokens:8000,timeoutMs:5000,inputCostPerMillion:0,outputCostPerMillion:0}});
  const done=await waitFor(manager,task.id);
  assert.equal(done.status,'PROVISIONAL',JSON.stringify({result:done.result,steps:manager.steps(task.id,1)}));
  assert.equal(decisions.length,3);assert.equal(searchCalls,1);
  assert.equal(done.result.validation.status,'PROVISIONAL');
  assert.equal(done.result.metrics.decisions,3);
  assert.equal(done.result.calculations?.[0]?.values?.quantity,12,JSON.stringify({result:done.result,steps:manager.steps(task.id,1)}));
  assert.equal(manager.steps(task.id,1).filter(step=>step.kind==='llm_decision').length,3);
  assert.equal(db.prepare('SELECT status FROM business_plans WHERE id=?').get(done.result.plan.id).status,'PROVISIONAL');
  assert.equal(done.result.planRef.planId,done.result.plan.id);
  assert.equal(done.result.planRef.projectId,1);assert.equal(done.result.planRef.revision,done.result.plan.revision);
  assert.ok(db.prepare('SELECT 1 FROM agent_task_deliveries WHERE task_id=?').get(task.id));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM transactions WHERE project_id=1').get().n,0);
  await manager.close();db.close();
});
