const { normalizeDigits } = require('./finance');

function numbers(value, output=new Set()) {
  if(typeof value==='number'&&Number.isFinite(value))output.add(Math.round(value*100)/100);
  else if(Array.isArray(value))value.forEach(item=>numbers(item,output));
  else if(value&&typeof value==='object')Object.values(value).forEach(item=>numbers(item,output));
  return output;
}

function validateResponse(text, {facts=[],calculations=[],goals=[],proposals=[],allowQuestion=false}={}) {
  const response=String(text||'').trim();
  const reasons=[];
  if(/```|\b(?:SELECT|INSERT|UPDATE|DELETE)\s|\{\s*"|\b\w+_\w+\b|tool_call|function\s*\(/iu.test(response))reasons.push('internal_syntax');
  if(/(?:ربح|مكسب|استثمار).{0,20}(?:مضمون|أكيد|مؤكد)|(?:مضمون|أكيد).{0,20}(?:ربح|مكسب)|هتكسب أكيد/u.test(response))reasons.push('guarantee');
  if(/(?:صافي (?:الربح|ربح|المكسب|مكسب)|مكسبك|ربحك).{0,30}[\d٠-٩]/u.test(response))reasons.push('unsupported_profit');
  if(/(?:السعر الحالي|سعر السوق|السوق دلوقتي).{0,35}[\d٠-٩].{0,10}جنيه/u.test(response))reasons.push('unverified_market_price');
  const questionCount=(response.match(/[؟?]/gu)||[]).length;
  if(questionCount>1)reasons.push('multiple_questions');
  if(!allowQuestion&&questionCount)reasons.push('unstructured_question');
  const known=numbers([...facts.map(row=>row.numeric_value),...goals.map(row=>row.target),...calculations.map(row=>row.values),proposals]);
  for(const match of normalizeDigits(response).matchAll(/(\d[\d,٬]*(?:[.٫]\d+)?)\s*(?:جنيه|جنيها|جنيهًا|%|٪)/gu)) {
    const value=Number(match[1].replace(/[,٬]/g,'').replace('٫','.'));
    if(!known.has(Math.round(value*100)/100))reasons.push('unsupported_number');
  }
  const capital=facts.find(row=>row.key==='capital')?.numeric_value;
  if(capital!=null&&!/(?:لو|افتراض)/u.test(response))for(const match of normalizeDigits(response).matchAll(/(?:رأس مالك|رأس المال|المبلغ المتاح)[^\d]{0,25}(\d[\d,٬]*(?:\.\d+)?)/gu)) {
    if(Number(match[1].replace(/[,٬]/g,''))!==capital)reasons.push('contradicts_capital');
  }
  return {text:response,valid:reasons.length===0,reasons:[...new Set(reasons)]};
}

function chooseQuestion(question,facts,previous,changed=[]) {
  if(!question?.text?.trim()||!question.reason?.trim())return null;
  if(question.fact_key&&facts.some(row=>row.key===question.fact_key&&!['ambiguous','hypothetical'].includes(row.certainty)))return null;
  if(previous?.text===question.text&&!changed.length)return null;
  const checked=validateResponse(question.text,{facts,allowQuestion:true});
  return checked.valid?{...question,text:checked.text}:null;
}

module.exports={validateResponse,chooseQuestion};
