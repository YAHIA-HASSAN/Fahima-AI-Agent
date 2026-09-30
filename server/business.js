const db = require('./db');
const { TYPES, summary, validTransaction } = require('./finance');

function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
function getProject(id) {
  const numericId = Number(id || 1);
  let project = db.prepare('SELECT * FROM projects WHERE id=?').get(numericId);
  if (!project && numericId === 1) {
    const result = db.prepare("INSERT INTO projects(name) VALUES ('مشروعي')").run();
    project = db.prepare('SELECT * FROM projects WHERE id=?').get(result.lastInsertRowid);
  }
  return project || null;
}
function ensureConversation(projectId) {
  let row = db.prepare('SELECT * FROM conversations WHERE project_id=? ORDER BY updated_at DESC,id DESC LIMIT 1').get(projectId);
  if (!row) {
    const result = db.prepare('INSERT INTO conversations(project_id,title) VALUES(?,?)').run(projectId,'محادثة المشروع');
    row = db.prepare('SELECT * FROM conversations WHERE id=?').get(result.lastInsertRowid);
  }
  return row;
}
function getConversation(projectId, conversationId) {
  if (!conversationId) return ensureConversation(projectId);
  return db.prepare('SELECT * FROM conversations WHERE id=? AND project_id=?').get(Number(conversationId),projectId) || null;
}
function getTransactions(projectId, from, to) {
  return db.prepare('SELECT * FROM transactions WHERE project_id=? AND date>=? AND date<=? ORDER BY date DESC,id DESC').all(projectId,from,to);
}
function periodBounds(period = 'today', date = new Date()) {
  const end = localDate(date);
  if (period === 'week') { const start = new Date(date); start.setDate(start.getDate()-6); return { from: localDate(start), to: end }; }
  if (period === 'month') return { from: `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-01`, to: end };
  if (period === 'all') return { from: '0001-01-01', to: end };
  return { from: end, to: end };
}
function getSummary(projectId, from, to) { return summary(getTransactions(projectId,from,to)); }
function formatSummary(s, periodLabel = 'الفترة') {
  if (!s.sufficient) return `مافيش معاملات مسجلة في ${periodLabel}، فمش عندي أرقام كفاية للملخص.`;
  return `في ${periodLabel} سجلنا مبيعات بـ${s.totals.income} جنيه${s.estimatedTotals.income ? `، ومبيعات تقديرية بـ${s.estimatedTotals.income} جنيه` : ''} من ${s.saleCount} عملية بيع. المشتريات أو الإنتاج المسجل ${s.totals.stock_cost} جنيه، ومصاريف التشغيل ${s.totals.operating_expense} جنيه${s.estimatedTotals.stock_cost || s.estimatedTotals.operating_expense ? '، وفيه كمان مبالغ تقديرية' : ''}. دي مجاميع المسجل فقط، ومش حساب ربح.`;
}
function getProducts(projectId) {
  return db.prepare('SELECT * FROM products WHERE project_id=? ORDER BY name COLLATE NOCASE').all(projectId);
}
function createProduct(projectId, input) {
  const name = String(input.name || '').trim().slice(0,100);
  const unit = String(input.unit || '').trim().slice(0,40);
  const initial = Number(input.initialQuantity || 0);
  const threshold = input.lowStockThreshold === '' || input.lowStockThreshold == null ? null : Number(input.lowStockThreshold);
  const unitCost = input.unitCost === '' || input.unitCost == null ? null : Number(input.unitCost);
  const markup = input.markupPercent === '' || input.markupPercent == null ? null : Number(input.markupPercent);
  if (!name || !unit || !Number.isFinite(initial) || initial < 0 || (threshold !== null && (!Number.isFinite(threshold)||threshold<0)) || (unitCost !== null && (!Number.isFinite(unitCost)||unitCost<0)) || (markup !== null && (!Number.isFinite(markup)||markup<0||markup>1000))) throw new Error('راجعي اسم المنتج والوحدة والكميات والأسعار.');
  const transact = db.transaction(() => {
    const result = db.prepare('INSERT INTO products(project_id,name,unit,initial_quantity,current_quantity,low_stock_threshold,unit_cost,markup_percent) VALUES(?,?,?,?,?,?,?,?)').run(projectId,name,unit,initial,initial,threshold,unitCost,markup);
    if (initial > 0) db.prepare('INSERT INTO inventory_movements(project_id,product_id,type,quantity,delta,description) VALUES(?,?,?,?,?,?)').run(projectId,result.lastInsertRowid,'adjustment',initial,initial,'رصيد البداية');
    return db.prepare('SELECT * FROM products WHERE id=?').get(result.lastInsertRowid);
  });
  return transact();
}
function findProduct(projectId, name, unit) {
  if (!name) return null;
  if (unit) return db.prepare('SELECT * FROM products WHERE project_id=? AND name=? COLLATE NOCASE AND unit=? COLLATE NOCASE').get(projectId,String(name).trim(),String(unit).trim());
  return db.prepare('SELECT * FROM products WHERE project_id=? AND name=? COLLATE NOCASE ORDER BY id DESC LIMIT 1').get(projectId,String(name).trim());
}
function recordTransaction(projectId, input) {
  const x = { ...input, amount: Number(input.amount), description: String(input.description || '').trim().slice(0,180) };
  let product = x.productName && x.quantity!=null ? findProduct(projectId,x.productName,x.unit) : null;
  const qty = x.quantity == null ? null : Number(x.quantity);
  let unitPrice = x.unitPrice == null ? null : Number(x.unitPrice);
  // If the confirmed total and quantity are known, derive the per-unit amount locally.
  if (unitPrice == null && Number.isFinite(qty) && qty > 0 && Number.isFinite(x.amount) && x.amount > 0) unitPrice = Math.round((x.amount / qty) * 100) / 100;
  if (x.productName && x.quantity!=null && x.type === 'stock_cost' && !product) {
    product = createProduct(projectId,{name:x.productName,unit:x.unit || 'وحدة',initialQuantity:0});
  }
  const itemized = Boolean(product && qty !== null && Number.isFinite(qty) && qty > 0 && unitPrice !== null && Number.isFinite(unitPrice) && unitPrice >= 0);
  if (x.productName && x.quantity!=null && x.type === 'income' && !product) throw new Error('المنتج مش مضاف للمخزون. أضيفيه أولًا أو سجلي البيع من غير تحديث المخزون.');
  if (x.productName && (!Number.isFinite(qty) || qty <= 0)) throw new Error('الكمية لازم تكون رقمًا أكبر من صفر.');
  if (product && x.unit && String(x.unit).toLowerCase() !== String(product.unit).toLowerCase()) throw new Error(`وحدة ${product.name} المسجلة هي ${product.unit}. راجعي الوحدة قبل التسجيل.`);
  if (itemized) x.amount = Math.round(qty * unitPrice * 100) / 100;
  x.date = x.date || localDate();
  if (!validTransaction(x)) throw new Error('راجعي نوع العملية والمبلغ والتاريخ قبل التسجيل.');
  const transact = db.transaction(() => {
    let activeProduct = product;
    if (itemized && x.productName && x.type === 'stock_cost' && !activeProduct) activeProduct = createProduct(projectId,{name:x.productName,unit:x.unit||'وحدة',initialQuantity:0});
    if (itemized && activeProduct && x.type === 'income' && activeProduct.current_quantity < qty) throw new Error(`المخزون المسجل من ${activeProduct.name} هو ${activeProduct.current_quantity} ${activeProduct.unit}. قللي الكمية أو سجلي البيع من غير تحديث المخزون.`);
    const row = db.prepare('INSERT INTO transactions(project_id,type,amount,date,description,estimated) VALUES(?,?,?,?,?,?)').run(projectId,x.type,x.amount,x.date,x.description,x.estimated?1:0);
    if (itemized && activeProduct) {
      const total = Math.round(qty * unitPrice * 100) / 100;
      db.prepare('INSERT INTO transaction_items(transaction_id,product_id,quantity,unit,unit_price,line_total) VALUES(?,?,?,?,?,?)').run(row.lastInsertRowid,activeProduct.id,qty,activeProduct.unit,unitPrice,total);
      const isSale = x.type === 'income'; const delta = isSale ? -qty : qty;
      if (isSale || x.type === 'stock_cost') {
        db.prepare('INSERT INTO inventory_movements(project_id,product_id,type,quantity,delta,reference_type,reference_id,description) VALUES(?,?,?,?,?,?,?,?)').run(projectId,activeProduct.id,isSale?'sale':'purchase',qty,delta,'transaction',row.lastInsertRowid,x.description);
        if (isSale) db.prepare('UPDATE products SET current_quantity=current_quantity-?,updated_at=datetime(\'now\') WHERE id=?').run(qty,activeProduct.id);
        else {
          const oldQty = activeProduct.current_quantity; const oldCost = activeProduct.unit_cost || 0;
          const avgCost = oldQty + qty > 0 ? ((oldQty*oldCost)+(qty*unitPrice))/(oldQty+qty) : unitPrice;
          db.prepare('UPDATE products SET current_quantity=current_quantity+?,unit_cost=?,updated_at=datetime(\'now\') WHERE id=?').run(qty,avgCost,activeProduct.id);
        }
      }
    }
    return db.prepare('SELECT * FROM transactions WHERE id=?').get(row.lastInsertRowid);
  });
  return transact();
}
function adjustInventory(projectId, productId, target, description = 'تسوية يدوية') {
  const quantity = Number(target); if (!Number.isFinite(quantity)||quantity<0) throw new Error('اكتبي كمية صحيحة تساوي صفر أو أكثر.');
  const transact = db.transaction(() => {
    const product = db.prepare('SELECT * FROM products WHERE id=? AND project_id=?').get(productId,projectId);
    if (!product) throw new Error('المنتج غير موجود في المشروع.');
    const delta = Math.round((quantity-product.current_quantity)*10000)/10000;
    if (delta) {
      db.prepare('INSERT INTO inventory_movements(project_id,product_id,type,quantity,delta,description) VALUES(?,?,?,?,?,?)').run(projectId,product.id,'adjustment',Math.abs(delta),delta,String(description).slice(0,180));
      db.prepare('UPDATE products SET current_quantity=?,updated_at=datetime(\'now\') WHERE id=?').run(quantity,product.id);
    }
    return db.prepare('SELECT * FROM products WHERE id=?').get(product.id);
  });
  return transact();
}
function getProductSales(projectId, from, to) {
  return db.prepare(`SELECT p.id,p.name,p.unit,SUM(i.quantity) AS quantity,COUNT(DISTINCT t.id) AS sale_count,
    SUM(i.line_total) AS sales_amount FROM transaction_items i
    JOIN transactions t ON t.id=i.transaction_id AND t.type='income' AND t.date>=? AND t.date<=?
    JOIN products p ON p.id=i.product_id WHERE p.project_id=? GROUP BY p.id ORDER BY quantity DESC`).all(from,to,projectId);
}
function addReminder(projectId, title, dueAt) {
  const cleanTitle=String(title||'').trim().slice(0,160); const date=String(dueAt||'');
  if (!cleanTitle || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('راجعي عنوان التذكير وتاريخه.');
  return db.prepare('INSERT INTO reminders(project_id,title,due_at) VALUES(?,?,?)').run(projectId,cleanTitle,date);
}
function getReminders(projectId) {
  return db.prepare('SELECT * FROM reminders WHERE project_id=? AND completed=0 ORDER BY due_at,id').all(projectId);
}
module.exports = { db, TYPES, localDate, getProject, ensureConversation, getConversation, getTransactions, periodBounds, getSummary, formatSummary, getProducts, createProduct, findProduct, recordTransaction, adjustInventory, getProductSales, addReminder, getReminders };
