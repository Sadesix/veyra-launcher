// Сетевые сбои на чужих компьютерах: корневые сертификаты Windows, понятные причины вместо «fetch failed»
// и повтор получения каталога версий из окна создания сборки.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');
const { networkMessage, describeError, readableError, readableFetch } = require('../main/network');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const coded = (code, message = code) => Object.assign(new Error(message), { code });
const fetchFailed = cause => new TypeError('fetch failed', { cause });

async function rules() {
  const certificate = await readableFetch(async () => { throw fetchFailed(coded('SELF_SIGNED_CERT_IN_CHAIN', 'self-signed certificate in certificate chain')); })('https://launchermeta.mojang.com/mc/game/version_manifest.json').catch(error => error);
  assert.match(certificate.message, /launchermeta\.mojang\.com не прошло проверку сертификата \(SELF_SIGNED_CERT_IN_CHAIN\).*антивирус/);
  assert.equal(certificate.cause.message, 'fetch failed', 'исходная ошибка остаётся в cause');
  // Уже объяснённая ошибка не теряет адрес, когда её описывают снова или кладут в другую.
  assert.equal(describeError(certificate), certificate.message);
  assert.equal(readableError(certificate), certificate);
  assert.equal(describeError(new Error('', { cause: certificate })), certificate.message);

  assert.match(networkMessage(fetchFailed(Object.assign(coded('ENOTFOUND'), { hostname: 'meta.fabricmc.net' }))), /^Нет связи с meta\.fabricmc\.net \(ENOTFOUND\)/);
  assert.match(networkMessage(fetchFailed(coded('UND_ERR_CONNECT_TIMEOUT')), new URL('https://maven.neoforged.net/x')), /^Сервер maven\.neoforged\.net не ответил вовремя/);
  assert.match(networkMessage(fetchFailed(coded('ECONNREFUSED'))), /^Не удалось подключиться к серверу \(ECONNREFUSED\)/);
  assert.match(networkMessage(fetchFailed(coded('ECONNRESET')), 'https://libraries.minecraft.net/a.jar'), /^Соединение с libraries\.minecraft\.net оборвалось \(ECONNRESET\)/);

  // Загрузчик @xmcl собирает сбои в AggregateError без текста; адрес лежит в urls ошибки загрузки.
  const download = Object.assign(new Error('', { cause: coded('UNABLE_TO_GET_ISSUER_CERT_LOCALLY') }), { urls: ['https://resources.download.minecraft.net/ab/abcdef'] });
  const aggregate = new AggregateError([download]);
  assert.equal(aggregate.message, '');
  assert.match(describeError(aggregate), /^Соединение с resources\.download\.minecraft\.net не прошло проверку сертификата \(UNABLE_TO_GET_ISSUER_CERT_LOCALLY\)/);
  assert.match(readableError(aggregate).message, /resources\.download\.minecraft\.net/);
  assert.equal(describeError(new AggregateError([new Error('Контрольная сумма не совпала')])), 'Контрольная сумма не совпала');

  // Не сетевые ошибки, отмена и тайм-аут сигнала проходят как есть: на их имя смотрят обновления и аккаунт Veyra.
  const plain = new Error('HTTP 404');
  assert.equal(readableError(plain), plain);
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  assert.equal(await readableFetch(async () => { throw timeout; })('https://example.com').catch(error => error), timeout);
  const abort = new DOMException('This operation was aborted', 'AbortError');
  assert.equal(await readableFetch(async () => { throw abort; })('https://example.com').catch(error => error), abort);
  process.stdout.write('OK: сетевые причины читаются\n');
}

