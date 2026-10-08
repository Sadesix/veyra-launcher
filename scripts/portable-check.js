const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('playwright-core');

async function main() {
  const executable = path.resolve(process.argv[2] || 'dist/Veyra-Launcher-0.4.0-x64.exe');
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-portable-'));
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  // The portable wrapper does not forward inspector stderr to Playwright.
  // Connect to the actual application's renderer after self-extraction.
  const child = spawn(executable, ['--remote-debugging-port=' + port], {
    windowsHide: true, stdio: 'ignore',
    env: { ...process.env, VEYRA_TEST_DATA_DIR: dataDirectory },
  });
  let browser;
  let page;
  try {
    let endpoint = '';
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('Portable wrapper exited before the app opened');
      endpoint = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(1000) })
        .then((response) => response.json()).then((value) => value.webSocketDebuggerUrl).catch(() => '');
      if (endpoint) break;
      await delay(300);
    }
    assert.ok(endpoint, 'Portable application did not expose its renderer');
    browser = await chromium.connectOverCDP(endpoint);
    page = browser.contexts()[0].pages()[0];
    await page.locator('#profile-top').waitFor();
    const initial = await page.evaluate(() => window.launcher.getState());
    assert.equal(initial.appVersion, '0.4.0');
    assert.deepEqual(initial.settings.appearance, { transparency: 0, brightness: 100, blur: 18 });
    assert.equal(await page.locator('#greeting-name').textContent(), initial.account.name);
    assert.equal(initial.dataDirectory.toLowerCase(), dataDirectory.toLowerCase());
    assert.equal(await page.locator('#hero-edit use').getAttribute('href'), '#i-settings');
    await page.locator('#profile-top').click();
    assert.equal(await page.locator('[data-account-mode="microsoft"]').isVisible(), false);
    assert.equal(await page.locator('#microsoft-client-id').isVisible(), false);
    await page.locator('#profile-name-input').fill('PortableNick');
    await page.locator('#profile-name-input').press('Enter');
    await page.waitForFunction(() => document.getElementById('profile-chip-name').textContent === 'PortableNick');
    assert.equal((await page.evaluate(() => window.launcher.getState())).settings.playerName, 'PortableNick');
    await page.waitForFunction(() => !document.getElementById('profile-dialog').open);
    await page.locator('#create-top').click();
    await page.locator('#version-search').waitFor();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('create-dialog').open);
    process.stdout.write('OK: portable self-extraction, first launch, version, nickname, gears and hidden Microsoft UI.\n');
  } finally {
    if (page) await page.evaluate(() => window.launcher.closeWindow()).catch(() => {});
    await browser?.close().catch(() => {});
    if (child.exitCode === null) child.kill();
  }
}
main().catch((error) => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
