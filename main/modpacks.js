const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createReadStream, createWriteStream } = require('node:fs');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { describeError } = require('./network');

// Сборки модов Modrinth (.mrpack): поиск, выбор версии и распаковка в папку новой сборки Veyra.
// Формат: ZIP с modrinth.index.json (Minecraft, загрузчик, список файлов со ссылками и хешами)
// и папками overrides/ и client-overrides/, которые копируются в папку игры как есть.
const API = 'https://api.modrinth.com/v2';
const SUPPORTED = ['fabric', 'forge', 'neoforge'];
// Ключ загрузчика в dependencies сборки → загрузчик Veyra.
const PACK_LOADERS = { 'fabric-loader': 'fabric', forge: 'forge', neoforge: 'neoforge' };
// Формат разрешает скачивать файлы сборки только с этих адресов.
const FILE_HOSTS = new Set(['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com']);
const LIMITS = { pack: 1024 ** 3, file: 1024 ** 3, files: 3000, index: 16 * 1024 ** 2, entries: 60000, overrides: 4 * 1024 ** 3, cover: 15 * 1024 ** 2 };
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const VERSION = /^[A-Za-z0-9._+-]{1,100}$/;
const SHA1 = /^[a-f0-9]{40}$/i;
const SHA512 = /^[a-f0-9]{128}$/i;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const CONCURRENCY = 6;

function validId(id) {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('Некорректный ID сборки или версии');
  return id;
}
function modrinthUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'cdn.modrinth.com' ? url.href : ''; } catch { return ''; }
}
function fileUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && FILE_HOSTS.has(url.hostname) ? url.href : ''; } catch { return ''; }
}

// Путь файла сборки: относительный, через «/», без «..», служебных папок Veyra и недопустимых в Windows имён.
function packPath(value) {
  const shown = String(value).slice(0, 160);
  if (typeof value !== 'string' || !value || value.length > 400 || value.includes('\\') || value.startsWith('/')) throw new Error('Недопустимый путь в сборке: ' + shown);
  const parts = value.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part.length > 180 || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || RESERVED.test(part) || /^\.veyra/i.test(part)) throw new Error('Недопустимый путь в сборке: ' + shown);
  }
  return parts;
}

// Описание сборки из modrinth.index.json: проверенный список файлов и то, что нужно для установки игры.
function readIndex(raw) {
  if (!raw || typeof raw !== 'object' || raw.formatVersion !== 1 || raw.game !== 'minecraft') throw new Error('Это не сборка Minecraft в формате Modrinth');
  const dependencies = raw.dependencies && typeof raw.dependencies === 'object' ? raw.dependencies : {};
  if (dependencies['quilt-loader']) throw new Error('Сборка рассчитана на Quilt — Veyra его пока не поддерживает. Выберите версию сборки для Fabric, Forge или NeoForge');
  for (const key of Object.keys(dependencies)) if (key !== 'minecraft' && !PACK_LOADERS[key]) throw new Error('Сборке нужен неизвестный компонент «' + key.slice(0, 60) + '»');
  const minecraft = dependencies.minecraft;
  if (typeof minecraft !== 'string' || !VERSION.test(minecraft)) throw new Error('В сборке не указана версия Minecraft');
  const loaders = Object.keys(dependencies).filter(key => PACK_LOADERS[key]);
  if (loaders.length > 1) throw new Error('В сборке указано несколько загрузчиков сразу');
  const loader = loaders.length ? PACK_LOADERS[loaders[0]] : 'vanilla';
  const loaderVersion = loaders.length ? dependencies[loaders[0]] : '';
  if (loader !== 'vanilla' && (typeof loaderVersion !== 'string' || !VERSION.test(loaderVersion))) throw new Error('В сборке неверно указана версия загрузчика');
  if (!Array.isArray(raw.files) || raw.files.length > LIMITS.files) throw new Error('В сборке слишком много файлов или нет их списка');
  const seen = new Set();
  const files = [];
  for (const item of raw.files) {
    if (!item || typeof item !== 'object') throw new Error('Описание файла сборки повреждено');
    const parts = packPath(item.path);
    const key = parts.join('/').toLowerCase();
    if (seen.has(key)) throw new Error('Файл указан в сборке дважды: ' + item.path);
    seen.add(key);
    // Файлы только для сервера клиенту не нужны.
    if (item.env?.client === 'unsupported') continue;
    const sha1 = item.hashes?.sha1, sha512 = item.hashes?.sha512;
    if (typeof sha1 !== 'string' || !SHA1.test(sha1) || sha512 !== undefined && (typeof sha512 !== 'string' || !SHA512.test(sha512))) throw new Error('У файла «' + item.path + '» нет контрольной суммы');
    if (!Number.isSafeInteger(item.fileSize) || item.fileSize < 0 || item.fileSize > LIMITS.file) throw new Error('Неверный размер файла «' + item.path + '»');
    const urls = (Array.isArray(item.downloads) ? item.downloads : []).map(fileUrl).filter(Boolean);
    if (!urls.length) throw new Error('Файл «' + item.path + '» скачивается с адреса, который формат Modrinth не разрешает');
    files.push({ path: parts.join('/'), parts, size: item.fileSize, sha1: sha1.toLowerCase(), sha512: sha512 ? sha512.toLowerCase() : '', urls });
  }
  return { name: typeof raw.name === 'string' ? raw.name.slice(0, 120) : '', versionId: typeof raw.versionId === 'string' ? raw.versionId.slice(0, 80) : '', minecraft, loader, loaderVersion, files };
}

