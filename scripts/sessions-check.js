const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { _electron: electron } = require('playwright-core');
async function main() {
  const workspace = path.join(__dirname, '..'), data = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-sessions-'));
  const game = path.join(data, 'instances', 'sessions'), versionRoot = path.join(game, 'versions', '26.3'); fs.mkdirSync(versionRoot, { recursive: true });
  const version = { id: '26.3', type: 'release', mainClass: 'net.minecraft.client.main.Main', assets: '26.3', javaVersion: { majorVersion: 25, component: 'java-runtime-epsilon' }, libraries: [], downloads: { client: {}, server: { url: 'https://fixture.invalid/server.jar', sha1: createHash('sha1').update('fixture server').digest('hex') } }, arguments: { jvm: ['-classpath', '${classpath}'], game: ['--username', '${auth_player_name}', '--gameDir', '${game_directory}'] } };
  fs.writeFileSync(path.join(versionRoot, '26.3.json'), JSON.stringify(version)); fs.writeFileSync(path.join(versionRoot, '26.3.jar'), 'fixture');
  fs.writeFileSync(path.join(game, '.veyra-instance-ready.json'), JSON.stringify({ id: 'sessions', versionId: '26.3' }));
  fs.mkdirSync(path.join(game, 'mods')); fs.writeFileSync(path.join(game, 'mods', 'server-mod.jar'), 'server mod'); fs.writeFileSync(path.join(game, 'mods', 'client-mod.jar'), 'client mod'); fs.writeFileSync(path.join(game, 'mods', 'unknown.jar'), 'unknown mod');
  fs.writeFileSync(path.join(game, '.veyra-content.json'), JSON.stringify({ schema: 1, trash: [], items: [{ kind: 'mods', file: 'server-mod.jar', projectId: 'servermod', versionId: 'server1' }, { kind: 'mods', file: 'client-mod.jar', projectId: 'clientmod', versionId: 'client1' }] }));
  fs.mkdirSync(path.join(game, 'saves', 'KeepWorld'), { recursive: true }); fs.writeFileSync(path.join(game, 'saves', 'KeepWorld', 'level.dat'), 'keep'); fs.writeFileSync(path.join(game, 'options.txt'), 'fixture options');
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ playerName: 'QuickNick', memoryGb: 1, selectedInstanceId: 'sessions', javaPath: path.join(process.env.VEYRA_JAVA_HOME || path.join(process.env.APPDATA, 'veyra-launcher', 'runtimes', 'java-runtime-epsilon'), 'bin', 'java.exe'), instances: [{ id: 'sessions', name: 'Together', directory: game, minecraftVersion: '26.3', versionId: '26.3', loader: 'vanilla', memoryGb: 1 }] }));
  fs.writeFileSync(path.join(data, 'version-manifest.json'), JSON.stringify({ versions: [{ id: '26.3', type: 'release', url: 'https://fixture.invalid/version.json' }] }));
  const app = await electron.launch({ executablePath: process.argv[2] ? path.resolve(process.argv[2]) : undefined, args: process.argv[2] ? [] : ['.'], cwd: workspace, env: { ...process.env, VEYRA_TEST_DATA_DIR: data }, timeout: 120000 });
  try {
    const page = await app.firstWindow(), errors = []; page.on('pageerror', error => errors.push(error.message)); await page.waitForFunction(() => document.getElementById('hero-name').textContent === 'Together');
    const savedSettings = fs.readFileSync(path.join(data, 'settings.json'), 'utf8');
    const duplicate = require('node:child_process').spawn(process.argv[2] ? path.resolve(process.argv[2]) : require('electron'), process.argv[2] ? [] : ['.'], { cwd: workspace, windowsHide: true, stdio: 'ignore', env: { ...process.env, VEYRA_TEST_DATA_DIR: data } });
    try { await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Duplicate launcher did not exit')), 7000); duplicate.once('error', error => { clearTimeout(timer); reject(error); }); duplicate.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Duplicate launcher exited with ' + code)); }); }); } finally { if (duplicate.exitCode == null) duplicate.kill(); }
    assert.equal(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'), savedSettings, 'Duplicate launcher must not write shared settings');
    await app.evaluate(({ app }, fixtureVersion) => {
      const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json'), childProcess = require('node:child_process'), originalSpawn = childProcess.spawn, originalFetch = globalThis.fetch;
      globalThis.__clientArgs = [];
      globalThis.fetch = (url, options) => {
        const value = String(url);
        if (value.includes('fixture.invalid/version') || value.includes('piston-meta.mojang.com')) return Promise.resolve(new Response(JSON.stringify(fixtureVersion)));
        if (value === 'https://fixture.invalid/server.jar') return Promise.resolve(new Response('fixture server'));
        if (value.includes('api.modrinth.com/v2/project/')) return Promise.resolve(new Response(JSON.stringify({ server_side: value.endsWith('servermod') ? 'required' : 'unsupported' })));
        return originalFetch(url, options);
      };
      childProcess.spawn = (command, args, options) => {
        if (args.includes('net.minecraft.client.main.Main')) { globalThis.__clientArgs.push(args); return originalSpawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...options, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }); }
        if (args.includes('server.jar')) return originalSpawn(process.execPath, ['-e', "const fs=require('fs'),net=require('net');const s=net.createServer();s.listen(25565,'0.0.0.0',()=>console.log('Done (0.1s)! For help, type \"help\"'));process.stdin.on('data',b=>{if(String(b).includes('stop')){fs.writeFileSync('saved-on-stop.txt','saved');s.close(()=>process.exit(0));}});"], { ...options, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
        return originalSpawn(command, args, options);
      };
    }, version);
    await page.evaluate(async () => { window.__sessionsState = await window.launcher.getState(); window.launcher.onEvent(event => { if (event.type === 'state') window.__sessionsState = event.state; }); });
    const first = await page.evaluate(() => window.launcher.launchInstance('sessions'));
    await page.locator('#hero-multi').click(); await page.waitForFunction(() => window.__sessionsState.runningClients.length === 2 && !window.__sessionsState.operation);
    let state = await page.evaluate(() => window.launcher.getState()); assert.equal(state.runningClients.length, 2, JSON.stringify({ clients: state.runningClients, crash: state.lastCrash, logs: await page.evaluate(() => window.launcher.getLogs()) })); assert.equal(state.runningClients[0].name, 'QuickNick'); assert.equal(state.runningClients[1].name, 'QuickNick_2');
    assert.notEqual(state.runningClients[0].directory, state.runningClients[1].directory); assert.equal(fs.existsSync(path.join(state.runningClients[1].directory, 'saves', 'KeepWorld')), false); assert.equal(fs.readFileSync(path.join(state.runningClients[1].directory, 'options.txt'), 'utf8'), 'fixture options');
    await app.evaluate(({ app }) => { const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json'), os = require('node:os'); globalThis.__realMemory = os.totalmem; os.totalmem = () => 3 * 1024 ** 3; });
    await assert.rejects(page.evaluate(() => window.launcher.launchInstance('sessions')), /выделено/);
    await app.evaluate(({ app }) => { const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json'); require('node:os').totalmem = globalThis.__realMemory; });
    await assert.rejects(page.evaluate(() => window.launcher.trashContent('sessions', 'mods', 'unknown.jar')), /Остановите/);
    await page.locator('#hero-server').click(); assert.equal(await page.locator('.client-session').count(), 2); assert.equal(await page.locator('#server-start').isDisabled(), true);
    await assert.rejects(page.evaluate(() => window.launcher.startServer('sessions', false)), /EULA/);
    await page.locator('#server-eula').check(); await page.locator('#server-start').click(); await page.waitForFunction(() => window.__sessionsState.server?.status === 'ready');
    state = await page.evaluate(() => window.launcher.getState()); assert.equal(state.server.port, 25565); assert.equal(state.server.skipped.length, 2); assert.equal(fs.readFileSync(path.join(game, 'saves', 'KeepWorld', 'level.dat'), 'utf8'), 'keep');
    assert.equal(state.server.host, '0.0.0.0');
    if (state.server.addresses.length) await new Promise((resolve, reject) => { const socket = require('node:net').connect(25565, state.server.addresses[0].split(':')[0]); socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('LAN interface did not accept a connection')); }); socket.once('connect', () => { socket.destroy(); resolve(); }); socket.once('error', reject); });
    assert.deepEqual(fs.readdirSync(path.join(game, '.veyra-server', 'mods')), ['server-mod.jar']);
    assert.match(fs.readFileSync(path.join(game, '.veyra-server', 'server.properties'), 'utf8'), /server-ip=0.0.0.0/);
    await page.locator('#server-copy').click(); assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), '127.0.0.1:25565');
    await page.locator('#server-join').click(); await page.waitForFunction(() => window.__sessionsState.runningClients.length === 3 && !window.__sessionsState.operation);
    const args = await app.evaluate(() => globalThis.__clientArgs); assert.ok(args[2].includes('--quickPlayMultiplayer')); assert.equal(args[2][args[2].indexOf('--quickPlayMultiplayer') + 1], '127.0.0.1:25565');
    fs.mkdirSync(path.join(workspace, 'test-output'), { recursive: true }); await page.screenshot({ path: path.join(workspace, 'test-output', 'sessions-server.png') });
    await page.locator('.client-session button').first().click(); await page.waitForFunction(() => window.__sessionsState.runningClients.length === 2);
    assert.ok(!(await page.evaluate(() => window.launcher.getState())).runningClients.some(run => run.id === first.id));
    await page.evaluate(() => window.launcher.stopGame()); await page.waitForFunction(() => window.__sessionsState.runningClients.length === 0);
    await assert.rejects(page.evaluate(() => window.launcher.trashContent('sessions', 'mods', 'unknown.jar')), /Остановите/);
    await page.locator('#server-stop').click(); await page.waitForFunction(() => window.__sessionsState.server?.status === 'stopped'); assert.ok(fs.existsSync(path.join(game, '.veyra-server', 'saved-on-stop.txt')));
    assert.deepEqual(errors, []);
    process.stdout.write('OK: 3 concurrent real child processes, isolated folders/worlds/natives, distinct names, content lock, explicit EULA, real TCP server on 25565, side filtering, address copy, quick join, individual stops and graceful server save. Game/server Java replaced by test Node children.\n');
  } finally { const page = await app.firstWindow().catch(() => null); await page?.evaluate(() => window.launcher.stopGame()).catch(() => {}); await page?.evaluate(() => window.launcher.stopServer(true)).catch(() => {}); await app.close(); }
}
main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
