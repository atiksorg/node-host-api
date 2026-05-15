// api/services/dns.js
// Управление DNS-записями (MVP: заглушка для wildcard)

/**
 * Создать A-запись для приложения
 * В MVP ничего не делает — wildcard DNS покрывает всё
 */
async function createRecord(_appName) {
  return true;
}

/**
 * Удалить DNS-запись
 * В MVP ничего не делает
 */
async function deleteRecord(_appName) {
  return true;
}

/**
 * Проверить, существует ли DNS-запись
 * В MVP всегда возвращает true (wildcard)
 */
async function exists(_appName) {
  return true;
}

module.exports = { createRecord, deleteRecord, exists };
