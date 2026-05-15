// api/services/ports.js
// Управление пулом портов (3001–3999)

const db = require('../db/client');
const config = require('../config');

const { from, to } = config.PORT_RANGE;

/**
 * Найти свободный порт, не занятый ни одним приложением в БД
 */
function findFreePort() {
  const usedRows = db.prepare('SELECT port FROM apps WHERE port IS NOT NULL AND status != ?').all('deleted');
  const usedPorts = new Set(usedRows.map((r) => r.port));

  for (let port = from; port <= to; port++) {
    if (!usedPorts.has(port)) {
      return port;
    }
  }

  throw new Error('No free ports available');
}

/**
 * Освободить порт (при удалении приложения)
 */
function releasePort(_port) {
  // Порт автоматически освобождается, т.к. БД — единственный источник правды
}

module.exports = { findFreePort, releasePort };
