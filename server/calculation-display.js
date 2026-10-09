// A structured dashboard display for validated arithmetic. This is not a chat reply.
const amount=value=>Number(value).toLocaleString('ar-EG',{maximumFractionDigits:2});
function calculationDisplay(result) {
  if(result.missing?.length)return '';
  const x=result.values;
  const texts={
    budget:()=>`من ${amount(x.budget)} جنيه، الاحتياطي المقترح ${amount(x.reserve)} جنيه. التقسيم: ${x.allocations.map(row=>`${row.label} ${amount(row.amount)} جنيه`).join('، ')}.${x.unallocated?` متبقي ${amount(x.unallocated)} جنيه من غير تخصيص.`:''}`,
    purchase:()=>`الحساب يسمح بـ${amount(x.quantity)} وحدة بتكلفة ${amount(x.cost)} جنيه، ويتبقى ${amount(x.remaining)} جنيه. ده تقدير حسابي، مش أمر شراء.`,
    revenue:()=>`بيع ${amount(x.quantity)} وحدة بالسعر ده يساوي ${amount(x.revenue)} جنيه قبل طرح التكاليف. ده مش صافي مكسب.`,
    margin:()=>`بعد تكلفة الوحدة المذكورة، يتبقى ${amount(x.contribution)} جنيه من الوحدة لتغطية باقي المصاريف.`,
    break_even:()=>x.required_quantity==null?'سعر البيع أقل من تكلفة الوحدة؛ زيادة الكمية وحدها مش هتغطي المصاريف.':`حسب التكاليف المذكورة، يلزم بيع ${amount(x.required_quantity)} وحدة لتغطية المصاريف.`,
    goal:()=>x.required_quantity==null?'بالسعر والتكلفة دول، البيع مش بيغطي تكلفة الوحدة.':`للوصول للهدف حسابيًا، يلزم بيع ${amount(x.required_quantity)} وحدة في نفس الفترة.${x.target_covered===false?' الكمية المتوقعة أقل من المطلوب.':''}`,
    cash:()=>`حسب الرصيد والحركات المسجلة، الفلوس المتبقية ${amount(x.cash_from_records)} جنيه. ده مش صافي مكسب.`,
  };
  return (result.scenario?'ده تقدير مبني على افتراضات. ':'')+(texts[result.type]?.()||'');
}
module.exports={calculationDisplay};
