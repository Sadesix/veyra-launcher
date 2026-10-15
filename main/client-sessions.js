const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
// Метка в командной строке Java отличает клиентов Veyra от любых других клиентов Minecraft на компьютере.
// По ней лаунчер после перезапуска находит игры, которые запустил раньше, и не трогает чужие.
const MARKER = '-Dveyra.client=';
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
async function copySettings(source, destination, overwrite = true) {
  for (const name of ['mods', 'config', 'defaultconfigs', 'resourcepacks', 'shaderpacks', 'options.txt', 'optionsof.txt', 'optionsshaders.txt', 'servers.dat']) {
    const from = path.join(source, name), to = path.join(destination, name);
    try {
      if (!overwrite && await fs.stat(to).catch(() => null)) continue;
      await fs.cp(from, to, { recursive: true, filter: async file => !(await fs.lstat(file)).isSymbolicLink() });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
// Основная папка свободна, если в ней не работает ни один известный клиент Veyra — лаунчер знает их всех, включая найденные после перезапуска.
async function clientFolder(instance, additional) {
  if (!additional) {
    // Файл владельца из 0.8.0 и раньше: PID в нём мог достаться чужому процессу и навсегда занять папку.
    await fs.rm(path.join(instance.directory, '.veyra-client-owner.json'), { force: true }).catch(() => {});
    return instance.directory;
  }
  const root = path.join(instance.directory, '.veyra-clients');
  await fs.mkdir(root, { recursive: true });
  if ((await fs.lstat(root)).isSymbolicLink()) throw new Error('Папка дополнительных клиентов не должна быть ссылкой');
  const directory = path.join(root, randomUUID());
  await fs.mkdir(directory);
  await copySettings(instance.directory, directory);
  await fs.writeFile(path.join(directory, 'VEYRA.txt'), 'Отдельный клиент Veyra. Сохранения основной сборки не копируются. Эта папка сохраняется после завершения игры.');
  return directory;
}
// data — отпечаток папки данных лаунчера: у копии Veyra с другой папкой могут быть сборки с теми же id.
function clientMarker({ data, run, instance, folder = '', name, profile, memory, started }) {
  return MARKER + Buffer.from(JSON.stringify({ v: 1, data, run, instance, folder, name, profile, memory, started }), 'utf8').toString('base64url');
}
function readMarker(value) {
  try {
    const info = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (info?.v !== 1 || !/^[0-9a-f]{12}$/.test(info.data) || !ID.test(info.run) || typeof info.instance !== 'string' || !info.instance || info.instance.length > 100) return null;
    if (info.folder !== '' && !ID.test(info.folder)) return null;
    if (typeof info.name !== 'string' || !info.name || info.name.length > 64 || typeof info.profile !== 'string' || info.profile.length > 64) return null;
    if (!Number.isInteger(info.memory) || info.memory < 1 || info.memory > 1024 || !Number.isFinite(info.started)) return null;
    return info;
  } catch { return null; }
}
// Командные строки процессов на Windows доступны только через WMI. Скрипт передаётся через stdin,
// поэтому сама PowerShell не попадает в результат, а метки декодирует и проверяет лаунчер.
const SCAN = "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%-Dveyra.client=%'\" | ForEach-Object { $m = [regex]::Match([string]$_.CommandLine, '-Dveyra\\.client=([A-Za-z0-9_-]{1,2000})'); if ($m.Success -and $_.CreationDate) { [string]$_.ProcessId + ' ' + ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() + ' ' + $m.Groups[1].Value } }";
function findClients({ spawner = spawn, timeout = 20000 } = {}) {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawner(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('поиск процессов не ответил')); }, timeout);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(errors.trim().split(/\r?\n/)[0] || 'PowerShell завершилась с кодом ' + code));
      // Процесс-обёртка и сама Java могут нести одну метку: клиентом считается запущенный первым.
      const clients = new Map();
      for (const line of output.split(/\r?\n/)) {
        const [pid, created, value] = line.trim().split(' ');
        const info = value && readMarker(value);
        if (!info || !/^\d+$/.test(pid) || !/^\d+$/.test(created)) continue;
        const item = { pid: Number(pid), createdAt: Number(created), info };
        if (!clients.has(info.run) || clients.get(info.run).createdAt > item.createdAt) clients.set(info.run, item);
      }
      resolve([...clients.values()]);
    });
    child.stdin.end(SCAN + '\n');
  });
}
const alive = pid => { if (!Number.isInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
function clientName(base, used, any = false) {
  const names = new Set(used.map(value => value.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let number = 2; ; number++) {
    const suffix = '_' + number;
    const name = Array.from(base).slice(0, (any ? 32 : 16) - suffix.length).join('') + suffix;
    if (!names.has(name.toLowerCase())) return name;
  }
}
module.exports = { clientFolder, clientName, copySettings, clientMarker, readMarker, findClients, alive };
