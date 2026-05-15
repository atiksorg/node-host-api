// api/routes/apps.js
// CRUD-операции для приложений

const { Router } = require('express');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const db = require('../services/db');
const runner = require('../services/runner');
const deployer = require('../services/deployer');
const proxy = require('../services/proxy');
const dns = require('../services/dns');
const ports = require('../services/ports');
const queue = require('../services/queue');

const router = Router();

/**
 * POST /apps — Деплой нового приложения
 */
router.post('/', async (req, res) => {
  try {
    const { name, source, env, startScript, nodeVersion } = req.body;

    if (!name || !source) {
      return res.status(400).json({ error: 'name and source are required' });
    }

    // nodeVersion принят по ТЗ, но пока не поддерживается — логируем предупреждение
    if (nodeVersion) {
      console.warn(`[apps] nodeVersion "${nodeVersion}" requested for app "${name}" but is not yet supported`);
    }

    // Валидация имени
    if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(name)) {
      return res.status(400).json({ error: 'Invalid app name (1-63 chars, lowercase alphanumeric and hyphens)' });
    }

    // Проверка уникальности
    const existing = db.findApp(name);
    if (existing) {
      return res.status(409).json({ error: 'App with this name already exists' });
    }

    // Выполняем деплой через очередь
    const { result: deployResult } = await queue.enqueue({
      fn: async (payload) => {
        const { name, source, env, startScript } = payload;

        // 1. Деплой кода
        let appDir;
        if (source.type === 'github') {
          appDir = await deployer.deployFromGitHub({
            name,
            url: source.url,
            branch: source.branch || 'main',
          });
        } else if (source.type === 'zip') {
          appDir = await deployer.deployFromZip({ name, url: source.url });
        } else if (source.type === 'patch') {
          appDir = await deployer.deployFromPatch({ name, files: source.files });
        } else {
          throw new Error(`Unknown source type: ${source.type}`);
        }

        // 2. Определяем точку входа
        const entryScript = deployer.detectStartScript(appDir, startScript);

        // 3. Находим свободный порт
        const port = ports.findFreePort();

        // 4. Создаём запись в БД
        db.createApp({
          name,
          status: 'stopped',
          port,
          dir: appDir,
          sourceType: source.type,
          sourceUrl: source.url || null,
          startScript: entryScript,
          env: env || {},
        });

        // 5. DNS (заглушка)
        await dns.createRecord(name);

        // 6. Запускаем через PM2
        const appRecord = db.findApp(name);
        await runner.start({
          name: appRecord.name,
          dir: appRecord.dir,
          port: appRecord.port,
          startScript: appRecord.start_script,
          env: JSON.parse(appRecord.env_json || '{}'),
        });

        // 7. Регистрируем маршрут в Caddy
        await proxy.addRoute(name, port);

        // 8. Обновляем статус
        db.updateApp(name, { status: 'running' });

        return {
          appId: appRecord.id,
          name: appRecord.name,
          url: `https://${name}.${config.BASE_DOMAIN}`,
          status: 'running',
          port,
          createdAt: appRecord.created_at,
        };
      },
      payload: { name, source, env, startScript },
    });

    res.status(201).json(deployResult);
  } catch (err) {
    console.error('Deploy error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /apps — Список приложений
 */
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    const apps = db.listApps(status ? { status } : {});

    const result = [];
    for (const app of apps) {
      let uptime = 0;
      if (app.status === 'running') {
        try {
          const procStatus = await runner.getStatus(app.name);
          uptime = procStatus.uptime;
        } catch {
          // PM2 может не вернуть данные
        }
      }

      result.push({
        appId: app.id,
        name: app.name,
        url: `https://${app.name}.${config.BASE_DOMAIN}`,
        status: app.status,
        uptime,
      });
    }

    res.json({ total: result.length, apps: result });
  } catch (err) {
    console.error('List apps error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /apps/:name — Информация о приложении
 */
router.get('/:name', async (req, res) => {
  try {
    const app = db.findApp(req.params.name);
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    let uptime = 0;
    let memory = 0;
    let cpu = 0;
    let restarts = 0;

    if (app.status === 'running') {
      try {
        const procStatus = await runner.getStatus(app.name);
        uptime = procStatus.uptime;
        memory = procStatus.memory;
        cpu = procStatus.cpu;
        restarts = procStatus.restarts;
      } catch {
        // PM2 может не вернуть данные
      }
    }

    res.json({
      appId: app.id,
      name: app.name,
      url: `https://${app.name}.${config.BASE_DOMAIN}`,
      status: app.status,
      port: app.port,
      uptime,
      memory: `${Math.round(memory / 1024 / 1024)} MB`,
      cpu: `${cpu}%`,
      restarts,
      createdAt: app.created_at,
      updatedAt: app.updated_at,
    });
  } catch (err) {
    console.error('Get app error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /apps/:name — Обновление приложения (redeploy)
 */
router.put('/:name', async (req, res) => {
  try {
    const app = db.findApp(req.params.name);
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    const { source, startScript } = req.body;
    if (!source) {
      return res.status(400).json({ error: 'source is required' });
    }

    // Сохраняем текущие env
    const currentEnv = JSON.parse(app.env_json || '{}');

    // Останавливаем процесс
    try {
      await runner.stop(app.name);
    } catch {
      // Процесс мог не быть запущен
    }

    // Удаляем маршрут из Caddy
    try {
      await proxy.removeRoute(app.name);
    } catch {
      // Маршрута могло не быть
    }

    // Новый деплой в ту же директорию
    let appDir;
    if (source.type === 'github') {
      appDir = await deployer.deployFromGitHub({
        name: app.name,
        url: source.url,
        branch: source.branch || 'main',
      });
    } else if (source.type === 'zip') {
      appDir = await deployer.deployFromZip({ name: app.name, url: source.url });
    } else if (source.type === 'patch') {
      appDir = await deployer.deployFromPatch({ name: app.name, files: source.files });
    } else {
      throw new Error(`Unknown source type: ${source.type}`);
    }

    // Определяем точку входа
    const entryScript = deployer.detectStartScript(appDir, startScript || app.start_script);

    // Обновляем БД
    db.updateApp(app.name, {
      dir: appDir,
      sourceType: source.type,
      sourceUrl: source.url || null,
      startScript: entryScript,
    });

    // Запускаем
    const updatedApp = db.findApp(app.name);
    await runner.start({
      name: updatedApp.name,
      dir: updatedApp.dir,
      port: updatedApp.port,
      startScript: updatedApp.start_script,
      env: currentEnv,
    });

    // Регистрируем маршрут
    await proxy.addRoute(app.name, app.port);

    // Обновляем статус
    db.updateApp(app.name, { status: 'running' });

    const result = db.findApp(app.name);
    res.json({
      appId: result.id,
      name: result.name,
      url: `https://${result.name}.${config.BASE_DOMAIN}`,
      status: 'running',
      port: result.port,
    });
  } catch (err) {
    console.error('Redeploy error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /apps/:name — Удаление приложения
 */
router.delete('/:name', async (req, res) => {
  try {
    const app = db.findApp(req.params.name);
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    // 1. Останавливаем процесс
    try {
      await runner.stop(app.name);
    } catch {
      // Процесс мог не быть запущен
    }

    // 2. Удаляем маршрут из Caddy
    try {
      await proxy.removeRoute(app.name);
    } catch {
      // Маршрута могло не быть
    }

    // 3. Удаляем DNS-запись
    try {
      await dns.deleteRecord(app.name);
    } catch {
      // Ошибка удаления DNS
    }

    // 4. Удаляем рабочую директорию
    if (app.dir && fs.existsSync(app.dir)) {
      fs.rmSync(app.dir, { recursive: true, force: true });
    }

    // 5. Освобождаем порт
    ports.releasePort(app.port);

    // 6. Помечаем как удалённое в БД
    db.deleteApp(app.name);

    res.status(204).end();
  } catch (err) {
    console.error('Delete app error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /apps/:name/restart — Перезапуск приложения
 */
router.post('/:name/restart', async (req, res) => {
  try {
    const app = db.findApp(req.params.name);
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    await runner.restart(app.name);
    db.updateApp(app.name, { status: 'running' });

    res.json({ name: app.name, status: 'running' });
  } catch (err) {
    console.error('Restart error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /apps/:name/stop — Остановка приложения
 */
router.post('/:name/stop', async (req, res) => {
  try {
    const app = db.findApp(req.params.name);
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    await runner.stop(app.name);

    // Деактивируем маршрут в Caddy
    try {
      await proxy.suspendRoute(app.name);
    } catch {
      // Заглушка
    }

    db.updateApp(app.name, { status: 'stopped' });

    res.json({ name: app.name, status: 'stopped' });
  } catch (err) {
    console.error('Stop error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /apps/:name/start — Запуск приложения
 */
router.post('/:name/start', async (req, res) => {
  try {
    const app = db.findApp(req.params.name);
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    if (app.status === 'running') {
      return res.json({ name: app.name, status: 'running' });
    }

    const env = JSON.parse(app.env_json || '{}');

    await runner.start({
      name: app.name,
      dir: app.dir,
      port: app.port,
      startScript: app.start_script,
      env,
    });

    // Восстанавливаем маршрут
    try {
      await proxy.resumeRoute(app.name, app.port);
    } catch {
      // Заглушка
    }

    // Убежаемся, что маршрут есть
    try {
      await proxy.addRoute(app.name, app.port);
    } catch {
      // Маршрут мог уже существовать
    }

    db.updateApp(app.name, { status: 'running' });

    res.json({ name: app.name, status: 'running' });
  } catch (err) {
    console.error('Start error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /apps/:name/env — Получить список ключей env (без значений)
 * Значения могут содержать секреты, поэтому возвращаем только имена ключей
 */
router.get('/:name/env', (req, res) => {
  try {
    const app = db.findApp(req.params.name);
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    const env = db.getEnv(app.name);
    const keys = Object.keys(env);
    res.json({ keys });
  } catch (err) {
    console.error('Get env error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /apps/:name/env — Полная замена env
 */
router.put('/:name/env', async (req, res) => {
  try {
    const app = db.findApp(req.params.name);
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    const { env } = req.body;
    if (typeof env !== 'object' || env === null) {
      return res.status(400).json({ error: 'env must be an object' });
    }

    db.setEnv(app.name, env);

    // Автоматический перезапуск
    if (app.status === 'running') {
      try {
        await runner.stop(app.name);
        await runner.start({
          name: app.name,
          dir: app.dir,
          port: app.port,
          startScript: app.start_script,
          env,
        });
      } catch (err) {
        console.error('Restart after env change failed:', err);
      }
    }

    res.json({ env });
  } catch (err) {
    console.error('Set env error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /apps/:name/env — Частичное обновление env
 */
router.patch('/:name/env', async (req, res) => {
  try {
    const app = db.findApp(req.params.name);
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    const patch = req.body;
    if (typeof patch !== 'object' || patch === null) {
      return res.status(400).json({ error: 'Body must be an object' });
    }

    db.patchEnv(app.name, patch);
    const updatedEnv = db.getEnv(app.name);

    // Автоматический перезапуск
    if (app.status === 'running') {
      try {
        await runner.stop(app.name);
        await runner.start({
          name: app.name,
          dir: app.dir,
          port: app.port,
          startScript: app.start_script,
          env: updatedEnv,
        });
      } catch (err) {
        console.error('Restart after env patch failed:', err);
      }
    }

    res.json({ env: updatedEnv });
  } catch (err) {
    console.error('Patch env error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
