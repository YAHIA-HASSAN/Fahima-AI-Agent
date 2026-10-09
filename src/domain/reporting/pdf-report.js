const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const { reportHtml } = require('./report-template');
const fontPath = path.resolve(__dirname, '../../../assets/fonts/NotoNaskhArabic-Regular.ttf');

async function createArabicReportPdf(report) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    throw Object.assign(new Error('تعذر تشغيل Chromium لتوليد التقرير. شغّلي: npx playwright install chromium'), { code: 'PDF_CHROMIUM_UNAVAILABLE', cause: error });
  }
  try {
    const page = await browser.newPage({ locale: 'ar-EG' });
    await page.setContent(reportHtml(report), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const font = fs.readFileSync(fontPath).toString('base64');
    const footerTemplate = `<style>@font-face{font-family:FahimaArabic;src:url(data:font/ttf;base64,${font})}*{font-family:FahimaArabic;font-size:9pt;color:#65756f}</style><div style="width:100%;padding:0 14mm;display:flex;justify-content:space-between;direction:ltr"><span>تم إعداد التقرير بواسطة فهيمة</span><span>صفحة <span class="pageNumber"></span> من <span class="totalPages"></span></span></div>`;
    return await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate, margin: { top: 0, right: 0, bottom: '14mm', left: 0 } });
  } finally {
    await browser.close();
  }
}

module.exports = { createArabicReportPdf };
