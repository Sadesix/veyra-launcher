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

// Зашифрованное средствами Windows хранилище сессии. Формат проверяет свой валидатор:
// по умолчанию — сессия Microsoft, для аккаунта Veyra передаётся validVeyraSession.
class AccountVault {
  constructor(file, storage, validate = validSession) {
    this.file = file;
    this.storage = storage;
    this.validate = validate;
    this.queue = Promise.resolve();
  }
  async read() {
    try {
      if (!this.storage.isEncryptionAvailable()) return null;
      const value = JSON.parse(this.storage.decryptString(await fs.readFile(this.file)));
      return this.validate(value) ? value : null;
    } catch { return null; }
  }
  write(session) {
    this.queue = this.queue.catch(() => {}).then(() => this.writeNow(session));
    return this.queue;
  }
  async writeNow(session) {
    if (!this.validate(session)) throw new Error('Некорректная сессия Minecraft');
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

// Сессия аккаунта Veyra: адрес API, токены входа, профиль и последний известный скин.
function validVeyraSession(value) {
  return Boolean(value) && typeof value.api === 'string' && /^https?:\/\//.test(value.api) &&
    typeof value.accessToken === 'string' && /^[0-9a-f]{64}$/.test(value.accessToken) &&
    typeof value.clientToken === 'string' && /^[\x21-\x7e]{1,128}$/.test(value.clientToken) &&
    /^[0-9a-f]{32}$/.test(value.profile?.id || '') && /^[A-Za-z0-9_]{3,16}$/.test(value.profile?.name || '') &&
    (value.skin === null || /^[0-9a-f]{64}$/.test(value.skin?.hash || '') && typeof value.skin.slim === 'boolean');
}

// Токены Veyra, которые ещё нужно отозвать на сервере: ими играл клиент или сервер не ответил при выходе.
function validVeyraRevokes(value) {
  return Boolean(value) && Array.isArray(value.tokens) && value.tokens.length <= 20 && value.tokens.every(item => Boolean(item) &&
    typeof item.api === 'string' && /^https?:\/\//.test(item.api) && typeof item.accessToken === 'string' && /^[0-9a-f]{64}$/.test(item.accessToken) &&
    typeof item.clientToken === 'string' && /^[\x21-\x7e]{1,128}$/.test(item.clientToken) && Number.isFinite(item.at));
}

module.exports = { AccountVault, validSession, validVeyraSession, validVeyraRevokes };
