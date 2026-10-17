const { createHash } = require('node:crypto');
const { execFile, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { describeError } = require('./network');

const RUNTIME_INDEX = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const COMPONENT_BY_MAJOR = {
  8: 'jre-legacy',
  16: 'java-runtime-alpha',
  17: 'java-runtime-beta',
  21: 'java-runtime-delta',
  25: 'java-runtime-epsilon',
};

function parseJava(executable, output) {
  const match = /(?:version\s+|openjdk\s+|java\s+)["']?(\d+)(?:\.(\d+))?/i.exec(output);
  if (!match) return null;
  const major = Number(match[1]) === 1 ? Number(match[2]) : Number(match[1]);
  if (!Number.isInteger(major)) return null;
  return { path: executable, major, description: output.split(/\r?\n/)[0].trim() };
}
function javaInfo(executable) {
  const result = spawnSync(executable, ['-version'], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  return parseJava(executable, String(result.stderr || '') + '\n' + String(result.stdout || ''));
}
// Та же проверка без блокировки главного процесса: окно продолжает отвечать, пока Java запускается.
function probeJava(executable) {
  return new Promise((resolve) => {
    execFile(executable, ['-version'], { encoding: 'utf8', timeout: 10000, windowsHide: true }, (error, stdout, stderr) => {
      resolve(error ? null : parseJava(executable, String(stderr || '') + '\n' + String(stdout || '')));
    });
  });
}
const whereJava = () => new Promise((resolve) => {
  execFile('where.exe', ['java'], { encoding: 'utf8', timeout: 5000, windowsHide: true }, (error, stdout) => resolve(error ? '' : String(stdout)));
});

function requiredJava(version) {
  const major = Number(version.javaVersion?.majorVersion) || 8;
  return {
    major,
    component: version.javaVersion?.component || COMPONENT_BY_MAJOR[major] || '',
  };
}

// Одновременные запросы поиска получают один и тот же результат, а не запускают Java повторно.
let scanning = null;
function scanJava(userData, extraPaths = []) {
  scanning ||= findJava(userData, extraPaths).finally(() => { scanning = null; });
  return scanning;
}
async function findJava(userData, extraPaths) {
  const candidates = [];
  const add = (value) => {
    if (typeof value === 'string' && value.trim()) candidates.push(value.trim());
  };
  for (const value of extraPaths) add(value);
  if (process.env.JAVA_HOME) {
    add(path.join(process.env.JAVA_HOME, 'bin', 'javaw.exe'));
    add(path.join(process.env.JAVA_HOME, 'bin', 'java.exe'));
  }
  for (const line of (await whereJava()).split(/\r?\n/)) add(line);
  for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (!root) continue;
    for (const group of ['Java', 'Eclipse Adoptium', 'Microsoft', 'Zulu', 'Amazon Corretto']) {
      const folder = path.join(root, group);
      let entries = [];
      try { entries = await fsp.readdir(folder, { withFileTypes: true }); } catch {}
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        add(path.join(folder, entry.name, 'bin', 'javaw.exe'));
        add(path.join(folder, entry.name, 'bin', 'java.exe'));
      }
    }
  }
  const managed = path.join(userData, 'runtimes');
  let entries = [];
  try { entries = await fsp.readdir(managed, { withFileTypes: true }); } catch {}
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await fsp.access(path.join(managed, entry.name, '.veyra-ready'));
      add(path.join(managed, entry.name, 'bin', 'javaw.exe'));
    } catch {}
  }
  const seen = new Set();
  const unique = [];
  for (const candidate of candidates) {
    const key = path.resolve(candidate).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  // Найденные Java проверяются параллельно: порядок списка сохраняется, время — как у самой медленной.
  const result = (await Promise.all(unique.map(probeJava))).filter(Boolean);
  return result.sort((a, b) => b.major - a.major);
}

async function fetchJson(url, signal) {
  const response = await fetch(url, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    headers: { 'User-Agent': 'VeyraLauncher/0.2' },
  });
  if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + url);
  return response.json();
}

