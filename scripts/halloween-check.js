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
    assert.equal(await page.locator('.intro-bat .bat-strip use').count(), 12, 'Each intro bat flies with four frames');
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

    // Мыши машут крыльями по кадрам: полоска «вверх, середина, вниз, середина» сдвигается целыми кадрами, без сплющивания.
    assert.deepEqual(await page.locator('.spooky-bat .bat-strip').first().evaluate(strip => [...strip.querySelectorAll('use')].map(use => use.getAttribute('href'))), ['#i-bat', '#i-batmid', '#i-batdown', '#i-batmid']);
    assert.equal(await page.locator('.wordmark-bat .bat-strip use').count(), 4);
    assert.equal(await page.evaluate(() => ['bat', 'batmid', 'batdown'].every(name => document.querySelector('#i-' + name + ' path'))), true, 'Every bat frame is drawn');
    const wings = async selector => {
      const seen = new Set();
      for (let sample = 0; sample < 24; sample++) {
        const frame = await page.evaluate(selector => {
          const strip = document.querySelector(selector);
          if (!strip) return null;
          const matrix = new DOMMatrix(getComputedStyle(strip).transform), size = strip.parentElement.getBoundingClientRect().width;
          if (matrix.a !== 1 || matrix.d !== 1 || matrix.b || matrix.c) return 'squashed';
          return Math.round(-matrix.e / size * 100) / 100;
        }, selector);
        if (frame !== null) seen.add(frame);
        await page.waitForTimeout(35);
      }
      return [...seen].sort();
    };
    const perched = await wings('.wordmark-bat .bat-strip');
    assert.ok(perched.length >= 3 && perched.every(frame => [0, 1, 2, 3].includes(frame)), 'The wordmark bat flaps through whole frames: ' + perched);
    const flying = await wings('.spooky-bat:not(.is-gliding) .bat-strip');
    assert.ok(flying.length >= 3 && flying.every(frame => [0, 1, 2, 3].includes(frame)), 'A flying bat flaps through whole frames: ' + flying);
    assert.equal(await page.evaluate(() => [...document.styleSheets].some(sheet => [...sheet.cssRules].some(rule => /scaleY/.test(rule.cssText) && /bat/i.test(rule.cssText)))), false, 'No bat is squashed with scaleY any more');

    // Паук висит на узле правой паутины: верх нити стоит на месте, качается только её длина, а паук держится за конец нити.
    const spider = () => page.evaluate(() => {
      const thread = document.querySelector('.spooky-thread').getBoundingClientRect(), body = document.querySelector('.spooky-spider').getBoundingClientRect();
      return { x: thread.left + thread.width / 2, top: thread.top, length: thread.height, spider: body.top, middle: body.left + body.width / 2 };
    });
    const onWeb = () => page.evaluate(() => {
      const thread = document.querySelector('.spooky-thread').getBoundingClientRect(), web = document.querySelector('.spooky-corner .spooky-web.is-right'), box = web.getBoundingClientRect(), path = web.querySelector('path');
      // Правая паутина отражена, поэтому точку в координаты рисунка 120 × 120 переводим вручную; допуск — пиксель.
      const x = thread.left + thread.width / 2, y = thread.top;
      return x > innerWidth / 2 && [-1, 0, 1].some(dx => [-1, 0, 1].some(dy => path.isPointInStroke(new DOMPoint((box.right - x - dx) / box.width * 120, (y + dy - box.top) / box.height * 120))));
    });
    const holds = item => Math.abs(item.spider - (item.top + item.length - 3)) <= 1 && Math.abs(item.middle - item.x) <= 1;
    // Щелчок: паук сматывает нить, прячется в паутине (верх нити на месте) и спускается снова.
    const scare = async () => {
      const hanging = await spider();
      await page.locator('.spooky-spider').click({ force: true });
      await page.locator('.spooky-drop.is-climbing').waitFor({ state: 'attached' });
      await page.waitForTimeout(1600);
      const hidden = await spider();
      assert.ok(hidden.length <= 4 && hidden.top === hanging.top, 'The spider climbs up into the web: ' + JSON.stringify(hidden));
      for (const end = Date.now() + 6000; (await spider()).length < 30;) {
        if (Date.now() > end) throw new Error('The spider did not come back down');
        await page.waitForTimeout(150);
      }
      assert.equal(await page.locator('.spooky-drop.is-climbing').count(), 0);
    };
    assert.equal(await onWeb(), true, 'The spider thread starts on a strand of the right cobweb');
    const sway = [];
    for (let sample = 0; sample < 6; sample++) { sway.push(await spider()); await page.waitForTimeout(460); }
    assert.ok(sway.every(item => item.top === sway[0].top && item.x === sway[0].x), 'The thread top stays tied to the web while the spider bobs');
    assert.ok(Math.max(...sway.map(item => item.length)) - Math.min(...sway.map(item => item.length)) >= 4, 'The spider bobs by changing the thread length');
    assert.ok(sway.every(holds), 'The spider holds the end of its thread');
    assert.ok(sway.every(item => Number.isInteger(item.length) && Number.isInteger(item.top)), 'The thread is pixel-crisp');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(output, 'halloween-home.png') });

    // Украшения не мешают: щелчок по сборке под туманом проходит, а паук сматывает нить, прячется в паутине и спускается снова.
    await page.locator('#home-instance-grid [data-instance-id="spooky"]').click();
    await scare();

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

    // Без лишнего движения мыши не летают и не машут крыльями (виден средний кадр), а паук не качается.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(new Date(2026, 9, 22, 21, 0));
    await page.waitForTimeout(3200);
    assert.equal(await page.locator('.spooky-bat, .intro-bat').count(), 0);
    assert.deepEqual(await wings('.wordmark-bat .bat-strip'), [1]);
    assert.equal(await page.locator('.spooky-drop').evaluate(node => getComputedStyle(node).animationName), 'none');
    await page.emulateMedia({ reducedMotion: null });

    // Движок без @property и round(): правила убраны так, как их не увидел бы старый браузер, а тема включена заново.
    // Паук всё равно висит на узле паутины (без качания, чтобы нить не прыгала), держится за конец нити и прячется по щелчку.
    assert.equal(await page.evaluate(() => {
      let removed = 0;
      delete CSS.registerProperty;
      for (const sheet of document.styleSheets) {
        if (!/halloween\.css$/.test(sheet.href || '')) continue;
        for (let index = sheet.cssRules.length - 1; index >= 0; index--) {
          const rule = sheet.cssRules[index];
          if (rule instanceof CSSPropertyRule || rule instanceof CSSSupportsRule && /round\(/.test(rule.conditionText)) { sheet.deleteRule(index); removed++; }
        }
      }
      const toggle = document.getElementById('ui-halloween');
      for (const on of [false, true]) { toggle.checked = on; toggle.dispatchEvent(new Event('change')); }
      return removed;
    }), 3, 'Two @property rules and the round() block are removed');
    assert.equal(await page.locator('.spooky-drop').evaluate(node => node.classList.contains('is-still') && getComputedStyle(node).animationName), 'none');
    assert.equal(await onWeb(), true, 'Without @property and round() the thread still starts on the cobweb');
    const still = [await spider()];
    await page.waitForTimeout(1200);
    still.push(await spider());
    assert.ok(still[0].length >= 30 && still.every(holds) && JSON.stringify(still[0]) === JSON.stringify(still[1]), 'Without @property the spider hangs still at the end of its thread: ' + JSON.stringify(still));
    await scare();

    // Вне сезона нет ни темы, ни переключателя.
    await open(new Date(2026, 11, 10, 12, 0));
    assert.equal(await halloween(), false);
    assert.equal(await page.locator('.spooky-front').count(), 0);
    await page.keyboard.press('6');
    assert.equal(await page.locator('#halloween-row').isVisible(), false);
    assert.deepEqual(errors, []);
    process.stdout.write('OK: Halloween season 15 Oct – 2 Nov, on by default with palette, intro, moon, frame-animated bats, spider hanging from the web (also without @property and round()), fog, lanterns and spooky texts; ghost achievement, season achievement, per-season switch that persists, calm mode, hidden switch and plain theme outside the season.\n');
  } finally { await app.close(); }
}
main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
