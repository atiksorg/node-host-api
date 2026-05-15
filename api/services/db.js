// api/services/db.js
// Инкапсуляция всех SQL-запросов (MVP: SQLite, Full PaaS: PostgreSQL)

const db = require('../db/client');
const { v4: uuidv4 } = require('uuid');

/**
 * Найти приложение по имени
 */
function findApp(name) {
  return db.prepare('SELECT * FROM apps WHERE name = ? AND status != ?').get(name, 'deleted');
}

/**
 * Найти приложение по ID
 */
function findAppById(id) {
  return db.prepare('SELECT * FROM apps WHERE id = ?').get(id);
}

/**
 * Получить список приложений
 * @param {Object} filters - { status }
 */
function listApps(filters = {}) {
  let query = 'SELECT * FROM apps WHERE status != ?';
  const params = ['deleted'];

  if (filters.status) {
    query += ' AND status = ?';
    params.push(filters.status);
  }

  query += ' ORDER BY created_at DESC';

  return db.prepare(query).all(...params);
}

/**
 * Создать запись о приложении
 */
function createApp(data) {
  const id = uuidv4();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO apps (id, name, status, port, dir, source_type, source_url, start_script, env_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    data.name,
    data.status || 'stopped',
    data.port || null,
    data.dir || null,
    data.sourceType || null,
    data.sourceUrl || null,
    data.startScript || 'index.js',
    JSON.stringify(data.env || {}),
    now,
    now
  );

  return findAppById(id);
}

/**
 * Обновить запись приложения
 */
function updateApp(name, data) {
  const now = new Date().toISOString();
  const app = findApp(name);
  if (!app) return null;

  const fields = [];
  const params = [];

  if (data.status !== undefined) {
    fields.push('status = ?');
    params.push(data.status);
  }
  if (data.port !== undefined) {
    fields.push('port = ?');
    params.push(data.port);
  }
  if (data.dir !== undefined) {
    fields.push('dir = ?');
    params.push(data.dir);
  }
  if (data.sourceType !== undefined) {
    fields.push('source_type = ?');
    params.push(data.sourceType);
  }
  if (data.sourceUrl !== undefined) {
    fields.push('source_url = ?');
    params.push(data.sourceUrl);
  }
  if (data.startScript !== undefined) {
    fields.push('start_script = ?');
    params.push(data.startScript);
  }
  if (data.env !== undefined) {
    fields.push('env_json = ?');
    params.push(JSON.stringify(data.env));
  }

  fields.push('updated_at = ?');
  params.push(now);

  params.push(name);

  db.prepare(`UPDATE apps SET ${fields.join(', ')} WHERE name = ?`).run(...params);

  return findApp(name);
}

/**
 * "Удалить" приложение (soft delete — статус = deleted)
 */
function deleteApp(name) {
  const now = new Date().toISOString();
  db.prepare('UPDATE apps SET status = ?, updated_at = ? WHERE name = ?')
    .run('deleted', now, name);
}

/**
 * Получить env-переменные приложения
 */
function getEnv(name) {
  const app = findApp(name);
  if (!app) return null;
  return JSON.parse(app.env_json || '{}');
}

/**
 * Установить env-переменные приложения (полная замена)
 */
function setEnv(name, env) {
  return updateApp(name, { env });
}

/**
 * Частично обновить env-переменные (add/update/delete)
 */
function patchEnv(name, patch) {
  const currentEnv = getEnv(name);
  if (!currentEnv) return null;

  const newEnv = { ...currentEnv };

  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) {
      delete newEnv[key]; // Удаление ключа
    } else {
      newEnv[key] = value; // Add/Update
    }
  }

  return updateApp(name, { env: newEnv });
}

/**
 * Подсчитать статистику по приложениям
 */
function getStats() {
  const total = db.prepare('SELECT COUNT(*) as count FROM apps WHERE status != ?').get('deleted');
  const running = db.prepare('SELECT COUNT(*) as count FROM apps WHERE status = ?').get('running');
  const stopped = db.prepare('SELECT COUNT(*) as count FROM apps WHERE status = ?').get('stopped');

  return {
    total: total.count,
    running: running.count,
    stopped: stopped.count,
  };
}

module.exports = {
  findApp,
  findAppById,
  listApps,
  createApp,
  updateApp,
  deleteApp,
  getEnv,
  setEnv,
  patchEnv,
  getStats,
};
