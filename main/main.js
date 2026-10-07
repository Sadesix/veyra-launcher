const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { launch, MinecraftFolder, Version } = require('@xmcl/core');
const {
  getVersionList,
  installVersionTask,
  installLibrariesTask,
  installResolvedAssetsTask,
} = require('@xmcl/installer');

let mainWindow;
let settings;
let manifest = { latest: {}, versions: [] };
let installedIds = new Set();
let activeOperation = null;
let gameProcess = null;
let refreshPromise = null;
let lastProgressAt = 0;

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const manifestFile = () => path.join(app.getPath('userData'), 'version-manifest.json');
const logFile = () => path.join(app.getPath('userData'), 'launcher.log');

function defaults() {
  return {
    playerName: 'Player',
    javaPath: '',
    memoryGb: 4,
    gameDirectory: path.join(app.getPath('userData'), 'minecraft'),
    showSnapshots: false,
    selectedVersion: '',
  };
}

function broadcast(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('launcher:event', payload);
  }
}

function appendLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFile(logFile(), line, 'utf8').catch(() => {});
}

function announce(message, level = 'info') {
  broadcast({ type: 'status', message, level });
  appendLog(message);
}

function describeError(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Неизвестная ошибка';
}

function reportError(prefix, error) {
  const message = `${prefix}: ${describeError(error)}`;
  appendLog(error instanceof Error && error.stack ? error.stack : message);
  broadcast({ type: 'error', message });
  announce(message, 'error');
}

function validVersionId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9._+-]{1,80}$/.test(id) && id !== '.' && id !== '..';
}

function validateSettings(partial, current) {
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
    throw new Error('Некорректные настройки');
  }
  const next = { ...current };
  for (const [key, value] of Object.entries(partial)) {
    switch (key) {
      case 'playerName': {
        const name = String(value).trim();
        if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
          throw new Error('Имя игрока: 3–16 латинских букв, цифр или _');
        }
        next.playerName = name;
        break;
      }
      case 'javaPath': {
        if (typeof value !== 'string' || (value && !path.isAbsolute(value))) {
          throw new Error('Укажите полный путь к java.exe или javaw.exe');
        }
        next.javaPath = value.trim();
        break;
      }
      case 'memoryGb': {
        const gb = Number(value);
        if (!Number.isInteger(gb) || gb < 1 || gb > 64) {
          throw new Error('Память должна быть от 1 до 64 ГБ');
        }
        next.memoryGb = gb;
        break;
      }
      case 'gameDirectory': {
        if (typeof value !== 'string' || !path.isAbsolute(value.trim())) {
          throw new Error('Укажите полный путь к папке игры');
        }
        next.gameDirectory = path.resolve(value.trim());
        break;
      }
      case 'showSnapshots':
        if (typeof value !== 'boolean') throw new Error('Некорректное значение showSnapshots');
        next.showSnapshots = value;
        break;
      case 'selectedVersion':
        if (value !== '' && !validVersionId(value)) throw new Error('Некорректный номер версии');
        next.selectedVersion = value;
        break;
      default:
        // Ignore fields sent by older or newer renderers.
        break;
    }
  }
  if (next.gameDirectory !== current.gameDirectory && (activeOperation || gameProcess)) {
    throw new Error('Папку игры можно изменить после завершения установки или выхода из игры');
  }
  return next;
}

async function persistSettings(next) {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(settingsFile(), JSON.stringify(next, null, 2), 'utf8');
  settings = next;
  if (next.gameDirectory !== undefined) {
    installedIds = await scanInstalledVersions(next.gameDirectory);
  }
  emitState();
  return { ...settings };
}

async function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(await fs.readFile(settingsFile(), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') appendLog(`Не удалось прочитать настройки: ${describeError(error)}`);
  }
  try {
    settings = validateSettings(saved, defaults());
  } catch (error) {
    settings = defaults();
    appendLog(`Настройки сброшены: ${describeError(error)}`);
  }
  installedIds = await scanInstalledVersions(settings.gameDirectory);
  try {
    const cached = JSON.parse(await fs.readFile(manifestFile(), 'utf8'));
    if (Array.isArray(cached.versions)) manifest = cached;
  } catch (error) {
    if (error.code !== 'ENOENT') appendLog(`Не удалось прочитать список версий: ${describeError(error)}`);
  }
}

