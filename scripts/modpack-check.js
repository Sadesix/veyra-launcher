// Сборки модов Modrinth: разбор .mrpack, защита путей и ссылок, докачка, каталог и установка отдельной сборкой.
// Сеть подменена: Modrinth и CDN отвечают тестовыми данными, игра не скачивается.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const workspace = path.join(__dirname, '..');
const sha = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function png(width, height, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_value, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = bytes => { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(type, 4, 'ascii'); const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data]))); return Buffer.concat([head, data, tail]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_value, index) => [r, g, b][index % 3])]);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

// Тестовая сборка: два мода, ресурспак, серверный мод (клиенту не нужен) и настройки в overrides.
const CDN = 'https://cdn.modrinth.com/data/';
const files = {
  alpha: { path: 'mods/alpha.jar', url: CDN + 'AlphaP01/versions/AlphaV01/alpha.jar', bytes: Buffer.from('alpha mod '.repeat(700)) },
  beta: { path: 'mods/beta.jar', url: CDN + 'BetaPr01/versions/BetaVe01/beta.jar', bytes: Buffer.from('beta library '.repeat(500)) },
  pack: { path: 'resourcepacks/pack.zip', url: 'https://github.com/veyra/pack/releases/download/v1/pack.zip', bytes: Buffer.from('resource pack '.repeat(90)) },
  server: { path: 'mods/server-only.jar', url: CDN + 'ServerP1/versions/ServerV1/server-only.jar', bytes: Buffer.from('server only'), env: { client: 'unsupported', server: 'required' } },
};
const entry = item => ({ path: item.path, hashes: { sha1: sha('sha1', item.bytes), sha512: sha('sha512', item.bytes) }, env: item.env || { client: 'required', server: 'required' }, downloads: [item.url], fileSize: item.bytes.length });
const baseIndex = { formatVersion: 1, game: 'minecraft', versionId: '2.0.0', name: 'Veyra Test Pack', dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.16.10' }, files: Object.values(files).map(entry) };
const overrides = {
  'overrides/config/': null,
  'overrides/config/alpha.toml': 'speed = 3\n',
  'overrides/options.txt': 'lang:en_us\n',
  'client-overrides/options.txt': 'lang:ru_ru\n',
  'server-overrides/server.properties': 'motd=server\n',
};

function makePack(file, index = baseIndex, extra = overrides) {
  const yazl = require('yazl');
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify(index)), 'modrinth.index.json');
  for (const [name, content] of Object.entries(extra)) {
    if (content === null) zip.addEmptyDirectory(name);
    else zip.addBuffer(Buffer.from(content), name);
  }
  zip.end();
  return new Promise((resolve, reject) => zip.outputStream.pipe(fs.createWriteStream(file)).on('close', resolve).on('error', reject));
}

