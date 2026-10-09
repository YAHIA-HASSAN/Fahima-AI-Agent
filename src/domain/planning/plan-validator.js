function validatePlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { valid: false, quality: 'PROVISIONAL', errors: ['الخطة غير موجودة.'] };
  for (const key of ['objective', 'assumptions', 'steps', 'risks', 'missingInformation']) if (!(key in plan)) errors.push(`missing:${key}`);
  if (typeof plan.objective !== 'string' || !plan.objective.trim()) errors.push('missing:objective');
  if (!Array.isArray(plan.steps) || plan.steps.length === 0 || plan.steps.some(step => typeof step !== 'string' || !step.trim())) errors.push('invalid:steps');
  if (!Array.isArray(plan.assumptions) || !Array.isArray(plan.risks) || !Array.isArray(plan.missingInformation)) errors.push('invalid:disclosures');
  if (plan.budget) {
    const items = plan.budget.items;
    if (!Array.isArray(items) || items.some(item => !Number.isFinite(item.totalCost) || item.totalCost < 0)) errors.push('invalid:budget_items');
    if (items?.length) {
      const sum = items.reduce((total, item) => total + item.totalCost, 0);
      if (!Number.isFinite(plan.budget.total) || Math.abs(sum + Number(plan.budget.reserve || 0) - plan.budget.total) > 0.01) errors.push('inconsistent:budget_total');
      if (!Number.isFinite(plan.budget.capital) || !Number.isFinite(plan.budget.remaining) || Math.abs(plan.budget.capital - plan.budget.total - plan.budget.remaining) > 0.01) errors.push('inconsistent:remaining_budget');
      if (Number(plan.budget.reserve) > 0 && plan.budget.reserveStatus !== 'agent_proposed') errors.push('undisclosed:reserve_status');
    }
  }
  if (plan.prices && (!Array.isArray(plan.prices) || plan.prices.some(price => !price.sourceUrl || !/^https?:\/\//i.test(price.sourceUrl) || !Number.isFinite(price.amount) || !price.unit || !price.observedAt))) errors.push('invalid:price_evidence');
  if (plan.sources && (!Array.isArray(plan.sources) || plan.sources.some(source => !/^https?:\/\//i.test(source.url || '') || !source.retrievedAt))) errors.push('invalid:source_evidence');
  const hasCriticalGaps = Array.isArray(plan.missingInformation) && plan.missingInformation.length > 0;
  return { valid: errors.length === 0, quality: errors.length || hasCriticalGaps ? 'PROVISIONAL' : 'COMPLETE', errors };
}
module.exports = { validatePlan };
