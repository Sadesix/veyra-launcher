const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { createReadStream, createWriteStream } = require('node:fs');

const MODES = ['notify', 'off', 'auto'];
const MAX_SIZE = 400 * 1024 ** 2;
const validVersion = value => typeof value === 'string' && /^\d{1,4}(?:\.\d{1,4}){1,3}$/.test(value);
function newer(candidate, current) {
  const left = String(candidate).split('.').map(Number), right = String(current).split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference) return difference > 0;
  }
  return false;
}
// Адреса только по HTTPS; локальный HTTP разрешён лишь проверочным скриптам.
// Относительный адрес считается от файла обновлений: сайт можно перенести, не правя latest.json.
function link(value, insecure, base) {
  if (typeof value !== 'string' || !value || value.length > 2000) return '';
  try {
    const url = new URL(value, base || undefined);
    return url.protocol === 'https:' || insecure && url.protocol === 'http:' && url.hostname === '127.0.0.1' ? url.href : '';
  } catch { return ''; }
}
function manifest(value, { insecure = false, base = '' } = {}) {
  if (!value || typeof value !== 'object' || !validVersion(value.version)) throw new Error('Файл обновлений повреждён: нет номера версии');
  const file = value.windows && typeof value.windows === 'object' ? value.windows : {};
  return {
    version: value.version,
    published: typeof value.published === 'string' ? value.published.slice(0, 40) : '',
    notes: Array.isArray(value.notes) ? value.notes.filter(item => typeof item === 'string' && item.trim()).slice(0, 12).map(item => item.trim().slice(0, 300)) : [],
    page: link(value.page, insecure, base),
    url: link(file.url, insecure, base),
    sha256: typeof file.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(file.sha256) ? file.sha256.toLowerCase() : '',
    size: Number.isSafeInteger(file.size) && file.size > 0 && file.size <= MAX_SIZE ? file.size : 0,
  };
}
async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

