const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn, spawnSync } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { _electron: electron } = require('playwright-core');

// Аккаунт Veyra в лаунчере целиком: настоящий сервер аккаунтов (api/ закрытого репозитория сайта на встроенном сервере PHP в копии сайта),
// поддельный authlib-injector с локального адреса (VEYRA_AUTHLIB_URL/VEYRA_AUTHLIB_SHA256) и Electron с отдельной папкой данных.
// Вкладки профиля с клавиатуры, регистрация и вход через окно профиля, русские ошибки, паузы после 429 отдельно у регистрации
// и у каждого ника, скин через veyra:// с CORS, модель и удаление, восстановление зашифрованной сессии, аргументы игры и сервера
// с агентом, запуск без сети и при 503 сайта, скрытие токена в журнале, второй клиент, удаление скина с подтверждением,
// «Вход через Veyra» у локального сервера (и выключенный белый список 26.3), ссылки сообщества, выход с отложенным отзывом токена
// работающей игры (через перезапуск лаунчера и без сети), устаревший вход и зеркало агента с бесконечным файлом.
// Java игры и сервера заменены процессами Node.
// PHP берётся из PHP_BINARY или PATH; без него проверка пишет SKIP. Временные папки удаляются (VEYRA_KEEP_SITE=1 оставляет).
const PHP = process.env.PHP_BINARY || 'php';
const workspace = path.join(__dirname, '..');
const output = path.join(workspace, 'test-output');
const config = require('../main/account-config.json');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const freePort = () => new Promise(resolve => { const server = net.createServer().listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
async function until(check, message, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}
function copySite(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (['downloads', 'data', 'latest.json'].includes(entry.name) || entry.name.endsWith('.zip')) continue;
    const source = path.join(from, entry.name), target = path.join(to, entry.name);
    if (entry.isDirectory()) { fs.mkdirSync(target, { recursive: true }); copySite(source, target); } else fs.copyFileSync(source, target);
  }
}
function offlineUuid(name) {
  const bytes = createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes.toString('hex');
}

// ── Скин 64×64: волосы, глаза, рубашка и штаны; второй слой прозрачный ──
function crc32(data) { let crc = ~0; for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xEDB88320 ^ crc >>> 1 : crc >>> 1; } return ~crc >>> 0; }
function chunk(type, data) {
  const head = Buffer.alloc(4), tail = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  head.writeUInt32BE(data.length); tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}
function skinPng({ skin, hair, eyes, shirt, pants, slim = false }) {
  const pixels = Buffer.alloc(64 * 64 * 4);
  const fill = (x0, y0, x1, y1, [r, g, b]) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) pixels.set([r, g, b, 255], (y * 64 + x) * 4); };
  fill(0, 0, 32, 16, skin); fill(8, 0, 16, 8, hair); fill(0, 8, 32, 10, hair); fill(24, 8, 32, 16, hair);
  fill(9, 12, 11, 13, [240, 225, 211]); fill(13, 12, 15, 13, [240, 225, 211]); fill(10, 12, 11, 13, eyes); fill(13, 12, 14, 13, eyes);
  fill(11, 14, 13, 15, [141, 90, 77]);
  fill(16, 16, 40, 32, shirt); fill(40, 16, 56, 32, skin); fill(40, 20, 56, 24, shirt); fill(32, 48, 48, 64, skin); fill(32, 52, 48, 56, shirt);
  fill(0, 16, 16, 32, pants); fill(16, 48, 32, 64, pants); fill(0, 28, 16, 32, [60, 52, 62]); fill(16, 60, 32, 64, [60, 52, 62]);
  // Тонкие руки шириной 3 пикселя: лишние столбцы развёртки рук пусты.
  const clear = (x0, y0, x1, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) pixels.fill(0, (y * 64 + x) * 4, (y * 64 + x) * 4 + 4); };
  if (slim) { clear(50, 16, 52, 20); clear(54, 16, 56, 32); clear(42, 48, 44, 52); clear(46, 48, 48, 64); }
  const rows = [];
  for (let y = 0; y < 64; y++) rows.push(Buffer.concat([Buffer.from([0]), pixels.subarray(y * 256, y * 256 + 256)]));
  const header = Buffer.alloc(13); header.writeUInt32BE(64, 0); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

