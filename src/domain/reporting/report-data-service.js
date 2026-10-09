const TYPE_LABELS = {
  income: 'مبيعات',
  stock_cost: 'مشتريات',
  operating_expense: 'مصروف',
  withdrawal: 'سحب من المشروع',
};

function createReportDataService({ db, ledger, projects }) {
  function build(projectId, from, to) {
    const project = projects.get(projectId);
    if (!project) throw Object.assign(new Error('المشروع غير موجود.'), { status: 404 });
    if (!validDate(from) || !validDate(to) || from > to) throw Object.assign(new Error('اختاري فترة زمنية صحيحة.'), { status: 400 });

    const summary = ledger.summary(projectId, from, to);
    const transactionRows = db.prepare(`SELECT id,type,amount,date,description,estimated
      FROM transactions WHERE project_id=? AND voided_at IS NULL AND date BETWEEN ? AND ?
      ORDER BY date ASC,id ASC`).all(projectId, from, to);
    const payments = db.prepare(`SELECT p.amount,p.effective_date AS date,p.description,c.name AS customer_name
      FROM fahima_v2_customer_payments p JOIN fahima_v2_customers c ON c.id=p.customer_id
      WHERE p.project_id=? AND p.effective_date BETWEEN ? AND ? ORDER BY p.effective_date ASC,p.id ASC`).all(projectId, from, to);
    const supplierPayments = db.prepare(`SELECT p.amount,p.effective_date AS date,p.description,s.name AS supplier_name
      FROM fahima_v2_supplier_payments p JOIN fahima_v2_suppliers s ON s.id=p.supplier_id
      WHERE p.project_id=? AND p.effective_date BETWEEN ? AND ? ORDER BY p.effective_date ASC,p.id ASC`).all(projectId, from, to);
    const transactions = transactionRows.map(row => ({
      date: row.date,
      type: row.type,
      typeLabel: TYPE_LABELS[row.type] || 'عملية',
      amount: Number(row.amount),
      estimated: Boolean(row.estimated),
      description: cleanDescription(row.description),
    }));
    for (const row of payments) transactions.push({ date: row.date, type: 'customer_payment', typeLabel: 'تحصيل من زبون', amount: Number(row.amount), description: `${cleanDescription(row.description)} — ${row.customer_name}` });
    for (const row of supplierPayments) transactions.push({ date: row.date, type: 'supplier_payment', typeLabel: 'دفع لمورد', amount: Number(row.amount), description: `${cleanDescription(row.description)} — ${row.supplier_name}` });
    transactions.sort((a, b) => a.date.localeCompare(b.date));
    const totals = {};
    for (const row of transactionRows) {
      const group = totals[row.type] || (totals[row.type] = { confirmed: 0, estimated: 0, count: 0 });
      group[row.estimated ? 'estimated' : 'confirmed'] += Number(row.amount);
      group.count += 1;
    }

    const inventory = db.prepare(`SELECT name,unit,current_quantity,unit_cost,
      ROUND(current_quantity*COALESCE(unit_cost,0),2) AS value FROM products WHERE project_id=? ORDER BY name`).all(projectId);
    const outsideRangeCount = db.prepare('SELECT COUNT(*) AS count FROM transactions WHERE project_id=? AND voided_at IS NULL AND (date<? OR date>?)').get(projectId, from, to).count;
    const availableRange = db.prepare('SELECT MIN(date) AS fromDate,MAX(date) AS toDate FROM transactions WHERE project_id=? AND voided_at IS NULL').get(projectId);
    const reconciliation = reconcile(summary, transactions);
    return {
      projectId,
      project: { id: project.id, name: project.name },
      period: { from, to },
      from,
      to,
      summary,
      totals,
      transactions,
      inventory,
      outsideRangeCount,
      availableRange,
      reconciliation,
      hasActivity: transactions.length > 0,
      generatedAt: new Date().toISOString(),
      note: 'الأرقام المعروضة مأخوذة من دفتر الأستاذ المحفوظ للمشروع والفترة المحددة.',
    };
  }

  return { build };
}

function cleanDescription(value) {
  return String(value || 'عملية مسجلة').replace(/\s*\[[^\]]+\]\s*$/u, '').trim() || 'عملية مسجلة';
}

function reconcile(summary, transactions) {
  const recordedSales = transactions.filter(row => row.type === 'income').reduce((sum, row) => sum + row.amount, 0);
  const recordedExpenses = transactions.filter(row => row.type === 'operating_expense').reduce((sum, row) => sum + row.amount, 0);
  return {
    salesMatch: Math.abs(recordedSales - Number(summary.invoicedSales || 0)) < 0.01,
    expensesMatch: Math.abs(recordedExpenses - Number(summary.operatingExpenses || 0)) < 0.01,
    warnings: [
      ...(Math.abs(recordedSales - Number(summary.invoicedSales || 0)) >= 0.01 ? ['المبيعات التفصيلية لا تتطابق مع دفتر الأستاذ.'] : []),
      ...(Math.abs(recordedExpenses - Number(summary.operatingExpenses || 0)) >= 0.01 ? ['المصاريف التفصيلية لا تتطابق مع دفتر الأستاذ.'] : []),
    ],
  };
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

module.exports = { createReportDataService, cleanDescription };