async function scanInstalledVersions(gameDirectory) {
  const found = new Set();
  const versionsDir = path.join(gameDirectory, 'versions');
  let entries;
  try {
    entries = await fs.readdir(versionsDir, { withFileTypes: true });
  } catch {
    return found;
  }
  await Promise.all(entries.filter((entry) => entry.isDirectory() && validVersionId(entry.name)).map(async (entry) => {
    const id = entry.name;
    const base = path.join(versionsDir, id, id);
    try {
      const markerDir = path.join(versionsDir, id);
      const markerExists = fs.access(path.join(markerDir, '.veyra-installed')).catch(() =>
        fs.access(path.join(markerDir, '.obsidian-installed'))
      );
      await Promise.all([
        fs.access(`${base}.json`),
        fs.access(`${base}.jar`),
        markerExists,
      ]);
      found.add(id);
    } catch {
      // A partial installation is not ready to launch.
    }
  }));
  return found;
}

function publicState() {
  const known = new Set();
  const versions = [];
  for (const version of manifest.versions) {
    if (!validVersionId(version.id)) continue;
    if (version.type !== 'release' && !(settings.showSnapshots && version.type === 'snapshot')) continue;
    known.add(version.id);
    versions.push({
      id: version.id,
      type: version.type,
      releaseTime: version.releaseTime || '',
      installed: installedIds.has(version.id),
    });
  }
  for (const id of installedIds) {
    if (!known.has(id)) versions.unshift({ id, type: 'release', releaseTime: '', installed: true });
  }
  return {
    settings: { ...settings },
    versions,
    busy: Boolean(activeOperation),
    running: Boolean(gameProcess),
    appVersion: app.getVersion(),
  };
}

function emitState() {
  if (settings) broadcast({ type: 'state', state: publicState() });
}

