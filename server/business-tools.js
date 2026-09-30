const PERIODS = new Set(['today', 'week', 'month', 'all']);

function createBusinessTools(projectId, options = {}) {
  const business = options.business || require('./business');
  const scope = Number(projectId);
  if (!Number.isSafeInteger(scope) || scope < 1 || !business.getProject(scope)) {
    throw new Error('Business tool context is invalid.');
  }

  function periodBounds(period) {
    return business.periodBounds(PERIODS.has(period) ? period : 'today');
  }

  return Object.freeze({
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
        if (!Number.isFinite(unitCost) || unitCost <= 0 || !Number.isFinite(markupPercent) || markupPercent < 0 || markupPercent > 10000) {
          throw new Error('Price estimate inputs are invalid.');
        }
        return { cost: unitCost, markup_percent: markupPercent, price: Math.round(unitCost * (1 + markupPercent / 100) * 100) / 100 };
      },
    },
  });
}

function executeBusinessTool(registry, name, input = {}) {
  const tool = registry?.[name];
  if (!tool || typeof tool.execute !== 'function') throw new Error('Business tool is unavailable.');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Business tool input must be an object.');
  return tool.execute(input);
}

module.exports = { createBusinessTools, executeBusinessTool };
