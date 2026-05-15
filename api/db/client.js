// api/db/client.js
// Инициализация SQLite через better-sqlite3

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('../config');

// Убедимся, что директория для БД существует
const dbDir = path.dirname(config.DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(config.DB_PATH);

// WAL mode для лучшей производительности
db.pragma('journal_mode = WAL');

// Инициализация схемы
const schemaPath = path.join(__dirname, 'schema.sql');
const schema = fs.readFileSync(schemaPath, 'utf8');
db.exec(schema);

module.exports = db;
