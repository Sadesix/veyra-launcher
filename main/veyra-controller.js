const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const path = require('node:path');
const { domainToASCII } = require('node:url');
const { isIP } = require('node:net');
const { createHash, randomUUID } = require('node:crypto');
const { Client } = require('ssh2');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { AccountVault } = require('./account-vault');
const accountConfig = require('./account-config.json');

const PROTOCOL = 3;
const entry = '/usr/local/lib/veyra-controller/controller.py';
const python = '/usr/bin/python3 -I';
const installCode = [
  'import json, sys',
  'payload = json.loads(sys.stdin.buffer.read(262145))',
  'module = {"__name__": "veyra_deploy"}',
  'exec(compile(payload["source"], "veyra-controller", "exec"), module)',
  'module["response"](lambda: module["install"](payload["source"], payload["account"]))',
].join('\n');
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const sha256 = value => createHash('sha256').update(value);
const validFingerprint = value => typeof value === 'string' && /^SHA256:[a-zA-Z0-9+/]{43}$/.test(value);
const validWorld = value => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
const isPort = value => Number.isInteger(value) && value >= 1 && value <= 65535;
const isVersion = value => typeof value === 'string' && /^(?:1\.(?:[89]|[1-9][0-9])(?:\.\d+)?|[2-9]\d\.\d+(?:\.\d+)?)$/.test(value);
const endpoint = (host, port) => (isIP(host) === 6 ? '[' + host + ']' : host) + ':' + port;
const publicHost = ({ id, name, host, port, username }) => ({ id, name, host, port, username });
const sameHost = (left, right) => left.host === right.host && left.port === right.port && left.username === right.username;

function parseHost(input) {
  const raw = typeof input?.host === 'string' ? input.host.trim().replace(/^\[([^\]]+)\]$/, '$1') : '';
  const host = isIP(raw) ? raw.toLowerCase() : domainToASCII(raw).toLowerCase();
  if (!host || host.length > 253 || !isIP(host) && !host.replace(/\.$/, '').split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error('Введите IP или доменное имя ВМ');
  }
  const username = typeof input.username === 'string' ? input.username.trim() : '';
  if (!/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(username)) throw new Error('Введите имя пользователя SSH');
  if (!isPort(input.port)) throw new Error('Укажите SSH-порт от 1 до 65535');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length > 48 || /\p{Cc}/u.test(name)) throw new Error('Имя ВМ должно содержать до 48 символов');
  const password = typeof input.password === 'string' ? input.password : '';
  const keyFile = typeof input.keyFile === 'string' ? input.keyFile : '';
  const passphrase = typeof input.passphrase === 'string' ? input.passphrase : '';
  if (password.length > 1024 || passphrase.length > 1024) throw new Error('Слишком длинный пароль или парольная фраза');
  if (keyFile ? !path.isAbsolute(keyFile) || keyFile.length > 4096 : !password) {
    throw new Error('Введите пароль SSH или выберите приватный ключ');
  }
  return { host, port: input.port, username, name: name || host, password: keyFile ? '' : password, keyFile, passphrase: keyFile ? passphrase : '' };
}

function validVault(value) {
  return Array.isArray(value?.hosts) && value.hosts.every(host => {
    try {
      return validFingerprint(host.fingerprint) && /^[a-f0-9-]{36}$/.test(host.id) && parseHost(host).host === host.host;
    } catch { return false; }
  });
}

async function openSsh(profile, { expected, probe = false } = {}) {
  let key;
  if (!probe && profile.keyFile) {
    try {
      if ((await fs.stat(profile.keyFile)).size > 128 * 1024) throw new Error();
      key = await fs.readFile(profile.keyFile);
    } catch { throw new Error('Не удалось прочитать приватный ключ SSH'); }
  }
  return new Promise((resolve, reject) => {
    const client = new Client();
    let ready = false, fingerprint, settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      if (probe && fingerprint) { resolve(fingerprint); return; }
      if (fingerprint && expected && fingerprint !== expected) {
        reject(new Error('SSH-ключ ВМ изменился. Сверьте новый отпечаток у провайдера перед повторным добавлением ВМ.'));
        return;
      }
      reject(new Error(error?.level === 'client-authentication' ? 'ВМ отклонила пароль или ключ SSH' :
        error?.code === 'ECONNREFUSED' ? 'ВМ отклонила подключение к SSH-порту' :
          error?.message ? 'Ошибка SSH: ' + error.message : 'SSH-соединение закрыто'));
    };
    client.on('error', fail);
    client.on('close', () => { if (!ready) fail(); });
    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      if (prompts.length === 1 && !prompts[0].echo && /password|пароль/i.test(prompts[0].prompt) && profile.password) finish([profile.password]);
      else finish([]);
    });
    client.once('ready', () => { ready = settled = true; resolve(client); });
    try {
      client.connect({
        host: profile.host, port: profile.port, username: profile.username, readyTimeout: 12000,
        ...(probe ? {} : key ? { privateKey: key, passphrase: profile.passphrase || undefined } :
          { password: profile.password, tryKeyboard: true }),
        keepaliveInterval: 20000, keepaliveCountMax: 2,
        hostVerifier(keyBytes) {
          fingerprint = 'SHA256:' + sha256(keyBytes).digest('base64').replace(/=+$/, '');
          return !probe && fingerprint === expected;
        },
      });
    } catch (error) {
      fail(key ? new Error('Проверьте формат приватного ключа и его парольную фразу') : error);
      client.end();
    }
  });
}

