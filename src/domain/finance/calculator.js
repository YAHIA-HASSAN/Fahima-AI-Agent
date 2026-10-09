function moneyMinor(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('المبلغ لازم يكون أكبر من صفر.');
  return Math.round((amount + Number.EPSILON) * 100);
}
function revenue(quantity, unitPrice) {
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) throw new Error('الكمية أو سعر الوحدة غير صحيح.');
  return Math.round(quantity * unitPrice * 100) / 100;
}
function budget(items, capital, reserve = 0) {
  if (!Array.isArray(items) || !items.length) throw new Error('أضيفي بنود التكلفة قبل حساب الميزانية.');
  const rows = items.map(item => {
    if (!Number.isFinite(item.quantity) || item.quantity <= 0 || !Number.isFinite(item.unitCost) || item.unitCost < 0) throw new Error('كل بند يحتاج كمية وتكلفة صحيحتين.');
    return { ...item, totalCost: Math.round(item.quantity * item.unitCost * 100) / 100 };
  });
  if (!Number.isFinite(capital) || capital <= 0 || !Number.isFinite(reserve) || reserve < 0) throw new Error('رأس المال أو الاحتياطي غير صحيح.');
  const required = rows.reduce((sum, row) => sum + row.totalCost, 0) + reserve;
  return { items: rows, subtotal: Math.round((required - reserve) * 100) / 100, reserve, total: Math.round(required * 100) / 100, capital, remaining: Math.round((capital - required) * 100) / 100, withinCapital: required <= capital };
}
module.exports = { moneyMinor, revenue, budget };
