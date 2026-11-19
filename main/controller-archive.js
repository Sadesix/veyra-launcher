const { open, readAllEntries, readEntry, openEntryReadStream } = require('@xmcl/unzip');
const { CONFIG_DIRS } = require('./controller-build');

const buildDirs = new Set(['mods', ...CONFIG_DIRS]);
const modes = new Set(['build', 'world', 'both']);
const version = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;

function memberPath(name) {
  const parts = name.replace(/\/$/, '').split('/');
  if (parts.length > 48 || parts.some(part => !part || part === '.' || part === '..' ||
    /[\\:\p{Cc}]/u.test(part) || Buffer.byteLength(part) > 255)) throw new Error('Недопустимый путь в ZIP: ' + name.slice(0, 140));
  return parts;
}

async function readControllerArchive(filename, mode) {
  if (!modes.has(mode)) throw new Error('Выберите, что загрузить');
  const zip = await open(filename, { lazyEntries: true, autoClose: false });
  try {
    const entries = await readAllEntries(zip);
    if (entries.length > 100000) throw new Error('В ZIP больше 100 000 файлов');
    const members = [];
    for (const entry of entries) {
      if (entry.fileName.startsWith('__MACOSX/')) continue;
      if ((entry.externalFileAttributes >>> 16 & 0o170000) === 0o120000) throw new Error('ZIP содержит символические ссылки');
      const parts = memberPath(entry.fileName);
      if (!entry.fileName.endsWith('/')) members.push({ entry, parts });
    }
    // A plain world ZIP can contain level.dat at its root or have one wrapping folder.
    if (members.length && members.every(({ parts }) => parts.length > 1 && parts[0] === members[0].parts[0]) &&
        !buildDirs.has(members[0].parts[0]) && members[0].parts[0] !== 'world') {
      for (const item of members) item.parts.shift();
    }
    const manifest = members.find(item => item.parts.join('/') === '.veyra-server.json');
    let compatibility;
    if (manifest && mode !== 'world') {
      if (manifest.entry.uncompressedSize > 65536) throw new Error('Описание серверного ZIP слишком большое');
      const data = JSON.parse((await readEntry(zip, manifest.entry)).toString('utf8'));
      if (!version.test(data.minecraftVersion || '') || !['vanilla', 'fabric', 'forge', 'neoforge'].includes(data.loader) ||
          (data.loader !== 'vanilla' && !version.test(data.loaderVersion || ''))) throw new Error('Некорректная версия сборки в ZIP');
      compatibility = { minecraftVersion: data.minecraftVersion, loader: data.loader, loaderVersion: data.loaderVersion || '' };
    }
    const levels = members.filter(item => item.parts.at(-1) === 'level.dat');
    const level = levels.find(item => item.parts.join('/') === 'world/level.dat') ||
      (levels.length === 1 && levels[0].parts.length <= 2 ? levels[0] : null);
    if (mode !== 'build' && !level) throw new Error('В архиве не найден единственный мир с level.dat');
    const worldPrefix = level?.parts.slice(0, -1) || [];
    const seen = new Set();
    const files = [];
    let total = 0;
    for (const { entry, parts } of members) {
      if (parts.at(-1) === 'session.lock' || parts.at(-1) === '.DS_Store' || parts[0] === '.veyra-server.json') continue;
      const build = mode !== 'world' && parts.length >= 2 && buildDirs.has(parts[0]);
      const save = mode !== 'build' && parts.length > worldPrefix.length &&
        worldPrefix.every((part, i) => parts[i] === part);
      if (!build && !save) continue;
      if (build && parts[0] === 'mods' && (parts.length !== 2 || !/\.jar(?:\.disabled)?$/i.test(parts[1]))) continue;
      const remote = (build ? parts : ['world', ...parts.slice(worldPrefix.length)]).join('/');
      const key = remote.toLowerCase();
      if (seen.has(key)) throw new Error('В серверном ZIP повторяется путь ' + remote);
      seen.add(key);
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) throw new Error('Некорректный размер файла в ZIP');
      total += entry.uncompressedSize;
      if (total > 64 * 1024 ** 3) throw new Error('В архиве больше 64 ГБ данных');
      files.push({ remote, size: entry.uncompressedSize, open: () => openEntryReadStream(zip, entry) });
    }
    if (mode !== 'world' && !files.some(file => buildDirs.has(file.remote.split('/')[0]))) throw new Error('В архиве нет модов или конфигов сборки');
    return { files, total, compatibility, close: () => zip.close() };
  } catch (error) {
    zip.close();
    throw error;
  }
}

module.exports = { readControllerArchive };