async function refreshVersions() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    announce('Обновляем список версий…');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const latest = await getVersionList({
        fetch: (url, init) => fetch(url, { ...init, signal: controller.signal }),
      });
      if (!Array.isArray(latest.versions)) throw new Error('Сервер вернул неверный список версий');
      manifest = latest;
      await fs.writeFile(manifestFile(), JSON.stringify(manifest), 'utf8');
      installedIds = await scanInstalledVersions(settings.gameDirectory);
      if (!settings.selectedVersion && validVersionId(manifest.latest?.release)) {
        settings = { ...settings, selectedVersion: manifest.latest.release };
        await fs.writeFile(settingsFile(), JSON.stringify(settings, null, 2), 'utf8');
      }
      emitState();
      announce(`Загружено версий: ${publicState().versions.length}`);
      return publicState().versions;
    } catch (error) {
      reportError('Не удалось обновить версии', error);
      emitState();
      throw error;
    } finally {
      clearTimeout(timeout);
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

function beginOperation(type, id) {
  if (activeOperation) throw new Error('Дождитесь завершения текущей операции');
  if (gameProcess) throw new Error('Дождитесь выхода из Minecraft');
  activeOperation = { type, id, task: null, cancelled: false, controller: new AbortController() };
  emitState();
  return activeOperation;
}

function endOperation(operation) {
  if (activeOperation === operation) {
    activeOperation = null;
    emitState();
  }
}

function phaseMessage(phase) {
  const labels = {
    install: 'Установка Minecraft',
    version: 'Подготовка версии',
    json: 'Загрузка описания версии',
    jar: 'Загрузка клиента',
    dependencies: 'Установка зависимостей',
    libraries: 'Загрузка библиотек',
    assets: 'Загрузка ресурсов',
    asset: 'Загрузка ресурсов',
    download: 'Загрузка файлов',
  };
  return labels[phase] || 'Установка Minecraft';
}

function sendTaskProgress(task, force = false) {
  const now = Date.now();
  if (!force && now - lastProgressAt < 150) return;
  lastProgressAt = now;
  const completed = Number.isFinite(task?.progress) ? Math.max(0, task.progress) : 0;
  const total = Number.isFinite(task?.total) ? Math.max(0, task.total) : 0;
  broadcast({
    type: 'progress',
    phase: phaseMessage(task?.name),
    stage: task?.name || 'install',
    completed,
    total,
    percent: total > 0 ? Math.min(100, Math.round(completed / total * 100)) : null,
    message: phaseMessage(task?.name),
  });
}

async function runTask(task, operation, onProgress) {
  operation.task = task;
  let currentTask = task;
  const context = {
    onStart(child) {
      currentTask = child;
      if (onProgress) onProgress(task, child, true);
      else sendTaskProgress(child, true);
    },
    onUpdate(child) {
      currentTask = child;
      if (onProgress) onProgress(task, child, false);
      else sendTaskProgress(child);
    },
  };
  const timer = setInterval(() => {
    if (onProgress) onProgress(task, currentTask, false);
    else sendTaskProgress(currentTask);
  }, 350);
  try {
    const result = await task.startAndWait(context);
    if (onProgress) onProgress(task, currentTask, true);
    else sendTaskProgress(task, true);
    return result;
  } finally {
    clearInterval(timer);
    operation.task = null;
  }
}

async function assetObjects(version, folder, operation) {
  const info = version.assetIndex;
  if (!info?.url) throw new Error('У версии нет индекса ресурсов');
  const indexPath = folder.getAssetsIndex(version.assets);
  let bytes;
  try {
    bytes = await fs.readFile(indexPath);
    if (info.sha1 && createHash('sha1').update(bytes).digest('hex') !== info.sha1) bytes = null;
  } catch {
    bytes = null;
  }
  if (!bytes) {
    broadcast({ type: 'progress', phase: 'Индекс ресурсов', stage: 'asset-index', completed: 0, total: 0, percent: null, message: 'Получаем список игровых файлов' });
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (operation.cancelled) throw new Error('Установка отменена');
      try {
        const signal = AbortSignal.any([operation.controller.signal, AbortSignal.timeout(30000)]);
        const response = await fetch(info.url, { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        bytes = Buffer.from(await response.arrayBuffer());
        if (info.sha1 && createHash('sha1').update(bytes).digest('hex') !== info.sha1) {
          throw new Error('Контрольная сумма индекса ресурсов не совпала');
        }
        await fs.mkdir(path.dirname(indexPath), { recursive: true });
        await fs.writeFile(indexPath, bytes);
        if (info.sha1 && info.sha1 !== version.assets) {
          await fs.writeFile(folder.getAssetsIndex(info.sha1), bytes);
        }
        break;
      } catch (error) {
        lastError = error;
        bytes = null;
        if (operation.cancelled) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 700));
      }
    }
    if (!bytes) throw new Error(`Не удалось загрузить индекс ресурсов: ${describeError(lastError)}`);
  }
  let data;
  try {
    data = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Индекс ресурсов повреждён');
  }
  if (!data.objects || typeof data.objects !== 'object') throw new Error('Индекс ресурсов имеет неверный формат');
  return Object.entries(data.objects).map(([name, item]) => ({ name, hash: item.hash, size: item.size }));
}

function sendAssetProgress(completed, total, count, allCount, force = false) {
  const now = Date.now();
  if (!force && now - lastProgressAt < 150) return;
  lastProgressAt = now;
  const current = Math.min(total, Math.max(0, completed));
  broadcast({
    type: 'progress',
    phase: 'Загрузка ресурсов',
    stage: 'assets',
    completed: current,
    total,
    percent: total > 0 ? Math.round(current / total * 100) : null,
    message: `Ресурсы: ${count} из ${allCount}`,
  });
}

async function installAssetsInBatches(version, operation) {
  const folder = MinecraftFolder.from(settings.gameDirectory);
  const objects = await assetObjects(version, folder, operation);
  const total = objects.reduce((sum, item) => sum + Number(item.size || 0), 0);
  let completed = 0;
  const batchSize = 32;
  for (let index = 0; index < objects.length; index += batchSize) {
    if (operation.cancelled) throw new Error('Установка отменена');
    const batch = objects.slice(index, index + batchSize);
    const batchBytes = batch.reduce((sum, item) => sum + Number(item.size || 0), 0);
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (operation.cancelled) throw new Error('Установка отменена');
      const task = installResolvedAssetsTask(batch, folder);
      try {
        await runTask(task, operation, (rootTask, _currentTask, force) => {
          const batchProgress = Number.isFinite(rootTask.progress) ? Math.max(0, rootTask.progress) : 0;
          sendAssetProgress(completed + batchProgress, total, index + batch.length, objects.length, force);
        });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (operation.cancelled) throw error;
        appendLog(`Повтор загрузки ресурсов (${attempt}/3): ${describeError(error)}`);
      }
    }
    if (lastError) throw new Error(`Не удалось загрузить ресурсы (${index + 1}–${index + batch.length}): ${describeError(lastError)}`);
    completed += batchBytes;
    sendAssetProgress(completed, total, index + batch.length, objects.length, true);
  }
}

