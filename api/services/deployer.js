// api/services/deployer.js
// Логика деплоя приложений (GitHub, ZIP, Patch)

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const simpleGit = require('simple-git');
const unzipper = require('unzipper');
const https = require('https');
const http = require('http');
const config = require('../config');

/**
 * Деплой приложения из GitHub
 * @param {Object} opts - { name, url, branch }
 * @returns {string} путь к рабочей директории
 */
async function deployFromGitHub({ name, url, branch = 'main' }) {
  const appDir = path.join(config.APPS_DIR, name);

  // Удаляем директорию, если существует (redeploy)
  if (fs.existsSync(appDir)) {
    fs.rmSync(appDir, { recursive: true, force: true });
  }

  const git = simpleGit();
  await git.clone(url, appDir, ['--depth=1', '--branch=' + branch]);

  // npm install --production
  runNpmInstall(appDir);

  return appDir;
}

/**
 * Деплой из ZIP-архива по URL
 * @param {Object} opts - { name, url }
 * @returns {string} путь к рабочей директории
 */
async function deployFromZip({ name, url }) {
  const appDir = path.join(config.APPS_DIR, name);

  // Удаляем директорию, если существует
  if (fs.existsSync(appDir)) {
    fs.rmSync(appDir, { recursive: true, force: true });
  }
  fs.mkdirSync(appDir, { recursive: true });

  // Скачиваем ZIP
  const zipBuffer = await downloadFile(url);

  // Распаковываем
  await unzipBuffer(zipBuffer, appDir);

  // npm install --production
  runNpmInstall(appDir);

  return appDir;
}

/**
 * Деплой патчами (отдельные файлы)
 * @param {Object} opts - { name, files }
 *   files: [{ path, content (base64) }]
 * @returns {string} путь к рабочей директории
 */
async function deployFromPatch({ name, files }) {
  const appDir = path.join(config.APPS_DIR, name);

  // Создаём директорию, если не существует
  fs.mkdirSync(appDir, { recursive: true });

  let packageJsonChanged = false;

  for (const file of files) {
    const filePath = path.join(appDir, file.path);
    const dirPath = path.dirname(filePath);

    // Создаём поддиректории
    fs.mkdirSync(dirPath, { recursive: true });

    // Декодируем base64 и записываем
    const content = Buffer.from(file.content, 'base64');
    fs.writeFileSync(filePath, content);

    if (file.path === 'package.json') {
      packageJsonChanged = true;
    }
  }

  // npm install только если изменился package.json
  if (packageJsonChanged) {
    runNpmInstall(appDir);
  }

  return appDir;
}

/**
 * Автоопределение точки входа
 * @param {string} appDir - рабочая директория
 * @param {string} startScript - явно указанный скрипт
 * @returns {string} имя файла точки входа
 */
function detectStartScript(appDir, startScript) {
  // 1. Явно указан
  if (startScript) return startScript;

  // 2. package.json → scripts.start
  const pkgPath = path.join(appDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts && pkg.scripts.start) {
        // Извлекаем имя файла из команды (например, "node server.js" → "server.js")
        const parts = pkg.scripts.start.split(/\s+/);
        const lastPart = parts[parts.length - 1];
        if (lastPart.endsWith('.js')) return lastPart;
      }
    } catch {
      // Игнорируем ошибки парсинга
    }
  }

  // 3. server.js или index.js
  if (fs.existsSync(path.join(appDir, 'server.js'))) return 'server.js';
  if (fs.existsSync(path.join(appDir, 'index.js'))) return 'index.js';

  return 'index.js';
}

// ─── Вспомогательные функции ───

/**
 * Выполнить npm install --production
 */
function runNpmInstall(cwd) {
  try {
    execSync('npm install --production --no-optional', {
      cwd,
      timeout: 120000,
      stdio: 'pipe',
    });
  } catch (err) {
    // Логируем ошибку, но не прерываем деплой
    console.error(`npm install failed for ${cwd}:`, err.message);
  }
}

/**
 * Скачать файл по URL
 */
function downloadFile(url) {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith('https') ? https : http;

    transport.get(url, (res) => {
      // Редиректы
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location).then(resolve, reject);
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`Download failed with status ${res.statusCode}`));
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Распаковать буфер ZIP в директорию
 */
async function unzipBuffer(buffer, destDir) {
  return new Promise((resolve, reject) => {
    const { Readable } = require('stream');
    let rootPrefix = '';

    Readable.from(buffer)
      .pipe(unzipper.Parse())
      .on('entry', (entry) => {
        // Определяем префикс корневой папки (если ZIP содержит одну папку)
        const parts = entry.path.split('/');
        if (!rootPrefix && parts.length > 1 && entry.type === 'Directory' && parts[0] !== '') {
          rootPrefix = parts[0] + '/';
        }

        // Убираем префикс корневой папки
        let filePath = entry.path;
        if (rootPrefix && filePath.startsWith(rootPrefix)) {
          filePath = filePath.slice(rootPrefix.length);
        }

        if (!filePath || filePath === '') {
          entry.autodrain();
          return;
        }

        const fullPath = path.resolve(destDir, filePath);

        // Защита от Zip Slip: убежаемся, что файл попадает внутрь destDir
        if (!fullPath.startsWith(path.resolve(destDir))) {
          console.warn(`[ZIP] Skipping suspicious path: ${entry.path}`);
          entry.autodrain();
          return;
        }

        if (entry.type === 'Directory') {
          fs.mkdirSync(fullPath, { recursive: true });
          entry.autodrain();
        } else {
          const dirPath = path.dirname(fullPath);
          fs.mkdirSync(dirPath, { recursive: true });
          entry.pipe(fs.createWriteStream(fullPath));
        }
      })
      .on('close', resolve)
      .on('error', reject);
  });
}

module.exports = {
  deployFromGitHub,
  deployFromZip,
  deployFromPatch,
  detectStartScript,
};
