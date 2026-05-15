// api/services/proxy.js
// Управление маршрутизацией Caddy через Admin API
//
// Маршруты создаются с уникальными @id для безопасного удаления
// без race conditions при параллельных запросах.
//
// При старте вызывается initServer(), который создаёт сервер "main"
// через Admin API, если его ещё нет. Это гарантирует наличие сервера
// с предсказуемым именем, независимо от Caddyfile.

const http = require('http');
const https = require('https');
const config = require('../config');

/**
 * Инициализировать сервер "main" в Caddy при старте API.
 * Проверяет, существует ли сервер, и создаёт при необходимости.
 */
async function initServer() {
  try {
    const servers = await caddyGet('/config/apps/http/servers');
    if (servers && servers.main) {
      console.log('[Caddy] Server "main" already exists, skipping init');
      return;
    }

    // Создаём сервер с пустым списком маршрутов
    // :80 редирект уже определён в Caddyfile — не дублируем
    await caddyPut('/config/apps/http/servers/main', {
      listen: [':443'],
      routes: [],
    });

    console.log('[Caddy] Server "main" created via Admin API');
  } catch (err) {
    console.error('[Caddy] Failed to init server "main":', err.message);
    // Не критично — Caddy может быть ещё не запущен,
    // initServer вызовется при первом addRoute
  }
}

/**
 * Добавить маршрут в Caddy: appName.domain.com → localhost:port
 * Маршрут получает уникальный @id для безопасного удаления.
 */
async function addRoute(appName, port) {
  const hostname = `${appName}.${config.BASE_DOMAIN}`;
  const routeId = `route-${appName}`;

  const route = {
    "@id": routeId,
    match: [{ host: [hostname] }],
    handle: [{
      handler: 'reverse_proxy',
      upstreams: [{ dial: `localhost:${port}` }],
    }],
  };

  await caddyPost('/config/apps/http/servers/main/routes', route);
}

/**
 * Удалить маршрут из Caddy для приложения по уникальному @id
 * (безопасно при параллельном удалении — @id стабилен).
 */
async function removeRoute(appName) {
  const routeId = `route-${appName}`;

  try {
    // Удаляем по уникальному Caddy @id — не зависит от сервера и индекса
    await caddyDelete(`/id/${routeId}`);
  } catch (err) {
    // Маршрута могло не быть — не критично
    if (err.message && err.message.includes('404')) return;
    throw err;
  }
}

/**
 * Деактивировать маршрут (приложение на паузе — заглушка)
 */
async function suspendRoute(_appName) {
  // MVP: заглушка для будущего Scale-to-Zero
  return true;
}

/**
 * Восстановить маршрут после пробуждения (заглушка)
 */
async function resumeRoute(_appName, _port) {
  // MVP: заглушка для будущего Scale-to-Zero
  return true;
}

// ─── Вспомогательные HTTP-функции ───

function caddyRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, config.CADDY_API);
    const transport = url.protocol === 'https:' ? https : http;

    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: { 'Content-Type': 'application/json' },
    };

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        } else if (res.statusCode === 404) {
          resolve(null);
        } else {
          reject(new Error(`Caddy API error ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

function caddyPost(apiPath, body) {
  return caddyRequest('POST', apiPath, body);
}

function caddyPut(apiPath, body) {
  return caddyRequest('PUT', apiPath, body);
}

function caddyGet(apiPath) {
  return caddyRequest('GET', apiPath);
}

function caddyDelete(apiPath) {
  return caddyRequest('DELETE', apiPath);
}

module.exports = { initServer, addRoute, removeRoute, suspendRoute, resumeRoute };
