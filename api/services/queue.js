// api/services/queue.js
// Управление очередью задач (MVP: синхронное выполнение)

/**
 * Поставить задачу в очередь и выполнить немедленно
 * MVP: выполняет task.fn(task.payload) синхронно
 * Full PaaS: Redis + Bull
 */
async function enqueue(task) {
  const result = await task.fn(task.payload);
  return { status: 'done', result };
}

/**
 * Получить статус задачи по jobId
 * MVP: всегда возвращает done
 */
async function getJobStatus(jobId) {
  return { status: 'done', jobId };
}

module.exports = { enqueue, getJobStatus };
