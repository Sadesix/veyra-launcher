const { app, BrowserWindow, dialog, ipcMain, protocol, shell } = require('electron');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { launch, Version } = require('@xmcl/core');
const { getVersionList } = require('@xmcl/installer');
const { installBase, installModdedLibraries } = require('./game-install');
const { fetchLoaderVersions, installLoader, validVersion } = require('./loaders');
const { requiredJava, resolveJava, scanJava, javaInfo } = require('./java-runtime');

if (process.env.VEYRA_TEST_DATA_DIR) app.setPath('userData', path.resolve(process.env.VEYRA_TEST_DATA_DIR));
protocol.registerSchemesAsPrivileged([{ scheme: 'veyra', privileges: { secure: true, standard: true, supportFetchAPI: true } }]);

let window;
let settings;
let manifest = { latest: {}, versions: [] };
let activeOperation = null;
let gameProcess = null;
let refreshPromise = null;
let javaCandidates = [];
let saveQueue = Promise.resolve();
let progressAt = 0;
let lastProgress = null;

const dataDir = () => app.getPath('userData');
const settingsFile = () => path.join(dataDir(), 'settings.json');
const manifestFile = () => path.join(dataDir(), 'version-manifest.json');
const logFile = () => path.join(dataDir(), 'launcher.log');
const instancesDir = () => path.join(dataDir(), 'instances');

function broadcast(payload) {
  if (window && !window.isDestroyed()) window.webContents.send('launcher:event', payload);
}

function log(message) {
  fs.appendFile(logFile(), '[' + new Date().toISOString() + '] ' + message + '\n', 'utf8').catch(() => {});
}

function status(message, level = 'info') {
  log(message);
  broadcast({ type: 'status', message, level });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Неизвестная ошибка');
}

function reportError(prefix, error) {
  const message = prefix + ': ' + errorMessage(error);
  log(error?.stack || message);
  broadcast({ type: 'error', message });
  return message;
}

function validName(value) {
  return typeof value === 'string' && value.trim().length >= 2 && value.trim().length <= 40;
}

function defaultSettings() {
  return {
    playerName: 'Player',
    memoryGb: 4,
    javaPath: '',
    showSnapshots: false,
    selectedInstanceId: '',
    instances: [],
  };
}

async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp-' + process.pid + '-' + randomUUID();
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  try { await fs.rename(temporary, file); }
  catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function persist() {
  const snapshot = JSON.parse(JSON.stringify(settings));
  saveQueue = saveQueue.catch(() => {}).then(() => atomicJson(settingsFile(), snapshot));
  return saveQueue;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') log('Не удалось прочитать ' + file + ': ' + errorMessage(error));
    return fallback;
  }
}

function sanitizeInstance(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !/^[a-z0-9-]{1,80}$/i.test(raw.id)) return null;
  if (!validName(raw.name) || !validVersion(raw.minecraftVersion)) return null;
  if (!['vanilla', 'fabric', 'neoforge', 'forge'].includes(raw.loader)) return null;
  if (typeof raw.directory !== 'string' || !path.isAbsolute(raw.directory)) return null;
  return {
    id: raw.id,
    name: raw.name.trim(),
    minecraftVersion: raw.minecraftVersion,
    loader: raw.loader,
    loaderVersion: typeof raw.loaderVersion === 'string' ? raw.loaderVersion : '',
    versionId: typeof raw.versionId === 'string' ? raw.versionId : '',
    directory: path.resolve(raw.directory),
    memoryGb: Number.isInteger(raw.memoryGb) && raw.memoryGb >= 1 && raw.memoryGb <= 64 ? raw.memoryGb : null,
    javaPath: typeof raw.javaPath === 'string' && path.isAbsolute(raw.javaPath) ? raw.javaPath : '',
    createdAt: raw.createdAt || new Date().toISOString(),
    lastPlayedAt: typeof raw.lastPlayedAt === 'string' ? raw.lastPlayedAt : '',
    launchCount: Number.isSafeInteger(raw.launchCount) && raw.launchCount >= 0 ? raw.launchCount : 0,
    note: typeof raw.note === 'string' ? raw.note.slice(0, 180) : '',
    favorite: Boolean(raw.favorite),
    accent: ['violet', 'blue', 'rose', 'amber'].includes(raw.accent) ? raw.accent : 'violet',
    coverFile: typeof raw.coverFile === 'string' && /^cover\.(png|jpg|webp)$/.test(raw.coverFile) ? raw.coverFile : '',
    coverRevision: Number.isSafeInteger(raw.coverRevision) ? raw.coverRevision : 0,
    legacy: Boolean(raw.legacy),
    installed: false,
  };
}

