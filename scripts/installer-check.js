const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright-core');
const asar = require('@electron/asar');

// Проверяет установщик так, как его проходит человек: тихая установка и установка через окно, запуск через ярлык-заглушку,
// обновление с сайта (с обрывом связи на середине загрузки), установка новой версии в фоне, перезапуск в неё,
// уборка прежней версии и удаление. Реестр и ярлыки в проверочном режиме пишутся в отдельные тестовые места.
const root = path.join(__dirname, '..');
const { version } = require('../package.json');
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const REG = 'HKCU\\Software\\VeyraLauncherTest\\Uninstall\\VeyraLauncher';

async function waitFor(check, timeout, message) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Не дождались: ' + message);
    await delay(200);
  }
}
function powershell(script) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' + script], { encoding: 'utf8', windowsHide: true });
  return result.stdout.trim();
}
const appProcesses = fragment => powershell(`Get-CimInstance Win32_Process -Filter "Name='Veyra Launcher.exe'" | ForEach-Object { $_.ExecutablePath }`)
  .split(/\r?\n/).filter(line => line && line.toLowerCase().includes(fragment.toLowerCase()));
const killApps = fragment => powershell(`Get-CimInstance Win32_Process -Filter "Name='Veyra Launcher.exe'" | Where-Object { $_.ExecutablePath -like '*${fragment.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
const regValue = name => { const result = spawnSync('reg', ['query', REG, '/v', name], { encoding: 'utf8', windowsHide: true }); return result.status === 0 ? result.stdout.split(/\r?\n/).find(line => line.includes(name))?.trim().split(/\s{2,}/).pop() : null; };
const shortcutTarget = link => powershell(`(New-Object -ComObject WScript.Shell).CreateShortcut('${link.replace(/'/g, "''")}').TargetPath`);
const freePort = () => new Promise(resolve => { const server = net.createServer().listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
function runSetup(file, args, env) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { out += chunk; });
    child.on('close', code => resolve({ code, out: out.trim() }));
  });
}

