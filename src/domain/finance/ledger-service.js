const { moneyMinor } = require('./calculator');

function createLedgerService(db, transactions, inventory) {
  const today = value => {
    const date = String(value || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('التاريخ غير صحيح.');
    return date;
  };
  const customer = (projectId, name) => {
    const clean = String(name || '').trim().slice(0, 120);
    if (!clean) return null;
    const existing = db.prepare('SELECT * FROM fahima_v2_customers WHERE project_id=? AND name=?').get(projectId, clean);
    if (existing) return existing;
    const result = db.prepare('INSERT INTO fahima_v2_customers(project_id,name) VALUES(?,?)').run(projectId, clean);
    return db.prepare('SELECT * FROM fahima_v2_customers WHERE id=?').get(result.lastInsertRowid);
  };
  const openingInventory = db.transaction((projectId, input, taskId) => {
    const key = String(input.idempotencyKey || `${taskId || 'manual'}:opening:${input.name}`).slice(0, 140);
    const prior = db.prepare('SELECT * FROM fahima_v2_inventory_movements WHERE project_id=? AND idempotency_key=?').get(projectId, key);
    if (prior) return { ...prior, duplicate: true };
    const movement = inventory.move(projectId, { name: input.name, unit: input.unit, quantityDelta: input.quantity, reason: 'رصيد بداية فعلي', idempotencyKey: key });
    db.prepare('UPDATE products SET unit_cost=?,initial_quantity=initial_quantity+?,updated_at=datetime(\'now\') WHERE id=? AND project_id=?').run(Number(input.unitCost), Number(input.quantity), movement.productId, projectId);
    return { ...movement, unitCost: Number(input.unitCost), duplicate: false };
  });
  const sale = db.transaction((projectId, input, context = {}) => {
    const amount = Math.round(Number(input.quantity) * Number(input.unitPrice) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('الكمية أو سعر البيع غير صحيح.');
    const date = today(input.date);
    const product = db.prepare('SELECT * FROM products WHERE project_id=? AND name=? AND unit=?').get(projectId, String(input.productName).trim(), String(input.unit).trim());
    if (!product) throw Object.assign(new Error('الصنف مش مسجل برصيد بداية.'), { code: 'PRODUCT_NOT_FOUND' });
    const kind = input.saleKind === 'credit' ? 'credit' : 'cash';
    const client = kind === 'credit' ? customer(projectId, input.customerName) : null;
    if (kind === 'credit' && !client) throw new Error('اسم الزبون مطلوب للبيع على الحساب.');
    const key = String(input.idempotencyKey || `${context.taskId || 'manual'}:sale:${context.toolSequence || Date.now()}`).slice(0, 140);
    const prior = db.prepare('SELECT s.* FROM fahima_v2_sales s JOIN transactions t ON t.id=s.transaction_id WHERE s.project_id=? AND t.description LIKE ?').get(projectId, `%[${key}]%`);
    if (prior) return { ...prior, duplicate: true };
    const transaction = transactions.record(projectId, { type: 'income', amount, date, description: `${String(input.description || 'بيع')} [${key}]`, idempotencyKey: `${key}:income`, taskId: context.taskId });
    const movement = inventory.move(projectId, { productId: product.id, quantityDelta: -Number(input.quantity), transactionId: transaction.id, reason: 'بيع فعلي', idempotencyKey: `${key}:stock` });
    const paid = kind === 'cash' ? amount : 0;
    const recordedUnitCost = product.unit_cost === null || product.unit_cost === undefined ? null : Number(product.unit_cost);
    const row = db.prepare('INSERT INTO fahima_v2_sales(project_id,transaction_id,customer_id,product_id,quantity,unit_price,unit_cost,amount,paid_amount,sale_kind,effective_date,source_message_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(projectId, transaction.id, client?.id || null, product.id, Number(input.quantity), Number(input.unitPrice), recordedUnitCost, amount, paid, kind, date, context.sourceMessageId || null);
    return { id: Number(row.lastInsertRowid), transaction, movement, customer: client, amount, paidAmount: paid, balance: amount - paid, duplicate: false };
  });
  const payment = db.transaction((projectId, input, context = {}) => {
    const amount = moneyMinor(input.amount) / 100;
    const client = customer(projectId, input.customerName);
    if (!client) throw new Error('اسم الزبون مطلوب.');
    const date = today(input.date);
    const key = String(input.idempotencyKey || `${context.taskId || 'manual'}:payment:${context.toolSequence || Date.now()}`).slice(0, 140);
    const prior = db.prepare('SELECT * FROM fahima_v2_customer_payments WHERE project_id=? AND idempotency_key=?').get(projectId, key);
    if (prior) return { ...prior, duplicate: true, balance: balanceFor(projectId, client.id) };
    const result = db.prepare('INSERT INTO fahima_v2_customer_payments(project_id,customer_id,amount,effective_date,description,idempotency_key,source_message_id) VALUES(?,?,?,?,?,?,?)').run(projectId, client.id, amount, date, String(input.description || 'تحصيل من الزبون').slice(0, 250), key, context.sourceMessageId || null);
    return { id: Number(result.lastInsertRowid), customer: client, amount, balance: balanceFor(projectId, client.id), duplicate: false };
  });
  const purchase = db.transaction((projectId, input, context = {}) => {
    const quantity = Number(input.quantity), unitCost = Number(input.unitCost), amount = Math.round(quantity * unitCost * 100) / 100;
    if (!(quantity > 0) || !(unitCost >= 0) || !(amount > 0)) throw new Error('كمية أو تكلفة الشراء غير صحيحة.');
    const supplierName = String(input.supplierName || '').trim();
    const supplier = supplierName ? (db.prepare('SELECT * FROM fahima_v2_suppliers WHERE project_id=? AND name=?').get(projectId, supplierName) || (() => { const r = db.prepare('INSERT INTO fahima_v2_suppliers(project_id,name) VALUES(?,?)').run(projectId, supplierName); return db.prepare('SELECT * FROM fahima_v2_suppliers WHERE id=?').get(r.lastInsertRowid); })()) : null;
    const product = db.prepare('SELECT * FROM products WHERE project_id=? AND name=? AND unit=?').get(projectId, input.productName, input.unit);
    if (!product) throw new Error('الصنف مش مسجل.');
    const key = String(input.idempotencyKey || `${context.taskId || 'manual'}:purchase:${context.toolSequence || Date.now()}`).slice(0, 140);
    const prior = db.prepare('SELECT * FROM fahima_v2_purchases WHERE project_id=? AND idempotency_key=?').get(projectId, key); if (prior) return { ...prior, duplicate: true };
    const transaction = transactions.record(projectId, { type: 'stock_cost', amount, date: today(input.date), description: `${String(input.description || 'شراء')} [${key}]`, idempotencyKey: `${key}:cost`, taskId: context.taskId });
    const movement = inventory.move(projectId, { productId: product.id, quantityDelta: quantity, transactionId: transaction.id, reason: 'شراء فعلي', idempotencyKey: `${key}:stock` });
    const paid = input.purchaseKind === 'credit' ? 0 : amount;
    const result = db.prepare('INSERT INTO fahima_v2_purchases(project_id,supplier_id,product_id,quantity,unit_cost,amount,paid_amount,effective_date,description,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?,?)').run(projectId, supplier?.id || null, product.id, quantity, unitCost, amount, paid, input.date, input.description || 'شراء فعلي', key);
    return { id: Number(result.lastInsertRowid), transaction, movement, amount, paidAmount: paid, supplier, balance: amount - paid, duplicate: false };
  });
  const supplierPayment = db.transaction((projectId, input) => {
    const supplier = db.prepare('SELECT * FROM fahima_v2_suppliers WHERE project_id=? AND name=?').get(projectId, String(input.supplierName).trim()); if (!supplier) throw new Error('المورد مش مسجل.');
    const amount = moneyMinor(input.amount) / 100, key = String(input.idempotencyKey || `supplier-payment:${Date.now()}`).slice(0, 140);
    const prior = db.prepare('SELECT * FROM fahima_v2_supplier_payments WHERE project_id=? AND idempotency_key=?').get(projectId, key); if (prior) return { ...prior, duplicate: true };
    const r = db.prepare('INSERT INTO fahima_v2_supplier_payments(project_id,supplier_id,amount,effective_date,description,idempotency_key) VALUES(?,?,?,?,?,?)').run(projectId, supplier.id, amount, today(input.date), input.description || 'دفع للمورد', key);
    const owed = db.prepare("SELECT COALESCE(SUM(amount-paid_amount),0) total FROM fahima_v2_purchases WHERE project_id=? AND supplier_id=?").get(projectId, supplier.id).total;
    const paid = db.prepare('SELECT COALESCE(SUM(amount),0) total FROM fahima_v2_supplier_payments WHERE project_id=? AND supplier_id=?').get(projectId, supplier.id).total;
    return { id: Number(r.lastInsertRowid), supplier, amount, balance: Number(owed) - Number(paid), duplicate: false };
  });
  function balanceFor(projectId, customerId) {
    const opening = db.prepare("SELECT COALESCE(SUM(amount),0) AS balance FROM fahima_v2_opening_balances WHERE project_id=? AND kind='customer_receivable' AND party_id=?").get(projectId, customerId).balance;
    const sales = db.prepare("SELECT COALESCE(SUM(s.amount-s.paid_amount),0) AS balance FROM fahima_v2_sales s JOIN transactions t ON t.id=s.transaction_id WHERE s.project_id=? AND s.customer_id=? AND t.voided_at IS NULL").get(projectId, customerId).balance;
    const payments = db.prepare('SELECT COALESCE(SUM(amount),0) AS amount FROM fahima_v2_customer_payments WHERE project_id=? AND customer_id=?').get(projectId, customerId).amount;
    return Math.round((Number(opening) + Number(sales) - Number(payments)) * 100) / 100;
  }
  function summary(projectId, from = '0000-01-01', to = '9999-12-31') {
    const sales = db.prepare("SELECT COALESCE(SUM(s.amount),0) total,COALESCE(SUM(s.paid_amount),0) paid,COALESCE(SUM(s.quantity),0) quantity FROM fahima_v2_sales s JOIN transactions t ON t.id=s.transaction_id WHERE s.project_id=? AND t.voided_at IS NULL AND s.effective_date BETWEEN ? AND ?").get(projectId, from, to);
    const payments = db.prepare('SELECT COALESCE(SUM(amount),0) amount FROM fahima_v2_customer_payments WHERE project_id=? AND effective_date BETWEEN ? AND ?').get(projectId, from, to).amount;
    const cogs = db.prepare("SELECT COALESCE(SUM(CASE WHEN s.unit_cost IS NOT NULL THEN s.quantity*s.unit_cost ELSE 0 END),0) total, SUM(CASE WHEN s.unit_cost IS NULL THEN 1 ELSE 0 END) unknown_count FROM fahima_v2_sales s JOIN transactions t ON t.id=s.transaction_id WHERE s.project_id=? AND t.voided_at IS NULL AND s.effective_date BETWEEN ? AND ?").get(projectId, from, to);
    const expenses = db.prepare("SELECT COALESCE(SUM(amount),0) total FROM transactions WHERE project_id=? AND type='operating_expense' AND voided_at IS NULL AND date BETWEEN ? AND ?").get(projectId, from, to).total;
    const purchases = db.prepare('SELECT COALESCE(SUM(amount),0) total FROM fahima_v2_purchases WHERE project_id=? AND effective_date BETWEEN ? AND ?').get(projectId, from, to).total;
    const legacy = db.prepare("SELECT COALESCE(SUM(t.amount),0) other_income FROM transactions t LEFT JOIN fahima_v2_sales s ON s.transaction_id=t.id WHERE t.project_id=? AND t.type='income' AND t.voided_at IS NULL AND s.id IS NULL AND t.date BETWEEN ? AND ?").get(projectId, from, to);
    const balances = db.prepare('SELECT c.name,ROUND((SELECT COALESCE(SUM(ob.amount),0) FROM fahima_v2_opening_balances ob WHERE ob.project_id=c.project_id AND ob.kind=\'customer_receivable\' AND ob.party_id=c.id AND ob.effective_date<=?)+(SELECT COALESCE(SUM(s.amount-s.paid_amount),0) FROM fahima_v2_sales s JOIN transactions t ON t.id=s.transaction_id WHERE s.customer_id=c.id AND t.voided_at IS NULL AND s.effective_date<=?)-(SELECT COALESCE(SUM(p.amount),0) FROM fahima_v2_customer_payments p WHERE p.customer_id=c.id AND p.effective_date<=?),2) balance FROM fahima_v2_customers c WHERE c.project_id=? ORDER BY c.name').all(to, to, to, projectId).filter(row => Math.abs(row.balance) > 0.0001);
    const supplierDebts = db.prepare('SELECT s.name,ROUND((SELECT COALESCE(SUM(p.amount-p.paid_amount),0) FROM fahima_v2_purchases p WHERE p.supplier_id=s.id AND p.effective_date<=?)-(SELECT COALESCE(SUM(sp.amount),0) FROM fahima_v2_supplier_payments sp WHERE sp.supplier_id=s.id AND sp.effective_date<=?),2) balance FROM fahima_v2_suppliers s WHERE s.project_id=? ORDER BY s.name').all(to, to, projectId).filter(row => Math.abs(row.balance) > 0.0001);
    const inventoryRows = db.prepare('SELECT name,unit,current_quantity,unit_cost,CASE WHEN unit_cost IS NULL THEN NULL ELSE ROUND(current_quantity*unit_cost,2) END AS value FROM products WHERE project_id=? ORDER BY name').all(projectId);
    const invoicedSales = Number(sales.total);
    const grossProfit = Number(cogs.unknown_count) > 0 ? null : Math.round((invoicedSales - Number(cogs.total)) * 100) / 100;
    return { invoicedSales, cashCollected: Number(sales.paid) + Number(payments), otherIncome: Number(legacy.other_income), customerBalances: balances, totalOutstanding: Math.round(balances.reduce((n, row) => n + Number(row.balance), 0) * 100) / 100, supplierDebts, totalSupplierDebt: Math.round(supplierDebts.reduce((n, row) => n + Number(row.balance), 0) * 100) / 100, quantitySold: Number(sales.quantity), purchases: Number(purchases), cogs: Number(cogs.total), cogsComplete: Number(cogs.unknown_count) === 0, grossProfit, grossProfitStatus: Number(cogs.unknown_count) > 0 ? 'غير متاح: تكلفة بعض البضاعة غير معروفة.' : 'متاح', operatingExpenses: Number(expenses), netProfit: null, inventory: inventoryRows };
  }
  function customers(projectId) { return db.prepare('SELECT id,name FROM fahima_v2_customers WHERE project_id=? ORDER BY name').all(projectId).map(row => ({ ...row, balance: balanceFor(projectId, row.id) })); }
  function correctSale(projectId, saleId, changes, taskId) {
    const old = db.prepare('SELECT * FROM fahima_v2_sales WHERE project_id=? AND id=?').get(projectId, saleId);
    if (!old) throw new Error('البيعة مش موجودة.');
    const kind = changes.saleKind || old.sale_kind;
    const client = kind === 'credit' ? customer(projectId, changes.customerName) : null;
    db.prepare('UPDATE fahima_v2_sales SET sale_kind=?,customer_id=?,paid_amount=? WHERE id=? AND project_id=?').run(kind, client?.id || null, kind === 'cash' ? old.amount : 0, saleId, projectId);
    const after = db.prepare('SELECT * FROM fahima_v2_sales WHERE id=?').get(saleId);
    db.prepare('INSERT INTO fahima_v2_transaction_audit(project_id,transaction_id,action,before_json,after_json,reason,task_id) VALUES(?,?,?,?,?,?,?)').run(projectId, old.transaction_id, 'correct_sale', JSON.stringify(old), JSON.stringify(after), String(changes.reason || 'تصحيح حالة السداد'), taskId || null);
    return { corrected: true, saleId, saleKind: kind, balance: client ? balanceFor(projectId, client.id) : 0, taskId };
  }
  return { openingInventory, sale, payment, purchase, supplierPayment, summary, customers, balance: balanceFor, correctSale };
}
module.exports = { createLedgerService };
