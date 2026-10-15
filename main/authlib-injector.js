const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const config = require('./account-config.json');

// authlib-injector — Java-агент, который направляет вход и скины игры на сервер аккаунтов Veyra.
// Файл скачивается один раз в compat/ папки данных и перед каждым запуском сверяется по SHA-256.
// Для проверок адрес и сумму можно подменить переменными VEYRA_AUTHLIB_URL и VEYRA_AUTHLIB_SHA256.
const pending = new Map();
// Агент весит около 340 КБ: всё, что заметно больше, — не он.
const MAX_JAR = 4 * 1024 * 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function authlibSource() {
  const custom = process.env.VEYRA_AUTHLIB_URL && /^[0-9a-f]{64}$/i.test(process.env.VEYRA_AUTHLIB_SHA256 || '');
  return {
    version: config.authlib.version,
    sha256: (custom ? process.env.VEYRA_AUTHLIB_SHA256 : config.authlib.sha256).toLowerCase(),
    urls: custom ? [process.env.VEYRA_AUTHLIB_URL] : config.authlib.urls,
  };
}
const authlibFile = dataDir => path.join(dataDir, 'compat', 'authlib-injector-' + config.authlib.version + '.jar');

async function download(url, file, hash, { fetchImpl, signal, timeout, agent }) {
  const limit = AbortSignal.timeout(timeout);
  const response = await fetchImpl(url, { headers: { 'User-Agent': agent }, signal: signal ? AbortSignal.any([signal, limit]) : limit });
  if (!response.ok) { response.body?.cancel().catch(() => {}); throw new Error('HTTP ' + response.status); }
  // Длинный ответ зеркала обрывается на лету, а не собирается в памяти целиком.
  if (Number(response.headers.get('content-length')) > MAX_JAR) { response.body?.cancel().catch(() => {}); throw new Error('файл слишком большой'); }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.length;
    // Выход из for await отменяет поток.
    if (size > MAX_JAR) throw new Error('файл слишком большой');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (sha256(bytes) !== hash) throw new Error('контрольная сумма не совпала');
  const temporary = file + '.download-' + randomUUID();
  try {
    await fs.writeFile(temporary, bytes);
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}

// Возвращает путь к проверенному файлу агента; скачивает его по очереди с зеркал, если файла нет или он испорчен.
function ensureAuthlib(dataDir, { fetchImpl = (...args) => fetch(...args), signal, timeout = 60000, version = '0', log = () => {} } = {}) {
  const file = authlibFile(dataDir), source = authlibSource();
  const key = file.toLowerCase() + '|' + source.sha256;
  if (pending.has(key)) return pending.get(key);
  const task = (async () => {
    const current = await fs.readFile(file).then(sha256).catch(() => '');
    if (current === source.sha256) return file;
    if (current) log('authlib-injector: файл в compat повреждён, скачиваем заново');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const problems = [];
    for (const url of source.urls) {
      try {
        await download(url, file, source.sha256, { fetchImpl, signal, timeout, agent: 'VeyraLauncher/' + version });
        log('authlib-injector ' + source.version + ' скачан: ' + new URL(url).host);
        return file;
      } catch (error) {
        if (signal?.aborted) throw new Error('Загрузка authlib-injector отменена');
        problems.push(new URL(url).host + ': ' + (error?.name === 'TimeoutError' ? 'нет ответа' : error?.message || error));
      }
    }
    throw new Error('Не удалось скачать authlib-injector для аккаунта Veyra (' + problems.join('; ') + '). Проверьте интернет и повторите запуск');
  })().finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}

module.exports = { ensureAuthlib, authlibFile, authlibSource };
