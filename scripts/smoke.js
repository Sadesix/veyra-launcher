const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');

async function main() {
  const executablePath = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-smoke-'));
  const app = await electron.launch({
    executablePath,
    args: executablePath ? [] : ['.'],
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, VEYRA_TEST_DATA_DIR: dataDirectory },
    timeout: 120000,
  });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.locator('#view-title').waitFor();
    const initial = await page.evaluate(() => window.launcher.getState());
    assert.equal(initial.instances.length, 0);
    assert.equal(initial.dataDirectory.toLowerCase(), dataDirectory.toLowerCase());
    assert.equal(initial.instancesDirectory.toLowerCase(), path.join(dataDirectory, 'instances').toLowerCase());
    assert.equal(await page.locator('.icon-rail').count(), 1);
    assert.equal(await page.locator('.nav-item').count(), 0);
    assert.equal(await page.locator('.wordmark').textContent(), 'veyra');
    assert.equal(await page.locator('.hero-atmosphere').count(), 0);
    assert.equal(await page.locator('#hero-edit use').getAttribute('href'), '#i-settings');
    assert.equal(await page.locator('use[href="#i-sliders"]').count(), 0);
    assert.ok(initial.maxMemoryGb <= initial.systemMemoryGb);

    const versions = await page.evaluate(() => window.launcher.refreshVersions());
    assert.ok(versions.some((version) => version.type === 'release'));

    await page.locator('#create-top').click();
    const iconState = await page.locator('.loader-choice .brand-icon').evaluateAll((images) =>
      images.map((image) => ({ loaded: image.complete && image.naturalWidth > 0, source: image.getAttribute('src') })));
    assert.equal(iconState.length, 4);
    assert.ok(iconState.every((item) => item.loaded), JSON.stringify(iconState));
    const output = path.join(__dirname, '..', 'test-output');
    fs.mkdirSync(output, { recursive: true });
    await page.waitForTimeout(380);
    await page.screenshot({ path: path.join(output, 'create.png') });
    await page.locator('#version-search').fill('1.21.8');
    await page.locator('[data-version="1.21.8"]').click();
    for (const loader of ['fabric', 'neoforge', 'forge']) {
      await page.locator('[data-loader="' + loader + '"]').click();
      await page.waitForFunction(() => {
        const select = document.getElementById('create-loader-version');
        return select.options.length > 0 && Boolean(select.options[0].value);
      }, null, { timeout: 45000 });
      assert.ok(await page.locator('#create-loader-version option').count() > 0, loader);
    }
    await page.locator('[data-loader="vanilla"]').click();
    await page.locator('[data-close="create-dialog"]').first().click();
    await page.waitForFunction(() => !document.getElementById('create-dialog').open);

    const instance = await page.evaluate(() => window.launcher.createInstance({
      name: 'Smoke World',
      minecraftVersion: '1.21.8',
      loader: 'vanilla',
    }));
    assert.ok(fs.existsSync(path.join(instance.directory, 'mods')));
    assert.ok(fs.existsSync(path.join(instance.directory, 'saves')));
    assert.equal(path.dirname(instance.directory).toLowerCase(), initial.instancesDirectory.toLowerCase());
    await page.locator('#hero-name').waitFor();
    assert.equal(await page.locator('#hero-name').textContent(), 'Smoke World');
    await page.keyboard.press('F2');
    await page.locator('#hero-rename-input').fill('Quick Name');
    await page.locator('#hero-rename-input').press('Enter');
    await page.waitForFunction(() => document.getElementById('hero-name').textContent === 'Quick Name');
    assert.equal(await page.locator('#hero-name').textContent(), 'Quick Name');
    const hero = page.locator('#hero-card');
    const rect = await hero.boundingBox();
    await page.mouse.move(rect.x + 30, rect.y + 30);
    const leftParallax = await hero.evaluate((node) => node.style.getPropertyValue('--scene-x'));
    await page.mouse.move(rect.x + rect.width - 30, rect.y + 30);
    const rightParallax = await hero.evaluate((node) => node.style.getPropertyValue('--scene-x'));
    assert.notEqual(leftParallax, rightParallax);
    assert.equal(await page.locator('#hero-image').evaluate((node) => getComputedStyle(node).animationName), 'none');
    await page.locator('#hero-edit').click();
    await app.evaluate(({ dialog }, imagePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [imagePath] });
    }, path.join(__dirname, '..', 'assets', 'veyra-hero.jpg'));
    await page.locator('#edit-cover').click();
    await page.locator('[data-accent="rose"]').click();
    await page.locator('#edit-favorite').check();
    await page.locator('#edit-name').fill('Renamed World');
    await page.locator('#edit-note').fill('Построить город над озером');
    assert.equal(await page.locator('#edit-memory').getAttribute('max'), String(initial.maxMemoryGb));
    await page.locator('[data-studio-tab="game"]').click();
    assert.ok((await page.locator('#edit-java-auto').boundingBox()).width < 60);
    await page.locator('[data-studio-tab="design"]').click();
    await page.screenshot({ path: path.join(output, 'instance.png') });
    await page.locator('#instance-form button[type="submit"]').click();
    const customized = (await page.evaluate(() => window.launcher.getState())).instances[0];
    assert.equal(customized.name, 'Renamed World');
    assert.equal(customized.accent, 'rose');
    assert.equal(customized.favorite, true);
    assert.equal(customized.note, 'Построить город над озером');
    assert.ok(customized.coverUrl);
    assert.ok(fs.existsSync(path.join(instance.directory, 'cover.jpg')));
    const coverLoads = await page.evaluate((url) => new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve(true);
      image.onerror = () => resolve(false);
      image.src = url;
    }), customized.coverUrl);
    assert.ok(coverLoads, 'Не загрузилась обложка сборки');

    await page.locator('.rail-button[data-view="settings"]').click();
    assert.equal(await page.locator('#memory-range').getAttribute('max'), String(initial.maxMemoryGb));
    assert.equal(await page.locator('#memory-gb').getAttribute('max'), String(initial.maxMemoryGb));
    assert.match(await page.locator('#show-snapshots').locator('..').textContent(), /Snapshots/);
    await page.locator('#player-name').fill('SmokePlayer');
    const memoryToUse = Math.min(6, initial.maxMemoryGb);
    await page.locator('#memory-gb').fill(String(memoryToUse));
    await page.locator('#save-settings').click();
    const updated = await page.evaluate(() => window.launcher.getState());
    assert.equal(updated.settings.playerName, 'SmokePlayer');
    assert.equal(updated.settings.memoryGb, memoryToUse);
    await assert.rejects(() => page.evaluate((maximum) => window.launcher.saveSettings({
      playerName: 'ChangedName', memoryGb: maximum + 1,
    }), initial.maxMemoryGb));
    assert.equal((await page.evaluate(() => window.launcher.getState())).settings.playerName, 'SmokePlayer');
    await page.locator('.rail-button[data-view="home"]').click();
    assert.equal(await page.locator('#capsule-note').textContent(), 'Построить город над озером');
    await page.reload();
    await page.locator('#hero-name').waitFor();
    assert.equal(await page.locator('#hero-name').textContent(), 'Renamed World');

    assert.equal(await page.locator('dialog[open]').count(), 0, 'Открыто модальное окно перед снимком');
    await page.locator('#toast').waitFor({ state: 'hidden' });
    await page.screenshot({ path: path.join(output, 'launcher.png'), fullPage: true });
    await page.locator('.rail-button[data-view="settings"]').click();
    await page.waitForTimeout(550);
    await page.screenshot({ path: path.join(output, 'settings.png'), fullPage: true });
    await page.locator('.rail-button[data-view="logs"]').click();
    await page.locator('#logs-content').waitFor({ state: 'visible' });
    await page.locator('.rail-button[data-view="home"]').click();
    await page.locator('#hero-edit').click();
    await page.locator('#remove-instance').click();
    await page.locator('#confirm-remove').click();
    const removed = await page.evaluate(() => window.launcher.getState());
    assert.equal(removed.instances.length, 0);
    assert.ok(!fs.existsSync(instance.directory));
    assert.deepEqual(errors, [], 'Ошибки интерфейса: ' + errors.join('; '));
    process.stdout.write('OK: версии, 3 загрузчика, CRUD сборки, изоляция файлов, настройки и интерфейс.\n');
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  process.stderr.write((error.stack || error) + '\n');
  process.exitCode = 1;
});
