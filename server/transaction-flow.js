const { TYPES, validDate } = require('./finance');
const business = require('./business');

function parsePeriod(parsed) {
  if (!['today', 'week', 'month', 'all'].includes(parsed.period)) throw new Error('اختار الفترة: اليوم، الأسبوع، الشهر، أو كل الفترة.');
  return parsed.period;
}

function periodLabel(period) {
  return period === 'week' ? 'الأسبوع ده' : period === 'month' ? 'الشهر ده' : period === 'all' ? 'كل الفترة' : 'النهارده';
}

function questionForPending(pending) {
  return ({
    transaction_type: 'دي كانت فلوس بيع، ولا شراء بضاعة، ولا مصروف؟', amount: 'المبلغ كام بالجنيه؟',
    product_name: 'اسم البضاعة إيه؟', quantity: 'الكمية كام؟', unit: 'وحدة الكمية إيه؟',
    date: 'تاريخ العملية إيه؟', amount_kind: 'المبلغ ده إجمالي العملية ولا سعر الوحدة؟',
    unit_price: 'سعر الوحدة كام؟', due_date: 'تحب أذكرك إمتى؟', reminder_title: 'أفكرك تعملي إيه؟',
    markup_percent: 'تحب تزودي كام على التكلفة؟',
  })[pending.waiting_for] || 'ممكن توضحيلي حاجة واحدة كمان؟';
}

function mergePendingTransaction(pending, parsed) {
  const next = { ...pending };
  if (parsed.unit_price == null && pending.amountKind === 'total' && (parsed.amount != null || parsed.quantity != null)) next.unitPrice = null;
  for (const [key, value] of Object.entries({
    type: parsed.transaction_type, amount: parsed.amount, date: parsed.date, description: parsed.description,
    estimated: parsed.estimated, productName: parsed.product_name, quantity: parsed.quantity, unit: parsed.unit,
    unitPrice: parsed.unit_price, amountKind: parsed.amount_kind,
  })) {
    if (value !== null && value !== undefined && value !== '' && !(key === 'estimated' && value === false)) next[key] = value;
  }
  delete next.waiting_for;
  return next;
}

function transactionFromAgent(item, fallbackDescription = '') {
  return {
    transaction_type: item.transaction_type, amount: item.amount, amount_kind: item.amount_kind,
    date: item.date, period: 'today', description: item.description || fallbackDescription,
    estimated: item.estimated, product_name: item.product_name, quantity: item.quantity,
    unit: item.unit, unit_price: item.unit_price,
  };
}

function transactionKindLabel(type) {
  return ({ income: 'بيع', stock_cost: 'شراء بضاعة', operating_expense: 'مصروف', withdrawal: 'سحب للبيت' })[type] || 'عملية';
}

function transactionPending(parsed, existing, raw) {
  const item = existing?.action_type === 'transaction' ? mergePendingTransaction(existing.payload, parsed) : {
    type: parsed.transaction_type, amount: parsed.amount, date: parsed.date, description: parsed.description || raw,
    estimated: parsed.estimated, productName: parsed.product_name, quantity: parsed.quantity, unit: parsed.unit,
    unitPrice: parsed.unit_price, amountKind: parsed.amount_kind,
  };
  if (!item.date) item.date = business.localDate();
  if (!item.description) item.description = raw;
  if (item.amountKind === 'unit_price' && item.quantity && item.amount != null && item.unitPrice == null) {
    item.unitPrice = item.amount;
    item.amount = null;
  }
  if (item.quantity && item.amount != null && item.unitPrice == null && item.amountKind === 'total') item.unitPrice = Number(item.amount) / Number(item.quantity);
  if (item.quantity && item.unitPrice != null && item.amountKind !== 'total') item.amount = Math.round(Number(item.quantity) * Number(item.unitPrice) * 100) / 100;

  let missing = null;
  if (!Object.hasOwn(TYPES, item.type)) missing = 'transaction_type';
  else if (!validDate(item.date)) missing = 'date';
  else if (item.quantity != null && (!Number.isFinite(item.quantity) || item.quantity <= 0)) missing = 'quantity';
  else if (item.amountKind === 'unit_price' && item.quantity == null) missing = 'quantity';
  else if (item.quantity != null && item.amount != null && !item.amountKind && item.unitPrice == null) missing = 'amount_kind';
  else if (item.quantity != null && !item.productName) missing = 'product_name';
  else if (item.productName && item.quantity != null && !item.unit) missing = 'unit';
  else if (item.productName && item.quantity != null && (item.unitPrice == null || !Number.isFinite(item.unitPrice) || item.unitPrice <= 0)) missing = 'unit_price';
  else if (item.quantity != null && item.amountKind === 'total' && item.unitPrice != null && Math.abs(Math.round(item.quantity * item.unitPrice * 100) - Math.round(item.amount * 100)) > 1) missing = 'amount';
  else if (!Number.isFinite(Number(item.amount)) || Number(item.amount) <= 0) missing = 'amount';

  if (missing) {
    item.waiting_for = missing;
    return { status: 'waiting_for_details', payload: item, reply: questionForPending(item) };
  }
  delete item.waiting_for;
  const product = item.productName ? ` ${[item.quantity, item.unit, item.productName].filter(value => value != null && value !== '').join(' ')}` : '';
  return { status: 'awaiting_confirmation', payload: item, reply: `فهمت: ${transactionKindLabel(item.type)}${product} بـ${Number(item.amount).toLocaleString('ar-EG')} جنيه. أسجلها؟ قول «أيوه» أو «إلغاء».` };
}

