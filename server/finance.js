const TYPES = { income: 'مبيعات/إيرادات', stock_cost: 'مشتريات أو تكلفة إنتاج', operating_expense: 'مصروف تشغيل', withdrawal: 'مسحوبات للبيت' };
const ONES = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة'];
const TEENS = ['', 'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'];
const TENS = ['', 'عشرة', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
const HUNDREDS = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة'];

function normalizeDigits(text) {
  return String(text).replace(/[٠-٩۰-۹]/g, c => {
    const ar = '٠١٢٣٤٥٦٧٨٩'.indexOf(c);
    return String(ar >= 0 ? ar : '۰۱۲۳۴۵۶۷۸۹'.indexOf(c));
  });
}
function underThousand(value) {
  if (!value) return '';
  const parts = []; const hundreds = Math.floor(value / 100); const rest = value % 100;
  if (hundreds) parts.push(HUNDREDS[hundreds]);
  if (rest >= 11 && rest <= 19) parts.push(TEENS[rest - 10]);
  else if (rest >= 10) {
    if (rest % 10) parts.push(`${ONES[rest % 10]} و${TENS[Math.floor(rest / 10)]}`);
    else parts.push(TENS[rest / 10]);
  } else if (rest) parts.push(ONES[rest]);
  return parts.join(' و');
}
function scaledGroup(value, singular, dual, plural) {
  if (value === 1) return singular;
  if (value === 2) return dual;
  if (value >= 3 && value <= 10) return `${underThousand(value)} ${plural}`;
  return `${underThousand(value)} ${singular}ًا`;
}
function integerWords(input) {
  let n = Math.trunc(Math.abs(Number(input)));
  if (!Number.isSafeInteger(n) || n > 999999999) return String(input);
  if (n === 0) return 'صفر';
  const parts = [];
  const millions = Math.floor(n / 1000000); n %= 1000000;
  const thousands = Math.floor(n / 1000); n %= 1000;
  if (millions) parts.push(scaledGroup(millions, 'مليون', 'مليونان', 'ملايين'));
  if (thousands) parts.push(scaledGroup(thousands, 'ألف', 'ألفان', 'آلاف'));
  if (n) parts.push(underThousand(n));
  return `${Number(input) < 0 ? 'سالب ' : ''}${parts.join(' و')}`;
}
function numberToArabicWords(input) {
  const n = Number(input);
  if (!Number.isFinite(n)) return String(input);
  const rounded = Math.round(Math.abs(n) * 100) / 100;
  const whole = Math.floor(rounded); const cents = Math.round((rounded - whole) * 100);
  const sign = n < 0 ? 'سالب ' : '';
  return `${sign}${integerWords(whole)}${cents ? ` فاصلة ${integerWords(cents)}` : ''}`;
}
function speakableArabic(text) {
  return normalizeDigits(text).replace(/(?<![\p{L}])([+-]?\d[\d,٬]*(?:[.٫][\d]+)?)(?![\p{L}])/gu, value => {
    const normalized = normalizeDigits(value).replace(/٬/g, ',').replace(/,/g, '');
    return numberToArabicWords(normalized.replace('٫', '.'));
  });
}
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0,10) === value;
}
function validTransaction(x) {
  return Boolean(x && Object.hasOwn(TYPES,x.type) && typeof x.amount === 'number' && Number.isFinite(x.amount) && x.amount > 0 && validDate(x.date) && String(x.description || '').trim());
}
function summary(rows) {
  const result = { totals: {}, estimatedTotals: {}, counts: {}, saleCount: 0, sufficient: rows.length > 0, types: TYPES };
  for (const key of Object.keys(TYPES)) { result.totals[key] = 0; result.estimatedTotals[key] = 0; result.counts[key] = 0; }
  for (const row of rows) {
    const bucket = row.estimated ? result.estimatedTotals : result.totals;
    bucket[row.type] += row.amount; result.counts[row.type]++;
    if (row.type === 'income') result.saleCount++;
  }
  return result;
}
module.exports = { TYPES, normalizeDigits, numberToArabicWords, speakableArabic, validDate, validTransaction, summary };