// Разбор и распаковка идут под Node из Electron, как в самом лаунчере.
async function unit() {
  const { readIndex, inspectPack, applyPack, packRecord, packPath } = require('../main/modpacks');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-modpack-unit-'));
  try {
    for (const bad of ['../evil.jar', 'mods/../../evil.jar', '/evil.jar', 'C:/evil.jar', 'mods\\evil.jar', '.veyra-content.json', 'mods/.veyra-x/a.jar', 'mods/con.jar', 'mods/evil.jar.', 'mods//evil.jar', 'mods/ev:il.jar']) assert.throws(() => packPath(bad), /Недопустимый путь/, bad);
    assert.deepEqual(packPath('config/sub dir/file.json'), ['config', 'sub dir', 'file.json']);
    assert.throws(() => readIndex({ ...baseIndex, dependencies: { minecraft: '1.20.1', 'quilt-loader': '0.26.0' } }), /Quilt/);
    assert.throws(() => readIndex({ ...baseIndex, dependencies: { minecraft: '1.20.1', forge: '47.2.0', 'fabric-loader': '0.16.10' } }), /несколько загрузчиков/);
    assert.throws(() => readIndex({ ...baseIndex, dependencies: { 'fabric-loader': '0.16.10' } }), /версия Minecraft/);
    assert.throws(() => readIndex({ ...baseIndex, game: 'other' }), /не сборка Minecraft/);
    assert.throws(() => readIndex({ ...baseIndex, files: [{ ...entry(files.alpha), downloads: ['https://evil.example/alpha.jar', 'http://cdn.modrinth.com/alpha.jar'] }] }), /не разрешает/);
    assert.throws(() => readIndex({ ...baseIndex, files: [entry(files.alpha), { ...entry(files.alpha), path: 'MODS/ALPHA.JAR' }] }), /дважды/);
    assert.throws(() => readIndex({ ...baseIndex, files: [{ ...entry(files.alpha), hashes: { sha512: sha('sha512', files.alpha.bytes) } }] }), /контрольной суммы/);
    assert.throws(() => readIndex({ ...baseIndex, files: [{ ...entry(files.alpha), path: '../outside.jar' }] }), /Недопустимый путь/);
    const vanilla = readIndex({ ...baseIndex, dependencies: { minecraft: '1.20.1' } });
    assert.equal(vanilla.loader, 'vanilla');

    const packFile = path.join(directory, 'pack.mrpack');
    await makePack(packFile);
    const index = await inspectPack(packFile);
    assert.deepEqual([index.name, index.minecraft, index.loader, index.loaderVersion], ['Veyra Test Pack', '1.20.1', 'fabric', '0.16.10']);
    assert.deepEqual(index.files.map(item => item.path), ['mods/alpha.jar', 'mods/beta.jar', 'resourcepacks/pack.zip'], 'серверный мод клиенту не нужен');
    const notZip = path.join(directory, 'broken.mrpack'); fs.writeFileSync(notZip, 'not a zip');
    await assert.rejects(inspectPack(notZip), /не ZIP/);
    const noIndex = path.join(directory, 'empty.mrpack'); await new Promise((resolve) => { const zip = new (require('yazl').ZipFile)(); zip.addBuffer(Buffer.from('x'), 'readme.txt'); zip.end(); zip.outputStream.pipe(fs.createWriteStream(noIndex)).on('close', resolve); });
    await assert.rejects(inspectPack(noIndex), /нет modrinth\.index\.json/);

    const served = new Map(Object.values(files).map(item => [item.url, item.bytes]));
    let calls = [];
    const fetcher = async (url, init) => { calls.push(url); assert.equal(init.headers['User-Agent'], 'VeyraTest'); const body = served.get(url); return body ? new Response(body) : new Response('missing', { status: 404 }); };
    const game = path.join(directory, 'game'); fs.mkdirSync(game);
    const reports = [];
    const result = await applyPack(packFile, index, game, { fetch: fetcher, agent: 'VeyraTest', progress: value => reports.push(value) });
    assert.deepEqual(result, { files: 3, overrides: 3 });
    assert.equal(calls.length, 3);
    for (const item of [files.alpha, files.beta, files.pack]) assert.deepEqual(fs.readFileSync(path.join(game, item.path)), item.bytes);
    assert.equal(fs.existsSync(path.join(game, 'mods', 'server-only.jar')), false);
    assert.equal(fs.readFileSync(path.join(game, 'config', 'alpha.toml'), 'utf8'), 'speed = 3\n');
    assert.equal(fs.readFileSync(path.join(game, 'options.txt'), 'utf8'), 'lang:ru_ru\n', 'client-overrides идут поверх overrides');
    assert.equal(fs.existsSync(path.join(game, 'server.properties')), false);
    assert.ok(reports.some(value => value.phase === 'Сборка модов' && value.total === index.files.reduce((sum, item) => sum + item.size, 0)));

    // Повтор ничего не качает; пропавший и испорченный файлы докачиваются.
    calls = [];
    await applyPack(packFile, index, game, { fetch: fetcher, agent: 'VeyraTest' });
    assert.equal(calls.length, 0, 'целые файлы не скачиваются заново');
    fs.rmSync(path.join(game, files.beta.path)); fs.writeFileSync(path.join(game, files.alpha.path), 'broken');
    await applyPack(packFile, index, game, { fetch: fetcher, agent: 'VeyraTest' });
    assert.deepEqual(calls.sort(), [files.alpha.url, files.beta.url].sort());
    assert.deepEqual(fs.readFileSync(path.join(game, files.alpha.path)), files.alpha.bytes);

    // Подменённый файл не попадает в сборку и не оставляет обрывков.
    served.set(files.beta.url, Buffer.from('tampered '.repeat(10)));
    fs.rmSync(path.join(game, files.beta.path));
    await assert.rejects(applyPack(packFile, index, game, { fetch: fetcher, agent: 'VeyraTest' }), /«mods\/beta\.jar».*(размер|контрольная сумма)/);
    assert.equal(fs.existsSync(path.join(game, files.beta.path)), false);
    assert.deepEqual(fs.readdirSync(path.join(game, 'mods')).filter(name => name.includes('.veyra-part')), []);
    served.set(files.beta.url, files.beta.bytes);

    // Папка-ссылка внутри сборки не уводит файлы наружу.
    const outside = path.join(directory, 'outside'); fs.mkdirSync(outside);
    const trap = path.join(directory, 'trap'); fs.mkdirSync(trap);
    fs.symlinkSync(outside, path.join(trap, 'mods'), 'junction');
    await assert.rejects(applyPack(packFile, index, trap, { fetch: fetcher, agent: 'VeyraTest' }), /ссылка/);
    assert.deepEqual(fs.readdirSync(outside), []);

    // Отмена прерывает загрузку.
    const controller = new AbortController();
    const slow = async (url, init) => { controller.abort(); return fetcher(url, init); };
    fs.mkdirSync(path.join(directory, 'cancel'));
    await assert.rejects(applyPack(packFile, index, path.join(directory, 'cancel'), { fetch: slow, agent: 'VeyraTest', signal: controller.signal }), error => error.name === 'AbortError');

    // Сведения о сборке в настройках: файл .mrpack принимается только с CDN Modrinth.
    const file = { url: CDN + 'VtPack01/versions/VtVer001/pack.mrpack', filename: 'pack.mrpack', size: 10, sha1: 'a'.repeat(40), sha512: 'b'.repeat(128) };
    assert.equal(packRecord({ source: 'modrinth', projectId: 'VtPack01', versionId: 'VtVer001', state: 'pending', file: { ...file, url: 'https://evil.example/pack.mrpack' } }), null);
    assert.equal(packRecord({ source: 'curseforge', projectId: 'VtPack01', versionId: 'VtVer001', state: 'applied' }), null);
    assert.equal(packRecord({ source: 'modrinth', projectId: '../x', versionId: 'VtVer001', state: 'applied' }), null);
    assert.equal(packRecord({ source: 'modrinth', projectId: 'VtPack01', versionId: 'VtVer001', state: 'pending', file }).file.url, file.url);
    const applied = packRecord({ source: 'modrinth', projectId: 'VtPack01', versionId: 'VtVer001', state: 'applied', file, title: 'T', icon: 'https://evil.example/icon.png' });
    assert.equal(applied.file, null); assert.equal(applied.icon, '');
    process.stdout.write('OK: .mrpack — пути, хеши, ссылки, докачка, overrides, отмена\n');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function electronBinary() { return require(path.join(workspace, 'node_modules', 'electron')); }

async function ui() {
  const { _electron: electron } = require('playwright-core');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-modpack-'));
  const packFile = path.join(data, 'fixture.mrpack');
  await makePack(packFile);
  const packBytes = fs.readFileSync(packFile);
  const quiltIndex = { ...baseIndex, dependencies: { minecraft: '1.20.1', 'quilt-loader': '0.26.0' } };
  fs.writeFileSync(path.join(data, 'version-manifest.json'), JSON.stringify({ latest: { release: '1.20.1' }, versions: [{ id: '1.20.1', type: 'release', url: 'https://fixture.invalid/1.20.1.json', releaseTime: '2023-06-12T00:00:00Z' }] }));
  const fixture = {
    packUrl: CDN + 'VtPack01/versions/VtVer001/Veyra%20Test%20Pack.mrpack',
    pack: packBytes.toString('base64'), packSha1: sha('sha1', packBytes), packSha512: sha('sha512', packBytes), packSize: packBytes.length,
    files: Object.fromEntries(Object.values(files).map(item => [item.url, item.bytes.toString('base64')])),
    image: png(64, 36, [120, 160, 200]).toString('base64'),
    alphaSha1: sha('sha1', files.alpha.bytes), betaSha1: sha('sha1', files.beta.bytes),
  };
  const env = { ...process.env, VEYRA_TEST_DATA_DIR: data };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: process.argv[2] ? path.resolve(process.argv[2]) : undefined, args: process.argv[2] ? [] : ['.'], cwd: workspace, env, timeout: 120000 });
  const output = path.join(workspace, 'test-output'); fs.mkdirSync(output, { recursive: true });
  try {
    const page = await app.firstWindow();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.locator('#view-title').waitFor();
    await app.evaluate((_electron, fixture) => {
      const original = globalThis.__veyraRealFetch ||= globalThis.fetch;
      const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
      const project = { id: 'VtPack01', slug: 'veyra-test-pack', title: 'Veyra Test Pack', description: 'Тестовая сборка Veyra', project_type: 'modpack', icon_url: 'https://cdn.modrinth.com/data/VtPack01/icon.png', downloads: 1234, followers: 5, gallery: [{ url: 'https://cdn.modrinth.com/data/VtPack01/images/cover_350.webp', raw_url: 'https://cdn.modrinth.com/data/VtPack01/images/cover.png', featured: true }] };
      const file = (name, url, size, sha1, sha512) => ({ url, filename: name, primary: true, size, hashes: { sha1, sha512 } });
      const versions = [
        { id: 'VtVer001', project_id: 'VtPack01', name: 'Release', version_number: '2.0.0', version_type: 'release', game_versions: ['1.20.1'], loaders: ['fabric'], date_published: '2026-10-01T00:00:00Z', files: [file('Veyra Test Pack.mrpack', fixture.packUrl, fixture.packSize, fixture.packSha1, fixture.packSha512)] },
        { id: 'VtVer002', project_id: 'VtPack01', name: 'Beta', version_number: '2.1.0-beta', version_type: 'beta', game_versions: ['1.20.1'], loaders: ['fabric'], date_published: '2026-10-10T00:00:00Z', files: [file('Veyra Test Pack beta.mrpack', fixture.packUrl, fixture.packSize, fixture.packSha1, fixture.packSha512)] },
        { id: 'VtVer003', project_id: 'VtPack01', name: 'Next', version_number: '3.0.0', version_type: 'release', game_versions: ['1.21.1'], loaders: ['neoforge'], date_published: '2026-10-15T00:00:00Z', files: [file('Veyra Test Pack next.mrpack', fixture.packUrl, fixture.packSize, fixture.packSha1, fixture.packSha512)] },
        { id: 'VtQuilt1', project_id: 'VtPack01', name: 'Quilt', version_number: '2.0.0-quilt', version_type: 'release', game_versions: ['1.20.1'], loaders: ['quilt'], date_published: '2026-09-01T00:00:00Z', files: [file('quilt.mrpack', fixture.packUrl, fixture.packSize, fixture.packSha1, fixture.packSha512)] },
      ];
      globalThis.__modpackRequests = [];
      globalThis.fetch = async (url, init = {}) => {
        const value = String(url?.url || url);
        if (value === 'https://launchermeta.mojang.com/mc/game/version_manifest.json') return json({ latest: { release: '1.20.1' }, versions: [{ id: '1.20.1', type: 'release', url: 'https://fixture.invalid/1.20.1.json', releaseTime: '2023-06-12T00:00:00Z' }] });
        if (value.startsWith('https://fixture.invalid/')) return new Response('not found', { status: 404 });
        if (value.startsWith('https://api.modrinth.com/v2/')) {
          const route = new URL(value);
          globalThis.__modpackRequests.push(route.pathname + route.search);
          if (route.pathname === '/v2/search') return json({ total_hits: 1, hits: [{ project_id: 'VtPack01', slug: 'veyra-test-pack', title: 'Veyra Test Pack', description: 'Тестовая сборка Veyra', author: 'Veyra', downloads: 1234, icon_url: project.icon_url, featured_gallery: 'https://cdn.modrinth.com/data/VtPack01/images/cover_350.webp', categories: ['fabric', 'adventure'], display_categories: ['adventure'], versions: ['1.20.1'] }] });
          if (route.pathname === '/v2/project/VtPack01') return json(project);
          if (route.pathname === '/v2/project/VtPack01/version') return json(versions);
          const version = versions.find(item => route.pathname === '/v2/version/' + item.id);
          if (version) return json(version);
          if (route.pathname === '/v2/version_files' && init.method === 'POST') {
            const body = JSON.parse(init.body);
            return json(Object.fromEntries(body.hashes.flatMap(hash => hash === fixture.alphaSha1 ? [[hash, { id: 'AlphaV01', project_id: 'AlphaP01', version_number: '1.4.0', dependencies: [{ project_id: 'BetaPr01', dependency_type: 'required' }] }]] : hash === fixture.betaSha1 ? [[hash, { id: 'BetaVe01', project_id: 'BetaPr01', version_number: '3.0.0', dependencies: [] }]] : [])));
          }
          if (route.pathname === '/v2/projects') return json([{ id: 'AlphaP01', title: 'Alpha Mod', icon_url: 'https://cdn.modrinth.com/data/AlphaP01/icon.png' }, { id: 'BetaPr01', title: 'Beta Library', icon_url: '' }]);
          return new Response('{}', { status: 404 });
        }
        if (value === fixture.packUrl) return new Response(Buffer.from(fixture.pack, 'base64'));
        if (fixture.files[value]) return new Response(Buffer.from(fixture.files[value], 'base64'));
        if (value.startsWith('https://cdn.modrinth.com/') && /\.(png|webp)$/.test(value)) return new Response(Buffer.from(fixture.image, 'base64'), { headers: { 'content-type': 'image/png' } });
        return original(url, init);
      };
    }, fixture);
    // Каталог версий Minecraft — из подменённого Mojang, чтобы установка не тянула настоящую игру.
    await page.evaluate(() => window.launcher.refreshVersions());

    await page.locator('#create-top').click();
    await page.locator('#create-modpacks').click();
    await page.locator('#modpack-dialog').waitFor();
    assert.equal(await page.locator('#create-dialog').evaluate(dialog => dialog.open && !dialog.classList.contains('is-closing')), false, 'окно новой сборки уступает место каталогу');
    const card = page.locator('#modpack-results .modpack-card[data-project-id="VtPack01"]');
    await card.waitFor();
    assert.match(await card.textContent(), /Veyra Test Pack[\s\S]*Veyra[\s\S]*Тестовая сборка Veyra[\s\S]*Fabric[\s\S]*Minecraft 1\.20\.1[\s\S]*1,2\sтыс\.\sзагрузок/);
    assert.match(await card.locator('.modpack-banner').evaluate(node => node.style.backgroundImage), /cover_350\.webp/);
    assert.equal(await page.locator('#modpack-count').textContent(), '1 сборок · Modrinth');
    let requests = await app.evaluate(() => globalThis.__modpackRequests);
    const facets = JSON.parse(new URLSearchParams(requests.find(item => item.startsWith('/v2/search')).split('?')[1]).get('facets'));
    assert.deepEqual(facets, [['project_type:modpack'], ['categories:fabric', 'categories:forge', 'categories:neoforge']]);
    await page.locator('#modpack-loader').selectOption('neoforge');
    await page.locator('#modpack-game').selectOption('1.20.1');
    await page.waitForFunction(() => document.querySelector('#modpack-results .modpack-card'));
    requests = await app.evaluate(() => globalThis.__modpackRequests);
    assert.deepEqual(JSON.parse(new URLSearchParams(requests.filter(item => item.startsWith('/v2/search')).at(-1).split('?')[1]).get('facets')), [['project_type:modpack'], ['categories:neoforge'], ['versions:1.20.1']]);
    await page.locator('#modpack-loader').selectOption('');
    await page.locator('#modpack-game').selectOption('');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(output, 'modpacks.png') });

    // Панель сборки: только версии с поддержанным загрузчиком, Beta — по переключателю.
    await page.locator('#modpack-results .modpack-card[data-project-id="VtPack01"] .modpack-choose').click();
    await page.waitForFunction(() => !document.getElementById('modpack-version').disabled);
    assert.deepEqual(await page.locator('#modpack-version option').evaluateAll(options => options.map(option => option.value)), ['VtVer003', 'VtVer001']);
    assert.equal(await page.locator('#modpack-version').inputValue(), 'VtVer003', 'по умолчанию — самая свежая версия');
    await page.locator('#modpack-preview').locator('..').click();
    assert.deepEqual(await page.locator('#modpack-version option').evaluateAll(options => options.map(option => option.value)), ['VtVer003', 'VtVer002', 'VtVer001']);
    // С фильтром Minecraft в каталоге сразу выбрана версия под него.
    await page.locator('#modpack-plan-close').click();
    await page.locator('#modpack-game').selectOption('1.20.1');
    await page.waitForFunction(() => document.querySelector('#modpack-results .modpack-card'));
    await page.locator('#modpack-results .modpack-card[data-project-id="VtPack01"] .modpack-choose').click();
    await page.waitForFunction(() => !document.getElementById('modpack-version').disabled);
    assert.equal(await page.locator('#modpack-version').inputValue(), 'VtVer001');
    await page.locator('#modpack-preview').locator('..').click();
    await page.locator('#modpack-version').selectOption('VtVer001');
    assert.match((await page.locator('#modpack-facts').textContent()).replace(/\s+/g, ' '), /Minecraft ?1\.20\.1 ?Загрузчик ?Fabric ?Файл сборки ?\d+ КБ/);
    assert.equal(await page.locator('#modpack-name').getAttribute('placeholder'), 'Veyra Test Pack');
    assert.match(await page.locator('#modpack-art').evaluate(node => node.style.backgroundImage), /cover\.png/);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(output, 'modpack-plan.png') });

    // Версия только для Quilt не ставится, и сборка не появляется.
    await assert.rejects(page.evaluate(() => window.launcher.createModpackInstance({ projectId: 'VtPack01', versionId: 'VtQuilt1' })), /Quilt/);
    assert.equal((await page.evaluate(() => window.launcher.getState())).instances.length, 0);

    // Установка: сборка создаётся, окно закрывается, установка идёт на главной.
    await page.locator('#modpack-install').click();
    await page.waitForFunction(() => !document.getElementById('modpack-dialog').open);
    let state;
    for (let i = 0; i < 200; i++) {
      state = await page.evaluate(() => window.launcher.getState());
      if (state.instances.length && !state.operation && state.installConsole?.live === false) break;
      await sleep(150);
    }
    const instance = state.instances[0];
    assert.equal(instance.name, 'Veyra Test Pack');
    assert.equal(await page.locator('[data-page="home"]').isVisible(), true);
    assert.deepEqual([instance.minecraftVersion, instance.loader, instance.loaderVersion, instance.installed], ['1.20.1', 'fabric', '0.16.10', false]);
    assert.equal(instance.modpack.state, 'applied', 'сборка распакована до установки игры');
    assert.equal(instance.modpack.version, '2.0.0');
    assert.equal(instance.coverFile, 'cover.png', 'обложка — картинка из галереи сборки');
    assert.equal(instance.note, 'Тестовая сборка Veyra');
    for (const item of [files.alpha, files.beta, files.pack]) assert.deepEqual(fs.readFileSync(path.join(instance.directory, item.path)), item.bytes);
    assert.equal(fs.readFileSync(path.join(instance.directory, 'options.txt'), 'utf8'), 'lang:ru_ru\n');
    assert.equal(fs.existsSync(path.join(instance.directory, 'mods', 'server-only.jar')), false);
    assert.equal(fs.existsSync(path.join(instance.directory, '.veyra-modpack', 'pack.mrpack')), false, '.mrpack удаляется после распаковки');
    // Игра в тесте не скачивается: установка останавливается на подменённом описании версии, с понятной причиной.
    assert.equal(state.installConsole.outcome, 'error');
    assert.match(state.installConsole.lines.map(line => line.text).join('\n'), /Сборка модов «Veyra Test Pack» 2\.0\.0: Minecraft 1\.20\.1, fabric 0\.16\.10, файлов: 3[\s\S]*на Modrinth найдено 2 файлов из 3[\s\S]*распакована: файлов 3, настроек 3/);
    assert.match(await page.locator('#hero-description').textContent(), /^Моды сборки «Veyra Test Pack» 2\.0\.0 с Modrinth на месте\. Установите игру/);

    // Моды сборки видны в мастерской как проекты Modrinth со связями.
    const mods = await page.evaluate(id => window.launcher.getContent(id, 'mods'), instance.id);
    const byTitle = Object.fromEntries(mods.entries.map(item => [item.title, item]));
    assert.deepEqual(Object.keys(byTitle).sort(), ['Alpha Mod', 'Beta Library']);
    assert.equal(byTitle['Alpha Mod'].source, 'modrinth');
    assert.equal(byTitle['Alpha Mod'].version, '1.4.0');
    assert.deepEqual(byTitle['Beta Library'].requiredBy, ['Alpha Mod']);
    await assert.rejects(page.evaluate(id => window.launcher.toggleContent(id, 'mods', 'beta.jar', false), instance.id), /Alpha Mod/);

    // Сведения о сборке переживают перезапуск: они в settings.json.
    const saved = JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).instances[0].modpack;
    assert.deepEqual([saved.source, saved.projectId, saved.versionId, saved.state, saved.file], ['modrinth', 'VtPack01', 'VtVer001', 'applied', null]);

    // Та же сборка ещё раз — новая отдельная сборка с номером в названии.
    const second = await page.evaluate(() => window.launcher.createModpackInstance({ projectId: 'VtPack01', versionId: 'VtVer002' }));
    assert.equal(second.name, 'Veyra Test Pack 2');
    assert.equal(second.modpack.state, 'pending');
    assert.notEqual(second.directory, instance.directory);
    const custom = await page.evaluate(() => window.launcher.createModpackInstance({ projectId: 'VtPack01', versionId: 'VtVer001', name: '  Мой сервер  ' }));
    assert.equal(custom.name, 'Мой сервер');
    await assert.rejects(page.evaluate(() => window.launcher.createModpackInstance({ projectId: '../etc', versionId: 'VtVer001' })), /Некорректный ID/);
    assert.deepEqual(errors, []);
    process.stdout.write('OK: каталог сборок, фильтры, версии, Quilt, установка отдельной сборкой, моды в мастерской, повтор с номером\n');
  } finally {
    await app.close();
    fs.rmSync(data, { recursive: true, force: true });
  }
}

(async () => {
  if (process.argv.includes('--unit')) return unit();
  const child = spawnSync(electronBinary(), [__filename, '--unit'], { cwd: workspace, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
  process.stdout.write(child.stdout || ''); process.stderr.write(child.stderr || '');
  if (child.status !== 0) throw new Error('Проверка разбора .mrpack не прошла');
  await ui();
})().catch((error) => { process.stderr.write((error.stack || error) + '\n'); process.exitCode = 1; });
