const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb } = require('./helpers');
const { createAgent } = require('../src/agent/agent');
const { createProjectRepository } = require('../src/database/repositories/project-repository');
const { createReportDataService } = require('../src/domain/reporting/report-data-service');
const { createArabicReportPdf } = require('../src/domain/reporting/pdf-report');

test('report data is ledger-scoped and customer payments are not sales', async () => {
  const db = createTestDb();
  const projectId = Number(db.prepare('INSERT INTO projects(name) VALUES(?)').run('دكان عم حمدان').lastInsertRowid);
  db.prepare('INSERT INTO transactions(project_id,type,amount,date,description) VALUES(?,?,?,?,?)').run(projectId, 'income', 300, '2026-10-01', 'بيع سكر');
  db.prepare('INSERT INTO transactions(project_id,type,amount,date,description) VALUES(?,?,?,?,?)').run(projectId, 'operating_expense', 40, '2026-10-02', 'كهرباء');
  const config = { root: require('node:path').resolve(__dirname, '..') };
  const agent = createAgent({ db, config, model: { decide: async () => ({}) }, search: async () => ({ results: [] }) });
  const reports = createReportDataService({ db, ledger: agent.ledger, projects: createProjectRepository(db) });
  const report = reports.build(projectId, '2026-10-01', '2026-10-02');
  assert.equal(report.summary.invoicedSales, 300);
  assert.equal(report.summary.operatingExpenses, 40);
  assert.equal(report.totals.income.confirmed, 300);
  assert.equal(report.transactions.some(row => row.type === 'customer_payment'), false);
  assert.equal(report.transactions.some(row => row.description.includes('[')), false);
  db.close();
});

test('report renderer paginates a large Arabic ledger without exposing IDs', async () => {
  const transactions = Array.from({ length: 100 }, (_, index) => ({ date: '2026-10-01', typeLabel: 'مبيعات', description: `بيع سكر للزبون رقم ${index + 1} بوصف عربي طويل`, amount: 30 }));
  const pdf = await createArabicReportPdf({ project: { name: 'مشروع عربي' }, period: { from: '2026-10-01', to: '2026-10-31' }, hasActivity: true, summary: { invoicedSales: 3000, cashCollected: 3000, totalOutstanding: 0, cogs: 2000, operatingExpenses: 0, grossProfit: 1000 }, transactions, inventory: [], reconciliation: { warnings: [] } });
  assert.match(pdf.subarray(0, 8).toString(), /^%PDF-1\./);
  assert.ok(pdf.includes(Buffer.from('/ToUnicode')));
  assert.ok(pdf.includes(Buffer.from('/FontDescriptor')));
  assert.ok(pdf.includes(Buffer.from('Noto Naskh Arabic')));
  assert.equal(pdf.includes(Buffer.from('transaction-id')), false);
});
