const { createMemory } = require('./memory');
const { hypothetical } = require('./planning');
const { normalizeDigits } = require('./finance');
const { createBusinessTools, executeBusinessTool } = require('./business-tools');
const { validateResponse,chooseQuestion } = require('./response-validator');
const { calculationDisplay } = require('./calculation-display');
const marketResearch = require('./market-research');
const { diagnostic } = require('./diagnostics');

function createAdvisor(db,business) {
  const memory=createMemory(db,business);
  function context(projectId) {
    const facts=memory.facts(projectId);
    const bounds=business.periodBounds('month');
    return {facts,goals:memory.goals(projectId),state:memory.state(projectId),plan:memory.latestPlan(projectId),experience:memory.experience(projectId),
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
      const update=parsed.state_update?{...parsed.state_update}:null;
      if(update)for(const key of ['objective','capability','next_action','progress']) {
        if(update[key]){const checked=validateResponse(update[key],qualityContext);update[key]=checked.valid?checked.text:null;}
      }
      const state=options.preserveState?memory.state(projectId):memory.saveState(projectId,messageId,update,question);
      for(const result of calculations)result.display=calculationDisplay(result);
      let plan=null;
      const canUpdatePlan=!options.preserveState||memory.state(projectId).source_message_id===messageId;
      if(parsed.plan&&canUpdatePlan&&!applied.conflicts.length) {
        const texts=[parsed.plan.title,parsed.plan.summary,...parsed.plan.assumptions,...parsed.plan.requirements,...parsed.plan.risks,
          ...parsed.plan.steps.map(step=>step.text),...parsed.plan.indicators,parsed.plan.next_action];
        if(texts.every(text=>validateResponse(text,qualityContext).valid)) {
          const sources=memory.research(projectId).filter(row=>row.selected).slice(0,20).map(row=>({title:row.source_title,url:row.source_url,kind:row.source_kind,
            product:row.product_name,specification:row.specification,price:row.price,currency:row.currency,unit:row.normalized_unit||row.unit,
            observed_on:row.observed_on,retrieved_at:row.retrieved_at,valid_until:row.valid_until,location:row.location,confidence:row.confidence,stale:row.stale}));
          const cleanPlan={...parsed.plan,proposed_transactions:proposals,sources,project_facts:facts.map(row=>({key:row.key,label:row.label,value:row.value,certainty:row.certainty,unit:row.unit}))};
          plan=memory.savePlan(projectId,messageId,cleanPlan,calculations,message);
        }
      }
      if(recomputedPlan&&calculations.length) {
        plan=memory.savePlan(projectId,messageId,priorPlan.body,calculations,message);
        memory.stalePlans(projectId);
        plan.stale=1;
      }
      const checked=validateResponse(parsed.answer,qualityContext);
      const next=validateResponse(state.next_action,qualityContext);
      const reply=checked.valid&&checked.text?checked.text:question?.text||(plan?.body?.summary||'')||(next.valid?next.text:'')||'مش قادر أطلع رد موثوق من المعلومات الحالية.';
      const pendingResearch=researchResults.filter(row=>row.pending).map(row=>row.request);
      return {reply,speechText:reply,calculations,plan,state,research:researchResults,pendingResearch,marketResearchChanged:researchResults.some(row=>!row.cached&&!row.pending&&!row.error),
        factsChanged:applied.changed.length>0||goalsChanged,conflicts:applied.conflicts,qualityIssues:checked.reasons};
    })();
  }
  return {context,process,memory};
}
module.exports={createAdvisor};
