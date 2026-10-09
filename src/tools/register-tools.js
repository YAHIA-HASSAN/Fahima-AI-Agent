const { revenue, budget } = require('../domain/finance/calculator');
const { validatePlan } = require('../domain/planning/plan-validator');

const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const shortText = { type: 'string', minLength: 1, maxLength: 250 };

function registerTools({ registry, db, memory, transactions, inventory, plans, search }) {
  registry.register({ name: 'save_project_fact', description: 'Save or correct a project fact explicitly stated or confirmed by the user.', inputSchema: object({ key: shortText, value: { type: 'string', maxLength: 1000 }, certainty: { type: 'string', enum: ['confirmed', 'proposed'] } }), execute: (input, context) => ({ fact: memory.saveFact(context.projectId, input.key, input.value, 'conversation', input.certainty) }) });
  registry.register({ name: 'save_project_goal', description: 'Save a project goal or update its target.', inputSchema: object({ key: shortText, title: shortText, target: { type: 'string', maxLength: 300 } }), execute: (input, context) => ({ goal: memory.saveGoal(context.projectId, input.key, input.title, input.target || null) }) });
  registry.register({ name: 'get_inventory', description: 'Read product quantities currently recorded for this project.', inputSchema: object({}), execute: (_input, context) => ({ items: inventory.list(context.projectId) }) });
  registry.register({ name: 'record_inventory_movement', description: 'Record an actual stock receipt, sale, or adjustment. Use only when the user reports a completed event.', inputSchema: object({ name:shortText,unit:shortText,quantityDelta:{type:'number',minimum:-1000000,maximum:1000000},reason:shortText }), permission:context=>context.isProjectAuthorized===true, execute:(input,context)=>inventory.move(context.projectId,{...input,idempotencyKey:`${context.task.id}:inventory:${context.toolSequence}`}) });
  registry.register({ name: 'correct_transaction', description: 'Correct an existing transaction by voiding the old record and writing its replacement with audit history. Linked stock transactions must be cancelled and re-recorded with corrected inventory details.', inputSchema: object({transactionId:{type:'integer',minimum:1},amount:{type:'number',minimum:0.01},type:{type:'string',enum:['income','stock_cost','operating_expense','withdrawal']},date:{type:'string',minLength:10,maxLength:10},description:{type:'string',maxLength:250},reason:shortText},['transactionId','reason']), permission:context=>context.isProjectAuthorized===true, execute:(input,context)=>{if(db.prepare('SELECT 1 FROM fahima_v2_inventory_movements WHERE project_id=? AND transaction_id=?').get(context.projectId,input.transactionId))throw Object.assign(new Error('المعاملة مرتبطة بالمخزون. ألغِيها ثم سجّلي العملية بتفاصيل الصنف والكمية الصحيحة.'),{code:'LINKED_INVENTORY_TRANSACTION'});return transactions.correct(context.projectId,input.transactionId,input,input.reason,`${context.task.id}:correct:${context.toolSequence}`);} });
  registry.register({ name: 'cancel_transaction', description: 'Cancel a transaction that should not count in financial totals; reverse any linked stock movement atomically.', inputSchema: object({transactionId:{type:'integer',minimum:1},reason:shortText}), permission:context=>context.isProjectAuthorized===true, execute:(input,context)=>db.transaction(()=>{const movements=db.prepare('SELECT id FROM fahima_v2_inventory_movements WHERE project_id=? AND transaction_id=? AND reverses_movement_id IS NULL').all(context.projectId,input.transactionId);const cancelled=transactions.cancel(context.projectId,input.transactionId,input.reason,`${context.task.id}:cancel:${context.toolSequence}`);const reversals=movements.map(row=>inventory.reverse(context.projectId,row.id,`${context.task.id}:cancel-stock:${context.toolSequence}:${row.id}`,input.reason));return { ...cancelled,reversedMovements:reversals.length };})() });
  registry.register({ name: 'update_plan_step', description: 'Mark a saved plan step complete or pending and preserve its note.', inputSchema:object({revision:{type:'integer',minimum:1},stepIndex:{type:'integer',minimum:0},complete:{type:'boolean'},note:{type:'string',maxLength:500}}),execute:(input,context)=>({steps:plans.setStep(context.projectId,input.revision,input.stepIndex,input.complete,input.note)}) });
  registry.register({ name: 'record_plan_outcome', description: 'Save an actual project outcome and compare it with the selected saved plan.', inputSchema:object({revision:{type:'integer',minimum:1},metric:shortText,actualValue:shortText,note:{type:'string',maxLength:500}}),execute:(input,context)=>({outcome:plans.recordOutcome(context.projectId,input.revision,input.metric,input.actualValue,input.note,`${context.task.id}:outcome:${context.toolSequence}`)}) });
  registry.register({ name: 'calculate_revenue', description: 'Calculate revenue from a quantity and unit price without recording a transaction.', inputSchema: object({ quantity: { type: 'number', minimum: 0.001 }, unitPrice: { type: 'number', minimum: 0 } }), execute: input => ({ revenue: revenue(input.quantity, input.unitPrice), currency: 'EGP', recorded: false }) });
  registry.register({ name: 'calculate_startup_budget', description: 'Calculate a budget from supplied cost items. State whether reserve is agent-proposed and explain its project-specific basis.', inputSchema: object({ capital: { type: 'number', minimum: 0.01 }, reserve: { type: 'number', minimum: 0 }, reserveRationale: shortText, items: { type: 'array', maxItems: 30, items: object({ name: shortText, quantity: { type: 'number', minimum: 0.001 }, unitCost: { type: 'number', minimum: 0 }, basis: { type: 'string', enum: ['researched', 'user_provided', 'assumption'] } }) } }), execute: input => ({ ...budget(input.items, input.capital, input.reserve), reserveStatus: 'agent_proposed', reserveRationale: input.reserveRationale }) });
  registry.register({ name: 'search_market', description: 'Search current web results for Egyptian products, suppliers, or business information. Results are unverified evidence.', inputSchema: object({ query: { type: 'string', minLength: 2, maxLength: 220 }, location: { type: 'string', maxLength: 120 }, searchType: { type: 'string', enum: ['search', 'shopping'] } }), execute: async (input, context) => {
    const result = await search({ ...input, projectId: context.projectId });
    const save = db.prepare('INSERT OR REPLACE INTO fahima_v2_research(project_id,task_id,query,source_url,result_json,retrieved_at) VALUES(?,?,?,?,?,?)');
    const persist = db.transaction(() => { for (const item of result.results || []) if (item.url) save.run(context.projectId, context.task.id, input.query, item.url, JSON.stringify(item), result.receivedAt); });
    persist();
    return { ...result, persistedEvidenceCount: (result.results || []).filter(item => item.url).length };
  } });
  registry.register({ name: 'record_actual_transaction', description: 'Record an actual completed sale, purchase, expense, or withdrawal reported as already done. Never use for plans or hypotheticals.', inputSchema: object({ type: { type: 'string', enum: ['income', 'stock_cost', 'operating_expense', 'withdrawal'] }, amount: { type: 'number', minimum: 0.01 }, date: { type: 'string', minLength: 10, maxLength: 10 }, description: shortText }), permission: context => context.isProjectAuthorized === true, execute: (input, context) => ({ transaction: transactions.record(context.projectId, { ...input, idempotencyKey: `${context.task.id}:transaction:${context.toolSequence}` }) }) });
  registry.register({ name:'record_inventory_transaction',description:'Record a completed tracked-product sale or purchase and its stock movement atomically. Use only when the product and quantity are known and opening stock is recorded.',inputSchema:object({type:{type:'string',enum:['income','stock_cost']},amount:{type:'number',minimum:0.01},date:{type:'string',minLength:10,maxLength:10},description:shortText,productName:shortText,unit:shortText,quantity:{type:'number',minimum:0.001},reason:shortText}),permission:context=>context.isProjectAuthorized===true,execute:(input,context)=>{const key=`${context.task.id}:combined:${context.toolSequence}`;return db.transaction(()=>{const transaction=transactions.record(context.projectId,{...input,idempotencyKey:`${key}:tx`,taskId:context.task.id});const existing=db.prepare('SELECT * FROM products WHERE project_id=? AND name=? AND unit=?').get(context.projectId,input.productName,input.unit);if(!existing)throw Object.assign(new Error('سجّلي رصيد بداية الصنف قبل ربط البيع أو الشراء بالمخزون.'),{code:'OPENING_STOCK_UNKNOWN'});const quantityDelta=input.type==='income'?-input.quantity:input.quantity;const movement=inventory.move(context.projectId,{productId:existing.id,quantityDelta,reason:input.reason,transactionId:transaction.id,idempotencyKey:`${key}:stock`});return {transaction,movement};})();}});
  registry.register({ name: 'get_financial_summary', description: 'Read stored financial totals for this project.', inputSchema: object({ from: { type: 'string', minLength: 10, maxLength: 10 }, to: { type: 'string', minLength: 10, maxLength: 10 } }), execute: (input, context) => ({ totals: db.prepare(`SELECT type,SUM(amount) AS amount,COUNT(*) AS count FROM transactions WHERE project_id=? AND voided_at IS NULL AND date>=? AND date<=? GROUP BY type`).all(context.projectId, input.from, input.to) }) });
  const priceSchema = object({ product: shortText, amount: { type: 'number', minimum: 0.01 }, unit: shortText, sourceUrl: { type: 'string', minLength: 8, maxLength: 1000 }, observedAt: { type: 'string', minLength: 10, maxLength: 40 } });
  const planSchema = { type: 'object', properties: { objective: shortText, assumptions: { type: 'array', maxItems: 30, items: shortText }, steps: { type: 'array', maxItems: 30, items: shortText }, risks: { type: 'array', maxItems: 30, items: shortText }, missingInformation: { type: 'array', maxItems: 30, items: shortText }, budget: { type: 'object' }, prices: { type: 'array', maxItems: 30, items: priceSchema } }, required: ['objective', 'assumptions', 'steps', 'risks', 'missingInformation'], additionalProperties: false };
  registry.register({ name: 'deliver_response', description: 'Deliver a final answer to a question or business update. Use deliver_business_plan for business planning.', inputSchema: object({ taskType: { type: 'string', enum: ['question', 'financial_action', 'business_update'] }, answer: shortText, status: { type: 'string', enum: ['COMPLETE', 'PROVISIONAL', 'WAITING_FOR_INPUT'] } }), execute: input => ({ terminalResult: { status: input.status, answer: input.answer, plan: null } }) });
  registry.register({ name: 'deliver_business_plan', description: 'Deliver and persist a complete structured business plan or revision. This tool requires the full plan and will validate it before the task can finish.', inputSchema: object({ plan: planSchema, answer: shortText, status: { type: 'string', enum: ['COMPLETE', 'PROVISIONAL', 'WAITING_FOR_INPUT'] } }), execute: (input, context) => {
    const budgetObservation = [...context.observations].reverse().find(item => item.tool === 'calculate_startup_budget' && item.observation.status === 'succeeded');
    const previousBudget = context.memory.plans[0]?.body?.budget;
    const reusesUnchangedBudget = sameBudgetInputs(input.plan.budget, previousBudget);
    if (input.plan.budget && !budgetObservation && !reusesUnchangedBudget) return { rejected: true, validation: { errors: ['missing:calculated_budget'] }, nextAction: 'Call calculate_startup_budget with the cost items and disclosed reserve. Copy its exact output into plan.budget.' };
    let plan = input.plan;
    if (budgetObservation) plan = { ...input.plan, budget: budgetObservation.observation.output };
    else if (reusesUnchangedBudget) plan = { ...input.plan, budget: previousBudget };
    else if (!plan.missingInformation.includes('تكاليف البداية لم تُحسب بعد من بنود موثوقة.')) plan = { ...plan, missingInformation: [...plan.missingInformation, 'تكاليف البداية لم تُحسب بعد من بنود موثوقة.'] };
    const searchSources = context.observations.filter(item => item.tool === 'search_market' && item.observation.status === 'succeeded').flatMap(observation => (observation.observation.output.results || []).map(item => ({ title: item.title, url: item.url, snippet: item.snippet, retrievedAt: observation.observation.output.receivedAt || null })));
    if (searchSources.length) plan = { ...plan, sources: uniqueSources(searchSources) };
    const validation = validatePlan(plan);
    if (!validation.valid) return { rejected: true, validation };
    const unsupportedPrices = (plan.prices || []).filter(price => !priceSupported(db, context.projectId, context.task.id, price));
    if (unsupportedPrices.length) return { rejected: true, validation: { ...validation, errors: [...validation.errors, 'unsupported:price_evidence'] }, unsupportedPriceCount: unsupportedPrices.length, nextAction: 'Remove unsupported prices from the plan, disclose the missing market data, and deliver a provisional plan.' };
    const stored = plans.save(context.projectId, context.task.id, plan, validation.quality);
    const status = input.status === 'WAITING_FOR_INPUT' ? 'WAITING_FOR_INPUT' : stored.qualityStatus === 'PROVISIONAL' ? 'PROVISIONAL' : input.status;
    return { terminalResult: { status, answer: input.answer, plan: stored }, planQuality: stored.qualityStatus, validation };
  } });
  registry.register({ name: 'ask_user', description: 'Ask one necessary question when the user must provide a critical missing fact.', inputSchema: object({ question: shortText }), execute: input => ({ terminalResult: { status: 'WAITING_FOR_INPUT', answer: input.question, plan: null } }) });
}

