const { normalizeDigits } = require('./finance');
const { labels } = require('./memory');
const terms = {...labels, memory:'معلومات المشروع',JSON:'تفاصيل داخلية',forecast:'تقدير للمستقبل',
  'break-even':'تغطية المصاريف',ROI:'استرجاع الفلوس',workflow:'خطوات الشغل','unit cost':'تكلفة القطعة'};
const phrases=[
  [/ده اقتراح لخطة بديلة[.،؛]?/gu,'دي فكرة تانية ممكنة للمشروع.'],
  [/ومش هيتسجل كمصروف تدفعيه/gu,'ومش هسجله كمصروف اتدفع'],
  [/لن يتم تسجيل هذا كمصروف/gu,'مش هسجله كمصروف'],
  [/مطلوب استكمال البيانات/gu,'محتاج أعرف حاجة واحدة بس'],
  [/يرجى توضيح المبلغ الإجمالي/gu,'المبلغ كله كام؟'],
  [/المدخلات غير كافية/gu,'محتاجين معلومة كمان'],
  [/تمت معالجة الطلب/gu,'خلصت طلبك'],
  [/تم التحقق(?: من البيانات)?/gu,'راجعت البيانات'],
  [/تكلفة الوحدة/gu,'سعر الواحدة'],
  [/سعر الوحدة كام بالجنيه[؟?]?/gu,'سعر الواحدة كام؟'],
  [/تاريخ العملية إيه[؟?]?/gu,'التاريخ إيه؟'],
  [/العملية/gu,'الحركة'],
  [/عملية مالية/gu,'حركة فلوس'],
  [/وحدة الكمية إيه[؟?]?/gu,'بتتقاس بإيه؟'],
  [/العملية دي مش موجودة/gu,'مش لاقي الحركة دي'],
  [/تعذر إكمال بحث السوق دلوقتي/gu,'البحث مش شغال دلوقتي'],
  [/حصلت مشكلة مؤقتة في المساعد\. جرب تاني أو اكتب طلبك بشكل أوضح\./gu,'حصلت مشكلة عندي. جرّب تاني بعد شوية.'],
  [/بدأت أراجع المعلومات والأسعار والحسابات علشان أطلع نتيجة وخطة مناسبة\. هتظهر هنا أول ما تجهز\./gu,'ثانية وهقولك النتيجة.'],
  [/بحث السوق اتأخر، فوقفت الانتظار\./gu,'البحث اتأخر.'],
  [/الحساب الكامل محتاج بيانات مؤكدة أكتر؛ نقدر نبدأ بتقدير واضح الافتراضات أو نجمع عرض سعر بالتكلفة الكاملة\./gu,'الحساب محتاج معلومة كمان.'],
  [/المصدر وتاريخ المراجعة ظاهرين في قسم بحث السوق\./gu,'هتلاقي المصدر وتاريخه تحت.'],
  [/سجل المراجعة/gu,'سجل التعديلات'],
  [/الخطة اجتازت المراجعة\./gu,'راجعت الخطة.'],
  [/الخطة محفوظة كمبدئية مع توضيح ما يحتاج مراجعة\./gu,'حفظت الخطة كبداية، وفيه حاجات لسه محتاجة مراجعة.'],
  [/المهمة محتاجة معلومة من المستخدم\./gu,'محتاج أعرف منك معلومة واحدة.'],
  [/المهمة انتهت بحالة واضحة\./gu,'خلصت مراجعة الطلب.'],
  [/مش هاعرض المهمة على إنها جاهزة/gu,'مش هقول إن النتيجة جاهزة'],
  [/حالة واضحة/gu,'نتيجة واضحة'],
];
function cleanLanguage(text) {
  let result=String(text||'').trim();
  for(const [key,label] of Object.entries(terms)) {
    result=result.replace(new RegExp(`(?<![A-Za-z_])${key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?![A-Za-z_])`,'gi'),label);
  }
  for(const [pattern,replacement] of phrases)result=result.replace(pattern,replacement);
  return result.replace(/يا حبيبتي|يا حبيبي/gu,'').replace(/\s{2,}/g,' ').trim();
}
function simplifyResponse(text) {
  let result=cleanLanguage(text).replace(/\n{3,}/gu,'\n\n');
  const questions=[...result.matchAll(/[؟?]/gu)];
  if(questions.length>1)result=result.slice(0,questions[0].index+1).trim();
  return result;
}
function numbers(value, output=new Set()) {
  if(typeof value==='number'&&Number.isFinite(value))output.add(Math.round(value*100)/100);
  else if(Array.isArray(value))value.forEach(item=>numbers(item,output));
  else if(value&&typeof value==='object')Object.values(value).forEach(item=>numbers(item,output));
  return output;
}
function validateText(text, {facts=[],calculations=[],goals=[],proposals=[],allowQuestion=false}={}) {
  const clean=simplifyResponse(text);
  const reasons=[];
  if(/```|\b(?:SELECT|INSERT|UPDATE|DELETE)\s|\{\s*"|\b\w+_\w+\b|tool_call|function\s*\(/iu.test(clean))reasons.push('internal_syntax');
  if(/(?:المدخلات|قاعدة البيانات|مهمة Gemini|HTTP \d{3}|تمت معالجة الطلب|مطلوب استكمال البيانات)/iu.test(clean))reasons.push('internal_wording');
  if(clean.length>420)reasons.push('too_long');
  if(/(?:ربح|مكسب|استثمار).{0,20}(?:مضمون|أكيد|مؤكد)|(?:مضمون|أكيد).{0,20}(?:ربح|مكسب)|هتكسب أكيد/u.test(clean))reasons.push('guarantee');
  if(/(?:صافي (?:الربح|ربح|المكسب|مكسب)|مكسبك|ربحك).{0,30}[\d٠-٩]/u.test(clean))reasons.push('unsupported_profit');
  if(/(?:السعر الحالي|سعر السوق|السوق دلوقتي).{0,35}[\d٠-٩].{0,10}جنيه/u.test(clean))reasons.push('unverified_market_price');
  if(!allowQuestion&&/[?؟]/u.test(clean))reasons.push('unstructured_question');
  const known=numbers([...facts.map(row=>row.numeric_value),...goals.map(row=>row.target),...calculations.map(row=>row.values),proposals]);
  for(const match of normalizeDigits(clean).matchAll(/(\d[\d,٬]*(?:[.٫]\d+)?)\s*(?:جنيه|جنيها|جنيهًا|%|٪)/gu)) {
    const value=Number(match[1].replace(/[,٬]/g,'').replace('٫','.'));
    if(!known.has(Math.round(value*100)/100))reasons.push('unsupported_number');
  }
  const capital=facts.find(row=>row.key==='capital')?.numeric_value;
  if(capital!=null&&!/(?:لو|افتراض)/u.test(clean))for(const match of normalizeDigits(clean).matchAll(/(?:رأس مالك|رأس المال|المبلغ المتاح)[^\d]{0,25}(\d[\d,٬]*(?:\.\d+)?)/gu)) {
    if(Number(match[1].replace(/[,٬]/g,''))!==capital)reasons.push('contradicts_capital');
  }
  const names=facts.map(row=>row.value).join(' ');
  for(const match of clean.matchAll(/\b[A-Za-z]+(?:\s+[A-Za-z]+){2,}\b/g))if(!names.includes(match[0]))reasons.push('english_sentence');
  return {text:clean,valid:reasons.length===0,reasons:[...new Set(reasons)]};
}
function chooseQuestion(question,facts,previous,changed=[]) {
  if(!question?.text?.trim()||!question.reason?.trim())return null;
  if(question.fact_key&&facts.some(row=>row.key===question.fact_key&&!['ambiguous','hypothetical'].includes(row.certainty)))return null;
  if(previous?.text===question.text&&!changed.length)return null;
  const checked=validateText(question.text,{facts,allowQuestion:true});
  if(!checked.valid || (checked.text.match(/[?؟]/g)||[]).length>1)return null;
  return {...question,text:checked.text};
}
const amount=value=>Number(value).toLocaleString('ar-EG',{maximumFractionDigits:2});
function calculationText(result) {
  if(result.missing?.length)return '';
  const x=result.values;
  const prefix=result.scenario?'ده حساب مبدئي بافتراضات محتاجة مراجعة. ':'';
  const texts={
    budget:()=>`من ${amount(x.budget)} جنيه، نسيب ${amount(x.reserve)} جنيه احتياطي. التقسيم المقترح: ${x.allocations.map(row=>`${cleanLanguage(row.label)} ${amount(row.amount)} جنيه`).join('، ')}.${x.unallocated?` ولسه ${amount(x.unallocated)} جنيه من غير تخصيص.`:''}`,
    purchase:()=>`الحد بالحساب ${amount(x.quantity)} وحدة بتكلفة ${amount(x.cost)} جنيه، ويتبقى ${amount(x.remaining)} جنيه. العدد العملي يتوقف على باقي المصاريف وتجهيز المكان؛ ده مش أمر شراء.`,
    revenue:()=>`بيع ${amount(x.quantity)} وحدة بالسعر ده يجيب ${amount(x.revenue)} جنيه قبل طرح التكاليف. ده مش صافي مكسب.`,
    margin:()=>`بعد تكلفة الوحدة المذكورة، يتبقى ${amount(x.contribution)} جنيه من الوحدة لتغطية باقي المصاريف.`,
    break_even:()=>x.required_quantity==null?'سعر البيع مش بيغطي تكلفة الوحدة، فزيادة الكمية لوحدها مش هتغطي المصاريف.':`حسب التكاليف المذكورة، محتاج بيع ${amount(x.required_quantity)} وحدة لتغطية المصاريف. لازم نتأكد إن كل التكاليف محسوبة.`,
    goal:()=>x.required_quantity==null?'بالسعر والتكلفة دول، الهدف مش متحقق لأن البيع مش بيغطي تكلفة الوحدة.':`للوصول للهدف بالحساب، محتاج بيع ${amount(x.required_quantity)} وحدة في نفس فترة المصاريف والهدف.${x.target_covered===false?' الكمية المتوقعة حاليًا أقل من المطلوب.':''} ده مش ضمان للمكسب؛ لازم نتأكد من الطلب وباقي التكاليف.`,
    cash:()=>`من رصيد نهاية ${x.as_of} والحركات المسجلة بعده، الفلوس المحسوبة ${amount(x.cash_from_records)} جنيه. ده يعتمد على اكتمال التسجيل، ومش صافي مكسب.`,
  };
  return prefix+(texts[result.type]?.()||'');
}
module.exports={cleanLanguage,simplifyResponse,validateText,chooseQuestion,calculationText};
