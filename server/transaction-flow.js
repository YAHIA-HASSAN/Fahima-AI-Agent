const { TYPES, validDate } = require('./finance');
const business = require('./business');

function parsePeriod(parsed) {
  if (!['today', 'week', 'month', 'all'].includes(parsed.period)) throw new Error('اختار الفترة: اليوم، الأسبوع، الشهر، أو كل الفترة.');
  return parsed.period;
}

function periodLabel(period) {
  return period === 'week' ? 'الأسبوع ده' : period === 'month' ? 'الشهر ده' : period === 'all' ? 'كل الفترة' : 'النهارده';
}

function mergePendingTransaction(pending, parsed) {
  const next = { ...pending };
  // A short reply answers the exact slot we just requested. Keep that link
  // deterministic; Gemini still decides whether this message belongs here.
  if (pending.waiting_for === 'unit_price' && parsed.amount != null && parsed.unit_price == null) {
    next.unitPrice = parsed.amount;
    next.amount = null;
    next.amountKind = 'unit_price';
  }
  if (parsed.unit_price == null && pending.amountKind === 'total' && (parsed.amount != null || parsed.quantity != null)) next.unitPrice = null;
  for (const [key, value] of Object.entries({
    type: parsed.transaction_type, amount: parsed.amount, date: parsed.date, description: parsed.description,
    estimated: parsed.estimated, productName: parsed.product_name, quantity: parsed.quantity, unit: parsed.unit,
    unitPrice: parsed.unit_price, amountKind: parsed.amount_kind,
  })) {
    if (pending.waiting_for === 'unit_price' && key === 'amount' && parsed.unit_price == null) continue;
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
  else if (item.quantity != null && item.amount == null && item.unitPrice == null) missing = 'unit_price';
  else if (item.quantity != null && item.amount != null && !item.amountKind && item.unitPrice == null) missing = 'amount_kind';
  else if (item.quantity != null && !item.productName) missing = 'product_name';
  else if (item.productName && item.quantity != null && !item.unit) missing = 'unit';
  else if (item.productName && item.quantity != null && (item.unitPrice == null || !Number.isFinite(item.unitPrice) || item.unitPrice <= 0)) missing = 'unit_price';
  else if (item.quantity != null && item.amountKind === 'total' && item.unitPrice != null && Math.abs(Math.round(item.quantity * item.unitPrice * 100) - Math.round(item.amount * 100)) > 1) missing = 'amount';
  else if (!Number.isFinite(Number(item.amount)) || Number(item.amount) <= 0) missing = 'amount';

  if (missing) {
    item.waiting_for = missing;
    const proposed=parsed.question;
    const question=proposed?.expected_field===missing?String(proposed.text||'').trim():'';
    const wellFormed=question&&(question.match(/[؟?]/gu)||[]).length===1;
    return { status: 'waiting_for_details', payload: item, reply: wellFormed?question:'محتاج أعرف معلومة واحدة كمان.' };
  }
  delete item.waiting_for;
  const product = item.productName ? ` ${[item.quantity, item.unit, item.productName].filter(value => value != null && value !== '').join(' ')}` : '';
  return { status: 'ready', payload: item, reply: `تمام، سجلت ${transactionKindLabel(item.type)}${product} بـ${Number(item.amount).toLocaleString('ar-EG')} جنيه.` };
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
    if (updated.status !== 'ready') return { status: 'waiting_for_details', payload: { transactions: batch, waitingIndex: startAt }, reply: `بالنسبة لـ${transactionKindLabel(item.type)}: ${updated.reply}` };
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
    if (normalized.status !== 'ready') return { status: 'waiting_for_details', payload: { transactions: batch, waitingIndex: index }, reply: `بالنسبة لـ${transactionKindLabel(item.type)}: ${normalized.reply}` };
  }
  const preview = batch.map((item, index) => `${index + 1}) ${transactionKindLabel(item.type)} ${[item.quantity, item.unit, item.productName].filter(value => value != null && value !== '').join(' ')}: ${Number(item.amount).toLocaleString('ar-EG')} جنيه`).join('، ');
  return { status: 'ready', payload: { transactions: batch }, reply: `تمام، سجلت العمليات دي: ${preview}.` };
}

module.exports = { parsePeriod, periodLabel, transactionKindLabel, transactionPending, transactionBatchPending };
