const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validClientId } = require('./microsoft-auth');

function validSession(value) {
  return value && validClientId(value.clientId) && /^[a-f0-9]{32}$/i.test(value.profile?.id || '') &&
    /^[A-Za-z0-9_]{3,16}$/.test(value.profile?.name || '') &&
    typeof value.accessToken === 'string' && value.accessToken.length > 0 &&
    typeof value.refreshToken === 'string' && value.refreshToken.length > 0 && Number.isFinite(value.expiresAt);
}

class AccountVault {
  constructor(file, storage) {
    this.file = file;
    this.storage = storage;
    this.queue = Promise.resolve();
  }
  async read() {
    try {
      if (!this.storage.isEncryptionAvailable()) return null;
      const value = JSON.parse(this.storage.decryptString(await fs.readFile(this.file)));
      return validSession(value) ? value : null;
    } catch { return null; }
  }
  write(session) {
    this.queue = this.queue.catch(() => {}).then(() => this.writeNow(session));
    return this.queue;
  }
  async writeNow(session) {
    if (!validSession(session)) throw new Error('Некорректная сессия Minecraft');
    if (!this.storage.isEncryptionAvailable()) throw new Error('Windows не смогла защитить сессию. Повторите вход после перезапуска лаунчера.');
    const encrypted = this.storage.encryptString(JSON.stringify(session));
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.tmp-' + randomUUID();
    try {
      await fs.writeFile(temporary, encrypted);
      await fs.rename(temporary, this.file);
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
  clear() {
    this.queue = this.queue.catch(() => {}).then(() => fs.rm(this.file, { force: true }));
    return this.queue;
  }
}

module.exports = { AccountVault, validSession };
