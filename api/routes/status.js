// api/routes/status.js
// Статус платформы

const { Router } = require('express');
const os = require('os');
const { execSync } = require('child_process');
const db = require('../services/db');

const router = Router();

/**
 * GET /status — Статус платформы
 */
router.get('/', (req, res) => {
  try {
    const stats = db.getStats();

    // Информация о сервере
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const loadAvg = os.loadavg();

    // Диск
    let diskFree = 'unknown';
    try {
      const dfOutput = execSync("df -h / | tail -1 | awk '{print $4}'", { encoding: 'utf8' }).trim();
      diskFree = dfOutput;
    } catch {
      // Игнорируем ошибки
    }

    res.json({
      platform: 'ok',
      appsTotal: stats.total,
      appsRunning: stats.running,
      appsStopped: stats.stopped,
      serverLoad: loadAvg[0].toFixed(2),
      freeMemory: `${(freeMem / 1024 / 1024 / 1024).toFixed(1)} GB`,
      diskFree,
    });
  } catch (err) {
    console.error('Status error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
