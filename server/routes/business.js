const { summary } = require('../finance');

function createBusinessRoutes({ app, db, business, validDate, projectOr404, requireConversation }) {
  app.post(['/api/transactions', '/api/project-facts', '/api/pending-actions', '/api/products', '/api/products/:id/adjust', '/api/reminders'], requireConversation);
  app.put(['/api/project', '/api/products/:id'], requireConversation);

  app.delete('/api/transactions/:id', (req, res) => {
    const project = projectOr404(req.query.projectId, res);
    if (!project) return;
    const row = db.prepare('SELECT * FROM transactions WHERE id=? AND project_id=?').get(Number(req.params.id), project.id);
    if (!row) return res.status(404).json({ error: 'العملية دي مش موجودة.' });
    try {
      business.voidTransaction(project.id,row.id,'إلغاء من سجل المعاملات');
      res.json({ ok: true, voided: true });
    } catch(error) {
      res.status(409).json({ error: error.message });
    }
  });

  app.get('/api/products', (req, res) => {
    const project = projectOr404(req.query.projectId, res);
    if (!project) return;
    res.json({ products: business.getProducts(project.id) });
  });

  app.get('/api/products/sales', (req, res) => {
    const project = projectOr404(req.query.projectId, res);
    if (!project) return;
    const from = String(req.query.from || business.periodBounds('month').from);
    const to = String(req.query.to || business.localDate());
    if (!validDate(from) || !validDate(to) || from > to) return res.status(400).json({ error: 'اختار فترة صحيحة.' });
    res.json({ sales: business.getProductSales(project.id, from, to) });
  });

  app.get('/api/reminders', (req, res) => {
    const project = projectOr404(req.query.projectId, res);
    if (!project) return;
    res.json({ reminders: business.getReminders(project.id) });
  });

  app.post('/api/reminders/:id/complete', (req, res) => {
    const project = projectOr404(req.body.projectId, res);
    if (!project) return;
    const result = db.prepare('UPDATE reminders SET completed=1 WHERE id=? AND project_id=?').run(Number(req.params.id), project.id);
    if (!result.changes) return res.status(404).json({ error: 'التذكير مش موجود.' });
    res.json({ ok: true });
  });

  app.get('/api/report', (req, res) => {
    const project = projectOr404(req.query.projectId, res);
    if (!project) return;
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    if (!validDate(from) || !validDate(to) || from > to) return res.status(400).json({ error: 'اختار فترة صحيحة للتقرير.' });
    const rows = business.getTransactions(project.id, from, to);
    res.json({
      project: { name: project.name, activity: project.activity },
      period: { from, to },
      transactions: rows,
      summary: summary(rows),
      products: business.getProductSales(project.id, from, to),
    });
  });
}

module.exports = { createBusinessRoutes };