function execute(client, command, value, input, signal, destination) {
  return new Promise((resolve, reject) => {
    let channel;
    let source;
    let completed = false;
    const timer = setTimeout(() => finish(new Error('ВМ не ответила вовремя')), input || destination ? 120000 : 35000);
    const cancel = () => finish(signal.reason);
    function finish(error, result) {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (error) { source?.destroy(); channel?.close(); reject(error); }
      else resolve(result);
    }
    if (signal?.aborted) { cancel(); return; }
    signal?.addEventListener('abort', cancel, { once: true });
    client.exec(command, (error, stream) => {
      if (error) return finish(error);
      if (completed) { stream.close(); return; }
      channel = stream;
      const chunks = [];
      let stderr = '', size = 0;
      stream.on('error', finish);
      const saved = destination ? pipeline(stream, createWriteStream(destination, { flags: 'wx' })) : null;
      saved?.catch(finish);
      stream.on('data', chunk => {
        if (saved) { timer.refresh(); return; }
        size += chunk.length;
        if (size > 16 * 1024 * 1024) return finish(new Error('Контроллер прислал слишком большой ответ'));
        chunks.push(chunk);
      });
      stream.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk.toString('utf8'); });
      stream.on('close', (code, signal) => {
        if (code === 44) { finish(null, null); return; }
        if (code !== 0) {
          const output = stderr.trim().slice(0, 400);
          const message = /sudo:/.test(output) ? 'Для установки и управления войдите как root или пользователь с sudo без пароля.' :
            /python3.*not found|python3: No such file/.test(output) ? 'На ВМ нужен системный Python 3 (путь /usr/bin/python3).' :
              output || (code == null ? 'SSH-соединение прервано' : 'Контроллер завершился с кодом ' + code);
          finish(new Error(signal ? message + ' (' + signal + ')' : message));
          return;
        }
        if (saved) { saved.then(() => finish(null, true), finish); return; }
        let reply;
        try { reply = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { finish(new Error('Контроллер вернул некорректный ответ')); return; }
        finish(reply?.ok ? null : new Error(String(reply?.error || 'Ошибка контроллера на ВМ')), reply?.data);
      });
      if (input) {
        source = Readable.from(input);
        source.on('error', finish);
        // Refresh the idle timeout as chunks are consumed. SSH provides the
        // backpressure for the file stream.
        source.on('data', () => timer.refresh());
        source.pipe(stream);
        stream.once('close', () => source.destroy());
      } else stream.end(JSON.stringify(value));
    });
  });
}

function worldSettings(input, creating, instance) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!name || Array.from(name).length > 48 || /\p{Cc}/u.test(name)) throw new Error('Укажите название мира (до 48 символов)');
  if (creating && !instance && !isVersion(input.minecraftVersion)) throw new Error('Выберите релиз Minecraft 1.8 или новее');
  if (!isPort(input.port) || input.port < 1024) throw new Error('Укажите игровой порт от 1024 до 65535');
  if (!Number.isInteger(input.memoryGb) || input.memoryGb < 1) throw new Error('Выделите миру не менее 1 ГБ ОЗУ');
  if (!Number.isInteger(input.maxPlayers) || input.maxPlayers < 1 || input.maxPlayers > 100) throw new Error('Укажите от 1 до 100 игроков');
  if (creating && input.eula !== true) throw new Error('Примите Minecraft EULA');
  if (typeof input.veyraLogin !== 'boolean') throw new Error('Укажите режим входа');
  return { name, minecraftVersion: instance?.minecraftVersion || input.minecraftVersion,
    ...(instance ? { loader: instance.loader, loaderVersion: instance.loaderVersion, sourceId: instance.id } : {}),
    port: input.port, memoryGb: input.memoryGb,
    maxPlayers: input.maxPlayers, eula: input.eula === true, veyraLogin: input.veyraLogin };
}

