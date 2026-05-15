// api/routes/logs.js
// Просмотр логов приложений

const { Router } = require('express');
const db = require('../services/db');
const runner = require('../services/runner');

const router = Router();

/**
 * GET /apps/:name/logs — Получить логи приложения
 * Query: lines (default 100), type (stdout|stderr|all)
 */
router.get('/:name/logs', async (req, res) => {
  try {
    const app = db.findApp(req.params.name);
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    const lines = parseInt(req.query.lines, 10) || 100;
    const type = req.query.type || 'all';

    const logs = await runner.getLogs(app.name, { lines, type });

    res.json({ logs });
  } catch (err) {
    console.error('Get logs error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
