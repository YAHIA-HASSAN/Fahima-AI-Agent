const PdfPrinter = require('pdfmake-rtl/js/Printer').default;
const fs = require('node:fs');
const path = require('node:path');

const fontPath = path.resolve(__dirname, '../../../assets/fonts/Cairo/Cairo-Regular.ttf');

function formatMoney(value) {
  const amount = Number(value);
  if (value === null || value === undefined || !Number.isFinite(amount)) return 'غير متاح';
  return `${amount.toLocaleString('en-US')} جنيه`;
}
function formatDate(value) { const [year, month, day] = String(value || '').split('-'); return year && month && day ? `${year}/${month}/${day}` : String(value || ''); }
function directionalRuns(value) {
  const source = String(value ?? '');
  const matches = [...source.matchAll(/[0-9٠-٩]+(?:[٬,./:-][0-9٠-٩]+)*/gu)];
  if (!matches.length) return source;
  const runs = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.index > cursor) {
      const plain = source.slice(cursor, match.index);
      runs.push({ text: plain, direction: /[\u0600-\u06ff]/u.test(plain) ? 'rtl' : 'ltr' });
    }
    runs.push({ text: match[0], direction: 'ltr' });
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) {
    const plain = source.slice(cursor);
    runs.push({ text: plain, direction: /[\u0600-\u06ff]/u.test(plain) ? 'rtl' : 'ltr' });
  }
  return runs;
}
function text(value, style = {}) { return { text: directionalRuns(value), ...style }; }

