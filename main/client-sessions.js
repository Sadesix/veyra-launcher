const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const owners = new Set();
const alive = pid => { if (!Number.isInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
async function copySettings(source, destination, overwrite = true) {
  for (const name of ['mods', 'config', 'defaultconfigs', 'resourcepacks', 'shaderpacks', 'options.txt', 'optionsof.txt', 'optionsshaders.txt', 'servers.dat']) {
    const from = path.join(source, name), to = path.join(destination, name);
    try {
      if (!overwrite && await fs.stat(to).catch(() => null)) continue;
      await fs.cp(from, to, { recursive: true, filter: async file => !(await fs.lstat(file)).isSymbolicLink() });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
async function clientFolder(instance, additional) {
  if (!additional) {
    const lease = path.join(instance.directory, '.veyra-client-owner.json');
    try {
      const handle = await fs.open(lease, 'wx');
      try { await handle.writeFile(JSON.stringify({ launcherPid: process.pid, pid: 0 })); } finally { await handle.close(); }
      owners.add(instance.directory); return instance.directory;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await fs.readFile(lease, 'utf8').then(JSON.parse).catch(() => null);
      if (owner && !alive(owner.launcherPid) && !alive(owner.pid)) { await fs.rm(lease); return clientFolder(instance, false); }
    }
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
function trackClient(directory, pid) { if (owners.has(directory)) require('node:fs').writeFileSync(path.join(directory, '.veyra-client-owner.json'), JSON.stringify({ launcherPid: process.pid, pid })); }
async function releaseClient(directory) { if (!owners.has(directory)) return; owners.delete(directory); await fs.rm(path.join(directory, '.veyra-client-owner.json'), { force: true }); }
function clientName(base, used, any = false) {
  const names = new Set(used.map(value => value.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let number = 2; ; number++) {
    const suffix = '_' + number;
    const name = Array.from(base).slice(0, (any ? 32 : 16) - suffix.length).join('') + suffix;
    if (!names.has(name.toLowerCase())) return name;
  }
}
module.exports = { clientFolder, clientName, copySettings, trackClient, releaseClient };