async function readyMarker(instance) {
  if (instance.legacy) {
    const id = instance.versionId || instance.minecraftVersion;
    const versionRoot = path.join(instance.directory, 'versions', id);
    try {
      await Promise.all([
        fs.access(path.join(versionRoot, id + '.json')),
        fs.access(path.join(versionRoot, id + '.jar')),
        fs.access(path.join(versionRoot, '.veyra-installed')).catch(() =>
          fs.access(path.join(versionRoot, '.obsidian-installed'))),
      ]);
      return true;
    } catch { return false; }
  }
  const marker = await readJson(path.join(instance.directory, '.veyra-instance-ready.json'), null);
  if (!marker || marker.id !== instance.id || marker.versionId !== instance.versionId) return false;
  try {
    await fs.access(path.join(instance.directory, 'versions', instance.versionId, instance.versionId + '.json'));
    await fs.access(path.join(instance.directory, 'versions', instance.minecraftVersion, instance.minecraftVersion + '.jar'));
    return true;
  } catch { return false; }
}

async function loadState() {
  const saved = await readJson(settingsFile(), {});
  settings = defaultSettings();
  if (/^[A-Za-z0-9_]{3,16}$/.test(saved.playerName || '')) settings.playerName = saved.playerName;
  if (Number.isInteger(saved.memoryGb) && saved.memoryGb >= 1 && saved.memoryGb <= 64) settings.memoryGb = saved.memoryGb;
  if (typeof saved.javaPath === 'string' && (!saved.javaPath || path.isAbsolute(saved.javaPath))) settings.javaPath = saved.javaPath;
  settings.showSnapshots = Boolean(saved.showSnapshots);
  if (Array.isArray(saved.instances)) {
    settings.instances = saved.instances.map(sanitizeInstance).filter(Boolean);
    settings.selectedInstanceId = typeof saved.selectedInstanceId === 'string' ? saved.selectedInstanceId : '';
  } else if (validVersion(saved.selectedVersion || '')) {
    const legacy = sanitizeInstance({
      id: 'legacy',
      name: 'Моя игра',
      minecraftVersion: saved.selectedVersion,
      loader: 'vanilla',
      directory: path.resolve(saved.gameDirectory || path.join(dataDir(), 'minecraft')),
      versionId: saved.selectedVersion,
      legacy: true,
    });
    if (legacy) {
      settings.instances = [legacy];
      settings.selectedInstanceId = legacy.id;
    }
  }
  if (!settings.instances.some((instance) => instance.id === settings.selectedInstanceId)) {
    settings.selectedInstanceId = settings.instances[0]?.id || '';
  }
  await Promise.all(settings.instances.map(async (instance) => { instance.installed = await readyMarker(instance); }));
  const cached = await readJson(manifestFile(), null);
  if (Array.isArray(cached?.versions)) manifest = cached;
  await persist();
}

function selectedInstance() {
  return settings.instances.find((instance) => instance.id === settings.selectedInstanceId) || null;
}

function requireInstance(id) {
  const instance = settings.instances.find((item) => item.id === id);
  if (!instance) throw new Error('Экземпляр не найден');
  return instance;
}

