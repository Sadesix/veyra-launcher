const { setTimeout: delay } = require('node:timers/promises');

const AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const SCOPE = 'XboxLive.SignIn offline_access';
const PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';

class AuthError extends Error {
  constructor(message, code = 'auth_failed') {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

function validClientId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function authFailure(stage, status, body = {}) {
  const code = body.error || body.errorType || 'http_' + status;
  if (code === 'authorization_declined' || code === 'access_denied') return new AuthError('Вход отменён в Microsoft.', 'declined');
  if (code === 'expired_token') return new AuthError('Код входа истёк. Получите новый код.', 'expired');
  if (code === 'invalid_grant') return new AuthError('Сессия Microsoft истекла. Войдите ещё раз.', 'reauth');
  if (code === 'unauthorized_client' || code === 'invalid_client') {
    return new AuthError('Приложение Microsoft не настроено для публичного входа. Проверьте Client ID и Allow public client flows.', 'client_config');
  }
  if (Number(body.XErr) === 2148916233) return new AuthError('Создайте профиль Xbox для этого аккаунта на xbox.com и повторите вход.', 'xbox_profile');
  if ([2148916236, 2148916237, 2148916238].includes(Number(body.XErr))) {
    return new AuthError('Настройки возраста или семьи Xbox не разрешают вход. Проверьте их в аккаунте Microsoft.', 'xbox_family');
  }
  if (stage === 'Minecraft' && status === 403) {
    return new AuthError('Minecraft не разрешил вход для Client ID этого лаунчера. Приложению Veyra нужен доступ к Minecraft API.', 'app_approval');
  }
  if (stage === 'Профиль' && status === 404) {
    return new AuthError('Minecraft Java-профиль не найден. Проверьте покупку Java Edition или создайте профиль на minecraft.net.', 'no_profile');
  }
  if (status === 429) return new AuthError('Слишком много запросов. Подождите немного и повторите вход.', 'rate_limit');
  if (status === 401) return new AuthError('Сессия больше не действительна. Войдите в Microsoft ещё раз.', 'reauth');
  return new AuthError(stage + ': сервер вернул HTTP ' + status + '. Повторите попытку позже.', String(code));
}

class MicrosoftAuth {
  constructor({ fetchImpl = fetch, wait = delay, now = Date.now } = {}) {
    this.fetch = fetchImpl;
    this.wait = wait;
    this.now = now;
  }

  async request(url, options, signal, stage) {
    try {
      const response = await this.fetch(url, {
        ...options,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000),
      });
      const body = await response.json().catch(() => ({}));
      return { ok: response.ok, status: response.status, body };
    } catch (error) {
      if (signal?.aborted) throw new AuthError('Вход отменён.', 'cancelled');
      throw new AuthError(stage + ': не удалось подключиться. Проверьте интернет и повторите попытку.', 'network');
    }
  }

  async form(endpoint, data, signal) {
    return this.request(AUTHORITY + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(data).toString(),
    }, signal, 'Microsoft');
  }

  async deviceCode(clientId, signal) {
    if (!validClientId(clientId)) throw new AuthError('Для Veyra ещё не задан Client ID Microsoft. Откройте настройку входа в профиле.', 'client_config');
    const result = await this.form('/devicecode', { client_id: clientId, scope: SCOPE }, signal);
    if (!result.ok) throw authFailure('Microsoft', result.status, result.body);
    const value = result.body;
    if (!value.device_code || !value.user_code || !Number.isFinite(value.expires_in) || value.expires_in <= 0) {
      throw new AuthError('Microsoft вернул неполный код входа. Повторите попытку.');
    }
    let uri;
    try { uri = new URL(value.verification_uri); }
    catch { throw new AuthError('Microsoft вернул неполный адрес входа. Повторите попытку.'); }
    if (uri.protocol !== 'https:' || !['microsoft.com', 'www.microsoft.com', 'login.microsoftonline.com'].includes(uri.hostname)) {
      throw new AuthError('Microsoft вернул неподдерживаемый адрес входа.');
    }
    return {
      deviceCode: value.device_code,
      userCode: value.user_code,
      verificationUri: uri.href,
      expiresAt: this.now() + value.expires_in * 1000,
      interval: Math.max(5, Number(value.interval) || 5),
    };
  }

