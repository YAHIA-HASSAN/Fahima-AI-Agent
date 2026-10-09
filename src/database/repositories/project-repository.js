function createProjectRepository(db) {
  return {
    list() { return db.prepare('SELECT id,name,activity,products,capital,created_at FROM projects ORDER BY id').all(); },
    get(id) { return db.prepare('SELECT id,name,activity,products,capital,costs,sales_method,household_use,created_at FROM projects WHERE id=?').get(Number(id)) || null; },
    create(name) {
      const clean = String(name || '').trim().slice(0, 100);
      if (!clean) throw new Error('اكتبي اسم المشروع.');
      const result = db.prepare('INSERT INTO projects(name) VALUES(?)').run(clean);
      return this.get(result.lastInsertRowid);
    },
    remove(id) {
      const project = this.get(id);
      if (!project) throw Object.assign(new Error('المشروع غير موجود.'), { status: 404 });
      db.prepare('DELETE FROM projects WHERE id=?').run(Number(id));
      return project;
    },
  };
}
module.exports = { createProjectRepository };