function transactionBatchPending(items, active, raw, followup = null) {
  const batch = active?.action_type === 'transaction_batch'
    ? [...(active.payload.transactions || [])]
    : items.map(item => transactionPending(transactionFromAgent(item, transactionKindLabel(item.transaction_type)), null, '').payload);
  let startAt = 0;
  if (active?.action_type === 'transaction_batch' && active.status === 'waiting_for_details') {
    startAt = Math.max(0, Math.min(Number(active.payload.waitingIndex) || 0, batch.length - 1));
    const item = batch[startAt];
    const updated = transactionPending({
      transaction_type: followup?.transaction_type ?? item.type, amount: followup?.amount ?? item.amount,
      amount_kind: followup?.amount_kind ?? item.amountKind, date: followup?.date ?? item.date,
      period: 'today', description: followup?.description || item.description, estimated: followup?.estimated ?? item.estimated,
      product_name: followup?.product_name ?? item.productName, quantity: followup?.quantity ?? item.quantity,
      unit: followup?.unit ?? item.unit, unit_price: followup?.unit_price ?? item.unitPrice,
    }, { action_type: 'transaction', payload: item }, raw);
    batch[startAt] = updated.payload;
    if (updated.status !== 'awaiting_confirmation') return { status: 'waiting_for_details', payload: { transactions: batch, waitingIndex: startAt }, reply: `بالنسبة لـ${transactionKindLabel(item.type)}: ${updated.reply}` };
    startAt += 1;
  }
  for (let index = startAt; index < batch.length; index += 1) {
    const item = batch[index];
    const normalized = transactionPending({
      transaction_type: item.type, amount: item.amount, amount_kind: item.amountKind, date: item.date,
      period: 'today', description: item.description, estimated: item.estimated, product_name: item.productName,
      quantity: item.quantity, unit: item.unit, unit_price: item.unitPrice,
    }, { action_type: 'transaction', payload: item }, '');
    batch[index] = normalized.payload;
    if (normalized.status !== 'awaiting_confirmation') return { status: 'waiting_for_details', payload: { transactions: batch, waitingIndex: index }, reply: `بالنسبة لـ${transactionKindLabel(item.type)}: ${normalized.reply}` };
  }
  const preview = batch.map((item, index) => `${index + 1}) ${transactionKindLabel(item.type)} ${[item.quantity, item.unit, item.productName].filter(value => value != null && value !== '').join(' ')}: ${Number(item.amount).toLocaleString('ar-EG')} جنيه`).join('، ');
  return { status: 'awaiting_confirmation', payload: { transactions: batch }, reply: `فهمت العمليات دي: ${preview}. أحفظهم كلهم؟ قول «أيوه» أو «إلغاء».` };
}

module.exports = { parsePeriod, periodLabel, transactionKindLabel, transactionPending, transactionBatchPending };