async function openZip(file) {
  const { open } = require('@xmcl/unzip');
  return open(file, { lazyEntries: true, autoClose: false });
}

// Описание сборки из скачанного .mrpack.
async function inspectPack(file) {
  const { readAllEntries, readEntry } = require('@xmcl/unzip');
  let zip;
  try { zip = await openZip(file); } catch { throw new Error('Файл сборки повреждён: это не ZIP-архив'); }
  try {
    const entries = await readAllEntries(zip);
    if (entries.length > LIMITS.entries) throw new Error('В архиве сборки слишком много файлов');
    const entry = entries.find(item => item.fileName === 'modrinth.index.json');
    if (!entry) throw new Error('В архиве нет modrinth.index.json — это не сборка Modrinth');
    if (entry.uncompressedSize > LIMITS.index) throw new Error('Описание сборки слишком большое');
    let raw;
    try { raw = JSON.parse((await readEntry(zip, entry)).toString('utf8')); } catch { throw new Error('Описание сборки повреждено'); }
    return readIndex(raw);
  } finally { zip.close(); }
}

async function fileHash(file, algorithm) {
  const hash = createHash(algorithm);
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

// Папка внутри сборки: каждая уже существующая ступень пути должна быть обычной папкой, а не ссылкой.
async function prepareFolder(directory, parts, checked) {
  let current = directory;
  for (const part of parts) {
    current = path.join(current, part);
    if (checked.has(current)) continue;
    // Загрузки идут параллельно: папку мог только что создать соседний поток.
    await fs.mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('В сборке на месте папки «' + path.relative(directory, current) + '» лежит файл или ссылка');
    checked.add(current);
  }
}
async function destination(directory, parts, checked) {
  await prepareFolder(directory, parts.slice(0, -1), checked);
  const file = path.join(directory, ...parts);
  const relative = path.relative(directory, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Недопустимый путь в сборке: ' + parts.join('/'));
  const stat = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new Error('В сборке на месте файла «' + parts.join('/') + '» лежит папка или ссылка');
  return { file, exists: Boolean(stat) };
}

// Скачивание с проверкой размера и хеша: файл появляется на месте только целиком и проверенным.
async function download({ fetch: fetcher, agent, urls, size, sha1, sha512, file, signal, onBytes = () => {}, name = path.basename(file), limit = LIMITS.file }) {
  const algorithm = sha512 ? 'sha512' : 'sha1';
  const expected = (sha512 || sha1).toLowerCase();
  let lastError;
  for (const url of urls) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      signal?.throwIfAborted();
      const temporary = file + '.veyra-part-' + randomUUID().slice(0, 8);
      let received = 0;
      try {
        const response = await fetcher(url, { redirect: 'follow', headers: { 'User-Agent': agent }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000) });
        if (!response.ok || !response.body) throw new Error('HTTP ' + response.status);
        const hash = createHash(algorithm);
        const meter = new Transform({ transform(chunk, _encoding, done) {
          received += chunk.length;
          if (received > limit || size != null && received > size) return done(new Error('размер не совпал'));
          hash.update(chunk); onBytes(chunk.length); done(null, chunk);
        } });
        await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temporary, { flags: 'wx' }), signal ? { signal } : {});
        if (size != null && received !== size) throw new Error('размер не совпал');
        if (hash.digest('hex') !== expected) throw new Error('контрольная сумма не совпала');
        await fs.rename(temporary, file);
        return received;
      } catch (error) {
        onBytes(-received);
        await fs.rm(temporary, { force: true }).catch(() => {});
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : error;
        lastError = error;
      }
    }
  }
  throw new Error('Не удалось скачать «' + name + '»: ' + describeError(lastError));
}

