// В Electron обычный fs видит app.asar как папку и не может удалить его целиком; original-fs работает с настоящими файлами.
const fs = (() => { try { return require('original-fs'); } catch { return require('node:fs'); } })();
const fsp = fs.promises;
const path = require('node:path');
const { spawn } = require('node:child_process');
const { newer } = require('./updater');

// Установленный лаунчер устроен «по версиям»: <корень>\Veyra Launcher.exe (маленькая заглушка, на неё ведут ярлыки)
// запускает <корень>\app-<сборка>\Veyra Launcher.exe по записи в <корень>\veyra-install.json.
// Обновление ставит установщик новой версии: он распаковывает её в соседнюю папку и переключает запись,
// а старая версия работает до перезапуска.
const STATE = 'veyra-install.json';

function readInstallState(root) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(root, STATE), 'utf8'));
    return state && typeof state.build === 'string' && /^[\w.-]+$/.test(state.build) && typeof state.version === 'string' ? state : null;
  } catch { return null; }
}

function detectInstall(execPath = process.execPath) {
  const appDir = path.dirname(execPath);
  if (!/^app-[\w.-]+$/i.test(path.basename(appDir))) return null;
  const root = path.dirname(appDir), state = readInstallState(root);
  if (!state) return null;
  return {
    root, appDir, build: path.basename(appDir).slice(4),
    stub: path.join(root, 'Veyra Launcher.exe'), packages: path.join(root, 'packages'),
  };
}

// Установщик в режиме обновления работает без окна и сообщает ошибку в stderr.
function runSetup(file, args, { timeout = 10 * 60 * 1000, spawn: spawner = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawner(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill(), timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) return resolve(output.trim());
      const message = output.trim().split(/\r?\n/).filter(Boolean).pop();
      reject(new Error(message || 'Установщик завершился с кодом ' + code));
    });
  });
}

// Прежние версии и скачанные установщики убираются, когда новая версия уже работает.
// Папка с занятым EXE (кто-то ещё держит старую версию открытой) пропускается до следующего раза.
async function cleanupInstall(install, version) {
  const state = readInstallState(install.root);
  const keep = new Set([install.appDir, state ? path.join(install.root, 'app-' + state.build) : ''].map(dir => dir.toLowerCase()));
  const removed = [];
  let busy = 0;
  for (const entry of await fsp.readdir(install.root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !/^app-/i.test(entry.name)) continue;
    const dir = path.join(install.root, entry.name);
    if (keep.has(dir.toLowerCase())) continue;
    if (/\.partial$/i.test(entry.name)) {
      const stat = await fsp.stat(dir).catch(() => null);
      if (!stat || Date.now() - stat.mtimeMs < 60 * 60 * 1000) continue;
    } else {
      try { await fsp.rm(path.join(dir, 'Veyra Launcher.exe'), { force: true }); } catch { busy++; continue; }
    }
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).then(() => removed.push(entry.name), () => { busy++; });
  }
  for (const name of await fsp.readdir(install.packages).catch(() => [])) {
    const match = /(\d+(?:\.\d+){1,3})/.exec(name);
    if (match && !newer(match[1], version)) await fsp.rm(path.join(install.packages, name), { force: true }).then(() => removed.push(name), () => {});
  }
  return { removed, busy };
}

module.exports = { detectInstall, readInstallState, runSetup, cleanupInstall };
