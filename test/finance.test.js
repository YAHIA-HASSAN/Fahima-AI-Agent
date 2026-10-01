const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const F = require('../server/finance');
const agent = require('../server/agent');

test('normalizes Eastern Arabic digits', () => {
  assert.equal(F.normalizeDigits('١٢٣ ۱۲'), '123 12');

});

test('speaks numeric values in Arabic and replaces digits in prose', () => {
  assert.equal(F.numberToArabicWords(0), 'صفر');
  assert.equal(F.numberToArabicWords(4850), 'أربعة آلاف وثمانمائة وخمسون');
  assert.equal(F.speakableArabic('المبيعات ٤٨٥٠ جنيهًا'), 'المبيعات أربعة آلاف وثمانمائة وخمسون جنيهًا');
});

test('validates supported transactions without calculating profit', () => {
  assert.equal(F.validTransaction({type:'income',amount:500,date:'2026-09-29',description:'بيع'}), true);
  assert.equal(F.validTransaction({type:'profit',amount:500,date:'2026-09-29',description:'ربح'}), false);
  const report=F.summary([{type:'income',amount:500,estimated:0},{type:'operating_expense',amount:200,estimated:0}]);
  assert.equal(report.totals.income,500);
  assert.equal(report.totals.operating_expense,200);
  assert.equal(report.saleCount,1);
  assert.equal('profit' in report.totals,false);
});

test('migrates legacy financial rows and records itemized stock movements', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'faheema-test-'));
  process.env.DB_PATH=path.join(dir,'legacy.sqlite');
  const legacy=new Database(process.env.DB_PATH);
  legacy.exec(`CREATE TABLE projects(id INTEGER PRIMARY KEY,name TEXT NOT NULL,activity TEXT,products TEXT,capital REAL,costs TEXT,sales_method TEXT,household_use TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE transactions(id INTEGER PRIMARY KEY,project_id INTEGER NOT NULL,type TEXT NOT NULL,amount REAL NOT NULL,date TEXT NOT NULL,description TEXT NOT NULL,estimated INTEGER DEFAULT 0,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO projects(id,name,activity) VALUES(1,'مشروعي','بقالة');
    INSERT INTO transactions(id,project_id,type,amount,date,description) VALUES(1,1,'income',500,'2026-09-29','بيع قديم');`);
  legacy.close();
  try {
    const db=require('../server/db');
    const B=require('../server/business');
    assert.equal(db.pragma('user_version',{simple:true}),2);
    assert.equal(B.getTransactions(1,'2026-09-01','2026-09-30').length,1);
    assert.equal(db.prepare('SELECT value FROM project_facts WHERE project_id=1 AND key=?').get('activity').value,'بقالة');
    const firstConversation=B.ensureConversation(1);
    const secondProjectId=db.prepare("INSERT INTO projects(name) VALUES('مشروع تاني')").run().lastInsertRowid;
    B.ensureConversation(secondProjectId);
    assert.equal(B.getConversation(secondProjectId,firstConversation.id),null);
    db.prepare("INSERT INTO project_facts(project_id,key,value,source) VALUES(1,'supplier','مورد أ','user'),(?,'supplier','مورد ب','user')").run(secondProjectId);
    assert.equal(db.prepare("SELECT value FROM project_facts WHERE project_id=? AND key='supplier'").get(secondProjectId).value,'مورد ب');
    const product=B.createProduct(1,{name:'مياه',unit:'كرتونة',initialQuantity:10,unitCost:50});
    B.recordTransaction(1,{type:'income',amount:100,date:'2026-09-29',description:'بيع كرتونتين',productName:'مياه',quantity:2,unit:'كرتونة',unitPrice:50});
    assert.equal(B.getProducts(1)[0].current_quantity,8);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM transaction_items').get().n,1);
    // A named purchase with only a total is a financial record, not a stock movement.
    const movementsBefore=db.prepare('SELECT COUNT(*) n FROM inventory_movements').get().n;
    for (const quantity of [null, undefined]) {
      const purchase=B.recordTransaction(1,{type:'stock_cost',amount:500,date:'2026-09-29',description:'شراء قماش',productName:'قماش',quantity});
      assert.equal(purchase.amount,500);
      assert.equal(purchase.project_id,1);
      assert.equal(purchase.type,'stock_cost');
    }
    assert.equal(B.findProduct(1,'قماش'),undefined);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM transaction_items').get().n,1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM inventory_movements').get().n,movementsBefore);
    for (const quantity of [0,-1,NaN,Infinity]) {
      assert.throws(()=>B.recordTransaction(1,{type:'stock_cost',amount:500,date:'2026-09-29',description:'شراء قماش',productName:'قماش',quantity}),/الكمية/);
    }
    assert.equal(B.findProduct(1,'قماش'),undefined);
    db.close();
  } finally { fs.rmSync(dir,{recursive:true,force:true}); delete process.env.DB_PATH; }
});

test('uses Gemini Flash structured output without sending database tools to the model', async () => {
  const oldKey=process.env.GEMINI_API_KEY,oldModel=process.env.GEMINI_MODEL;
  process.env.GEMINI_API_KEY='test-key';process.env.GEMINI_MODEL='gemini-test-flash';
  const parsed={intent:'record_transaction',transactions:[],transaction_type:'income',amount:500,amount_kind:'total',date:'2026-09-29',period:'today',description:'بعت بـ 500',estimated:false,product_name:null,quantity:null,unit:null,unit_price:null,markup_percent:null,reminder_title:null,due_date:null,fact_key:null,fact_value:null,answer:''};
  let captured;
  agent.__setGeminiClientForTests({interactions:{create:async(request)=>{captured=request;return {output_text:JSON.stringify(parsed)};}}});
  try {
    const result=await agent.extract('بعت بـ 500 جنيه.',{history:[],products:[]});
    assert.equal(result.intent,'record_transaction');
    assert.equal(captured.model,'gemini-test-flash');
    assert.equal(captured.response_format[0].mime_type,'application/json');
    assert.match(captured.input,/صافي ربح/);
    assert.equal('tools' in captured,false);
  } finally {
    agent.__setGeminiClientForTests(null);
    if(oldKey===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=oldKey;
    if(oldModel===undefined)delete process.env.GEMINI_MODEL;else process.env.GEMINI_MODEL=oldModel;
  }
});
