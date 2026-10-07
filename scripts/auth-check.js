const assert = require('node:assert/strict');
const { MicrosoftAuth, authFailure } = require('../main/microsoft-auth');
const { exitCode, diagnoseFailure } = require('../main/game-diagnostics');

const clientId = '11111111-2222-3333-4444-555555555555';
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

async function main() {
  let now = 1000;
  const waits = [];
  const requests = [];
  const replies = [
    response({ device_code: 'private-device', user_code: 'PUBLICCODE', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5 }),
    response({ error: 'authorization_pending' }, 400),
    response({ error: 'slow_down' }, 400),
    response({ access_token: 'private-ms', refresh_token: 'private-refresh' }),
    response({ Token: 'private-xbox' }),
    response({ Token: 'private-xsts', DisplayClaims: { xui: [{ uhs: 'user-hash' }] } }),
    response({ access_token: 'private-minecraft', expires_in: 86400 }),
    response({ id: 'a'.repeat(32), name: 'LicensedUser' }),
    response({ access_token: 'new-ms', refresh_token: 'new-refresh' }),
  ];
  const auth = new MicrosoftAuth({
    now: () => now,
    wait: async (ms) => { waits.push(ms); now += ms; },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      assert.ok(replies.length, 'Unexpected request');
      return replies.shift();
    },
  });
  const device = await auth.deviceCode(clientId);
  const token = await auth.poll(clientId, device);
  assert.deepEqual(waits, [5000, 5000, 10000], 'Polling must respect slow_down');
  const session = await auth.minecraft(clientId, token);
  assert.equal(session.profile.name, 'LicensedUser');
  assert.equal(session.refreshToken, 'private-refresh');
  assert.ok(session.expiresAt > now);
  assert.equal(JSON.parse(requests[4].options.body).Properties.RpsTicket, 'd=private-ms');
  assert.equal(JSON.parse(requests[6].options.body).identityToken, 'XBL3.0 x=user-hash;private-xsts');
  assert.equal(requests[7].options.headers.Authorization, 'Bearer private-minecraft');
  const refreshed = await auth.refresh(clientId, session.refreshToken);
  assert.equal(refreshed.refresh_token, 'new-refresh');
  assert.equal(new URLSearchParams(requests[8].options.body).get('grant_type'), 'refresh_token');
  await assert.rejects(() => auth.deviceCode(''), { code: 'client_config' });
  const unsafe = new MicrosoftAuth({ fetchImpl: async () => response({
    device_code: 'd', user_code: 'u', verification_uri: 'https://example.com/login', expires_in: 600,
  }) });
  await assert.rejects(() => unsafe.deviceCode(clientId), /неподдерживаемый адрес/);
  const cancelled = new MicrosoftAuth({ wait: async () => { throw new Error('aborted'); } });
  await assert.rejects(() => cancelled.poll(clientId, { ...device, expiresAt: Date.now() + 10000 }), { code: 'cancelled' });
  assert.equal(authFailure('Xbox', 401, { XErr: 2148916233 }).code, 'xbox_profile');
  assert.equal(authFailure('Minecraft', 403, { errorMessage: 'server-sensitive-detail' }).code, 'app_approval');
  assert.equal(authFailure('Профиль', 404).code, 'no_profile');
  assert.equal(authFailure('Microsoft', 400, { error: 'invalid_grant' }).code, 'reauth');
  assert.equal(exitCode(4294967295), -1);
  assert.match(diagnoseFailure('NeoForgeVersionCheck.getStatus()', 4294967295), /проверке обновлений/);
  process.stdout.write('OK: Microsoft device flow, slow_down, Xbox/XSTS/Minecraft chain, refresh and safe errors.\n');
}

main().catch((error) => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
