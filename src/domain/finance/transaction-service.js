const crypto = require('node:crypto');
const { moneyMinor } = require('./calculator');

function createTransactionService(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS fahima_v2_idempotency (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL, transaction_id INTEGER NOT NULL REFERENCES transactions(id),
    PRIMARY KEY(project_id,idempotency_key)
  )`);
  const save = db.transaction((projectId, input) => {
    const key = String(input.idempotencyKey || crypto.randomUUID()).slice(0, 120);
    const prior = db.prepare('SELECT transaction_id FROM fahima_v2_idempotency WHERE project_id=? AND idempotency_key=?').get(projectId, key);
    if (prior) return { ...db.prepare('SELECT * FROM transactions WHERE id=? AND project_id=?').get(prior.transaction_id, projectId), duplicate: true };
    const amountMinor = moneyMinor(input.amount);
    if (!['income', 'stock_cost', 'operating_expense', 'withdrawal'].includes(input.type)) throw new Error('نوع المعاملة غير صحيح.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || new Date(`${input.date}T00:00:00Z`).toISOString().slice(0, 10) !== input.date) throw new Error('التاريخ غير صحيح.');
    const description = String(input.description || '').trim().slice(0, 250);
    if (!description) throw new Error('وصف العملية مطلوب.');
    const result = db.prepare('INSERT INTO transactions(project_id,type,amount,date,description,estimated) VALUES(?,?,?,?,?,0)').run(projectId, input.type, amountMinor / 100, input.date, description);
    db.prepare('INSERT INTO fahima_v2_idempotency(project_id,idempotency_key,transaction_id) VALUES(?,?,?)').run(projectId, key, result.lastInsertRowid);
    audit.run(projectId, result.lastInsertRowid, 'record', null, JSON.stringify(db.prepare('SELECT * FROM transactions WHERE id=?').get(result.lastInsertRowid)), input.description, input.taskId || null);
    return { ...db.prepare('SELECT * FROM transactions WHERE id=?').get(result.lastInsertRowid), duplicate: false };
  });
  const audit = db.prepare('INSERT INTO fahima_v2_transaction_audit(project_id,transaction_id,action,before_json,after_json,reason,task_id) VALUES(?,?,?,?,?,?,?)');
  const correct = db.transaction((projectId, id, changes, reason, taskId) => {
    if(taskId){
      const prior=db.prepare("SELECT 1 FROM fahima_v2_transaction_audit WHERE project_id=? AND transaction_id=? AND action='correct' AND task_id=? LIMIT 1").get(projectId,id,taskId);
      if(prior){const replacement=db.prepare("SELECT transaction_id FROM fahima_v2_transaction_audit WHERE project_id=? AND action='replacement' AND task_id=? ORDER BY id DESC LIMIT 1").get(projectId,taskId);if(replacement)return {corrected:true,voidedId:id,transaction:db.prepare('SELECT * FROM transactions WHERE id=? AND project_id=?').get(replacement.transaction_id,projectId),duplicate:true};}
    }
    const old = db.prepare('SELECT * FROM transactions WHERE id=? AND project_id=? AND voided_at IS NULL').get(id, projectId);
    if (!old) throw Object.assign(new Error('المعاملة مش موجودة أو سبق إلغاؤها.'), { code: 'TRANSACTION_NOT_FOUND' });
    const amount = changes.amount == null ? old.amount : moneyMinor(changes.amount) / 100;
    const type = changes.type || old.type;
    if (!['income','stock_cost','operating_expense','withdrawal'].includes(type)) throw new Error('نوع المعاملة غير صحيح.');
    const description = String(changes.description || old.description).trim().slice(0,250);
    const date = changes.date || old.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0,10)!==date) throw new Error('التاريخ غير صحيح.');
    const after = { ...old, type, amount, date, description };
    db.prepare('UPDATE transactions SET voided_at=datetime(\'now\'),void_reason=? WHERE id=? AND project_id=?').run(`تصحيح: ${reason}`, id, projectId);
    const inserted = db.prepare('INSERT INTO transactions(project_id,type,amount,date,description,estimated) VALUES(?,?,?,?,?,?)').run(projectId,type,amount,date,description,old.estimated);
    audit.run(projectId,id,'correct',JSON.stringify(old),JSON.stringify(after),reason,taskId || null);
    audit.run(projectId,inserted.lastInsertRowid,'replacement',JSON.stringify(old),JSON.stringify(db.prepare('SELECT * FROM transactions WHERE id=?').get(inserted.lastInsertRowid)),reason,taskId || null);
    return { corrected: true, voidedId:id, transaction:db.prepare('SELECT * FROM transactions WHERE id=?').get(inserted.lastInsertRowid) };
  });
  const cancel = db.transaction((projectId,id,reason,taskId) => {
    const old=db.prepare('SELECT * FROM transactions WHERE id=? AND project_id=? AND voided_at IS NULL').get(id,projectId);
    if(!old){const prior=taskId&&db.prepare("SELECT 1 FROM fahima_v2_transaction_audit WHERE project_id=? AND transaction_id=? AND action='cancel' AND task_id=?").get(projectId,id,taskId);if(prior)return {cancelled:true,transactionId:id,duplicate:true};throw Object.assign(new Error('المعاملة مش موجودة أو سبق إلغاؤها.'),{code:'TRANSACTION_NOT_FOUND'});}
    db.prepare('UPDATE transactions SET voided_at=datetime(\'now\'),void_reason=? WHERE id=? AND project_id=?').run(reason,id,projectId);
    audit.run(projectId,id,'cancel',JSON.stringify(old),null,reason,taskId||null);
    return { cancelled:true,transactionId:id };
  });
  return { record: (projectId, input) => save(projectId, input), correct:(projectId,id,changes,reason,taskId)=>correct(projectId,id,changes,reason,taskId), cancel:(projectId,id,reason,taskId)=>cancel(projectId,id,reason,taskId), audit:(projectId,id)=>db.prepare('SELECT * FROM fahima_v2_transaction_audit WHERE project_id=? AND transaction_id=? ORDER BY id').all(projectId,id) };
}
module.exports = { createTransactionService };
