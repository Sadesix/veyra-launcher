const { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, safeStorage, screen, shell } = require('electron');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { launch, Version } = require('@xmcl/core');
const { getVersionList } = require('@xmcl/installer');
const { installBase, installModdedLibraries } = require('./game-install');
const { fetchLoaderVersions, installLoader, validVersion } = require('./loaders');
const { requiredJava, resolveJava, scanJava, javaInfo } = require('./java-runtime');
const { MicrosoftAuth, validClientId } = require('./microsoft-auth');
const { AccountVault } = require('./account-vault');
const { diagnoseFailure } = require('./game-diagnostics');
const { prechecks, javaArguments } = require('./launch-runtime');
const { appearance } = require('./appearance');
const { validPlayerName } = require('./local-profile');
const { observeOutput, cleanOutput } = require('./install-output');
const { ContentManager, KINDS } = require('./content-manager');
const { backgrounds, validBackground, randomBackground } = require('./backgrounds');
const { DiscordPresence } = require('./discord-presence');
const { CartStore } = require('./cart-store');
const { buildName } = require('./build-name');
const microsoftConfig = require('./microsoft-config.json');

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
let installConsole = null;
let accountSession = null;
let accountVault;
let authController = null;
let authState = { busy: false, phase: '', error: '' };
let lastCrash = null;
let accountRevision = 0;
let accountRefreshPromise = null;
const microsoft = new MicrosoftAuth();
const content = new ContentManager({ version: app.getVersion() });
const carts = new CartStore(path.join(app.getPath('userData'), 'content-carts.json'));
let savedWindow = {};
let windowSaveQueue = Promise.resolve();
let windowSaveTimer;
const discord = new DiscordPresence({ onStatus: () => { if (settings) broadcast({ type: 'discord', status: discord.status }); } });

const dataDir = () => app.getPath('userData');
const settingsFile = () => path.join(dataDir(), 'settings.json');
const manifestFile = () => path.join(dataDir(), 'version-manifest.json');
const logFile = () => path.join(dataDir(), 'launcher.log');
const instancesDir = () => process.env.VEYRA_TEST_DATA_DIR
  ? path.join(dataDir(), 'instances')
  : path.join(app.getPath('documents'), 'Veyra Launcher', 'instances');
const systemMemoryGb = () => Math.max(1, Math.round(os.totalmem() / 1024 ** 3));
const maxMemoryGb = () => Math.max(1, systemMemoryGb() - 2);

function broadcast(payload) {
  if (window && !window.isDestroyed()) window.webContents.send('launcher:event', payload);
}

