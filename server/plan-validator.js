const { normalizeDigits } = require('./finance');

function resultOutput(result) { return result?.output || result?.result || result || {}; }
function resultStatus(result) {
  if(result?.status)return result.status;
  if(result?.result?.status)return result.result.status;
  const output=resultOutput(result);
  if(result?.error||output?.error)return 'terminal_failure';
  if(output?.missing?.length||output?.missingInputs?.length)return 'insufficient_data';
  return output?.values&&Object.keys(output.values).length?'succeeded':'insufficient_data';
}
function numericLeaves(value,prefix='',rows=[]) {
  if(typeof value==='number'&&Number.isFinite(value)){rows.push([prefix,value]);return rows;}
  if(Array.isArray(value)){value.forEach((item,index)=>numericLeaves(item,`${prefix}[${index}]`,rows));return rows;}
  if(value&&typeof value==='object')for(const [key,item] of Object.entries(value))numericLeaves(item,prefix?`${prefix}.${key}`:key,rows);
  return rows;
}
function sameNumber(a,b) { return Math.abs(Number(a)-Number(b))<0.011; }
function numericClaims(text) {
  const rows=[];
  const pattern=/([0-9٠-٩۰-۹][0-9٠-٩۰-۹,٬]*(?:[.٫][0-9٠-٩۰-۹]+)?)\s*(جنيه(?:ًا|ات)?|EGP|كجم|كيلو(?:جرام)?|طن|لتر|كيس|طائر|كتكوت|دجاجة|قطعة|وحدة|متر|فدان|رأس)/giu;
  for(const match of String(text||'').matchAll(pattern)) {
    const value=Number(normalizeDigits(match[1]).replace(/[,٬]/gu,'').replace('٫','.'));
    if(Number.isFinite(value))rows.push({value,claim:match[0]});
  }
  return rows;
}
function makeResult(status,missing,errors=[],warnings=[]) {
  return {status,qualityStatus:status,valid:status==='COMPLETE',missing:[...new Set(missing)],errors:[...new Set(errors)],warnings:[...new Set(warnings)]};
}

/**
 * Validate a plan against authoritative server tool results. The positional
 * signature is retained for existing callers; new callers should pass an
 * options object as the second argument.
 */