async function installVersion(id) {
  if (!validVersionId(id)) throw new Error('Некорректный номер версии');
  const meta = manifest.versions.find((version) => version.id === id);
  if (!meta) throw new Error('Версия не найдена. Обновите список версий');
  const operation = beginOperation('install', id);
  announce(`Устанавливаем Minecraft ${id}…`);
  try {
    await fs.mkdir(settings.gameDirectory, { recursive: true });
    const marker = path.join(settings.gameDirectory, 'versions', id, '.veyra-installed');
    await fs.rm(marker, { force: true });
    installedIds.delete(id);
    emitState();
    const version = await runTask(installVersionTask(meta, settings.gameDirectory, { side: 'client' }), operation);
    if (operation.cancelled) throw new Error('Установка отменена');
    await runTask(installLibrariesTask(version), operation);
    if (operation.cancelled) throw new Error('Установка отменена');
    await installAssetsInBatches(version, operation);
    if (operation.cancelled) throw new Error('Установка отменена');
    await fs.writeFile(marker, JSON.stringify({ id, installedAt: new Date().toISOString() }), 'utf8');
    installedIds = await scanInstalledVersions(settings.gameDirectory);
    if (!installedIds.has(id)) throw new Error('Установка завершилась, но файлы версии отсутствуют');
    if (settings.selectedVersion !== id) {
      settings = { ...settings, selectedVersion: id };
      await fs.writeFile(settingsFile(), JSON.stringify(settings, null, 2), 'utf8');
    }
    emitState();
    announce(`Minecraft ${id} установлен`, 'success');
    return publicState();
  } catch (error) {
    if (operation.cancelled || taskCancelled(error)) {
      announce('Установка отменена');
      return publicState();
    }
    reportError(`Не удалось установить ${id}`, error);
    throw error;
  } finally {
    installedIds = await scanInstalledVersions(settings.gameDirectory);
    endOperation(operation);
  }
}

function taskCancelled(error) {
  return error?.name === 'CancelledError' || error?.name === 'AbortError';
}

function offlineUuid(name) {
  const bytes = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes.toString('hex');
}

