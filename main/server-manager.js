const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { open, readAllEntries, openEntryReadStream } = require('@xmcl/unzip');
const { validVersion } = require('./loaders');
const { serverConfig, serverProperties } = require('./server-config');
async function portFree(port) {
  // Windows can allow wildcard and specific-address binds simultaneously.
  // Probe loopback and every actual IPv4 address as well as the wildcard.
  const hosts = [...new Set(['0.0.0.0', '127.0.0.1', ...Object.values(os.networkInterfaces()).flat().filter(item => item?.family === 'IPv4').map(item => item.address)])];
  for (const host of hosts) await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', error => reject(new Error(error.code === 'EADDRINUSE' ? 'Порт ' + port + ' уже занят. Остановите другой сервер или программу' : error.message))); probe.listen({ port, host, exclusive: true }, () => probe.close(resolve)); });
}
async function plain(directory) { await fs.mkdir(directory, { recursive: true }); if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('Папка сервера не должна быть ссылкой'); }
async function fabricSide(file) {
  const zip = await open(await fs.readFile(file), { lazyEntries: true, autoClose: false });
  try { const entry = (await readAllEntries(zip)).find(item => item.fileName === 'fabric.mod.json'); if (!entry) return ''; let text = ''; for await (const bytes of await openEntryReadStream(zip, entry)) { text += bytes; if (text.length > 1024 * 1024) throw new Error('Большой манифест мода'); } const mod = JSON.parse(text); return mod.environment === 'client' ? 'unsupported' : ['*', 'server'].includes(mod.environment || '*') ? 'required' : ''; }
  finally { zip.close(); }
}
class ServerManager {
  constructor({ fetch: fetcher = (...args) => fetch(...args), spawn = (...args) => require('node:child_process').spawn(...args), onChange = () => {}, port = 25565, version = '0.9.0' } = {}) { this.fetch = fetcher; this.spawn = spawn; this.onChange = onChange; this.port = port; this.agent = 'VeyraLauncher/' + version; this.run = null; this.state = null; this.partial = ''; }
  update(patch = {}) { this.state = { ...this.state, ...patch }; this.onChange(); }
  output(bytes) { const text = String(bytes).replace(/\x1b\[[0-9;]*m/g, ''); this.state.lines = (this.state.lines + text).slice(-60000);
    if (this.state.status === 'starting' && /Done \([\d.,]+s\)!|For help, type "help"/.test(this.state.lines)) { this.state.status = 'ready'; this.state.readyAt = Date.now(); }
    // Игроки собираются по целым строкам журнала; чат, /say и /me начинаются с <, [ или *.
    const lines = (this.partial + text).split(/\r?\n/); this.partial = lines.pop().slice(-2000);
    for (const line of lines) {
      const match = line.match(/\]: ([^<[*\s][^\r\n]{0,31}?) (joined|left) the game$/); if (!match) continue;
      const players = this.state.players.filter(name => name !== match[1]);
      this.state.players = match[2] === 'joined' ? [...players, match[1]].slice(-100) : players;
    }
    this.onChange();
  }
  command(text) {
    const child = this.run; if (!child || !['starting', 'ready'].includes(this.state?.status)) throw new Error('Сервер ещё не запущен');
    const line = typeof text === 'string' ? text.trim().replace(/^\//, '') : '';
    if (!line || line.length > 256 || /\p{Cc}/u.test(line)) throw new Error('Команда: одна строка до 256 символов');
    this.output('> ' + line + '\n'); child.stdin.write(line + '\n'); return true;
  }
  async json(url, signal) { const response = await this.fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]), headers: { 'User-Agent': this.agent } }); if (!response.ok) throw new Error('Сервер загрузки: HTTP ' + response.status); return response.json(); }
  async download(url, file, signal, hash) {
    if (hash && await fs.readFile(file).then(bytes => createHash('sha1').update(bytes).digest('hex') === hash).catch(() => false)) return;
    const response = await this.fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]) }); if (!response.ok) throw new Error('Загрузка сервера: HTTP ' + response.status);
    const bytes = Buffer.from(await response.arrayBuffer()); signal.throwIfAborted();
    if (hash && createHash('sha1').update(bytes).digest('hex') !== hash) throw new Error('Контрольная сумма сервера не совпала');
    const temporary = file + '.download'; try { await fs.writeFile(temporary, bytes); await fs.rename(temporary, file); } finally { await fs.rm(temporary, { force: true }); }
  }
  terminate(child) {
    if (child.exitCode != null || child.signalCode != null) return;
    if (process.platform === 'win32') require('node:child_process').execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {}); else child.kill('SIGKILL');
  }
  async installer(java, args, directory, signal) {
    const child = this.spawn(java, args, { cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const abort = () => this.terminate(child); signal.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', bytes => this.output(bytes)); child.stderr?.on('data', bytes => this.output(bytes));
    try { await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('Установщик сервера завершился с кодом ' + code))); if (signal.aborted) abort(); }); signal.throwIfAborted(); }
    finally { signal.removeEventListener('abort', abort); }
  }
  async syncMods(instance, directory, signal) {
    const root = path.join(instance.directory, 'mods'), target = path.join(directory, 'mods'); await plain(target);
    if ((await fs.lstat(root).catch(() => null))?.isSymbolicLink()) throw new Error('Папка модов сборки не должна быть ссылкой');
    const manifest = await fs.readFile(path.join(instance.directory, '.veyra-content.json'), 'utf8').then(JSON.parse).catch(() => ({ items: [] }));
    const records = new Map((manifest.items || []).filter(item => item.kind === 'mods').map(item => [item.file, item]));
    const files = (await fs.readdir(root, { withFileTypes: true }).catch(() => [])).filter(item => item.isFile() && item.name.endsWith('.jar'));
    const eligible = [], skipped = []; const cache = await fs.readFile(path.join(directory, '.veyra-sides.json'), 'utf8').then(JSON.parse).catch(() => ({}));
    for (const file of files) {
      signal.throwIfAborted(); const record = records.get(file.name); let side = '';
      if (record?.projectId) {
        const key = record.projectId + ':' + record.versionId;
        try { side = cache[key] || (await this.json('https://api.modrinth.com/v2/project/' + encodeURIComponent(record.projectId), signal)).server_side || ''; if (side) cache[key] = side; } catch { signal.throwIfAborted(); }
      }
      if (!side && instance.loader === 'fabric') side = await fabricSide(path.join(root, file.name)).catch(() => '');
      if (side === 'required' || side === 'optional') eligible.push({ name: file.name, record }); else skipped.push({ name: file.name, reason: side === 'unsupported' ? 'Только для клиента' : 'Серверная совместимость не указана' });
    }
    // Do not copy a dependent mod without its declared required library.
    let changed = true;
    while (changed) { changed = false; const ids = new Set(eligible.map(item => item.record?.projectId).filter(Boolean)); for (let i = eligible.length - 1; i >= 0; i--) if (eligible[i].record?.dependencies?.some(id => !ids.has(id))) { skipped.push({ name: eligible[i].name, reason: 'Нет совместимой обязательной зависимости' }); eligible.splice(i, 1); changed = true; } }
    const managedFile = path.join(directory, '.veyra-server-mods.json'); const managed = await fs.readFile(managedFile, 'utf8').then(JSON.parse).catch(() => []);
    for (const item of eligible) { const existing = await fs.lstat(path.join(target, item.name)).catch(() => null); if (existing?.isSymbolicLink() || existing && !managed.includes(item.name)) throw new Error('В сервере уже есть собственный файл ' + item.name + '. Переименуйте его перед синхронизацией'); }
    await fs.writeFile(managedFile, JSON.stringify([...new Set([...managed, ...eligible.map(item => item.name)])]));
    for (const name of managed) if (path.basename(name) === name && !eligible.some(item => item.name === name)) await fs.rm(path.join(target, name), { force: true });
    for (const item of eligible) await fs.copyFile(path.join(root, item.name), path.join(target, item.name));
    await fs.writeFile(managedFile, JSON.stringify(eligible.map(item => item.name))); await fs.writeFile(path.join(directory, '.veyra-sides.json'), JSON.stringify(cache));
    for (const name of ['config', 'defaultconfigs']) { const source = path.join(instance.directory, name), destination = path.join(directory, name); if (!await fs.stat(destination).catch(() => null)) await fs.cp(source, destination, { recursive: true, filter: async file => !(await fs.lstat(file)).isSymbolicLink() }).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    this.update({ skipped });
  }
  // jvm — дополнительные аргументы Java до команды запуска, например агент входа через Veyra.
  async start(instance, metadata, java, memoryGb, acceptEula, signal, options, jvm = []) {
    if (this.run) throw new Error('Сервер уже работает. Сначала остановите его');
    const directory = path.join(instance.directory, '.veyra-server'); await plain(directory);
    const accepted = /(?:^|\n)eula\s*=\s*true/.test(await fs.readFile(path.join(directory, 'eula.txt'), 'utf8').catch(() => ''));
    if (!accepted && !acceptEula) throw new Error('Подтвердите согласие с Minecraft EULA');
    const config = serverConfig(options), port = options?.port || this.port;
    await portFree(port);
    const addresses = [...new Set(Object.values(os.networkInterfaces()).flat().filter(item => item && !item.internal && item.family === 'IPv4').map(item => item.address + ':' + port))];
    this.partial = '';
    this.state = { instanceId: instance.id, directory, host: '0.0.0.0', addresses, port, memoryGb, config, players: [], startedAt: Date.now(), readyAt: 0, status: 'preparing', lines: '', skipped: [], error: '' }; this.onChange();
    try {
      const base = await this.json(metadata.url, signal); if (!base.downloads?.server?.url) throw new Error('Для этой версии нет выделенного сервера');
      const key = [instance.minecraftVersion, instance.loader, instance.loaderVersion].join(':'); const marker = path.join(directory, '.veyra-server-ready.json');
      let args = await fs.readFile(marker, 'utf8').then(JSON.parse).then(data => data.key === key ? data.args : null).catch(() => null);
      if (!args) {
        this.output('Подготавливаем ' + instance.loader + ' · Minecraft ' + instance.minecraftVersion + '\n');
        if (instance.loader === 'vanilla') { await this.download(base.downloads.server.url, path.join(directory, 'server.jar'), signal, base.downloads.server.sha1); args = ['-jar', 'server.jar']; }
        else if (instance.loader === 'fabric') {
          const installers = await this.json('https://meta.fabricmc.net/v2/versions/installer', signal); const installer = installers.find(item => item.stable) || installers[0];
          if (!validVersion(installer?.version)) throw new Error('Не найдена версия установщика Fabric');
          await this.download('https://meta.fabricmc.net/v2/versions/loader/' + instance.minecraftVersion + '/' + instance.loaderVersion + '/' + installer.version + '/server/jar', path.join(directory, 'fabric-server-launch.jar'), signal); args = ['-jar', 'fabric-server-launch.jar'];
        } else {
          const full = instance.minecraftVersion + '-' + instance.loaderVersion;
          const url = instance.loader === 'forge' ? 'https://maven.minecraftforge.net/net/minecraftforge/forge/' + full + '/forge-' + full + '-installer.jar' : 'https://maven.neoforged.net/releases/net/neoforged/neoforge/' + instance.loaderVersion + '/neoforge-' + instance.loaderVersion + '-installer.jar';
          await this.download(url, path.join(directory, 'installer.jar'), signal);
          await this.installer(java, ['-jar', 'installer.jar', '--installServer'], directory, signal);
          const bat = await fs.readFile(path.join(directory, 'run.bat'), 'utf8').catch(() => ''); const match = bat.match(/@(?:"([^"\r\n]*win_args\.txt)"|([^\s"\r\n]*win_args\.txt))/i);
          if (match) { const relative = (match[1] || match[2]).replaceAll('\\', '/'); if (!relative.startsWith('libraries/') || relative.split('/').includes('..') || path.isAbsolute(relative)) throw new Error('Некорректный файл аргументов сервера'); args = ['@' + relative]; }
          else { const jar = (await fs.readdir(directory)).find(name => /^forge-.*\.jar$/.test(name) && !name.includes('installer')); if (!jar) throw new Error('Установщик не создал команду запуска сервера'); args = ['-jar', jar]; }
        }
        await fs.writeFile(marker, JSON.stringify({ key, args }));
      }
      await this.syncMods(instance, directory, signal);
      await fs.writeFile(path.join(directory, 'eula.txt'), 'eula=true\n');
      let properties = await fs.readFile(path.join(directory, 'server.properties'), 'utf8').catch(() => '');
      for (const [key, value] of Object.entries(serverProperties(config, port))) { properties = properties.replace(new RegExp('^' + key + '=.*(?:\\r?\\n|$)', 'gm'), ''); properties += '\n' + key + '=' + value + '\n'; }
      await fs.writeFile(path.join(directory, 'server.properties'), properties);
      await portFree(port); signal.throwIfAborted();
      const child = this.spawn(java, ['-Xms512M', '-Xmx' + memoryGb + 'G', ...jvm, ...args, 'nogui'], { cwd: directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.run = child; this.update({ status: 'starting', pid: child.pid });
      child.stdin?.on('error', error => this.output(error.message + '\n')); child.stdout?.on('data', bytes => this.output(bytes)); child.stderr?.on('data', bytes => this.output(bytes));
      child.once('error', error => { if (this.run !== child) return; this.run = null; this.update({ status: 'error', error: error.message, players: [] }); });
      child.once('close', code => { if (this.run && this.run !== child) return; this.run = null; this.update({ players: [], status: code === 0 || this.state.status === 'stopping' ? 'stopped' : 'error', error: code && this.state.status !== 'stopping' ? 'Сервер завершился с кодом ' + code + '. Проверьте журнал и совместимость модов' : '' }); });
      return this.state;
    } catch (error) { this.update({ status: signal.aborted ? 'stopped' : 'error', error: signal.aborted ? '' : error.message }); throw error; }
  }
  async stop(force = false) {
    const child = this.run; if (!child) return true;
    this.update({ status: 'stopping' });
    if (force) this.terminate(child); else child.stdin?.write('stop\n');
    return new Promise(resolve => { const timer = setTimeout(() => resolve(false), 20000); child.once('close', () => { clearTimeout(timer); resolve(true); }); });
  }
}
module.exports = { ServerManager, portFree, fabricSide };
