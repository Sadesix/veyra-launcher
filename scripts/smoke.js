const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');

async function main() {
  const executablePath = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  const app = await electron.launch({
    executablePath,
    args: executablePath ? [] : ['.'],
    cwd: path.join(__dirname, '..'),
    timeout: 120000,
  });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.locator('#main-action').waitFor();

    const state = await page.evaluate(() => window.launcher.getState());
    assert.equal(typeof state.settings.playerName, 'string');
    assert.ok(Array.isArray(state.versions));

    await page.locator('.nav-item[data-view="settings"]').click();
    await page.locator('#java-path').waitFor({ state: 'visible' });
    await page.locator('.nav-item[data-view="play"]').click();

    const versions = await page.evaluate(() => window.launcher.refreshVersions());
    assert.ok(versions.length > 0, 'Список версий пуст');
    assert.ok(versions.some((version) => version.type === 'release'));

    const output = path.join(__dirname, '..', 'test-output');
    fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'launcher.png'), fullPage: true });
    await page.locator('.nav-item[data-view="settings"]').click();
    await page.screenshot({ path: path.join(output, 'settings.png'), fullPage: true });
    assert.deepEqual(errors, [], `Ошибки интерфейса: ${errors.join('; ')}`);
    process.stdout.write(`OK: ${versions.length} версий, интерфейс и IPC работают.\n`);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
