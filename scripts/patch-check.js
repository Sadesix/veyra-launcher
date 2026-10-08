const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');
async function main() {
  const workspace = path.join(__dirname, '..'), data = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-patch-'));
  const directory = path.join(data, 'instances', 'aurora'); fs.mkdirSync(directory, { recursive: true });
  const save = path.join(directory, 'saves', 'Adventure'); fs.mkdirSync(save, { recursive: true }); fs.writeFileSync(path.join(save, 'level.dat'), 'fixture save');
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ playerName: 'QuickNick', selectedInstanceId: 'aurora', instances: [{ id: 'aurora', name: 'Aurora', minecraftVersion: '1.21.8', loader: 'fabric', loaderVersion: '0.17.2', directory }] }));
  fs.writeFileSync(path.join(data, 'version-manifest.json'), JSON.stringify({ versions: [{ id: '1.21.8', type: 'release' }] }));
  const options = { executablePath: process.argv[2] ? path.resolve(process.argv[2]) : undefined, args: process.argv[2] ? [] : ['.'], cwd: workspace, env: { ...process.env, VEYRA_TEST_DATA_DIR: data }, timeout: 120000 };
  let app, page; const errors = [], output = path.join(workspace, 'test-output'); fs.mkdirSync(output, { recursive: true });
  async function start() {
    app = await electron.launch(options); page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.locator('#profile-top').waitFor(); await page.waitForFunction(() => document.getElementById('hero-name').textContent.length > 0);
  }
  async function closeCorner(dialogId) {
    const button = page.locator('#' + dialogId + ' .modal-close'); await button.waitFor();
    await page.waitForTimeout(850); const before = await button.boundingBox();
    assert.ok(before.width >= 43.9 && before.height >= 43.9, dialogId + ' hit area: ' + JSON.stringify(before));
    await button.hover(); await page.waitForTimeout(350); const after = await button.boundingBox();
    assert.ok(Math.abs(before.x - after.x) < .1 && Math.abs(before.y - after.y) < .1, dialogId + ' hover must not move hit area');
    assert.equal(await button.locator('svg').evaluate(node => getComputedStyle(node).pointerEvents), 'none');
    await button.click({ position: { x: 2, y: 2 } }); await page.waitForFunction(id => !document.getElementById(id).open, dialogId);
  }
  try {
    await start(); assert.equal(await page.evaluate(() => [...document.forms].every(form => form.noValidate)), true);
    await page.locator('#profile-top').click(); await page.locator('#profile-name-input').fill(''); await page.locator('#profile-name-input').press('Enter');
    await page.waitForFunction(() => document.getElementById('profile-name-input').getAttribute('aria-invalid') === 'true');
    assert.match(await page.locator('#profile-name-form .field-error').textContent(), /Заполните/);
    assert.equal((await page.evaluate(() => window.launcher.getState())).settings.playerName, 'QuickNick');
    await page.locator('#profile-name-input').fill('@@@'); await page.locator('#profile-name-input').press('Enter');
    assert.match(await page.locator('#profile-name-form .field-error').textContent(), /латинские/);
    await page.waitForTimeout(550);
    await page.screenshot({ path: path.join(output, 'custom-validation.png') }); await closeCorner('profile-dialog');
    await page.locator('#profile-top').click(); assert.equal(await page.locator('#profile-name-form .field-error').count(), 0); await closeCorner('profile-dialog');
    // Creation remains real; skip its automatic game download in this interface test.
    await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('launcher:install-instance'); ipcMain.handle('launcher:install-instance', () => ({ cancelled: true })); });
    await page.locator('#create-top').click(); assert.equal(await page.locator('#create-name').getAttribute('placeholder'), 'Сборка');
    await page.locator('#create-name').fill('X'); await page.locator('#create-submit').click();
    assert.match(await page.locator('#create-form .field-error').textContent(), /минимум 2/);
    await page.locator('#create-name').fill(''); await page.locator('#create-submit').click();
    await page.waitForFunction(() => !document.getElementById('create-dialog').open);
    let builds = (await page.evaluate(() => window.launcher.getState())).instances;
    assert.ok(builds.some(item => item.name === 'Сборка'));
    const second = await page.evaluate(() => window.launcher.createInstance({ name: '  ', minecraftVersion: '1.21.8', loader: 'vanilla' }));
    assert.equal(second.name, 'Сборка 2');
    await page.waitForFunction(() => document.getElementById('hero-name').textContent === 'Сборка 2');
    await page.locator('#hero-rename').click(); await page.locator('#hero-rename-input').fill(''); await page.locator('#hero-rename-input').press('Enter');
    await page.waitForFunction(() => document.getElementById('hero-rename-form').hidden);
    assert.equal((await page.evaluate(() => window.launcher.getState())).instances.find(item => item.id === second.id).name, 'Сборка 2');
    await page.locator('#create-top').click(); assert.equal(await page.locator('#create-name').getAttribute('placeholder'), 'Сборка 3'); await closeCorner('create-dialog');
    await page.evaluate(() => window.launcher.selectInstance('aurora')); await page.waitForFunction(() => document.getElementById('hero-name').textContent === 'Aurora');
    await page.locator('#hero-rename').click();
    const renameCross = page.locator('#hero-rename-cancel'); const renameBox = await renameCross.boundingBox(); assert.ok(renameBox.width >= 44 && renameBox.height >= 44);
    await renameCross.click({ position: { x: 2, y: 2 } }); assert.equal(await page.locator('#hero-rename-form').isVisible(), false);
    await page.locator('#hero-edit').click(); await page.locator('#edit-name').fill('');
    assert.equal(await page.locator('#instance-dialog-title').textContent(), 'Сборка 3');
    await page.locator('[data-studio-tab="game"]').click(); await page.locator('#edit-memory-default').uncheck(); await page.locator('#edit-memory').fill('0');
    await page.locator('#instance-form button[type="submit"]').click();
    assert.match(await page.locator('.studio-fields .field-error').textContent(), /Минимальное значение/);
    assert.equal((await page.evaluate(() => window.launcher.getState())).instances.find(item => item.id === 'aurora').name, 'Aurora');
    await page.locator('#edit-memory').fill('3'); await page.locator('#instance-form button[type="submit"]').click();
    await page.waitForFunction(() => !document.getElementById('instance-dialog').open);
    assert.equal((await page.evaluate(() => window.launcher.getState())).instances.find(item => item.id === 'aurora').name, 'Сборка 3');
    await page.locator('#hero-edit').click(); await page.locator('#remove-instance').click(); await closeCorner('remove-dialog');
    await page.locator('#hero-edit').click(); await closeCorner('instance-dialog');
    await app.evaluate(({ app }, fixturePath) => {
      const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json'), fixture = require(fixturePath).fixtures(), original = globalThis.fetch;
      globalThis.fetch = (url, options) => /https:\/\/(api|cdn)\.modrinth\.com\//.test(String(url)) ? fixture.fetcher(url, options) : original(url, options);
    }, path.join(workspace, 'scripts', 'content-check.js'));
    await page.locator('#hero-content').click(); await page.locator('#content-catalog-mode').click();
    await page.locator('.catalog-card[data-project-id="mainmod"] .catalog-options').click();
    const planCross = page.locator('#content-plan-close'); assert.ok((await planCross.boundingBox()).width >= 44); await planCross.click({ position: { x: 2, y: 2 } }); await page.waitForFunction(() => document.getElementById('content-plan').hidden);
    await page.locator('#content-cart-open').click(); await page.locator('#cart-close').click({ position: { x: 2, y: 2 } }); await page.waitForFunction(() => document.getElementById('content-cart').hidden);
    await page.locator('[data-content-kind="saves"]').click();
    await page.locator('.content-row[data-content-name="Adventure"] button[title="Переименовать папку"]').click();
    await page.locator('#save-rename-input').fill(''); await page.locator('#save-rename-form button[type="submit"]').click();
    assert.match(await page.locator('#save-rename-form .field-error').textContent(), /Заполните/);
    await page.locator('#save-rename-input').fill('bad/name'); await page.locator('#save-rename-form button[type="submit"]').click();
    await page.locator('#save-rename-form .form-alert').waitFor(); assert.match(await page.locator('#save-rename-form .form-alert').textContent(), /Некорректное имя/);
    await closeCorner('save-rename-dialog');
    await closeCorner('content-dialog');
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(1234, 777); window.setPosition(70, 80); });
    await page.waitForTimeout(500); const expected = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNormalBounds());
    await app.close(); await start();
    assert.deepEqual(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNormalBounds()), expected);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize()); await page.waitForTimeout(700); await app.close(); await start();
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()), true);
    assert.deepEqual(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNormalBounds()), expected);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].unmaximize()); await page.waitForTimeout(700);
    assert.deepEqual(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds()), expected);
    const minimizedBounds = await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(1198, 733); window.setPosition(82, 92); const bounds = window.getNormalBounds(); window.minimize(); return bounds; });
    await app.close(); await start();
    assert.deepEqual(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNormalBounds()), minimizedBounds, 'Immediate minimize and quit must preserve the most recent geometry');
    const cross = page.locator('#window-close'); const rect = await cross.boundingBox(); assert.ok(rect.width >= 44 && rect.height >= 44);
    assert.deepEqual(errors, []);
    await Promise.all([app.waitForEvent('close'), cross.click({ position: { x: 2, y: 2 } }).catch(error => { if (!/has been closed/.test(error.message)) throw error; })]); app = null;
    process.stdout.write('OK: custom field validation, automatic names in creation/quick rename/studio, fixed close hitboxes and edge clicks, exact size/position and maximized state restored, hidden Microsoft UI preserved.\n');
  } finally { await app?.close().catch(() => {}); }
}
main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