function publicState() {
  const versions = manifest.versions.filter((version) =>
    validVersion(version.id) && (version.type === 'release' || (settings.showSnapshots && version.type === 'snapshot'))
  ).map((version) => ({
    id: version.id,
    type: version.type,
    releaseTime: version.releaseTime || '',
  }));
  return {
    settings: {
      playerName: settings.playerName,
      memoryGb: settings.memoryGb,
      javaPath: settings.javaPath,
      showSnapshots: settings.showSnapshots,
      selectedInstanceId: settings.selectedInstanceId,
    },
    instances: settings.instances.map((instance) => ({
      ...instance,
      coverUrl: instance.coverFile ? 'veyra://cover/' + encodeURIComponent(instance.id) + '?v=' + instance.coverRevision : '',
    })),
    versions,
    javaCandidates,
    operation: activeOperation ? {
      type: activeOperation.type,
      instanceId: activeOperation.instanceId,
      progress: lastProgress,
    } : null,
    runningInstanceId: gameProcess?.instanceId || null,
    appVersion: app.getVersion(),
    dataDirectory: dataDir(),
  };
}

function emitState() {
  if (settings) broadcast({ type: 'state', state: publicState() });
}

function progress(value, force = false) {
  const now = Date.now();
  if (!force && now - progressAt < 120) return;
  progressAt = now;
  const completed = Number.isFinite(value.completed) ? Math.max(0, value.completed) : 0;
  const total = Number.isFinite(value.total) ? Math.max(0, value.total) : 0;
  lastProgress = {
    phase: value.phase || 'Подготовка',
    completed,
    total,
    percent: total > 0 ? Math.min(100, Math.round(completed / total * 100)) : null,
    message: value.message || value.phase || 'Подготовка',
  };
  broadcast({ type: 'progress', ...lastProgress });
}

async function runTask(task, operation, label, onUpdate) {
  operation.task = task;
  let current = task;
  const send = (force) => {
    if (onUpdate) onUpdate(task, current, force);
    else progress({
      phase: label,
      completed: Number.isFinite(current.progress) ? current.progress : 0,
      total: Number.isFinite(current.total) ? current.total : 0,
      message: label,
    }, force);
  };
  const context = {
    onStart(child) { current = child; send(true); },
    onUpdate(child) { current = child; send(false); },
  };
  const timer = setInterval(() => send(false), 400);
  try { return await task.startAndWait(context); }
  finally {
    clearInterval(timer);
    operation.task = null;
  }
}

function beginOperation(type, instanceId) {
  if (activeOperation) throw new Error('Дождитесь окончания текущей операции');
  if (gameProcess) throw new Error('Сначала закройте запущенную игру');
  const controller = new AbortController();
  activeOperation = { type, instanceId, controller, signal: controller.signal, task: null };
  lastProgress = null;
  emitState();
  return activeOperation;
}

function endOperation(operation) {
  if (activeOperation === operation) {
    activeOperation = null;
    lastProgress = null;
    emitState();
  }
}

async function refreshVersions() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const list = await getVersionList({
        fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(25000) }),
      });
      if (!Array.isArray(list.versions)) throw new Error('Неверный ответ сервера Minecraft');
      manifest = list;
      await atomicJson(manifestFile(), list);
      emitState();
      status('Список версий обновлён', 'success');
      return publicState().versions;
    } catch (error) {
      reportError('Не удалось обновить версии', error);
      throw error;
    } finally { refreshPromise = null; }
  })();
  return refreshPromise;
}