function javaVersion(javaPath) {
  const result = spawnSync(javaPath, ['-version'], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  if (result.error) throw new Error(`Java не найдена (${javaPath}). Выберите java.exe в настройках`);
  if (result.status !== 0) throw new Error(`Не удалось запустить Java (${javaPath})`);
  const output = `${result.stderr || ''}\n${result.stdout || ''}`;
  const match = /version\s+["']?(\d+)(?:\.(\d+))?/i.exec(output)
    || /\bopenjdk\s+["']?(\d+)(?:\.(\d+))?/i.exec(output)
    || /\bjava\s+["']?(\d+)(?:\.(\d+))?/i.exec(output);
  if (!match) throw new Error(`Не удалось определить версию Java (${javaPath})`);
  return Number(match[1]) === 1 ? Number(match[2]) : Number(match[1]);
}

async function launchVersion(id) {
  if (!validVersionId(id)) throw new Error('Некорректный номер версии');
  const operation = beginOperation('launch', id);
  announce(`Запускаем Minecraft ${id}…`);
  try {
    if (!installedIds.has(id)) throw new Error('Версия ещё не установлена. Сначала установите её');
    const version = await Version.parse(settings.gameDirectory, id);
    const javaPath = settings.javaPath || 'java';
    const installedJava = javaVersion(javaPath);
    const requiredJava = Number(version.javaVersion?.majorVersion) || 8;
    if (installedJava < requiredJava) {
      throw new Error(`Minecraft ${id} требует Java ${requiredJava} или новее. Сейчас доступна Java ${installedJava}. Выберите нужную java.exe в настройках`);
    }
    const child = await launch({
      gamePath: settings.gameDirectory,
      javaPath,
      version,
      gameProfile: { name: settings.playerName, id: offlineUuid(settings.playerName) },
      maxMemory: settings.memoryGb * 1024,
      launcherName: 'Veyra Launcher',
      extraExecOption: { windowsHide: true },
    });
    gameProcess = child;
    child.stdout?.on('data', (chunk) => {
      const message = String(chunk).trim();
      if (message) {
        appendLog(message);
        broadcast({ type: 'log', message: message.slice(-1000) });
      }
    });
    child.stderr?.on('data', (chunk) => {
      const message = String(chunk).trim();
      if (message) {
        appendLog(message);
        broadcast({ type: 'log', message: message.slice(-1000) });
      }
    });
    child.once('error', (error) => {
      reportError('Ошибка процесса Minecraft', error);
      if (gameProcess === child) {
        gameProcess = null;
        emitState();
      }
    });
    child.once('close', (code, signal) => {
      if (gameProcess === child) {
        gameProcess = null;
        emitState();
      }
      if (code === 0) announce('Minecraft закрыт');
      else announce(`Minecraft завершился (код ${code ?? signal ?? 'неизвестен'}). Подробности: ${logFile()}`, 'error');
    });
    emitState();
    announce(`Minecraft ${id} запущен в офлайн-режиме`, 'success');
    return { pid: child.pid || null };
  } catch (error) {
    reportError(`Не удалось запустить ${id}`, error);
    throw error;
  } finally {
    endOperation(operation);
  }
}

async function saveSettings(partial) {
  const next = validateSettings(partial, settings);
  return persistSettings(next);
}

async function pickJava() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Выберите java.exe или javaw.exe',
    properties: ['openFile'],
    filters: [{ name: 'Java', extensions: ['exe'] }],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const chosen = result.filePaths[0];
  await saveSettings({ javaPath: chosen });
  return chosen;
}

async function pickGameDirectory() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Выберите папку Minecraft',
    defaultPath: settings.gameDirectory,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const chosen = result.filePaths[0];
  await saveSettings({ gameDirectory: chosen });
  return chosen;
}

async function openGameDirectory() {
  await fs.mkdir(settings.gameDirectory, { recursive: true });
  const error = await shell.openPath(settings.gameDirectory);
  if (error) throw new Error(error);
  return true;
}

function registerIpc() {
  ipcMain.handle('launcher:get-state', () => publicState());
  ipcMain.handle('launcher:refresh-versions', () => refreshVersions());
  ipcMain.handle('launcher:install-version', (_event, id) => installVersion(id));
  ipcMain.handle('launcher:launch-version', (_event, id) => launchVersion(id));
  ipcMain.handle('launcher:cancel-install', async () => {
    if (activeOperation?.type !== 'install') return false;
    activeOperation.cancelled = true;
    activeOperation.controller.abort();
    announce('Отменяем установку…');
    activeOperation.task?.cancel().catch((error) => reportError('Не удалось отменить установку', error));
    return true;
  });
  ipcMain.handle('launcher:save-settings', (_event, partial) => saveSettings(partial));
  ipcMain.handle('launcher:pick-java', () => pickJava());
  ipcMain.handle('launcher:pick-game-directory', () => pickGameDirectory());
  ipcMain.handle('launcher:open-game-directory', () => openGameDirectory());
  ipcMain.handle('launcher:window-minimize', () => { mainWindow?.minimize(); return true; });
  ipcMain.handle('launcher:window-maximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('launcher:window-close', () => { mainWindow?.close(); return true; });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 900,
    minWidth: 900,
    minHeight: 680,
    show: false,
    frame: false,
    title: 'Veyra Launcher',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    backgroundColor: '#090910',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
}

app.whenReady().then(async () => {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await loadSettings();
  registerIpc();
  createWindow();
  refreshVersions().catch(() => {});
}).catch((error) => {
  dialog.showErrorBox('Veyra Launcher', describeError(error));
  app.quit();
});

app.on('window-all-closed', () => app.quit());
