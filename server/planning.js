const { normalizeDigits } = require('./finance');
const money = value => Math.round((value + Number.EPSILON) * 100) / 100;
const normalize = value => normalizeDigits(String(value || '')).replace(/\s+/g,' ').trim();
function quoted(evidence, message) {
  return Boolean(normalize(evidence) && normalize(message).includes(normalize(evidence)));
}
function hypothetical(text) {
  return /(?:^|\s)(?:لو|افرض|افترضي|نفترض|فرضًا|فرضاً|مثلا|مثلاً|مثال)(?:\s|$)/u.test(String(text));
}
function calculate(request, { facts = [], message = '', cashRows = [] } = {}) {
  const missing = [];
  const sources = [];
  let scenario = false;
  function read(name, optional = false) {
    const input = request[name];
    if (!input) { if (!optional) missing.push(name); return null; }
    let value;
    if (input.fact_key) {
      const fact = facts.find(row => row.key === input.fact_key && ['confirmed','approximate'].includes(row.certainty));
      if (!fact || fact.numeric_value == null) { missing.push(input.fact_key); return null; }
      value = fact.numeric_value;
      sources.push({ key:fact.key,label:fact.label,certainty:fact.certainty,observed_on:fact.observed_on,source:fact.source });
      if (fact.certainty === 'approximate' || fact.kind === 'price') scenario = true;
    } else if (input.basis === 'assumption') {
      value = input.value;
      scenario = true;
      sources.push({ label:name,certainty:'hypothetical',value });
    } else if (input.basis === 'user' && quoted(input.evidence,message)) {
      value = input.value;
      if (hypothetical(input.evidence) || hypothetical(message)) scenario = true;
      sources.push({label:name,certainty:'user_provided',evidence:input.evidence});
    } else { missing.push(name); return null; }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e12) throw new Error('قيمة الحساب محتاجة مراجعة.');
    return value;
  }
  let values = {};
  if (request.type === 'budget') {
    const budget = read('budget');
    const reserve = read('reserve');
    const lines = request.lines || [];
    if (!lines.length) missing.push('allocation');
    if (missing.length) return {id:request.id,type:request.type,missing};
    if (reserve > budget) throw new Error('المبلغ الاحتياطي أكبر من الفلوس المتاحة.');
    let available = Math.round((budget-reserve)*100);
    const allocations = [];
    const weighted = [];
    for (const line of lines) {
      if (line.amount) {
        const amount = readLine(line.amount);
        if (amount == null) continue;
        available -= Math.round(amount*100);
        allocations.push({label:line.label,amount});
      } else {
        if (!Number.isFinite(line.weight)||line.weight<=0) throw new Error('نسبة تقسيم الميزانية محتاجة مراجعة.');
        weighted.push(line);
      }
    }
    if (missing.length) return {id:request.id,type:request.type,missing};
    if (available < 0) throw new Error('التكاليف المقترحة أكبر من الميزانية. لازم نقلل حجم البداية.');
    const weight = weighted.reduce((sum,line)=>sum+line.weight,0);
    let allocated = 0;
    weighted.forEach((line,index)=>{
      const cents = index===weighted.length-1 ? available-allocated : Math.floor(available*line.weight/weight);
      allocated += cents;
      allocations.push({label:line.label,amount:cents/100});
    });
    scenario = true; // Allocation weights are proposals, never observed costs.
    values = {budget,reserve,allocations,unallocated:(available-allocated)/100};
    function readLine(input) {
      request = {...request,line_amount:input};
      return read('line_amount');
    }
  } else if (request.type === 'purchase') {
    const budget=read('budget'), reserve=read('reserve'), price=read('price');
    if (!missing.length) {
      if (price<=0||reserve>budget) throw new Error('سعر الشراء أو المبلغ الاحتياطي محتاج مراجعة.');
      const quantity=Math.floor((Math.round(budget*100)-Math.round(reserve*100))/Math.round(price*100));
      if (!Number.isFinite(quantity)) throw new Error('سعر الشراء صغير جدًا للحساب بالجنيه والقرش.');
      values={budget,reserve,unit_price:price,quantity,cost:money(quantity*price),remaining:money(budget-quantity*price)};
    }
  } else if (request.type === 'revenue') {
    const quantity=read('quantity'),price=read('price');
    if (!missing.length) values={quantity,price,revenue:money(quantity*price)};
  } else if (['margin','break_even','goal'].includes(request.type)) {
    const price=read('price'),cost=read('unit_cost');
    const fixed=request.type==='margin'?null:read('fixed_cost');
    const target=request.type==='goal'?read('target'):null;
    const quantity=read('quantity',true);
    if (!missing.length) {
      const margin=money(price-cost);
      values={price,unit_cost:cost,contribution:margin};
      if (request.type!=='margin') {
        values.fixed_cost=fixed;
        values.required_quantity=margin>0?Math.ceil(((target||0)+fixed)/margin):null;
        values.target=target;
        if (quantity!=null) {
          values.quantity=quantity;
          values.scenario_surplus=money(quantity*margin-fixed);
          values.target_covered=margin>0 && values.scenario_surplus >= (target||0);
        }
      }
    }
  } else if (request.type === 'cash') {
    const opening=read('budget');
    const fact=facts.find(row=>row.key===request.budget?.fact_key);
    if (!fact || fact.key!=='opening_cash' || !fact.observed_on) missing.push('opening_cash');
    if (!missing.length) {
      const flows=cashRows.filter(row=>!row.estimated&&row.date>fact.observed_on);
      const inflows=flows.filter(row=>row.type==='income').reduce((sum,row)=>sum+row.amount,0);
      const outflows=flows.filter(row=>row.type!=='income').reduce((sum,row)=>sum+row.amount,0);
      values={opening_cash:opening,as_of:fact.observed_on,inflows:money(inflows),outflows:money(outflows),cash_from_records:money(opening+inflows-outflows)};
    }
  } else throw new Error('نوع الحساب مش مدعوم.');
  if (Object.values(values).some(value=>typeof value==='number'&&!Number.isFinite(value))) throw new Error('الأرقام أكبر من نطاق الحساب.');
  return {id:request.id,type:request.type,missing:[...new Set(missing)],scenario,sources,values};
}
module.exports = { calculate, quoted, hypothetical };