async function createInstance(input) {
  if (activeOperation) throw new Error('Дождитесь окончания установки');
  if (!input || !validName(input.name)) throw new Error('Название: от 2 до 40 символов');
  if (!validVersion(input.minecraftVersion)) throw new Error('Выберите версию Minecraft');
  if (!manifest.versions.some((version) => version.id === input.minecraftVersion)) {
    throw new Error('Версия не найдена. Обновите список');
  }
  const loader = input.loader || 'vanilla';
  if (!['vanilla', 'fabric', 'neoforge', 'forge'].includes(loader)) throw new Error('Выберите загрузчик');
  let loaderVersion = '';
  if (loader !== 'vanilla') {
    const available = await fetchLoaderVersions(loader, input.minecraftVersion);
    loaderVersion = input.loaderVersion || available[0]?.id;
    if (!available.some((item) => item.id === loaderVersion)) {
      throw new Error('Для этой версии Minecraft нет выбранного загрузчика');
    }
  }
  const id = randomUUID();
  const directory = path.join(instancesDir(), id);
  await fs.mkdir(directory, { recursive: true });
  await Promise.all(['mods', 'saves', 'resourcepacks', 'screenshots'].map((name) =>
    fs.mkdir(path.join(directory, name), { recursive: true })));
  const instance = sanitizeInstance({
    id,
    name: input.name,
    minecraftVersion: input.minecraftVersion,
    loader,
    loaderVersion,
    directory,
    createdAt: new Date().toISOString(),
    accent: 'violet',
  });
  settings.instances.unshift(instance);
  settings.selectedInstanceId = id;
  await persist();
  emitState();
  status('Экземпляр «' + instance.name + '» создан', 'success');
  return { ...instance };
}

async function selectInstance(id) {
  requireInstance(id);
  settings.selectedInstanceId = id;
  await persist();
  emitState();
  return publicState();
}

async function updateInstance(id, patch) {
  const instance = requireInstance(id);
  if (!patch || typeof patch !== 'object') throw new Error('Некорректные настройки экземпляра');
  if (patch.name !== undefined) {
    if (!validName(patch.name)) throw new Error('Название: от 2 до 40 символов');
    instance.name = patch.name.trim();
  }
  if (patch.memoryGb !== undefined) {
    if (patch.memoryGb !== null && (!Number.isInteger(Number(patch.memoryGb)) || Number(patch.memoryGb) < 1 || Number(patch.memoryGb) > 64)) {
      throw new Error('Память: от 1 до 64 ГБ');
    }
    instance.memoryGb = patch.memoryGb === null ? null : Number(patch.memoryGb);
  }
  if (patch.javaPath !== undefined) {
    if (typeof patch.javaPath !== 'string' || (patch.javaPath && !path.isAbsolute(patch.javaPath))) {
      throw new Error('Укажите полный путь к Java');
    }
    instance.javaPath = patch.javaPath;
  }
  if (patch.favorite !== undefined) instance.favorite = Boolean(patch.favorite);
  if (patch.note !== undefined) {
    if (typeof patch.note !== 'string' || patch.note.length > 180) throw new Error('Заметка: не более 180 символов');
    instance.note = patch.note.trim();
  }
  if (patch.accent !== undefined) {
    if (!['violet', 'blue', 'rose', 'amber'].includes(patch.accent)) throw new Error('Неизвестный цвет экземпляра');
    instance.accent = patch.accent;
  }
  await persist();
  emitState();
  return { ...instance };
}

