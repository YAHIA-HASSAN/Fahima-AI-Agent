const { createHash } = require('node:crypto');
const { extract } = require('./agent');
const marketResearch = require('./market-research');
const { validateBusinessPlan } = require('./plan-validator');
const { createToolRegistry } = require('./tool-registry');

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function toolOutcome({tool,invocationId,input,output,error,projectId,at=new Date().toISOString()}) {
  const missingInputs=[...(output?.missing||output?.missingInputs||[])];
  let status='succeeded';
  if(error)status=['SEARCH_TIMEOUT','HTTP_429','HTTP_503','SERPER_NETWORK_ERROR','SERPER_NOT_CONFIGURED','SERPER_UNAUTHORIZED','SERPER_FORBIDDEN'].includes(error.code)?'recoverable_failure':'terminal_failure';
  else if(missingInputs.length)status='insufficient_data';
  else if(tool==='analyze_scenario'&&(!output?.values||!Object.keys(output.values).length))status='insufficient_data';
  else if(tool==='market_search') {
    const hasPrice=(output?.items||[]).some(row=>row.selected&&row.price!=null&&row.source_url&& (row.unit||row.normalized_unit)&&!row.stale);
    if(input?.purpose==='price'&&!hasPrice)status='insufficient_data';
    else if(!(output?.items||[]).length)status='insufficient_data';
  }
  const errors=error?[{code:String(error.code||'tool_failed'),category:status,message:String(error.message||'تعذر تنفيذ الأداة.').slice(0,300),
    mode:error.mode||error.searchMode||null,elapsedMs:Number(error.elapsedMs)||null,providerStatus:Number(error.providerStatus||error.status)||null}]:[];
  const sourceRows=tool==='market_search'?(output?.sources||output?.items||[]).map(row=>({title:row.source_title||row.title,url:row.source_url||row.url,observed_on:row.observed_on,selected:Boolean(row.selected)})):
    (output?.sources||[]).map(row=>({key:row.key,label:row.label,certainty:row.certainty,source:row.source}));
  if(status==='insufficient_data'&&!missingInputs.length)missingInputs.push(tool==='market_search'?'verified_research':'validated_output');
  return {tool,invocationId:String(invocationId||`${tool}:${hash({input,at}).slice(0,16)}`),status,input:input||{},output:output||null,
    missingInputs:[...new Set(missingInputs)],errors,sources:sourceRows.filter(row=>row.url||row.key||row.label),
    timestamp:at,projectId:Number(projectId)};
}
function outcomeFailed(result) {return ['recoverable_failure','terminal_failure','skipped'].includes(result?.status)||Boolean(result?.error);}
function modelToolResults(outcomes) {
  return outcomes.slice(-8).map(({kind,key,result})=>{
    const output=result?.output||result?.result||{};
    if(kind==='market_search')return {...result,kind,key,output:{summary:output.summary||'',cached:Boolean(output.cached),
      items:(output.items||[]).slice(0,4).map(row=>({product_name:row.product_name,specification:row.specification,price:row.price,currency:row.currency,
        quantity:row.quantity,unit:row.normalized_unit||row.unit,source_title:row.source_title,source_url:row.source_url,observed_on:row.observed_on,
        location:row.location,confidence:row.confidence,stale:Boolean(row.stale)}))}};
    return {...result,kind,key};
  });
}
function decisionSummary(value) {
  return {intent:value.intent,answer:String(value.answer||'').slice(0,300),question:value.question,
    research_requests:value.research_requests,calculations:value.calculations,
    plan:value.plan?{title:value.plan.title,summary:value.plan.summary}:null,state_update:value.state_update};
}
function taskBudget(type,config) {
  const profiles={
    simple:{decisions:2,tools:2,tokens:8000},
    multi_step:{decisions:4,tools:4,tokens:16000},
    business_plan:{decisions:6,tools:6,tokens:24000},
  };
  const selected=profiles[type]||profiles.multi_step;
  const inputCostPerMillion=config.agent.taskInputCostPerMillion,outputCostPerMillion=config.agent.taskOutputCostPerMillion;
  const maxCost=inputCostPerMillion||outputCostPerMillion?selected.tokens*Math.max(inputCostPerMillion,outputCostPerMillion)/1e6:null;
  return {...selected,timeoutMs:config.agent.taskTimeoutMs,maxCost,inputCostPerMillion,outputCostPerMillion};
}
function projectFingerprint(db,projectId) {
  return hash({facts:db.prepare('SELECT key,value,numeric_value,certainty,revision,updated_at FROM project_facts WHERE project_id=? ORDER BY key').all(projectId),
    goals:db.prepare('SELECT goal_key,title,target,unit,horizon,status,updated_at FROM business_goals WHERE project_id=? ORDER BY goal_key').all(projectId),
    transactions:db.prepare('SELECT COUNT(*) AS count,MAX(id) AS last_id FROM transactions WHERE project_id=?').get(projectId)});
}
function createTaskRunner({db,advisor,config,contextFor,addMetric,extractDecision=extract,searchMarket=marketResearch.search}) {
  async function run(task,control) {
    const started=Date.now(),payload=task.payload||{},message=String(payload.message||''),projectId=task.projectId;
    const budget=task.budget||taskBudget(task.type,config);
    const runtimeTools=createToolRegistry({projectId});
    runtimeTools.register({name:'market_search',description:'Find and validate current external market information for this project.',
      inputSchema:{type:'object',properties:{key:{type:'string',minLength:1,maxLength:80},query:{type:'string',minLength:1,maxLength:300},purpose:{type:'string',enum:['price','supplier','requirement','regulation','market']},product_name:{type:'string',maxLength:120},specification:{type:['string','null'],maxLength:200},unit:{type:['string','null'],maxLength:60},location:{type:['string','null'],maxLength:120},freshness_days:{type:'number',minimum:1,maximum:365},search_type:{type:'string',enum:['search','shopping']},reason:{type:'string',maxLength:300},source_url:{type:['string','null'],maxLength:1000}},required:['key','query','purpose','product_name','specification','unit','location','freshness_days','reason'],additionalProperties:false},
      outputSchema:{type:'object'},execute:async(request)=>{
        const normalize=value=>String(value||'').toLocaleLowerCase('ar-EG').replace(/[\s\u0640]/gu,'').trim();
        const prior=advisor.memory.research(projectId,{freshOnly:true}).find(row=>row.research_key===request.key&&row.selected&&
          (!request.product_name||normalize(row.product_name)===normalize(request.product_name))&&
          (!request.specification||normalize(row.specification)===normalize(request.specification))&&
          (!request.unit||normalize(row.normalized_unit||row.unit)===normalize(request.unit))&&
          (!request.location||normalize(request.location)==='مصر'||normalize(row.location)===normalize(request.location)));
        if(prior)return {cached:true,summary:'Using a matching fresh project-scoped research result.',items:[prior]};
        const location=advisor.memory.facts(projectId).find(row=>row.key==='location')?.value||null;
        const result=await searchMarket(request,{location,projectId});
        result.items=advisor.memory.saveResearch(projectId,result);
        return {cached:false,...result};
      }});
    const baselineDecisions=Number(payload.baselineDecisionCount??(payload.parsed?1:0));
    const baselineInputTokens=Number(payload.baselineInputTokens)||0,baselineOutputTokens=Number(payload.baselineOutputTokens)||0;
    const persistedSteps=control.completedSteps?.()||[];
    const decisionSteps=persistedSteps.filter(step=>step.kind==='llm_decision'&&step.status==='completed').sort((a,b)=>a.sequence-b.sequence);
    const toolSteps=persistedSteps.filter(step=>['market_search','calculation'].includes(step.kind));
    const outcomes=[...(payload.initialToolResults||[]),...toolSteps.map(step=>({kind:step.kind,key:step.key,stepKey:step.key,
      result:step.status==='completed'?step.result:toolOutcome({tool:step.kind==='market_search'?'market_search':'analyze_scenario',invocationId:step.key,
        input:{key:step.key},error:{code:step.error||'TOOL_PREVIOUSLY_FAILED',message:'Tool did not complete in the previous attempt.'},projectId})}))];
    let decisions=Math.max(Number(task.decisionCount)||0,baselineDecisions,...decisionSteps.map(step=>Math.ceil(step.sequence/100)));
    let tools=Math.max(Number(task.toolCount)||0,toolSteps.length,payload.initialToolResults?.length||0);
    let parsed=(payload.initialToolResults?.length?null:payload.parsed)||null;
    let currentDecisionSequence=baselineDecisions*100;
    const latestDecision=decisionSteps.at(-1);
    if(latestDecision){parsed=latestDecision.result?.decision||parsed;currentDecisionSequence=latestDecision.sequence;}
    const latestToolSequence=Math.max(0,...toolSteps.map(step=>step.sequence));
    if(latestToolSequence>currentDecisionSequence)parsed=null;
    const previousDecisions=decisionSteps.map(step=>({sequence:step.sequence,result:step.result?.decision}));
    if(payload.parsed&&baselineDecisions&&!previousDecisions.length)previousDecisions.push({sequence:baselineDecisions*100,result:decisionSummary(payload.parsed)});
    task.inputTokens=baselineInputTokens+decisionSteps.reduce((sum,step)=>sum+(Number(step.result?.usage?.inputTokens)||0),0);
    task.outputTokens=baselineOutputTokens+decisionSteps.reduce((sum,step)=>sum+(Number(step.result?.usage?.outputTokens)||0),0);
    let totalTokens=Number(task.inputTokens||0)+Number(task.outputTokens||0);
    let repeatedQuestion=false;
    async function withProviderRetry(operation) {
      for(let attempt=0;;attempt++) {
        try{return await operation();}catch(error) {
          const status=Number(error?.status||error?.statusCode||error?.response?.status||error?.cause?.status||0);
          if(attempt>=1||![429,503].includes(status))throw error;
          const headers=error?.headers||error?.response?.headers;
          const headerValue=typeof headers?.get==='function'?headers.get('retry-after'):headers?.['retry-after']||headers?.['Retry-After'];
          const seconds=Number(headerValue);
          const delay=Number.isFinite(seconds)&&seconds>0?seconds*1000:1000*(2**attempt);
          if(Date.now()-started+delay>=budget.timeoutMs)throw error;
          await new Promise(resolve=>setTimeout(resolve,delay));
        }
      }
    }
    function updateCounts(extra={}) {
      const cost=budget.inputCostPerMillion||budget.outputCostPerMillion
        ?(Number(task.inputTokens||0)*(budget.inputCostPerMillion||0)+Number(task.outputTokens||0)*(budget.outputCostPerMillion||0))/1e6:null;
      control.update({decision_count:decisions,tool_count:tools,input_tokens:Number(task.inputTokens||0),output_tokens:Number(task.outputTokens||0),estimated_cost:cost,...extra});
    }
    function checkBudget() {
      if(Date.now()-started>budget.timeoutMs)throw Object.assign(new Error('المهمة احتاجت وقت أطول من المتاح. حفظت فهيمة التقدم، ونقدر نكملها بطلب جديد.'),{code:'TASK_TIMEOUT'});
      if(totalTokens>=budget.tokens)throw Object.assign(new Error('وصلت المهمة لحد الرموز المحدد لها. النتيجة الحالية محفوظة وتحتاج خطوة متابعة.'),{code:'TASK_TOKEN_BUDGET'});
      if(decisions>=budget.decisions)throw Object.assign(new Error('وصلت المهمة لحد خطوات القرار. حفظت فهيمة التقدم الحالي.'),{code:'TASK_DECISION_BUDGET'});
      if(tools>=budget.tools)throw Object.assign(new Error('وصلت المهمة لحد استخدام الأدوات. حفظت فهيمة التقدم الحالي.'),{code:'TASK_TOOL_BUDGET'});
      const spent=(Number(task.inputTokens||0)*budget.inputCostPerMillion+Number(task.outputTokens||0)*budget.outputCostPerMillion)/1e6;
      if(budget.maxCost!=null&&spent>=budget.maxCost)throw Object.assign(new Error('وصلت المهمة للميزانية المحددة للنموذج.'),{code:'TASK_COST_BUDGET'});
    }
    function checkCostBudget() {
      const spent=(Number(task.inputTokens||0)*budget.inputCostPerMillion+Number(task.outputTokens||0)*budget.outputCostPerMillion)/1e6;
      if(budget.maxCost!=null&&spent>budget.maxCost)throw Object.assign(new Error('وصلت المهمة للميزانية المحددة للنموذج.'),{code:'TASK_COST_BUDGET'});
    }
    let initialFingerprint=String(payload.projectFingerprint||task.projectFingerprint||'');
    let processed=payload.initialAdvice||null;
    function stale() {return initialFingerprint&&projectFingerprint(db,projectId)!==initialFingerprint;}
    async function decide(context) {
      const number=decisions+1,key=`decision:${number}`,sequence=number*100;
      const contextTask=context.task;
      const input={message,objective:task.objective,contextTask,projectFingerprint:initialFingerprint};
      const existed=(control.completedSteps?.()||[]).some(step=>step.key===key&&step.status==='completed');
      if(!existed)checkBudget();
      const saved=await control.runStep({key,sequence,kind:'llm_decision',input},async()=>{
        const response=await withProviderRetry(()=>extractDecision(message,context));
        return {decision:JSON.parse(JSON.stringify(response)),usage:response.usage||{}};
      });
      if(!saved?.decision)throw new Error('قرار Gemini المحفوظ غير مكتمل.');
      decisions=number;currentDecisionSequence=sequence;parsed=saved.decision;
      Object.defineProperty(parsed,'usage',{value:saved.usage||{},enumerable:false,configurable:true});
      if(!existed)previousDecisions.push({sequence,result:decisionSummary(parsed)});
      const allDecisions=control.completedSteps?.().filter(step=>step.kind==='llm_decision'&&step.status==='completed')||[];
      task.inputTokens=baselineInputTokens+allDecisions.reduce((sum,step)=>sum+(Number(step.result?.usage?.inputTokens)||0),0);
      task.outputTokens=baselineOutputTokens+allDecisions.reduce((sum,step)=>sum+(Number(step.result?.usage?.outputTokens)||0),0);
      totalTokens=Number(task.inputTokens||0)+Number(task.outputTokens||0);
      updateCounts();checkCostBudget();
      if(totalTokens>budget.tokens)throw Object.assign(new Error('وصلت المهمة لحد الرموز المحدد لها.'),{code:'TASK_TOKEN_BUDGET'});
      return parsed;
    }
    function decisionContext() {
      const context=contextFor(task.conversationId,projectId,message);
      context.task={objective:task.objective,required_outputs:task.type==='business_plan'?['خطة أعمال محفوظة بعنوان وملخص','خطوات تنفيذ قابلة للتطبيق','حساب مالي من أداة الخادم أو افتراض معلن','المتطلبات والمخاطر ومصادر الأسعار','النواقص المؤثرة']:['ملخص عملي','حسابات موثقة أو افتراضات معلنة','متطلبات ومخاطر وخطوات تنفيذ','نواقص مؤثرة'],
        decisions_remaining:Math.max(0,budget.decisions-decisions),tools_remaining:Math.max(0,budget.tools-tools),
        previous_decisions:previousDecisions.slice(-3).map(item=>({sequence:item.sequence,decision:decisionSummary(item.result||{})})),
        recovery_guidance:outcomes.some(item=>item.kind==='market_search'&&outcomeFailed(item.result))
          ?'تعذر بحث سوق في هذه المهمة. لا تعيدي طلب البحث نفسه. استخدمي فقط أسعار المشروع المخزنة إذا كانت حديثة ومطابقة. إذا لم يتوفر سعر موثوق، أكملي خطة مبدئية بالخطوات والمتطلبات دون اختراع سعر أو اعتبار تكلفة مجهولة صفرًا، ووسمي السعر والنواقص بوضوح. اسألي المستخدم فقط عن معلومة شخصية حرجة لا يمكن استنتاجها أو حسابها.'
          :null,
        tool_results:modelToolResults(outcomes)};
      return context;
    }
    async function performSearch(request,sequence) {
      const requestSignature=hash({key:request.key,query:request.query,product_name:request.product_name,specification:request.specification,unit:request.unit,location:request.location}).slice(0,16);
      const stepKey=`search:${request.key}:${requestSignature}`;
      const existing=outcomes.find(row=>row.stepKey===stepKey);
      if(existing)return;
      const step=await control.runStep({key:stepKey,sequence,kind:'market_search',input:{key:request.key,query:request.query,location:request.location}},async()=>{
        try {
          const outcome=await runtimeTools.execute('market_search',request);
          if(outcome.status!=='succeeded')throw Object.assign(new Error(outcome.error?.message||'تعذر تنفيذ بحث السوق.'),{code:outcome.error?.code||'MARKET_SEARCH_FAILED'});
          return toolOutcome({tool:'market_search',invocationId:stepKey,input:request,output:outcome.output,projectId});
        } catch(error) {
          if(error?.code==='TASK_LEASE_LOST')throw error;
          const status=Number(error?.status||error?.statusCode||error?.response?.status||error?.cause?.status||0);
          return toolOutcome({tool:'market_search',invocationId:stepKey,input:request,
            error:{code:status===429?'HTTP_429':status===503?'HTTP_503':error?.code||`HTTP_${status||'ERROR'}`,message:error?.code==='SEARCH_TIMEOUT'?'انتهت مهلة البحث.':status===429?'المزود رفض البحث مؤقتًا.':'تعذر إكمال البحث.',mode:error?.searchMode||'google_search',elapsedMs:error?.elapsedMs||null,providerStatus:status||null},projectId});
        }
      });
      tools+=1;outcomes.push({kind:'market_search',key:request.key,stepKey,result:step});
      control.metric('tool_execution',step.status==='succeeded'?1:0,{kind:'market_search',key:request.key,status:step.status});
      control.update({progress:`راجعت ${request.product_name||request.key} وسجلت نتيجة البحث.`});
      updateCounts();
    }
    async function finishWith(status,reply,processed=null,validation=null) {
      if(validation) {
        if(validation.status==='WAITING_FOR_INPUT')validation={...validation,status:'PROVISIONAL',taskStatus:'WAITING_FOR_INPUT'};
        if(status==='PROVISIONAL'&&validation.status==='COMPLETE')validation={...validation,status:'PROVISIONAL',missing:[...(validation.missing||[])],
          warnings:[...(validation.warnings||[]),'اكتملت المهمة دون اعتماد نهائي للخطة.']};
        if(status==='WAITING_FOR_INPUT'&&validation.status==='COMPLETE')validation={...validation,status:'PROVISIONAL',taskStatus:'WAITING_FOR_INPUT',
          missing:[...(validation.missing||[]),'معلومة مطلوبة لاستكمال المهمة.']};
        validation={...validation,qualityStatus:validation.status,valid:validation.status==='COMPLETE'};
      }
      let plan=processed?.plan||advisor.memory.latestPlan(projectId);
      if(plan&&validation){advisor.memory.setPlanValidation(projectId,plan.id,validation);plan=advisor.memory.latestPlan(projectId)||plan;}
      const failedResearch=outcomes.some(item=>item.kind==='market_search'&&outcomeFailed(item.result));
      if(failedResearch&&status!=='FAILED')reply='ماقدرتش أراجع أسعار موثوقة، فخليت الخطة مبدئية لحد ما نتأكد منها.';
      const taskSearchKeys=new Set(outcomes.filter(item=>item.kind==='market_search').map(item=>item.key));
      const researchRows=advisor.memory.research(projectId).filter(row=>row.selected||taskSearchKeys.has(row.research_key))
        .sort((a,b)=>Number(taskSearchKeys.has(b.research_key))-Number(taskSearchKeys.has(a.research_key))).slice(0,12);
      const groupedResearch=[...new Map(researchRows.map(row=>[row.research_key,row])).values()].map(row=>({request:{key:row.research_key},
        items:researchRows.filter(item=>item.research_key===row.research_key)}));
      const requiresPlan=task.type==='business_plan';
      const effectiveStatus=validation?.taskStatus==='WAITING_FOR_INPUT'||validation?.status==='INVALID'||requiresPlan&&!plan&&status!=='FAILED'?'WAITING_FOR_INPUT':
        validation?.status==='PROVISIONAL'&&status==='COMPLETE'?'PROVISIONAL':(!plan&&status==='COMPLETE'?'WAITING_FOR_INPUT':status);
      const userReply=String(reply||'').trim();
      const result={taskId:task.id,status:effectiveStatus,reply:userReply,speechText:userReply,
        plan:plan?{id:plan.id,projectId:Number(projectId),revision:plan.revision,title:plan.title,status:plan.status||validation?.status||'PROVISIONAL',stale:Boolean(plan.stale)}:null,
        planRef:plan?{planId:plan.id,projectId:Number(projectId),revision:plan.revision,status:plan.status||validation?.status||'PROVISIONAL'}:null,
        calculations:processed?.calculations||[],research:groupedResearch,
        state:processed?.state||advisor.memory.state(projectId),validation,metrics:{durationMs:Date.now()-started,decisions,tools,tokens:totalTokens}};
      control.deliver(result.reply);
      control.metric('task_duration_ms',result.metrics.durationMs);
      control.metric('task_decisions',decisions);
      control.metric('task_tools',tools);
      control.metric('task_tokens',totalTokens);
      control.metric('task_completed',status==='COMPLETE'?1:0,{status});
      control.metric('plan_quality_missing_sections',validation?.missing?.length||0,{status:validation?.status||status});
      control.metric('repeated_question',repeatedQuestion?1:0);
      result.status=effectiveStatus;
      return {status:effectiveStatus,result,progress:effectiveStatus==='COMPLETE'?'الخطة جاهزة بالمعلومات المتاحة.':effectiveStatus==='PROVISIONAL'?'الخطة مبدئية، وفيه حاجات لسه محتاجة مراجعة.':effectiveStatus==='WAITING_FOR_INPUT'?'محتاج أعرف منك معلومة واحدة.':'خلصت مراجعة الطلب.'};
    }
    try {
      let round=0;
      const existingDecision=Boolean(parsed);
      const rounds=Math.max(1,budget.decisions-decisions+(existingDecision?1:0));
      while(round<rounds) {
        if(control.cancelled())return {status:'CANCELLED',result:{status:'CANCELLED',reply:'تم إيقاف المهمة.'}};
        if(stale()) {
          const reply='معلومات المشروع اتغيرت أثناء إعداد الخطة، فمش هاعرض نتيجة قديمة كأنها محدثة. ابعتي «كمّلي الخطة» علشان أراجعها على البيانات الجديدة.';
          return finishWith('WAITING_FOR_INPUT',reply,processed,{status:'WAITING_FOR_INPUT',missing:['مراجعة بيانات المشروع بعد التغيير']});
        }
        if(!parsed)parsed=await decide(decisionContext());
        const outcomesBefore=outcomes.length,toolsBefore=tools;
        const priorPlanBefore=advisor.memory.latestPlan(projectId);
        const requests=parsed.research_requests||[];
        const requestedTools=requests.length+(parsed.calculations?.length||0);
        if(requestedTools&&decisions>=budget.decisions) {
          const safeParsed={...parsed,research_requests:[],calculations:[]};
          processed=await advisor.process(projectId,task.sourceMessageId,message,safeParsed,{preserveState:Boolean(round>0),deferResearch:true});
          const latest=processed?.plan||advisor.memory.latestPlan(projectId),validation=validateBusinessPlan(latest,{objective:task.objective,projectFacts:advisor.memory.facts(projectId),
            calculations:outcomes.filter(item=>item.kind==='calculation').map(item=>item.result),research:advisor.memory.research(projectId),authoritativeToolResults:outcomes,
            requiredDeliverables:{financialAnalysis:task.type==='business_plan'}});
          const status=latest?'PROVISIONAL':'WAITING_FOR_INPUT';
          return finishWith(status,'وصلت فهيمة لحدود المهمة قبل تنفيذ الخطوة التالية. النتيجة الحالية مبدئية وتحتاج متابعة.',processed,
            {...validation,status,missing:[...validation.missing,'خطوة مطلوبة لم يسمح بها حد المهمة']});
        }
        // Apply facts, goals and the current recommendation before tools need them.
        if(!processed||!payload.initialAdvice||round>0) {
          processed=await advisor.process(projectId,task.sourceMessageId,message,parsed,{preserveState:Boolean(round>0),deferResearch:true});
          initialFingerprint=projectFingerprint(db,projectId);
        }
        const executable={...parsed,research_requests:[]};
        if(task.type==='business_plan'&&!executable.calculations?.length&&executable.plan) {
          const priorCalculations=priorPlanBefore?.body?.calculations||[];
          executable.calculations=priorCalculations.map(row=>row.request).filter(Boolean);
        }
        for(const request of requests.slice(0,2)) {
          if(tools>=budget.tools){outcomes.push({kind:'market_search',key:request.key,stepKey:`limit:${request.key}`,result:{error:{code:'TOOL_BUDGET',message:'تم بلوغ حد الأدوات.'}}});continue;}
          await performSearch(request,decisions*100+tools+1);
        }
        // Research is now in project memory, so deterministic calculations use its actual normalized values.
        processed=await advisor.process(projectId,task.sourceMessageId,message,executable,{preserveState:true,deferResearch:true});
        initialFingerprint=projectFingerprint(db,projectId);
        const priorQuestion=advisor.memory.state(projectId).pending_question?.text;
        repeatedQuestion=Boolean(priorQuestion&&parsed.question?.text===priorQuestion);
        for(let index=0;index<(processed.calculations||[]).length;index++) {
          const calculation=processed.calculations[index];
          const input={request:calculation.request||null,values:calculation.values||null,missing:calculation.missing||[],fingerprint:initialFingerprint};
          const stepKey=`calculation:${hash(input).slice(0,24)}`;
          const previous=outcomes.find(row=>row.stepKey===stepKey);
          if(previous){processed.calculations[index]=previous.result?.output||previous.result?.result||previous.result;continue;}
          if(tools>=budget.tools){outcomes.push({kind:'calculation',stepKey:`limit:${stepKey}`,result:{error:{code:'TOOL_BUDGET',message:'تم بلوغ حد الأدوات.'}}});continue;}
          const saved=await control.runStep({key:stepKey,sequence:decisions*100+tools+1,kind:'calculation',input},async()=>toolOutcome({tool:'analyze_scenario',
            invocationId:calculation.id,input:calculation.request||input,output:calculation,projectId}));
          const execution=saved?.output?saved:toolOutcome({tool:'analyze_scenario',invocationId:calculation.id,input:calculation.request||input,output:saved,projectId});
          processed.calculations[index]=execution.output;tools+=1;
          if(calculation.id)for(let priorIndex=outcomes.length-1;priorIndex>=0;priorIndex--) {
            const prior=outcomes[priorIndex],priorOutput=prior?.result?.output||prior?.result?.result;
            if(prior.kind==='calculation'&&priorOutput?.id===calculation.id)outcomes.splice(priorIndex,1);
          }
          outcomes.push({kind:'calculation',key:calculation.id,stepKey,result:execution});
          control.metric('tool_execution',execution.status==='succeeded'?1:0,{kind:'calculation',type:calculation.type,status:execution.status});
        }
        updateCounts({progress:processed.plan?'حسبت المدخلات المتاحة وراجعت مسودة الخطة.':'حللت المعلومات المتاحة وحددت الخطوة التالية.'});
        if(outcomes.length>outcomesBefore||tools>toolsBefore) {
          if(decisions>=budget.decisions) {
            const latest=processed?.plan||advisor.memory.latestPlan(projectId),validation=validateBusinessPlan(latest,{objective:task.objective,projectFacts:advisor.memory.facts(projectId),
              calculations:outcomes.filter(item=>item.kind==='calculation').map(item=>item.result),research:advisor.memory.research(projectId),authoritativeToolResults:outcomes,
              requiredDeliverables:{financialAnalysis:task.type==='business_plan'}});
            const status=latest?'PROVISIONAL':'WAITING_FOR_INPUT';
            return finishWith(status,'نفذت الأدوات المتاحة، ووصلت لحد القرارات قبل مراجعة النتائج. النتيجة مبدئية وتحتاج متابعة.',processed,{...validation,status,missing:[...validation.missing,'مراجعة نتائج الأدوات']});
          }
          parsed=null;round+=1;continue;
        }
        const currentPlan=processed.plan||(task.type==='business_plan'?advisor.memory.latestPlan(projectId):null);
        const authoritativeCalculations=outcomes.filter(item=>item.kind==='calculation').map(item=>item.result?.output||item.result?.result||item.result).filter(Boolean);
        if(!processed.calculations?.length&&authoritativeCalculations.length)processed.calculations=authoritativeCalculations;
        if(task.type!=='business_plan') {
          const calculationOutcomes=outcomes.filter(item=>item.kind==='calculation').map(item=>item.result);
          const missing=[...new Set(calculationOutcomes.flatMap(item=>item?.missingInputs||item?.output?.missing||[]))];
          if(calculationOutcomes.length&&!calculationOutcomes.some(item=>item?.status==='succeeded'))missing.push('حساب مكتمل من الأداة');
          const warnings=outcomes.filter(item=>item.kind==='market_search'&&item.result?.status!=='succeeded')
            .map(item=>outcomeFailed(item.result)?'تعذر إكمال البحث.':'نتيجة البحث لا تكفي لتأكيد المعلومة.');
          const scenario=calculationOutcomes.some(item=>item?.output?.scenario);
          const status=missing.length?'WAITING_FOR_INPUT':warnings.length||scenario?'PROVISIONAL':'COMPLETE';
          const validation={status,qualityStatus:status,valid:status==='COMPLETE',missing,warnings:[...new Set(warnings)],errors:[]};
          return finishWith(status,processed.reply,processed,validation);
        }
        const validation=validateBusinessPlan(currentPlan,{objective:task.objective,projectFacts:advisor.memory.facts(projectId),
          calculations:outcomes.filter(item=>item.kind==='calculation').map(item=>item.result),research:advisor.memory.research(projectId),authoritativeToolResults:outcomes,
          requiredDeliverables:{financialAnalysis:task.type==='business_plan'}});
        if(currentPlan&&validation.status==='COMPLETE') {
          const reply=processed.reply||currentPlan.body.summary;
          const status=processed.question?'PROVISIONAL':'COMPLETE';
          return finishWith(status,reply,processed,{...validation,status});
        }
        if(processed.question&&!currentPlan)return finishWith('WAITING_FOR_INPUT',processed.reply,processed,{...validation,status:'PROVISIONAL',taskStatus:'WAITING_FOR_INPUT'});
        if(round>=rounds-1) {
          const reply=processed.reply||(currentPlan?currentPlan.body.summary:'');
          const safeStatus=validation.status==='INVALID'||validation.taskStatus==='WAITING_FOR_INPUT'?'WAITING_FOR_INPUT':currentPlan?'PROVISIONAL':'WAITING_FOR_INPUT';
          return finishWith(safeStatus,reply,processed,validation);
        }
        parsed=null;round+=1;
      }
      const latest=processed?.plan||advisor.memory.latestPlan(projectId);
      const validation=validateBusinessPlan(latest,{objective:task.objective,projectFacts:advisor.memory.facts(projectId),
        calculations:outcomes.filter(item=>item.kind==='calculation').map(item=>item.result),research:advisor.memory.research(projectId),authoritativeToolResults:outcomes,
        requiredDeliverables:{financialAnalysis:task.type==='business_plan'}});
      return finishWith('WAITING_FOR_INPUT','المهمة محتاجة معلومة إضافية علشان أكملها بشكل مسؤول.',processed,{...validation,status:'PROVISIONAL',taskStatus:'WAITING_FOR_INPUT'});
    } catch(error) {
      if(error?.code==='TASK_TIMEOUT'||error?.code==='TASK_TOKEN_BUDGET'||error?.code==='TASK_COST_BUDGET'||error?.code==='TASK_DECISION_BUDGET'||error?.code==='TASK_TOOL_BUDGET') {
        const latest=advisor.memory.latestPlan(projectId);
        const status=latest?'PROVISIONAL':'WAITING_FOR_INPUT';
        return finishWith(status,`${error.message}${latest?`\nآخر نسخة محفوظة من الخطة: ${latest.title}، نسخة ${latest.revision}.`:''}`,processed,{status,missing:[error.code]});
      }
      const status=Number(error?.status||error?.statusCode||error?.response?.status||error?.cause?.status||0);
      const message=error?.code==='SEARCH_TIMEOUT'?'بحث السوق اتأخر، وطلبت من فهيمة تقييم النتيجة من غير سعر مؤكد.':status===429?'Gemini رفض الطلب مؤقتًا بعد محاولة محدودة.':'تعذر إكمال خطوة من خطوات المهمة. النتيجة الحالية محفوظة من غير تسجيل أي معاملة.';
      return finishWith('FAILED',message,processed,{status:'FAILED',missing:[error?.code||`provider_${status||'error'}`]});
    }
  }
  return {run};
}

module.exports={createTaskRunner,taskBudget,projectFingerprint,toolOutcome};