function validateBusinessPlan(plan, calculations=[], research=[], options={}) {
  if(!Array.isArray(calculations)&&calculations&&typeof calculations==='object') {
    options=calculations;
    calculations=options.calculations||[];
    research=options.research||[];
  }
  const objective=String(options.objective||'').trim();
  const body=plan?.body||plan||{};
  const missing=[],errors=[],warnings=[];
  const requiredDeliverables=options.requiredDeliverables||{};
  const requireFinancial=Boolean(options.requireFinancial||requiredDeliverables.financialAnalysis);
  const useful=Boolean(String(body.summary||'').trim()&&Array.isArray(body.steps)&&body.steps.some(step=>String(step?.text||'').trim()));
  if(!String(plan?.title||body.title||'').trim())missing.push('عنوان الخطة');
  if(!String(body.summary||'').trim())missing.push('ملخص قابل للتنفيذ');
  if(!Array.isArray(body.steps)||!body.steps.some(step=>String(step?.text||'').trim()))missing.push('خطوات التنفيذ');
  if(!Array.isArray(body.risks)||!body.risks.length)missing.push('مراجعة المخاطر');
  if(!Array.isArray(body.assumptions)||!body.assumptions.length)missing.push('توضيح الافتراضات');
  if(!Array.isArray(body.requirements)||!body.requirements.length)missing.push('متطلبات المشروع');
  if(!Array.isArray(body.sources))missing.push('توثيق مصادر الخطة');
  if(plan?.stale)missing.push('تحديث الخطة بعد تغير البيانات');

  const authoritative=options.authoritativeToolResults||[];
  const authoritativeCalculations=authoritative.filter(row=>row.tool==='analyze_scenario'||row.kind==='calculation').map(row=>({
    result:row.output||row.result||row, status:row.status||resultStatus(row.result||row), invocationId:row.invocationId||row.result?.invocationId,
  }));
  const calcResults=authoritativeCalculations.length?authoritativeCalculations:calculations.map(row=>({result:row,status:resultStatus(row),invocationId:row.id}));
  const usableCalculations=calcResults.filter(row=>row.status==='succeeded'&&resultOutput(row.result).values&&
    Object.keys(resultOutput(row.result).values).length&&!(resultOutput(row.result).missing||resultOutput(row.result).missingInputs||[]).length);
  const incompleteCalculations=calcResults.filter(row=>row.status!=='succeeded');
  const criticalMissing=[];
  for(const row of incompleteCalculations) {
    const output=resultOutput(row.result);
    for(const item of output.missing||output.missingInputs||[])criticalMissing.push(`مدخل الحساب: ${item}`);
    if(row.status==='recoverable_failure'||row.status==='terminal_failure')criticalMissing.push('إعادة تنفيذ الحساب والتحقق من نتيجته');
  }
  if(requireFinancial&&!usableCalculations.length) {
    if(calcResults.length)criticalMissing.push(...(criticalMissing.length?[]:['حساب مالي مكتمل من أداة الحساب']));
    else criticalMissing.push('حساب مالي مكتمل من أداة الحساب');
  }
  missing.push(...criticalMissing);

  // The plan may describe server results, but it cannot replace or contradict them.
  if(usableCalculations.length&&Array.isArray(body.calculations)) {
    const trustedById=new Map(usableCalculations.map(row=>{const output=resultOutput(row.result);return [String(output.id||row.invocationId||''),output];}));
    for(const claimed of body.calculations) {
      const trusted=trustedById.get(String(claimed?.id||''));
      if(!trusted) { errors.push(`حساب غير موثق: ${claimed?.id||'بدون معرّف'}`); continue; }
      const actual=numericLeaves(trusted.values), claimedValues=numericLeaves(claimed.values);
      for(const [key,value] of claimedValues) {
        const match=actual.find(([actualKey])=>actualKey===key);
        if(!match||!sameNumber(value,match[1]))errors.push(`قيمة حساب غير متطابقة: ${key}`);
      }
    }
  }
  if(requireFinancial&&usableCalculations.some(row=>resultOutput(row.result).scenario||
    (resultOutput(row.result).sources||[]).some(source=>['hypothetical','approximate','user_provided'].includes(source.certainty)))) {
    warnings.push('التحليل المالي يعتمد على افتراض أو تقدير معلن.');
  }

  const selectedPrices=research.filter(row=>row.selected&&row.price!=null);
  const knownSourceUrls=new Set(research.map(row=>row.source_url).filter(Boolean));
  for(const source of body.sources||[])if(source?.url&&!knownSourceUrls.has(source.url))errors.push(`مصدر غير موجود في نتائج البحث: ${source.title||source.url}`);
  for(const price of selectedPrices) {
    if(!price.source_url||!price.unit&&!price.normalized_unit||price.stale||price.valid_until&&Date.parse(price.valid_until)<Date.now())
      warnings.push(`سعر يحتاج تحقق: ${price.product_name||price.research_key}`);
  }
  for(const row of authoritative.filter(item=>item.tool==='market_search'||item.kind==='market_search')) {
    const status=row.status||resultStatus(row.result||row),key=row.input?.key||row.result?.input?.key||row.key||'بحث السوق';
    if(!['succeeded','insufficient_data'].includes(status))warnings.push(`تعذر التحقق من البحث: ${key}`);
    if(status==='insufficient_data')warnings.push(`نتيجة البحث لا تحتوي معلومة كافية: ${key}`);
  }
  const facts=options.projectFacts||[];
  if(facts.some(fact=>fact.certainty==='confirmed'&&fact.kind==='constraint'&&fact.violated===true))errors.push('الخطة تخالف قيدًا مؤكدًا للمشروع.');

  const trustedNumbers=new Set();
  for(const fact of facts)if(fact.numeric_value!=null)trustedNumbers.add(Number(fact.numeric_value));
  for(const row of usableCalculations)for(const [,value] of numericLeaves(resultOutput(row.result).values))trustedNumbers.add(Number(value));
  for(const row of selectedPrices)for(const key of ['price','normalized_price','quantity','normalized_price'])if(Number.isFinite(Number(row[key]))&&row[key]!=null)trustedNumbers.add(Number(row[key]));
  const assumptions=(body.assumptions||[]).join(' ');
  const proposedReserve=usableCalculations.some(row=>{
    const output=resultOutput(row.result);
    return output.values?.reserve!=null&&(output.sources||[]).some(source=>source.label==='reserve'&&source.certainty==='hypothetical');
  });
  if(proposedReserve&&!/احتياط/u.test(assumptions))warnings.push('قيمة الاحتياطي تقدير مقترح ويجب توضيح أساسه في الافتراضات.');
  for(const field of [body.title,body.summary,...(body.requirements||[]),...(body.risks||[]),...(body.indicators||[]),body.next_action,...(body.steps||[]).map(step=>step?.text)]) {
    for(const claim of numericClaims(field))if(![...trustedNumbers].some(value=>sameNumber(value,claim.value))&&!numericClaims(assumptions).some(item=>sameNumber(item.value,claim.value)))
      errors.push(`رقم غير مدعوم في الخطة: ${claim.claim}`);
  }
  for(const claim of numericClaims(assumptions))if(![...trustedNumbers].some(value=>sameNumber(value,claim.value)))warnings.push(`افتراض رقمي يحتاج تأكيدًا: ${claim.claim}`);

  const uniqueMissing=[...new Set(missing)],uniqueErrors=[...new Set(errors)],uniqueWarnings=[...new Set(warnings)];
  if(uniqueErrors.length)return {...makeResult('INVALID',uniqueMissing,uniqueErrors,uniqueWarnings),useful};
  if(!useful&&objective)return {...makeResult('PROVISIONAL',uniqueMissing,[],uniqueWarnings),useful,taskStatus:'WAITING_FOR_INPUT'};
  if(criticalMissing.length)return {...makeResult('PROVISIONAL',uniqueMissing,[],uniqueWarnings),useful,taskStatus:'WAITING_FOR_INPUT'};
  if(uniqueMissing.length||uniqueWarnings.length||plan?.stale||usableCalculations.some(row=>resultOutput(row.result).scenario))
    return {...makeResult('PROVISIONAL',uniqueMissing,[],uniqueWarnings),useful};
  return {...makeResult('COMPLETE',[],[],[]),useful};
}

module.exports={validateBusinessPlan};