async function main() {
  // Сервер аккаунтов — часть закрытого репозитория сайта (папка site рядом с лаунчером); в открытой копии его нет.
  if (!fs.existsSync(path.join(workspace, 'site', 'api', 'index.php'))) { process.stdout.write('SKIP: нет папки site с сервером аккаунтов (закрытый репозиторий Sadesix/veyra-site) — аккаунт Veyra в лаунчере не проверен.\n'); return; }
  const probe = spawnSync(PHP, ['-v'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) { process.stdout.write('SKIP: PHP не найден — аккаунт Veyra в лаунчере не проверен. Укажите путь к php.exe в переменной PHP_BINARY.\n'); return; }
  const phpVersion = probe.stdout.split('\n')[0].split(' ').slice(0, 2).join(' ');
  const env = { ...process.env };
  const sslConf = path.join(path.dirname(PHP), 'extras', 'ssl', 'openssl.cnf');
  if (!env.OPENSSL_CONF && fs.existsSync(sslConf)) env.OPENSSL_CONF = sslConf;
  delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(output, { recursive: true });

  // ── Копия сайта с сервером аккаунтов ──
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-account-site-'));
  copySite(path.join(workspace, 'site'), root);
  fs.writeFileSync(path.join(root, 'inc', 'config.php'), "<?php\nreturn array('key_sha256' => '" + sha256(randomBytes(16)) + "', 'site_url' => 'https://veyra.example', 'timezone' => 'Europe/Moscow');\n");
  const sitePort = await freePort(), ROOT = 'http://127.0.0.1:' + sitePort + '/api/index.php/';
  let phpLog = '';
  const php = spawn(PHP, ['-d', 'log_errors=1', '-S', '127.0.0.1:' + sitePort, '-t', root], { cwd: root, env, windowsHide: true });
  php.stdout.on('data', data => { phpLog += data; }); php.stderr.on('data', data => { phpLog += data; });
  // ── Поддельный authlib-injector на локальном адресе ──
  const jar = Buffer.concat([Buffer.from('PK\x03\x04 fake authlib-injector for veyra-account-check '), randomBytes(256)]), jarHash = sha256(jar);
  let jarRequests = 0;
  const jarServer = http.createServer((request, response) => {
    response.on('error', () => {});
    // Неисправное зеркало: файл без конца или с огромной заявленной длиной.
    if (request.url === '/endless.jar') {
      response.writeHead(200, { 'Content-Type': 'application/java-archive' });
      const block = Buffer.alloc(64 * 1024, 7), pump = () => { while (!response.destroyed && response.write(block)); if (!response.destroyed) response.once('drain', pump); };
      pump(); return;
    }
    if (request.url === '/declared.jar') { response.writeHead(200, { 'Content-Type': 'application/java-archive', 'Content-Length': 400 * 1024 * 1024 }); response.write(Buffer.alloc(1024)); return; }
    if (request.url !== '/authlib-injector.jar') { response.writeHead(404); response.end(); return; }
    jarRequests++; response.writeHead(200, { 'Content-Type': 'application/java-archive', 'Content-Length': jar.length }); response.end(jar);
  });
  await new Promise(resolve => jarServer.listen(0, '127.0.0.1', resolve));
  const jarUrl = 'http://127.0.0.1:' + jarServer.address().port + '/authlib-injector.jar';

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-account-data-'));
  const done = [];
  let app = null;
  // Игры-подмены переживают лаунчер, как настоящие: после сбоя проверки они завершаются в finally.
  const gamePids = new Set();
  try {
    for (let attempt = 0; ; attempt++) {
      try { await fetch(ROOT); break; } catch (error) { if (attempt > 80) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    // ── Зеркало authlib-injector отдаёт бесконечный файл: загрузка обрывается на лету, ответ не копится в памяти ──
    {
      const { ensureAuthlib } = require('../main/authlib-injector');
      const saved = { url: process.env.VEYRA_AUTHLIB_URL, sum: process.env.VEYRA_AUTHLIB_SHA256 }, scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-authlib-'));
      try {
        for (const route of ['/endless.jar', '/declared.jar']) {
          process.env.VEYRA_AUTHLIB_URL = 'http://127.0.0.1:' + jarServer.address().port + route; process.env.VEYRA_AUTHLIB_SHA256 = jarHash;
          const memory = () => { const usage = process.memoryUsage(); return usage.arrayBuffers + usage.external; };
          const before = memory(), started = Date.now();
          await assert.rejects(ensureAuthlib(scratch, { timeout: 20000 }), /файл слишком большой/, route);
          assert.ok(Date.now() - started < 10000, route + ': the oversized download must stop early, not at the timeout');
          assert.ok(memory() - before < 64 * 1024 * 1024, route + ': the oversized body must not be buffered (' + Math.round((memory() - before) / 1048576) + ' MB)');
        }
        assert.equal(fs.existsSync(path.join(scratch, 'compat', 'authlib-injector-1.2.8.jar')), false);
      } finally {
        for (const [key, value] of [['VEYRA_AUTHLIB_URL', saved.url], ['VEYRA_AUTHLIB_SHA256', saved.sum]]) if (value === undefined) delete process.env[key]; else process.env[key] = value;
        fs.rmSync(scratch, { recursive: true, force: true });
      }
      done.push('зеркало агента с бесконечным файлом или огромной длиной обрывается на лету');
    }
    const call = async (route, { body, token, ip = '198.51.100.20' } = {}) => {
      const headers = { 'X-Real-IP': ip };
      if (token) headers.Authorization = 'Bearer ' + token;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(new URL(route, ROOT), { method: body !== undefined ? 'POST' : 'GET', headers, body: body !== undefined ? JSON.stringify(body) : undefined });
      const text = await response.text();
      return { status: response.status, text, data: /json/.test(response.headers.get('content-type') || '') && text ? JSON.parse(text) : null };
    };
    const metadata = await call('');
    assert.equal(metadata.status, 200, phpLog);
    assert.equal((await call('veyra/register', { body: { username: 'Taken_Nick', password: 'taken-password' }, ip: '198.51.100.7' })).status, 200);
    assert.equal((await call('veyra/register', { body: { username: 'Locked_One', password: 'locked-password' }, ip: '198.51.100.8' })).status, 200);

    // ── Сборка и сервер для запуска ──
    const game = path.join(data, 'instances', 'veyra-check'), versionRoot = path.join(game, 'versions', '26.3');
    fs.mkdirSync(versionRoot, { recursive: true });
    const version = {
      id: '26.3', type: 'release', mainClass: 'net.minecraft.client.main.Main', assets: '26.3',
      javaVersion: { majorVersion: 25, component: 'java-runtime-epsilon' }, libraries: [],
      downloads: { client: {}, server: { url: 'https://fixture.invalid/server.jar', sha1: createHash('sha1').update('fixture server').digest('hex') } },
      arguments: { jvm: ['-classpath', '${classpath}'], game: ['--username', '${auth_player_name}', '--accessToken', '${auth_access_token}', '--uuid', '${auth_uuid}', '--userType', '${user_type}', '--gameDir', '${game_directory}'] },
    };
    fs.writeFileSync(path.join(versionRoot, '26.3.json'), JSON.stringify(version));
    fs.writeFileSync(path.join(versionRoot, '26.3.jar'), 'fixture');
    fs.writeFileSync(path.join(game, '.veyra-instance-ready.json'), JSON.stringify({ id: 'veyra-check', versionId: '26.3' }));
    fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
      playerName: 'LocalNick', memoryGb: 1, selectedInstanceId: 'veyra-check',
      javaPath: path.join(process.env.VEYRA_JAVA_HOME || path.join(process.env.APPDATA, 'veyra-launcher', 'runtimes', 'java-runtime-epsilon'), 'bin', 'java.exe'),
      instances: [{ id: 'veyra-check', name: 'Veyra World', directory: game, versionId: '26.3', minecraftVersion: '26.3', loader: 'vanilla', memoryGb: 1 }],
    }));
    fs.writeFileSync(path.join(data, 'version-manifest.json'), JSON.stringify({ versions: [{ id: '26.3', type: 'release', url: 'https://fixture.invalid/version.json' }] }));
    const skinFiles = { first: path.join(data, 'skin-first.png'), second: path.join(data, 'skin-second.png') };
    fs.writeFileSync(skinFiles.first, skinPng({ skin: [232, 196, 168], hair: [93, 81, 98], eyes: [102, 108, 142], shirt: [167, 172, 201], pants: [74, 64, 77] }));
    fs.writeFileSync(skinFiles.second, skinPng({ skin: [217, 169, 140], hair: [141, 90, 77], eyes: [88, 118, 91], shirt: [142, 174, 145], pants: [60, 52, 62], slim: true }));
    const faceColor = { first: [232, 196, 168], second: [217, 169, 140] };

    // Как другие проверки: путь к собранному «Veyra Launcher.exe» первым аргументом проверяет сборку, без него — исходники.
    const packaged = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
    const options = halloween => ({ executablePath: packaged, args: packaged ? [] : ['.'], cwd: workspace, timeout: 120000,
      env: { ...env, VEYRA_TEST_DATA_DIR: data, VEYRA_ACCOUNT_API: ROOT, VEYRA_AUTHLIB_URL: jarUrl, VEYRA_AUTHLIB_SHA256: jarHash, VEYRA_HALLOWEEN: halloween ? 'season' : 'off', VEYRA_MICROSOFT_CLIENT_ID: '' } });
    const problems = [];
    // Скины, которых нарочно нет: их 404 в консоли ожидаем.
    const missingSkins = new Set(['0'.repeat(64)]);
    // Подмены в главном процессе: процессы Java, адреса сборки сервера, диалог выбора файла и открытие ссылок.
    const open = async (halloween = false) => {
      app = await electron.launch(options(halloween));
      const page = await app.firstWindow();
      page.on('pageerror', error => problems.push('pageerror: ' + error.message));
      // Ошибки консоли, кроме нарочно отсутствующих скинов.
      page.on('console', message => { if ((message.type() === 'error' || /CORS|Access-Control|tainted/i.test(message.text())) && ![...missingSkins].some(hash => String(message.location()?.url).includes(hash))) problems.push('console: ' + message.text() + ' ' + message.location()?.url); });
      await page.locator('#main-action').waitFor();
      await app.evaluate(({ app, dialog, shell }, { fixtureVersion, root }) => {
        const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json'), childProcess = require('node:child_process'), originalSpawn = childProcess.spawn;
        const realFetch = globalThis.__realFetch ||= globalThis.fetch;
        globalThis.__offline = false; globalThis.__validateStatus = 0; globalThis.__gameArgs = []; globalThis.__serverArgs = []; globalThis.__opened = [];
        globalThis.fetch = (url, init) => {
          const value = String(url);
          if (globalThis.__offline && value.startsWith(root)) return Promise.reject(new TypeError('fetch failed'));
          // Хостинг сайта лежит: проверка токена отвечает страницей ошибки 5xx.
          if (globalThis.__validateStatus && value === root + 'authserver/validate') return Promise.resolve(new Response('<html><body>Service Unavailable</body></html>', { status: globalThis.__validateStatus, headers: { 'Content-Type': 'text/html' } }));
          if (value.includes('fixture.invalid/version')) return Promise.resolve(new Response(JSON.stringify(fixtureVersion)));
          if (value === 'https://fixture.invalid/server.jar') return Promise.resolve(new Response('fixture server'));
          return realFetch(url, init);
        };
        const node = (script, args, spawnOptions) => originalSpawn(process.execPath, ['-e', script, '--', ...args], { ...spawnOptions, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
        childProcess.spawn = (command, args, spawnOptions) => {
          if (args.includes('net.minecraft.client.main.Main')) { globalThis.__gameArgs.push(args); return node("console.log('game ' + process.argv.slice(1).join(' ')); setInterval(() => {}, 1000);", args.filter(arg => arg.startsWith('-Dveyra.client=') || ['--accessToken', '--username'].includes(arg) || /^[0-9a-f]{64}$/.test(arg)), spawnOptions); }
          if (args.includes('server.jar')) {
            globalThis.__serverArgs.push(args);
            return node("const fs=require('fs'),net=require('net'),port=Number(/server-port=(\\d+)/.exec(fs.readFileSync('server.properties','utf8'))[1]);const s=net.createServer();s.listen(port,'0.0.0.0',()=>console.log('Done (0.1s)! For help, type \"help\"'));process.stdin.on('data',b=>{if(String(b).includes('stop'))s.close(()=>process.exit(0));});", [], spawnOptions);
          }
          return originalSpawn(command, args, spawnOptions);
        };
        dialog.showOpenDialog = async (_window, settings) => { globalThis.__dialog = settings; return globalThis.__skinFile ? { canceled: false, filePaths: [globalThis.__skinFile] } : { canceled: true, filePaths: [] }; };
        shell.openExternal = async url => { globalThis.__opened.push(url); };
      }, { fixtureVersion: version, root: ROOT });
      await page.evaluate(async () => { window.__state = await window.launcher.getState(); window.launcher.onEvent(event => { if (event.type === 'state') window.__state = event.state; }); });
      return page;
    };
    const quit = async () => {
      const child = app.process(), exited = new Promise(resolve => child.once('exit', resolve));
      await app.evaluate(({ app }) => { setTimeout(() => app.quit(), 50); }).catch(() => {});
      await Promise.race([exited, new Promise((resolve, reject) => setTimeout(() => reject(new Error('Launcher did not quit')), 20000))]);
      app = null;
    };
    const state = page => page.evaluate(() => window.launcher.getState());
    const vault = () => app.evaluate(({ safeStorage }, file) => { const fs = process.getBuiltinModule('node:fs'); return fs.existsSync(file) ? JSON.parse(safeStorage.decryptString(fs.readFileSync(file))) : null; }, path.join(data, 'veyra-session.bin'));
    const shot = async (page, name) => { await page.waitForTimeout(450); await page.screenshot({ path: path.join(output, name) }); };
    // Холст головы: пиксель лица читается — значит, скин пришёл с CORS и холст не «чужой».
    const headPixel = (page, selector) => page.evaluate(selector => {
      const canvas = document.querySelector(selector);
      try { return [...canvas.getContext('2d').getImageData(4, 5, 1, 1).data]; } catch (error) { return error.name; }
    }, selector);
    // Вся голова 8×8 строкой — для сравнения с эталоном.
    const headData = (page, selector) => page.evaluate(selector => { try { return [...document.querySelector(selector).getContext('2d').getImageData(0, 0, 8, 8).data].join(); } catch (error) { return error.name; } }, selector);

    let page = await open();

    // ── Вкладки профиля: локальный ник по умолчанию, вкладка Veyra видна, Microsoft скрыт ──
    await page.locator('#profile-top').click();
    await page.locator('#profile-name-input').waitFor();
    assert.equal(await page.locator('[data-account-mode="local"]').isVisible(), true);
    assert.equal(await page.locator('[data-account-mode="veyra"]').isVisible(), true);
    assert.equal(await page.locator('[data-account-mode="microsoft"]').isVisible(), false);
    assert.equal(await page.locator('[data-account-mode="local"]').getAttribute('aria-selected'), 'true');
    await shot(page, 'profile-local-tab.png');
    // Вкладки по шаблону ARIA: панели связаны с вкладками, Tab попадает на выбранную, стрелки и Home/End переходят по видимым.
    for (const mode of ['local', 'veyra', 'microsoft']) {
      assert.equal(await page.locator('#profile-tab-' + mode).getAttribute('aria-controls'), 'profile-' + mode + '-panel');
      assert.equal(await page.locator('#profile-' + mode + '-panel').getAttribute('role'), 'tabpanel');
      assert.equal(await page.locator('#profile-' + mode + '-panel').getAttribute('aria-labelledby'), 'profile-tab-' + mode);
    }
    assert.deepEqual(await page.locator('#account-tabs [role="tab"]').evaluateAll(tabs => tabs.map(tab => tab.tabIndex)), [0, -1, -1]);
    const focused = () => page.evaluate(() => document.activeElement.id);
    await page.locator('#profile-tab-local').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await focused(), 'profile-tab-veyra');
    assert.equal(await page.locator('#profile-tab-veyra').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#profile-veyra-panel').isVisible(), true);
    assert.deepEqual(await page.locator('#account-tabs [role="tab"]').evaluateAll(tabs => tabs.map(tab => tab.tabIndex)), [-1, 0, -1]);
    await page.keyboard.press('ArrowRight');
    assert.equal(await focused(), 'profile-tab-local', 'The hidden Microsoft tab is skipped');
    assert.equal(await page.locator('#profile-local-panel').isVisible(), true);
    await page.keyboard.press('End');
    assert.equal(await focused(), 'profile-tab-veyra');
    await page.keyboard.press('Home');
    assert.equal(await focused(), 'profile-tab-local');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await focused(), 'profile-tab-veyra');
    await page.keyboard.press('Home');
    await page.locator('[data-account-mode="veyra"]').click();
    await page.locator('#veyra-login-name').waitFor();
    assert.equal(await page.locator('#profile-name-input').isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'veyra-login-name');
    await shot(page, 'profile-veyra-login.png');

    // ── Неверный пароль ──
    await page.locator('#veyra-login-name').fill('Taken_Nick');
    await page.locator('#veyra-login-password').fill('wrong-password');
    await page.locator('#veyra-login-submit').click();
    await page.locator('#veyra-error').waitFor();
    assert.equal(await page.locator('#veyra-error').textContent(), 'Неверный ник или пароль');
    assert.equal((await state(page)).account.mode, 'local');

    // ── Регистрация: живые правила ника и пароля, занятый ник ──
    await page.locator('#veyra-login-form [data-veyra-form="register"]').click();
    await page.locator('#veyra-register-name').waitFor();
    assert.equal(await page.locator('#veyra-error').isVisible(), false, 'Switching forms clears the previous error');
    await page.locator('#veyra-register-name').fill('ab');
    assert.match(await page.locator('#veyra-name-rule').textContent(), /Ещё 1/);
    assert.equal(await page.locator('#veyra-name-rule').evaluate(node => node.classList.contains('is-invalid')), true);
    await page.locator('#veyra-register-name').fill('Ник');
    assert.match(await page.locator('#veyra-name-rule').textContent(), /латинские/);
    await page.locator('#veyra-register-name').fill('taken_nick');
    assert.equal(await page.locator('#veyra-name-rule').evaluate(node => node.classList.contains('is-valid')), true);
    assert.equal(await page.locator('#veyra-name-count').textContent(), '10 / 16');
    await page.locator('#veyra-register-password').fill('short');
    assert.match(await page.locator('#veyra-password-rule').textContent(), /Ещё 1/);
    await page.locator('#veyra-register-password').fill('veyra-secret-1');
    await page.locator('#veyra-register-confirm').fill('veyra-secret-2');
    assert.equal(await page.locator('#veyra-password-rule').textContent(), 'Пароли не совпадают');
    await page.locator('#veyra-register-submit').click();
    assert.match(await page.locator('#veyra-register-form .field-error').first().textContent(), /Пароли не совпадают/);
    await page.locator('#veyra-register-confirm').fill('veyra-secret-1');
    assert.equal(await page.locator('#veyra-password-rule').textContent(), 'Пароли совпадают');
    await shot(page, 'profile-veyra-register.png');
    await page.locator('#veyra-register-submit').click();
    await until(async () => /уже занят/.test(await page.locator('#veyra-error').textContent()), 'Name taken message did not appear');
    assert.equal(await page.locator('#veyra-error').textContent(), 'Ник taken_nick уже занят — выберите другой');
    done.push('вкладки, неверный пароль, правила ника и пароля, занятый ник');

    // ── Регистрация → режим Veyra, модель со скином по умолчанию ──
    await page.locator('#veyra-register-name').fill('Veyra_Tester');
    await page.locator('#veyra-register-submit').click();
    await page.waitForFunction(() => document.getElementById('profile-chip-name').textContent === 'Veyra_Tester');
    assert.equal(await page.locator('#profile-chip-mode').textContent(), 'Аккаунт Veyra');
    let current = await state(page);
    assert.equal(current.account.mode, 'veyra');
    assert.deepEqual(current.account.veyra, { id: offlineUuid('Veyra_Tester'), name: 'Veyra_Tester', skin: null });
    assert.equal(await page.locator('#veyra-signed').isVisible(), true);
    assert.equal(await page.locator('#veyra-badge').isVisible(), true);
    assert.equal(await page.locator('#veyra-play').isVisible(), false);
    assert.equal(await page.locator('[data-account-mode="veyra"]').evaluate(node => node.classList.contains('is-current')), true);
    await until(() => page.locator('#veyra-stage [data-skin-view]').evaluate(node => node.dataset.state === 'ready').catch(() => false), 'The default skin did not load into the 3D view');
    assert.equal(await page.locator('#veyra-stage-label').textContent(), 'Скин Veyra — его видят все в игре', 'Without a skin the caption says that everyone sees the default Veyra skin in the game');
    assert.equal(await page.locator('#profile-active-mode').textContent(), 'Аккаунт Veyra · в игре скин Veyra по умолчанию');
    // Голова без своего скина — лицо скина Veyra по умолчанию, как модель рядом, аватар в кабинете и игрок в игре.
    const defaultHead = await page.evaluate(async () => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8; await window.VeyraSkin.drawHead(canvas, null, false); return [...canvas.getContext('2d').getImageData(0, 0, 8, 8).data].join(); });
    const nickHead = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8; window.veyraHead(canvas, 'Veyra_Tester'); return [...canvas.getContext('2d').getImageData(0, 0, 8, 8).data].join(); });
    assert.notEqual(defaultHead, nickHead);
    await until(async () => await headData(page, '#profile-top canvas[data-head]') === defaultHead, 'Without a skin the chip head is not the default Veyra face');
    assert.equal(await headData(page, '.profile-avatar canvas[data-head]'), defaultHead, 'The profile head matches the 3D model next to it');
    assert.equal(await headData(page, '#profile-rail canvas[data-head]'), defaultHead);
    await shot(page, 'profile-veyra-noskin.png');
    assert.equal(await page.locator('#veyra-remove').isDisabled(), true);
    assert.equal(await page.locator('[data-skin-model="slim"]').isDisabled(), true);
    assert.ok(!JSON.stringify(current).match(/[0-9a-f]{64}/), 'The public state carries no tokens or texture hashes yet');
    done.push('регистрация через окно профиля, выбор аккаунта для игры');

    // ── Скин: выбор файла, veyra://skin с CORS, голова из скина, модель, удаление ──
    await app.evaluate((_context, file) => { globalThis.__skinFile = file; }, skinFiles.first);
    await page.locator('#veyra-upload').click();
    await until(async () => (await state(page)).account.veyra.skin, 'The uploaded skin did not reach the state');
    current = await state(page);
    const firstHash = sha256(fs.readFileSync(skinFiles.first));
    assert.equal(current.account.veyra.skin.url, 'veyra://skin/' + firstHash, 'A clean 8-bit PNG is stored unchanged');
    assert.equal(current.account.veyra.skin.slim, false, 'A skin with wide arms is classic');
    const dialogSettings = await app.evaluate(() => globalThis.__dialog);
    assert.deepEqual(dialogSettings.filters, [{ name: 'Скин Minecraft', extensions: ['png'] }]);
    assert.ok(fs.existsSync(path.join(data, 'veyra-skins', firstHash + '.png')), 'The skin is cached locally');
    await until(() => page.locator('#veyra-stage [data-skin-view]').evaluate(node => node.dataset.state === 'ready' && node.querySelectorAll('canvas[data-face]').length > 20).catch(() => false), 'The uploaded skin did not render');
    const loaded = await page.evaluate(url => new Promise(resolve => { const image = new Image(); image.crossOrigin = 'anonymous'; image.onload = () => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64; const context = canvas.getContext('2d'); context.drawImage(image, 0, 0); try { resolve([...context.getImageData(12, 12, 1, 1).data]); } catch (error) { resolve(error.name); } }; image.onerror = () => resolve('error'); image.src = url; }), current.account.veyra.skin.url);
    assert.deepEqual(loaded, [...faceColor.first, 255], 'veyra://skin answers with CORS: pixels are readable');
    assert.equal(await page.evaluate(() => new Promise(resolve => { const image = new Image(); image.onload = () => resolve('loaded'); image.onerror = () => resolve('missing'); image.src = 'veyra://skin/' + '0'.repeat(64); })), 'missing', 'Unknown skins are not served');
    await until(async () => JSON.stringify(await headPixel(page, '#profile-top canvas[data-head]')) === JSON.stringify([...faceColor.first, 255]), 'The profile chip head is not drawn from the skin');
    assert.deepEqual(await headPixel(page, '.profile-avatar canvas[data-head]'), [...faceColor.first, 255]);
    let me = await call('veyra/me', { token: (await vault()).accessToken });
    assert.deepEqual(me.data.skin, { hash: firstHash, url: ROOT + 'textures/' + firstHash, slim: false });
    await page.locator('[data-skin-model="slim"]').click();
    await until(async () => (await state(page)).account.veyra.skin?.slim === true, 'Slim model was not applied');
    assert.equal(await page.locator('[data-skin-model="slim"]').getAttribute('aria-pressed'), 'true');
    me = await call('veyra/me', { token: (await vault()).accessToken });
    assert.equal(me.data.skin.slim, true);
    await until(() => page.locator('#veyra-stage [data-part="rightArm"] [data-layer="base"] [data-face="front"]').evaluate(node => node.style.width === '30px').catch(() => false), 'The 3D view did not switch to slim arms');
    assert.equal(await page.locator('#veyra-stage-label').textContent(), 'Тонкая модель');
    await shot(page, 'profile-veyra-skin.png');
    // Удаление — только после подтверждения: Escape закрывает подтверждение, а профиль под ним остаётся открытым.
    await page.locator('#veyra-remove').click();
    await until(() => page.locator('#veyra-remove-dialog').evaluate(node => node.open), 'The removal was not confirmed first');
    assert.equal(await focused(), 'veyra-remove-keep', 'Focus starts on the safe choice');
    assert.match(await page.locator('#veyra-remove-dialog .modal-intro').textContent(), /скин Veyra по умолчанию.*Файл скина с сайта удалится/);
    assert.equal((await call('veyra/me', { token: (await vault()).accessToken })).data.skin.hash, firstHash, 'Nothing is removed before the confirmation');
    await shot(page, 'profile-veyra-remove-confirm.png');
    await page.keyboard.press('Escape');
    await until(() => page.locator('#veyra-remove-dialog').evaluate(node => !node.open), 'Escape did not close the confirmation');
    assert.equal(await page.locator('#profile-dialog').evaluate(node => node.open && !node.classList.contains('is-closing')), true, 'Escape closes only the top dialog');
    assert.equal((await state(page)).account.veyra.skin?.url, 'veyra://skin/' + firstHash);
    assert.equal((await call('veyra/me', { token: (await vault()).accessToken })).data.skin.hash, firstHash, '«Оставить» keeps the skin');
    await page.locator('#veyra-remove').click();
    await until(() => page.locator('#veyra-remove-dialog').evaluate(node => node.open), 'The confirmation did not open again');
    await page.locator('#confirm-veyra-remove').click();
    await until(async () => (await state(page)).account.veyra.skin === null, 'The skin was not removed');
    assert.equal((await call('veyra/me', { token: (await vault()).accessToken })).data.skin, null);
    await until(async () => await headData(page, '#profile-top canvas[data-head]') === defaultHead, 'Without a skin the head shows the default Veyra face again');
    assert.equal(await headData(page, '.profile-avatar canvas[data-head]'), defaultHead);
    await until(async () => await focused() === 'veyra-upload', 'After the removal focus did not move to the upload button');
    assert.equal(await page.locator('#profile-dialog').evaluate(node => node.open), true);
    await app.evaluate((_context, file) => { globalThis.__skinFile = file; }, skinFiles.second);
    await page.locator('#veyra-upload').click();
    const secondHash = sha256(fs.readFileSync(skinFiles.second));
    await until(async () => (await state(page)).account.veyra.skin?.url === 'veyra://skin/' + secondHash, 'The second skin did not arrive');
    assert.equal((await state(page)).account.veyra.skin.slim, true, 'The slim model is detected from the picture');
    assert.deepEqual(fs.readdirSync(path.join(data, 'veyra-skins')), [secondHash + '.png'], 'Old cached skins are removed');
    await app.evaluate(() => { globalThis.__skinFile = ''; });
    await page.locator('#veyra-upload').click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#veyra-error').isVisible(), false, 'A cancelled file dialog is not an error');
    done.push('скин: загрузка файлом, veyra://skin с CORS, голова из скина, тонкая модель, удаление с подтверждением (Escape закрывает только его) и замена; без скина голова — лицо скина Veyra по умолчанию');

    // ── Зашифрованная сессия и восстановление после перезапуска (с Хеллоуином) ──
    const session = await vault();
    assert.match(session.accessToken, /^[0-9a-f]{64}$/);
    const tokens = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'data', 'account-tokens.php'), 'utf8').slice('<?php exit; ?>\n'.length)));
    assert.ok(tokens.includes(sha256(session.accessToken)), 'The vault holds the live server token');
    const encrypted = fs.readFileSync(path.join(data, 'veyra-session.bin'));
    for (const secret of [session.accessToken, session.clientToken, 'Veyra_Tester']) assert.ok(!encrypted.includes(Buffer.from(secret)), 'The vault file must not contain ' + secret.slice(0, 6) + '… in plain text');
    assert.ok(!JSON.stringify(await state(page)).includes(session.accessToken));
    await until(() => fs.existsSync(path.join(data, 'compat', 'authlib-injector-1.2.8.jar')), 'authlib-injector was not prepared after sign-in');
    assert.equal(jarRequests, 1);
    await page.keyboard.press('Escape');
    await quit();
    page = await open(true);
    current = await state(page);
    assert.equal(current.account.mode, 'veyra');
    assert.equal(current.account.name, 'Veyra_Tester');
    assert.deepEqual(current.account.veyra.skin, { url: 'veyra://skin/' + secondHash, slim: true });
    const spooky = await page.evaluate(() => Boolean(window.veyraHalloween?.inSeason()));
    if (spooky) await page.waitForFunction(() => document.documentElement.classList.contains('is-halloween'));
    await page.locator('#profile-rail').click();
    await page.locator('#veyra-signed').waitFor();
    await until(() => page.locator('#veyra-stage [data-skin-view]').evaluate(node => node.dataset.state === 'ready').catch(() => false), 'The restored skin did not render');
    await until(async () => JSON.stringify(await headPixel(page, '.profile-avatar canvas[data-head]')) === JSON.stringify([...faceColor.second, 255]), 'The restored head is not drawn from the skin');
    await shot(page, 'profile-veyra-halloween.png');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 650));
    await page.waitForTimeout(500);
    const box = await page.locator('#profile-dialog').boundingBox(), viewport = await page.evaluate(() => [innerWidth, innerHeight]);
    assert.ok(box.y >= 0 && box.y + box.height <= viewport[1] && box.x >= 0 && box.x + box.width <= viewport[0], 'The profile fits the minimum window');
    assert.equal(await page.locator('#profile-dialog').evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await shot(page, 'profile-veyra-small.png');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('profile-dialog').open);
    await shot(page, 'launcher-veyra-small.png');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1460, 900));
    done.push('сессия в зашифрованном файле без токена в открытом виде, восстановление после перезапуска, Хеллоуин и окно 980×650');

    // ── Запуск игры с агентом, проверка токена, скрытие в журнале ──
    const agentPath = path.join(data, 'compat', 'authlib-injector-1.2.8.jar');
    const first = await page.evaluate(() => window.launcher.launchInstance('veyra-check'));
    let args = (await app.evaluate(() => globalThis.__gameArgs)).at(-1);
    const value = name => args[args.indexOf(name) + 1];
    assert.equal(args.find(arg => arg.startsWith('-javaagent:') && arg.includes('authlib')), '-javaagent:' + agentPath + '=' + ROOT);
    const prefetched = args.find(arg => arg.startsWith('-Dauthlibinjector.yggdrasil.prefetched='));
    assert.deepEqual(JSON.parse(Buffer.from(prefetched.split('=')[1], 'base64').toString('utf8')), metadata.data, 'prefetched is the server description');
    assert.ok(args.includes('-Dauthlibinjector.noShowServerName'));
    assert.ok(args.indexOf('-javaagent:' + agentPath + '=' + ROOT) < args.indexOf('net.minecraft.client.main.Main'), 'The agent is a JVM argument');
    assert.equal(value('--accessToken'), session.accessToken);
    assert.equal(value('--uuid'), offlineUuid('Veyra_Tester'));
    assert.equal(value('--username'), 'Veyra_Tester');
    assert.equal(value('--userType'), 'mojang');
    assert.equal(sha256(fs.readFileSync(agentPath)), jarHash);
    assert.equal(jarRequests, 1, 'A verified cached agent is not downloaded again');
    const marker = JSON.parse(Buffer.from(args.find(arg => arg.startsWith('-Dveyra.client=')).slice(15), 'base64url').toString('utf8'));
    assert.deepEqual([marker.name, marker.profile], ['Veyra_Tester', offlineUuid('Veyra_Tester')], 'The client marker carries the Veyra profile');
    assert.equal(marker.veyra, sha256(session.accessToken), 'The marker carries the token fingerprint, not the token');
    assert.ok(!args.find(arg => arg.startsWith('-Dveyra.client=')).includes(session.accessToken));
    assert.equal(first.name, 'Veyra_Tester');
    gamePids.add(first.pid);
    await until(async () => (await page.evaluate(() => window.launcher.getLogs())).includes('game '), 'The game output did not reach the log');
    let logs = await page.evaluate(() => window.launcher.getLogs());
    assert.ok(!logs.includes(session.accessToken), 'The Veyra token must not reach the log');
    assert.match(logs, /--accessToken \[(?:скрыто|защищено)\]/);
    // Второй клиент с тем же аккаунтом Veyra не запускается, и «+ Клиент» это показывает заранее.
    assert.equal((await state(page)).account.veyraPlaying, true);
    await until(() => page.locator('#hero-multi').isDisabled(), '«+ Клиент» stays enabled while the Veyra account plays');
    assert.match(await page.locator('#hero-multi').getAttribute('data-tip-lore'), /^Аккаунт Veyra уже в игре\. Для второго клиента выберите в профиле локальный ник$/);
    // Отказ — до проверки токена и подготовки агента: без сети в журнале нет попытки входа.
    await app.evaluate(() => { globalThis.__offline = true; });
    const savedLogins = (logs.match(/запускаем с сохранённым входом/g) || []).length;
    await assert.rejects(page.evaluate(() => window.launcher.launchInstance('veyra-check')), /уже играет в другом клиенте/);
    assert.equal(((await page.evaluate(() => window.launcher.getLogs())).match(/запускаем с сохранённым входом/g) || []).length, savedLogins, 'The second launch is refused before the token check');
    await app.evaluate(() => { globalThis.__offline = false; });
    await page.evaluate(() => window.launcher.stopGame());
    await until(async () => (await state(page)).runningClients.length === 0, 'The game did not stop');
    assert.equal((await state(page)).account.veyraPlaying, false);
    await until(() => page.locator('#hero-multi').isEnabled(), '«+ Клиент» did not come back after the game stopped');
    assert.equal(await page.locator('#hero-multi').getAttribute('data-tip-lore'), 'Отдельная папка, вход аккаунтом Veyra');
    // Испорченный агент скачивается заново и снова сверяется.
    fs.writeFileSync(agentPath, 'broken');
    // Без сети: запуск с сохранённым входом и сохранённым описанием сервера, в журнале — предупреждение.
    await app.evaluate(() => { globalThis.__offline = true; });
    // Скин не загрузился (копии нет, сайт недоступен) — голова рисуется своя по нику, а не из скина Veyra по умолчанию.
    fs.rmSync(path.join(data, 'veyra-skins', secondHash + '.png'));
    missingSkins.add(secondHash);
    await page.evaluate(() => window.launcher.selectAccount('local'));
    await page.evaluate(() => window.launcher.selectAccount('veyra'));
    const headPixels = selector => page.evaluate(selector => [...document.querySelector(selector).getContext('2d').getImageData(0, 0, 8, 8).data].join(), selector);
    const generatedHead = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8; window.veyraHead(canvas, 'Veyra_Tester'); return [...canvas.getContext('2d').getImageData(0, 0, 8, 8).data].join(); });
    await until(async () => await headPixels('#profile-top canvas[data-head]') === generatedHead, 'A skin that failed to load must fall back to the generated head');
    assert.equal(await headPixels('#profile-rail canvas[data-head]'), generatedHead);
    await page.waitForTimeout(200);
    missingSkins.delete(secondHash);
    await page.evaluate(() => window.launcher.launchInstance('veyra-check'));
    args = (await app.evaluate(() => globalThis.__gameArgs)).at(-1);
    assert.equal(value('--accessToken'), session.accessToken);
    assert.equal(jarRequests, 2);
    assert.equal(sha256(fs.readFileSync(agentPath)), jarHash);
    assert.deepEqual(JSON.parse(Buffer.from(args.find(arg => arg.startsWith('-Dauthlibinjector.yggdrasil.prefetched=')).split('=')[1], 'base64').toString('utf8')), metadata.data);
    logs = await page.evaluate(() => window.launcher.getLogs());
    assert.match(logs, /сервер аккаунтов недоступен, запускаем с сохранённым входом/);
    await app.evaluate(() => { globalThis.__offline = false; });
    await page.evaluate(() => window.launcher.stopGame());
    await until(async () => (await state(page)).runningClients.length === 0, 'The offline game did not stop');
    // Хостинг отвечает 503 на проверку токена — игра тоже запускается с сохранённым входом, а не отказывает.
    await app.evaluate(() => { globalThis.__validateStatus = 503; });
    await page.evaluate(() => window.launcher.launchInstance('veyra-check'));
    args = (await app.evaluate(() => globalThis.__gameArgs)).at(-1);
    assert.equal(value('--accessToken'), session.accessToken);
    assert.ok(args.includes('-javaagent:' + agentPath + '=' + ROOT));
    assert.match(await page.evaluate(() => window.launcher.getLogs()), /запускаем с сохранённым входом \(Сервер аккаунтов Veyra временно не отвечает \(HTTP 503\)/);
    await app.evaluate(() => { globalThis.__validateStatus = 0; });
    await page.evaluate(() => window.launcher.stopGame());
    await until(async () => (await state(page)).runningClients.length === 0, 'The game started during the 503 did not stop');
    assert.equal((await state(page)).account.mode, 'veyra', 'A server outage does not sign the account out');
    done.push('запуск: -javaagent с ROOT, prefetched = описание сервера, токен/UUID/ник/mojang, метка клиента, токен скрыт, второй клиент запрещён, без сети и при 503 — с сохранённым входом, испорченный агент скачан заново, незагрузившийся скин — своя голова');

    // ── Локальный сервер «Вход через Veyra» и подключение клиента ──
    const serverPort = await freePort();
    await page.locator('.rail-button[data-view="server"]').click();
    await page.locator('#server-veyra-login').waitFor({ state: 'attached' });
    assert.equal(await page.locator('#server-veyra-login').isChecked(), false);
    await assert.rejects(page.evaluate(() => window.launcher.saveServerConfig('veyra-check', { veyraLogin: 'yes' })), /переключатель/);
    await page.locator('#server-veyra-login').check();
    assert.match(await page.locator('#server-auth-note').textContent(), /только игроки с аккаунтом Veyra/);
    await page.locator('#server-port').fill(String(serverPort));
    await page.locator('#server-eula').check();
    await shot(page, 'server-veyra-login.png');
    await page.locator('#server-start').click();
    await until(async () => (await state(page)).server?.status === 'ready', 'The Veyra server did not start: ' + await page.locator('#sessions-error').textContent().catch(() => ''), 60000);
    const properties = fs.readFileSync(path.join(game, '.veyra-server', 'server.properties'), 'utf8');
    assert.match(properties, /^online-mode=true$/m);
    assert.match(properties, /^enforce-secure-profile=false$/m);
    assert.match(properties, /^white-list=false$/m, 'The 26.3 white list (on by default) would turn away every Veyra player');
    assert.match(properties, new RegExp('^server-port=' + serverPort + '$', 'm'));
    const serverArgs = (await app.evaluate(() => globalThis.__serverArgs)).at(-1);
    assert.ok(serverArgs.indexOf('-javaagent:' + agentPath + '=' + ROOT) >= 0 && serverArgs.indexOf('-javaagent:' + agentPath + '=' + ROOT) < serverArgs.indexOf('-jar'), 'The server runs with the agent before -jar');
    assert.deepEqual(JSON.parse(Buffer.from(serverArgs.find(arg => arg.startsWith('-Dauthlibinjector.yggdrasil.prefetched=')).split('=')[1], 'base64').toString('utf8')), metadata.data);
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).instances[0].serverConfig.veyraLogin, true, 'The option is saved with the build');
    assert.match(await page.locator('#server-card-meta').textContent(), /вход через Veyra/);
    // С локальным ником быстрый вход отклоняется понятным сообщением.
    await page.evaluate(() => window.launcher.selectAccount('local'));
    await page.locator('#server-join').click();
    await until(async () => /аккаунтом Veyra/.test(await page.locator('#sessions-error').textContent()), 'Quick join in local mode was not refused');
    assert.match(await page.locator('#sessions-error').textContent(), /^Сервер запущен со входом через Veyra/);
    assert.equal((await state(page)).runningClients.length, 0);
    await page.evaluate(() => window.launcher.selectAccount('veyra'));
    await page.locator('#server-join').click();
    await until(async () => (await state(page)).runningClients.length === 1, 'Quick join with the Veyra account failed: ' + await page.locator('#sessions-error').textContent());
    args = (await app.evaluate(() => globalThis.__gameArgs)).at(-1);
    assert.equal(value('--quickPlayMultiplayer'), '127.0.0.1:' + serverPort);
    assert.ok(args.includes('-javaagent:' + agentPath + '=' + ROOT));
    // «+ Ещё клиент» не обещает второй клиент с тем же аккаунтом Veyra.
    await until(() => page.locator('#sessions-add').isDisabled(), '«+ Ещё клиент» stays enabled while the Veyra account plays');
    assert.equal(await page.locator('#sessions-note').textContent(), 'Аккаунт Veyra играет только в одном клиенте. Для дополнительных клиентов выберите в профиле локальный ник.');
    await shot(page, 'server-veyra-playing.png');
    await page.evaluate(() => window.launcher.stopGame());
    await until(async () => (await state(page)).runningClients.length === 0, 'The joined client did not stop');
    await until(() => page.locator('#sessions-add').isEnabled(), '«+ Ещё клиент» did not come back after the game stopped');
    await page.locator('#server-stop').click();
    await until(async () => (await state(page)).server?.status === 'stopped', 'The server did not stop');
    await page.locator('#server-veyra-login').uncheck();
    await page.locator('#server-start').click();
    await until(async () => (await state(page)).server?.status === 'ready', 'The plain server did not start', 60000);
    assert.match(fs.readFileSync(path.join(game, '.veyra-server', 'server.properties'), 'utf8'), /^online-mode=false$/m);
    assert.match(fs.readFileSync(path.join(game, '.veyra-server', 'server.properties'), 'utf8'), /^white-list=false$/m);
    assert.ok(!(await app.evaluate(() => globalThis.__serverArgs)).at(-1).some(arg => arg.startsWith('-javaagent:')), 'Without the option the server runs without the agent');
    await page.evaluate(() => window.launcher.selectAccount('local'));
    await until(async () => await page.locator('#sessions-note').textContent() === 'Дополнительные клиенты получают отдельные папки и разные локальные ники.', 'The local note did not come back');
    await page.locator('#server-join').click();
    await until(async () => (await state(page)).runningClients.length === 1, 'Local quick join to a plain server failed');
    await until(() => page.locator('#sessions-add').isEnabled(), 'Local nicknames may run more clients');
    await page.evaluate(() => window.launcher.stopGame());
    await until(async () => (await state(page)).runningClients.length === 0, 'The local client did not stop');
    await page.locator('#server-stop').click();
    await until(async () => (await state(page)).server?.status === 'stopped', 'The plain server did not stop');
    await page.evaluate(() => window.launcher.selectAccount('veyra'));
    done.push('сервер «Вход через Veyra»: online-mode=true, enforce-secure-profile=false, white-list=false, агент в аргументах, быстрый вход только с аккаунтом Veyra, «+ Ещё клиент» выключен, пока аккаунт в игре; без галочки — прежний офлайн-сервер');

    // ── Ссылки сообщества и личный кабинет ──
    await page.locator('.rail-button[data-view="home"]').click();
    // Кнопки внизу окна; ссылка «напишите нам в Telegram» из формы входа ведёт туда же.
    await page.locator('.community-button[data-community="telegram"]').click();
    await page.locator('.community-button[data-community="discord"]').click();
    await until(async () => (await app.evaluate(() => globalThis.__opened)).length === 2, 'Community links did not open');
    assert.deepEqual(await app.evaluate(() => globalThis.__opened), [config.telegram, config.discord]);
    assert.deepEqual([config.telegram, config.discord], ['https://t.me/veyra_launcher', 'https://veyra-launcher.com/discord']);
    await assert.rejects(page.evaluate(() => window.launcher.openCommunity('https://example.com')), /Неизвестная ссылка/);
    assert.equal(await page.locator('[data-community="telegram"] use').getAttribute('href'), '#i-telegram');
    assert.equal(await page.locator('[data-community="discord"] use').getAttribute('href'), '#i-discord');
    await page.locator('#profile-top').click();
    await page.locator('#veyra-cabinet').click();
    await until(async () => (await app.evaluate(() => globalThis.__opened)).length === 3, 'The cabinet did not open');
    assert.equal((await app.evaluate(() => globalThis.__opened))[2], config.cabinet);
    done.push('Telegram, Discord и личный кабинет открываются только по ссылкам из account-config.json');

    // ── Выход во время игры с аккаунтом Veyra: вход забывается сразу, токен отзывается, когда игра закроется ──
    const revokeFile = path.join(data, 'veyra-revoke.bin');
    const validate = async token => (await call('authserver/validate', { body: { accessToken: token } })).status;
    const playingToken = (await vault()).accessToken;
    const playing = await page.evaluate(() => window.launcher.launchInstance('veyra-check'));
    gamePids.add(playing.pid);
    await page.locator('#veyra-logout').click();
    await page.waitForFunction(() => document.getElementById('profile-chip-mode').textContent === 'Локальный профиль');
    assert.equal(fs.existsSync(path.join(data, 'veyra-session.bin')), false, 'Logout clears the vault at once');
    assert.equal(await validate(playingToken), 204, 'The running game keeps its token');
    assert.ok(fs.existsSync(revokeFile), 'The deferred token is remembered');
    assert.ok(!fs.readFileSync(revokeFile).includes(Buffer.from(playingToken)), 'The deferred token is stored encrypted');
    // Лаунчер перезапускается, игра остаётся: найденный по метке клиент держит свой токен.
    await quit();
    page = await open();
    await until(async () => (await state(page)).runningClients.length === 1, 'The running Veyra game was not found after the restart', 60000);
    await until(async () => (await page.evaluate(() => window.launcher.getLogs())).includes('Найден запущенный клиент'), 'The adoption was not logged');
    await page.waitForTimeout(1500);
    assert.equal(await validate(playingToken), 204, 'A found game keeps its token after the restart');
    assert.ok(fs.existsSync(revokeFile));
    // Игра закрывается без сети: отзыв не прошёл и повторится при следующем запуске лаунчера.
    await app.evaluate(() => { globalThis.__offline = true; });
    await page.evaluate(() => window.launcher.stopGame());
    await until(async () => (await state(page)).runningClients.length === 0, 'The found game did not stop');
    await until(async () => (await page.evaluate(() => window.launcher.getLogs())).includes('отложенный выход не подтверждён'), 'The revoke was not attempted when the game closed');
    assert.equal(await validate(playingToken), 204);
    assert.ok(fs.existsSync(revokeFile), 'Without the network the token stays in the list');
    await quit();
    page = await open();
    await until(async () => await validate(playingToken) === 403, 'The deferred token was not revoked at the next start');
    await until(() => !fs.existsSync(revokeFile), 'The deferred list was not cleared');
    gamePids.delete(playing.pid);
    done.push('выход во время игры Veyra: вход забыт сразу, токен игры жив, список отзыва зашифрован, переживает перезапуск, игра найдена по метке и держит токен, без сети отзыв повторён при следующем запуске');

    // ── Выход, когда играет локальный ник с тем же именем: UUID тот же, токен — нет, и он отзывается сразу ──
    await page.evaluate(() => window.launcher.veyraLogin('Veyra_Tester', 'veyra-secret-1'));
    const sameNameToken = (await vault()).accessToken;
    await page.evaluate(() => window.launcher.saveSettings({ playerName: 'Veyra_Tester' }));
    await page.evaluate(() => window.launcher.selectAccount('local'));
    const local = await page.evaluate(() => window.launcher.launchInstance('veyra-check'));
    gamePids.add(local.pid);
    args = (await app.evaluate(() => globalThis.__gameArgs)).at(-1);
    assert.deepEqual([local.name, value('--uuid'), value('--accessToken')], ['Veyra_Tester', offlineUuid('Veyra_Tester'), '0']);
    assert.equal(JSON.parse(Buffer.from(args.find(arg => arg.startsWith('-Dveyra.client=')).slice(15), 'base64url').toString('utf8')).veyra, undefined, 'A local game carries no Veyra token fingerprint');
    assert.equal((await state(page)).account.veyraPlaying, true, 'The same UUID still blocks a second Veyra client');
    await page.locator('#profile-top').click();
    await page.locator('[data-account-mode="veyra"]').click();
    await page.locator('#veyra-logout').click();
    await until(async () => (await state(page)).account.veyra === null, 'Logout did not finish');
    assert.equal(await validate(sameNameToken), 403, 'Logout revokes the token: the local game does not hold it');
    assert.equal(fs.existsSync(revokeFile), false, 'Nothing is deferred');
    await page.evaluate(() => window.launcher.stopGame());
    await until(async () => (await state(page)).runningClients.length === 0, 'The local game did not stop');
    gamePids.delete(local.pid);
    await page.evaluate(() => window.launcher.saveSettings({ playerName: 'LocalNick' }));
    await page.waitForFunction(() => document.getElementById('profile-chip-mode').textContent === 'Локальный профиль');
    current = await state(page);
    assert.equal(current.account.mode, 'local');
    assert.equal(current.account.veyra, null);
    assert.equal(current.account.name, 'LocalNick');
    assert.equal(fs.existsSync(path.join(data, 'veyra-session.bin')), false, 'Logout clears the vault');
    assert.equal(await page.locator('#veyra-login-form').isVisible(), true);
    await assert.rejects(page.evaluate(() => window.launcher.selectAccount('veyra')), /Сначала войдите/);
    done.push('выход при локальном нике с тем же UUID: токен отозван сразу, файл сессии удалён, снова локальный ник');

    // ── 429 у регистрации (пять аккаунтов с адреса за час) в окне 980×650: ждёт только регистрация ──
    for (const name of ['Filler_One', 'Filler_Two', 'Filler_Three', 'Filler_Four']) assert.equal((await call('veyra/register', { body: { username: name, password: 'filler-password' }, ip: '127.0.0.1' })).status, 200);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 650));
    await page.waitForTimeout(400);
    await page.locator('#veyra-login-form [data-veyra-form="register"]').click();
    await page.locator('#veyra-register-name').fill('Late_Comer');
    await page.locator('#veyra-register-password').fill('late-password');
    await page.locator('#veyra-register-confirm').fill('late-password');
    await page.locator('#veyra-register-submit').click();
    await until(async () => /С этого адреса/.test(await page.locator('#veyra-error').textContent()), 'Registration 429 was not shown');
    // Объяснение сервера показано без своего числа минут: оставшееся время одно — отсчёт на кнопке.
    const registerText = await page.locator('#veyra-error').textContent();
    assert.equal(registerText, 'С этого адреса уже создано несколько аккаунтов. Кнопка оживёт сама, когда закончится отсчёт.');
    assert.equal(await page.locator('#veyra-register-submit').isDisabled(), true);
    const registerLabel = await page.locator('#veyra-register-submit span').textContent();
    // Час считается с первой регистрации с адреса (Veyra_Tester в начале проверки): осталось меньше часа, но больше 40 минут.
    assert.match(registerLabel, /^Подождите (?:[45]\d:[0-5]\d|60:00)$/);
    assert.ok((await state(page)).account.veyraWait.register > Date.now() + 2400 * 1000);
    assert.deepEqual(Object.keys((await state(page)).account.veyraWait), ['register'], 'Only registration waits');
    assert.equal(await page.locator('#veyra-register-form [data-veyra-form="login"]').evaluate(node => node === document.activeElement), true, 'Focus moves from the disabled button to «Уже есть аккаунт»');
    // Сообщение видно целиком в маленьком окне: диалог прокрутился к нему.
    const [errorBox, dialogBox] = await page.evaluate(() => [document.getElementById('veyra-error'), document.getElementById('profile-dialog')].map(node => { const box = node.getBoundingClientRect(); return { top: box.top, bottom: box.bottom }; }));
    assert.ok(errorBox.top >= dialogBox.top && errorBox.bottom <= dialogBox.bottom - 6, 'The registration error is scrolled into the visible part of the dialog: ' + JSON.stringify([errorBox, dialogBox]));
    await shot(page, 'profile-veyra-register-wait.png');
    await page.waitForTimeout(1200);
    assert.equal(await page.locator('#veyra-error').textContent(), registerText, 'The alert region does not change every second');
    assert.notEqual(await page.locator('#veyra-register-submit span').textContent(), registerLabel, 'The countdown ticks on the button');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1460, 900));
    // Вход после отказа в регистрации доступен.
    await page.locator('#veyra-register-form [data-veyra-form="login"]').click();
    assert.equal(await page.locator('#veyra-login-submit').isEnabled(), true, 'A registration 429 does not block signing in');
    assert.equal(await page.locator('#veyra-login-submit span').textContent(), 'Войти');
    assert.equal(await page.locator('#veyra-error').isVisible(), false);
    done.push('429 у регистрации: текст сервера без своего числа, отсчёт в минутах на кнопке, сообщение видно в окне 980×650, вход не заблокирован');

    // ── 429 у входа: после пяти неверных паролей ждёт только этот ник ──
    for (let attempt = 0; attempt < 5; attempt++) await call('authserver/authenticate', { body: { username: 'Locked_One', password: 'nope-' + attempt }, ip: '198.51.100.30' });
    await page.locator('#veyra-login-name').fill('Locked_One');
    await page.locator('#veyra-login-password').fill('locked-password');
    await page.locator('#veyra-login-submit').click();
    await until(async () => /Слишком много попыток/.test(await page.locator('#veyra-error').textContent()), '429 was not shown');
    const waitText = await page.locator('#veyra-error').textContent();
    assert.match(waitText, /^Слишком много попыток\. Кнопка оживёт сама, когда закончится отсчёт\.$/);
    assert.doesNotMatch(waitText, /\d/, 'The message has no second, frozen number next to the countdown');
    assert.equal(await page.locator('#veyra-login-submit').isDisabled(), true);
    const waitLabel = await page.locator('#veyra-login-submit span').textContent();
    assert.match(waitLabel, /^Подождите \d+ с$/);
    assert.ok((await state(page)).account.veyraWait['login:locked_one'] > Date.now());
    assert.equal(await focused(), 'veyra-login-name', 'After a 429 the name is selected: another account can sign in');
    await page.waitForTimeout(2100);
    assert.equal(await page.locator('#veyra-error').textContent(), waitText, 'The alert region does not change every second');
    assert.notEqual(await page.locator('#veyra-login-submit span').textContent(), waitLabel, 'The countdown ticks on the button');
    await shot(page, 'profile-veyra-wait.png');
    await page.locator('#veyra-login-name').fill('LOCKED_ONE');
    assert.equal(await page.locator('#veyra-login-submit').isDisabled(), true, 'Names are compared case-insensitively');
    await page.locator('#veyra-login-name').fill('Veyra_Tester');
    assert.equal(await page.locator('#veyra-login-submit').isEnabled(), true, 'Another name may sign in at once');
    assert.equal(await page.locator('#veyra-login-submit span').textContent(), 'Войти');
    assert.equal(await page.locator('#veyra-error').isVisible(), false, 'The wait message of another name goes away');
    await page.locator('#veyra-login-name').fill('Locked_One');
    assert.equal(await page.locator('#veyra-login-submit').isDisabled(), true);
    await until(() => page.locator('#veyra-login-submit').isEnabled(), 'The countdown did not end', 70000);
    assert.equal(await page.locator('#veyra-login-submit span').textContent(), 'Войти');
    assert.equal(await page.locator('#veyra-register-submit').isDisabled(), true, 'Registration still waits');
    await page.locator('#veyra-login-name').fill('Veyra_Tester');
    await page.locator('#veyra-login-password').fill('veyra-secret-1');
    await page.locator('#veyra-login-submit').click();
    await page.waitForFunction(() => document.getElementById('profile-chip-name').textContent === 'Veyra_Tester');
    assert.equal((await state(page)).account.mode, 'veyra');
    assert.deepEqual((await state(page)).account.veyra.skin, { url: 'veyra://skin/' + secondHash, slim: true }, 'Signing in brings the skin back');
    done.push('429 у входа: текст сервера один раз и без числа секунд, отсчёт на кнопке, пауза только у этого ника (без учёта регистра), вход по паролю');

    // ── Отозванный токен: запуск просит войти заново ──
    await call('authserver/invalidate', { body: { accessToken: (await vault()).accessToken } });
    await page.keyboard.press('Escape');
    await assert.rejects(page.evaluate(() => window.launcher.launchInstance('veyra-check')), /устарел — войдите заново/);
    current = await state(page);
    assert.equal(current.account.mode, 'local');
    assert.equal(current.account.veyra, null);
    assert.equal(fs.existsSync(path.join(data, 'veyra-session.bin')), false);
    assert.equal((await state(page)).runningClients.length, 0);
    done.push('отозванный токен: обновление не прошло — вход сброшен, игра не запущена');

    assert.deepEqual(problems, []);
    assert.doesNotMatch(phpLog, /PHP (?:Fatal|Warning|Notice|Deprecated)/, phpLog);
    process.stdout.write('OK (' + phpVersion + '): ' + done.join('; ') + '. Сервер аккаунтов настоящий; Java игры и сервера, authlib-injector и диалог файла — подмены.\n');
  } finally {
    if (app) {
      const page = await app.firstWindow().catch(() => null);
      await page?.evaluate(() => window.launcher.stopGame()).catch(() => {});
      await page?.evaluate(() => window.launcher.stopServer(true)).catch(() => {});
      await app.close().catch(() => {});
    }
    for (const pid of gamePids) { try { process.kill(pid); } catch { /* уже завершилась */ } }
    const phpExited = php.exitCode !== null || php.signalCode !== null ? Promise.resolve() : new Promise(resolve => php.once('exit', resolve));
    php.kill();
    await Promise.race([phpExited, new Promise(resolve => setTimeout(resolve, 5000))]);
    jarServer.closeAllConnections();
    await new Promise(resolve => jarServer.close(resolve));
    // Копия сайта (ключ RSA, базы аккаунтов и токенов) и папка данных лаунчера не остаются во временной папке.
    // VEYRA_KEEP_SITE=1 оставляет их для разбора.
    if (process.env.VEYRA_KEEP_SITE) process.stdout.write('Копия сайта: ' + root + '\nДанные лаунчера: ' + data + '\n');
    else for (const folder of [root, data]) {
      try { fs.rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
      catch (error) { process.stderr.write('Не удалось удалить ' + folder + ': ' + error.message + '\n'); }
    }
  }
}
main().catch(error => { process.stderr.write((error.stack || error) + '\n'); process.exitCode = 1; });