class VeyraController {
  constructor(dataDir, storage, accountApi) {
    this.vault = new AccountVault(path.join(dataDir, 'controller-hosts.bin'), storage, validVault);
    this.ready = this.vault.read().then(value => { this.hosts = value?.hosts || []; });
    this.sessions = new Map();
    this.pendingTrust = new Map();
    this.changes = Promise.resolve();
    this.account = { ...accountConfig, api: accountApi };
  }

  async list() {
    await this.ready;
    return this.hosts.map(publicHost);
  }

  change(task) {
    const operation = this.changes.catch(() => {}).then(() => this.ready).then(task);
    this.changes = operation;
    return operation;
  }

  async profile(id) {
    await this.ready;
    const profile = this.hosts.find(host => host.id === id);
    if (!profile) throw new Error('ВМ не найдена');
    return profile;
  }

  close(id) {
    const opening = this.sessions.get(id);
    this.sessions.delete(id);
    opening?.then(connection => connection.end(), () => {});
  }

  connection(profile) {
    if (this.sessions.has(profile.id)) return this.sessions.get(profile.id);
    const opening = openSsh(profile, { expected: profile.fingerprint }).then(connection => {
      connection.once('close', clear);
      return connection;
    }, error => { clear(); throw error; });
    const clear = () => { if (this.sessions.get(profile.id) === opening) this.sessions.delete(profile.id); };
    this.sessions.set(profile.id, opening);
    return opening;
  }

  run(client, profile, command, payload) {
    const prefix = profile.username === 'root' ? '' : 'sudo -n ';
    return execute(client, command === 'install' ? prefix + python + ' -c ' + shellQuote(installCode) :
      'test -f ' + entry + ' || exit 44; ' + prefix + python + ' ' + entry, payload);
  }

  async deploy(client, profile) {
    const source = await fs.readFile(path.join(__dirname, 'controller-linux.py'), 'utf8');
    const revision = sha256(source).update(JSON.stringify(this.account)).digest('hex');
    const remote = await this.run(client, profile, 'control', { action: 'hello' });
    if (remote && remote.protocol > PROTOCOL) throw new Error('На ВМ установлен более новый контроллер. Обновите Veyra Launcher.');
    if (!remote || remote.revision !== revision || remote.protocol !== PROTOCOL) {
      if (!this.account.api.startsWith('https://')) throw new Error('Для удалённого входа через Veyra требуется HTTPS API');
      const result = await this.run(client, profile, 'install', { source, account: { ...this.account, revision } });
      if (result?.protocol !== PROTOCOL) throw new Error('Не удалось установить Veyra Controller на ВМ');
    }
  }

  async connect(input, trust = '') {
    const profile = parseHost(input);
    if (!this.vault.storage.isEncryptionAvailable()) throw new Error('Windows не смогла защитить данные SSH. Перезапустите лаунчер.');
    return this.change(async () => {
      const existing = this.hosts.find(host => sameHost(host, profile));
      if (existing) {
        profile.id = existing.id;
        profile.fingerprint = existing.fingerprint;
      } else {
        const now = Date.now();
        for (const [id, candidate] of this.pendingTrust) if (candidate.expiry <= now) this.pendingTrust.delete(id);
        const candidate = this.pendingTrust.get(trust);
        this.pendingTrust.delete(trust);
        if (!candidate || !sameHost(candidate, profile)) {
          const fingerprint = await openSsh(profile, { probe: true });
          const token = randomUUID();
          this.pendingTrust.set(token, { host: profile.host, port: profile.port, username: profile.username, fingerprint, expiry: now + 180000 });
          return { fingerprint, token };
        }
        profile.id = randomUUID();
        profile.fingerprint = candidate.fingerprint;
      }
      const client = await openSsh(profile, { expected: profile.fingerprint });
      try {
        await this.deploy(client, profile);
        const snapshot = await this.run(client, profile, 'control', { action: 'snapshot' });
        const hosts = [...this.hosts.filter(host => host.id !== profile.id), profile];
        await this.vault.write({ hosts });
        this.hosts = hosts;
        this.close(profile.id);
        const opening = Promise.resolve(client);
        this.sessions.set(profile.id, opening);
        client.once('close', () => { if (this.sessions.get(profile.id) === opening) this.sessions.delete(profile.id); });
        return { host: publicHost(profile), snapshot };
      } catch (error) {
        client.end();
        throw error;
      }
    });
  }

  async attach(id) {
    const profile = await this.profile(id);
    const client = await this.connection(profile);
    await this.deploy(client, profile);
    return this.snapshot(id);
  }

  forget(id) {
    return this.change(async () => {
      await this.profile(id);
      const hosts = this.hosts.filter(host => host.id !== id);
      if (hosts.length) await this.vault.write({ hosts });
      else await this.vault.clear();
      this.hosts = hosts;
      this.close(id);
      return this.list();
    });
  }

