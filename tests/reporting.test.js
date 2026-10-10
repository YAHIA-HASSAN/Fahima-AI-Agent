const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb } = require('./helpers');
const { createAgent } = require('../src/agent/agent');
const { createProjectRepository } = require('../src/database/repositories/project-repository');
const { createReportDataService } = require('../src/domain/reporting/report-data-service');
const { createArabicReportPdf } = require('../src/domain/reporting/pdf-report');
const { createTransactionService } = require('../src/domain/finance/transaction-service');
const { createInventoryService } = require('../src/domain/inventory/inventory-service');
const { createLedgerService } = require('../src/domain/finance/ledger-service');

test('report data is ledger-scoped and customer payments are not sales', async () => {
  const db = createTestDb();
  const projectId = Number(db.prepare('INSERT INTO projects(name) VALUES(?)').run('دكان عم حمدان').lastInsertRowid);
  db.prepare('INSERT INTO transactions(project_id,type,amount,date,description) VALUES(?,?,?,?,?)').run(projectId, 'income', 300, '2026-10-01', 'بيع سكر');
  db.prepare('INSERT INTO transactions(project_id,type,amount,date,description) VALUES(?,?,?,?,?)').run(projectId, 'operating_expense', 40, '2026-10-02', 'كهرباء');
  const config = { root: require('node:path').resolve(__dirname, '..') };
  const agent = createAgent({ db, config, model: { decide: async () => ({}) }, search: async () => ({ results: [] }) });
  const reports = createReportDataService({ db, ledger: agent.ledger, projects: createProjectRepository(db) });
  const report = reports.build(projectId, '2026-10-01', '2026-10-02');
  assert.equal(report.summary.invoicedSales, 0);
  assert.equal(report.summary.otherIncome, 300);
  assert.equal(report.summary.operatingExpenses, 40);
  assert.equal(report.totals.other_income.confirmed, 300);
  assert.equal(report.transactions.some(row => row.type === 'other_income'), true);
  assert.equal(report.transactions.some(row => row.description.includes('[')), false);
  db.close();
});

test('report renderer paginates a large Arabic ledger without exposing IDs', async () => {
  const transactions = Array.from({ length: 100 }, (_, index) => ({ date: '2026-10-01', typeLabel: 'مبيعات', description: `بيع سكر للزبون رقم ${index + 1} بوصف عربي طويل`, amount: 30 }));
  const pdf = await createArabicReportPdf({ project: { name: 'مشروع عربي' }, period: { from: '2026-10-01', to: '2026-10-31' }, hasActivity: true, summary: { invoicedSales: 3000, cashCollected: 3000, totalOutstanding: 0, cogs: 2000, operatingExpenses: 0, grossProfit: 1000 }, transactions, inventory: [], reconciliation: { warnings: [] } });
  assert.match(pdf.subarray(0, 8).toString(), /^%PDF-1\./);
  assert.ok(pdf.includes(Buffer.from('/ToUnicode')));
  assert.ok(pdf.includes(Buffer.from('/FontDescriptor')));
  assert.ok(pdf.includes(Buffer.from('/FontFile')));
  assert.equal(pdf.includes(Buffer.from('transaction-id')), false);
});

test('report renderer creates an Arabic PDF when the period has no transactions', async () => {
  const pdf = await createArabicReportPdf({
    project: { name: 'فهيمة - مشروع فارغ' },
    period: { from: '2026-10-01', to: '2026-10-10' },
    hasActivity: false,
    summary: { invoicedSales: 0, cashCollected: 0, totalOutstanding: 0, cogs: 0, operatingExpenses: 0, grossProfit: 0 },
    transactions: [],
    inventory: [],
    reconciliation: { warnings: [] },
  });
  assert.match(pdf.subarray(0, 8).toString(), /^%PDF-1\./);
  assert.ok(pdf.includes(Buffer.from('/FontFile')));
});