function redact(message) {
  let safe = String(message);
  for (const token of [accountSession?.accessToken, accountSession?.refreshToken]) {
    if (token) safe = safe.split(token).join('[скрыто]');
  }
  return safe;
}
function log(message, source = 'launcher') {
  const safe = cleanOutput(redact(message));
  fs.appendFile(logFile(), '[' + new Date().toISOString() + '] ' + safe + '\n', 'utf8').catch(() => {});
  if (activeOperation?.type === 'install' && installConsole?.id === activeOperation.id) {
    const lines = safe.split(/\r?\n/).filter(Boolean).map(text => ({ sequence: ++installConsole.sequence, time: Date.now(), source, text }));
    installConsole.lines.push(...lines);
    installConsole.lines = installConsole.lines.slice(-400);
    broadcast({ type: 'install-output', id: installConsole.id, lines });
  }
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
    allowAnySymbols: false,
    accountMode: 'local',
    microsoftClientId: '',
    memoryGb: Math.min(4, maxMemoryGb()),
    javaPath: '',
    showSnapshots: false,
    discordEnabled: !process.env.VEYRA_TEST_DATA_DIR,
    selectedInstanceId: '',
    instances: [],
    appearance: appearance(),
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
    memoryGb: Number.isInteger(raw.memoryGb) && raw.memoryGb >= 1 ? Math.min(raw.memoryGb, maxMemoryGb()) : null,
    javaPath: typeof raw.javaPath === 'string' && path.isAbsolute(raw.javaPath) ? raw.javaPath : '',
    createdAt: raw.createdAt || new Date().toISOString(),
    lastPlayedAt: typeof raw.lastPlayedAt === 'string' ? raw.lastPlayedAt : '',
    launchCount: Number.isSafeInteger(raw.launchCount) && raw.launchCount >= 0 ? raw.launchCount : 0,
    playedMs: Number.isSafeInteger(raw.playedMs) && raw.playedMs >= 0 ? raw.playedMs : 0,
    note: typeof raw.note === 'string' ? raw.note.slice(0, 180) : '',
    favorite: Boolean(raw.favorite),
    accent: ['violet', 'blue', 'rose', 'amber'].includes(raw.accent) ? raw.accent : 'violet',
    coverFile: typeof raw.coverFile === 'string' && /^cover\.(png|jpg|webp)$/.test(raw.coverFile) ? raw.coverFile : '',
    coverRevision: Number.isSafeInteger(raw.coverRevision) ? raw.coverRevision : 0,
    backgroundId: validBackground(raw.backgroundId) ? raw.backgroundId : 'default',
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
  savedWindow = await readJson(path.join(dataDir(), 'window-state.json'), {});
  const saved = await readJson(settingsFile(), {});
  settings = defaultSettings();
  settings.allowAnySymbols = saved.allowAnySymbols === true;
  if (validPlayerName(saved.playerName, settings.allowAnySymbols)) settings.playerName = saved.playerName;
  if (validClientId(saved.microsoftClientId)) settings.microsoftClientId = saved.microsoftClientId;
  if (saved.accountMode === 'microsoft') settings.accountMode = 'microsoft';
  if (Number.isInteger(saved.memoryGb) && saved.memoryGb >= 1) settings.memoryGb = Math.min(saved.memoryGb, maxMemoryGb());
  if (typeof saved.javaPath === 'string' && (!saved.javaPath || path.isAbsolute(saved.javaPath))) settings.javaPath = saved.javaPath;
  settings.showSnapshots = Boolean(saved.showSnapshots);
  if (typeof saved.discordEnabled === 'boolean') settings.discordEnabled = saved.discordEnabled;
  settings.appearance = appearance(saved.appearance);
  if (Array.isArray(saved.instances)) {
    settings.instances = saved.instances.map(sanitizeInstance).filter(Boolean);
    settings.selectedInstanceId = typeof saved.selectedInstanceId === 'string' ? saved.selectedInstanceId : '';
  } else if (validVersion(saved.selectedVersion || '')) {
    const legacy = sanitizeInstance({
      id: 'legacy',
      name: 'Моя сборка',
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
  if (!instance) throw new Error('Сборка не найдена');
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
      allowAnySymbols: settings.allowAnySymbols,
      memoryGb: settings.memoryGb,
      javaPath: settings.javaPath,
      showSnapshots: settings.showSnapshots,
      selectedInstanceId: settings.selectedInstanceId,
      appearance: { ...settings.appearance },
      discordEnabled: settings.discordEnabled,
    },
    instances: settings.instances.map((instance) => ({
      ...instance,
      coverUrl: instance.coverFile ? 'veyra://cover/' + encodeURIComponent(instance.id) + '?v=' + instance.coverRevision : backgrounds.find(item => item.id === instance.backgroundId)?.url || '',
    })),
    versions,
    backgrounds,
    discordStatus: discord.status,
    javaCandidates,
    operation: activeOperation ? {
      type: activeOperation.type,
      instanceId: activeOperation.instanceId,
      progress: lastProgress,
      cancellable: activeOperation.type === 'install' || Boolean(activeOperation.cancellable),
    } : null,
    runningInstanceId: gameProcess?.instanceId || null,
    stoppingGame: Boolean(gameProcess?.stopping),
    runningSession: gameProcess ? { instanceId: gameProcess.instanceId, accountedAt: gameProcess.accountedAt, startedAt: gameProcess.startedAt } : null,
    installConsole,
    appVersion: app.getVersion(),
    systemMemoryGb: systemMemoryGb(),
    maxMemoryGb: maxMemoryGb(),
    dataDirectory: dataDir(),
    instancesDirectory: instancesDir(),
    account: {
      mode: settings.accountMode,
      name: settings.accountMode === 'microsoft' ? (accountSession?.profile.name || 'Microsoft') : settings.playerName,
      microsoft: accountSession ? { ...accountSession.profile } : null,
      configured: validClientId(microsoftClientId()),
      clientId: microsoftClientId(),
      auth: { ...authState },
    },
    lastCrash: lastCrash ? { instanceId: lastCrash.instanceId, message: lastCrash.message, hasReport: Boolean(lastCrash.file) } : null,
  };
}

function microsoftClientId() {
  return settings.microsoftClientId || process.env.VEYRA_MICROSOFT_CLIENT_ID || microsoftConfig.clientId || '';
}

async function saveMicrosoftClientId(value) {
  if (typeof value !== 'string' || (value.trim() && !validClientId(value.trim()))) throw new Error('Client ID должен быть идентификатором приложения Microsoft в формате UUID');
  if (authController || accountRefreshPromise || activeOperation?.type === 'launch') throw new Error('Сначала завершите текущий вход или запуск');
  const previous = microsoftClientId();
  const effective = value.trim() || process.env.VEYRA_MICROSOFT_CLIENT_ID || microsoftConfig.clientId || '';
  if (previous !== effective && accountSession) {
    await accountVault.clear();
    accountSession = null;
    settings.accountMode = 'local';
  }
  accountRevision++;
  settings.microsoftClientId = value.trim();
  await persist();
  emitState();
  return true;
}

async function selectAccount(mode) {
  if (!['local', 'microsoft'].includes(mode)) throw new Error('Неизвестный профиль');
  if (activeOperation?.type === 'launch') throw new Error('Дождитесь запуска игры');
  if (mode === 'microsoft' && !accountSession) throw new Error('Сначала войдите в Microsoft');
  settings.accountMode = mode;
  await persist();
  emitState();
  return true;
}

async function startMicrosoftLogin() {
  if (authController) throw new Error('Вход уже выполняется');
  if (accountRefreshPromise) throw new Error('Дождитесь обновления профиля');
  if (activeOperation?.type === 'launch') throw new Error('Дождитесь запуска игры');
  const clientId = microsoftClientId();
  const controller = new AbortController();
  const revision = ++accountRevision;
  authController = controller;
  authState = { busy: true, phase: 'Получаем код Microsoft…', error: '' };
  emitState();
  try {
    const device = await microsoft.deviceCode(clientId, controller.signal);
    if (controller.signal.aborted) throw new Error('Вход отменён');
    authState = {
      busy: true, phase: 'Откройте Microsoft и введите этот код.', error: '',
      userCode: device.userCode, verificationUri: device.verificationUri, expiresAt: device.expiresAt,
    };
    emitState();
    (async () => {
      try {
        const token = await microsoft.poll(clientId, device, controller.signal);
        const session = await microsoft.minecraft(clientId, token, controller.signal, (phase) => {
          authState.phase = phase;
          emitState();
        });
        if (!session.refreshToken) throw new Error('Microsoft не разрешил сохранять вход. Повторите вход с разрешением offline_access.');
        if (controller.signal.aborted) return;
        await accountVault.write(session);
        if (controller.signal.aborted || revision !== accountRevision) {
          if (revision === accountRevision) {
            if (accountSession) await accountVault.write(accountSession);
            else await accountVault.clear();
          }
          return;
        }
        accountSession = session;
        settings.accountMode = 'microsoft';
        await persist();
        authState = { busy: false, phase: 'Вход выполнен', error: '' };
        status('Microsoft: вход выполнен для ' + session.profile.name, 'success');
      } catch (error) {
        authState = { busy: false, phase: '', error: controller.signal.aborted ? '' : errorMessage(error) };
      } finally {
        if (authController === controller) authController = null;
        emitState();
      }
    })();
    return true;
  } catch (error) {
    if (authController === controller) authController = null;
    authState = { busy: false, phase: '', error: controller.signal.aborted ? '' : errorMessage(error) };
    emitState();
    if (!controller.signal.aborted) throw error;
    return false;
  }
}

async function logoutMicrosoft() {
  if (activeOperation?.type === 'launch') throw new Error('Дождитесь запуска игры');
  authController?.abort();
  accountRevision++;
  await accountVault.clear();
  accountSession = null;
  settings.accountMode = 'local';
  authState = { busy: false, phase: '', error: '' };
  await persist();
  emitState();
  return true;
}

async function microsoftIdentity(signal, force = false) {
  if (!accountSession || accountSession.clientId !== microsoftClientId()) throw new Error('Войдите в Microsoft через кнопку профиля');
  let session = accountSession;
  if (force || session.expiresAt <= Date.now() + 60000) {
    if (!accountRefreshPromise) {
      const revision = accountRevision;
      const previous = session;
      accountRefreshPromise = (async () => {
        const token = await microsoft.refresh(previous.clientId, previous.refreshToken, signal);
        token.refresh_token ||= previous.refreshToken;
        const updated = await microsoft.minecraft(previous.clientId, token, signal);
        if (revision !== accountRevision) throw new Error('Профиль изменился. Повторите действие.');
        await accountVault.write(updated);
        if (revision !== accountRevision) throw new Error('Профиль изменился. Повторите действие.');
        accountSession = updated;
        emitState();
        return updated;
      })().finally(() => { accountRefreshPromise = null; });
    }
    session = await accountRefreshPromise;
  }
  return { gameProfile: { ...session.profile }, accessToken: session.accessToken, userType: 'msa' };
}

function emitState() {
  if (settings) updateDiscord();
  if (settings) broadcast({ type: 'state', state: publicState() });
}

function updateDiscord() {
  const running = gameProcess && settings.instances.find(item => item.id === gameProcess.instanceId);
  discord.configure(settings.discordEnabled);
  discord.update(running ? {
    type: 0, details: 'Играет в Minecraft ' + running.minecraftVersion,
    state: running.name + ' · ' + ({ vanilla: 'Vanilla', fabric: 'Fabric', neoforge: 'NeoForge', forge: 'Forge' }[running.loader]),
    timestamps: { start: Math.floor(gameProcess.startedAt / 1000) },
  } : { type: 0, details: 'В библиотеке сборок', state: 'Готовится к приключению' });
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
  if (activeOperation?.type === 'install') {
    const detail = lastProgress.phase + ' · ' + lastProgress.message;
    if (detail !== activeOperation.lastConsoleProgress && (force || now - (activeOperation.consoleProgressAt || 0) > 1800)) {
      activeOperation.lastConsoleProgress = detail;
      activeOperation.consoleProgressAt = now;
      log(detail, 'progress');
    }
  }
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
    onStart(child) {
      current = child;
      if (operation.type === 'install' && child.name) log('[' + label + '] ' + child.name + (child.param ? ' ' + JSON.stringify(child.param).slice(0, 300) : ''), 'task');
      send(true);
    },
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
  activeOperation = { id: randomUUID(), type, instanceId, controller, signal: controller.signal, task: null };
  if (type === 'install') installConsole = { id: activeOperation.id, instanceId, live: true, outcome: '', startedAt: Date.now(), sequence: 0, lines: [] };
  lastProgress = null;
  emitState();
  return activeOperation;
}

function endOperation(operation) {
  if (activeOperation === operation) {
    if (operation.type === 'install' && installConsole?.id === operation.id) {
      installConsole.live = false;
      installConsole.outcome = operation.outcome || 'error';
      installConsole.endedAt = Date.now();
    }
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
  if (!input || typeof input !== 'object') throw new Error('Не удалось прочитать параметры сборки');
  buildName(input.name, settings.instances);
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
    name: buildName(input.name, settings.instances),
    minecraftVersion: input.minecraftVersion,
    loader,
    loaderVersion,
    directory,
    createdAt: new Date().toISOString(),
    accent: 'violet',
    backgroundId: randomBackground(),
  });
  settings.instances.unshift(instance);
  settings.selectedInstanceId = id;
  await persist();
  emitState();
  status('Сборка «' + instance.name + '» создана', 'success');
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
  if (!patch || typeof patch !== 'object') throw new Error('Некорректные настройки сборки');
  const next = { ...instance };
  if (patch.name !== undefined) {
    next.name = buildName(patch.name, settings.instances, id);
  }
  if (patch.memoryGb !== undefined) {
    if (patch.memoryGb !== null && (!Number.isInteger(Number(patch.memoryGb)) || Number(patch.memoryGb) < 1 || Number(patch.memoryGb) > maxMemoryGb())) {
      throw new Error('Память: от 1 до ' + maxMemoryGb() + ' ГБ на этом компьютере');
    }
    next.memoryGb = patch.memoryGb === null ? null : Number(patch.memoryGb);
  }
  if (patch.javaPath !== undefined) {
    if (typeof patch.javaPath !== 'string' || (patch.javaPath && !path.isAbsolute(patch.javaPath))) {
      throw new Error('Укажите полный путь к Java');
    }
    next.javaPath = patch.javaPath;
  }
  if (patch.favorite !== undefined) next.favorite = Boolean(patch.favorite);
  if (patch.note !== undefined) {
    if (typeof patch.note !== 'string' || patch.note.length > 180) throw new Error('Заметка: не более 180 символов');
    next.note = patch.note.trim();
  }
  if (patch.accent !== undefined) {
    if (!['violet', 'blue', 'rose', 'amber'].includes(patch.accent)) throw new Error('Неизвестный цвет сборки');
    next.accent = patch.accent;
  }
  if (patch.backgroundId !== undefined) {
    if (!validBackground(patch.backgroundId)) throw new Error('Неизвестная обложка');
    next.backgroundId = patch.backgroundId;
    next.coverFile = '';
    next.coverRevision = Date.now();
  }
  Object.assign(instance, next);
  await persist();
  emitState();
  return { ...instance };
}

