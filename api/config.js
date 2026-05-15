// api/config.js
// Точка сборки путей и настроек. Читает /var/nodehost/.env при старте.

const path = require('path');

// В dev-режиме (.env в корне проекта), в production — /var/nodehost/.env
const envPath = process.env.NODE_ENV === 'production'
  ? '/var/nodehost/.env'
  : path.join(__dirname, '..', '.env');

require('dotenv').config({ path: envPath });

module.exports = {
  DATA_DIR:      process.env.DATA_DIR      || '/var/nodehost',
  APPS_DIR:      process.env.APPS_DIR      || '/var/nodehost/apps',
  DB_PATH:       process.env.DB_PATH       || '/var/nodehost/db/platform.db',
  LOGS_DIR:      process.env.LOGS_DIR      || '/var/nodehost/logs',
  CADDY_API:     process.env.CADDY_API     || 'http://localhost:2019',
  API_PORT:      parseInt(process.env.API_PORT, 10) || 8080,
  MASTER_TOKEN:  process.env.MASTER_TOKEN  || 'change-me-in-production',
  BASE_DOMAIN:   process.env.BASE_DOMAIN   || 'localhost',
  PORT_RANGE:    { from: 3001, to: 3999 },
};
