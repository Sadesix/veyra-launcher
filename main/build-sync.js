const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { setTimeout: delay } = require('node:timers/promises');
const path = require('node:path');
const { VeyraError } = require('./veyra-account');
const { applyPack } = require('./modpacks');
const { SHARED_DIRS } = require('./build-share');

const MAX = 1024 ** 3;
const CHUNK = 1024 ** 2;
const ID = /^[0-9a-f]{32}$/;
const HASH = /^[0-9a-f]{64}$/;
const STAGE_ID = /^[0-9a-f-]{36}$/;
const directories = ['mods', ...SHARED_DIRS];

function route(id, action, params = {}) {
  if (!ID.test(id || '')) throw new Error('Введите код сборки из Veyra Controller');
  const query = new URLSearchParams(params).toString();
  return 'veyra/build-sync/' + id + '/' + action + (query ? '?' + query : '');
}

async function publishArchive(client, request, id, key, file, revision) {
  const { size } = await fs.stat(file);
  if (size < 1 || size > MAX) throw new Error('Архив общей сборки должен занимать до 1 ГБ');
  const begin = await request(token => client.request(route(id, 'begin'), { method: 'POST', token, json: { key, size } }));
  const upload = begin.data?.upload;
  if (!ID.test(upload || '')) throw new Error('Хранилище не подтвердило загрузку сборки');
  const digest = createHash('sha256');
  let position = 0;
  for await (const bytes of createReadStream(file, { highWaterMark: CHUNK })) {
    digest.update(bytes);
    const result = await request(token => client.request(route(id, 'chunk', { upload, offset: position }),
      { method: 'POST', token, raw: bytes, type: 'application/octet-stream', timeout: 120000 }));
    position += bytes.length;
    if (result.data?.received !== position) throw new Error('Сервер не подтвердил файлы общей сборки');
  }
  const hash = digest.digest('hex');
  const result = await request(token => client.request(route(id, 'finish', { upload }), { method: 'POST', token, json: { hash, revision }, timeout: 120000 }));
  if (result.data?.hash !== hash || result.data?.size !== size) throw new Error('Сервер не подтвердил ревизию сборки');
}

async function authorizeArchive(client, request, id, signal) {
  const start = await request(token => client.request(route(id, 'request'), { method: 'POST', token, json: {}, signal }));
  const ticket = start.data?.ticket;
  if (!ID.test(ticket || '')) throw new Error('Хранилище не выдало запрос допуска');
  for (let attempt = 0; attempt < 18; attempt++) {
    const { data } = await request(token => client.request(route(id, 'check', { ticket }), { method: 'POST', token, json: {}, signal }));
    if (data?.state === 'allowed' && HASH.test(data.hash || '') && Number.isSafeInteger(data.size) && data.size > 0 && data.size <= MAX) {
      return { ticket, hash: data.hash, size: data.size };
    }
    await delay(2200, null, { signal });
  }
  throw new Error('ВМ не ответила на проверку белого списка. Повторите попытку позже.');
}

async function downloadArchive(client, request, id, authorized, destination, signal) {
  return request(async token => {
    const response = await client.fetch(new URL(route(id, 'download', { ticket: authorized.ticket }), client.root), {
      headers: { Authorization: 'Bearer ' + token, 'User-Agent': client.agent }, redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15 * 60 * 1000)]) : AbortSignal.timeout(15 * 60 * 1000),
    });
    if (response.status === 401) throw new VeyraError('Войдите в аккаунт Veyra заново', { status: 401, code: 'unauthorized' });
    if (!response.ok || !response.body) throw new Error('Доступ к архиву сборки истёк. Запросите его снова.');
    let bytes = 0;
    const hash = createHash('sha256');
    const verify = new Transform({
      transform(chunk, _encoding, done) {
        bytes += chunk.length;
        if (bytes > authorized.size) return done(new Error('Сборка превышает объявленный размер'));
        hash.update(chunk);
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), verify, createWriteStream(destination, { flags: 'wx' }), { signal });
    if (bytes !== authorized.size || hash.digest('hex') !== authorized.hash) throw new Error('Загруженная сборка не прошла проверку SHA-256');
  });
}