async function main() {
  const setup = path.resolve(process.argv[2] || path.join(root, 'dist', 'Veyra-Launcher-Setup-' + version + '.exe'));
  assert.ok(fs.existsSync(setup), 'Нет установщика ' + setup + ': выполните npm run dist');
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-installer-'));
  const env = { ...process.env, VEYRA_SETUP_TEST: '1', VEYRA_SETUP_TEST_DIR: T, VEYRA_TEST_DATA_DIR: path.join(T, 'data'), VEYRA_CLEANUP_DELAY: '2000' };
  delete env.ELECTRON_RUN_AS_NODE;
  const installRoot = path.join(T, 'Veyra Launcher');
  const report = [];
  let server, browser;
  try {
    // ── Следующая версия: та же сборка, но с другим номером внутри app.asar ──
    const next = version.replace(/\d+$/, digits => Number(digits) + 1);
    const nextApp = path.join(T, 'next-app'), unpacked = path.join(T, 'next-asar');
    fs.cpSync(path.join(root, 'dist', 'win-unpacked'), nextApp, { recursive: true });
    asar.extractAll(path.join(nextApp, 'resources', 'app.asar'), unpacked);
    const manifest = JSON.parse(fs.readFileSync(path.join(unpacked, 'package.json'), 'utf8'));
    manifest.version = next;
    fs.writeFileSync(path.join(unpacked, 'package.json'), JSON.stringify(manifest, null, 2));
    // @electron/asar не ждёт закрытия файла после записи: архив пишется рядом и копируется на место, когда освободится.
    const packed = path.join(T, 'next.asar');
    await asar.createPackage(unpacked, packed);
    await waitFor(() => { try { fs.copyFileSync(packed, path.join(nextApp, 'resources', 'app.asar')); return true; } catch { return false; } }, 10000, 'архив app.asar освободился');
    const nextSetup = path.join(T, 'Veyra-Launcher-Setup-' + next + '.exe');
    const built = spawnSync(process.execPath, [path.join(__dirname, 'build-installer.js'), '--version', next, '--app-dir', nextApp, '--out', nextSetup, '--fast'], { encoding: 'utf8' });
    assert.equal(built.status, 0, built.stderr);
    fs.rmSync(unpacked, { recursive: true, force: true });

    // ── Тихая установка ──
    let started = Date.now();
    let result = await runSetup(setup, ['--quiet', '--root', installRoot, '--no-desktop'], env);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, new RegExp('^OK ' + version.replace(/\./g, '\\.') + ' '));
    const state = JSON.parse(fs.readFileSync(path.join(installRoot, 'veyra-install.json'), 'utf8'));
    assert.equal(state.version, version); assert.equal(state.desktop, false); assert.equal(state.startMenu, true);
    const build = state.build, buildDir = path.join(installRoot, 'app-' + build);
    for (const file of ['Veyra Launcher.exe', 'Uninstall Veyra Launcher.exe', path.join('app-' + build, 'Veyra Launcher.exe'), path.join('app-' + build, '.veyra-ready'), path.join('app-' + build, 'resources', 'app.asar')]) assert.ok(fs.existsSync(path.join(installRoot, file)), 'Есть ' + file);
    assert.equal(regValue('DisplayVersion'), version); assert.equal(regValue('InstallLocation'), installRoot);
    assert.match(regValue('UninstallString'), /Uninstall Veyra Launcher\.exe" --uninstall$/);
    assert.equal(shortcutTarget(path.join(T, 'Programs', 'Veyra Launcher.lnk')).toLowerCase(), path.join(installRoot, 'Veyra Launcher.exe').toLowerCase());
    assert.ok(!fs.existsSync(path.join(T, 'Desktop', 'Veyra Launcher.lnk')), 'Без --no-desktop ярлыка на столе нет');
    report.push('тихая установка ' + ((Date.now() - started) / 1000).toFixed(1) + ' с');

    // ── Сайт с новой версией: первая загрузка обрывается на середине ──
    const nextSize = fs.statSync(nextSetup).size, requests = [];
    let dropped = false;
    server = http.createServer((request, response) => {
      if (request.url === '/update.json') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        return response.end(JSON.stringify({ version: next, published: '20 октября 2026', notes: ['Проверка обновления установщиком'], windows: { url: '/setup.exe', sha256: sha256(nextSetup), size: nextSize } }));
      }
      if (request.url !== '/setup.exe') { response.writeHead(404); return response.end(); }
      const range = /^bytes=(\d+)-$/.exec(request.headers.range || '');
      requests.push(range ? 'range ' + range[1] : 'full');
      const from = range ? Number(range[1]) : 0;
      response.writeHead(range ? 206 : 200, { 'Content-Length': nextSize - from, 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': 'bytes ' + from + '-' + (nextSize - 1) + '/' + nextSize } : {}) });
      const stream = fs.createReadStream(nextSetup, { start: from });
      if (!dropped) {
        dropped = true;
        let sent = 0;
        stream.on('data', chunk => { sent += chunk.length; if (sent > nextSize * 0.4) { stream.destroy(); response.destroy(); } });
      }
      stream.pipe(response);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const feed = 'http://127.0.0.1:' + server.address().port + '/update.json';

    // ── Запуск через заглушку, как с ярлыка ──
    const port = await freePort();
    started = Date.now();
    const stub = spawn(path.join(installRoot, 'Veyra Launcher.exe'), ['--remote-debugging-port=' + port], { env: { ...env, VEYRA_UPDATE_FEED: feed }, windowsHide: true, stdio: 'ignore' });
    const stubExit = await new Promise(resolve => stub.on('exit', code => resolve({ code, ms: Date.now() - started })));
    assert.equal(stubExit.code, 0);
    const endpoint = await waitFor(() => fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(800) }).then(response => response.json()).then(value => value.webSocketDebuggerUrl).catch(() => ''), 60000, 'окно лаунчера');
    const opened = Date.now() - started;
    browser = await chromium.connectOverCDP(endpoint);
    const page = await waitFor(() => browser.contexts()[0]?.pages()[0], 10000, 'страница');
    await page.locator('#profile-top').waitFor();
    let appState = await page.evaluate(() => window.launcher.getState());
    assert.equal(appState.appVersion, version); assert.equal(appState.update.installed, true);
    assert.ok(appProcesses(buildDir).length > 0, 'Лаунчер работает из папки своей сборки');
    report.push('заглушка ' + stubExit.ms + ' мс, окно ' + (opened / 1000).toFixed(1) + ' с');

    // ── Обновление: проверка, загрузка с докачкой, установка в фоне ──
    appState = await page.evaluate(() => window.launcher.checkUpdates());
    assert.equal(appState.status, 'available'); assert.equal(appState.version, next);
    started = Date.now();
    await page.evaluate(() => window.launcher.downloadUpdate());
    appState = (await page.evaluate(() => window.launcher.getState())).update;
    assert.equal(appState.status, 'ready', appState.error); assert.equal(appState.prepared, true, appState.error);
    assert.deepEqual(requests.slice(0, 2).map(item => item.split(' ')[0]), ['full', 'range'], 'После обрыва загрузка продолжилась с места остановки: ' + requests.join(', '));
    const nextState = JSON.parse(fs.readFileSync(path.join(installRoot, 'veyra-install.json'), 'utf8'));
    assert.equal(nextState.version, next); assert.equal(nextState.previous, build);
    const nextDir = path.join(installRoot, 'app-' + nextState.build);
    assert.ok(fs.existsSync(path.join(nextDir, '.veyra-ready')), 'Новая версия распакована рядом');
    assert.ok(fs.existsSync(buildDir), 'Работающая версия не тронута');
    assert.ok(fs.existsSync(path.join(installRoot, 'packages', 'Veyra-Launcher-Setup-' + next + '.exe')));
    assert.equal(regValue('DisplayVersion'), next);
    await page.locator('.rail-button[data-view="settings"]').click();
    await page.locator('#update-apply').waitFor();
    assert.equal(await page.locator('#update-apply-label').textContent(), 'Перезапустить и обновить');
    report.push('обновление скачано с докачкой и установлено в фоне за ' + ((Date.now() - started) / 1000).toFixed(1) + ' с');

    // ── Перезапуск в новую версию и уборка прежней ──
    await page.evaluate(() => window.launcher.applyUpdate()).catch(() => {});
    await browser.close().catch(() => {});
    browser = null;
    await waitFor(() => appProcesses(nextDir).length > 0 && appProcesses(buildDir).length === 0, 30000, 'новая версия запустилась вместо старой');
    await waitFor(() => !fs.existsSync(buildDir), 60000, 'прежняя версия удалена');
    await waitFor(() => (fs.readdirSync(path.join(installRoot, 'packages')).length === 0), 20000, 'скачанный установщик удалён');
    const settings = JSON.parse(fs.readFileSync(path.join(T, 'data', 'settings.json'), 'utf8'));
    assert.equal(settings.pendingUpdate, null, 'Новая версия закрыла ожидание обновления');
    killApps(installRoot);
    report.push('перезапуск в ' + next + ', прежняя версия и установщик убраны');

    // ── Удаление ──
    await waitFor(() => appProcesses(installRoot).length === 0, 10000, 'лаунчер закрылся');
    result = await runSetup(path.join(installRoot, 'Uninstall Veyra Launcher.exe'), ['--uninstall', '--quiet'], env);
    assert.equal(result.code, 0, result.out);
    await waitFor(() => !fs.existsSync(installRoot), 30000, 'папка установки удалена');
    assert.equal(regValue('DisplayVersion'), null, 'Запись в «Приложениях» удалена');
    assert.ok(!fs.existsSync(path.join(T, 'Programs', 'Veyra Launcher.lnk')), 'Ярлык удалён');
    assert.ok(fs.existsSync(path.join(T, 'data', 'settings.json')), 'Настройки остались');
    report.push('удаление');

    // ── Установка через окно: кнопка «Установить», страница «Готово», запуск ──
    const uiRoot = path.join(T, 'Окно установки', 'Veyra Launcher');
    const ui = powershell(`
      Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
      $env:VEYRA_SETUP_TEST = '1'; $env:VEYRA_SETUP_TEST_DIR = '${T.replace(/'/g, "''")}'; $env:VEYRA_TEST_DATA_DIR = '${path.join(T, 'data').replace(/'/g, "''")}'
      Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
      $process = Start-Process -FilePath '${setup.replace(/'/g, "''")}' -ArgumentList @('--root', '"${uiRoot.replace(/'/g, "''")}"') -PassThru
      function Window { [Windows.Automation.AutomationElement]::RootElement.FindFirst([Windows.Automation.TreeScope]::Children, (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ProcessIdProperty, $process.Id))) }
      function Find($id) { $w = Window; if (-not $w) { return $null }; $w.FindFirst([Windows.Automation.TreeScope]::Descendants, (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::AutomationIdProperty, $id))) }
      function Wait($id) { for ($i = 0; $i -lt 450; $i++) { $e = Find $id; if ($e -and -not $e.Current.IsOffscreen) { return $e }; Start-Sleep -Milliseconds 200 }; return $null }
      $title = Wait 'WelcomeTitle'
      $first = $title.Current.Name
      (Find 'PrimaryButton').GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
      $done = Wait 'DoneTitle'
      $doneText = if ($done) { $done.Current.Name } else { 'timeout' }
      (Find 'PrimaryButton').GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
      $process.WaitForExit(15000) | Out-Null
      "$first|$doneText|$($process.ExitCode)"`);
    assert.equal(ui, 'Veyra ' + version + '|Veyra установлена|0', 'Окно установщика: ' + ui);
    assert.ok(fs.existsSync(path.join(uiRoot, 'veyra-install.json')), 'Окно поставило лаунчер в выбранную папку');
    assert.equal(shortcutTarget(path.join(T, 'Desktop', 'Veyra Launcher.lnk')).toLowerCase(), path.join(uiRoot, 'Veyra Launcher.exe').toLowerCase(), 'Ярлык на столе по умолчанию');
    await waitFor(() => appProcesses(uiRoot).length > 0, 30000, 'лаунчер открылся после установки');
    killApps(uiRoot);
    await waitFor(() => appProcesses(uiRoot).length === 0, 10000, 'лаунчер закрылся');
    result = await runSetup(path.join(uiRoot, 'Uninstall Veyra Launcher.exe'), ['--uninstall', '--quiet'], env);
    assert.equal(result.code, 0, result.out);
    await waitFor(() => !fs.existsSync(uiRoot), 30000, 'вторая установка удалена');
    report.push('установка через окно с ярлыками и запуском');

    process.stdout.write('OK: ' + report.join('; ') + '.\n');
  } finally {
    await browser?.close().catch(() => {});
    server?.close();
    killApps(T);
    spawnSync('reg', ['delete', 'HKCU\\Software\\VeyraLauncherTest', '/f'], { windowsHide: true });
    await delay(500);
    if (process.env.VEYRA_KEEP_TEST) process.stdout.write('Папка проверки оставлена: ' + T + '\n');
    else fs.rmSync(T, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
    for (const file of fs.readdirSync(path.join(root, 'dist', '.installer'))) if (/-fast\.7z$/.test(file)) fs.rmSync(path.join(root, 'dist', '.installer', file), { force: true });
    // Деинсталлятор переносит себя во временную папку; обычно его убирает следующий запуск установщика.
    for (const file of fs.readdirSync(os.tmpdir())) if (/^veyra-uninstall-[0-9a-f]{8}\.exe$/.test(file)) fs.rmSync(path.join(os.tmpdir(), file), { force: true });
  }
}
main().catch((error) => { process.stderr.write((error.stack || error) + '\n'); process.exitCode = 1; });