// Файлы из списка сборки и папки overrides: всё проверено по хешам, повторный запуск докачивает недостающее.
async function applyPack(packFile, index, directory, { fetch: fetcher = (...args) => fetch(...args), agent = 'VeyraLauncher', signal, progress = () => {} } = {}) {
  const checked = new Set();
  const total = index.files.reduce((sum, item) => sum + item.size, 0);
  let completed = 0, done = 0, cursor = 0;
  const report = () => progress({ phase: 'Сборка модов', completed, total, message: 'Моды и файлы сборки: ' + done + ' / ' + index.files.length });
  report();
  // После первой ошибки потоки не берут новые файлы, а установка ждёт их все: ничего не пишется после её конца.
  let failure = null;
  const worker = async () => {
    while (!failure && cursor < index.files.length) {
      try {
        signal?.throwIfAborted();
        const item = index.files[cursor++];
        const target = await destination(directory, item.parts, checked);
        const algorithm = item.sha512 ? 'sha512' : 'sha1';
        if (target.exists && await fileHash(target.file, algorithm) === (item.sha512 || item.sha1)) completed += item.size;
        else await download({ fetch: fetcher, agent, urls: item.urls, size: item.size, sha1: item.sha1, sha512: item.sha512, file: target.file, signal, name: item.path, onBytes: bytes => { completed += bytes; report(); } });
        done++;
        report();
      } catch (error) { failure ||= error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, index.files.length) }, worker));
  if (failure) throw failure;
  return { files: index.files.length, overrides: await extractOverrides(packFile, directory, { signal, progress }) };
}

