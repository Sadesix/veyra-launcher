const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');

async function main() {
  const workspace = path.join(__dirname, '..'), data = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-halloween-'));
  const game = path.join(data, 'instances', 'spooky');
  fs.mkdirSync(game, { recursive: true });
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
    playerName: 'Pumpkin', memoryGb: 1, selectedInstanceId: 'spooky',
    instances: [{ id: 'spooky', name: 'Тыквенная', directory: game, minecraftVersion: '1.21.1', versionId: '1.21.1', loader: 'fabric', loaderVersion: '0.16.0', accent: 'rose' }],
  }));
  const output = path.join(workspace, 'test-output'); fs.mkdirSync(output, { recursive: true });
  // Тема включается по календарю: проверка задаёт даты сама, поэтому реальный сезон не нужен.
  const app = await electron.launch({ executablePath: process.argv[2] ? path.resolve(process.argv[2]) : undefined, args: process.argv[2] ? [] : ['.'], cwd: workspace, env: { ...process.env, VEYRA_TEST_DATA_DIR: data, VEYRA_HALLOWEEN: 'season' }, timeout: 120000 });
  try {
    const page = await app.firstWindow(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const open = async (date, wait = true) => {
      await page.clock.setSystemTime(date);
      await page.reload();
      if (wait) await page.locator('#intro').waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.getElementById('hero-name').textContent === 'Тыквенная');
    };
    const halloween = () => page.evaluate(() => document.documentElement.classList.contains('is-halloween'));

    await page.waitForFunction(() => window.veyraHalloween && document.getElementById('hero-name').textContent === 'Тыквенная');
    // Границы сезона: с 15 октября по 2 ноября включительно.
    assert.equal(await page.evaluate(() => window.launcher.festive), 'season');
    assert.deepEqual(await page.evaluate(() => [[9, 14], [9, 15], [9, 31], [10, 2], [10, 3], [0, 1]].map(([month, day]) => window.veyraHalloween.inSeason(new Date(2026, month, day, 12)))),
      [false, true, true, true, false, false]);

    // В сезон тема включена сама: палитра, украшения, приветствие, фразы и переключатель.
    await page.clock.install({ time: new Date(2026, 9, 20, 20, 30) });
    await page.reload();
    await page.waitForTimeout(250);
    assert.equal(await halloween(), true, 'The theme must be on before the intro is shown');
    await page.screenshot({ path: path.join(output, 'halloween-intro.png') });
    await page.locator('#intro').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.getElementById('hero-name').textContent === 'Тыквенная');
    assert.equal(await page.locator('.wordmark').evaluate(node => getComputedStyle(node).color), 'rgb(236, 138, 58)');
    assert.equal(await page.locator('#greeting-time').textContent(), 'Жуткого вечера');
    assert.match(await page.locator('#greeting-note').textContent(), /Тыквы зажжены/);
    assert.ok((await page.evaluate(() => window.veyraHalloween.phrases)).includes(await page.locator('#splash').textContent()));
    for (const selector of ['.spooky-back .spooky-moon', '.spooky-front .spooky-spider', '.spooky-front .spooky-fog', '.hotbar-lantern.is-left', '.hotbar-lantern.is-right', '#hero-card .hero-spooky', '.wordmark-bat']) {
      assert.equal(await page.locator(selector).count(), 1, selector);
    }
    await page.waitForFunction(() => document.querySelectorAll('.spooky-bat').length > 0, null, { timeout: 8000 });
    assert.equal(await page.locator('#advancement small').textContent(), 'Жуткое достижение!');
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(output, 'halloween-home.png') });

    // Украшения не мешают: щелчок по сборке под туманом проходит, а паук уползает вверх.
    await page.locator('#home-instance-grid [data-instance-id="spooky"]').click();
    await page.locator('.spooky-spider').click({ force: true });
    await page.locator('.spooky-spider.is-climbing').waitFor();

    // Призрак: пойманный даёт секретное достижение.
    await page.evaluate(() => window.veyraHalloween.summonGhost());
    await page.waitForTimeout(1500);
    await page.locator('.spooky-ghost').dispatchEvent('click');
    for (const end = Date.now() + 10000; !(await page.evaluate(async () => (await window.launcher.getState()).achievements)).ghostbuster;) {
      if (Date.now() > end) throw new Error('The ghost did not give its achievement');
      await page.waitForTimeout(150);
    }
    await page.waitForFunction(() => document.getElementById('toast-text').textContent === 'Бу! Призрак пойман');
    await page.locator('.spooky-ghost').waitFor({ state: 'detached' });
    await page.keyboard.press('4');
    assert.equal(await page.locator('.trophy').count(), 35);
    assert.ok((await page.locator('.trophy strong').allTextContents()).includes('Сладость или гадость'));
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(output, 'halloween-trophies.png') });

    // Переключатель в настройках выключает тему сразу и помнит выбор после перезапуска.
    await page.keyboard.press('6');
    assert.equal(await page.locator('#halloween-row').isVisible(), true);
    assert.equal(await page.locator('#ui-halloween').isChecked(), true);
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(output, 'halloween-settings.png') });
    await page.locator('#ui-halloween').locator('..').click();
    assert.equal(await halloween(), false);
    assert.equal(await page.locator('.spooky-front, .spooky-back, .hotbar-lantern, .hero-spooky, .wordmark-bat').count(), 0);
    await page.keyboard.press('1');
    assert.match(await page.locator('#greeting-time').textContent(), /^Добр/);
    assert.equal(await page.locator('.wordmark').evaluate(node => getComputedStyle(node).color), 'rgb(210, 154, 138)');
    await open(new Date(2026, 9, 21, 9, 0));
    assert.equal(await halloween(), false, 'A switched-off theme stays off for the season');
    await page.keyboard.press('6');
    assert.equal(await page.locator('#ui-halloween').isChecked(), false);
    await page.locator('#ui-halloween').locator('..').click();
    assert.equal(await halloween(), true);
    await page.keyboard.press('1');
    assert.equal(await page.locator('#greeting-time').textContent(), 'Жуткого утра');

    // Хеллоуин и последний день сезона.
    await open(new Date(2026, 9, 31, 15, 0));
    assert.equal(await page.locator('#greeting-time').textContent(), 'Счастливого Хеллоуина');
    await open(new Date(2026, 10, 2, 23, 0));
    assert.equal(await halloween(), true);

    // Вне сезона нет ни темы, ни переключателя.
    await open(new Date(2026, 11, 10, 12, 0));
    assert.equal(await halloween(), false);
    assert.equal(await page.locator('.spooky-front').count(), 0);
    await page.keyboard.press('6');
    assert.equal(await page.locator('#halloween-row').isVisible(), false);
    assert.deepEqual(errors, []);
    process.stdout.write('OK: Halloween season 15 Oct – 2 Nov, on by default with palette, intro, moon, bats, spider, fog, lanterns and spooky texts; ghost achievement, season achievement, per-season switch that persists, hidden switch and plain theme outside the season.\n');
  } finally { await app.close(); }
}
main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
