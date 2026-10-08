const { createMemory } = require('./memory');
const { hypothetical } = require('./planning');
const { normalizeDigits } = require('./finance');
const { createBusinessTools, executeBusinessTool } = require('./business-tools');
const { cleanLanguage,validateText,chooseQuestion,calculationText } = require('./response-quality');
const marketResearch = require('./market-research');
const { diagnostic } = require('./diagnostics');

function researchText(results) {
  const lines=[];
  for(const result of results) {
    if(result.pending)continue;
    if(result.error) {lines.push(Number(result.error)===429
      ?'حاولت أراجع المعلومة من الإنترنت، لكن بحث Gemini وصل لحد الاستخدام مؤقتًا. نقدر نكمل بفرضيات واضحة أو نرجع للبحث بعدين.'
      :result.error==='SEARCH_TIMEOUT'
        ?'بحث السوق اتأخر، فوقفت الانتظار. نقدر نكمل بحساب مشروط بأسعار تحددها أو نعيد البحث بعدين.'
        :'حاولت أراجع المعلومة من الإنترنت، لكن البحث مش متاح دلوقتي. نقدر نكمل بفرضيات واضحة أو نرجع للبحث بعدين.');continue;}
    if(result.cached)continue;
    const selected=result.items?.find(row=>row.selected)||result.items?.find(row=>row.price!=null&&row.source_url);
    if(selected) {
      const quantity=selected.quantity&&selected.unit?` لكل ${selected.quantity} ${selected.unit}`:selected.unit?` لكل ${selected.unit}`:'';
      lines.push(`لقيت سعر منشور لـ${selected.product_name||'البند المطلوب'}: ${Number(selected.price).toLocaleString('ar-EG',{maximumFractionDigits:2})} ${String(selected.currency).toUpperCase()==='EGP'?'جنيه':selected.currency}${quantity}. المصدر وتاريخ المراجعة ظاهرين في قسم بحث السوق. السعر مؤقت ومحتاج تأكيد التوفر والتوصيل قبل الشراء.`);
    } else lines.push('راجعت مصادر على الإنترنت، لكن ملقتش سعرًا واضحًا بنفس الوحدة والمواصفات ينفع ندخله في الحساب. المصادر موجودة للمراجعة، والسعر لسه غير مؤكد.');
  }
  return [...new Set(lines)];
}

