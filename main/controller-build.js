const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { declaredServerSide } = require('./server-manager');
const { fileHash } = require('./modpacks');

const CONFIG_DIRS = ['config', 'defaultconfigs', 'kubejs', 'scripts', 'global_packs', 'openloader', 'paxi', 'datapacks', 'patchouli_books'];
const safeName = name => name !== '.' && name !== '..' && !/[/\\:\p{Cc}]/u.test(name) && Buffer.byteLength(name) <= 255;
const MAX_BYTES = 64 * 1024 ** 3;
const MAX_FILES = 100000;

async function directoryEntries(directory) {
  const info = await fs.lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!info) return [];
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Папка сборки должна быть обычной папкой: ' + path.basename(directory));
  return fs.readdir(directory, { withFileTypes: true });
}

async function inspectBuild(instance, lookup, lookupHashes) {
  await directoryEntries(instance.directory);
  const directory = path.join(instance.directory, 'mods');
  const files = (await directoryEntries(directory)).filter(entry => entry.isFile() && safeName(entry.name) && /\.jar$/i.test(entry.name));
  const installed = await fs.readFile(path.join(instance.directory, '.veyra-content.json'), 'utf8').then(JSON.parse).catch(() => ({ items: [] }));
  const records = new Map((Array.isArray(installed?.items) ? installed.items : []).filter(item => item.kind === 'mods').map(item => [item.file, item]));
  const inspected = [];
  for (let offset = 0; offset < files.length; offset += 12) {
    inspected.push(...await Promise.all(files.slice(offset, offset + 12).map(async ({ name }) => {
      const file = path.join(directory, name);
      const declared = instance.loader === 'vanilla' ? 'unsupported' : await declaredServerSide(file, instance.loader).catch(() => '');
      const projectId = records.get(name)?.projectId;
      const sha1 = lookupHashes && !projectId && declared !== 'unsupported' ? await fileHash(file, 'sha1').catch(() => '') : '';
      return { name, projectId, declared, sha1 };
    })));
  }
  const hashes = [...new Set(inspected.map(mod => mod.sha1).filter(Boolean))];
  const versions = new Map();
  for (let offset = 0; offset < hashes.length; offset += 200) {
    const batch = hashes.slice(offset, offset + 200);
    const found = await lookupHashes(batch).catch(() => null);
    for (const sha1 of batch) {
      const id = found?.[sha1]?.project_id;
      if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id)) versions.set(sha1, id);
    }
  }
  const projects = new Map();
  const mods = [];
  for (let offset = 0; offset < inspected.length; offset += 12) {
    mods.push(...await Promise.all(inspected.slice(offset, offset + 12).map(async ({ name, declared, projectId, sha1 }) => {
      const id = projectId || versions.get(sha1);
      if (lookup && id && declared !== 'unsupported' && !projects.has(id)) {
        projects.set(id, lookup(id).then(project => project?.server_side, () => ''));
      }
      const side = await projects.get(id);
      const supported = side !== 'unsupported' && declared !== 'unsupported';
      return { name, supported, verified: supported && (['required', 'optional'].includes(side) || declared === 'required') };
    })));
  }
  const worlds = [];
  for (const entry of await directoryEntries(path.join(instance.directory, 'saves'))) {
    if (entry.isDirectory() && safeName(entry.name) &&
        await fs.lstat(path.join(instance.directory, 'saves', entry.name, 'level.dat')).then(info => info.isFile(), () => false)) worlds.push(entry.name);
  }
  return { mods, worlds };
}

async function buildFiles(instance, mods = [], worldName = '', directories = CONFIG_DIRS) {
  if (!Array.isArray(mods) || mods.length > MAX_FILES || mods.some(name => typeof name !== 'string' || !safeName(name) || !/\.jar$/i.test(name))) {
    throw new Error('Некорректный список модов сборки');
  }
  if (worldName && (typeof worldName !== 'string' || !safeName(worldName))) throw new Error('Некорректная папка мира');
  const files = [];
  let total = 0;
  async function add(local, remote) {
    const info = await fs.lstat(local);
    if (!info.isFile()) throw new Error('Ожидался обычный файл сборки: ' + path.basename(local));
    total += info.size;
    if (files.length >= MAX_FILES || total > MAX_BYTES) throw new Error('Файлы сборки превышают 64 ГБ или 100 000 файлов');
    files.push({ local, remote, size: info.size });
  }
  async function walk(local, remote) {
    for (const entry of await directoryEntries(local)) {
      if (!safeName(entry.name)) throw new Error('Недопустимое имя файла в сборке: ' + entry.name);
      if (entry.name === 'session.lock') continue;
      const source = path.join(local, entry.name), destination = remote + '/' + entry.name;
      if (entry.isDirectory()) await walk(source, destination);
      else if (entry.isFile()) await add(source, destination);
    }
  }
  await directoryEntries(instance.directory);
  if (mods.length && instance.loader !== 'vanilla') {
    await directoryEntries(path.join(instance.directory, 'mods'));
    for (const name of new Set(mods)) {
      const source = path.join(instance.directory, 'mods', name);
      if (await declaredServerSide(source, instance.loader).catch(() => '') !== 'unsupported') await add(source, 'mods/' + name);
    }
  }
  for (const directory of directories) await walk(path.join(instance.directory, directory), directory);
  if (worldName) {
    const saves = path.join(instance.directory, 'saves');
    await directoryEntries(saves);
    const world = path.join(saves, worldName);
    await directoryEntries(world);
    if (!(await fs.lstat(path.join(world, 'level.dat'))).isFile()) throw new Error('Сохранение мира не найдено');
    await walk(world, 'world');
  }
  return { files, total };
}

async function* buildStream(header, { files, total }, progress, signal) {
  yield JSON.stringify({ ...header, count: files.length, total }) + '\n';
  let completed = 0;
  for (const file of files) {
    signal.throwIfAborted();
    yield JSON.stringify({ path: file.remote, size: file.size }) + '\n';
    let sent = 0;
    const source = file.open ? await file.open() : createReadStream(file.local, { signal });
    for await (const bytes of source) {
      signal.throwIfAborted();
      sent += bytes.length;
      if (sent > file.size) throw new Error('Во время отправки изменился файл ' + path.basename(file.local));
      yield bytes;
      completed += bytes.length;
      progress(completed, total);
    }
    if (sent !== file.size) throw new Error('Во время отправки изменился файл ' + path.basename(file.local));
  }
}

module.exports = { inspectBuild, buildFiles, buildStream, CONFIG_DIRS };