  async poll(clientId, device, signal) {
    let interval = device.interval;
    while (this.now() < device.expiresAt) {
      try { await this.wait(interval * 1000, undefined, { signal }); }
      catch { throw new AuthError('Вход отменён.', 'cancelled'); }
      if (this.now() >= device.expiresAt) break;
      const result = await this.form('/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: clientId, device_code: device.deviceCode,
      }, signal);
      if (result.ok) return this.validateToken(result.body);
      if (result.body.error === 'authorization_pending') continue;
      if (result.body.error === 'slow_down') { interval += 5; continue; }
      throw authFailure('Microsoft', result.status, result.body);
    }
    throw new AuthError('Код входа истёк. Получите новый код.', 'expired');
  }

  validateToken(body) {
    if (typeof body.access_token !== 'string' || !body.access_token) throw new AuthError('Microsoft не вернул токен входа.');
    return body;
  }

  async refresh(clientId, refreshToken, signal) {
    const result = await this.form('/token', {
      grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken, scope: SCOPE,
    }, signal);
    if (!result.ok) throw authFailure('Microsoft', result.status, result.body);
    return this.validateToken(result.body);
  }

  async json(url, payload, signal, stage) {
    const result = await this.request(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    }, signal, stage);
    if (!result.ok) throw authFailure(stage, result.status, result.body);
    return result.body;
  }

  async profile(accessToken, signal) {
    const result = await this.request(PROFILE_URL, {
      headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' },
    }, signal, 'Профиль');
    if (!result.ok) throw authFailure('Профиль', result.status, result.body);
    const profile = result.body;
    if (!/^[a-f0-9]{32}$/i.test(profile.id || '') || !/^[A-Za-z0-9_]{3,16}$/.test(profile.name || '')) {
      throw new AuthError('Minecraft вернул неполный профиль.');
    }
    return { id: profile.id, name: profile.name };
  }

  async minecraft(clientId, microsoftToken, signal, onPhase = () => {}) {
    onPhase('Проверяем профиль Xbox…');
    const xbox = await this.json('https://user.auth.xboxlive.com/user/authenticate', {
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: 'd=' + microsoftToken.access_token },
      RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT',
    }, signal, 'Xbox');
    if (!xbox.Token) throw new AuthError('Xbox не вернул токен входа.');
    const xsts = await this.json('https://xsts.auth.xboxlive.com/xsts/authorize', {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xbox.Token] },
      RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT',
    }, signal, 'Xbox');
    const userHash = xsts.DisplayClaims?.xui?.[0]?.uhs;
    if (!xsts.Token || !userHash) throw new AuthError('Xbox не вернул игровой профиль.');
    onPhase('Подключаем Minecraft…');
    const minecraft = await this.json('https://api.minecraftservices.com/authentication/login_with_xbox', {
      identityToken: 'XBL3.0 x=' + userHash + ';' + xsts.Token,
    }, signal, 'Minecraft');
    if (!minecraft.access_token || !Number.isFinite(minecraft.expires_in) || minecraft.expires_in <= 0) {
      throw new AuthError('Minecraft не вернул игровую сессию.');
    }
    onPhase('Получаем ник Minecraft…');
    const profile = await this.profile(minecraft.access_token, signal);
    return {
      clientId, profile,
      accessToken: minecraft.access_token,
      refreshToken: microsoftToken.refresh_token || '',
      expiresAt: this.now() + minecraft.expires_in * 1000,
    };
  }
}

module.exports = { MicrosoftAuth, AuthError, validClientId, authFailure };