function sameBudgetInputs(a, b) {
  if (!a || !b || Number(a.capital) !== Number(b.capital) || Number(a.reserve) !== Number(b.reserve) || !Array.isArray(a.items) || !Array.isArray(b.items) || a.items.length !== b.items.length) return false;
  return a.items.every((item, index) => {
    const prior = b.items[index];
    return String(item.name || '') === String(prior.name || '') && Number(item.quantity) === Number(prior.quantity) && Number(item.unitCost) === Number(prior.unitCost);
  });
}

function uniqueSources(rows) {
  const seen = new Set();
  return rows.filter(row => row.url && !seen.has(row.url) && seen.add(row.url));
}

function priceSupported(db, projectId, taskId, price) {
  if (!price || !price.sourceUrl || !Number.isFinite(price.amount) || !price.unit || !price.observedAt) return false;
  const rows = db.prepare('SELECT result_json,retrieved_at FROM fahima_v2_research WHERE project_id=? AND source_url=? ORDER BY id DESC LIMIT 5').all(projectId, price.sourceUrl);
  const requestedAt = Date.parse(price.observedAt);
  if (!Number.isFinite(requestedAt)) return false;
  return rows.some(row => {
    const retrievedAt = Date.parse(row.retrieved_at);
    if (!Number.isFinite(retrievedAt) || Date.now() - retrievedAt > 30 * 86400000) return false;
    let item;
    try { item = JSON.parse(row.result_json); } catch { return false; }
    const text = `${item.title || ''} ${item.snippet || ''}`.toLocaleLowerCase('ar-EG');
    const priceText = String(item.price || '');
    const amountMatches = /(?:\bEGP\b|جنيه|ج\.م|ج م)/i.test(priceText) && [...priceText.matchAll(/[0-9][0-9,]*(?:\.[0-9]+)?/g)].some(match => Math.abs(Number(match[0].replaceAll(',', '')) - Number(price.amount)) < 0.005);
    const unitMatches = text.includes(String(price.unit).toLocaleLowerCase('ar-EG'));
    const product = String(price.product || '').trim().toLocaleLowerCase('ar-EG');
    const productMatches = !product || text.includes(product) || product.split(/\s+/).filter(word => word.length > 2).every(word => text.includes(word));
    return amountMatches && unitMatches && productMatches && Math.abs(requestedAt - retrievedAt) < 86400000;
  });
}

module.exports = { registerTools, priceSupported };
