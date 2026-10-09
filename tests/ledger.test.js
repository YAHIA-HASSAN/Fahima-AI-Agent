const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb } = require('./helpers');
const { createTransactionService } = require('../src/domain/finance/transaction-service');
const { createInventoryService } = require('../src/domain/inventory/inventory-service');
const { createLedgerService } = require('../src/domain/finance/ledger-service');

test('grocery ledger keeps cash, credit, collection, inventory cost, and profit distinct', () => {
  const db = createTestDb();
  const projectId = Number(db.prepare('INSERT INTO projects(name) VALUES(?)').run('بقالة معزولة').lastInsertRowid);
  const transactions = createTransactionService(db);
  const inventory = createInventoryService(db);
  const ledger = createLedgerService(db, transactions, inventory);
  ledger.openingInventory(projectId, { name: 'سكر', unit: 'كجم', quantity: 500, unitCost: 27, date: '2026-10-10', idempotencyKey: 'opening-sugar' });
  ledger.sale(projectId, { productName: 'سكر', unit: 'كجم', quantity: 10, unitPrice: 30, saleKind: 'cash', date: '2026-10-10', description: 'بيع نقدي', idempotencyKey: 'sale-1' });
  ledger.sale(projectId, { productName: 'سكر', unit: 'كجم', quantity: 4, unitPrice: 30, saleKind: 'credit', customerName: 'زبون آخر', date: '2026-10-10', description: 'بيع آجل', idempotencyKey: 'sale-2' });
  const hamdan = ledger.sale(projectId, { productName: 'سكر', unit: 'كجم', quantity: 5, unitPrice: 32, saleKind: 'cash', date: '2026-10-10', description: 'بيع حمدان', idempotencyKey: 'sale-3' });
  ledger.correctSale(projectId, hamdan.id, { saleKind: 'credit', customerName: 'حمدان' }, 'correction-1');
  ledger.payment(projectId, { customerName: 'حمدان', amount: 100, date: '2026-10-10', description: 'تحصيل جزئي', idempotencyKey: 'payment-1' });
  const summary = ledger.summary(projectId, '2026-10-10', '2026-10-10');
  assert.equal(summary.invoicedSales, 580);
  assert.equal(summary.cashCollected, 400);
  assert.equal(summary.totalOutstanding, 180);
  assert.equal(summary.cogs, 513);
  assert.equal(summary.grossProfit, 67);
  assert.equal(summary.inventory[0].current_quantity, 481);
  assert.deepEqual(summary.customerBalances, [{ name: 'حمدان', balance: 60 }, { name: 'زبون آخر', balance: 120 }]);
  db.close();
});
