const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const config = require('./account-config.json');

// Клиент сервера аккаунтов Veyra: вход по спецификации Yggdrasil (authserver/*) и личные адреса veyra/*.
// Все ошибки превращаются в понятный русский текст; 429 несёт время ожидания в retryAfter.
const NAME = /^[A-Za-z0-9_]{3,16}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{32}$/;
const SKIN_BYTES = 64 * 1024;
const RUSSIAN = /[А-Яа-яЁё]/;

class VeyraError extends Error {
  constructor(message, { code = 'failed', status = 0, retryAfter = 0 } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

// Корень API: из account-config.json, для проверок — из VEYRA_ACCOUNT_API. Всегда со слешем в конце.
function apiRoot(value = process.env.VEYRA_ACCOUNT_API || config.api) {
  let url;
  try { url = new URL(value); } catch { url = new URL(config.api); }
  if (!/^https?:$/.test(url.protocol)) url = new URL(config.api);
  url.search = ''; url.hash = '';
  return url.href.endsWith('/') ? url.href : url.href + '/';
}
const validName = value => typeof value === 'string' && NAME.test(value);
const validPassword = value => typeof value === 'string' && Array.from(value).length >= 6 && Array.from(value).length <= 128 && !/[\x00-\x1f\x7f]/.test(value);
const validToken = value => typeof value === 'string' && HEX64.test(value);
const validClientToken = value => typeof value === 'string' && /^[\x21-\x7e]{1,128}$/.test(value);
const validProfile = value => Boolean(value) && typeof value.id === 'string' && UUID.test(value.id) && validName(value.name);

function waitText(seconds) { return seconds < 60 ? seconds + ' с' : Math.ceil(seconds / 60) + ' мин'; }
// Ответ сервера с ошибкой → VeyraError с русским текстом.
function failure(status, body, headers, action) {
  const code = typeof body?.error === 'string' ? body.error : 'http_' + status;
  const text = typeof body?.errorMessage === 'string' ? body.errorMessage : '';
  if (status === 429) {
    const retryAfter = Math.max(1, Math.min(3600, Math.round(Number(body?.retryAfter) || Number(headers?.get?.('retry-after')) || 15)));
    return new VeyraError(RUSSIAN.test(text) ? text : 'Слишком много попыток. Подождите ' + waitText(retryAfter) + '.', { code: 'too_many_requests', status, retryAfter });
  }
  if (action === 'login' && status === 403) return new VeyraError('Неверный ник или пароль', { code: 'wrong_credentials', status });
  if (action === 'refresh' && (status === 403 || status === 401)) return new VeyraError('Вход в аккаунт Veyra устарел — войдите заново', { code: 'expired', status });
  if (status === 401) return new VeyraError('Вход в аккаунт Veyra устарел — войдите заново', { code: 'unauthorized', status });
  if (RUSSIAN.test(text)) return new VeyraError(text, { code, status });
  if (status >= 500) return new VeyraError('Сервер аккаунтов Veyra временно не отвечает (HTTP ' + status + '). Повторите попытку позже.', { code, status });
  return new VeyraError('Сервер аккаунтов Veyra отклонил запрос (HTTP ' + status + ').', { code, status });
}

class VeyraAccount {
  constructor({ root = apiRoot(), fetchImpl = (...args) => fetch(...args), version = '0', timeout = 15000 } = {}) {
    this.root = root;
    this.fetch = fetchImpl;
    this.agent = 'VeyraLauncher/' + version;
    this.timeout = timeout;
  }

  async request(route, { method = 'GET', json, raw, type, token, signal, timeout = this.timeout, action = '', binary = false } = {}) {
    const headers = { 'User-Agent': this.agent, Accept: binary ? 'image/png' : 'application/json' };
    let body;
    if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    if (raw !== undefined) { headers['Content-Type'] = type; body = raw; }
    if (token) headers.Authorization = 'Bearer ' + token;
    const limit = AbortSignal.timeout(timeout);
    let response;
    try {
      response = await this.fetch(new URL(route, this.root), { method, headers, body, redirect: 'error', signal: signal ? AbortSignal.any([signal, limit]) : limit });
    } catch (error) {
      if (signal?.aborted) throw new VeyraError('Действие отменено', { code: 'cancelled' });
      if (limit.aborted) throw new VeyraError('Сервер аккаунтов Veyra не ответил вовремя. Проверьте интернет и повторите попытку.', { code: 'network' });
      throw new VeyraError('Сервер аккаунтов Veyra недоступен. Проверьте интернет и повторите попытку.', { code: 'network' });
    }
    let bytes;
    try { bytes = Buffer.from(await response.arrayBuffer()); }
    catch { throw new VeyraError('Ответ сервера аккаунтов оборвался. Повторите попытку.', { code: 'network' }); }
    let data = null;
    if (!binary && bytes.length && /json/i.test(response.headers.get('content-type') || '')) {
      try { data = JSON.parse(bytes.toString('utf8')); } catch { data = null; }
    }
    if (!response.ok) throw failure(response.status, data, response.headers, action);
    return { status: response.status, data, bytes };
  }

  // Ответ входа, регистрации и обновления: токен и профиль игрока.
  session(data, clientToken) {
    if (!validToken(data?.accessToken) || !validProfile(data?.selectedProfile)) throw new VeyraError('Сервер аккаунтов вернул неполный ответ. Повторите попытку.', { code: 'invalid_reply' });
    return { accessToken: data.accessToken, clientToken: validClientToken(data.clientToken) ? data.clientToken : clientToken, profile: { id: data.selectedProfile.id, name: data.selectedProfile.name } };
  }
  skin(value) {
    if (value === null || value === undefined) return null;
    if (typeof value?.hash !== 'string' || !HEX64.test(value.hash)) throw new VeyraError('Сервер аккаунтов вернул неполный ответ о скине.', { code: 'invalid_reply' });
    return { hash: value.hash, slim: value.slim === true };
  }

  // Описание сервера для authlib-injector: исходный текст JSON нужен целиком — он уходит в игру в base64.
  async metadata(signal) {
    const { bytes, data } = await this.request('', { signal });
    if (!data?.meta || typeof data.signaturePublickey !== 'string') throw new VeyraError('Сервер аккаунтов Veyra вернул неверное описание.', { code: 'invalid_reply' });
    return bytes.toString('utf8');
  }
  async authenticate(username, password, clientToken, signal) {
    if (!validName(username)) throw new VeyraError('Ник — от 3 до 16 символов: латинские буквы, цифры и знак _', { code: 'invalid_name' });
    if (typeof password !== 'string' || !password) throw new VeyraError('Введите пароль', { code: 'invalid_password' });
    const { data } = await this.request('authserver/authenticate', { method: 'POST', json: { username, password, clientToken, requestUser: false, agent: { name: 'Minecraft', version: 1 } }, signal, action: 'login' });
    return this.session(data, clientToken);
  }
  async register(username, password, clientToken, signal) {
    if (!validName(username)) throw new VeyraError('Ник — от 3 до 16 символов: латинские буквы, цифры и знак _', { code: 'invalid_name' });
    if (!validPassword(password)) throw new VeyraError('Пароль — от 6 до 128 символов без переносов строк', { code: 'invalid_password' });
    const { data } = await this.request('veyra/register', { method: 'POST', json: { username, password, clientToken }, signal });
    return this.session(data, clientToken);
  }
  async refresh(accessToken, clientToken, signal) {
    const { data } = await this.request('authserver/refresh', { method: 'POST', json: { accessToken, clientToken, requestUser: false }, signal, action: 'refresh' });
    return this.session(data, clientToken);
  }
  // true — токен действует, false — сервер его не принял; сетевые сбои выбрасываются.
  async validate(accessToken, clientToken, signal) {
    try { await this.request('authserver/validate', { method: 'POST', json: { accessToken, clientToken }, signal }); return true; }
    catch (error) { if (error.status === 403 || error.status === 401) return false; throw error; }
  }
  async invalidate(accessToken, clientToken) {
    await this.request('authserver/invalidate', { method: 'POST', json: { accessToken, clientToken }, timeout: 5000 });
    return true;
  }
  async me(token, signal) {
    const { data } = await this.request('veyra/me', { token, signal });
    if (!validProfile(data)) throw new VeyraError('Сервер аккаунтов вернул неполный профиль.', { code: 'invalid_reply' });
    return { id: data.id, name: data.name, createdAt: typeof data.createdAt === 'string' ? data.createdAt : '', skin: this.skin(data.skin) };
  }
  async uploadSkin(token, bytes, slim, signal) {
    const { data } = await this.request('veyra/skin?model=' + (slim ? 'slim' : 'classic'), { method: 'POST', raw: bytes, type: 'image/png', token, signal, timeout: 30000 });
    return this.skin(data?.skin);
  }
  async setSkinModel(token, slim, signal) {
    const { data } = await this.request('veyra/skin/model', { method: 'POST', json: { slim: slim === true }, token, signal });
    return this.skin(data?.skin);
  }
  async removeSkin(token, signal) {
    await this.request('veyra/skin/delete', { method: 'POST', token, signal });
    return true;
  }
  // Файл скина берётся только с нашего сервера и сверяется с SHA-256 из его имени.
  async texture(hash, signal) {
    if (!HEX64.test(hash)) throw new VeyraError('Некорректный адрес скина', { code: 'invalid_reply' });
    const { bytes } = await this.request('textures/' + hash, { signal, binary: true, timeout: 30000 });
    if (bytes.length > SKIN_BYTES * 2 || createHash('sha256').update(bytes).digest('hex') !== hash) throw new VeyraError('Файл скина пришёл повреждённым. Повторите попытку.', { code: 'invalid_texture' });
    return bytes;
  }
}

// Быстрая проверка файла до отправки: настоящий PNG 64×64 или 64×32 и не больше 64 КБ. Остальное проверит сервер.
function checkSkinFile(bytes) {
  if (bytes.length > SKIN_BYTES) throw new VeyraError('Скин больше 64 КБ — выберите PNG 64×64 или 64×32', { code: 'too_large' });
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || bytes.toString('latin1', 12, 16) !== 'IHDR') throw new VeyraError('Это не PNG. Скин Minecraft — картинка PNG 64×64 или 64×32', { code: 'invalid_png' });
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (width !== 64 || (height !== 64 && height !== 32)) throw new VeyraError('Скин должен быть 64×64 или 64×32, а не ' + width + '×' + height, { code: 'invalid_size' });
  return true;
}

// Прозрачность пикселей PNG без внешних библиотек: разбор чанков, распаковка и обратные фильтры строк.
function pngAlpha(bytes) {
  let offset = 8, header = null, transparency = null;
  const parts = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('latin1', offset + 4, offset + 8), body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], color: body[9], interlace: body[12] };
    else if (type === 'tRNS') transparency = body;
    else if (type === 'IDAT') parts.push(body);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header?.color];
  if (!channels || header.interlace) return null;
  const bits = channels * header.depth, stride = Math.ceil(header.width * bits / 8), step = Math.max(1, bits / 8);
  const packed = zlib.inflateSync(Buffer.concat(parts)), rows = [];
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < header.height; y++) {
    const filter = packed[y * (stride + 1)], row = Buffer.from(packed.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const left = i >= step ? row[i - step] : 0, up = previous[i], corner = i >= step ? previous[i - step] : 0;
      const guess = left + up - corner, near = Math.abs(guess - left) <= Math.abs(guess - up) && Math.abs(guess - left) <= Math.abs(guess - corner) ? left : Math.abs(guess - up) <= Math.abs(guess - corner) ? up : corner;
      row[i] = (row[i] + [0, left, up, (left + up) >> 1, near][filter]) & 255;
    }
    rows.push(row); previous = row;
  }
  const sample = (row, x) => header.depth >= 8 ? row[x * step] : (row[x * header.depth >> 3] >> (8 - header.depth - (x * header.depth & 7))) & ((1 << header.depth) - 1);
  return (x, y) => {
    const row = rows[y];
    if (header.color === 6) return row[x * step + step - (header.depth === 16 ? 2 : 1)];
    if (header.color === 4) return row[x * step + step - (header.depth === 16 ? 2 : 1)];
    if (header.color === 3) { const index = sample(row, x); return transparency && index < transparency.length ? transparency[index] : 255; }
    return 255;
  };
}
// Модель по самой картинке: у тонкого скина правая рука шириной 3 пикселя, и столбцы 54–55 развёртки пусты.
// null — понять нельзя (старый формат 64×32 или нестандартный файл).
function skinModel(bytes) {
  try {
    if (bytes.readUInt32BE(20) !== 64) return null;
    const alpha = pngAlpha(bytes);
    if (!alpha) return null;
    for (let y = 20; y < 32; y++) for (const x of [54, 55]) if (alpha(x, y) !== 0) return false;
    return true;
  } catch { return null; }
}

module.exports = { VeyraAccount, VeyraError, apiRoot, validName, validPassword, validToken, validClientToken, validProfile, checkSkinFile, skinModel, waitText };
