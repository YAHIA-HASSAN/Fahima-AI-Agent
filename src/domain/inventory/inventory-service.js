function createInventoryService(db) {
  const columns=new Set(db.prepare('PRAGMA table_info(products)').all().map(row=>row.name));
  for(const [name,definition] of [['initial_quantity','REAL NOT NULL DEFAULT 0'],['updated_at',"TEXT NOT NULL DEFAULT (datetime('now'))"]]) if(!columns.has(name)) db.exec(`ALTER TABLE products ADD COLUMN ${name} ${definition}`);
  const move = db.transaction((projectId, input) => {
    const key = String(input.idempotencyKey || '').slice(0,140);
    if (!key) throw new Error('معرّف حركة المخزون مطلوب.');
    const prior = db.prepare('SELECT * FROM fahima_v2_inventory_movements WHERE project_id=? AND idempotency_key=?').get(projectId,key);
    if (prior) return { ...prior, duplicate:true };
    let product = input.productId ? db.prepare('SELECT * FROM products WHERE project_id=? AND id=?').get(projectId,input.productId) : null;
    if (!product) product = db.prepare('SELECT * FROM products WHERE project_id=? AND name=? AND unit=?').get(projectId,String(input.name||'').trim(),String(input.unit||'').trim());
    if (!product) {
      const result = db.prepare('INSERT INTO products(project_id,name,unit,initial_quantity,current_quantity) VALUES(?,?,?,0,0)').run(projectId,String(input.name||'').trim(),String(input.unit||'').trim());
      product = db.prepare('SELECT * FROM products WHERE id=?').get(result.lastInsertRowid);
    }
    const delta=Number(input.quantityDelta);
    if(!Number.isFinite(delta)||delta===0) throw new Error('كمية الحركة لازم تكون رقمًا غير صفر.');
    const next=Number(product.current_quantity)+delta;
    if(next < -1e-9) throw Object.assign(new Error('الحركة دي هتخلي المخزون بالسالب.'),{code:'NEGATIVE_INVENTORY'});
    db.prepare('UPDATE products SET current_quantity=?,updated_at=datetime(\'now\') WHERE id=? AND project_id=?').run(Math.max(0,next),product.id,projectId);
    const result=db.prepare('INSERT INTO fahima_v2_inventory_movements(project_id,product_id,transaction_id,quantity_delta,reason,idempotency_key) VALUES(?,?,?,?,?,?)').run(projectId,product.id,input.transactionId||null,delta,String(input.reason||'تسوية مخزون').slice(0,250),key);
    return { id:result.lastInsertRowid,productId:product.id,name:product.name,unit:product.unit,quantityDelta:delta,currentQuantity:Math.max(0,next),duplicate:false };
  });
  return {
    move:(projectId,input)=>move(projectId,input),
    reverse(projectId,movementId,key,reason='عكس حركة') {
      const original=db.prepare('SELECT * FROM fahima_v2_inventory_movements WHERE id=? AND project_id=?').get(movementId,projectId);
      if(!original) throw Object.assign(new Error('حركة المخزون غير موجودة.'),{code:'MOVEMENT_NOT_FOUND'});
      const prior=db.prepare('SELECT * FROM fahima_v2_inventory_movements WHERE reverses_movement_id=? AND project_id=?').get(movementId,projectId);
      if(prior) return { ...prior,duplicate:true };
      const result=move(projectId,{ productId:original.product_id,quantityDelta:-original.quantity_delta,reason,idempotencyKey:key });
      db.prepare('UPDATE fahima_v2_inventory_movements SET reverses_movement_id=? WHERE id=?').run(movementId,result.id);
      return result;
    },
    list:projectId=>db.prepare('SELECT p.id,p.name,p.unit,p.initial_quantity,p.current_quantity,p.low_stock_threshold,p.unit_cost FROM products p WHERE p.project_id=? ORDER BY p.name').all(projectId),
    history:(projectId,productId)=>db.prepare('SELECT * FROM fahima_v2_inventory_movements WHERE project_id=? AND product_id=? ORDER BY id DESC').all(projectId,productId),
  };
}
module.exports={createInventoryService};