function documentDefinition(report) {
  const summary = report.summary || {};
  const cards = [['المبيعات', summary.invoicedSales], ['الفلوس اللي اتحصلت', summary.cashCollected], ['الفلوس اللي عند الزباين', summary.totalOutstanding], ['المشتريات', summary.purchases], ['تكلفة البضاعة المباعة', summary.cogsComplete === false ? null : summary.cogs], ['المصاريف', summary.operatingExpenses], ['المكسب من بيع البضاعة', summary.grossProfit]].filter(([, value]) => value !== null && value !== undefined && Number(value) !== 0);
  const transactions = report.transactions || [];
  const inventory = report.inventory || [];
  const content = [{ table: { widths: ['*', '*'], body: [[text('تقرير المشروع', { style: 'headerTitle' }), text(`فهيمة — ${report.project?.name || ''}`, { style: 'headerProject' })]] }, layout: { fillColor: () => '#126b5b', hLineWidth: () => 0, vLineWidth: () => 0 }, margin: [0, 0, 0, 18] }, text(`من ${formatDate(report.period?.from)} إلى ${formatDate(report.period?.to)}`, { style: 'period', margin: [0, 0, 0, 12] })];
  if (cards.length) content.push({ table: { widths: ['*', '*'], body: cards.reduce((rows, card, index) => { if (index % 2 === 0) rows.push([]); rows[rows.length - 1].push({ stack: [text(card[0], { style: 'cardLabel' }), text(formatMoney(card[1]), { style: 'cardValue' })], style: 'card' }); if (index % 2 === 0 && index === cards.length - 1) rows[rows.length - 1].push(''); return rows; }, []) }, layout: { fillColor: () => '#e8f4ef', hLineWidth: () => 4, vLineWidth: () => 4, hLineColor: () => '#ffffff', vLineColor: () => '#ffffff' }, margin: [0, 0, 0, 14] });
  const quickSummary = report.hasActivity || transactions.length ? `المبيعات خلال الفترة ${formatMoney(summary.invoicedSales)}، والفلوس اللي اتحصلت خلالها ${formatMoney(summary.cashCollected)}، ولسه فيه ${formatMoney(summary.totalOutstanding)} عند الزباين.` : 'مفيش عمليات متسجلة في الفترة دي.';
  content.push(text('ملخص سريع', { style: 'sectionTitle', margin: [0, 8, 0, 4] }), text(quickSummary, { style: 'body', margin: [0, 0, 0, 6] }));
  if (summary.grossProfit === null || summary.cogsComplete === false) content.push(text('المكسب لسه مش متاح لأن تكلفة بعض البضاعة مش معروفة.', { style: 'warning' }));
  for (const warning of report.reconciliation?.warnings || []) content.push(text(`تنبيه: ${warning}`, { style: 'warning' }));
  content.push(text('تفاصيل العمليات', { style: 'sectionTitle', margin: [0, 12, 0, 5] }));
  if (transactions.length) content.push({ table: { headerRows: 1, widths: [75, '*', 90], body: [[text('التاريخ', { style: 'tableHeader' }), text('العملية', { style: 'tableHeader' }), text('المبلغ', { style: 'tableHeader' })], ...transactions.map(row => [text(formatDate(row.date), { style: 'dateCell' }), text(`${row.typeLabel || 'عملية'}: ${row.description || 'عملية مسجلة'}`, { style: 'cell' }), text(formatMoney(row.amount), { style: 'amountCell' })]) ] }, layout: { fillColor: row => row === 0 ? '#126b5b' : '#f7faf8', hLineColor: () => '#dbe9e3', vLineColor: () => '#ffffff', hLineWidth: () => 1, vLineWidth: () => 2, paddingLeft: () => 7, paddingRight: () => 7, paddingTop: () => 6, paddingBottom: () => 6 } });
  else content.push(text('مفيش عمليات متسجلة في الفترة دي.', { style: 'muted', margin: [0, 0, 0, 10] }));
  if (inventory.length) { content.push(text('البضاعة الموجودة', { style: 'sectionTitle', margin: [0, 14, 0, 5] })); content.push({ table: { widths: ['*', 120], body: inventory.map(item => [text(item.name, { style: 'cell' }), text(`${Number(item.current_quantity).toLocaleString('en-US')} ${item.unit || ''}`, { style: 'amountCell' })]) }, layout: { hLineColor: () => '#e8f0ec', vLineWidth: () => 0, paddingTop: () => 5, paddingBottom: () => 5 } }); }
  return { rtl: true, pageSize: 'A4', pageMargins: [42, 42, 42, 48], defaultStyle: { font: 'FahimaArabic', fontSize: 10, color: '#233b34', alignment: 'right', lineHeight: 1.25 }, styles: { headerTitle: { color: '#ffffff', fontSize: 23, bold: true, margin: [18, 20, 18, 4] }, headerProject: { color: '#ffffff', fontSize: 14, margin: [18, 0, 18, 20] }, period: { color: '#65756f', fontSize: 10 }, card: { margin: [4, 5, 4, 5], padding: [9, 7, 9, 7], minHeight: 48 }, cardLabel: { color: '#65756f', fontSize: 9 }, cardValue: { color: '#126b5b', fontSize: 15, margin: [0, 3, 0, 0] }, sectionTitle: { color: '#126b5b', fontSize: 14, bold: true }, body: { fontSize: 10 }, warning: { color: '#9b5b00', fontSize: 9 }, tableHeader: { color: '#ffffff', fontSize: 9, bold: true }, cell: { fontSize: 9 }, dateCell: { fontSize: 8, color: '#65756f', alignment: 'left' }, amountCell: { fontSize: 9, color: '#126b5b', alignment: 'right' }, muted: { color: '#65756f', fontSize: 10 } }, footer: (currentPage, pageCount) => ({ columns: [text('تم إعداد التقرير بواسطة فهيمة', { fontSize: 8, color: '#65756f', alignment: 'left' }), text(`صفحة ${currentPage} من ${pageCount}`, { fontSize: 8, color: '#65756f', alignment: 'right' })], margin: [42, 10, 42, 0] }), content, info: { title: `تقرير فهيمة — ${report.project?.name || ''}`, author: 'فهيمة' } };
}

function streamToBuffer(stream) { return new Promise((resolve, reject) => { const chunks = []; stream.on('data', chunk => chunks.push(Buffer.from(chunk))); stream.on('end', () => resolve(Buffer.concat(chunks))); stream.on('error', reject); }); }
async function createArabicReportPdf(report) { if (!fs.existsSync(fontPath)) throw Object.assign(new Error('خط التقرير العربي غير موجود.'), { code: 'PDF_FONT_UNAVAILABLE' }); const printer = new PdfPrinter({ FahimaArabic: { normal: fontPath, bold: fontPath, italics: fontPath, bolditalics: fontPath } }); const pdf = await printer.createPdfKitDocument(documentDefinition(report)); pdf.end(); return streamToBuffer(pdf); }

module.exports = { createArabicReportPdf, documentDefinition };
