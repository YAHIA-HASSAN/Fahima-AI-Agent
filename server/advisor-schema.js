// These describe reasoning outputs, not business-specific templates.
const nullableText = (maxLength = 300) => ({ type: ['string','null'], maxLength });
const text = (maxLength = 300) => ({ type: 'string', maxLength });
const number = { type: ['number','null'] };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });
const list = (items, maxItems = 12) => ({ type: 'array', items, maxItems });
const fact = object({
  key: text(80), label: text(100), value: text(300), numeric_value: number, unit: nullableText(40),
  kind: { type:'string', enum:['fact','resource','price','preference','constraint'] },
  certainty: { type:'string', enum:['confirmed','approximate','hypothetical','ambiguous'] },
  evidence: text(500), correction: { type:'boolean' }, observed_on: nullableText(10),
});
// Numeric operands either reference this project's memory or explicitly disclose a scenario assumption.
const operand = object({ fact_key: nullableText(80), value: number, basis: { type:'string', enum:['stored','user','assumption'] }, evidence: nullableText(500) });
const calculation = object({
  id: text(40), type: { type:'string', enum:['budget','purchase','revenue','margin','break_even','goal','cash'] },
  budget: { ...operand, type:['object','null'] }, reserve: { ...operand, type:['object','null'] },
  price: { ...operand, type:['object','null'] }, quantity: { ...operand, type:['object','null'] },
  unit_cost: { ...operand, type:['object','null'] }, fixed_cost: { ...operand, type:['object','null'] },
  target: { ...operand, type:['object','null'] },
  lines: list(object({ label:text(100), weight:{type:'number'}, amount:{ ...operand, type:['object','null'] } })),
});
const properties = {
  facts: list(fact,20),
  goals: list(object({ key:text(80),title:text(200),target:number,unit:nullableText(40),horizon:nullableText(100),
    evidence:text(500),status:{type:'string',enum:['active','completed','paused']},correction:{type:'boolean'} }),8),
  transaction_status: { type:'string',enum:['actual','planned','hypothetical','unclear'] },
  project_reference: nullableText(100),
  state_update: { ...object({ mode:{type:'string',enum:['continue','interrupt','resume','replace']},
    objective:nullableText(300), capability:nullableText(80), next_action:nullableText(300), progress:nullableText(300) }), type:['object','null'] },
  question: { ...object({ text:text(300), fact_key:nullableText(80), reason:text(300) }), type:['object','null'] },
  calculations:list(calculation,5),
  research_requests:list(object({
    key:text(80), query:text(300), purpose:{type:'string',enum:['price','supplier','requirement','regulation','market']},
    product_name:text(120), specification:nullableText(200), unit:nullableText(60), location:nullableText(120),
    freshness_days:{type:'number'}, search_type:{type:'string',enum:['search','shopping']}, reason:text(300)
  },['key','query','purpose','product_name','specification','unit','location','freshness_days','reason']),2),
  plan: { ...object({ title:text(150),summary:text(700),
    assumptions:list(text(300)),requirements:list(text(300)),risks:list(text(300)),
    steps:list(object({ key:text(80),text:text(300),status:{type:'string',enum:['proposed','in_progress','completed']},evidence:nullableText(500) })),
    indicators:list(text(200)),next_action:text(300),sources:list(object({title:text(200),url:text(1000)}),12) }), type:['object','null'] },
};
module.exports = { properties };
