const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');

async function main() {
  const workspace = path.join(__dirname, '..'), data = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-eggs-'));
  const game = path.join(data, 'instances', 'eggs');
  fs.mkdirSync(game, { recursive: true });
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
    playerName: 'EggNick', memoryGb: 1, selectedInstanceId: 'eggs',
    instances: [
      { id: 'eggs', name: 'Eggs', directory: game, minecraftVersion: '1.12.2', versionId: '1.12.2', loader: 'forge', loaderVersion: '14.23.5.2860' },
      { id: 'fabric', name: 'Fabric', directory: path.join(data, 'instances', 'fabric'), minecraftVersion: '1.21.1', versionId: '1.21.1', loader: 'fabric', loaderVersion: '0.16.0' },
    ],
  }));
  const output = path.join(workspace, 'test-output'); fs.mkdirSync(output, { recursive: true });
  const app = await electron.launch({ executablePath: process.argv[2] ? path.resolve(process.argv[2]) : undefined, args: process.argv[2] ? [] : ['.'], cwd: workspace, env: { ...process.env, VEYRA_TEST_DATA_DIR: data }, timeout: 120000 });
  try {
    const page = await app.firstWindow(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.locator('#intro').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.getElementById('hero-name').textContent === 'Eggs');
    const earned = () => page.evaluate(async () => (await window.launcher.getState()).achievements);
    const waitTrophy = async id => {
      for (const end = Date.now() + 15000; !(await earned())[id];) {
        if (Date.now() > end) throw new Error('Achievement ' + id + ' was not unlocked');
        await page.waitForTimeout(150);
      }
    };

    // Обычные достижения открываются по состоянию: сборка на 1.12.2 — «Олдскул».
    await waitTrophy('old-school');
    assert.equal((await earned()).polyglot, undefined, 'Two loaders are not enough for the polyglot');

    // До открытия секретное достижение выглядит как «???» с намёком.
    await page.keyboard.press('4');
    assert.equal(await page.locator('.trophy').count(), 33);
    assert.equal(await page.locator('.trophy.is-secret').count(), 10);
    assert.deepEqual(await page.locator('.trophy.is-secret strong').allTextContents(), Array(10).fill('???'));
    await page.keyboard.press('1');

    // Код Konami: не срабатывает в поле ввода, срабатывает на странице.
    const konami = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
    await page.locator('#search-input').focus();
    for (const key of konami) await page.keyboard.press(key);
    await page.waitForTimeout(400);
    assert.equal((await earned()).konami, undefined, 'Typing in a field must not trigger the code');
    await page.locator('#search-input').fill(''); await page.locator('#search-input').blur();
    for (const key of konami) await page.keyboard.press(key);
    await waitTrophy('konami');
    assert.equal(await page.locator('.block-rain').count(), 1, 'Blocks rain after the code');
    // Уведомления идут по очереди: сначала «Первый блок» и «Олдскул», затем код.
    await page.waitForFunction(() => !document.getElementById('advancement').hidden && document.getElementById('advancement-title').textContent === 'Тридцать жизней', null, { timeout: 20000 });
    await page.locator('.block-rain').waitFor({ state: 'detached', timeout: 8000 });

    // Экран отладки F3.
    await page.keyboard.press('F3');
    await page.locator('#debug-screen').waitFor({ state: 'visible' });
    assert.match(await page.locator('#debug-left').textContent(), /Veyra 0\.8\.1/);
    assert.match(await page.locator('#debug-left').textContent(), /Сборок: 2/);
    await waitTrophy('debug');
    await page.keyboard.press('F3');
    await page.locator('#debug-screen').waitFor({ state: 'hidden' });

    // Змейка: набрать snake, поиграть до стены, начать заново; цифры не переключают разделы.
    for (const key of 'snake') await page.keyboard.press(key);
    await page.locator('#snake-dialog').waitFor({ state: 'visible' });
    await waitTrophy('snake');
    assert.equal(await page.locator('#snake-message').textContent(), 'Стрелки или WASD — начать');
    await page.keyboard.press('ArrowUp');
    await page.waitForFunction(() => document.getElementById('snake-message').textContent.startsWith('Конец игры'), null, { timeout: 10000 });
    await page.keyboard.press('2');
    assert.equal(await page.locator('[data-page="home"]').isVisible(), true, 'Keys inside the game do not switch sections');
    await page.waitForTimeout(400); await page.screenshot({ path: path.join(output, 'snake.png') });
    await page.locator('#snake-restart').click();
    assert.equal(await page.locator('#snake-score').textContent(), '0');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('snake-dialog').open);

    // Стук по логотипу.
    for (let index = 0; index < 10; index++) await page.locator('.rail-logo').click();
    await waitTrophy('woodpecker');

    // Фразы: крипер взрывается, пятнадцать фраз — «Болтун».
    for (let index = 0; index < 400; index++) {
      const got = await earned();
      if (got.creeper && got.chatterbox) break;
      if (await page.locator('#splash').textContent() === 'Крипер? Показалось.') { await page.locator('#splash').dispatchEvent('click'); await page.waitForTimeout(500); }
      else await page.locator('#splash').dispatchEvent('click');
    }
    await waitTrophy('creeper');
    await waitTrophy('chatterbox');

    await page.keyboard.press('4');
    await page.locator('#trophies-page').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelectorAll('.trophy.is-secret').length === 4, null, { timeout: 10000 })
      .catch(async error => { throw new Error(error.message + ' ' + JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.trophy.is-secret small')].length))); });
    assert.ok((await page.locator('.trophy.is-unlocked strong').allTextContents()).includes('Тридцать жизней'));
    await page.waitForTimeout(500); await page.screenshot({ path: path.join(output, 'trophies-secret.png') });

    // Хеллоуин: часы меняют значок и открывают своё достижение.
    await page.clock.install({ time: new Date(2026, 9, 31, 20, 0) });
    await page.reload();
    await page.locator('#intro').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#clock-icon').getAttribute('href'), '#i-pumpkin');
    await page.locator('#world-clock').click();
    await waitTrophy('pumpkin');
    assert.equal((await earned())['new-year'], undefined);
    assert.deepEqual(errors, []);
    process.stdout.write('OK: 33 achievements with 10 secret ones, Konami code with block rain (ignored in fields), F3 debug screen, hidden snake with its own keys, logo knocks, exploding creeper splash, chatterbox and the Halloween clock.\n');
  } finally { await app.close(); }
}
main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
