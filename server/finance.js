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
function parseArabicNumberWords(text) {
  const normalized = String(text).replace(/[ًٌٍَُِّْـ]/gu, '').replace(/[إأآ]/g, 'ا').replace(/ة/g, 'ه');
  const values = {صفر:0,واحد:1,واحدة:1,واحده:1,اتنين:2,اثنين:2,اثنان:2,تلاته:3,تلاتة:3,ثلاثه:3,ثلاثة:3,اربعه:4,اربعة:4,اربعه:4,اربعة:4,خمسه:5,خمسة:5,سته:6,ستة:6,سبعه:7,سبعة:7,تمانيه:8,تمانية:8,تمانيه:8,ثمانيه:8,ثمانية:8,تسعه:9,تسعة:9,عشره:10,عشرة:10,حداشر:11,احدعشر:11,اتناشر:12,اثناشر:12,تلتاشر:13,تلاتاشر:13,اربعتاشر:14,خمستاشر:15,ستاشر:16,سبعتاشر:17,تمنتاشر:18,تمانتاشر:18,تسعتاشر:19,عشرين:20,تلاتين:30,ثلاثين:30,اربعين:40,خمسين:50,ستين:60,سبعين:70,تمانين:80,ثمانين:80,تسعين:90,ميه:100,ميه:100,مائه:100,مئه:100,مئتان:200,ميتين:200,تلتميه:300,ثلاثمائه:300,تلاتميه:300,اربعمائه:400,ربعمية:400,خمسمائه:500,خمسمية:500,ستمائه:600,ستمية:600,سبعمائه:700,سبعمية:700,تمنميه:800,ثمانمائه:800,تمنمية:800,تسعمائه:900,تسعمية:900};
  let total=0, group=0, found=false;
  for(const original of normalized.split(/\s+/u)){
    const word=Object.hasOwn(values,original)?original:original.replace(/^[وبفلك]/u,'');
    if(word==='و'||word==='ب')continue;
    if(Object.hasOwn(values,word)){group+=values[word];found=true;continue;}
    if(/^(?:الفين|الفان)$/u.test(word)){total+=2000;group=0;found=true;continue;}
    if(/^(?:الف|الاف)$/u.test(word)){total+=(group||1)*1000;group=0;found=true;continue;}
    if(/^(?:مليونين|مليونان)$/u.test(word)){total+=2000000;group=0;found=true;continue;}
    if(/^مليون$/u.test(word)){total+=(group||1)*1000000;group=0;found=true;continue;}
    if(/^[0-9٠-٩۰-۹]+(?:[.,٫][0-9٠-٩۰-۹]+)?$/u.test(word)){group+=Number(normalizeDigits(word).replace(',', '.').replace('٫','.'));found=true;continue;}
    if(found)break;
  }
  return found?total+group:null;
}
function amountFromText(text) {
  const s=normalizeDigits(text).replace(/[,٬]/g,'');
  if(/نص\s+(?:ألف|الف|مليون)/u.test(s)) {
    const match=s.match(/نص\s+(?:ألف|الف|مليون)/u);
    if(match[0].includes('مليون'))return 500000;
    return 500;
  }
  const spoken=parseArabicNumberWords(s);
  if(spoken!==null&&Number.isFinite(spoken))return spoken;
  const match=s.match(/(?:حوالي\s*)?(\d+(?:\.\d+)?|ألفين|الفين|ألف|الف|مليون)/i);
  if(!match)return null;
  const word=match[1];
  if(/^ألفين|^الفين/.test(word))return 2000;
  if(/^ألف|^الف/.test(word))return 1000;
  if(/^مليون/.test(word))return 1000000;
  return Number(word);
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
function cairoDate(date = new Date()) {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  const fields=Object.fromEntries(parts.map(part=>[part.type,part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}
function localExtract(text) {
  const s = text.toLowerCase();
  let type = null;
  if (/بعت|بيع|مبيعات|دخل|إيراد|ايراد/.test(s)) type = 'income';
  else if (/علف|بضاعة|بضاعه|خامات|اشتريت|شراء|كتاكيت/.test(s)) type = 'stock_cost';
  else if (/للبيت|للمنزل|خدت|سحبت/.test(s)) type = 'withdrawal';
  else if (/كهربا|كهرباء|إيجار|ايجار|مياه|مواصلات|مصروف|دفعت/.test(s)) type = 'operating_expense';
  return { type, amount: amountFromText(text), date: cairoDate(), description: text.slice(0,180), estimated: /تقريب|تقريبًا|تقريبا|مش فاكر|مش فاكرة|يمكن/.test(s) };
}
function validTransaction(x) {
  if (!x || !TYPES[x.type] || !Number.isFinite(Number(x.amount)) || Number(x.amount) <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(x.date) || !String(x.description || '').trim()) return false;
  const parsed = new Date(`${x.date}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0,10) === x.date;
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
module.exports = { TYPES, normalizeDigits, amountFromText, numberToArabicWords, speakableArabic, localExtract, validTransaction, summary };