test('period report separates credit sales from collection of an opening customer debt', () => {
  const db = createTestDb();
  const projectId = Number(db.prepare('INSERT INTO projects(name) VALUES(?)').run('مشروع اختبار التحصيل').lastInsertRowid);
  const transactions = createTransactionService(db);
  const inventory = createInventoryService(db);
  const ledger = createLedgerService(db, transactions, inventory);
  ledger.openingInventory(projectId, { name: 'منتج', unit: 'قطعة', quantity: 20, unitCost: 10, date: '2026-09-01', idempotencyKey: 'opening-report' });
  ledger.sale(projectId, { productName: 'منتج', unit: 'قطعة', quantity: 4, unitPrice: 25, saleKind: 'credit', customerName: 'عم حمدان', date: '2026-09-20', description: 'دين سابق', idempotencyKey: 'old-debt' });
  ledger.sale(projectId, { productName: 'منتج', unit: 'قطعة', quantity: 1, unitPrice: 30, saleKind: 'credit', customerName: 'عم حمدان', date: '2026-10-01', description: 'بيع آجل جديد', idempotencyKey: 'current-sale' });
  ledger.payment(projectId, { customerName: 'عم حمدان', amount: 100, date: '2026-10-02', description: 'تحصيل الدين السابق', idempotencyKey: 'current-payment' });
  const reports = createReportDataService({ db, ledger, projects: createProjectRepository(db) });
  const report = reports.build(projectId, '2026-10-01', '2026-10-02');
  assert.equal(report.summary.invoicedSales, 30);
  assert.equal(report.summary.cashCollected, 100);
  assert.equal(report.summary.totalOutstanding, 30);
  assert.deepEqual(report.transactions.filter(row => row.type === 'income').map(row => row.amount), [30]);
  assert.deepEqual(report.transactions.filter(row => row.type === 'customer_payment').map(row => row.amount), [100]);
  db.close();
});

test('gross profit stays unavailable when a sold product has no known cost', () => {
  const db = createTestDb();
  const projectId = Number(db.prepare('INSERT INTO projects(name) VALUES(?)').run('مشروع تكلفة ناقصة').lastInsertRowid);
  const transactions = createTransactionService(db);
  const inventory = createInventoryService(db);
  db.prepare('INSERT INTO products(project_id,name,unit,current_quantity,unit_cost) VALUES(?,?,?,?,NULL)').run(projectId, 'صنف بلا تكلفة', 'قطعة', 5);
  const ledger = createLedgerService(db, transactions, inventory);
  ledger.sale(projectId, { productName: 'صنف بلا تكلفة', unit: 'قطعة', quantity: 1, unitPrice: 30, saleKind: 'cash', date: '2026-10-01', description: 'بيع', idempotencyKey: 'unknown-cost' });
  const summary = ledger.summary(projectId, '2026-10-01', '2026-10-01');
  assert.equal(summary.cogsComplete, false);
  assert.equal(summary.grossProfit, null);
  assert.equal(summary.inventory[0].value, null);
  db.close();
});

test('legacy collection rows are not counted or displayed as sales', () => {
  const db = createTestDb();
  const projectId = Number(db.prepare('INSERT INTO projects(name) VALUES(?)').run('مشروع بيانات قديمة').lastInsertRowid);
  db.prepare('INSERT INTO transactions(project_id,type,amount,date,description) VALUES(?,?,?,?,?)').run(projectId, 'income', 100, '2026-10-02', 'تحصيل دين عميل');
  const transactions = createTransactionService(db);
  const ledger = createLedgerService(db, transactions, createInventoryService(db));
  const reports = createReportDataService({ db, ledger, projects: createProjectRepository(db) });
  const report = reports.build(projectId, '2026-10-02', '2026-10-02');
  assert.equal(report.summary.invoicedSales, 0);
  assert.equal(report.summary.cashCollected, 0);
  assert.equal(report.transactions[0].type, 'other_income');
  assert.equal(report.totals.other_income.confirmed, 100);
  db.close();
});
