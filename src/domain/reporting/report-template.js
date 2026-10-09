const fs = require('node:fs');
const path = require('node:path');

const fontPath = path.resolve(__dirname, '../../../assets/fonts/NotoNaskhArabic-Regular.ttf');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function money(value) { return `${Number(value || 0).toLocaleString('ar-EG')} جنيه`; }
function dateLabel(value) { return String(value || '').split('-').reverse().join('/'); }

function reportHtml(report) {
  const font = fs.readFileSync(fontPath).toString('base64');
  const summary = report.summary || {};
  const cards = [
    ['المبيعات', summary.invoicedSales], ['الفلوس اللي اتحصلت', summary.cashCollected],
    ['الفلوس اللي عند الزباين', summary.totalOutstanding], ['المشتريات', summary.cogs],
    ['المصاريف', summary.operatingExpenses], ['المكسب من بيع البضاعة', summary.grossProfit],
  ].filter(([, value]) => value !== null && value !== undefined && Number(value) !== 0);
  const hasActivity = Boolean(report.hasActivity || report.transactions?.length);
  const quickSummary = hasActivity
    ? `الدكان باع بضاعة بقيمة ${money(summary.invoicedSales)}، اتحصل منها ${money(summary.cashCollected)}، ولسه فيه ${money(summary.totalOutstanding)} عند الزباين.`
    : 'مفيش عمليات متسجلة في الفترة دي.';
  const transactions = report.transactions || [];
  const inventory = report.inventory || [];
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>
@font-face{font-family:FahimaArabic;src:url(data:font/ttf;base64,${font}) format('truetype');font-weight:400;font-style:normal;font-display:swap}
@page{size:A4 portrait;margin:0}
*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;color:#233b34;font-family:FahimaArabic,'Noto Naskh Arabic',serif;direction:rtl;font-size:11pt;line-height:1.45}body{margin:16mm 14mm 18mm;print-color-adjust:exact;-webkit-print-color-adjust:exact}.report{width:100%}.header{background:#126b5b;color:#fff;padding:17mm 13mm 12mm;margin:-16mm -14mm 7mm;min-height:43mm}.header h1{font-size:25pt;font-weight:400;margin:0 0 5mm}.header .project{font-size:15pt}.period{color:#65756f;font-size:11pt;margin:0 0 5mm}.section-title{font-size:16pt;color:#126b5b;margin:6mm 0 3mm;border-bottom:1px solid #dbe9e3;padding-bottom:1mm}.cards{display:grid;grid-template-columns:1fr 1fr;gap:3mm;margin-bottom:4mm}.card{background:#e8f4ef;border-radius:2mm;padding:4mm 5mm;min-height:22mm;break-inside:avoid}.card .label{color:#65756f;font-size:10pt}.card .value{color:#126b5b;font-size:17pt;margin-top:1mm;direction:rtl;unicode-bidi:plaintext}.quick{font-size:11pt;margin:0 0 4mm}.warning{color:#9b5b00;font-size:9pt;margin:1mm 0}.transactions{width:100%;border-collapse:separate;border-spacing:0 1.5mm;table-layout:fixed}.transactions thead{display:table-header-group}.transactions th{background:#126b5b;color:#fff;font-weight:400;padding:2.5mm 3mm;font-size:10pt}.transactions th:first-child{width:20%}.transactions th:last-child{width:17%}.transactions td{background:#f7faf8;padding:2.5mm 3mm;vertical-align:top;overflow-wrap:anywhere}.transactions tr{break-inside:avoid}.transactions td.date{color:#65756f;white-space:nowrap;direction:ltr;text-align:right;font-size:9pt}.transactions td.amount{color:#126b5b;white-space:nowrap;text-align:right;direction:rtl;font-size:10pt}.inventory{margin-top:4mm}.inventory-row{display:flex;justify-content:space-between;border-bottom:1px solid #e8f0ec;padding:1.5mm 0;break-inside:avoid}.empty{color:#65756f;margin:4mm 0}.muted{color:#65756f;font-size:9pt}.avoid-break{break-inside:avoid}
</style></head><body><main class="report">
<header class="header"><h1>تقرير المشروع</h1><div class="project">فهيمة — ${escapeHtml(report.project?.name || '')}</div></header>
<p class="period">من ${escapeHtml(dateLabel(report.period?.from))} إلى ${escapeHtml(dateLabel(report.period?.to))}</p>
${cards.length ? `<section class="cards">${cards.map(([label, value]) => `<div class="card"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(money(value))}</div></div>`).join('')}</section>` : ''}
<section class="avoid-break"><h2 class="section-title">ملخص سريع</h2><p class="quick">${escapeHtml(quickSummary)}</p>${(report.reconciliation?.warnings || []).map(warning => `<p class="warning">تنبيه: ${escapeHtml(warning)}</p>`).join('')}</section>
<section><h2 class="section-title">تفاصيل العمليات</h2>${transactions.length ? `<table class="transactions"><thead><tr><th>التاريخ</th><th>العملية</th><th>المبلغ</th></tr></thead><tbody>${transactions.map(row => `<tr><td class="date">${escapeHtml(dateLabel(row.date))}</td><td>${escapeHtml(`${row.typeLabel || 'عملية'}: ${row.description || 'عملية مسجلة'}`)}</td><td class="amount">${escapeHtml(money(row.amount))}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">مفيش عمليات متسجلة في الفترة دي.</p>'}</section>
${inventory.length ? `<section class="inventory"><h2 class="section-title">البضاعة الموجودة</h2>${inventory.map(item => `<div class="inventory-row"><span>${escapeHtml(item.name)}</span><span>${escapeHtml(`${Number(item.current_quantity || 0).toLocaleString('ar-EG')} ${item.unit || ''}`)}</span></div>`).join('')}</section>` : ''}
</main></body></html>`;
}

module.exports = { reportHtml, escapeHtml };
