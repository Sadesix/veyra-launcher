const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createWriteStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { open, readAllEntries, openEntryReadStream } = require('@xmcl/unzip');
const { LaunchPrecheck, getPlatform, DEFAULT_EXTRA_JVM_ARGS } = require('@xmcl/core');

async function checksum(file) {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

// Buffer-backed ZIP reads avoid fd-slicer stream stalls on Windows. Extract
// sequentially; never leave a half-written DLL as a ready file.
async function checkNatives(resource, version, options) {
  options.signal?.throwIfAborted();
  const root = options.nativeRoot || resource.getNativesRoot(version.id);
  const nativeLibraries = version.libraries.filter((lib) => lib.isNative || lib.classifier.startsWith('natives'));
  const names = nativeLibraries.map((lib) => lib.name).sort();
  const cacheFile = path.join(root, '.veyra-natives.json');
  await fs.mkdir(root, { recursive: true });
  const cache = await fs.readFile(cacheFile, 'utf8').then(JSON.parse).catch(() => null);
  if (cache && JSON.stringify(cache.libraries) === JSON.stringify(names) && Array.isArray(cache.entries) &&
      (cache.entries.length > 0 || names.length === 0)) {
    const valid = await Promise.all(cache.entries.map(async (entry) => {
      if (typeof entry?.file !== 'string' || path.basename(entry.file) !== entry.file || typeof entry.hash !== 'string') return false;
      return (await checksum(path.join(root, entry.file)).catch(() => '')) === entry.hash;
    }));
    if (valid.every(Boolean)) return;
  }
  const platform = options.platform || getPlatform();
  const entries = [];
  for (const lib of nativeLibraries) {
    options.signal?.throwIfAborted();
    const archive = await fs.readFile(resource.getLibraryByPath(lib.download.path));
    const zip = await open(archive, { lazyEntries: true, autoClose: false });
    try {
      for (const entry of await readAllEntries(zip)) {
        const file = entry.fileName;
        if (file.endsWith('/') || file.includes('META-INF/') || file.endsWith('.sha1') || file.endsWith('.git') ||
            (lib.extractExclude || []).some((prefix) => file.startsWith(prefix))) continue;
        if (file.includes('/')) {
          const [os, arch] = file.split('/');
          if (os !== platform.name || (arch === 'ia32' ? 'x86' : arch) !== platform.arch) continue;
        }
        const name = path.basename(file);
        const target = path.join(root, name);
        const temporary = target + '.tmp-' + randomUUID();
        try {
          const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
          await pipeline(await openEntryReadStream(zip, entry), createWriteStream(temporary), { signal });
          await fs.rename(temporary, target);
          entries.push({ file: name, hash: await checksum(target) });
        } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      }
    } finally { zip.close(); }
  }
  options.signal?.throwIfAborted();
  const latestEntries = [...new Map(entries.map((entry) => [entry.file, entry])).values()];
  await fs.writeFile(cacheFile, JSON.stringify({ libraries: names, entries: latestEntries }));
}

const prechecks = [LaunchPrecheck.checkVersion, LaunchPrecheck.checkLibraries, checkNatives, LaunchPrecheck.linkAssets];
function javaArguments(extra = []) {
  return [...DEFAULT_EXTRA_JVM_ARGS.filter((value) => !value.startsWith('-Xmx')), ...extra];
}
module.exports = { prechecks, checkNatives, javaArguments };
