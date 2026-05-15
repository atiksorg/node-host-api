// api/services/runner.js
// Управление процессами через PM2
//
// Подключение к PM2 устанавливается ОДИН РАЗ при загрузке модуля.
// Это решает race condition: если два HTTP-запроса параллельно используют
// PM2, disconnect() одного НЕ оборвёт IPC-сокет другого.

const pm2 = require('pm2');
const path = require('path');
const fs = require('fs');

// ─── Постоянное подключение к PM2 daemon ───

let _connected = false;

function ensureConnected() {
  if (_connected) return Promise.resolve();

  return new Promise((resolve, reject) => {
    pm2.connect((err) => {
      if (err) {
        console.error('[PM2] Connect error:', err);
        return reject(err);
      }
      _connected = true;
      resolve();
    });
  });
}

// При загрузке модуля — подключаемся к PM2 daemon.
// Если daemon не запущен — PM2 сам его стартует.
pm2.connect((err) => {
  if (err) {
    console.error('[PM2] Initial connect error:', err);
    // Не process.exit — возможно, daemon стартует позже,
    // ensureConnected() повторит попытку при первом вызове
    _connected = false;
  } else {
    _connected = true;
  }
});

// ─── Вспомогательные функции ───

/**
 * Привести все значения env к строкам (PM2 и Node.js期待 string)
 */
function stringifyEnv(env) {
  if (!env || typeof env !== 'object') return {};
  const result = {};
  for (const [k, v] of Object.entries(env)) {
    result[k] = String(v);
  }
  return result;
}

// ─── Публичные методы ───

/**
 * Запустить приложение через PM2
 * @param {Object} app - { name, dir, port, startScript, env }
 */
async function start(app) {
  await ensureConnected();

  return new Promise((resolve, reject) => {
    const scriptPath = path.join(app.dir, app.startScript || 'index.js');

    const pm2Options = {
      name: app.name,
      cwd: app.dir,
      script: scriptPath,
      args: '',
      env: {
        ...stringifyEnv(app.env),
        PORT: String(app.port),
      },
      node_args: '',
      max_memory_restart: '256M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: path.join(app.dir, '.pm2-error.log'),
      out_file: path.join(app.dir, '.pm2-out.log'),
      autorestart: true,
      watch: false,
    };

    pm2.start(pm2Options, (err) => {
      // НЕ делаем disconnect() — соединение общее
      if (err) reject(err);
      else resolve({ name: app.name, status: 'running' });
    });
  });
}

/**
 * Остановить и удалить процесс из PM2
 */
async function stop(appName) {
  await ensureConnected();

  return new Promise((resolve, reject) => {
    pm2.delete(appName, (err) => {
      if (err) {
        // Если процесс не найден — считаем это успешной остановкой
        if (err.message && err.message.includes('not found')) {
          return resolve({ name: appName, status: 'stopped' });
        }
        reject(err);
      } else {
        resolve({ name: appName, status: 'stopped' });
      }
    });
  });
}

/**
 * Перезапустить процесс
 */
async function restart(appName) {
  await ensureConnected();

  return new Promise((resolve, reject) => {
    pm2.restart(appName, (err) => {
      if (err) reject(err);
      else resolve({ name: appName, status: 'running' });
    });
  });
}

/**
 * Получить статус процесса
 * @returns {Object} { status, uptime, memory, cpu, restarts }
 */
async function getStatus(appName) {
  await ensureConnected();

  return new Promise((resolve, reject) => {
    pm2.describe(appName, (err, list) => {
      if (err) return reject(err);

      if (!list || list.length === 0) {
        return resolve({ status: 'stopped', uptime: 0, memory: 0, cpu: '0%', restarts: 0 });
      }

      const proc = list[0];
      const uptime = proc.pm2_env ? Date.now() - proc.pm2_env.pm_uptime : 0;

      resolve({
        status: proc.pm2_env && proc.pm2_env.status === 'online' ? 'running' : 'stopped',
        uptime: Math.floor(uptime / 1000),
        memory: proc.monit ? proc.monit.memory : 0,
        cpu: proc.monit ? proc.monit.cpu : 0,
        restarts: proc.pm2_env ? proc.pm2_env.restart_time || 0 : 0,
      });
    });
  });
}

/**
 * Получить логи приложения из PM2
 * @param {string} appName
 * @param {Object} opts - { lines, type }
 * @returns {Array} [{ ts, type, line }]
 */
async function getLogs(appName, opts = {}) {
  const { lines = 100, type = 'all' } = opts;
  await ensureConnected();

  return new Promise((resolve, reject) => {
    pm2.describe(appName, (err, list) => {
      if (err) return reject(err);

      if (!list || list.length === 0) {
        return resolve([]);
      }

      const proc = list[0];
      const logs = [];

      const readLogFile = (filePath, logType) => {
        try {
          if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8');
            const allLines = content.trim().split('\n');
            const tail = allLines.slice(-lines);
            for (const line of tail) {
              if (line.trim()) {
                // PM2 пишет строки вида: "2025-01-01 12:00:01 +0000: Server started"
                const match = line.trim().match(
                  /^(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}[^:]*?):\s*(.+)/
                );
                let ts, text;
                if (match) {
                  ts = new Date(match[1]).toISOString() || new Date().toISOString();
                  text = match[2];
                } else {
                  ts = new Date().toISOString();
                  text = line.trim();
                }
                logs.push({ ts, type: logType, line: text });
              }
            }
          }
        } catch {
          // Файл может не существовать
        }
      };

      if (proc.pm2_env) {
        if (type === 'all' || type === 'stdout') {
          readLogFile(proc.pm2_env.out_log_path, 'stdout');
        }
        if (type === 'all' || type === 'stderr') {
          readLogFile(proc.pm2_env.err_log_path, 'stderr');
        }
      }

      // Сортируем по времени и ограничиваем
      resolve(logs.slice(-lines));
    });
  });
}

/**
 * Список всех процессов под управлением PM2
 */
async function list() {
  await ensureConnected();

  return new Promise((resolve, reject) => {
    pm2.list((err, list) => {
      if (err) return reject(err);

      const processes = (list || []).map((proc) => ({
        name: proc.name,
        status: proc.pm2_env && proc.pm2_env.status === 'online' ? 'running' : 'stopped',
      }));

      resolve(processes);
    });
  });
}

module.exports = { start, stop, restart, getStatus, getLogs, list };
