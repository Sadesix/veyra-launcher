const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { _electron: electron } = require('playwright-core');
async function main() {
  const workspace = path.join(__dirname, '..');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-cart-ui-'));
  const directory = path.join(data, 'instances', 'aurora'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ selectedInstanceId: 'aurora', instances: [{ id: 'aurora', name: 'Aurora', minecraftVersion: '1.21.8', loader: 'fabric', loaderVersion: '0.17.2', directory }] }));
  fs.writeFileSync(path.join(data, 'version-manifest.json'), JSON.stringify({ versions: [{ id: '1.21.8', type: 'release' }] }));
  const options = { executablePath: process.argv[2] ? path.resolve(process.argv[2]) : undefined, args: process.argv[2] ? [] : ['.'], cwd: workspace, env: { ...process.env, VEYRA_TEST_DATA_DIR: data }, timeout: 120000 };
  let app; let page;
  const errors = [], output = path.join(workspace, 'test-output'); fs.mkdirSync(output, { recursive: true });
  async function start() {
    app = await electron.launch(options); page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => document.getElementById('hero-name').textContent === 'Aurora');
    await app.evaluate(({ app }, fixturePath) => {
      const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
      const fixture = require(fixturePath).fixtures(), original = globalThis.fetch;
      globalThis.fetch = (url, options) => /https:\/\/(api|cdn)\.modrinth\.com\//.test(String(url)) ? fixture.fetcher(url, options) : original(url, options); globalThis.__cartFixture = fixture;
    }, path.join(workspace, 'scripts', 'content-check.js'));
  }
  try {
    await start(); await page.locator('#hero-content').click(); await page.locator('#content-catalog-mode').click();
    await page.locator('.catalog-card[data-project-id="mainmod"] .catalog-add').waitFor();
    await page.evaluate(() => {
      document.querySelector('.catalog-card[data-project-id="mainmod"] .catalog-add').click();
      document.querySelector('.catalog-card[data-project-id="secondmod"] .catalog-add').click();
      if (!document.getElementById('cart-install').disabled) throw new Error('Installation must wait for pending additions');
    });
    assert.equal(await page.locator('#content-catalog-mode').getAttribute('aria-pressed'), 'true');
    assert.equal((await page.evaluate(() => window.launcher.getContent('aurora', 'mods'))).entries.length, 0);
    await page.waitForFunction(() => document.getElementById('cart-count').textContent === '2' && !document.getElementById('cart-install').disabled);
    assert.equal(await page.locator('.cart-dependency').count(), 1, 'Shared library shown once');
    assert.equal((await page.evaluate(() => window.launcher.getCart('aurora'))).length, 2);
    await page.waitForTimeout(800); await page.screenshot({ path: path.join(output, 'cart-workshop.png') });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 650)); await page.waitForTimeout(600);
    const cartButton = await page.locator('#cart-install').boundingBox(), dialogBox = await page.locator('#content-dialog').boundingBox();
    assert.ok(cartButton.y + cartButton.height < dialogBox.y + dialogBox.height, 'Batch button remains inside minimum window with selected projects and dependencies');
    assert.equal(await page.locator('#content-dialog').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    await page.screenshot({ path: path.join(output, 'cart-workshop-filled-small.png') });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1460, 900));
    // Kill only this test process tree to simulate a launcher crash.
    const pid = app.process().pid;
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); else app.process().kill('SIGKILL');
    await app.close().catch(() => {}); await start();
    assert.equal((await page.evaluate(() => window.launcher.getCart('aurora'))).length, 2);
    await page.locator('#hero-content').click(); await page.waitForFunction(() => !document.getElementById('cart-install').disabled);
    assert.equal(await page.locator('#cart-count').textContent(), '2');
    await page.locator('.cart-item[data-project-id="mainmod"] button[title^="Изменить версию"]').click();
    await page.locator('#content-version').selectOption('mod1');
    await page.waitForFunction(() => document.getElementById('content-version').value === 'mod1' && !document.getElementById('content-plan-install').disabled);
    await page.locator('#content-plan-install').click();
    await page.waitForFunction(async () => (await window.launcher.getCart('aurora')).find(item => item.projectId === 'mainmod').versionId === 'mod1');
    assert.equal((await page.evaluate(() => window.launcher.getCart('aurora'))).length, 2);
    await app.evaluate(() => globalThis.__cartFixture.setDelay(true));
    await page.waitForFunction(() => !document.getElementById('cart-install').disabled); await page.locator('#cart-install').click(); await page.locator('#content-cancel').click();
    await page.waitForFunction(async () => !(await window.launcher.getState()).operation);
    assert.equal((await page.evaluate(() => window.launcher.getCart('aurora'))).length, 2);
    assert.equal((await page.evaluate(() => window.launcher.getContent('aurora', 'mods'))).entries.length, 0);
    await app.evaluate(() => globalThis.__cartFixture.setDelay(false));
    await page.waitForFunction(() => !document.getElementById('cart-install').disabled); await page.locator('#cart-install').click();
    await page.waitForFunction(() => document.getElementById('cart-count').textContent === '0');
    assert.equal(await page.locator('#content-catalog-mode').getAttribute('aria-pressed'), 'true');
    const content = await page.evaluate(() => window.launcher.getContent('aurora', 'mods'));
    assert.equal(content.entries.length, 3); assert.ok(fs.existsSync(path.join(directory, 'mods', 'mainmod-1.0.jar'))); assert.ok(fs.existsSync(path.join(directory, 'mods', 'secondmod-1.0.jar')));
    assert.equal((await page.evaluate(() => window.launcher.getCart('aurora'))).length, 0);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 650));
    await page.locator('#content-cart-open').click();
    await page.waitForTimeout(600);
    assert.equal(await page.locator('#content-dialog .content-body').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    assert.equal(await page.locator('#content-dialog').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    await page.screenshot({ path: path.join(output, 'cart-workshop-small.png') });
    const cross = page.locator('[data-close="content-dialog"]'); const rect = await cross.boundingBox(); assert.ok(rect.width >= 44 && rect.height >= 44);
    await cross.click({ position: { x: 3, y: 3 } }); await page.waitForFunction(() => !document.getElementById('content-dialog').open);
    assert.deepEqual(errors, []);
    process.stdout.write('OK: quick accumulation, persistent crash recovery, shared dependency once, queued version changes, cancellation retains picks, atomic batch install, catalog stays open, minimum size and edge click on close.\n');
  } finally { await app?.close().catch(() => {}); }
}
main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
