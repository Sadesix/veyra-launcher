const fs = require('node:fs/promises');
const path = require('node:path');
const { createReadStream, createWriteStream } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { open, readAllEntries, readEntry } = require('@xmcl/unzip');
const { ZipFile } = require('yazl');
const { CONFIG_DIRS, buildFiles } = require('./controller-build');
const { packPath, readIndex, LIMITS } = require('./modpacks');

const SHARED_DIRS = [...CONFIG_DIRS, 'resourcepacks', 'shaderpacks'];
const MOD_NAME = /\.jar(?:\.disabled)?$/i;
const SHA1 = /^[a-f0-9]{40}$/;

async function hash(file) {
  const digest = createHash('sha1');
  await pipeline(createReadStream(file), digest);
  return digest.digest('hex');
}

async function declaredVersion(file) {
  let zip;
  try {
    zip = await open(file, { lazyEntries: true, autoClose: false });
    const entries = await readAllEntries(zip);
    const entry = entries.find(item => ['fabric.mod.json', 'META-INF/neoforge.mods.toml', 'META-INF/mods.toml', 'mcmod.info'].includes(item.fileName));
    if (!entry || entry.uncompressedSize > 256 * 1024) return '';
    const text = (await readEntry(zip, entry)).toString('utf8');
    if (entry.fileName.endsWith('.toml')) return (text.match(/^\s*version\s*=\s*["']([^"']+)["']/m)?.[1] || '').slice(0, 100);
    const data = JSON.parse(text);
    const version = data.version || data.modList?.[0]?.version || data[0]?.version;
    return typeof version === 'string' ? version.slice(0, 100) : '';
  } catch { return ''; }
  finally { zip?.close(); }
}

async function inspectExport(instance) {
  const root = path.join(instance.directory, 'mods');
  const mods = [];
  const directory = await fs.lstat(root).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (directory && !directory.isDirectory()) throw new Error('Папка mods должна быть обычной папкой');
  if (directory) {
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (!entry.isFile() || !MOD_NAME.test(entry.name)) continue;
      packPath('mods/' + entry.name);
      const file = path.join(root, entry.name);
      const info = await fs.stat(file);
      if (info.size > LIMITS.file || mods.length >= LIMITS.files) throw new Error('Превышен лимит размера или количества модов .veyra');
      mods.push({ name: entry.name, file, size: info.size, modified: info.mtimeMs,
        sha1: await hash(file), version: await declaredVersion(file), source: null });
    }
  }
  return mods;
}