// overrides/ копируется первым, client-overrides/ — поверх него. Ссылки из архива не создаются.
async function extractOverrides(packFile, directory, { signal, progress = () => {} } = {}) {
  const { readAllEntries, openEntryReadStream } = require('@xmcl/unzip');
  const zip = await openZip(packFile);
  try {
    const entries = await readAllEntries(zip);
    const pick = prefix => entries.filter(entry => entry.fileName.startsWith(prefix) && !entry.fileName.endsWith('/') && (entry.externalFileAttributes >>> 16 & 0o170000) !== 0o120000).map(entry => ({ entry, parts: packPath(entry.fileName.slice(prefix.length)) }));
    const list = [...pick('overrides/'), ...pick('client-overrides/')];
    const total = list.reduce((sum, item) => sum + item.entry.uncompressedSize, 0);
    if (total > LIMITS.overrides) throw new Error('Настройки сборки занимают слишком много места');
    const checked = new Set();
    let completed = 0;
    for (const [index, { entry, parts }] of list.entries()) {
      signal?.throwIfAborted();
      if (index % 25 === 0) progress({ phase: 'Сборка модов', completed, total, message: 'Настройки сборки: ' + index + ' / ' + list.length });
      const target = await destination(directory, parts, checked);
      const temporary = target.file + '.veyra-part-' + randomUUID().slice(0, 8);
      try {
        await pipeline(await openEntryReadStream(zip, entry), createWriteStream(temporary, { flags: 'wx' }), signal ? { signal } : {});
        await fs.rename(temporary, target.file);
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      completed += entry.uncompressedSize;
    }
    progress({ phase: 'Сборка модов', completed: total, total, message: 'Настройки сборки: ' + list.length + ' / ' + list.length });
    return list.length;
  } finally { zip.close(); }
}

// Сведения о сборке в настройках экземпляра. Файл .mrpack нужен, пока сборка не распакована.
function packRecord(raw) {
  if (!raw || typeof raw !== 'object' || raw.source !== 'modrinth' || !ID.test(raw.projectId || '') || !ID.test(raw.versionId || '')) return null;
  const state = raw.state === 'applied' ? 'applied' : 'pending';
  const file = raw.file;
  const validFile = file && typeof file === 'object' && modrinthUrl(file.url) && Number.isSafeInteger(file.size) && file.size > 0 && file.size <= LIMITS.pack && typeof file.sha1 === 'string' && SHA1.test(file.sha1) && (!file.sha512 || typeof file.sha512 === 'string' && SHA512.test(file.sha512)) && typeof file.filename === 'string';
  if (state === 'pending' && !validFile) return null;
  return {
    source: 'modrinth',
    projectId: raw.projectId,
    versionId: raw.versionId,
    slug: typeof raw.slug === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(raw.slug) ? raw.slug : '',
    title: typeof raw.title === 'string' ? raw.title.slice(0, 120) : '',
    version: typeof raw.version === 'string' ? raw.version.slice(0, 80) : '',
    icon: modrinthUrl(raw.icon),
    state,
    file: state === 'pending' ? { url: modrinthUrl(file.url), filename: file.filename.slice(0, 200), size: file.size, sha1: file.sha1.toLowerCase(), sha512: file.sha512 ? file.sha512.toLowerCase() : '' } : null,
    appliedAt: typeof raw.appliedAt === 'string' ? raw.appliedAt.slice(0, 40) : '',
  };
}

class ModpackCatalog {
  constructor({ fetch: fetcher = (...args) => fetch(...args), version = '0' } = {}) {
    this.fetch = fetcher;
    this.agent = 'VeyraLauncher/' + version;
    this.cache = new Map();
  }
  async api(route, { method = 'GET', body } = {}) {
    const response = await this.fetch(API + route, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'User-Agent': this.agent, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, signal: AbortSignal.timeout(25000) });
    if (!response.ok) throw new Error(response.status === 429 ? 'Modrinth просит подождать: слишком много запросов. Повторите чуть позже' : response.status === 404 ? 'Сборка или её версия больше недоступна на Modrinth' : 'Modrinth: HTTP ' + response.status);
    return response.json();
  }
  async cached(route) {
    const cached = this.cache.get(route);
    if (cached && Date.now() - cached.time < 300000) return cached.value;
    const value = await this.api(route);
    if (this.cache.size > 150) this.cache.clear();
    this.cache.set(route, { time: Date.now(), value });
    return value;
  }
  async search(options = {}) {
    const loader = SUPPORTED.includes(options.loader) ? options.loader : '';
    const facets = [['project_type:modpack'], loader ? ['categories:' + loader] : SUPPORTED.map(item => 'categories:' + item)];
    if (typeof options.gameVersion === 'string' && VERSION.test(options.gameVersion)) facets.push(['versions:' + options.gameVersion]);
    const params = new URLSearchParams({ query: String(options.query || '').slice(0, 150), facets: JSON.stringify(facets), index: ['relevance', 'downloads', 'updated', 'newest'].includes(options.sort) ? options.sort : 'downloads', limit: '18', offset: String(Math.max(0, Math.min(9800, Number(options.offset) || 0))) });
    const result = await this.api('/search?' + params);
    return {
      total: result.total_hits || 0,
      hits: (result.hits || []).filter(item => ID.test(item.project_id || '')).map(item => ({
        id: item.project_id,
        slug: item.slug,
        title: String(item.title || ''),
        description: String(item.description || ''),
        author: String(item.author || ''),
        downloads: Number(item.downloads) || 0,
        icon: modrinthUrl(item.icon_url),
        image: modrinthUrl(item.featured_gallery || item.gallery?.[0]),
        loaders: SUPPORTED.filter(name => item.categories?.includes(name)),
        categories: (item.display_categories || []).filter(name => !SUPPORTED.includes(name)).slice(0, 4),
        gameVersions: Array.isArray(item.versions) ? item.versions.filter(value => VERSION.test(value)).slice(-40) : [],
        updated: item.date_modified || '',
      })),
    };
  }
  // Версии сборки, которые Veyra может поставить: с файлом .mrpack и загрузчиком Fabric, Forge или NeoForge.
  async versions(projectId) {
    const versions = await this.cached('/project/' + validId(projectId) + '/version');
    return versions.filter(version => this.packFile(version) && version.loaders?.some(name => SUPPORTED.includes(name)))
      .sort((a, b) => new Date(b.date_published) - new Date(a.date_published))
      .slice(0, 1000)
      .map(version => ({ id: version.id, name: String(version.version_number || version.name || version.id).slice(0, 80), channel: version.version_type, gameVersions: (version.game_versions || []).filter(value => VERSION.test(value)), loaders: SUPPORTED.filter(name => version.loaders.includes(name)), published: version.date_published || '', size: this.packFile(version).size }));
  }
  async details(projectId) {
    const [project, versions] = await Promise.all([this.cached('/project/' + validId(projectId)), this.versions(projectId)]);
    if (project.project_type !== 'modpack') throw new Error('Это не сборка модов');
    return { id: project.id, slug: project.slug, title: String(project.title || ''), description: String(project.description || ''), icon: modrinthUrl(project.icon_url), image: this.image(project), downloads: Number(project.downloads) || 0, followers: Number(project.followers) || 0, versions };
  }
  packFile(version) {
    const file = version.files?.find(item => item.primary && /\.mrpack$/i.test(item.filename || '')) || version.files?.find(item => /\.mrpack$/i.test(item.filename || ''));
    if (!file || !modrinthUrl(file.url) || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > LIMITS.pack || typeof file.hashes?.sha1 !== 'string' || !SHA1.test(file.hashes.sha1)) return null;
    return { url: modrinthUrl(file.url), filename: String(file.filename).slice(0, 200), size: file.size, sha1: file.hashes.sha1.toLowerCase(), sha512: typeof file.hashes.sha512 === 'string' && SHA512.test(file.hashes.sha512) ? file.hashes.sha512.toLowerCase() : '' };
  }
  image(project) {
    const gallery = Array.isArray(project.gallery) ? project.gallery : [];
    const picture = gallery.find(item => item.featured) || gallery[0];
    return picture ? modrinthUrl(picture.raw_url) || modrinthUrl(picture.url) : '';
  }
  // Проверенные сведения для новой сборки: проект, версия, загрузчик и файл .mrpack.
  async resolve(projectId, versionId) {
    const project = await this.cached('/project/' + validId(projectId));
    if (project.project_type !== 'modpack') throw new Error('Это не сборка модов');
    const version = await this.cached('/version/' + validId(versionId));
    if (version.project_id !== project.id) throw new Error('Версия относится к другой сборке');
    const file = this.packFile(version);
    if (!file) throw new Error('У этой версии нет файла сборки .mrpack');
    const loader = SUPPORTED.find(name => version.loaders?.includes(name));
    if (!loader) throw new Error(version.loaders?.includes('quilt') ? 'Эта версия сборки рассчитана на Quilt — Veyra его пока не поддерживает' : 'Эта версия сборки не для Fabric, Forge или NeoForge');
    const minecraft = (version.game_versions || []).find(value => VERSION.test(value));
    if (!minecraft) throw new Error('У версии сборки не указан Minecraft');
    return { project, version, file, loader, minecraft, image: this.image(project) };
  }
  // Обложка сборки из галереи Modrinth: картинка до 15 МБ во временном файле.
  async fetchImage(url, file) {
    if (!modrinthUrl(url)) return false;
    const response = await this.fetch(url, { headers: { 'User-Agent': this.agent }, signal: AbortSignal.timeout(20000) });
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > LIMITS.cover) return false;
    let size = 0;
    const limit = new Transform({ transform(chunk, _encoding, done) { size += chunk.length; done(size > LIMITS.cover ? new Error('Картинка слишком большая') : null, chunk); } });
    await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(file, { flags: 'wx' }));
    return true;
  }
  fetchPack(file, target, signal, onBytes) {
    return download({ fetch: this.fetch, agent: this.agent, urls: [file.url], size: file.size, sha1: file.sha1, sha512: file.sha512, file: target, signal, onBytes, name: file.filename, limit: LIMITS.pack });
  }
  // Моды, ресурспаки и шейдеры сборки, найденные на Modrinth по хешу, появляются в мастерской с названием,
  // иконкой и зависимостями — их можно обновлять и отключать, как добавленные из каталога.
  async registerContent(content, instance, index, { safeIcon }) {
    const kinds = { mods: { kind: 'mods', ext: '.jar' }, resourcepacks: { kind: 'resourcepacks', ext: '.zip' }, shaderpacks: { kind: 'shaders', ext: '.zip' } };
    const candidates = index.files.filter(item => item.parts.length === 2 && kinds[item.parts[0]] && item.parts[1].toLowerCase().endsWith(kinds[item.parts[0]].ext));
    if (!candidates.length) return 0;
    const versions = {};
    for (let start = 0; start < candidates.length; start += 500) Object.assign(versions, await this.api('/version_files', { method: 'POST', body: { hashes: candidates.slice(start, start + 500).map(item => item.sha1), algorithm: 'sha1' } }));
    const found = candidates.map(item => ({ item, version: versions[item.sha1] })).filter(({ version }) => version && ID.test(version.project_id || '') && ID.test(version.id || ''));
    const ids = [...new Set(found.map(({ version }) => version.project_id))];
    const projects = new Map();
    for (let start = 0; start < ids.length; start += 100) for (const project of await this.api('/projects?ids=' + encodeURIComponent(JSON.stringify(ids.slice(start, start + 100))))) projects.set(project.id, project);
    const data = await content.manifest(instance);
    const inPack = new Set(found.map(({ version }) => version.project_id));
    let added = 0;
    for (const { item, version } of found) {
      const project = projects.get(version.project_id);
      if (!project) continue;
      const kind = kinds[item.parts[0]].kind;
      data.items = data.items.filter(other => !(other.kind === kind && other.file === item.parts[1]) && other.projectId !== project.id);
      data.items.push({
        kind, file: item.parts[1], source: 'modrinth', projectId: project.id, versionId: version.id, title: String(project.title || item.parts[1]).slice(0, 120),
        version: String(version.version_number || '').slice(0, 80), icon: safeIcon(project.icon_url), dependency: false,
        dependencies: [...new Set((version.dependencies || []).filter(dep => dep.dependency_type === 'required' && inPack.has(dep.project_id)).map(dep => dep.project_id))],
        incompatibilities: (version.dependencies || []).filter(dep => dep.dependency_type === 'incompatible').map(dep => ({ projectId: dep.project_id, versionId: dep.version_id })),
        installedAt: Date.now(), pack: true,
      });
      added++;
    }
    await content.save(instance, data);
    return added;
  }
}

module.exports = { ModpackCatalog, inspectPack, applyPack, readIndex, packPath, packRecord, SUPPORTED, LIMITS };
