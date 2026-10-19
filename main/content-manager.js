const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createWriteStream } = require('node:fs');
const { ContentTransaction } = require('./content-transaction');

const KINDS = { mods: { folder: 'mods', type: 'mod', ext: '.jar' }, saves: { folder: 'saves' }, shaders: { folder: 'shaderpacks', type: 'shader', ext: '.zip' }, resourcepacks: { folder: 'resourcepacks', type: 'resourcepack', ext: '.zip' } };
const MAX_FILE = 512 * 1024 ** 2;
function kindInfo(kind) { if (!KINDS[kind]) throw new Error('Неизвестный раздел содержимого'); return KINDS[kind]; }
function safeName(name) {
  if (typeof name !== 'string' || !name || name.length > 180 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || name === '.' || name === '..' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('Некорректное имя файла или папки');
  return name;
}
function validId(id) { if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('Некорректный ID проекта или версии'); return id; }
function inside(root, target) { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); }
async function exists(file) { return Boolean(await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; })); }
async function plainDirectory(directory, create = false) {
  if (create) await fs.mkdir(directory, { recursive: true });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Папка содержимого должна быть обычной папкой, без ссылок');
  return directory;
}
async function checkedTree(root) {
  let count = 0;
  async function visit(file) {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('Ссылки и специальные файлы не импортируются');
    if (++count > 100000) throw new Error('В папке слишком много файлов');
    if (stat.isDirectory()) for (const entry of await fs.readdir(file)) await visit(path.join(file, entry));
  }
  await visit(root);
}
async function atomic(file, data) {
  const temporary = file + '.tmp-' + randomUUID();
  try { await fs.writeFile(temporary, JSON.stringify(data, null, 2)); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}
function safeIcon(url) { try { const value = new URL(url); return value.protocol === 'https:' && value.hostname === 'cdn.modrinth.com' ? value.href : ''; } catch { return ''; } }
function enabledFile(name) { return name.endsWith('.disabled') ? name.slice(0, -9) : name; }
function projectKind(type) { return Object.keys(KINDS).find(key => KINDS[key].type === type); }
function compatible(version, instance, kind) {
  if (!version.game_versions?.includes(instance.minecraftVersion)) return false;
  if (kind === 'mods') return instance.loader !== 'vanilla' && version.loaders?.includes(instance.loader);
  if (kind === 'resourcepacks') return version.loaders?.includes('minecraft');
  return kind === 'shaders';
}

class ContentManager {
  constructor({ fetch: fetcher = (...args) => fetch(...args), version = '0.6.1' } = {}) {
    this.fetch = fetcher;
    this.agent = 'VeyraLauncher/' + version;
    this.cache = new Map();
    this.plans = new Map();
    this.activeTransactions = new Set();
    this.recoveries = new Map();
  }
  async root(instance, kind) {
    kindInfo(kind);
    await plainDirectory(instance.directory, true);
    return plainDirectory(path.join(instance.directory, KINDS[kind].folder), true);
  }
  async storage(instance, folder) {
    await plainDirectory(instance.directory, true);
    return plainDirectory(path.join(instance.directory, folder), true);
  }
  async manifest(instance) {
    await plainDirectory(instance.directory, true);
    await this.recover(instance);
    const file = path.join(instance.directory, '.veyra-content.json');
    const stat = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat) return { schema: 1, items: [], trash: [] };
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Некорректный файл сведений о содержимом');
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      if (data.schema !== 1 || !Array.isArray(data.items) || !Array.isArray(data.trash)) throw new Error();
      return data;
    } catch { throw new Error('Сведения о содержимом повреждены. Файлы игры сохранены'); }
  }
  async save(instance, data) { await atomic(path.join(instance.directory, '.veyra-content.json'), data); }
  async recover(instance) {
    if (this.activeTransactions.has(instance.id)) return;
    if (!this.recoveries.has(instance.id)) {
      const operation = ContentTransaction.recover(instance.directory).finally(() => this.recoveries.delete(instance.id));
      this.recoveries.set(instance.id, operation);
    }
    return this.recoveries.get(instance.id);
  }
  async list(instance, kind) {
    const root = await this.root(instance, kind);
    const manifest = await this.manifest(instance);
    const entries = [];
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const base = enabledFile(entry.name);
      if (kind === 'saves' ? !entry.isDirectory() : !(entry.isFile() && base.toLowerCase().endsWith(KINDS[kind].ext) || entry.isDirectory() && kind !== 'mods')) continue;
      const stat = await fs.lstat(path.join(root, entry.name));
      const managed = manifest.items.find(item => item.kind === kind && item.file === entry.name);
      const requiredBy = managed ? manifest.items.filter(item => item.dependencies?.includes(managed.projectId) && !item.file.endsWith('.disabled')).map(item => item.title) : [];
      entries.push({ name: entry.name, title: managed?.title || base.replace(/\.(jar|zip)$/i, ''), size: stat.isFile() ? stat.size : null, modifiedAt: stat.mtimeMs, directory: stat.isDirectory(), enabled: stat.isDirectory() || !entry.name.endsWith('.disabled'), source: managed ? 'modrinth' : 'local', projectId: managed?.projectId || '', versionId: managed?.versionId || '', version: managed?.version || '', icon: managed?.icon || '', dependency: Boolean(managed?.dependency), requiredBy, dependencies: managed?.dependencies || [], missingDependencies: (managed?.dependencies || []).filter(id => !manifest.items.some(item => item.projectId === id && !item.file.endsWith('.disabled'))) });
    }
    return { entries, trash: manifest.trash.filter(item => item.kind === kind).map(({ id, name, title, removedAt }) => ({ id, name, title, removedAt })), folder: root, counts: { total: entries.length, enabled: entries.filter(item => item.enabled).length } };
  }
  async entry(instance, kind, name) {
    const root = await this.root(instance, kind);
    const file = path.join(root, safeName(name));
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('Нельзя изменять ссылку или специальный файл');
    if (kind === 'saves' ? !stat.isDirectory() : !(stat.isFile() && enabledFile(name).toLowerCase().endsWith(KINDS[kind].ext) || stat.isDirectory() && kind !== 'mods')) throw new Error('Файл не относится к выбранному разделу');
    return { root, file, stat };
  }
  async dependents(instance, kind, name) {
    const data = await this.manifest(instance);
    const item = data.items.find(item => item.kind === kind && item.file === name);
    return item ? data.items.filter(other => other.dependencies?.includes(item.projectId) && !other.file.endsWith('.disabled')) : [];
  }
  async toggle(instance, kind, name, enabled) {
    if (kind === 'saves') throw new Error('Сохранения не отключаются');
    const { file, root, stat } = await this.entry(instance, kind, name);
    if (stat.isDirectory()) throw new Error('Распакованная папка остаётся доступна игре. Используйте ZIP или переместите папку в корзину');
    const data = await this.manifest(instance);
    const item = data.items.find(item => item.kind === kind && item.file === name);
    if (!enabled) {
      const needed = await this.dependents(instance, kind, name);
      if (needed.length) throw new Error('Сначала отключите: ' + needed.map(item => item.title).join(', '));
    } else if (item) {
      const missing = (item.dependencies || []).filter(id => !data.items.some(other => other.projectId === id && !other.file.endsWith('.disabled')));
      if (missing.length) throw new Error('Сначала включите обязательные зависимости этой установки');
    }
    const next = safeName(enabledFile(name) + (enabled ? '' : '.disabled'));
    if (name === next) return;
    if (await exists(path.join(root, next))) throw new Error('Файл с таким именем уже существует');
    await fs.rename(file, path.join(root, next));
    if (item) item.file = next;
    try { await this.save(instance, data); } catch (error) { await fs.rename(path.join(root, next), file); throw error; }
  }
  async trash(instance, kind, name) {
    const { file } = await this.entry(instance, kind, name);
    const needed = await this.dependents(instance, kind, name);
    if (needed.length) throw new Error('Этот файл нужен: ' + needed.map(item => item.title).join(', ') + '. Сначала отключите или удалите их');
    const data = await this.manifest(instance);
    const item = data.items.find(item => item.kind === kind && item.file === name);
    const id = randomUUID();
    const trash = await this.storage(instance, '.veyra-content-trash');
    const target = path.join(trash, id);
    await fs.rename(file, target);
    data.items = data.items.filter(other => other !== item);
    data.trash.push({ id, kind, name, title: item?.title || name, removedAt: Date.now(), item: item || null });
    try { await this.save(instance, data); } catch (error) { await fs.rename(target, file); throw error; }
    return id;
  }
  async restore(instance, id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Некорректный ID корзины');
    const data = await this.manifest(instance);
    const removed = data.trash.find(item => item.id === id);
    if (!removed) throw new Error('Файл уже восстановлен');
    const root = await this.root(instance, removed.kind);
    const target = path.join(root, safeName(removed.name));
    if (await exists(target)) throw new Error('В папке уже есть файл с таким именем');
    const trash = await this.storage(instance, '.veyra-content-trash');
    const source = path.join(trash, id);
    if ((await fs.lstat(source)).isSymbolicLink()) throw new Error('Нельзя восстановить ссылку');
    await fs.rename(source, target);
    data.trash = data.trash.filter(item => item.id !== id);
    if (removed.item) data.items.push(removed.item);
    try { await this.save(instance, data); } catch (error) { await fs.rename(target, source); throw error; }
  }
  async renameSave(instance, name, nextName) {
    const { file, root } = await this.entry(instance, 'saves', name);
    const next = path.join(root, safeName(nextName.trim()));
    if (file === next) return;
    if (await exists(next)) throw new Error('Такое сохранение уже существует');
    await fs.rename(file, next);
  }
  async duplicateSave(instance, name) {
    const { file, root } = await this.entry(instance, 'saves', name);
    await checkedTree(file);
    let number = 1;
    let target;
    do { target = path.join(root, safeName(name.slice(0, 140) + ' — копия ' + number++)); } while (await exists(target));
    const stageRoot = await this.storage(instance, '.veyra-content-staging');
    const stage = path.join(stageRoot, randomUUID());
    try { await fs.cp(file, stage, { recursive: true, errorOnExist: true, force: false }); await fs.rename(stage, target); }
    finally { await fs.rm(stage, { recursive: true, force: true }); }
    return path.basename(target);
  }
  async import(instance, kind, sources) {
    const root = await this.root(instance, kind);
    const stageRoot = await this.storage(instance, '.veyra-content-staging');
    const stage = await plainDirectory(path.join(stageRoot, randomUUID()), true);
    const copied = [];
    const committed = [];
    try {
      for (const source of sources) {
        if (!path.isAbsolute(source)) throw new Error('Укажите полный путь к файлу');
        const name = safeName(path.basename(source));
        const stat = await fs.lstat(source);
        if (stat.isSymbolicLink()) throw new Error('Ссылки не импортируются');
        if (kind === 'saves') {
          if (!stat.isDirectory() || !await exists(path.join(source, 'level.dat'))) throw new Error('Выберите папку сохранения с level.dat внутри');
          if (inside(source, instance.directory) || inside(instance.directory, source)) throw new Error('Эта папка уже находится в сборке');
          await checkedTree(source);
        } else if (!stat.isFile() || !name.toLowerCase().endsWith(KINDS[kind].ext)) throw new Error('Для этого раздела нужен файл ' + KINDS[kind].ext);
        if (await exists(path.join(root, name)) || copied.includes(name)) throw new Error('Уже есть «' + name + '». Сначала переименуйте или уберите старый файл');
        await fs.cp(source, path.join(stage, name), { recursive: kind === 'saves', errorOnExist: true, force: false });
        copied.push(name);
      }
      for (const name of copied) { await fs.rename(path.join(stage, name), path.join(root, name)); committed.push(name); }
      return copied;
    } catch (error) {
      for (const name of committed.reverse()) await fs.rename(path.join(root, name), path.join(stage, name)).catch(() => {});
      throw error;
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
  }
  async api(route, signal) {
    const response = await this.fetch('https://api.modrinth.com/v2' + route, { headers: { 'User-Agent': this.agent, Accept: 'application/json' }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000) });
    if (!response.ok) throw new Error(response.status === 429 ? 'Modrinth просит подождать: слишком много запросов. Повторите чуть позже' : response.status === 404 ? 'Проект или версия больше недоступны на Modrinth' : 'Modrinth: HTTP ' + response.status);
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
  async categories(kind) {
    const info = kindInfo(kind);
    if (!info.type) return [];
    return (await this.cached('/tag/category')).filter(item => item.project_type === info.type).map(({ name, header }) => ({ name, header }));
  }
  async search(instance, kind, options = {}) {
    const info = kindInfo(kind);
    if (!info.type || kind === 'mods' && instance.loader === 'vanilla') return { hits: [], total: 0 };
    const facets = [['project_type:' + info.type], ['versions:' + instance.minecraftVersion]];
    if (kind === 'mods') facets.push(['categories:' + instance.loader]);
    if (options.category && /^[a-z0-9_-]{1,80}$/i.test(options.category)) facets.push(['categories:' + options.category]);
    const params = new URLSearchParams({ query: String(options.query || '').slice(0, 150), facets: JSON.stringify(facets), index: ['relevance', 'downloads', 'updated', 'newest'].includes(options.sort) ? options.sort : 'downloads', limit: '18', offset: String(Math.max(0, Math.min(9800, Number(options.offset) || 0))) });
    const result = await this.api('/search?' + params);
    return { total: result.total_hits || 0, hits: (result.hits || []).map(item => ({ id: item.project_id, slug: item.slug, title: item.title, description: item.description, author: item.author, downloads: item.downloads, icon: safeIcon(item.icon_url), categories: item.display_categories || item.categories || [] })) };
  }
  async versions(instance, kind, projectId, preview = false) {
    const params = new URLSearchParams({ game_versions: JSON.stringify([instance.minecraftVersion]), include_changelog: 'false' });
    if (kind === 'mods') params.set('loaders', JSON.stringify([instance.loader]));
    if (kind === 'resourcepacks') params.set('loaders', '["minecraft"]');
    const versions = await this.cached('/project/' + validId(projectId) + '/version?' + params);
    return versions.filter(version => compatible(version, instance, kind) && (preview || version.version_type === 'release')).sort((a, b) => (preview ? 0 : Number(b.version_type === 'release') - Number(a.version_type === 'release')) || new Date(b.date_published) - new Date(a.date_published));
  }
  async plan(instance, kind, projectId, options = {}) {
    return this.planBatch(instance, [{ kind, projectId, versionId: options.versionId || '', preview: options.preview === true }]);
  }
  async planBatch(instance, selections) {
    if (!Array.isArray(selections) || !selections.length || selections.length > 40) throw new Error('Добавьте от 1 до 40 проектов в корзину');
    const roots = new Map();
    for (const item of selections) {
      if (!KINDS[item.kind]?.type) throw new Error('Для сохранений доступен импорт папки');
      validId(item.projectId); if (item.versionId) validId(item.versionId);
      if (roots.has(item.projectId)) throw new Error('Этот проект уже есть в корзине');
      if (item.kind === 'mods' && instance.loader === 'vanilla') throw new Error('Для модов нужна сборка с Fabric, Forge или NeoForge');
      roots.set(item.projectId, item);
    }
    const manifest = await this.manifest(instance);
    const installed = [];
    for (const item of manifest.items) {
      try { await this.entry(instance, item.kind, item.file); installed.push(item); } catch { /* Missing files do not satisfy dependencies. */ }
    }
    const nodes = new Map();
    const projects = new Map();
    const getProject = async id => {
      if (!projects.has(id)) { const project = await this.cached('/project/' + validId(id)); validId(project.id); projects.set(id, project); }
      return projects.get(id);
    };
    const resolve = async (id, exactVersion = '', dependency = false, preview = false) => {
      const project = await getProject(id);
      const choice = roots.get(id) || roots.get(project.id);
      if (choice) {
        if (exactVersion && choice.versionId && exactVersion !== choice.versionId) throw new Error('Зависимости требуют другую версию «' + project.title + '». Измените её в корзине');
        exactVersion = choice.versionId || exactVersion; preview = choice.preview === true; dependency = false;
      }
      const targetKind = projectKind(project.project_type);
      if (!targetKind) throw new Error('Неподдерживаемый тип зависимости: ' + project.title);
      if (choice && targetKind !== choice.kind) throw new Error('Проект относится к другому разделу');
      if (nodes.has(project.id)) {
        if (exactVersion && nodes.get(project.id).version.id !== exactVersion) throw new Error('Зависимости требуют разные версии «' + project.title + '». Установка не изменена');
        return project.id;
      }
      let version;
      const existing = installed.find(item => item.projectId === project.id && (!exactVersion || item.versionId === exactVersion));
      if (existing && dependency) version = await this.cached('/version/' + validId(existing.versionId));
      if (!version || !compatible(version, instance, targetKind)) version = exactVersion ? await this.cached('/version/' + validId(exactVersion)) : (await this.versions(instance, targetKind, project.id, preview))[0];
      if (!version || version.project_id !== project.id || !compatible(version, instance, targetKind)) throw new Error('Нет совместимой версии «' + project.title + '» для Minecraft ' + instance.minecraftVersion + ' / ' + instance.loader + (preview ? '' : '. Можно проверить Beta / Alpha'));
      validId(version.id);
      if (nodes.size >= 60) throw new Error('Слишком много зависимостей в одной установке');
      const file = version.files?.find(file => file.primary && !file.file_type?.includes('sources')) || version.files?.find(file => !['sources-jar', 'dev-jar', 'javadoc-jar', 'signature'].includes(file.file_type));
      if (version.files?.some(other => other !== file && other.file_type === 'required-resource-pack')) throw new Error('У «' + project.title + '» есть дополнительный обязательный ресурспак в файлах версии. Добавьте его вручную со страницы проекта');
      if (!file || !safeName(file.filename).toLowerCase().endsWith(KINDS[targetKind].ext) || !Number.isSafeInteger(file.size) || file.size > MAX_FILE || file.size < 0) throw new Error('Неподходящий файл проекта «' + project.title + '»');
      const same = installed.find(item => item.projectId === project.id && item.versionId === version.id);
      const old = installed.find(item => item.projectId === project.id);
      const node = { project, version, kind: targetKind, file, dependency, dependencies: [], installed: Boolean(same), disabled: Boolean(same?.file.endsWith('.disabled')), old: old || null };
      nodes.set(project.id, node);
      for (const requirement of version.dependencies || []) {
        if (requirement.dependency_type !== 'required') continue;
        let requiredId = requirement.project_id;
        if (!requiredId && requirement.version_id) requiredId = (await this.cached('/version/' + validId(requirement.version_id))).project_id;
        if (!requiredId) throw new Error('У «' + project.title + '» есть внешняя обязательная зависимость: ' + (requirement.file_name || 'без ссылки на проект'));
        node.dependencies.push(await resolve(requiredId, requirement.version_id || '', true, preview));
      }
      return project.id;
    };
    for (const item of roots.values()) await resolve(item.projectId, item.versionId || '', false, item.preview === true);
    for (const existing of installed.filter(item => !item.file.endsWith('.disabled') && !nodes.has(item.projectId))) {
      const incompatible = existing.incompatibilities || (await this.cached('/version/' + validId(existing.versionId))).dependencies?.filter(dep => dep.dependency_type === 'incompatible').map(dep => ({ projectId: dep.project_id, versionId: dep.version_id })) || [];
      if (incompatible.some(dep => [...nodes.values()].some(node => dep.versionId ? dep.versionId === node.version.id : dep.projectId === node.project.id))) throw new Error('«' + existing.title + '» несовместим с одним из добавляемых проектов');
    }
    for (const node of nodes.values()) {
      for (const dependency of node.version.dependencies || []) if (dependency.dependency_type === 'incompatible') {
        if ([...nodes.values()].some(other => dependency.version_id ? other.version.id === dependency.version_id : other.project.id === dependency.project_id) || installed.some(item => !item.file.endsWith('.disabled') && !nodes.has(item.projectId) && (dependency.version_id ? item.versionId === dependency.version_id : item.projectId === dependency.project_id))) throw new Error('«' + node.project.title + '» несовместим с одним из установленных модов');
      }
      // Existing pinned dependents must remain valid when their shared library is updated.
      if (node.old && node.old.versionId !== node.version.id) for (const existing of installed.filter(item => !nodes.has(item.projectId) && item.dependencies?.includes(node.project.id))) {
        const version = await this.cached('/version/' + validId(existing.versionId));
        for (const dep of version.dependencies || []) {
          if (dep.dependency_type !== 'required' || !dep.version_id || dep.version_id === node.version.id) continue;
          const dependencyId = dep.project_id || (await this.cached('/version/' + validId(dep.version_id))).project_id;
          if (dependencyId === node.project.id) throw new Error('Обновление «' + node.project.title + '» нарушит зависимость «' + existing.title + '»');
        }
      }
    }
    for (const node of nodes.values()) if (!node.installed) {
      const root = await this.root(instance, node.kind);
      for (const name of [node.file.filename, node.file.filename + '.disabled']) if (await exists(path.join(root, safeName(name))) && node.old?.file !== name) throw new Error('Файл «' + name + '» уже добавлен вручную. Уберите его в корзину перед установкой из каталога');
    }
    const token = randomUUID();
    if (this.plans.size > 30) this.plans.clear();
    this.plans.set(token, { instanceId: instance.id, fingerprint: JSON.stringify(manifest), minecraft: instance.minecraftVersion, loader: instance.loader, nodes: [...nodes.values()], createdAt: Date.now() });
    const first = selections[0];
    return {
      token,
      title: selections.length === 1 ? projects.get(first.projectId)?.title || [...nodes.values()][0].project.title : 'Корзина · ' + selections.length + ' проектов',
      versions: selections.length === 1 ? (await this.versions(instance, first.kind, first.projectId, first.preview)).slice(0, 80).map(version => ({ id: version.id, name: version.version_number, channel: version.version_type })) : [],
      entries: [...nodes.values()].map(node => ({ projectId: node.project.id, versionId: node.version.id, title: node.project.title, icon: safeIcon(node.project.icon_url), version: node.version.version_number, kind: node.kind, dependency: node.dependency, installed: node.installed, disabled: node.disabled, updating: Boolean(node.old && !node.installed), size: node.installed ? 0 : node.file.size })),
      totalBytes: [...nodes.values()].reduce((total, node) => total + (node.installed ? 0 : node.file.size), 0),
    };
  }
  async download(file, destination, signal, onBytes) {
    const url = new URL(file.url);
    if (url.protocol !== 'https:' || url.hostname !== 'cdn.modrinth.com') throw new Error('Неподдерживаемый адрес загрузки');
    const algorithm = file.hashes?.sha512 ? 'sha512' : file.hashes?.sha1 ? 'sha1' : '';
    if (!algorithm || !new RegExp('^[a-f0-9]{' + (algorithm === 'sha512' ? 128 : 40) + '}$', 'i').test(file.hashes[algorithm])) throw new Error('Нет контрольной суммы файла');
    const response = await this.fetch(url.href, { redirect: 'error', headers: { 'User-Agent': this.agent }, signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]) });
    if (!response.ok || !response.body) throw new Error('Не удалось скачать ' + file.filename + ': HTTP ' + response.status);
    const hash = createHash(algorithm);
    let size = 0;
    const verify = new Transform({ transform(chunk, _encoding, done) { size += chunk.length; if (size > MAX_FILE || size > file.size) return done(new Error('Размер загрузки не совпал: ' + file.filename)); hash.update(chunk); onBytes(size); done(null, chunk); } });
    await pipeline(Readable.fromWeb(response.body), verify, createWriteStream(destination, { flags: 'wx' }), { signal });
    if (size !== file.size || hash.digest('hex').toLowerCase() !== file.hashes[algorithm].toLowerCase()) throw new Error('Контрольная сумма не совпала: ' + file.filename + '. Файлы сборки не изменены');
  }
  async install(instance, token, signal, report) {
    const plan = this.plans.get(token);
    this.plans.delete(token);
    if (!plan || plan.instanceId !== instance.id || Date.now() - plan.createdAt > 600000 || plan.minecraft !== instance.minecraftVersion || plan.loader !== instance.loader) throw new Error('План установки устарел. Выберите проект заново');
    const data = await this.manifest(instance);
    if (JSON.stringify(data) !== plan.fingerprint) throw new Error('Содержимое изменилось. Проверьте зависимости заново');
    const stageRoot = await this.storage(instance, '.veyra-content-staging');
    const stage = await plainDirectory(path.join(stageRoot, randomUUID()), true);
    const backups = [];
    const transaction = new ContentTransaction(instance.directory, path.basename(stage));
    const total = plan.nodes.reduce((sum, node) => sum + (node.installed ? 0 : node.file.size), 0);
    let completed = 0;
    this.activeTransactions.add(instance.id);
    try {
      await transaction.begin();
      for (const [index, node] of plan.nodes.entries()) {
        signal.throwIfAborted();
        report({ phase: 'Загрузка', message: node.project.title, completed, total, fileIndex: index + 1, fileCount: plan.nodes.length });
        if (!node.installed) {
          await this.download(node.file, path.join(stage, node.project.id), signal, bytes => report({ phase: 'Загрузка', message: node.project.title, completed: completed + bytes, total, fileIndex: index + 1, fileCount: plan.nodes.length }));
          completed += node.file.size;
        }
      }
      signal.throwIfAborted();
      report({ phase: 'Сохранение', message: 'Добавляем файлы и зависимости', completed: total, total });
      for (const node of plan.nodes) {
        const root = await this.root(instance, node.kind);
        if (node.installed && !node.disabled) continue;
        if (node.old) {
          const previous = (await this.entry(instance, node.kind, node.old.file)).file;
          const backup = path.join(stage, 'old-' + node.project.id);
          await transaction.move(previous, backup);
          backups.push({ previous, backup });
          if (node.installed) await fs.copyFile(backup, path.join(stage, node.project.id));
        }
        const target = path.join(root, safeName(node.file.filename));
        if (await exists(target)) throw new Error('Файл появился во время загрузки: ' + node.file.filename);
        await transaction.move(path.join(stage, node.project.id), target);
      }
      for (const node of plan.nodes) {
        data.items = data.items.filter(item => item.projectId !== node.project.id);
        data.items.push({ kind: node.kind, file: node.file.filename, source: 'modrinth', projectId: node.project.id, versionId: node.version.id, title: node.project.title, version: node.version.version_number, icon: safeIcon(node.project.icon_url), dependency: node.dependency, dependencies: node.dependencies, incompatibilities: (node.version.dependencies || []).filter(dep => dep.dependency_type === 'incompatible').map(dep => ({ projectId: dep.project_id, versionId: dep.version_id })), installedAt: Date.now() });
      }
      // Keep old versions in the same recoverable trash as manual removals.
      for (const backup of backups) {
        if (!await exists(backup.backup)) continue;
        const node = plan.nodes.find(node => node.old && path.basename(backup.backup) === 'old-' + node.project.id);
        if (node?.installed) continue;
        const trash = await this.storage(instance, '.veyra-content-trash');
        const id = randomUUID();
        const archived = path.join(trash, id);
        await transaction.move(backup.backup, archived);
        backup.backup = archived;
        data.trash.push({ id, kind: node.kind, name: enabledFile(node.old.file) + '.disabled', title: node.old.title + ' · прежняя версия', removedAt: Date.now(), item: null });
      }
      data.transactionId = transaction.data.id;
      await this.save(instance, data);
      await transaction.finish();
      return { added: plan.nodes.filter(node => !node.installed || node.disabled).length, dependencies: plan.nodes.filter(node => node.dependency).length };
    } catch (error) {
      try {
        if (transaction.started) await transaction.recover();
        else await fs.rm(stage, { recursive: true, force: true });
      } catch (recoveryError) { throw new Error('Не удалось полностью восстановить файлы после сбоя. Резервные копии сохранены в .veyra-content-staging и .veyra-content-trash внутри сборки. ' + recoveryError.message + ' ' + error.message, { cause: error }); }
      throw error;
    } finally { this.activeTransactions.delete(instance.id); }
  }
}
module.exports = { ContentManager, KINDS, safeName, safeIcon, compatible };
