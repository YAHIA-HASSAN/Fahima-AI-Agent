const { validDate } = require('./finance');
const { quoted, hypothetical } = require('./planning');
const labels = {
  capital:'المبلغ المتاح لبداية المشروع',starting_capital:'المبلغ اللي بدأ بيه المشروع',available_cash:'الفلوس المتاحة دلوقتي',
  opening_cash:'رصيد الفلوس في نهاية اليوم المذكور',total_invested:'إجمالي الفلوس اللي اتحطت في المشروع',obligations:'فلوس مطلوب دفعها',
  activity:'نوع النشاط',products:'المنتجات أو الخدمات',costs:'مصاريف الشغل',sales_method:'طريقة البيع',household_use:'استخدام دخل المشروع للبيت',
  project_status:'وضع المشروع',location:'مكان المشروع',experience:'الخبرة',space:'المكان المتاح',
};
const profileFields = new Set(['capital','activity','products','costs','sales_method','household_use']);
const financialKeys = new Set(['capital','starting_capital','available_cash','opening_cash','total_invested','obligations']);
function factLabel(row) { return labels[row.key] || row.label || 'معلومة عن المشروع'; }
function createMemory(db) {
  function facts(projectId) {
    const seen=new Set();
    return db.prepare('SELECT * FROM project_facts WHERE project_id=? ORDER BY updated_at DESC,id DESC').all(projectId)
      .filter(row=>{if(seen.has(row.key))return false;seen.add(row.key);return true;})
      .map(row=>({...row,label:factLabel(row)}));
  }
  function state(projectId) {
    const row=db.prepare('SELECT * FROM advisor_state WHERE project_id=?').get(projectId);
    return row?{...row,pending_question:row.pending_question?JSON.parse(row.pending_question):null,progress:JSON.parse(row.progress)}:
      {objective:'',capability:'',next_action:'',pending_question:null,progress:[]};
  }
  function goals(projectId) {return db.prepare('SELECT * FROM business_goals WHERE project_id=? ORDER BY updated_at DESC,id DESC').all(projectId);}
  function latestPlan(projectId) {
    const row=db.prepare('SELECT * FROM business_plans WHERE project_id=? ORDER BY revision DESC LIMIT 1').get(projectId);
    return row?{...row,body:JSON.parse(row.body)}:null;
  }
  function experience(projectId) {
    const outcomes=db.prepare(`SELECT o.*,p.title AS plan_title FROM plan_outcomes o JOIN business_plans p ON p.id=o.plan_id
      WHERE o.project_id=? ORDER BY o.created_at DESC,o.id DESC LIMIT 12`).all(projectId).map(row=>({...row,
        planned:JSON.parse(row.planned_json),actual:JSON.parse(row.actual_json)}));
    const revisions=db.prepare('SELECT revision,title,change_reason,created_at FROM business_plans WHERE project_id=? ORDER BY revision DESC LIMIT 6').all(projectId);
    return {outcomes,revisions};
  }
  function stalePlans(projectId) {db.prepare('UPDATE business_plans SET stale=1 WHERE project_id=?').run(projectId);}
  function research(projectId,{freshOnly=false}={}) {
    const now=new Date().toISOString();
    const rows=db.prepare('SELECT * FROM market_research WHERE project_id=? ORDER BY retrieved_at DESC,id DESC').all(projectId)
      .map(row=>{
        const age=row.observed_on?Date.now()-Date.parse(`${row.observed_on}T00:00:00Z`):Infinity;
        const expired=row.valid_until<now||(row.price!=null&&(!Number.isFinite(age)||age>30*86400000||age< -86400000));
        return {...row,stale:expired};
      });
    return freshOnly?rows.filter(row=>!row.stale):rows;
  }
  function researchFacts(projectId) {
    const seen=new Set();
    return research(projectId,{freshOnly:true}).filter(row=>row.selected&&row.price!=null&&String(row.currency||'').toUpperCase()==='EGP'&&row.source_url?.startsWith('https://')&&(row.unit||row.normalized_unit))
      .filter(row=>{if(seen.has(row.research_key))return false;seen.add(row.research_key);return true;})
      .map(row=>({key:`market:${row.research_key}`,label:row.product_name||row.research_key,value:String(row.normalized_price??row.price),
        numeric_value:row.normalized_price??row.price,unit:row.normalized_unit||row.unit,kind:'price',certainty:'approximate',
        observed_on:row.observed_on||row.retrieved_at.slice(0,10),source:'web',source_url:row.source_url,retrieved_at:row.retrieved_at,valid_until:row.valid_until}));
  }
  function saveResearch(projectId,result) {
    if(!result?.request?.key)return [];
    db.prepare('UPDATE market_research SET selected=0 WHERE project_id=? AND research_key=?').run(projectId,result.request.key);
    const insert=db.prepare(`INSERT INTO market_research(project_id,research_key,query,purpose,product_name,specification,description,price,currency,quantity,unit,normalized_price,normalized_unit,seller,source_title,source_url,source_kind,observed_on,retrieved_at,valid_until,location,confidence,availability,delivery_cost,total_cost,selected,raw_excerpt,provider,validation_status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const normalize=value=>String(value||'').toLocaleLowerCase('ar-EG').replace(/[\s\u0640]/gu,'').trim();
    const requested=result.request;
    const now=Date.now();
    const isUsable=row=>{
      if(row.price==null||String(row.currency||'').toUpperCase()!=='EGP'||!String(row.source_url||'').startsWith('https://')||!row.unit&&!row.normalized_unit||!row.observed_on)return false;
      const observed=Date.parse(`${row.observed_on}T00:00:00Z`);
      if(!Number.isFinite(observed)||now-observed>30*86400000||observed>now+86400000)return false;
      if(row.confidence==='low'||!['published_offer','market_estimate'].includes(row.source_kind)||!String(row.source_title||row.seller||'').trim())return false;
      const askedProduct=normalize(requested?.product_name),foundProduct=normalize(row.product_name);
      if(askedProduct&&(!foundProduct||!askedProduct.includes(foundProduct)&&!foundProduct.includes(askedProduct)))return false;
      const askedSpec=normalize(requested?.specification),foundSpec=normalize(row.specification);
      if(askedSpec&&!foundSpec.includes(askedSpec))return false;
      const askedUnit=normalize(requested?.unit),foundUnit=normalize(row.normalized_unit||row.unit);
      if(askedUnit&&askedUnit!==foundUnit)return false;
      const askedLocation=normalize(requested?.location),foundLocation=normalize(row.location);
      if(askedLocation&&askedLocation!=='مصر'&&(!foundLocation||!foundLocation.includes(askedLocation)&&!askedLocation.includes(foundLocation)))return false;
      return true;
    };
    const usable=(result.items||[]).findIndex(isUsable);
    for(const [index,row] of (result.items||[]).entries())insert.run(projectId,row.research_key,row.query,row.purpose,row.product_name,row.specification,row.description,row.price,row.currency,row.quantity,row.unit,row.normalized_price,row.normalized_unit,row.seller,row.source_title,row.source_url,row.source_kind,row.observed_on,row.retrieved_at,row.valid_until,row.location,row.confidence,row.availability,row.delivery_cost,row.total_cost,index===usable?1:0,row.raw_excerpt,result.provider||'gemini',index===usable?'accepted_for_planning':String(row.validation_status||'unverified').slice(0,60));
    if((result.items||[]).length)stalePlans(projectId);
    return research(projectId).filter(row=>row.retrieved_at===result.retrieved_at&&row.research_key===result.request.key);
  }
  function applyFacts(projectId,messageId,message,updates) {
    const changed=[],conflicts=[];
    const origin=db.prepare('SELECT m.id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=? AND c.project_id=? AND m.role=\'user\'').get(messageId,projectId);
    if(!origin)throw new Error('مصدر المعلومة مش موجود في المشروع.');
    for(const input of updates||[]) {
      if(!input.key.trim() || !input.value.trim() || !quoted(input.evidence,message) || ['hypothetical','ambiguous'].includes(input.certainty) || hypothetical(input.evidence))continue;
      // A hypothetical message must never silently alter actual financial facts.
      if(hypothetical(message)&&financialKeys.has(input.key))continue;
      if(input.observed_on&&!validDate(input.observed_on))throw new Error('تاريخ المعلومة محتاج توضيح.');
      if(financialKeys.has(input.key)&&(input.numeric_value==null||input.numeric_value<0))throw new Error('المبلغ محتاج توضيح.');
      const value=financialKeys.has(input.key)?String(input.numeric_value):input.value.trim();
      const old=facts(projectId).find(row=>row.key===input.key);
      if(old&&old.value===value&&old.numeric_value===input.numeric_value&&old.certainty===input.certainty&&old.unit===input.unit&&(!input.observed_on||old.observed_on===input.observed_on))continue;
      if(old&&!input.correction&&!(input.kind==='price'&&input.observed_on&&input.observed_on>=(old.observed_on||''))) {
        conflicts.push({key:input.key,label:factLabel(old),previous:old.value,proposed:value});continue;
      }
      if(old)db.prepare('INSERT INTO fact_history(project_id,fact_key,snapshot,source_message_id) VALUES(?,?,?,?)').run(projectId,input.key,JSON.stringify(old),messageId);
      db.prepare('DELETE FROM project_facts WHERE project_id=? AND key=?').run(projectId,input.key);
      db.prepare(`INSERT INTO project_facts(project_id,key,value,label,kind,certainty,numeric_value,unit,observed_on,source_message_id,source,revision)
        VALUES(?,?,?,?,?,?,?,?,?,?,'user',?)`).run(projectId,input.key,value,labels[input.key]||input.label,input.kind,input.certainty,input.numeric_value,input.unit,input.observed_on,messageId,(old?.revision||0)+1);
      if(profileFields.has(input.key))db.prepare(`UPDATE projects SET ${input.key}=? WHERE id=?`).run(input.key==='capital'?input.numeric_value:value,projectId);
      changed.push(input.key);
    }
    if(changed.length)stalePlans(projectId);
    return {changed,conflicts};
  }
  function applyGoals(projectId,messageId,message,updates) {
    let changed=false;
    for(const goal of updates||[]) {
      if(!quoted(goal.evidence,message)||hypothetical(goal.evidence)||hypothetical(message)||!goal.key.trim()||!goal.title.trim())continue;
      const old=db.prepare('SELECT * FROM business_goals WHERE project_id=? AND goal_key=?').get(projectId,goal.key);
      if(old&&!goal.correction)continue;
      if(goal.target!=null&&goal.target<0)throw new Error('الهدف المالي محتاج توضيح.');
      db.prepare(`INSERT INTO business_goals(project_id,goal_key,title,target,unit,horizon,status,source_message_id) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(project_id,goal_key) DO UPDATE SET title=excluded.title,target=excluded.target,unit=excluded.unit,horizon=excluded.horizon,status=excluded.status,source_message_id=excluded.source_message_id,updated_at=datetime('now')`)
        .run(projectId,goal.key,goal.title,goal.target,goal.unit,goal.horizon,goal.status,messageId);
      changed=true;
    }
    if(changed)stalePlans(projectId);
    return changed;
  }
  function saveState(projectId,messageId,update,question) {
    const previous=state(projectId);
    const next={...previous};
    if(update && update.mode!=='interrupt') {
      if(update.mode!=='resume'&&update.objective)next.objective=update.objective;
      if(update.capability)next.capability=update.capability;
      if(update.next_action)next.next_action=update.next_action;
      if(update.progress&&!next.progress.includes(update.progress))next.progress=[...next.progress,update.progress].slice(-12);
      next.pending_question=question;
    } else if(!update && question)next.pending_question=question;
    db.prepare(`INSERT INTO advisor_state(project_id,objective,capability,next_action,pending_question,progress,source_message_id) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET objective=excluded.objective,capability=excluded.capability,next_action=excluded.next_action,pending_question=excluded.pending_question,progress=excluded.progress,source_message_id=excluded.source_message_id,updated_at=datetime('now')`)
      .run(projectId,next.objective,next.capability,next.next_action,next.pending_question?JSON.stringify(next.pending_question):null,JSON.stringify(next.progress),messageId);
    return next;
  }
  function savePlan(projectId,messageId,plan,calculations,message) {
    const previous=latestPlan(projectId);
    const steps=plan.steps.map(step=>({...step,status:step.status==='completed'&&!quoted(step.evidence,message)&&
      !previous?.body.steps.some(old=>old.key===step.key&&old.text===step.text&&old.status==='completed')?'proposed':step.status}));
    const body={...plan,steps,calculations};
    if(previous&&!previous.stale&&JSON.stringify(previous.body)===JSON.stringify(body))return previous;
    const revision=(previous?.revision||0)+1;
    const result=db.prepare('INSERT INTO business_plans(project_id,revision,title,body,source_message_id,change_reason) VALUES(?,?,?,?,?,?)')
      .run(projectId,revision,plan.title,JSON.stringify(body),messageId,previous?String(message||'').slice(0,500):'إنشاء الخطة الأولى');
    return {...db.prepare('SELECT * FROM business_plans WHERE id=? AND project_id=?').get(result.lastInsertRowid,projectId),body};
  }
  function setPlanValidation(projectId,planId,validation) {
    const row=db.prepare('SELECT body FROM business_plans WHERE id=? AND project_id=?').get(planId,projectId);
    if(!row)return false;
    const status=['COMPLETE','PROVISIONAL','FAILED','INVALID'].includes(validation?.status)?validation.status:'PROVISIONAL';
    const body=JSON.parse(row.body);body.validation={status,valid:status==='COMPLETE',missing:[...(validation?.missing||[])]};
    db.prepare('UPDATE business_plans SET status=?,body=? WHERE id=? AND project_id=?').run(status,JSON.stringify(body),planId,projectId);
    return true;
  }
  return {facts,state,goals,latestPlan,experience,stalePlans,research,researchFacts,saveResearch,applyFacts,applyGoals,saveState,savePlan,setPlanValidation};
}
module.exports = {createMemory,factLabel,labels};