async function launcher() {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-network-'));
  const env = { ...process.env, VEYRA_TEST_DATA_DIR: dataDirectory, NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '' };
  // Как у обычного запуска из проводника: системные корни лаунчер подключает сам, а не через переменную Node.
  delete env.NODE_USE_SYSTEM_CA;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], cwd: path.join(__dirname, '..'), env, timeout: 120000 });
  try {
    const page = await app.firstWindow();
    await page.locator('#view-title').waitFor();

    const roots = await app.evaluate(() => {
      const tls = process.getBuiltinModule('node:tls');
      const trusted = new Set(tls.getCACertificates('default'));
      const system = tls.getCACertificates('system');
      return { system: system.length, missing: system.filter(item => !trusted.has(item)).length, env: process.env.NODE_USE_SYSTEM_CA || '' };
    });
    assert.equal(roots.env, '');
    assert.ok(roots.system > 0, 'В хранилище Windows нет корневых сертификатов');
    assert.equal(roots.missing, 0, 'Главный процесс не доверяет ' + roots.missing + ' корням Windows');

    // Сеть недоступна (прокси на закрытом порту): каталог версий не получен, причина видна.
    let notice = '';
    for (let i = 0; i < 60 && !notice; i++) {
      await sleep(500);
      notice = await page.evaluate(() => document.getElementById('notice').hidden ? '' : document.getElementById('notice-text').textContent);
    }
    assert.match(notice, /^Не удалось обновить версии: Не удалось подключиться к launchermeta\.mojang\.com \(ECONNREFUSED\)/, notice);
    assert.doesNotMatch(notice, /fetch failed/);
    const log = fs.readFileSync(path.join(dataDirectory, 'launcher.log'), 'utf8');
    assert.match(log, /Не удалось подключиться к launchermeta\.mojang\.com \(ECONNREFUSED\)/);
    assert.doesNotMatch(log, /fetch failed/);

    await page.locator('#create-top').click();
    await page.locator('#version-retry').waitFor();
    assert.match(await page.locator('#version-tiles .version-empty').textContent(), /^Каталог версий Minecraft не загрузился\. Не удалось подключиться к launchermeta\.mojang\.com \(ECONNREFUSED\).*Повторить$/);
    assert.equal(await page.locator('#create-submit').isDisabled(), true);
    const output = path.join(__dirname, '..', 'test-output');
    fs.mkdirSync(output, { recursive: true });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(output, 'create-offline.png') });

    // Сеть вернулась: «Повторить» получает каталог, и сборку можно создать.
    await app.evaluate(() => {
      const manifest = { latest: { release: '1.21.8', snapshot: '1.21.8' }, versions: [{ id: '1.21.8', type: 'release', url: 'https://piston-meta.mojang.com/v1/packages/x/1.21.8.json', time: '2025-07-17T12:00:00+00:00', releaseTime: '2025-07-17T12:00:00+00:00' }] };
      globalThis.fetch = async () => new Response(JSON.stringify(manifest), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    await page.locator('#version-retry').click();
    await page.locator('#version-tiles [data-version="1.21.8"]').waitFor();
    assert.equal(await page.locator('#version-retry').count(), 0);
    assert.equal(await page.locator('#create-submit').isDisabled(), false);
    assert.equal(await page.locator('#chosen-version').textContent(), '1.21.8');
    process.stdout.write('OK: без сети окно создания называет причину, «Повторить» возвращает каталог\n');

    // Защита папок не пускает лаунчер в «Документы»: создание объясняет, что разрешить, и не оставляет сборку.
    await app.evaluate(() => {
      const fsp = process.getBuiltinModule('node:fs/promises');
      const mkdir = fsp.mkdir;
      fsp.mkdir = async (target, options) => {
        if (/[\\/]instances[\\/]/.test(String(target))) throw Object.assign(new Error("EPERM: operation not permitted, mkdir '" + target + "'"), { code: 'EPERM' });
        return mkdir(target, options);
      };
    });
    await page.locator('#create-submit').click();
    const alert = page.locator('#create-dialog .form-alert');
    await alert.waitFor();
    await page.screenshot({ path: path.join(output, 'create-blocked.png') });
    assert.match(await alert.textContent(), /^Windows не разрешает лаунчеру создать папку сборки в .*instances \(EPERM\)\. .*«Контролируемый доступ к папкам»/);
    assert.equal(await page.locator('#create-dialog').evaluate(dialog => dialog.open), true);
    assert.equal((await page.evaluate(() => window.launcher.getState())).instances.length, 0);
    process.stdout.write('OK: запрет записи в «Документы» назван прямо\n');
  } finally {
    await app.close();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
}

(async () => {
  await rules();
  await launcher();
})().catch((error) => { process.stderr.write((error.stack || error) + '\n'); process.exitCode = 1; });