async function sha1(file) {
  const hash = createHash('sha1');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

async function validFile(file, expected) {
  try { return (await sha1(file)) === expected; } catch { return false; }
}

async function downloadFile(entry, destination, signal) {
  const source = entry.downloads?.raw;
  if (!source?.url || !source.sha1) throw new Error('Некорректный файл Java в манифесте');
  if (await validFile(destination, source.sha1)) return;
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (signal?.aborted) throw signal.reason || new Error('Загрузка отменена');
    const temporary = destination + '.veyra-' + process.pid + '-' + Math.random().toString(16).slice(2);
    try {
      const response = await fetch(source.url, {
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
      });
      if (!response.ok || !response.body) throw new Error('HTTP ' + response.status);
      await pipeline(require('node:stream').Readable.fromWeb(response.body), fs.createWriteStream(temporary));
      if (!(await validFile(temporary, source.sha1))) throw new Error('Контрольная сумма Java не совпала');
      await fsp.rename(temporary, destination);
      return;
    } catch (error) {
      lastError = error;
      await fsp.rm(temporary, { force: true }).catch(() => {});
      if (signal?.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw new Error('Не удалось загрузить Java: ' + describeError(lastError));
}

async function installManagedJava(component, major, userData, onProgress, signal) {
  if (!component || !/^[a-z0-9-]+$/.test(component)) {
    throw new Error('Неизвестный компонент Java. Укажите путь к подходящей Java вручную');
  }
  const destination = path.join(userData, 'runtimes', component);
  const executable = path.join(destination, 'bin', 'javaw.exe');
  const marker = path.join(destination, '.veyra-ready');
  const existing = await fsp.access(marker).then(() => javaInfo(executable), () => null);
  if (existing?.major === major) return existing;
  onProgress?.({ phase: 'Java', completed: 0, total: 0, message: 'Получаем официальную Java ' + major });
  const index = await fetchJson(RUNTIME_INDEX, signal);
  const target = index['windows-x64']?.[component]?.[0];
  if (!target?.manifest?.url) throw new Error('Для Java ' + major + ' нет официальной сборки Windows x64');
  const manifest = await fetchJson(target.manifest.url, signal);
  const entries = Object.entries(manifest.files || {});
  const files = entries.filter(([, entry]) => entry.type === 'file');
  const links = entries.filter(([, entry]) => entry.type === 'link');
  const safePath = (relative) => {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('Небезопасный путь в манифесте Java');
    const resolved = path.resolve(destination, relative);
    if (!resolved.startsWith(path.resolve(destination) + path.sep)) throw new Error('Небезопасный путь в манифесте Java');
    return resolved;
  };
  await fsp.mkdir(destination, { recursive: true });
  let cursor = 0;
  let completed = 0;
  const workers = Array.from({ length: Math.min(8, files.length) }, async () => {
    while (cursor < files.length) {
      if (signal?.aborted) throw signal.reason || new Error('Загрузка отменена');
      const [relative, entry] = files[cursor++];
      await downloadFile(entry, safePath(relative), signal);
      completed++;
      onProgress?.({ phase: 'Java', completed, total: files.length, message: 'Java ' + major + ': ' + completed + ' / ' + files.length });
    }
  });
  await Promise.all(workers);
  for (const [relative, entry] of links) {
    const targetPath = safePath(path.join(path.dirname(relative), entry.target));
    const linkPath = safePath(relative);
    await fsp.mkdir(path.dirname(linkPath), { recursive: true });
    try { await fsp.copyFile(targetPath, linkPath); } catch (error) {
      throw new Error('Не удалось восстановить файл Java: ' + error.message);
    }
  }
  const installed = javaInfo(executable);
  if (installed?.major !== major) throw new Error('Java скачана, но проверка версии не прошла');
  await fsp.writeFile(path.join(destination, '.veyra-ready'), JSON.stringify({ component, major, version: target.version?.name }), 'utf8');
  return installed;
}

async function resolveJava(version, explicitPath, userData, onProgress, signal) {
  const required = requiredJava(version);
  if (explicitPath) {
    const selected = javaInfo(explicitPath);
    if (!selected) throw new Error('Выбранная Java не запускается. Проверьте путь в настройках');
    if (selected.major !== required.major) {
      throw new Error('Для этой версии нужна Java ' + required.major + ', выбрана Java ' + selected.major + '. Переключите Java на «Автоматически»');
    }
    return selected;
  }
  const available = await scanJava(userData);
  const local = available.find((candidate) => candidate.major === required.major);
  if (local) return local;
  return installManagedJava(required.component, required.major, userData, onProgress, signal);
}

module.exports = { javaInfo, requiredJava, scanJava, resolveJava, installManagedJava };