function createAdvisor(db,business) {
  const memory=createMemory(db);
  function context(projectId) {
    const facts=memory.facts(projectId);
    const bounds=business.periodBounds('month');
    return {facts,goals:memory.goals(projectId),state:memory.state(projectId),plan:memory.latestPlan(projectId),
      records:{period:bounds,summary:business.getSummary(projectId,bounds.from,bounds.to)},
      knowledge:{market_search_available:true,
        prices:facts.filter(row=>row.kind==='price').map(row=>({key:row.key,value:row.value,numeric_value:row.numeric_value,unit:row.unit,observed_on:row.observed_on,source:row.source,certainty:row.certainty})),
        research:memory.research(projectId).slice(0,20)}};
  }
  async function process(projectId,messageId,message,parsed,options={}) {
    const location=memory.facts(projectId).find(row=>row.key==='location')?.value||null;
    const researchResults=[];
    for(const request of parsed.research_requests||[]) {
      const existing=memory.research(projectId,{freshOnly:true}).find(row=>row.research_key===request.key&&row.selected);
      if(existing){researchResults.push({request,cached:true,items:[existing]});continue;}
      if(options.deferResearch){researchResults.push({request,pending:true,items:[]});continue;}
      try {
        const result=await marketResearch.search(request,{location});
        result.items=memory.saveResearch(projectId,result);
        researchResults.push(result);
        diagnostic('tool.completed',{tool:'market_search',projectId,researchKey:request.key,resultCount:result.items.length});
      } catch(error) {
        researchResults.push({request,error:error?.code||error?.status||'unavailable',items:[]});
        diagnostic('tool.failed',{tool:'market_search',projectId,researchKey:request.key,errorCode:error?.code||error?.status||'unavailable'});
      }
    }
    return db.transaction(()=>{
      const previous=memory.state(projectId);
      let updates=parsed.facts||[];
      // Compatibility with old clients/model responses; new responses use facts[].
      if(parsed.intent==='project_fact'&&parsed.fact_key&&parsed.fact_value&&!updates.length&&!hypothetical(message)&&
        normalizeDigits(message).includes(normalizeDigits(parsed.fact_value))) {
        const numeric=Number(parsed.fact_value);
        updates=[{key:parsed.fact_key,label:'',value:parsed.fact_value,numeric_value:Number.isFinite(numeric)?numeric:null,
          kind:'fact',certainty:'confirmed',unit:null,observed_on:null,evidence:message,correction:false}];
      }
      const applied=memory.applyFacts(projectId,messageId,message,updates);
      const goalsChanged=memory.applyGoals(projectId,messageId,message,parsed.goals||[]);
      const facts=memory.facts(projectId),goals=memory.goals(projectId);
      const tools=createBusinessTools(projectId,{business,message});
      const calculations=[];
      for(const request of parsed.calculations||[]) {
        try {
          const calculation={...executeBusinessTool(tools,'analyze_scenario',{calculation:request}),request,source_message_id:messageId};
          calculations.push(calculation);
          diagnostic('tool.completed',{tool:'analyze_scenario',projectId,calculationId:request.id,calculationType:request.type,valid:!calculation.missing.length});
        } catch(error) {
          calculations.push({id:request.id,type:request.type,missing:['invalid_inputs']});
          diagnostic('tool.failed',{tool:'analyze_scenario',projectId,calculationId:request.id,calculationType:request.type,errorCode:error?.code||'invalid_inputs'});
        }
      }
      // Recalculate stored plan arithmetic after a correction; keep its strategy
      // marked for review, since changing money can also change practical choices.
      const priorPlan=memory.latestPlan(projectId);
      let recomputedPlan=false;
      if((applied.changed.length||goalsChanged)&&!parsed.plan&&!calculations.length&&priorPlan?.body?.calculations?.length) {
        recomputedPlan=true;
        for(const prior of priorPlan.body.calculations) {
          if(!prior.request)continue;
          const sourceId=prior.source_message_id||priorPlan.source_message_id;
          const origin=db.prepare('SELECT m.content FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=? AND c.project_id=?').get(sourceId,projectId);
          const priorTools=createBusinessTools(projectId,{business,message:origin?.content||''});
          try {calculations.push({...executeBusinessTool(priorTools,'analyze_scenario',{calculation:prior.request}),request:prior.request,source_message_id:sourceId});}
          catch {calculations.push({id:prior.id,type:prior.type,missing:['invalid_inputs']});}
        }
      }
      const proposals=(parsed.planned_transactions?.length?parsed.planned_transactions:parsed.transaction_status==='planned'?(parsed.transactions?.length?parsed.transactions:[parsed]):[])
        .map(item=>({type:item.transaction_type,product_name:item.product_name,quantity:item.quantity,unit:item.unit,amount:item.amount,amount_kind:item.amount_kind}));
      const qualityContext={facts:[...facts,...memory.researchFacts(projectId)],calculations,goals,proposals};
      let question=chooseQuestion(parsed.question,facts,previous.pending_question,applied.changed);
      if(applied.conflicts.length) {
        const conflict=applied.conflicts[0];
        question={fact_key:conflict.key,reason:'تصحيح معلومة متعارضة',text:`المعلومة السابقة عن ${cleanLanguage(conflict.label)} هي ${cleanLanguage(conflict.previous)}. المقصود تغييرها إلى ${cleanLanguage(conflict.proposed)}؟`};
      }
      const update=parsed.state_update?{...parsed.state_update}:null;
      if(update)for(const key of ['objective','capability','next_action','progress']) {
        if(update[key]){const checked=validateText(update[key],qualityContext);update[key]=checked.valid?checked.text:null;}
      }
      const state=options.preserveState?memory.state(projectId):memory.saveState(projectId,messageId,update,question);
      for(const result of calculations)result.display=calculationText(result);
      let plan=null;
      if(parsed.transaction_status==='planned'&&!parsed.plan&&['record_transaction','record_transactions'].includes(parsed.intent)) {
        const items=parsed.transactions?.length?parsed.transactions:[parsed];
        parsed.plan={title:'خطوات مقترحة للمشروع',summary:'دي خطوات لسه ما اتنفذتش، وهنراجع تكلفتها ومتطلباتها قبل التنفيذ.',
          requirements:[],assumptions:[],risks:[],indicators:[],proposed_transactions:proposals,next_action:'مراجعة المتطلبات والتكلفة قبل أي شراء.',
          steps:items.map((item,index)=>({key:`planned_${index}`,text:item.description||message,status:'proposed',evidence:null}))};
      }
      const canUpdatePlan=!options.preserveState||memory.state(projectId).source_message_id===messageId;
      if(parsed.plan&&canUpdatePlan&&!calculations.some(row=>row.missing.length)&&!applied.conflicts.length) {
        const texts=[parsed.plan.title,parsed.plan.summary,...parsed.plan.assumptions,...parsed.plan.requirements,...parsed.plan.risks,
          ...parsed.plan.steps.map(step=>step.text),...parsed.plan.indicators,parsed.plan.next_action];
        if(texts.every(text=>validateText(text,qualityContext).valid)) {
          const cleanPlan={...parsed.plan,proposed_transactions:proposals,title:cleanLanguage(parsed.plan.title),summary:cleanLanguage(parsed.plan.summary),
            assumptions:parsed.plan.assumptions.map(cleanLanguage),requirements:parsed.plan.requirements.map(cleanLanguage),risks:parsed.plan.risks.map(cleanLanguage),
            steps:parsed.plan.steps.map(step=>({...step,text:cleanLanguage(step.text)})),indicators:parsed.plan.indicators.map(cleanLanguage),next_action:cleanLanguage(parsed.plan.next_action)};
          plan=memory.savePlan(projectId,messageId,cleanPlan,calculations,message);
        }
      }
      if(recomputedPlan&&calculations.length) {
        plan=memory.savePlan(projectId,messageId,priorPlan.body,calculations,message);
        memory.stalePlans(projectId);
        plan.stale=1;
      }
      const checked=validateText(parsed.answer,qualityContext);
      let reply=checked.valid?checked.text:'';
      const math=calculations.map(calculationText).filter(Boolean);
      if(math.length)reply=[reply,...math].filter(Boolean).join('\n');
      const market=researchText(researchResults);
      if(market.length)reply=[reply,...market].filter(Boolean).join('\n');
      if(plan&&!reply)reply=plan.body.summary;
      if(!reply) {
        const next=validateText(state.next_action,qualityContext);
        reply=next.valid&&next.text?next.text:'نقدر نرتب الخطوة الجاية من المعلومات المتاحة، وأي سعر مش معروف هنسيبه واضح لحد ما نتأكد منه.';
      }
      const pendingResearch=researchResults.filter(row=>row.pending).map(row=>row.request);
      if(pendingResearch.length)reply+='\nبدأت أراجع المعلومة المطلوبة من المصادر، والنتيجة هتظهر هنا لوحدها.';
      else if(calculations.some(row=>row.missing.length))reply+=' الحساب الكامل محتاج بيانات مؤكدة أكتر؛ نقدر نبدأ بتقدير واضح الافتراضات أو نجمع عرض سعر بالتكلفة الكاملة.';
      if(question)reply+=`\n${question.text}`;
      const speech=[reply.split('\n')[0],...math.slice(0,1),question?.text].filter(Boolean);
      return {reply,speechText:[...new Set(speech)].join(' '),calculations,plan,state,research:researchResults,pendingResearch,marketResearchChanged:researchResults.some(row=>!row.cached&&!row.pending&&!row.error),
        factsChanged:applied.changed.length>0||goalsChanged,conflicts:applied.conflicts,qualityIssues:checked.reasons};
    })();
  }
  async function completeResearch(projectId,messageId,message,parsed) {
    const completed=await process(projectId,messageId,message,parsed,{preserveState:true});
    const fresh=completed.research.filter(row=>!row.cached);
    const parts=[...researchText(fresh),...completed.calculations.map(row=>row.display).filter(Boolean)];
    return {...completed,reply:parts.join('\n')||'خلصت مراجعة المصادر، لكن ملقتش معلومة واضحة تنفع ندخلها في الحساب.',
      speechText:parts[0]||'خلصت مراجعة المصادر.'};
  }
  return {context,process,completeResearch,memory};
}
module.exports={createAdvisor};
