const test=require('node:test');
const assert=require('node:assert/strict');
const {createTestDb}=require('./helpers');
const {createTransactionService}=require('../src/domain/finance/transaction-service');
const {createInventoryService}=require('../src/domain/inventory/inventory-service');
const {createPlanService}=require('../src/domain/planning/plan-service');
const {createTaskManager}=require('../src/agent/task-manager');
const {runLoop}=require('../src/agent/agent-loop');
const {createToolRegistry}=require('../src/tools/tool-registry');
const {registerTools}=require('../src/tools/register-tools');
const {createMemoryService}=require('../src/memory/memory-service');

function project(db){return Number(db.prepare('INSERT INTO projects(name) VALUES(?)').run('اختبار').lastInsertRowid);}

test('correct and cancel transaction preserve audit and update financial totals',()=>{
  const db=createTestDb(),id=project(db),service=createTransactionService(db);
  const sale=service.record(id,{type:'income',amount:125,date:'2026-10-09',description:'بيع',idempotencyKey:'sale'});
  const revised=service.correct(id,sale.id,{amount:150},'تصحيح المبلغ','task-a');
  assert.equal(revised.transaction.amount,150);
  assert.ok(db.prepare('SELECT voided_at FROM transactions WHERE id=?').get(sale.id).voided_at);
  assert.equal(service.audit(id,sale.id).at(-1).action,'correct');
  service.cancel(id,revised.transaction.id,'عملية مكررة','task-b');
  assert.ok(db.prepare('SELECT voided_at FROM transactions WHERE id=?').get(revised.transaction.id).voided_at);
  assert.equal(db.prepare('SELECT SUM(amount) total FROM transactions WHERE project_id=? AND voided_at IS NULL').get(id).total,null);
});

test('inventory movements are idempotent, reversible, and reject negative balances',()=>{
  const db=createTestDb(),id=project(db),stock=createInventoryService(db);
  const incoming=stock.move(id,{name:'قطعة غيار',unit:'قطعة',quantityDelta:4,reason:'شراء فعلي',idempotencyKey:'in-1'});
  assert.equal(stock.move(id,{name:'قطعة غيار',unit:'قطعة',quantityDelta:4,reason:'شراء فعلي',idempotencyKey:'in-1'}).duplicate,true);
  assert.equal(stock.move(id,{productId:incoming.productId,quantityDelta:-1,reason:'بيع',idempotencyKey:'out-1'}).currentQuantity,3);
  assert.throws(()=>stock.move(id,{productId:incoming.productId,quantityDelta:-9,reason:'تسوية',idempotencyKey:'bad'}),/السالب/);
  assert.equal(stock.reverse(id,db.prepare('SELECT id FROM fahima_v2_inventory_movements WHERE idempotency_key=?').get('out-1').id,'reverse-1').currentQuantity,4);
  assert.equal(stock.list(id)[0].current_quantity,4);
});

test('tracked product sales write financial and stock records atomically',async()=>{
  const db=createTestDb(),id=project(db),stock=createInventoryService(db),transactions=createTransactionService(db);
  const product=stock.move(id,{name:'دفتر',unit:'قطعة',quantityDelta:5,reason:'رصيد بداية معروف',idempotencyKey:'opening'});
  const registry=createToolRegistry();registerTools({registry,db,memory:createMemoryService(db),transactions,inventory:stock,plans:createPlanService(db),search:async()=>({results:[]})});
  const context={projectId:id,isProjectAuthorized:true,task:{id:'tx-task'},toolSequence:1};
  const sale=await registry.execute({name:'record_inventory_transaction',input:{type:'income',amount:30,date:'2026-10-09',description:'بيع دفترين',productName:'دفتر',unit:'قطعة',quantity:2,reason:'بيع فعلي'},context});
  assert.equal(sale.status,'succeeded');assert.equal(stock.list(id)[0].current_quantity,3);
  const movement=db.prepare('SELECT transaction_id FROM fahima_v2_inventory_movements WHERE idempotency_key LIKE ?').get('%:stock');
  assert.equal(movement.transaction_id,sale.output.transaction.id);
  const failed=await registry.execute({name:'record_inventory_transaction',input:{type:'income',amount:30,date:'2026-10-09',description:'بيع زائد',productName:'دفتر',unit:'قطعة',quantity:9,reason:'بيع فعلي'},context:{...context,toolSequence:2}});
  assert.equal(failed.status,'failed');assert.equal(db.prepare('SELECT COUNT(*) n FROM transactions WHERE project_id=?').get(id).n,1);assert.equal(stock.list(id)[0].current_quantity,3);
});

test('saved plan steps and actual outcomes persist against the selected revision',()=>{
  const db=createTestDb(),id=project(db),plans=createPlanService(db);
  const saved=plans.save(id,null,{objective:'تجربة بيع',assumptions:['تقديري'],steps:['تجهيز','بيع'],risks:['تغير السعر'],missingInformation:['الطلب الفعلي']},'PROVISIONAL');
  plans.setStep(id,saved.revision,0,true,'تم التجهيز');
  assert.equal(plans.steps(id,saved.revision)[0].status,'complete');
  const outcome=plans.recordOutcome(id,saved.revision,'revenue','300 جنيه','أول أسبوع','result-once');
  assert.equal(outcome.actual,'300 جنيه');
  assert.equal(plans.recordOutcome(id,saved.revision,'revenue','300 جنيه','أول أسبوع','result-once').duplicate,true);
  assert.equal(plans.outcomes(id).length,1);
});

test('cancellation prevents Gemini tool execution after cancellation is accepted',async()=>{
  let calls=0;
  const registry=createToolRegistry().register({name:'danger_read',description:'read',inputSchema:{type:'object',properties:{},required:[],additionalProperties:false},execute:()=>{calls++;return {};}});
  const model={decide:async()=>({candidate:{parts:[{functionCall:{name:'danger_read',args:{}}}]}})};
  const result=await runLoop({model,registry,context:{task:{decisionCount:0},memory:{project:null,facts:[],goals:[],inventory:[],plans:[],messages:[],tasks:[],activeTasks:[],previousDecisions:[],research:[],transactions:[]},message:'إلغاء',observations:[]},budgets:{maxDecisions:4,maxTools:4,timeoutMs:1000},isCancelled:()=>true});
  assert.equal(result.status,'CANCELLED');assert.equal(calls,0);
});