async function setInstanceCover(id) {
  const instance = requireInstance(id);
  if (instance.legacy) throw new Error('Обложку старого экземпляра можно добавить после переноса в новую папку');
  const result = await dialog.showOpenDialog(window, {
    title: 'Выберите обложку экземпляра',
    properties: ['openFile'],
    filters: [{ name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const source = result.filePaths[0];
  const stat = await fs.stat(source);
  if (!stat.isFile() || stat.size > 15 * 1024 * 1024) throw new Error('Обложка должна быть файлом до 15 МБ');
  const bytes = await fs.readFile(source);
  const png = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  const jpg = bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
  const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  const extension = png ? 'png' : jpg ? 'jpg' : webp ? 'webp' : '';
  if (!extension) throw new Error('Поддерживаются PNG, JPEG и WebP');
  const name = 'cover.' + extension;
  const temporary = path.join(instance.directory, 'cover.tmp-' + randomUUID());
  await fs.writeFile(temporary, bytes);
  try {
    await fs.rename(temporary, path.join(instance.directory, name));
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  if (instance.coverFile && instance.coverFile !== name) {
    await fs.rm(path.join(instance.directory, instance.coverFile), { force: true }).catch(() => {});
  }
  instance.coverFile = name;
  instance.coverRevision = Date.now();
  await persist();
  emitState();
  status('Обложка экземпляра обновлена', 'success');
  return { ...instance };
}

async function resetInstanceCover(id) {
  const instance = requireInstance(id);
  if (instance.coverFile) {
    await fs.rm(path.join(instance.directory, instance.coverFile), { force: true }).catch(() => {});
    instance.coverFile = '';
    instance.coverRevision = Date.now();
    await persist();
    emitState();
  }
  return { ...instance };
}

async function removeInstance(id) {
  const instance = requireInstance(id);
  if (activeOperation?.instanceId === id || gameProcess?.instanceId === id) {
    throw new Error('Сначала завершите установку или игру');
  }
  const managed = path.resolve(instancesDir());
  const target = path.resolve(instance.directory);
  let movedTo = '';
  if (!instance.legacy && path.dirname(target).toLowerCase() === managed.toLowerCase()) {
    const stat = await fs.lstat(target).catch(() => null);
    if (stat?.isSymbolicLink()) throw new Error('Папка экземпляра является ссылкой');
    if (stat?.isDirectory()) {
      const trash = path.join(dataDir(), 'trash');
      await fs.mkdir(trash, { recursive: true });
      movedTo = path.join(trash, id + '-' + Date.now());
      await fs.rename(target, movedTo);
    }
  }
  settings.instances = settings.instances.filter((item) => item.id !== id);
  if (settings.selectedInstanceId === id) settings.selectedInstanceId = settings.instances[0]?.id || '';
  await persist();
  emitState();
  status('Экземпляр удалён из списка' + (movedTo ? '; файлы перемещены в корзину Veyra' : ''), 'success');
  return { movedTo };
}

async function saveSettings(patch) {
  if (!patch || typeof patch !== 'object') throw new Error('Некорректные настройки');
  if (patch.playerName !== undefined) {
    if (!/^[A-Za-z0-9_]{3,16}$/.test(patch.playerName)) throw new Error('Имя игрока: 3–16 латинских букв, цифр или _');
    settings.playerName = patch.playerName;
  }
  if (patch.memoryGb !== undefined) {
    const memory = Number(patch.memoryGb);
    if (!Number.isInteger(memory) || memory < 1 || memory > 64) throw new Error('Память: от 1 до 64 ГБ');
    settings.memoryGb = memory;
  }
  if (patch.javaPath !== undefined) {
    if (typeof patch.javaPath !== 'string' || (patch.javaPath && !path.isAbsolute(patch.javaPath))) {
      throw new Error('Укажите полный путь к Java');
    }
    if (patch.javaPath && !javaInfo(patch.javaPath)) throw new Error('Выбранная Java не запускается');
    settings.javaPath = patch.javaPath;
  }
  if (patch.showSnapshots !== undefined) settings.showSnapshots = Boolean(patch.showSnapshots);
  await persist();
  emitState();
  return publicState();
}

async function fetchRequirements(metadata, signal) {
  const response = await fetch(metadata.url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
  });
  if (!response.ok) throw new Error('Не удалось получить требования Minecraft: HTTP ' + response.status);
  const json = await response.json();
  return requiredJava(json);
}

async function installInstance(id) {
  const instance = requireInstance(id);
  const metadata = manifest.versions.find((item) => item.id === instance.minecraftVersion);
  if (!metadata) throw new Error('Версия Minecraft отсутствует в списке. Обновите его');
  const operation = beginOperation('install', id);
  instance.installed = false;
  emitState();
  status('Устанавливаем «' + instance.name + '»');
  try {
    if (!instance.legacy) {
      await fs.rm(path.join(instance.directory, '.veyra-instance-ready.json'), { force: true });
    }
    const requirements = await fetchRequirements(metadata, operation.signal);
    const java = await resolveJava(
      { javaVersion: { majorVersion: requirements.major, component: requirements.component } },
      instance.javaPath || settings.javaPath,
      dataDir(),
      progress,
      operation.signal
    );
    const base = await installBase(instance, metadata, operation, runTask, progress);
    if (operation.signal.aborted) throw new Error('Установка отменена');
    let versionId = instance.minecraftVersion;
    if (instance.loader !== 'vanilla') {
      progress({ phase: 'Загрузчик', completed: 0, total: 0, message: 'Устанавливаем ' + instance.loader });
      versionId = await installLoader(instance, java.path, (task) => runTask(task, operation, 'Загрузчик'));
      if (operation.signal.aborted) throw new Error('Установка отменена');
      await installModdedLibraries(instance.directory, versionId, operation, runTask, progress);
    }
    instance.versionId = versionId;
    instance.installed = true;
    if (instance.legacy) {
      await fs.writeFile(path.join(instance.directory, 'versions', versionId, '.veyra-installed'), 'ready', 'utf8');
    } else {
      await atomicJson(path.join(instance.directory, '.veyra-instance-ready.json'), {
        id: instance.id,
        minecraftVersion: instance.minecraftVersion,
        loader: instance.loader,
        loaderVersion: instance.loaderVersion,
        versionId,
        installedAt: new Date().toISOString(),
      });
    }
    await persist();
    emitState();
    status('Экземпляр «' + instance.name + '» готов', 'success');
    return publicState();
  } catch (error) {
    instance.installed = false;
    emitState();
    if (operation.signal.aborted || error?.name === 'CancelledError') {
      status('Установка отменена');
      return publicState();
    }
    reportError('Установка не завершена', error);
    throw error;
  } finally { endOperation(operation); }
}

function offlineUuid(name) {
  const bytes = createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes.toString('hex');
}

async function launchInstance(id) {
  const instance = requireInstance(id);
  if (!instance.installed) throw new Error('Сначала установите экземпляр');
  const operation = beginOperation('launch', id);
  try {
    const version = await Version.parse(instance.directory, instance.versionId);
    const java = await resolveJava(
      version,
      instance.javaPath || settings.javaPath,
      dataDir(),
      progress,
      operation.signal
    );
    progress({ phase: 'Запуск', completed: 0, total: 0, message: 'Запускаем Minecraft' }, true);
    const child = await launch({
      gamePath: instance.directory,
      resourcePath: instance.directory,
      javaPath: java.path,
      version,
      gameProfile: { name: settings.playerName, id: offlineUuid(settings.playerName) },
      maxMemory: (instance.memoryGb || settings.memoryGb) * 1024,
      launcherName: 'Veyra Launcher',
      extraExecOption: { windowsHide: true },
    });
    gameProcess = { child, instanceId: id };
    instance.lastPlayedAt = new Date().toISOString();
    instance.launchCount++;
    await persist().catch((error) => log('Не удалось сохранить историю запуска: ' + errorMessage(error)));
    const onOutput = (chunk) => {
      const message = String(chunk).trim();
      if (!message) return;
      log('[' + instance.name + '] ' + message);
      broadcast({ type: 'log', message: message.slice(-1500), instanceId: id });
    };
    child.stdout?.on('data', onOutput);
    child.stderr?.on('data', onOutput);
    child.once('error', (error) => {
      reportError('Minecraft', error);
      if (gameProcess?.child === child) gameProcess = null;
      emitState();
    });
    child.once('close', (code, signal) => {
      if (gameProcess?.child === child) gameProcess = null;
      emitState();
      status(code === 0 ? 'Minecraft закрыт' : 'Игра завершилась с кодом ' + (code ?? signal ?? '?'), code === 0 ? 'info' : 'error');
    });
    emitState();
    status('Minecraft запущен: ' + instance.name, 'success');
    return { pid: child.pid || null };
  } catch (error) {
    reportError('Не удалось запустить игру', error);
    throw error;
  } finally { endOperation(operation); }
}

async function getLogs() {
  try {
    const content = await fs.readFile(logFile(), 'utf8');
    return content.slice(-120000);
  } catch { return ''; }
}

async function openInstanceFolder(id) {
  const directory = requireInstance(id).directory;
  await fs.mkdir(directory, { recursive: true });
  const error = await shell.openPath(directory);
  if (error) throw new Error(error);
  return true;
}

async function pickJava() {
  const result = await dialog.showOpenDialog(window, {
    title: 'Выберите java.exe или javaw.exe',
    properties: ['openFile'],
    filters: [{ name: 'Java', extensions: ['exe'] }],
  });
  return result.canceled ? null : result.filePaths[0] || null;
}

function registerIpc() {
  ipcMain.handle('launcher:get-state', () => publicState());
  ipcMain.handle('launcher:refresh-versions', () => refreshVersions());
  ipcMain.handle('launcher:get-loader-versions', (_event, loader, mc) => fetchLoaderVersions(loader, mc));
  ipcMain.handle('launcher:create-instance', (_event, input) => createInstance(input));
  ipcMain.handle('launcher:select-instance', (_event, id) => selectInstance(id));
  ipcMain.handle('launcher:update-instance', (_event, id, patch) => updateInstance(id, patch));
  ipcMain.handle('launcher:set-instance-cover', (_event, id) => setInstanceCover(id));
  ipcMain.handle('launcher:reset-instance-cover', (_event, id) => resetInstanceCover(id));
  ipcMain.handle('launcher:remove-instance', (_event, id) => removeInstance(id));
  ipcMain.handle('launcher:install-instance', (_event, id) => installInstance(id));
  ipcMain.handle('launcher:launch-instance', (_event, id) => launchInstance(id));
  ipcMain.handle('launcher:cancel-operation', async () => {
    if (!activeOperation || activeOperation.type !== 'install') return false;
    activeOperation.controller.abort();
    activeOperation.task?.cancel().catch((error) => log('Ошибка отмены: ' + errorMessage(error)));
    status('Отменяем установку…');
    return true;
  });
  ipcMain.handle('launcher:save-settings', (_event, patch) => saveSettings(patch));
  ipcMain.handle('launcher:scan-java', async () => {
    javaCandidates = await scanJava(dataDir(), [settings.javaPath, ...settings.instances.map((item) => item.javaPath)]);
    emitState();
    return javaCandidates;
  });
  ipcMain.handle('launcher:pick-java', () => pickJava());
  ipcMain.handle('launcher:open-instance-folder', (_event, id) => openInstanceFolder(id));
  ipcMain.handle('launcher:open-data-folder', async () => {
    const error = await shell.openPath(dataDir());
    if (error) throw new Error(error);
    return true;
  });
  ipcMain.handle('launcher:get-logs', () => getLogs());
  ipcMain.handle('launcher:window-minimize', () => { window?.minimize(); return true; });
  ipcMain.handle('launcher:window-maximize', () => {
    if (!window) return false;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return window.isMaximized();
  });
  ipcMain.handle('launcher:window-close', () => { window?.close(); return true; });
}

function createWindow() {
  window = new BrowserWindow({
    width: 1460,
    height: 900,
    minWidth: 980,
    minHeight: 650,
    show: false,
    frame: false,
    title: 'Veyra Launcher',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    backgroundColor: '#080911',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { window = null; });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
}

app.whenReady().then(async () => {
  protocol.handle('veyra', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'cover' || url.pathname.split('/').length !== 2) return new Response('', { status: 404 });
      const id = decodeURIComponent(url.pathname.slice(1));
      const instance = settings?.instances.find((item) => item.id === id);
      if (!instance?.coverFile) return new Response('', { status: 404 });
      const file = path.join(instance.directory, instance.coverFile);
      const bytes = await fs.readFile(file);
      const type = instance.coverFile.endsWith('.png') ? 'image/png' : instance.coverFile.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      return new Response(bytes, { headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } });
    } catch { return new Response('', { status: 404 }); }
  });
  await fs.mkdir(dataDir(), { recursive: true });
  await loadState();
  registerIpc();
  createWindow();
  refreshVersions().catch(() => {});
  scanJava(dataDir(), [settings.javaPath, ...settings.instances.map((item) => item.javaPath)])
    .then((found) => { javaCandidates = found; emitState(); })
    .catch((error) => log('Поиск Java: ' + errorMessage(error)));
}).catch((error) => {
  dialog.showErrorBox('Veyra Launcher', errorMessage(error));
  app.quit();
});

app.on('window-all-closed', () => app.quit());
