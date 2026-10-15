const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { _electron: electron } = require('playwright-core');
const { Updater, manifest, newer } = require('../main/updater');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = file => fs.existsSync(file);

async function main() {
  // Сравнение версий и разбор файла обновлений.
  assert.equal(newer('0.7.3', '0.7.2'), true); assert.equal(newer('0.10.0', '0.9.9'), true); assert.equal(newer('1.0', '0.9.9'), true);
  assert.equal(newer('0.7.2', '0.7.2'), false); assert.equal(newer('0.7.2', '0.7.10'), false);
  assert.throws(() => manifest({ windows: {} }), /нет номера версии/); assert.throws(() => manifest({ version: '1.0.0; rm' }), /нет номера версии/);
  const parsed = manifest({ version: '1.2.3', notes: [' Новое ', 5, ''], page: 'http://example.com/', windows: { url: 'https://example.com/a.exe', sha256: 'AB'.repeat(32), size: 10 } });
  assert.deepEqual(parsed, { version: '1.2.3', published: '', notes: ['Новое'], page: '', url: 'https://example.com/a.exe', sha256: 'ab'.repeat(32), size: 10 });
  assert.equal(manifest({ version: '1.2.3', windows: { url: 'http://127.0.0.1:1/a.exe' } }).url, '', 'Plain HTTP is refused outside checks');
  assert.equal(manifest({ version: '1.2.3', windows: { url: 'http://127.0.0.1:1/a.exe' } }, { insecure: true }).url, 'http://127.0.0.1:1/a.exe');
  assert.equal(new Updater({ version: '1.0.0', feed: 'http://example.com/latest.json' }).state.status, 'unconfigured', 'An HTTP feed is not a feed');
  const relative = manifest({ version: '1.2.3', page: './', windows: { url: 'downloads/Veyra-Launcher-1.2.3-x64.exe' } }, { base: 'https://example.com/veyra/latest.json' });
  assert.equal(relative.url, 'https://example.com/veyra/downloads/Veyra-Launcher-1.2.3-x64.exe', 'Relative links resolve against the feed'); assert.equal(relative.page, 'https://example.com/veyra/');
  assert.equal(manifest({ version: '1.2.3', windows: { url: 'downloads/a.exe' } }).url, '', 'A relative link needs the feed address');

  // Настоящая маленькая программа Windows играет роль новой версии: её можно скачать, проверить и запустить.
  const program = fs.readFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe'));
  const workspace = path.join(__dirname, '..'), current = require('../package.json').version;
  let feed = {}, slow = null;
  const server = http.createServer((request, response) => {
    if (request.url === '/latest.json') { response.writeHead(feed.status || 200, { 'Content-Type': 'application/json' }); return response.end(feed.body); }
    if (request.url === '/app.exe') { response.writeHead(200, { 'Content-Length': program.length }); return response.end(program); }
    if (request.url === '/slow.exe') { response.writeHead(200, { 'Content-Length': program.length }); response.write(program.subarray(0, 4096)); slow = response; return; }
    response.writeHead(404); response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const publish = (version, file = {}) => { feed = { body: JSON.stringify({ version, published: '20 октября 2026', notes: ['Новый конструктор миров', 'Исправления интерфейса'], windows: { url: base + '/app.exe', sha256: sha256(program), size: program.length, ...file } }) }; };
  try {
    // Модуль обновлений с настоящими HTTP-ответами.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-updater-'));
    const states = [];
    const updater = new Updater({ version: '1.0.0', feed: base + '/latest.json', directory, insecure: true, onChange: () => states.push(updater.state.status + ':' + updater.state.progress) });
    assert.equal(updater.state.status, 'idle');
    feed = { status: 404, body: 'no' }; assert.equal((await updater.check()).status, 'error'); assert.match(updater.state.error, /HTTP 404/);
    feed = { body: '{broken' }; assert.equal((await updater.check()).status, 'error'); assert.match(updater.state.error, /повреждён/);
    publish('1.0.0'); assert.equal((await updater.check()).status, 'current');
    await assert.rejects(updater.download(), /Сначала проверьте/);
    publish('2.0.0', { sha256: '' }); assert.equal((await updater.check()).status, 'available'); assert.equal(updater.state.downloadable, false);
    await assert.rejects(updater.download(), /контрольной суммой/);
    publish('2.0.0', { sha256: 'f'.repeat(64) }); await updater.check();
    await assert.rejects(updater.download(), /Контрольная сумма/);
    assert.deepEqual(fs.readdirSync(directory), [], 'A file with a wrong checksum must not stay on disk'); assert.equal(updater.state.status, 'available'); assert.match(updater.state.error, /не совпала/);
    publish('2.0.0', { url: base + '/slow.exe' }); await updater.check();
    const cancelled = updater.download();
    while (!slow) await new Promise(resolve => setTimeout(resolve, 20));
    updater.cancel(); assert.equal(await cancelled, null); slow.destroy();
    assert.deepEqual(fs.readdirSync(directory), []); assert.equal(updater.state.status, 'available'); assert.equal(updater.state.error, '');
    feed = { body: JSON.stringify({ version: '2.0.0', windows: { url: 'app.exe', sha256: sha256(program), size: program.length } }) }; await updater.check();
    assert.equal(updater.latest.url, base + '/app.exe', 'The site may list the installer by a relative path');
    const downloaded = await updater.download();
    assert.equal(downloaded.file, path.join(directory, 'Veyra-Launcher-2.0.0-x64.exe')); assert.deepEqual(fs.readFileSync(downloaded.file), program); assert.equal(downloaded.sha256, sha256(program));
    assert.equal(updater.state.status, 'ready'); assert.ok(states.includes('downloading:0'));
    assert.equal((await updater.check()).status, 'ready', 'A verified file is not downloaded twice');

    // Лаунчер: уведомление, режимы, скачивание и передача запуска новой версии.
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-update-')), portable = path.join(data, 'portable');
    const next = current.replace(/\d+$/, digits => Number(digits) + 1), target = path.join(portable, 'Veyra-Launcher-' + next + '-x64.exe'), handoff = path.join(data, 'handoff.json');
    fs.mkdirSync(portable);
    fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ playerName: 'UpdateNick', instances: [] }));
    fs.writeFileSync(path.join(data, 'version-manifest.json'), JSON.stringify({ versions: [{ id: '1.21.8', type: 'release' }] }));
    const env = { ...process.env, VEYRA_TEST_DATA_DIR: data, VEYRA_UPDATE_FEED: base + '/latest.json', PORTABLE_EXECUTABLE_FILE: path.join(portable, 'Veyra-Launcher-' + current + '-x64.exe') };
    const options = { executablePath: process.argv[2] ? path.resolve(process.argv[2]) : undefined, args: process.argv[2] ? [] : ['.'], cwd: workspace, env, timeout: 120000 };
    const settings = () => JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));
    const watch = page => page.evaluate(async () => { window.__update = await window.launcher.getState(); window.launcher.onEvent(event => { if (event.type === 'state') window.__update = event.state; }); });
    publish(next);
    let app = await electron.launch(options), page = await app.firstWindow();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await watch(page);
    assert.equal((await page.evaluate(() => window.launcher.getState())).settings.updates, 'notify', 'Automatic installation is off by default');
    await page.waitForFunction(() => window.__update.update.status === 'available', null, { timeout: 20000 });
    await page.locator('#update-footer').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#update-footer-label').textContent(), 'Обновление ' + next);
    assert.equal(await page.locator('.rail-button[data-view="settings"]').evaluate(node => node.classList.contains('has-alert')), true);
    assert.match(await page.locator('#toast-text').textContent(), new RegExp('Вышла версия ' + next.replaceAll('.', '\\.')));
    assert.equal(exists(target), false, 'Notify mode must not download by itself');
    await page.locator('#update-footer').click();
    assert.equal(await page.locator('#settings-page').isVisible(), true);
    assert.match(await page.locator('#update-status-text').textContent(), new RegExp('Доступна версия ' + next.replaceAll('.', '\\.') + ' от 20 октября 2026'));
    assert.equal(await page.locator('#update-notes li').count(), 2); assert.equal(await page.locator('#update-current').textContent(), 'Установлена версия ' + current);
    await page.waitForTimeout(500); fs.mkdirSync(path.join(workspace, 'test-output'), { recursive: true }); await page.screenshot({ path: path.join(workspace, 'test-output', 'updates.png') });
    await page.locator('[data-update-mode="off"]').click();
    await page.waitForFunction(() => window.__update.settings.updates === 'off');
    assert.equal(await page.locator('#update-footer').isVisible(), false, 'Hidden mode shows no reminder'); assert.equal(settings().updates, 'off');
    assert.equal(await page.locator('.rail-button[data-view="settings"]').evaluate(node => node.classList.contains('has-alert')), false);
    assert.equal(await page.locator('#update-download').isVisible(), true, 'A manual download stays available in settings');
    await assert.rejects(page.evaluate(() => window.launcher.saveSettings({ updates: 'always' })), /режим обновлений/);
    await assert.rejects(page.evaluate(() => window.launcher.applyUpdate()), /ещё не скачано/);
    await page.locator('[data-update-mode="notify"]').click(); await page.waitForFunction(() => window.__update.settings.updates === 'notify');
    await page.locator('#update-download').click();
    await page.waitForFunction(() => window.__update.update.status === 'ready', null, { timeout: 20000 });
    assert.deepEqual(fs.readFileSync(target), program); assert.deepEqual(settings().pendingUpdate, { version: next, file: target, sha256: sha256(program) });
    assert.equal(await page.locator('#update-footer-label').textContent(), 'Перезапустить · ' + next);
    assert.match(await page.locator('#update-status-text').textContent(), /скачана и проверена/);
    assert.deepEqual(errors, []);
    // Запуск новой версии подменён записью в файл: проверяются путь, отсоединение и очищенное окружение.
    await app.evaluate(({ app: electronApp }, marker) => {
      const require = process.getBuiltinModule('module').createRequire(electronApp.getAppPath() + '/package.json'), childProcess = require('node:child_process');
      childProcess.spawn = (file, args, spawnOptions) => { require('node:fs').writeFileSync(marker, JSON.stringify({ file, args, detached: spawnOptions.detached, portable: Object.keys(spawnOptions.env).filter(key => key.startsWith('PORTABLE_')) })); return { once(event, callback) { if (event === 'spawn') setImmediate(callback); }, unref() {} }; };
    }, handoff);
    await Promise.all([app.waitForEvent('close'), page.locator('#update-apply').click().catch(error => { if (!/closed/.test(error.message)) throw error; })]);
    assert.deepEqual(JSON.parse(fs.readFileSync(handoff, 'utf8')), { file: target, args: [], detached: true, portable: [] });
    assert.equal(settings().playerName, 'UpdateNick', 'Settings are saved before the new version starts');

    // Скачанная версия ждёт кнопки: без автоматического режима старт остаётся обычным.
    app = await electron.launch(options); page = await app.firstWindow(); await watch(page);
    await page.waitForFunction(() => window.__update.update.status === 'ready');
    assert.equal((await page.evaluate(() => window.launcher.getState())).update.file, target);
    await page.evaluate(() => window.launcher.saveSettings({ updates: 'auto' }));
    await app.close();

    // Автоматический режим: проверенный файл запускается вместо старой версии, старая выходит сама.
    const launcher = options.executablePath || require('electron');
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(launcher, options.args, { cwd: workspace, env, windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => { child.kill(); reject(new Error('The old version did not hand over to the downloaded one')); }, 20000);
      child.once('error', reject); child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(await run(), 0);
    const log = fs.readFileSync(path.join(data, 'launcher.log'), 'utf8');
    assert.match(log, new RegExp('Запускаем скачанную версию ' + next.replaceAll('.', '\\.'))); assert.doesNotMatch(log, /Запуск обновления:/);

    // Изменённый файл не запускается: лаунчер стартует как обычно и забывает о нём.
    fs.appendFileSync(target, 'x');
    publish(current);
    app = await electron.launch(options); page = await app.firstWindow(); await watch(page);
    await page.locator('#profile-top').waitFor();
    assert.equal(settings().pendingUpdate, null); assert.notEqual((await page.evaluate(() => window.launcher.getState())).update.status, 'ready');
    await page.waitForFunction(() => window.__update.update.status === 'current', null, { timeout: 20000 });
    assert.equal(await page.locator('#update-footer').isVisible(), false);
    // Автоматический режим сам скачивает найденную версию.
    fs.rmSync(target); publish(next);
    await page.keyboard.press('6'); await page.locator('#update-check').click();
    await page.waitForFunction(() => window.__update.update.status === 'ready', null, { timeout: 20000 });
    assert.deepEqual(fs.readFileSync(target), program); assert.equal(settings().pendingUpdate.version, next);
    assert.match(await page.locator('#update-explain').textContent(), /в фоне/);
    await app.close();
    process.stdout.write('OK: version comparison, feed validation, HTTPS-only links, HTTP errors, checksum mismatch, cancellation, verified download; notify by default with footer reminder, hidden mode, manual download, saved hand-over to the new version, automatic hand-over at start, refusal of a changed file and automatic background download. The update file is a small real Windows program served over local HTTP.\n');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