async function plainDir(folder) {
  const info = await fs.lstat(folder).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (info && !info.isDirectory()) throw new Error('Папка синхронизации содержит ссылку или обычный файл');
  return Boolean(info);
}

async function recoverSyncedBuild(instance, readJson) {
  const journal = path.join(instance.directory, '.veyra-sync-journal.json');
  let record;
  try { record = JSON.parse(await fs.readFile(journal, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!STAGE_ID.test(record.id || '') || !HASH.test(record.hash || '') || !Array.isArray(record.folders) ||
      record.folders.some(item => !directories.includes(item?.name) || typeof item.existed !== 'boolean')) {
    throw new Error('Некорректный журнал синхронизации');
  }
  const area = path.join(instance.directory, '.veyra-sync-storage');
  const work = path.join(area, record.id);
  const next = path.join(work, 'next'), previous = path.join(work, 'previous');
  if (!await plainDir(area) || !await plainDir(work) || !await plainDir(next) || !await plainDir(previous)) {
    throw new Error('Не удалось найти резервные файлы синхронизации');
  }
  const committed = await readJson(path.join(instance.directory, '.veyra-sync-revision.json'), null);
  if (committed?.hash !== record.hash) {
    for (const { name, existed } of [...record.folders].reverse()) {
      const active = path.join(instance.directory, name), staged = path.join(next, name), backup = path.join(previous, name);
      const backedUp = await plainDir(backup);
      if ((backedUp || !existed) && await plainDir(active) && !await plainDir(staged)) await fs.rename(active, staged);
      if (backedUp) await fs.rename(backup, active);
    }
    const oldMetadata = path.join(previous, 'content.json');
    const source = await fs.lstat(oldMetadata).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (source) {
      if (!source.isFile()) throw new Error('Повреждены резервные сведения о модах');
      await fs.rename(oldMetadata, path.join(instance.directory, '.veyra-content.json'));
    }
  }
  await fs.rm(journal, { force: true });
}

async function updateSyncedBuild(instance, file, index, hash, { signal, readJson, atomicJson }) {
  await recoverSyncedBuild(instance, readJson);
  if (!await plainDir(instance.directory)) throw new Error('Папка сборки отсутствует');
  const area = path.join(instance.directory, '.veyra-sync-storage');
  if (!await plainDir(area)) await fs.mkdir(area);
  const id = randomUUID(), work = path.join(area, id);
  const next = path.join(work, 'next'), previous = path.join(work, 'previous');
  await fs.mkdir(next, { recursive: true });
  await fs.mkdir(previous);
  const journal = path.join(instance.directory, '.veyra-sync-journal.json');
  try {
    await applyPack(file, index, next, { signal });
    const metadata = path.join(instance.directory, '.veyra-content.json');
    const stored = await fs.lstat(metadata).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    let content;
    if (stored) {
      if (!stored.isFile()) throw new Error('Некорректные сведения о содержимом');
      content = JSON.parse(await fs.readFile(metadata, 'utf8'));
      if (content.schema !== 1 || !Array.isArray(content.items)) throw new Error('Некорректные сведения о содержимом');
      content.items = content.items.filter(item => !['mods', 'resourcepacks', 'shaders'].includes(item.kind));
    }
    const folders = [];
    for (const name of directories) {
      const existed = await plainDir(path.join(instance.directory, name));
      if (existed || await plainDir(path.join(next, name))) folders.push({ name, existed });
    }
    await atomicJson(journal, { id, hash, folders });
    for (const { name, existed } of folders) {
      const active = path.join(instance.directory, name), staged = path.join(next, name);
      if (existed) await fs.rename(active, path.join(previous, name));
      if (await plainDir(staged)) await fs.rename(staged, active);
    }
    if (content) {
      await fs.rename(metadata, path.join(previous, 'content.json'));
      await atomicJson(metadata, content);
    }
    await atomicJson(path.join(instance.directory, '.veyra-sync-revision.json'), { hash });
    await fs.rm(journal, { force: true });
  } catch (error) {
    await recoverSyncedBuild(instance, readJson);
    throw error;
  }
}

module.exports = { ID, HASH, publishArchive, authorizeArchive, downloadArchive, recoverSyncedBuild, updateSyncedBuild };
