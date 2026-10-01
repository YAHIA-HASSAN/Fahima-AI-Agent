const db = require('./db');
const { TYPES, summary, validDate, validTransaction } = require('./finance');

function cairoParts(date = new Date()) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date).map(part=>[part.type,part.value]));
}
function localDate(date = new Date()) {
  const {year,month,day}=cairoParts(date);
  return `${year}-${month}-${day}`;
}
function shiftCalendarDay(date, days) {
  const {year,month,day}=cairoParts(date);
  const shifted=new Date(Date.UTC(Number(year),Number(month)-1,Number(day)+days));
  return shifted.toISOString().slice(0,10);
}
function getProject(id) {
  const numericId = Number(id);
  if (!Number.isSafeInteger(numericId) || numericId < 1) return null;
  return db.prepare('SELECT * FROM projects WHERE id=?').get(numericId) || null;
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
  if (period === 'week') return { from: shiftCalendarDay(date,-6), to: end };
  if (period === 'month') return { from: `${end.slice(0,7)}-01`, to: end };
  if (period === 'all') return { from: '0001-01-01', to: end };
  return { from: end, to: end };
}
function getSummary(projectId, from, to) { return summary(getTransactions(projectId,from,to)); }
function formatSummary(s, periodLabel = 'الفترة') {
  const number=(value)=>Number(value||0).toLocaleString('ar-EG');
  if (!s.sufficient) return `مافيش عمليات متسجلة في ${periodLabel}، فمش عندي أرقام كفاية للملخص.`;
  return `في ${periodLabel}: دخل من البيع ${number(s.totals.income)} جنيه، وشراء بضاعة ${number(s.totals.stock_cost)} جنيه، ومصاريف ${number(s.totals.operating_expense)} جنيه. ${s.estimatedTotals.income||s.estimatedTotals.stock_cost||s.estimatedTotals.operating_expense?'فيه كمان أرقام تقديرية. ':''}دي الأرقام اللي اتسجلت بس؛ ماقدرش أحدد المكسب بدقة من غير تكلفة البضاعة اللي اتباعت.`;
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
  const x = { ...input, description: String(input.description || '').trim().slice(0,180) };
  const qty = x.quantity == null ? null : x.quantity;
  const hasDetails = qty !== null;
  if (hasDetails && (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0)) throw new Error('الكمية لازم تكون رقمًا أكبر من صفر.');
  if (hasDetails && (!x.productName || !x.unit)) throw new Error('راجعي اسم المنتج ووحدة الكمية.');
  if (hasDetails && !['income','stock_cost'].includes(x.type)) throw new Error('تفاصيل المخزون تخص البيع والشراء بس.');
  x.date = x.date || localDate();
  if (!validTransaction(x)) throw new Error('راجعي نوع العملية والمبلغ والتاريخ قبل التسجيل.');
  const unitPrice = hasDetails ? (x.unitPrice == null ? x.amount / qty : x.unitPrice) : null;
  if (hasDetails && (typeof unitPrice !== 'number' || !Number.isFinite(unitPrice) || unitPrice <= 0)) throw new Error('راجعي سعر الوحدة.');
  if (hasDetails && Math.abs(Math.round(qty * unitPrice * 100) - Math.round(x.amount * 100)) > 1) throw new Error('الإجمالي مختلف عن الكمية في سعر الوحدة. راجعي المبلغ.');
  // Keep the confirmed total; rounding an inferred unit price can change it.
  if (x.productName && !x.description.includes(x.productName)) x.description = `${x.productName}: ${x.description}`.slice(0,180);
  const transact = db.transaction(() => {
    let product = hasDetails ? findProduct(projectId,x.productName,x.unit) : null;
    if (hasDetails && !product && x.type === 'income') throw new Error('المنتج مش مضاف للمخزون. أضيفيه أولًا أو سجلي البيع من غير تحديث المخزون.');
    if (hasDetails && !product) product = createProduct(projectId,{name:x.productName,unit:x.unit,initialQuantity:0});
    if (product && x.type === 'income' && product.current_quantity < qty) throw new Error(`المخزون المسجل من ${product.name} هو ${product.current_quantity} ${product.unit}. قللي الكمية أو سجلي البيع من غير تحديث المخزون.`);
    const row = db.prepare('INSERT INTO transactions(project_id,type,amount,date,description,estimated) VALUES(?,?,?,?,?,?)').run(projectId,x.type,x.amount,x.date,x.description,x.estimated?1:0);
    if (product) {
      db.prepare('INSERT INTO transaction_items(transaction_id,product_id,quantity,unit,unit_price,line_total) VALUES(?,?,?,?,?,?)').run(row.lastInsertRowid,product.id,qty,product.unit,unitPrice,x.amount);
      const isSale = x.type === 'income';
      db.prepare('INSERT INTO inventory_movements(project_id,product_id,type,quantity,delta,reference_type,reference_id,description) VALUES(?,?,?,?,?,?,?,?)').run(projectId,product.id,isSale?'sale':'purchase',qty,isSale?-qty:qty,'transaction',row.lastInsertRowid,x.description);
      if (isSale) db.prepare("UPDATE products SET current_quantity=current_quantity-?,updated_at=datetime('now') WHERE id=? AND project_id=?").run(qty,product.id,projectId);
      else {
        const oldQty = product.current_quantity;
        // Unknown old costs remain unknown; do not silently value existing stock at zero.
        const avgCost = oldQty > 0 && product.unit_cost == null ? null : ((oldQty*(product.unit_cost || 0))+x.amount)/(oldQty+qty);
        db.prepare("UPDATE products SET current_quantity=current_quantity+?,unit_cost=?,updated_at=datetime('now') WHERE id=? AND project_id=?").run(qty,avgCost,product.id,projectId);
      }
    }
    return db.prepare('SELECT * FROM transactions WHERE id=? AND project_id=?').get(row.lastInsertRowid,projectId);
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
  if (!cleanTitle || !validDate(date)) throw new Error('راجعي عنوان التذكير وتاريخه.');
  return db.prepare('INSERT INTO reminders(project_id,title,due_at) VALUES(?,?,?)').run(projectId,cleanTitle,date);
}
function getReminders(projectId) {
  return db.prepare('SELECT * FROM reminders WHERE project_id=? AND completed=0 ORDER BY due_at,id').all(projectId);
}
module.exports = { db, TYPES, localDate, getProject, ensureConversation, getConversation, getTransactions, periodBounds, getSummary, formatSummary, getProducts, createProduct, findProduct, recordTransaction, adjustInventory, getProductSales, addReminder, getReminders };
