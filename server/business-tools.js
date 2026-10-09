const PERIODS = new Set(['today', 'week', 'month', 'all']);
const {createToolRegistry}=require('./tool-registry');

function createBusinessTools(projectId, options = {}) {
  const business = options.business || require('./business');
  const scope = Number(projectId);
  if (!Number.isSafeInteger(scope) || scope < 1 || !business.getProject(scope)) {
    throw new Error('Business tool context is invalid.');
  }

  function periodBounds(period) {
    return business.periodBounds(PERIODS.has(period) ? period : 'today');
  }

  const definitions={
    analyze_scenario: {
      description: 'Calculate a proposal from this project facts or labelled assumptions; never write ledger records.',
      execute: ({ calculation } = {}) => {
        const { createMemory } = require('./memory');
        const { calculate } = require('./planning');
        const memory=createMemory(business.db);
        const facts=[...memory.facts(scope),...memory.researchFacts(scope),...memory.goals(scope).map(goal=>({key:`goal:${goal.goal_key}`,label:goal.title,numeric_value:goal.target,certainty:'confirmed',source:'user',observed_on:null}))];
        return calculate(calculation,{facts,message:options.message||'',cashRows:calculation.type==='cash'?business.getTransactions(scope,'0001-01-01',business.localDate()):[]});
      },
    },
    get_sales_summary: {
      description: 'Return authoritative sales total and count from the selected project records.',
      execute: ({ period = 'today' } = {}) => {
        const bounds = periodBounds(period);
        const sales = business.getTransactions(scope, bounds.from, bounds.to).filter((row) => row.type === 'income');
        return { total: sales.reduce((sum, row) => sum + Number(row.amount || 0), 0), count: sales.length, period: bounds };
      },
    },
    get_project_summary: {
      description: 'Return recorded income, purchases, operating expenses, and withdrawals. Never call the result net profit.',
      execute: ({ period = 'month' } = {}) => {
        const bounds = periodBounds(period);
        return { summary: business.getSummary(scope, bounds.from, bounds.to), period: bounds };
      },
    },
    get_inventory: {
      description: 'Return current registered quantity for a product or the selected project product list.',
      execute: ({ product_name: productName = null } = {}) => {
        const rows = business.getProducts(scope);
        const product = typeof productName === 'string' && productName.trim()
          ? business.findProduct(scope, productName.trim().slice(0, 100))
          : null;
        return { product: product ? { name: product.name, unit: product.unit, current_quantity: product.current_quantity } : null, products: product ? [] : rows.slice(0, 25).map((row) => ({ name: row.name, unit: row.unit, current_quantity: row.current_quantity })) };
      },
    },
    get_product_sales: {
      description: 'Return the top products by detailed sale quantity for the selected period.',
      execute: ({ period = 'month' } = {}) => {
        const bounds = periodBounds(period);
        return { sales: business.getProductSales(scope, bounds.from, bounds.to).slice(0, 10), period: bounds };
      },
    },
    estimate_price: {
      description: 'Calculate a selling price from a supplied cost and markup; this is not a market-price recommendation.',
      execute: ({ cost, markup_percent: markup } = {}) => {
        const unitCost = Number(cost);
        const markupPercent = Number(markup);
        if (cost == null || markup == null || !Number.isFinite(unitCost) || unitCost <= 0 || !Number.isFinite(markupPercent) || markupPercent < 0 || markupPercent > 10000) {
          throw new Error('Price estimate inputs are invalid.');
        }
        return { cost: unitCost, markup_percent: markupPercent, price: Math.round(unitCost * (1 + markupPercent / 100) * 100) / 100 };
      },
    },
  };
  const schemas={
    analyze_scenario:{type:'object',properties:{calculation:{type:'object'}},required:['calculation'],additionalProperties:false},
    get_sales_summary:{type:'object',properties:{period:{type:'string',enum:[...PERIODS]}},additionalProperties:false},
    get_project_summary:{type:'object',properties:{period:{type:'string',enum:[...PERIODS]}},additionalProperties:false},
    get_inventory:{type:'object',properties:{product_name:{type:['string','null'],maxLength:100}},additionalProperties:false},
    get_product_sales:{type:'object',properties:{period:{type:'string',enum:[...PERIODS]}},additionalProperties:false},
    estimate_price:{type:'object',properties:{cost:{type:'number',minimum:0.01},markup_percent:{type:'number',minimum:0,maximum:10000}},required:['cost','markup_percent'],additionalProperties:false},
  };
  const outputs={
    analyze_scenario:{type:'object'},
    get_sales_summary:{type:'object',properties:{total:{type:'number'},count:{type:'integer'},period:{type:'object'}},required:['total','count','period']},
    get_project_summary:{type:'object',properties:{summary:{type:'object'},period:{type:'object'}},required:['summary','period']},
    get_inventory:{type:'object',properties:{product:{type:['object','null']},products:{type:'array',items:{type:'object'}}},required:['product','products']},
    get_product_sales:{type:'object',properties:{sales:{type:'array',items:{type:'object'}},period:{type:'object'}},required:['sales','period']},
    estimate_price:{type:'object',properties:{cost:{type:'number'},markup_percent:{type:'number'},price:{type:'number'}},required:['cost','markup_percent','price']},
  };
  const registry=createToolRegistry({projectId:scope});
  for(const [name,tool] of Object.entries(definitions))registry.register({name,description:tool.description,inputSchema:schemas[name],outputSchema:outputs[name],execute:tool.execute});
  return Object.freeze(Object.fromEntries(registry.describe().map(({name})=>[name,{execute:input=>{
    const outcome=registry.execute(name,input);
    if(outcome.status!=='succeeded')throw Object.assign(new Error(outcome.error?.message||outcome.error?.code||'Tool execution failed.'),{code:outcome.error?.code});
    return outcome.output;
  }}])));
}

function executeBusinessTool(registry, name, input = {}) {
  const tool = registry?.[name];
  if (!tool || typeof tool.execute !== 'function') throw new Error('Business tool is unavailable.');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Business tool input must be an object.');
  return tool.execute(input);
}

module.exports = { createBusinessTools, executeBusinessTool };
