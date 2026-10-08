const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { ZipFile } = require('yazl');
const { _electron: electron } = require('playwright-core');

const sha1 = bytes => createHash('sha1').update(bytes).digest('hex');
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
async function zip(entries) {
  const archive = new ZipFile();
  const chunks = [];
  archive.outputStream.on('data', chunk => chunks.push(chunk));
  const done = new Promise((resolve, reject) => { archive.outputStream.once('end', () => resolve(Buffer.concat(chunks))); archive.outputStream.once('error', reject); });
  for (const [name, content] of Object.entries(entries)) archive.addBuffer(Buffer.from(content), name);
  archive.end();
  return done;
}

async function main() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-refinement-'));
  const output = path.join(__dirname, '..', 'test-output');
  fs.mkdirSync(output, { recursive: true });
  const game = path.join(data, 'instances', 'console-check');
  const versionId = 'fixture-v1';
  const forgeId = versionId + '-forge-99.0.1';
  const client = Buffer.from('Minecraft client fixture');
  const assets = Buffer.from(JSON.stringify({ objects: {} }));
  const processor = await zip({ 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\nMain-Class: FixtureInstaller\n\n' });
  const responses = { '/client.jar': client, '/assets.json': assets, '/processor.jar': processor };
  const server = http.createServer((request, response) => {
    const bytes = responses[request.url];
    response.writeHead(bytes ? 200 : 404, { 'Content-Type': request.url.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
    response.end(bytes || 'Not found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const version = {
    id: versionId, type: 'release', mainClass: 'net.minecraft.client.main.Main', assets: 'fixture-assets',
    javaVersion: { majorVersion: 25, component: 'java-runtime-epsilon' }, libraries: [],
    assetIndex: { id: 'fixture-assets', url: base + '/assets.json', sha1: sha1(assets), size: assets.length, totalSize: 0 },
    downloads: { client: { url: base + '/client.jar', sha1: sha1(client), size: client.length } },
    arguments: { jvm: ['-classpath', '${classpath}'], game: ['--username', '${auth_player_name}'] },
  };
  responses['/version.json'] = Buffer.from(JSON.stringify(version));
  const manifest = { versions: [{ id: versionId, type: 'release', url: base + '/version.json', sha1: sha1(responses['/version.json']) }] };
  write(path.join(data, 'version-manifest.json'), JSON.stringify(manifest));
  write(path.join(game, 'versions', versionId, versionId + '.json'), responses['/version.json']);
  write(path.join(game, 'versions', versionId, versionId + '.jar'), client);
  write(path.join(game, 'assets', 'indexes', 'fixture-assets.json'), assets);
  const processorPath = 'fixture/processor/1.0/processor-1.0.jar';
  write(path.join(game, 'libraries', processorPath), processor);
  const profile = {
    spec: 1, profile: 'forge', version: forgeId, minecraft: versionId, json: '/version.json', data: {},
    libraries: [{ name: 'fixture:processor:1.0', downloads: { artifact: { url: base + '/processor.jar', path: processorPath, sha1: sha1(processor), size: processor.length } } }],
    processors: [{ sides: ['client'], jar: 'fixture:processor:1.0', classpath: [], args: [], outputs: {} }],
  };
  write(path.join(game, 'libraries', 'net', 'minecraftforge', 'forge', versionId + '-99.0.1', 'forge-' + versionId + '-99.0.1-installer.jar'), await zip({
    'install_profile.json': JSON.stringify(profile),
    'version.json': JSON.stringify({ id: forgeId, inheritsFrom: versionId, type: 'release', mainClass: version.mainClass, libraries: [], arguments: { jvm: [], game: [] } }),
  }));
  const javaPath = path.join(process.env.VEYRA_JAVA_HOME || path.join(process.env.APPDATA, 'veyra-launcher', 'runtimes', 'java-runtime-epsilon'), 'bin', 'java.exe');
  assert.ok(fs.existsSync(javaPath), 'Java 25 is needed for launch prechecks');
  write(path.join(data, 'settings.json'), JSON.stringify({ javaPath, selectedInstanceId: 'console-check', instances: [{ id: 'console-check', name: 'Aurora', directory: game, minecraftVersion: versionId, loader: 'forge', loaderVersion: '99.0.1' }] }));
  const options = { executablePath: process.argv[2] ? path.resolve(process.argv[2]) : undefined, args: process.argv[2] ? [] : ['.'], cwd: path.join(__dirname, '..'), env: { ...process.env, VEYRA_TEST_DATA_DIR: data }, timeout: 120000 };
  let app;
  try {
    app = await electron.launch(options);
    let page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => document.getElementById('hero-name').textContent === 'Aurora');
    await app.evaluate(({ app }, fixtureManifest) => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (url, init) => {
        const address = String(url);
        if (address.includes('version_manifest')) return Promise.resolve(new Response(JSON.stringify(fixtureManifest)));
        if (address.includes('forge/maven-metadata.json')) return Promise.resolve(new Response(JSON.stringify({ 'fixture-v1': ['fixture-v1-99.0.2', 'fixture-v1-99.0.1'] })));
        if (address.includes('promotions_slim.json')) return Promise.resolve(new Response(JSON.stringify({ promos: { 'fixture-v1-recommended': '99.0.1' } })));
        return originalFetch(url, init);
      };
      const nodeRequire = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
      const childProcess = nodeRequire('node:child_process');
      const originalSpawn = childProcess.spawn;
      childProcess.spawn = (command, args, options) => {
        if (args.includes('FixtureInstaller')) {
          // Only Java bytecode is replaced. The actual XMCL installation, child streams,
          // task cancellation, launcher IPC and clipboard all run normally.
          const script = "let n=0; console.log('Реальный stdout: начало'); console.error('Реальный stderr: предупреждение'); const timer=setInterval(()=>{console.log('\\x1b[32mФайл '+(++n)+' проверен\\x1b[0m'); if(n===24){clearInterval(timer); console.log('Установщик завершён');}},250);";
          const child = originalSpawn(process.execPath, ['-e', script], { ...options, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true });
          globalThis.__installerPid = child.pid;
          return child;
        }
        if (args.includes('net.minecraft.client.main.Main')) {
          globalThis.__gameArgs = args;
          const child = originalSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { ...options, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true });
          globalThis.__gamePid = child.pid;
          return child;
        }
        return originalSpawn(command, args, options);
      };
    }, manifest);
    await page.evaluate(() => window.launcher.refreshVersions());
    await page.evaluate(() => window.launcher.refreshVersions());
    assert.match(await page.locator('#hero-loader').textContent(), /Forge 99\.0\.1/);
    assert.match(await page.locator('#home-instance-grid').textContent(), /Forge 99\.0\.1/);
    const before = await page.locator('#hero-description').boundingBox();
    await page.locator('#hero-rename').click();
    const during = await page.locator('#hero-description').boundingBox();
    assert.ok(Math.abs(before.y - during.y) < 1, 'Renaming must preserve description geometry');
    await page.evaluate(() => {
      window.__typedNames = [];
      window.__nameObserver = new MutationObserver(() => window.__typedNames.push(document.getElementById('hero-name').textContent));
      window.__nameObserver.observe(document.getElementById('hero-name'), { childList: true, subtree: true, characterData: true });
    });
    await page.locator('#hero-rename-input').fill('Aurora Prime');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('hero-name').textContent === 'Aurora Prime');
    const names = await page.evaluate(() => window.__typedNames);
    assert.ok(names.includes('') && names.some(name => name.startsWith('Aurora') && name.length < 12), 'Name must erase and type again');
    assert.equal(await page.locator('#hero-rename-input').inputValue(), '');
    assert.ok(Math.abs(before.y - (await page.locator('#hero-description').boundingBox()).y) < 1);
    await page.locator('#toast-undo').click();
    await page.waitForFunction(() => document.getElementById('hero-name').textContent === 'Aurora');
    await page.locator('#profile-top').click();
    await page.locator('#profile-any-symbols').locator('..').click();
    assert.equal(await page.locator('#profile-any-symbols').isChecked(), true);
    await page.locator('#profile-name-input').fill('Лайси 🌙');
    await page.locator('#profile-name-input').press('Enter');
    await page.waitForFunction(() => document.getElementById('profile-chip-name').textContent === 'Лайси 🌙');
    assert.equal((await page.evaluate(() => window.launcher.getState())).settings.allowAnySymbols, true);
    await assert.rejects(() => page.evaluate(() => window.launcher.saveSettings({ playerName: 'bad\nname', allowAnySymbols: true })));
    await assert.rejects(() => page.evaluate(() => window.launcher.saveSettings({ playerName: 'Лайси 🌙', allowAnySymbols: false })));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('profile-dialog').open);
    await page.locator('#create-top').click();
    await page.locator('[data-loader="forge"]').click();
    await page.locator('[data-loader-version="99.0.1"]').waitFor();
    assert.equal(await page.locator('#create-loader-version').inputValue(), '99.0.1');
    assert.match(await page.locator('[data-loader-version="99.0.1"]').textContent(), /Рекомендуется/);
    await page.locator('[data-loader-version="99.0.2"]').click();
    assert.equal(await page.locator('#create-loader-version').inputValue(), '99.0.2');
    await page.locator('#loader-version-search').fill('99.0.1');
    assert.equal(await page.locator('[data-loader-version]').count(), 1);
    await page.screenshot({ path: path.join(output, 'loader-version-picker.png') });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('create-dialog').open);
    await page.locator('.rail-button[data-view="settings"]').click();
    await page.locator('[data-background-picture="false"]').click();
    assert.equal(await page.locator('#appearance-blur').isDisabled(), true);
    await page.locator('#save-settings').click();
    assert.equal((await page.evaluate(() => window.launcher.getState())).settings.appearance.picture, false);
    await page.locator('.rail-button[data-view="home"]').click();
    await page.waitForTimeout(500);
    assert.equal(await page.locator('body').evaluate(node => getComputedStyle(node, '::after').opacity), '0');
    await page.locator('#main-action').click();
    await page.waitForFunction(() => document.getElementById('install-console-output').textContent.includes('Реальный stderr'), { timeout: 30000 });
    assert.ok(await page.locator('#install-scroll').isVisible());
    assert.match(await page.locator('#install-console-output').textContent(), /Реальный stdout/);
    await page.waitForTimeout(900);
    assert.equal(await page.locator('#hero-card').evaluate(node => node.scrollTop), 0, 'Focusing inline rename must not scroll the cover internally');
    assert.ok((await page.locator('#hero-active').boundingBox()).y >= (await page.locator('#hero-card').boundingBox()).y);
    assert.equal(await page.locator('.dashboard-side > .glass-card').first().evaluate(node => getComputedStyle(node).opacity), '0');
    await page.screenshot({ path: path.join(output, 'install-scroll.png') });
    await page.locator('#console-pause').click();
    const paused = await page.locator('#install-console-output').textContent();
    await page.waitForTimeout(700);
    assert.equal(await page.locator('#install-console-output').textContent(), paused, 'Pause must freeze the viewport');
    await page.locator('#console-copy').click();
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
    assert.match(copied, /Реальный stdout/);
    assert.doesNotMatch(copied, /\x1b\[/);
    await page.locator('#console-follow').click();
    assert.ok((await page.locator('#install-console-output').textContent()).length > paused.length, 'Follow must catch up buffered output');
    await page.waitForFunction(() => document.getElementById('console-status').textContent === 'Готово', { timeout: 20000 });
    const installed = await page.evaluate(() => window.launcher.getState());
    assert.equal(installed.instances[0].installed, true);
    assert.equal(installed.installConsole.outcome, 'success');
    assert.ok(installed.installConsole.lines.some(line => line.source === 'stderr'));
    await page.locator('#console-close').click();
    await page.locator('#install-scroll').waitFor({ state: 'hidden' });
    await page.locator('#console-footer').click();
    assert.ok(await page.locator('#install-scroll').isVisible());
    await page.locator('#console-close').click();
    await page.locator('#install-scroll').waitFor({ state: 'hidden' });
    await page.locator('#main-action').click();
    await page.locator('#launch-stage').waitFor({ state: 'visible' });
    const stage = await page.locator('#launch-stage').boundingBox();
    const hero = await page.locator('#hero-card').boundingBox();
    assert.ok(stage.width <= 440 && stage.x >= hero.x && stage.y >= hero.y && stage.y + stage.height <= hero.y + hero.height, 'Launch animation must fit inside the hero');
    await page.screenshot({ path: path.join(output, 'compact-launch.png') });
    await page.waitForFunction(() => document.getElementById('main-action-label').textContent === 'Остановить игру');
    const args = await app.evaluate(() => globalThis.__gameArgs);
    assert.equal(args[args.indexOf('--username') + 1], 'Лайси 🌙', 'Unicode nickname must reach the real launch arguments');
    await page.evaluate(() => window.launcher.stopGame());
    await page.waitForFunction(async () => !(await window.launcher.getState()).runningInstanceId);
    const previousSession = (await page.evaluate(() => window.launcher.getState())).installConsole.id;
    await page.evaluate(() => { window.__reinstall = window.launcher.installInstance('console-check').catch(error => { window.__reinstallError = error.message; }); });
    await page.waitForFunction(async oldId => {
      if (window.__reinstallError) throw new Error(window.__reinstallError);
      const current = (await window.launcher.getState()).installConsole;
      return current?.live && current.id !== oldId;
    }, previousSession);
    await page.waitForFunction(() => document.getElementById('install-console-output').textContent.includes('Реальный stdout'));
    const pid = await app.evaluate(() => globalThis.__installerPid);
    await page.locator('#cancel-operation').click();
    await page.waitForFunction(() => document.getElementById('console-status').textContent === 'Отменено', { timeout: 15000 });
    await page.evaluate(() => window.__reinstall);
    assert.equal(await app.evaluate((_context, targetPid) => { try { process.kill(targetPid, 0); return false; } catch { return true; } }, pid), true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 650));
    await page.waitForTimeout(900);
    assert.equal(await page.locator('.content').evaluate(node => node.scrollWidth > node.clientWidth + 1), false, 'Minimum window must not overflow horizontally');
    const smallHero = await page.locator('#hero-card').boundingBox();
    const smallConsole = await page.locator('#install-scroll').boundingBox();
    assert.ok(smallConsole.x >= smallHero.x + smallHero.width, 'Console must stay beside the cover at minimum window size');
    await page.screenshot({ path: path.join(output, 'install-scroll-small.png') });
    assert.deepEqual(errors, []);
    await app.close();
    app = await electron.launch(options);
    page = await app.firstWindow();
    await page.waitForFunction(() => document.getElementById('profile-chip-name').textContent === 'Лайси 🌙');
    const restored = await page.evaluate(() => window.launcher.getState());
    assert.equal(restored.settings.allowAnySymbols, true);
    assert.equal(restored.settings.appearance.picture, false);
    assert.equal(restored.instances[0].name, 'Aurora');
    process.stdout.write('OK: loader version tiles/badges, stable rename/typewriter/undo, Unicode profile/launch/persistence, picture toggle, real installer stdout/stderr/pause/copy/cancellation, compact launch and minimum window. Installer bytecode and game replaced by real Node children.\n');
  } finally {
    if (app) { const page = await app.firstWindow().catch(() => null); await page?.evaluate(() => window.launcher.stopGame()).catch(() => {}); await app.close().catch(() => {}); }
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