async function resolveExport(mods, lookup) {
  const versions = {};
  for (let offset = 0; offset < mods.length; offset += 200) {
    Object.assign(versions, await lookup([...new Set(mods.slice(offset, offset + 200).map(mod => mod.sha1))]));
  }
  return mods.map(mod => {
    const version = versions[mod.sha1];
    const artifact = version?.files?.find(file => file.hashes?.sha1 === mod.sha1 && file.size === mod.size && /^https:\/\/cdn\.modrinth\.com\//.test(file.url));
    return {
      ...mod, version: String(version?.version_number || mod.version).slice(0, 100),
      source: artifact ? { url: artifact.url, versionId: version.id, projectId: version.project_id } : null,
    };
  });
}

async function exportBuild(instance, mods, mode, destination) {
  const config = await buildFiles(instance, [], '', SHARED_DIRS);
  const binaries = mods.filter(mod => mode === 'all' || (mode === 'missing' && !mod.source));
  const included = new Set(binaries);
  if (config.files.length + binaries.length + 2 > LIMITS.entries ||
    config.total + binaries.reduce((sum, mod) => sum + mod.size, 0) > LIMITS.overrides) {
    throw new Error('Сборка превышает лимит архива .veyra (4 ГБ файлов)');
  }
  for (const mod of mods) {
    const current = await fs.lstat(mod.file);
    if (!current.isFile() || current.size !== mod.size || current.mtimeMs !== mod.modified) {
      throw new Error('Моды изменились. Откройте окно экспорта снова.');
    }
  }
  const dependencies = { minecraft: instance.minecraftVersion };
  if (instance.loader !== 'vanilla') dependencies[instance.loader === 'fabric' ? 'fabric-loader' : instance.loader] = instance.loaderVersion;
  const index = { formatVersion: 1, game: 'minecraft', name: instance.name, versionId: 'veyra-1', dependencies,
    files: mods.filter(mod => mod.source && !included.has(mod)).map(mod => ({ path: 'mods/' + mod.name, hashes: { sha1: mod.sha1 },
      fileSize: mod.size, downloads: [mod.source.url] })) };
  const descriptor = { format: 1, note: instance.note, mods: mods.map(mod => ({
    name: mod.name, version: mod.version, sha1: mod.sha1, source: included.has(mod) ? null : mod.source, embedded: included.has(mod),
  })) };
  readIndex(index);
  const temporary = destination + '.part-' + randomUUID();
  const zip = new ZipFile();
  zip.on('error', error => zip.outputStream.destroy(error));
  try {
    zip.addBuffer(Buffer.from(JSON.stringify(index, null, 2)), 'modrinth.index.json');
    zip.addBuffer(Buffer.from(JSON.stringify(descriptor, null, 2)), 'veyra.json');
    for (const file of config.files) {
      packPath(file.remote);
      zip.addFile(file.local, 'overrides/' + file.remote);
    }
    for (const mod of binaries) zip.addFile(mod.file, 'overrides/mods/' + mod.name, { compress: false });
    zip.end();
    await pipeline(zip.outputStream, createWriteStream(temporary, { flags: 'wx' }));
    await fs.rename(temporary, destination);
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}

async function inspectShare(file) {
  const zip = await open(file, { lazyEntries: true, autoClose: false });
  try {
    const entries = await readAllEntries(zip);
    if (entries.length > LIMITS.entries) throw new Error('В файле .veyra слишком много файлов');
    const paths = new Set();
    const embedded = new Map();
    let extracted = 0;
    for (const entry of entries) {
      const name = entry.fileName;
      if (name === 'modrinth.index.json' || name === 'veyra.json') {
        if (entry.uncompressedSize > LIMITS.index) throw new Error('Описание сборки слишком большое');
      } else {
        if (!name.startsWith('overrides/') || name.endsWith('/') || (entry.externalFileAttributes >>> 16 & 0o170000) === 0o120000) {
          throw new Error('Недопустимая запись в файле .veyra');
        }
        const [directory, filename, ...rest] = packPath(name.slice('overrides/'.length));
        if (directory === 'mods' && filename && !rest.length && MOD_NAME.test(filename)) embedded.set(filename, entry);
        else if (!SHARED_DIRS.includes(directory) || !filename) throw new Error('Недопустимая папка в файле .veyra');
        extracted += entry.uncompressedSize;
        if (extracted > LIMITS.overrides) throw new Error('Файлы сборки превышают 4 ГБ');
      }
      if (paths.has(name.toLowerCase())) throw new Error('В файле .veyra повторяются пути');
      paths.add(name.toLowerCase());
    }
    const read = async name => JSON.parse((await readEntry(zip, entries.find(entry => entry.fileName === name))).toString('utf8'));
    if (!paths.has('veyra.json') || !paths.has('modrinth.index.json')) throw new Error('Файл .veyra не содержит описания сборки');
    const index = readIndex(await read('modrinth.index.json'));
    const descriptor = await read('veyra.json');
    if (descriptor.format !== 1 || !Array.isArray(descriptor.mods) || descriptor.mods.length > LIMITS.files) throw new Error('Неизвестный формат .veyra');
    const downloads = new Map(index.files.map(item => [item.path, item]));
    const unresolved = [], binaries = [], seen = new Set();
    for (const mod of descriptor.mods) {
      const name = mod?.name;
      if (typeof name !== 'string' || !MOD_NAME.test(name) || name.includes('/') || !SHA1.test(mod.sha1 || '') || seen.has(name.toLowerCase())) {
        throw new Error('Некорректное описание мода в файле .veyra');
      }
      packPath('mods/' + name);
      seen.add(name.toLowerCase());
      const item = downloads.get('mods/' + name);
      if (item && item.sha1 === mod.sha1 && !mod.embedded && item.urls.every(url => new URL(url).hostname === 'cdn.modrinth.com')) downloads.delete(item.path);
      else if (!item && mod.embedded && embedded.delete(name)) binaries.push(mod);
      else if (!item && !mod.embedded) unresolved.push(name);
      else throw new Error('Список модов не совпал с содержимым .veyra');
    }
    if (downloads.size || embedded.size) throw new Error('Файл .veyra содержит моды вне списка');
    // Check embedded JARs before installation can copy any files.
    const { openEntryReadStream } = require('@xmcl/unzip');
    for (const mod of binaries) {
      const entry = entries.find(item => item.fileName === 'overrides/mods/' + mod.name);
      if (entry.uncompressedSize > LIMITS.file) throw new Error('Встроенный мод слишком большой');
      const digest = createHash('sha1');
      await pipeline(await openEntryReadStream(zip, entry), digest);
      if (digest.digest('hex') !== mod.sha1) throw new Error('Контрольная сумма не совпала для «' + mod.name + '»');
    }
    return { index, note: typeof descriptor.note === 'string' ? descriptor.note.slice(0, 180) : '',
      unresolved, embedded: binaries.length, count: descriptor.mods.length };
  } finally { zip.close(); }
}

module.exports = { inspectExport, resolveExport, exportBuild, inspectShare };