async function setInstanceCover(id) {
  const instance = requireInstance(id);
  if (instance.legacy) throw new Error('Обложку старой сборки можно добавить после переноса в новую папку');
  const result = await dialog.showOpenDialog(window, {
    title: 'Выберите обложку сборки',
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
  status('Обложка сборки обновлена', 'success');
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
  const target = path.resolve(instance.directory);
  const managed = [instancesDir(), path.join(dataDir(), 'instances')]
    .map((root) => path.resolve(root))
    .find((root) => path.dirname(target).toLowerCase() === root.toLowerCase());
  let movedTo = '';
  if (!instance.legacy && managed) {
    const stat = await fs.lstat(target).catch(() => null);
    if (stat?.isSymbolicLink()) throw new Error('Папка сборки является ссылкой');
    if (stat?.isDirectory()) {
      const trash = path.join(path.dirname(managed), 'trash');
      await fs.mkdir(trash, { recursive: true });
      movedTo = path.join(trash, id + '-' + Date.now());
      await fs.rename(target, movedTo);
    }
  }
  settings.instances = settings.instances.filter((item) => item.id !== id);
  if (settings.selectedInstanceId === id) settings.selectedInstanceId = settings.instances[0]?.id || '';
  await persist();
  emitState();
  status('Сборка удалена из списка' + (movedTo ? '; файлы перемещены в корзину Veyra' : ''), 'success');
  return { movedTo };
}

async function saveSettings(patch) {
  if (!patch || typeof patch !== 'object') throw new Error('Некорректные настройки');
  const next = { ...settings };
  if (patch.allowAnySymbols !== undefined) next.allowAnySymbols = patch.allowAnySymbols === true;
  if (patch.playerName !== undefined) next.playerName = typeof patch.playerName === 'string' ? patch.playerName.trim().normalize('NFC') : patch.playerName;
  if (!validPlayerName(next.playerName, next.allowAnySymbols)) {
    throw new Error(next.allowAnySymbols ? 'Ник: от 1 до 32 символов, без переносов строк' : 'Имя игрока: 3–16 латинских букв, цифр или _');
  }
  if (patch.memoryGb !== undefined) {
    const memory = Number(patch.memoryGb);
    if (!Number.isInteger(memory) || memory < 1 || memory > maxMemoryGb()) {
      throw new Error('Память: от 1 до ' + maxMemoryGb() + ' ГБ на этом компьютере');
    }
    next.memoryGb = memory;
  }
  if (patch.javaPath !== undefined) {
    if (typeof patch.javaPath !== 'string' || (patch.javaPath && !path.isAbsolute(patch.javaPath))) {
      throw new Error('Укажите полный путь к Java');
    }
    if (patch.javaPath && !javaInfo(patch.javaPath)) throw new Error('Выбранная Java не запускается');
    next.javaPath = patch.javaPath;
  }
  if (patch.showSnapshots !== undefined) next.showSnapshots = Boolean(patch.showSnapshots);
  if (patch.discordEnabled !== undefined) next.discordEnabled = patch.discordEnabled === true;
  if (patch.appearance !== undefined) next.appearance = appearance(patch.appearance, true);
  settings = next;
  await persist();
  applyWindowAppearance(settings.appearance);
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
    await content.recover(instance);
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
      versionId = await installLoader(instance, java.path, (task) => runTask(task, operation, 'Загрузчик'), {
        spawn: (command, args, options) => {
          operation.signal.throwIfAborted();
          const child = require('node:child_process').spawn(command, args, { ...options, windowsHide: true });
          observeOutput(child.stdout, 'stdout', (line, source) => { if (activeOperation === operation) log(line, source); });
          observeOutput(child.stderr, 'stderr', (line, source) => { if (activeOperation === operation) log(line, source); });
          return child;
        },
      });
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
    status('Сборка «' + instance.name + '» готова', 'success');
    operation.outcome = 'success';
    return publicState();
  } catch (error) {
    instance.installed = false;
    emitState();
    if (operation.signal.aborted || error?.name === 'CancelledError') {
      operation.outcome = 'cancelled';
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
  if (!instance.installed) throw new Error('Сначала установите сборку');
  if (authController) throw new Error('Завершите Microsoft-вход или отмените его перед запуском');
  const operation = beginOperation('launch', id);
  try {
    await content.recover(instance);
    const version = await Version.parse(instance.directory, instance.versionId);
    const java = await resolveJava(
      version,
      instance.javaPath || settings.javaPath,
      dataDir(),
      progress,
      operation.signal
    );
    const identity = settings.accountMode === 'microsoft'
      ? await microsoftIdentity(operation.signal)
      : { gameProfile: { name: settings.playerName, id: offlineUuid(settings.playerName) }, accessToken: '0', userType: 'legacy' };
    const extraJVMArgs = javaArguments();
    if (instance.loader === 'neoforge' && instance.loaderVersion === '26.3.0.56-beta') {
      const source = path.join(__dirname, '..', 'assets', 'compat', 'neoforge-version-guard.jar');
      const agent = path.join(dataDir(), 'compat', 'neoforge-version-guard.jar');
      await fs.mkdir(path.dirname(agent), { recursive: true });
      await fs.copyFile(source, agent);
      extraJVMArgs.push('-javaagent:' + agent);
      log('Включена защита проверки обновлений NeoForge 26.3.0.56-beta');
    }
    progress({ phase: 'Запуск', completed: 0, total: 0, message: 'Запускаем Minecraft' }, true);
    const child = await launch({
      gamePath: instance.directory,
      resourcePath: instance.directory,
      javaPath: java.path,
      version,
      ...identity,
      extraJVMArgs,
      prechecks,
      signal: operation.signal,
      spawn: (...args) => {
        operation.signal.throwIfAborted();
        return require('node:child_process').spawn(...args);
      },
      maxMemory: (instance.memoryGb || settings.memoryGb) * 1024,
      launcherName: 'Veyra Launcher',
      extraExecOption: { windowsHide: true },
    });
    const run = { child, instanceId: id, stopping: false, stoppedByUser: false, startedAt: Date.now(), accountedAt: Date.now(), settled: false };
    gameProcess = run;
    run.timer = setInterval(() => {
      accountPlaytime(run);
      persist().catch((error) => log('История игры: ' + errorMessage(error)));
      emitState();
    }, 15000);
    lastCrash = null;
    let recentOutput = '';
    const launchedAt = Date.now();
    instance.lastPlayedAt = new Date().toISOString();
    instance.launchCount++;
    const onOutput = (chunk) => {
      let message = redact(String(chunk).trim());
      if (identity.accessToken !== '0') message = message.split(identity.accessToken).join('[защищено]');
      if (!message) return;
      recentOutput = (recentOutput + '\n' + message).slice(-40000);
      log('[' + instance.name + '] ' + message);
      broadcast({ type: 'log', message: message.slice(-1500), instanceId: id });
    };
    child.stdout?.on('data', onOutput);
    child.stderr?.on('data', onOutput);
    child.once('error', (error) => {
      settlePlaytime(run);
      reportError('Minecraft', error);
      if (gameProcess?.child === child) gameProcess = null;
      emitState();
    });
    child.once('close', async (code, signal) => {
      settlePlaytime(run);
      if (gameProcess?.child === child) gameProcess = null;
      emitState();
      if (run.stoppedByUser) status('Игра остановлена');
      else if (code === 0) status('Minecraft закрыт');
      else {
        const message = diagnoseFailure(recentOutput, code, signal);
        const reportRoot = path.join(instance.directory, 'crash-reports');
        const entries = await fs.readdir(reportRoot, { withFileTypes: true }).catch(() => []);
        const reports = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith('.txt')).map(async (entry) => {
          const file = path.join(reportRoot, entry.name);
          const stat = await fs.stat(file).catch(() => null);
          return stat && stat.mtimeMs >= launchedAt - 2000 ? { file, time: stat.mtimeMs } : null;
        }));
        const file = reports.filter(Boolean).sort((a, b) => b.time - a.time)[0]?.file || '';
        lastCrash = { instanceId: id, message, file };
        status(message, 'error');
        broadcast({ type: 'game-crash', message });
        emitState();
      }
    });
    await persist().catch((error) => log('Не удалось сохранить историю запуска: ' + errorMessage(error)));
    emitState();
    if (gameProcess?.child === child) status('Minecraft запущен: ' + instance.name, 'success');
    return { pid: child.pid || null };
  } catch (error) {
    reportError('Не удалось запустить игру', error);
    throw error;
  } finally { endOperation(operation); }
}

function accountPlaytime(run) {
  if (run.settled) return;
  const now = Date.now();
  const item = settings.instances.find((entry) => entry.id === run.instanceId);
  if (item) item.playedMs += Math.max(0, now - run.accountedAt);
  run.accountedAt = now;
}

function settlePlaytime(run) {
  if (run.settled) return;
  accountPlaytime(run);
  run.settled = true;
  clearInterval(run.timer);
  persist().catch((error) => log('История игры: ' + errorMessage(error)));
}

async function stopGame() {
  const run = gameProcess;
  if (!run) return false;
  if (run.stopping) return true;
  run.stopping = true;
  run.stoppedByUser = true;
  emitState();
  try {
    if (!run.child.kill() && run.child.exitCode == null) throw new Error('Не удалось завершить процесс Minecraft');
    status('Останавливаем Minecraft…');
    return true;
  } catch (error) {
    run.stopping = false;
    run.stoppedByUser = false;
    emitState();
    throw error;
  }
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

async function changeContent(id, label, callback, cancellable = false) {
  const instance = requireInstance(id);
  const operation = beginOperation('content', id);
  operation.cancellable = cancellable;
  emitState();
  progress({ phase: label, message: label, completed: 0, total: 0 }, true);
  try {
    const result = await callback(instance, operation);
    status(label + ' — готово', 'success');
    broadcast({ type: 'content-changed', instanceId: id });
    return result;
  } catch (error) {
    if (operation.signal.aborted) { status('Добавление отменено'); return { cancelled: true }; }
    reportError('Содержимое сборки', error);
    throw error;
  } finally { endOperation(operation); }
}

async function importContent(id, kind) {
  requireInstance(id);
  if (!KINDS[kind]) throw new Error('Неизвестный раздел содержимого');
  const save = kind === 'saves';
  const selection = await dialog.showOpenDialog(window, { title: save ? 'Выберите папки сохранений с level.dat' : 'Добавить файлы в сборку', properties: [save ? 'openDirectory' : 'openFile', 'multiSelections'], ...(save ? {} : { filters: [{ name: kind === 'mods' ? 'Моды Minecraft' : 'Архивы', extensions: [kind === 'mods' ? 'jar' : 'zip'] }] }) });
  if (selection.canceled) return { cancelled: true };
  return changeContent(id, 'Импорт содержимого', instance => content.import(instance, kind, selection.filePaths));
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
  ipcMain.handle('launcher:start-microsoft-login', () => startMicrosoftLogin());
  ipcMain.handle('launcher:cancel-microsoft-login', () => { authController?.abort(); return true; });
  ipcMain.handle('launcher:save-microsoft-client-id', (_event, value) => saveMicrosoftClientId(value));
  ipcMain.handle('launcher:select-account', (_event, mode) => selectAccount(mode));
  ipcMain.handle('launcher:logout-microsoft', () => logoutMicrosoft());
  ipcMain.handle('launcher:refresh-account', async () => {
    if (authController || activeOperation?.type === 'launch') throw new Error('Дождитесь завершения входа или запуска');
    await microsoftIdentity(undefined, true);
    return true;
  });
  ipcMain.handle('launcher:open-account-link', async (_event, target) => {
    const links = {
      login: authState.verificationUri,
      profile: 'https://www.minecraft.net/msaprofile',
      setup: 'https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app',
    };
    if (!links[target]) throw new Error('Адрес недоступен');
    await shell.openExternal(links[target]);
    return true;
  });
  ipcMain.handle('launcher:copy-login-code', () => { if (authState.userCode) clipboard.writeText(authState.userCode); return true; });
  ipcMain.handle('launcher:open-crash-report', async () => {
    const instance = requireInstance(lastCrash?.instanceId);
    const target = lastCrash.file || path.join(instance.directory, 'logs');
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    return true;
  });
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
  ipcMain.handle('launcher:stop-game', () => stopGame());
  ipcMain.handle('launcher:cancel-operation', async () => {
    if (!activeOperation || !(activeOperation.type === 'install' || activeOperation.cancellable)) return false;
    activeOperation.controller.abort();
    activeOperation.task?.cancel().catch((error) => log('Ошибка отмены: ' + errorMessage(error)));
    status('Отменяем установку…');
    return true;
  });
  ipcMain.handle('launcher:save-settings', (_event, patch) => saveSettings(patch));
  ipcMain.handle('launcher:preview-appearance', (_event, value) => { applyWindowAppearance(appearance(value, true)); return true; });
  ipcMain.handle('launcher:scan-java', async () => {
    javaCandidates = await scanJava(dataDir(), [settings.javaPath, ...settings.instances.map((item) => item.javaPath)]);
    emitState();
    return javaCandidates;
  });
  ipcMain.handle('launcher:pick-java', () => pickJava());
  ipcMain.handle('launcher:open-instance-folder', (_event, id) => openInstanceFolder(id));
  ipcMain.handle('launcher:open-data-folder', async () => {
    await fs.mkdir(instancesDir(), { recursive: true });
    const error = await shell.openPath(instancesDir());
    if (error) throw new Error(error);
    return true;
  });
  ipcMain.handle('launcher:get-logs', () => getLogs());
  ipcMain.handle('launcher:copy-install-console', () => {
    clipboard.writeText((installConsole?.lines || []).map(line => '[' + new Date(line.time).toISOString() + '] [' + line.source + '] ' + line.text).join('\n'));
    return true;
  });
  ipcMain.handle('launcher:get-content', (_event, id, kind) => content.list(requireInstance(id), kind));
  ipcMain.handle('launcher:content-categories', (_event, kind) => content.categories(kind));
  ipcMain.handle('launcher:search-content', (_event, id, kind, options) => content.search(requireInstance(id), kind, options));
  ipcMain.handle('launcher:plan-content', (_event, id, kind, projectId, options) => content.plan(requireInstance(id), kind, projectId, options));
  ipcMain.handle('launcher:get-cart', (_event, id) => { requireInstance(id); return carts.get(id); });
  ipcMain.handle('launcher:save-cart', (_event, id, selected) => { requireInstance(id); if (activeOperation) throw new Error('Дождитесь завершения текущей операции'); return carts.set(id, selected); });
  ipcMain.handle('launcher:plan-cart', async (_event, id) => content.planBatch(requireInstance(id), await carts.get(id)));
  ipcMain.handle('launcher:install-cart', (_event, id) => changeContent(id, 'Установка корзины', async (instance, operation) => {
    const plan = await content.planBatch(instance, await carts.get(id));
    const result = await content.install(instance, plan.token, operation.signal, value => progress(value));
    try { await carts.set(id, []); } catch { result.warning = 'Файлы установлены, но не удалось очистить сохранённую корзину. Очистите её вручную'; }
    return result;
  }, true));
  ipcMain.handle('launcher:install-content', (_event, id, token) => changeContent(id, 'Установка из Modrinth', (instance, operation) => content.install(instance, token, operation.signal, value => progress(value)), true));
  ipcMain.handle('launcher:toggle-content', (_event, id, kind, name, enabled) => changeContent(id, enabled ? 'Включение' : 'Отключение', instance => content.toggle(instance, kind, name, Boolean(enabled))));
  ipcMain.handle('launcher:trash-content', (_event, id, kind, name) => changeContent(id, 'Перемещение в корзину', instance => content.trash(instance, kind, name)));
  ipcMain.handle('launcher:restore-content', (_event, id, trashId) => changeContent(id, 'Восстановление', instance => content.restore(instance, trashId)));
  ipcMain.handle('launcher:rename-save', (_event, id, name, next) => changeContent(id, 'Переименование сохранения', instance => content.renameSave(instance, name, next)));
  ipcMain.handle('launcher:duplicate-save', (_event, id, name) => changeContent(id, 'Копирование сохранения', instance => content.duplicateSave(instance, name)));
  ipcMain.handle('launcher:import-content', (_event, id, kind) => importContent(id, kind));
  ipcMain.handle('launcher:open-content-folder', async (_event, id, kind) => {
    const target = await content.root(requireInstance(id), kind);
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    return true;
  });
  ipcMain.handle('launcher:reveal-content', async (_event, id, kind, name) => { shell.showItemInFolder((await content.entry(requireInstance(id), kind, name)).file); return true; });
  ipcMain.handle('launcher:open-content-project', async (_event, projectId) => {
    if (typeof projectId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(projectId)) throw new Error('Некорректный проект');
    await shell.openExternal('https://modrinth.com/project/' + encodeURIComponent(projectId));
    return true;
  });
  ipcMain.handle('launcher:window-minimize', () => { window?.minimize(); return true; });
  ipcMain.handle('launcher:window-maximize', () => {
    if (!window) return false;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return window.isMaximized();
  });
  ipcMain.handle('launcher:window-close', () => { window?.close(); return true; });
}

function captureWindowState() {
  if (window && !window.isDestroyed() && !window.isMinimized()) {
    savedWindow = { ...window.getNormalBounds(), maximized: window.isMaximized() };
  }
}
function saveWindowState() {
  clearTimeout(windowSaveTimer);
  captureWindowState();
  const snapshot = { ...savedWindow };
  windowSaveQueue = windowSaveQueue.catch(() => {}).then(() => atomicJson(path.join(dataDir(), 'window-state.json'), snapshot));
  return windowSaveQueue;
}
function createWindow() {
  const acrylic = process.platform === 'win32' && Number(os.release().split('.')[2]) >= 22621;
  const valid = Number.isInteger(savedWindow.width) && savedWindow.width >= 980 && Number.isInteger(savedWindow.height) && savedWindow.height >= 650;
  const area = screen.getDisplayMatching(valid && Number.isInteger(savedWindow.x) && Number.isInteger(savedWindow.y) ? savedWindow : screen.getPrimaryDisplay().workArea).workArea;
  const width = valid ? Math.min(savedWindow.width, Math.max(980, area.width)) : 1460;
  const height = valid ? Math.min(savedWindow.height, Math.max(650, area.height)) : 900;
  window = new BrowserWindow({
    width,
    height,
    ...(valid && Number.isInteger(savedWindow.x) && Number.isInteger(savedWindow.y) ? { x: Math.max(area.x, Math.min(savedWindow.x, area.x + area.width - width)), y: Math.max(area.y, Math.min(savedWindow.y, area.y + area.height - height)) } : {}),
    minWidth: 980,
    minHeight: 650,
    show: false,
    frame: false,
    title: 'Veyra Launcher',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    backgroundColor: acrylic && settings.appearance.transparency > 0 ? '#00000000' : '#080911',
    ...(acrylic ? { backgroundMaterial: settings.appearance.transparency > 0 ? 'acrylic' : 'none' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (savedWindow.maximized === true) window.maximize();
  for (const event of ['resize', 'move', 'maximize', 'unmaximize']) window.on(event, () => { captureWindowState(); clearTimeout(windowSaveTimer); windowSaveTimer = setTimeout(() => saveWindowState().catch(error => log('Размер окна: ' + errorMessage(error))), 300); });
  window.on('close', () => saveWindowState().catch(error => log('Размер окна: ' + errorMessage(error))));
  window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { window = null; });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
}

function applyWindowAppearance(value) {
  if (!window || window.isDestroyed()) return;
  const supported = process.platform === 'win32' && Number(os.release().split('.')[2]) >= 22621;
  const glass = supported && value.transparency > 0;
  window.setBackgroundColor(glass ? '#00000000' : '#080911');
  if (supported) window.setBackgroundMaterial(glass ? 'acrylic' : 'none');
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
  const recovered = await Promise.allSettled(settings.instances.map(instance => content.recover(instance)));
  for (const result of recovered) if (result.status === 'rejected') log('Восстановление содержимого: ' + errorMessage(result.reason));
  accountVault = new AccountVault(path.join(dataDir(), 'microsoft-session.bin'), safeStorage);
  accountSession = await accountVault.read();
  if (accountSession?.clientId !== microsoftClientId()) accountSession = null;
  if (!accountSession) settings.accountMode = 'local';
  updateDiscord();
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
let finishingQuit = false;
app.on('before-quit', (event) => {
  discord.dispose();
  authController?.abort();
  if (finishingQuit) return;
  event.preventDefault();
  finishingQuit = true;
  if (gameProcess) settlePlaytime(gameProcess);
  Promise.allSettled([saveWindowState(), settings ? persist() : Promise.resolve(), carts.queue]).finally(() => app.quit());
});
