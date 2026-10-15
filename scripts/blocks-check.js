const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const { _electron: electron } = require('playwright-core');
const { serverConfig, serverProperties, importProperties } = require('../main/server-config');

// Маленький настоящий PNG для галереи скриншотов.
function png(width, height, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_value, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = bytes => { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(type, 4, 'ascii'); const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data]))); return Buffer.concat([head, data, tail]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_value, index) => [r, g, b][index % 3])]);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}
async function freePort() { const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '0.0.0.0', resolve)); const { port } = probe.address(); await new Promise(resolve => probe.close(resolve)); return port; }

async function main() {
  // Настройки сервера: проверка полей, запись и чтение server.properties.
  assert.throws(() => serverConfig({ port: 80 }, { strict: true }), /Порт/);
  assert.throws(() => serverConfig({ levelName: '../world' }, { strict: true }), /Название мира/);
  assert.throws(() => serverConfig({ motd: 'две\nстроки' }, { strict: true }), /Описание/);
  assert.throws(() => serverConfig({ memoryGb: 9 }, { strict: true, maxMemoryGb: 8 }), /Память сервера/);
  assert.equal(serverConfig({ port: 80, gamemode: 'god' }).port, 25565, 'Saved values that are no longer valid fall back to defaults');
  const sample = serverConfig({ levelName: 'Мой мир', motd: 'Привет, друзья!', seed: 'veyra', gamemode: 'creative', difficulty: 'hard', hardcore: true, maxPlayers: 12, viewDistance: 6 }, { strict: true });
  const written = serverProperties(sample, 25570);
  assert.equal(written['server-port'], '25570'); assert.equal(written['online-mode'], 'false'); assert.match(written.motd, /^[\x20-\x7e]+$/, 'Non-Latin text must be escaped for old and new servers');
  assert.equal(serverProperties(serverConfig({}), 25565).motd, undefined, 'An empty description keeps the value already stored by the server');
  assert.deepEqual(importProperties('#Minecraft server properties\n' + Object.entries(written).map(([key, value]) => key + '=' + value).join('\n') + '\nunknown=1\n'), { ...sample, port: 25570 });

  const workspace = path.join(__dirname, '..'), data = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-blocks-')), port = await freePort();
  const game = path.join(data, 'instances', 'blocks'), versionRoot = path.join(game, 'versions', '26.3'); fs.mkdirSync(versionRoot, { recursive: true });
  const version = { id: '26.3', type: 'release', mainClass: 'net.minecraft.client.main.Main', assets: '26.3', javaVersion: { majorVersion: 25, component: 'java-runtime-epsilon' }, libraries: [], downloads: { client: {}, server: { url: 'https://fixture.invalid/server.jar', sha1: createHash('sha1').update('fixture server').digest('hex') } }, arguments: { jvm: ['-classpath', '${classpath}'], game: ['--username', '${auth_player_name}'] } };
  fs.writeFileSync(path.join(versionRoot, '26.3.json'), JSON.stringify(version)); fs.writeFileSync(path.join(versionRoot, '26.3.jar'), 'fixture');
  fs.writeFileSync(path.join(game, '.veyra-instance-ready.json'), JSON.stringify({ id: 'blocks', versionId: '26.3' }));
  fs.mkdirSync(path.join(game, 'screenshots'), { recursive: true }); fs.writeFileSync(path.join(game, 'screenshots', '2026-10-13_12.00.00.png'), png(64, 36, [142, 174, 145]));
  fs.writeFileSync(path.join(game, 'screenshots', 'notes.txt'), 'not a screenshot');
  fs.mkdirSync(path.join(game, 'saves', 'Долина'), { recursive: true }); fs.writeFileSync(path.join(game, 'saves', 'Долина', 'level.dat'), 'fixture');
  // Уже существующий server.properties становится исходными значениями конструктора.
  fs.mkdirSync(path.join(game, '.veyra-server'), { recursive: true }); fs.writeFileSync(path.join(game, '.veyra-server', 'server.properties'), 'difficulty=hard\nmax-players=5\nspawn-protection=3\n');
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ playerName: 'BlockNick', memoryGb: 1, selectedInstanceId: 'blocks', javaPath: path.join(process.env.VEYRA_JAVA_HOME || path.join(process.env.APPDATA, 'veyra-launcher', 'runtimes', 'java-runtime-epsilon'), 'bin', 'java.exe'), instances: [{ id: 'blocks', name: 'Blocks', directory: game, minecraftVersion: '26.3', versionId: '26.3', loader: 'vanilla', memoryGb: 1, playedMs: 2 * 3600000 + 1800000, launchCount: 3 }] }));
  fs.writeFileSync(path.join(data, 'version-manifest.json'), JSON.stringify({ versions: [{ id: '26.3', type: 'release', url: 'https://fixture.invalid/version.json' }] }));
  const options = { executablePath: process.argv[2] ? path.resolve(process.argv[2]) : undefined, args: process.argv[2] ? [] : ['.'], cwd: workspace, env: { ...process.env, VEYRA_TEST_DATA_DIR: data }, timeout: 120000 };
  let app = await electron.launch(options);
  const output = path.join(workspace, 'test-output'); fs.mkdirSync(output, { recursive: true });
  try {
    let page = await app.firstWindow(); const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => document.getElementById('hero-name').textContent === 'Blocks');
    await app.evaluate(({ app }, fixtureVersion) => {
      const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json'), childProcess = require('node:child_process'), originalSpawn = childProcess.spawn, originalFetch = globalThis.fetch;
      globalThis.fetch = (url, init) => {
        const value = String(url);
        if (value.includes('fixture.invalid/version') || value.includes('piston-meta.mojang.com')) return Promise.resolve(new Response(JSON.stringify(fixtureVersion)));
        if (value === 'https://fixture.invalid/server.jar') return Promise.resolve(new Response('fixture server'));
        return originalFetch(url, init);
      };
      // Заменён только Java-сервер: порт, stdin, журнал и остановка настоящие.
      const script = "const fs=require('fs'),net=require('net'),port=Number(/server-port=(\\d+)/.exec(fs.readFileSync('server.properties','utf8'))[1]);const s=net.createServer();const say=t=>console.log('[12:00:00] [Server thread/INFO]: '+t);s.listen(port,'0.0.0.0',()=>{console.log('Done (0.1s)! For help, type \"help\"');say('Alex joined the game');say('<Alex> Bob joined the game');});let rest='';process.stdin.on('data',b=>{rest+=b;const lines=rest.split('\\n');rest=lines.pop();for(const line of lines){if(line==='stop'){s.close(()=>process.exit(0));return;}if(line==='kick Alex')say('Alex left the game');else say('command '+line);}});";
      childProcess.spawn = (command, args, spawnOptions) => args.includes('server.jar') ? originalSpawn(process.execPath, ['-e', script], { ...spawnOptions, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }) : originalSpawn(command, args, spawnOptions);
    }, version);
    await page.evaluate(async () => { window.__blocks = await window.launcher.getState(); window.launcher.onEvent(event => { if (event.type === 'state') window.__blocks = event.state; }); });

    // Заставка с логотипом уходит сама, первое достижение всплывает сразу после неё.
    assert.equal(await page.locator('.intro-logo').evaluate(image => image.complete && image.naturalWidth > 0), true);
    await page.locator('#intro').waitFor({ state: 'hidden' });
    await page.locator('#advancement').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.body.classList.contains('is-booting'));

    // Оформление: шрифты, логотип, палитра, хотбар и подсказка предмета.
    assert.equal(await page.evaluate(() => document.fonts.check('18px Monocraft')), true, 'The bundled pixel font must load');
    assert.equal(await page.evaluate(() => document.fonts.check('14px DotumChe')), true, 'The text font must load');
    assert.match(await page.locator('#hero-description').evaluate(node => getComputedStyle(node).fontFamily), /^"?DotumChe/);
    assert.match(await page.locator('#hero-name').evaluate(node => getComputedStyle(node).fontFamily), /^"?Monocraft/);
    assert.equal(await page.locator('.rail-logo img').evaluate(image => image.complete && image.naturalWidth > 0 && image.src.endsWith('veyra-emblem-96.png')), true);
    await page.locator('#hero-server').hover(); await page.waitForTimeout(300);
    assert.equal(await page.locator('#hero-server svg').evaluate(node => getComputedStyle(node).transform), 'none', 'Icons stay still under the pointer');
    assert.equal(await page.locator('#home-instance-grid .instance-card').first().evaluate(node => getComputedStyle(node).transform), 'none');
    assert.equal(await page.locator('.wordmark').evaluate(node => getComputedStyle(node).color), 'rgb(210, 154, 138)');
    assert.equal(await page.locator('#main-action').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(210, 154, 138)');
    assert.equal(await page.locator('.memory-capsule').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(60, 52, 62)');
    assert.equal(await page.locator('.sign').evaluate(node => getComputedStyle(node).color), 'rgb(23, 19, 26)');
    assert.equal(await page.evaluate(() => window.veyraIcons.every(name => document.getElementById('i-' + name)?.querySelector('path'))), true, 'Every pixel icon needs a drawing');
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('use')].every(use => document.querySelector(use.getAttribute('href')))), true, 'Every icon reference must resolve');
    assert.equal(await page.locator('#xp-level').textContent(), '2', 'The level counts whole hours in the game');
    await page.locator('#home-instance-grid [data-instance-id="blocks"]').hover();
    await page.locator('#tooltip').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#tooltip-title').textContent(), 'Blocks');
    assert.match(await page.locator('#tooltip-lore').textContent(), /Vanilla · Minecraft 26\.3[\s\S]*Сыграно: 2 ч 30 мин/);
    await page.mouse.move(600, 30); await page.locator('#tooltip').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelectorAll('#home-worlds .world-row').length === 1);
    assert.match(await page.locator('#home-worlds').textContent(), /Долина/);
    const slots = ['home', 'instances', 'server', 'trophies', 'logs', 'settings'];
    for (const [index, view] of slots.entries()) {
      await page.keyboard.press(String(index + 1));
      assert.equal(await page.locator('[data-page="' + view + '"]').isVisible(), true, 'Key ' + (index + 1) + ' opens ' + view);
      assert.equal(await page.locator('.rail-button.is-active').getAttribute('data-view'), view);
    }
    assert.notEqual(await page.locator('#rail-nav').evaluate(node => node.style.getPropertyValue('--nav-x')), '0px');
    // Переход: прежний раздел уезжает поверх нового и исчезает сам, без пустого кадра.
    await page.waitForFunction(() => !document.querySelector('.is-leaving'));
    await page.keyboard.press('5');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-page]')].filter(item => !item.hidden).map(item => item.dataset.page + (item.classList.contains('is-leaving') ? ':leaving' : ''))), ['logs', 'settings:leaving']);
    await page.waitForFunction(() => !document.querySelector('.is-leaving') && !document.querySelector('.content').classList.contains('is-switching'));
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-page]')].filter(item => !item.hidden).map(item => item.dataset.page)), ['logs']);
    assert.equal(await page.locator('#settings-page').evaluate(node => node.getAttribute('style') || ''), '', 'The finished transition leaves no inline placement');
    await page.keyboard.press('1');

    // Фраза на главной скрывается из своего меню и возвращается в настройках.
    await page.locator('#splash').dispatchEvent('contextmenu');
    assert.equal(await page.locator('#build-context-menu [role="menuitem"]').count(), 2);
    await page.locator('#build-context-menu [data-action="eye"]').click();
    assert.equal(await page.locator('#splash').isVisible(), false);
    await page.locator('#toast-undo').click(); await page.locator('#splash').waitFor({ state: 'visible' });
    await page.locator('#splash').dispatchEvent('contextmenu'); await page.locator('#build-context-menu [data-action="eye"]').click();
    await page.keyboard.press('6'); assert.equal(await page.locator('#ui-splash').isChecked(), false);
    await page.locator('#ui-splash').locator('..').click(); await page.keyboard.press('1'); await page.locator('#splash').waitFor({ state: 'visible' });
    await page.locator('#search-input').fill('3'); await page.locator('#search-input').press('3');
    assert.equal(await page.locator('[data-page="home"]').isVisible(), true, 'Digits typed into a field must not switch sections');
    await page.locator('#search-input').fill(''); await page.locator('#search-input').blur();

    // Достижения открываются по сохранённой истории и переживают перезапуск.
    await page.waitForFunction(() => Object.keys(window.__blocks.achievements).length >= 3);
    await page.keyboard.press('4');
    assert.deepEqual(Object.keys((await page.evaluate(() => window.launcher.getState())).achievements).sort(), ['first-build', 'first-launch', 'hour']);
    assert.equal(await page.locator('.trophy.is-unlocked').count(), 3); assert.equal(await page.locator('.trophy').count(), 35);
    assert.equal(await page.locator('#trophy-count').textContent(), '3 из 35');
    assert.equal(await page.locator('#stats-playtime').textContent(), '2 ч 30 мин'); assert.equal(await page.locator('.stat-bar').count(), 1);
    await assert.rejects(page.evaluate(() => window.launcher.unlockAchievements('host')));
    assert.equal((await page.evaluate(() => window.launcher.unlockAchievements(['../x', 'hour']))).hour.length > 10, true);
    await page.waitForTimeout(600); await page.screenshot({ path: path.join(output, 'trophies.png') });

    // Выключенные достижения: слот и уведомления скрыты, клавиши сдвигаются, счёт идёт в фоне.
    await page.locator('#advancement').waitFor({ state: 'hidden' });
    await page.keyboard.press('6'); await page.locator('#ui-trophies').locator('..').click();
    assert.equal(await page.locator('.rail-button[data-view="trophies"]').isVisible(), false);
    assert.deepEqual(await page.locator('.rail-nav .rail-button:not([hidden]) kbd').allTextContents(), ['1', '2', '3', '4', '5']);
    await page.keyboard.press('4'); assert.equal(await page.locator('[data-page="logs"]').isVisible(), true, 'With achievements off key 4 is the journal');
    await page.keyboard.press('5'); assert.equal(await page.locator('[data-page="settings"]').isVisible(), true);

    // Скриншоты сборки: галерея в студии и обложка из кадра.
    await page.keyboard.press('1'); await page.locator('#hero-edit').click(); await page.locator('[data-studio-tab="shots"]').click();
    await page.waitForFunction(() => { const image = document.querySelector('.shot img'); return image && image.complete && image.naturalWidth > 0; });
    assert.equal(await page.locator('.shot').count(), 1, 'Only PNG screenshots are listed');
    await assert.rejects(page.evaluate(() => window.launcher.coverFromScreenshot('blocks', '..\\\\.veyra-instance-ready.json')), /Некорректное имя/);
    await assert.rejects(page.evaluate(() => window.launcher.openScreenshot('blocks', 'missing.png')), /не найден/);
    await page.locator('.shot').hover(); await page.locator('.shot .button-primary').click();
    await page.waitForFunction(() => document.getElementById('studio-cover-name').textContent === 'Своя обложка');
    assert.equal((await page.evaluate(() => window.launcher.getState())).instances[0].coverFile, 'cover.png'); assert.ok(fs.existsSync(path.join(game, 'cover.png')));
    await page.waitForFunction(() => window.__blocks.achievements.artist);
    assert.equal(await page.locator('#advancement').isVisible(), false, 'A hidden achievement is recorded without a notification');
    // Копия кадра в буфер и избранное.
    await page.locator('.shot').hover(); await page.locator('.shot .shot-copy').click();
    await page.waitForFunction(() => document.getElementById('toast-text').textContent === 'Скриншот скопирован');
    assert.deepEqual(await app.evaluate(async ({ clipboard }) => { const bytes = Buffer.from(await (await (await clipboard.read())[0].getType('image/png')).arrayBuffer()); return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]; }), [64, 36], 'The clipboard holds the screenshot image');
    assert.equal(await page.locator('.shot .shot-star').getAttribute('aria-pressed'), 'false');
    await page.locator('.shot .shot-star').click(); await page.locator('.shot.is-favorite').waitFor();
    assert.equal(await page.locator('.shot .shot-star').getAttribute('aria-pressed'), 'true'); assert.match(await page.locator('#shots-hint').textContent(), /избранных: 1/);
    assert.deepEqual((await page.evaluate(() => window.launcher.getState())).instances[0].favoriteShots, ['2026-10-13_12.00.00.png']);
    await assert.rejects(page.evaluate(() => window.launcher.favoriteScreenshot('blocks', '..\\secret.png', true)), /Некорректное имя/);
    await assert.rejects(page.evaluate(() => window.launcher.copyScreenshot('blocks', 'missing.png')), /не найден/);
    await page.waitForTimeout(500); await page.screenshot({ path: path.join(output, 'studio-screenshots.png') });
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.getElementById('instance-dialog').open);

    // Конструктор сервера: значения из server.properties, проверка полей, сохранение и запуск.
    await page.locator('#hero-server').click();
    await page.waitForFunction(() => document.getElementById('server-max-players').value === '5');
    assert.equal(await page.locator('[data-difficulty="hard"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#server-card-name').textContent(), 'Blocks'); assert.equal(await page.locator('#server-memory-value').textContent(), 'Авто · 1 ГБ');
    await page.locator('#server-motd').fill('Привет из Veyra'); assert.equal(await page.locator('#server-card-motd').textContent(), 'Привет из Veyra');
    await page.locator('#server-level-name').fill('Мир друзей'); await page.locator('#server-seed').fill('veyra');
    await page.locator('[data-gamemode="creative"]').click(); await page.locator('#server-flight').check();
    await page.locator('#server-max-players').fill('6'); assert.equal(await page.locator('#server-card-max').textContent(), '6');
    assert.equal(await page.locator('#server-start').isDisabled(), true, 'The server cannot start before the EULA is accepted');
    await page.locator('#server-eula').check();
    await page.locator('#server-port').fill('80'); await page.locator('#server-start').click();
    assert.match(await page.locator('#server-builder .field-error').textContent(), /Минимальное значение/); assert.equal((await page.evaluate(() => window.launcher.getState())).server, null);
    await page.locator('#server-port').fill(String(port)); assert.equal(await page.locator('#server-local-address').textContent(), '127.0.0.1:' + port);
    await page.waitForTimeout(400); await page.screenshot({ path: path.join(output, 'server-builder.png') });
    await page.locator('#server-start').click();
    await page.waitForFunction(() => window.__blocks.server?.status === 'ready', null, { timeout: 30000 });
    let state = await page.evaluate(() => window.launcher.getState());
    assert.equal(state.server.port, port); assert.equal(state.server.memoryGb, 1); assert.equal(state.server.config.gamemode, 'creative');
    assert.deepEqual(state.instances[0].serverConfig, { levelName: 'Мир друзей', seed: 'veyra', gamemode: 'creative', difficulty: 'hard', hardcore: false, allowFlight: true, maxPlayers: 6, viewDistance: 10, motd: 'Привет из Veyra', port, memoryGb: null });
    const properties = fs.readFileSync(path.join(game, '.veyra-server', 'server.properties'), 'utf8');
    for (const line of ['server-port=' + port, 'gamemode=creative', 'difficulty=hard', 'max-players=6', 'allow-flight=true', 'level-seed=veyra', 'online-mode=false', 'spawn-protection=3']) assert.ok(properties.split(/\r?\n/).includes(line), line);
    assert.deepEqual(importProperties(properties).motd, 'Привет из Veyra'); assert.equal(importProperties(properties).levelName, 'Мир друзей');
    await new Promise((resolve, reject) => { const socket = net.connect(port, '127.0.0.1'); socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('The configured port did not accept a connection')); }); socket.once('connect', () => { socket.destroy(); resolve(); }); socket.once('error', reject); });
    await assert.rejects(page.evaluate(() => window.launcher.saveServerConfig('blocks', { port: 25570 })), /Остановите сервер/);

    // Живая консоль: игроки из журнала, команды и история.
    assert.equal(await page.locator('#server-builder').isVisible(), false); assert.equal(await page.locator('#server-console').isVisible(), true);
    await page.waitForFunction(() => document.querySelectorAll('.server-player').length === 1);
    assert.deepEqual(state.server.players.length <= 1, true); assert.equal(await page.locator('.server-player strong').textContent(), 'Alex', 'Chat lines must not add players');
    assert.equal(await page.locator('#server-card-players').textContent(), '1'); assert.equal(await page.locator('#server-lamp').getAttribute('data-status'), 'ready');
    assert.equal(await page.locator('.rail-button[data-view="server"]').evaluate(node => node.classList.contains('has-alert')), true);
    await page.locator('#server-command').fill('/say Привет'); await page.locator('#server-command').press('Enter');
    await page.waitForFunction(() => document.getElementById('server-log').textContent.includes('command say Привет'));
    assert.match(await page.locator('#server-log .log-command').first().textContent(), /^> say Привет/);
    await page.locator('#server-command').press('ArrowUp'); assert.equal(await page.locator('#server-command').inputValue(), '/say Привет');
    await page.locator('#server-command').fill('');
    await page.locator('#server-quick [data-command="save-all"]').click();
    await page.waitForFunction(() => document.getElementById('server-log').textContent.includes('command save-all'));
    await assert.rejects(page.evaluate(() => window.launcher.sendServerCommand('say one\nstop')), /одна строка/);
    await page.locator('#server-copy').click(); assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), '127.0.0.1:' + port);
    await page.waitForTimeout(400); await page.screenshot({ path: path.join(output, 'server-console.png') });
    await page.locator('.server-player button').last().click();
    await page.waitForFunction(() => document.querySelectorAll('.server-player').length === 0);
    await page.waitForFunction(() => window.__blocks.achievements.host);
    await page.locator('#server-stop').click(); await page.waitForFunction(() => window.__blocks.server?.status === 'stopped');
    await page.waitForFunction(() => document.getElementById('server-builder').offsetParent !== null);
    assert.equal(await page.locator('#server-console-title').textContent(), 'Журнал последнего запуска');
    assert.equal(await page.locator('#server-motd').inputValue(), 'Привет из Veyra');
    await assert.rejects(page.evaluate(() => window.launcher.sendServerCommand('list')), /не запущен/);
    assert.deepEqual(errors, []);

    await app.close(); app = await electron.launch(options); page = await app.firstWindow();
    await page.waitForFunction(() => document.getElementById('hero-name').textContent === 'Blocks');
    state = await page.evaluate(() => window.launcher.getState());
    assert.deepEqual(Object.keys(state.achievements).sort(), ['artist', 'first-build', 'first-launch', 'host', 'hour']);
    assert.equal(state.instances[0].serverConfig.motd, 'Привет из Veyra'); assert.equal(state.instances[0].serverConfig.port, port);
    assert.deepEqual(state.instances[0].favoriteShots, ['2026-10-13_12.00.00.png']);
    // Выбор «без достижений» пережил перезапуск; включение возвращает слот и накопленное.
    await page.locator('#intro').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.rail-button[data-view="trophies"]').isVisible(), false);
    await page.keyboard.press('5'); await page.locator('#ui-trophies').locator('..').click();
    await page.keyboard.press('4'); assert.equal(await page.locator('#trophy-count').textContent(), '5 из 35');
    await page.keyboard.press('3'); await page.waitForFunction(value => document.getElementById('server-port').value === value, String(port));
    assert.equal(await page.locator('#server-eula').isChecked(), true, 'An accepted EULA is remembered by the server folder');
    process.stdout.write('OK: opening animation, logo, palette and both fonts, still icons, complete icon set, hotbar keys, section transitions, splash menu, switchable achievements, screenshot copy and favourites, item tooltip, worlds list, level bar, achievements with persistence, screenshot gallery and cover, server builder import/validation/persistence, configured port on a real TCP server, live players, commands with history and quick actions. Server Java replaced by a test Node child.\n');
  } finally { const page = await app.firstWindow().catch(() => null); await page?.evaluate(() => window.launcher.stopServer(true)).catch(() => {}); await app.close().catch(() => {}); }
}
main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