class Updater {
  constructor({ version, feed = '', directory, fetch: fetcher = (...args) => fetch(...args), onChange = () => {}, insecure = false, fileName = version => 'Veyra-Launcher-' + version + '-x64.exe', retryDelay = 1500 } = {}) {
    this.version = version; this.feed = link(feed, insecure); this.directory = directory; this.fetch = fetcher; this.onChange = onChange; this.insecure = insecure;
    this.fileName = fileName; this.retryDelay = retryDelay;
    this.latest = null; this.controller = null; this.pending = null; this.file = ''; this.fileVersion = '';
    this.state = { status: this.feed ? 'idle' : 'unconfigured', version: '', published: '', notes: [], page: '', size: 0, downloadable: false, progress: null, error: '', checkedAt: 0, file: '', prepared: false };
  }
  set(patch) { this.state = { ...this.state, ...patch }; this.onChange(); }
  // Уже скачанный и проверенный файл новой версии не скачивается повторно.
  adopt(version, file) {
    this.file = file; this.fileVersion = version;
    if (!newer(this.state.version || '0', version)) this.set({ status: 'ready', version, file, progress: 100 });
  }
  check() {
    if (!this.feed) return Promise.resolve(this.state);
    if (this.state.status === 'downloading' || this.state.status === 'preparing') return Promise.resolve(this.state);
    this.pending ||= (async () => {
      this.set({ status: 'checking', error: '' });
      try {
        const response = await this.fetch(this.feed, { cache: 'no-store', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'VeyraLauncher/' + this.version, Accept: 'application/json' } });
        if (!response.ok) throw new Error('Сервер обновлений ответил HTTP ' + response.status);
        const text = await response.text();
        if (text.length > 100000) throw new Error('Файл обновлений слишком большой');
        let parsed;
        try { parsed = JSON.parse(text); } catch { throw new Error('Файл обновлений повреждён'); }
        const latest = manifest(parsed, { insecure: this.insecure, base: this.feed });
        this.latest = latest;
        const details = { version: latest.version, published: latest.published, notes: latest.notes, page: latest.page, size: latest.size, downloadable: Boolean(latest.url && latest.sha256), checkedAt: Date.now(), error: '' };
        if (!newer(latest.version, this.version)) this.set({ ...details, status: 'current', progress: null, file: '', prepared: false });
        else if (this.file && this.fileVersion === latest.version) this.set({ ...details, status: 'ready', progress: 100, file: this.file });
        else this.set({ ...details, status: 'available', progress: null, file: '', prepared: false });
      } catch (error) {
        this.set({ status: this.file ? 'ready' : 'error', error: error.name === 'TimeoutError' ? 'Сервер обновлений не ответил за 15 секунд' : error.message, checkedAt: Date.now() });
      } finally { this.pending = null; }
      return this.state;
    })();
    return this.pending;
  }
  async download() {
    const latest = this.latest;
    if (!latest || this.state.status !== 'available') throw new Error('Сначала проверьте обновления');
    if (!latest.url || !latest.sha256) throw new Error('В файле обновлений нет загрузки с контрольной суммой. Откройте страницу загрузки');
    const controller = new AbortController(), directory = typeof this.directory === 'function' ? this.directory() : this.directory;
    const target = path.join(directory, this.fileName(latest.version)), temporary = target + '.download';
    this.controller = controller;
    this.set({ status: 'downloading', progress: 0, error: '' });
    try {
      await fs.mkdir(directory, { recursive: true });
      // Обрыв связи не начинает загрузку заново: файл докачивается с места остановки, до четырёх попыток подряд.
      for (let attempt = 1; ; attempt++) {
        try { await this.receive(latest, temporary, controller.signal); break; }
        catch (error) {
          if (controller.signal.aborted || !error.retry || attempt >= 4) throw error;
          await new Promise(resolve => setTimeout(resolve, this.retryDelay * attempt));
        }
      }
      // Файл становится обновлением только после совпадения SHA-256 из файла обновлений.
      if (await fileHash(temporary) !== latest.sha256) throw new Error('Контрольная сумма обновления не совпала, файл удалён');
      await fs.rm(target, { force: true });
      await fs.rename(temporary, target);
      this.file = target; this.fileVersion = latest.version;
      this.set({ status: 'ready', progress: 100, file: target, error: '', prepared: false });
      return { version: latest.version, file: target, sha256: latest.sha256 };
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      this.set({ status: 'available', progress: null, error: controller.signal.aborted ? '' : error.message });
      if (controller.signal.aborted) return null;
      throw error;
    } finally { this.controller = null; }
  }
  async receive(latest, temporary, signal) {
    const have = await fs.stat(temporary).then(stat => stat.size, () => 0);
    let response;
    try {
      response = await this.fetch(latest.url, { signal, redirect: 'follow', headers: have ? { Range: 'bytes=' + have + '-' } : {} });
    } catch (error) { throw Object.assign(new Error('Загрузка обновления прервалась: ' + (error.cause?.code || error.message)), { retry: true }); }
    if (response.status === 416) { await fs.rm(temporary, { force: true }); throw Object.assign(new Error('Загрузка обновления: сервер не продолжил файл'), { retry: true }); }
    if (!response.ok || !response.body) throw Object.assign(new Error('Загрузка обновления: HTTP ' + response.status), { retry: response.status >= 500 });
    if (!link(response.url || latest.url, this.insecure)) throw new Error('Загрузка обновления перенаправлена на небезопасный адрес');
    const resumed = have > 0 && response.status === 206;
    const total = latest.size || (Number(response.headers.get('content-length')) || 0) + (resumed ? have : 0);
    if (total > MAX_SIZE) throw new Error('Файл обновления слишком большой');
    const output = createWriteStream(temporary, { flags: resumed ? 'a' : 'w' });
    let received = resumed ? have : 0, shown = this.state.progress;
    try {
      for await (const chunk of response.body) {
        received += chunk.length;
        if (received > MAX_SIZE) throw new Error('Файл обновления слишком большой');
        if (!output.write(chunk)) await once(output, 'drain');
        const percent = total ? Math.min(99, Math.floor(received / total * 100)) : null;
        if (percent !== shown) { shown = percent; this.set({ progress: percent }); }
      }
    } catch (error) {
      if (signal.aborted || error.message.includes('слишком большой')) throw error;
      throw Object.assign(new Error('Загрузка обновления прервалась: ' + (error.cause?.code || error.message)), { retry: true });
    } finally { await new Promise(resolve => output.end(resolve)); }
    if (latest.size && received !== latest.size) throw Object.assign(new Error('Загрузка обновления оборвалась на ' + Math.round(received / 1024 ** 2) + ' МБ'), { retry: received < latest.size });
  }
  cancel() { this.controller?.abort(); return true; }
}
module.exports = { MODES, Updater, manifest, newer, fileHash };