  async request(id, value) {
    const profile = await this.profile(id);
    const result = await this.run(await this.connection(profile), profile, 'control', value);
    if (result === null) throw new Error('Veyra Controller отсутствует на ВМ. Подключите ВМ заново для установки.');
    return result;
  }

  snapshot(id, worldId) {
    return this.request(id, { action: 'snapshot', worldId: validWorld(worldId) ? worldId : null });
  }

  action(id, action, worldId, value) {
    if (!['create', 'save', 'start', 'stop', 'restart', 'command'].includes(action)) throw new Error('Неизвестное действие контроллера');
    if (action !== 'create' && !validWorld(worldId)) throw new Error('Выберите мир');
    const request = { action, worldId };
    if (action === 'create' || action === 'save') request.settings = worldSettings(value, action === 'create');
    if (action === 'command') {
      if (typeof value !== 'string' || !value.trim() || Array.from(value).length > 256 || /\p{Cc}/u.test(value)) throw new Error('Введите одну команду Minecraft (до 256 символов)');
      request.command = value;
    }
    return this.request(id, request);
  }

  async importBuild(id, value, instance, files, progress, signal) {
    const { buildStream } = require('./controller-build');
    const settings = worldSettings(value, true, instance);
    const profile = await this.profile(id);
    const client = await this.connection(profile);
    const prefix = profile.username === 'root' ? '' : 'sudo -n ';
    return execute(client, prefix + python + ' ' + entry + ' import-build', null,
      buildStream({ settings }, files, progress, signal), signal);
  }

  workspace(id, worldId, action, options = {}) {
    if (!['files', 'read-file', 'game-rules', 'save-rules', 'save-config', 'mkdir', 'delete-world', 'delete-server', 'trash', 'restore', 'purge'].includes(action)) {
      throw new Error('Неизвестное действие файловой панели');
    }
    if (!['trash', 'restore', 'purge'].includes(action) && !validWorld(worldId)) throw new Error('Выберите сервер');
    if (action === 'save-config') options = { ...options, settings: worldSettings(options.settings, false) };
    return this.request(id, { ...options, action, worldId });
  }

  async fileChannel(id, action, value, input, signal, destination) {
    if (!validWorld(value.worldId)) throw new Error('Выберите сервер');
    const profile = await this.profile(id);
    const prefix = profile.username === 'root' ? '' : 'sudo -n ';
    return execute(await this.connection(profile), prefix + python + ' ' + entry + ' ' + action,
      value, input, signal, destination);
  }

  async uploadFile(id, worldId, name, file, options) {
    const { size } = await fs.stat(file);
    const header = { path: name, worldId, size, replace: options.replace === true };
    async function* input() {
      yield JSON.stringify(header) + '\n';
      yield* createReadStream(file);
    }
    return this.fileChannel(id, 'upload-file', header, input());
  }

  saveText(id, worldId, name, text, etag) {
    if (typeof text !== 'string' || typeof etag !== 'string' || !/^[\da-f]{64}$/.test(etag)) throw new Error('Откройте файл перед сохранением');
    const bytes = Buffer.from(text);
    if (bytes.length > 1024 * 1024 || bytes.includes(0)) throw new Error('Сохранять можно текст UTF-8 до 1 МБ');
    const header = { path: name, worldId, size: bytes.length, replace: true, etag };
    return this.fileChannel(id, 'upload-file', header, [JSON.stringify(header) + '\n', bytes]);
  }

  async downloadFiles(id, worldId, kind, name, output) {
    const temporary = output + '.veyra-part-' + randomUUID();
    try {
      await this.fileChannel(id, 'download-files', { worldId, kind, path: name }, null, null, temporary);
      await fs.rename(temporary, output);
      return true;
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  async replaceBuild(id, worldId, mode, archive, sourceId, progress, signal) {
    const { buildStream } = require('./controller-build');
    const header = { worldId, mode, compatibility: archive.compatibility, sourceId };
    return this.fileChannel(id, 'replace-build', header, buildStream(header, archive, progress, signal), signal);
  }

  async target(id, worldId) {
    if (!validWorld(worldId)) throw new Error('Выберите мир');
    const profile = await this.profile(id);
    const { worlds } = await this.snapshot(id, worldId);
    const world = worlds.find(item => item.id === worldId);
    if (!world || !isPort(world.port) || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/.test(world.minecraftVersion)) throw new Error('Мир на ВМ не найден');
    return { ...world, host: profile.host, address: endpoint(profile.host, world.port) };
  }
}

module.exports = { VeyraController, endpoint };
