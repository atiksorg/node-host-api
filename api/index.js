// api/index.js
// Точка входа Express — управляющий API NodeHost

const express = require('express');
const path = require('path');
const config = require('./config');
const auth = require('./middleware/auth');
const appsRouter = require('./routes/apps');
const logsRouter = require('./routes/logs');
const statusRouter = require('./routes/status');
const proxy = require('./services/proxy');

const app = express();

// ─── Статика: папка public/ ───

const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// ─── Middleware ───

// Парсинг JSON-тела запроса
app.use(express.json({ limit: '10mb' }));

// CORS (открытый — API управляет сервером, не браузером)
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');

  if (_req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

// ─── Авторизация для всех /v1 маршрутoв ───

app.use('/v1', auth);

// ─── Маршруты ───

// CRUD приложений (POST, GET, PUT, DELETE /apps, а также /apps/:name/*)
app.use('/v1/apps', appsRouter);

// Логи (GET /apps/:name/logs) — mounted на тот же префикс, но отдельный роутер
app.use('/v1/apps', logsRouter);

// Статус платформы (GET /status)
app.use('/v1/status', statusRouter);

// ─── Health check (без авторизации) ───

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── 404 ───

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── Запуск сервера ───

app.listen(config.API_PORT, async () => {
  console.log(`[NodeHost] API running on port ${config.API_PORT}`);
  console.log(`[NodeHost] Base domain: ${config.BASE_DOMAIN}`);
  console.log(`[NodeHost] Apps directory: ${config.APPS_DIR}`);
  console.log(`[NodeHost] Database: ${config.DB_PATH}`);

  // Инициализируем сервер "main" в Caddy через Admin API
  await proxy.initServer();
});
