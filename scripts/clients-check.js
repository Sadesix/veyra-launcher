const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { _electron: electron } = require('playwright-core');
const { clientMarker } = require('../main/client-sessions');

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const idle = args => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', ...args], { stdio: 'ignore', windowsHide: true });
async function waitFor(check, message, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

async function main() {
  const executablePath = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  const workspace = path.join(__dirname, '..'), data = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-clients-'));
  const game = path.join(data, 'instances', 'clients'), version = path.join(game, 'versions', '26.3');
  fs.mkdirSync(version, { recursive: true });
  fs.writeFileSync(path.join(version, '26.3.jar'), 'fixture');
  fs.writeFileSync(path.join(version, '26.3.json'), JSON.stringify({
    id: '26.3', type: 'release', mainClass: 'net.minecraft.client.main.Main', assets: '26.3',
    javaVersion: { majorVersion: 25, component: 'java-runtime-epsilon' }, libraries: [], downloads: { client: {} },
    arguments: { jvm: ['-classpath', '${classpath}'], game: ['--username', '${auth_player_name}', '--gameDir', '${game_directory}'] },
  }));
  fs.writeFileSync(path.join(game, '.veyra-instance-ready.json'), JSON.stringify({ id: 'clients', versionId: '26.3' }));
  fs.writeFileSync(path.join(game, 'options.txt'), 'fixture options');
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
    playerName: 'QuickNick', memoryGb: 1, selectedInstanceId: 'clients',
    javaPath: path.join(process.env.VEYRA_JAVA_HOME || path.join(process.env.APPDATA, 'veyra-launcher', 'runtimes', 'java-runtime-epsilon'), 'bin', 'java.exe'),
    instances: [{ id: 'clients', name: 'Clients', directory: game, versionId: '26.3', minecraftVersion: '26.3', loader: 'vanilla', memoryGb: 1 }],
  }));
  // Чужие процессы: клиент Minecraft другого лаунчера в той же папке и клиент копии Veyra с другой папкой данных и той же сборкой.
  const foreign = idle(['net.minecraft.client.main.Main', '--username', 'Stranger', '--gameDir', game]);
  const elsewhere = idle([clientMarker({ data: '0123456789ab', run: require('node:crypto').randomUUID(), instance: 'clients', name: 'Other', profile: 'x', memory: 1, started: Date.now() })]);
  // Файл владельца из 0.8.0 с PID живого чужого процесса раньше навсегда занимал основную папку.
  fs.writeFileSync(path.join(game, '.veyra-client-owner.json'), JSON.stringify({ launcherPid: foreign.pid, pid: elsewhere.pid }));
  const pids = [foreign.pid, elsewhere.pid];
  const open = async () => {
    const app = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], cwd: workspace, env: { ...process.env, VEYRA_TEST_DATA_DIR: data }, timeout: 120000 });
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.locator('#main-action').waitFor();
    // Игру заменяет простой процесс с той же меткой Veyra в командной строке; запуск, поиск и завершение остаются настоящими.
    await app.evaluate(({ app }) => {
      const childProcess = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')('node:child_process');
      const originalSpawn = childProcess.spawn;
      globalThis.__clientOptions = [];
      childProcess.spawn = (command, args, options) => {
        if (!args.includes('net.minecraft.client.main.Main')) return originalSpawn(command, args, options);
        globalThis.__clientOptions.push({ detached: options.detached });
        return originalSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', ...args.filter(arg => arg.startsWith('-Dveyra.client='))], { ...options, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
      };
    });
    return { app, page, errors };
  };
  // Игра наследует каналы вывода Electron от Playwright и держит их после выхода лаунчера,
  // поэтому app.close() ждал бы конца игры: достаточно дождаться завершения самого процесса.
  const quit = async ({ app }) => {
    const child = app.process();
    if (child.exitCode != null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    await app.evaluate(({ app }) => { setTimeout(() => app.quit(), 50); }).catch(() => {});
    await Promise.race([exited, new Promise((resolve, reject) => setTimeout(() => reject(new Error('Launcher did not quit')), 20000))]);
  };
  let session;
  try {
    session = await open();
    const first = await session.page.evaluate(() => window.launcher.launchInstance('clients'));
    pids.push(first.pid);
    assert.equal(first.directory, game, 'Stale owner file with a foreign PID must not push the client into a separate folder');
    assert.equal(fs.existsSync(path.join(game, '.veyra-client-owner.json')), false);
    assert.deepEqual(await session.app.evaluate(() => globalThis.__clientOptions), [{ detached: true }]);
    await session.page.waitForFunction(() => document.getElementById('main-action-label').textContent === 'Остановить игру');
    assert.deepEqual(session.errors, []);
    await quit(session);
    session = null;

    await new Promise(resolve => setTimeout(resolve, 500));
    assert.ok(alive(first.pid), 'Closing the launcher must not kill the game');
    const clock = JSON.parse(fs.readFileSync(path.join(data, 'running-clients.json'), 'utf8'));
    assert.ok(clock[first.id] > 0, 'The launcher must remember where playtime accounting stopped');

    const reopenedAt = Date.now();
    session = await open();
    const state = await waitFor(async () => {
      const value = await session.page.evaluate(() => window.launcher.getState());
      return value.runningClients.length ? value : null;
    }, 'The reopened launcher did not find its running client');
    assert.equal(state.runningClients.length, 1, 'Foreign Minecraft clients must not be adopted: ' + JSON.stringify(state.runningClients));
    const [adopted] = state.runningClients;
    assert.deepEqual({ id: adopted.id, pid: adopted.pid, name: adopted.name, directory: adopted.directory, memoryGb: adopted.memoryGb },
      { id: first.id, pid: first.pid, name: 'QuickNick', directory: game, memoryGb: 1 });
    assert.equal(state.runningInstanceId, 'clients');
    assert.ok(state.runningSession.accountedAt <= reopenedAt, 'Playtime must continue from the saved checkpoint');
    await session.page.waitForFunction(() => document.getElementById('main-action-label').textContent === 'Остановить игру');

    // Основная папка занята найденным клиентом: второй получает свою папку и другой ник.
    const second = await session.page.evaluate(() => window.launcher.launchInstance('clients'));
    pids.push(second.pid);
    assert.equal(second.name, 'QuickNick_2');
    assert.notEqual(second.directory, game);
    assert.equal(path.dirname(second.directory), path.join(game, '.veyra-clients'));

    await session.page.evaluate(id => window.launcher.stopGame(id), first.id);
    await waitFor(async () => !alive(first.pid) && (await session.page.evaluate(() => window.launcher.getState())).runningClients.length === 1, 'The adopted client did not stop');
    assert.ok(alive(second.pid));
    await session.page.evaluate(() => window.launcher.stopGame());
    await waitFor(async () => (await session.page.evaluate(() => window.launcher.getState())).runningClients.length === 0, 'Clients did not stop');
    await session.page.waitForFunction(() => document.getElementById('main-action-label').textContent === 'Играть');
    assert.ok(alive(foreign.pid) && alive(elsewhere.pid), 'Foreign processes must stay untouched');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'running-clients.json'), 'utf8')), {});
    assert.deepEqual(session.errors, []);
    process.stdout.write('OK: the game outlives the launcher, the reopened launcher finds and stops it by the Veyra marker, keeps playtime, ignores a foreign client and another data folder, and a stale owner file no longer blocks the main folder.\n');
  } finally {
    await session?.page.evaluate(() => window.launcher.stopGame()).catch(() => {});
    for (const pid of pids) { try { process.kill(pid); } catch {} }
    if (session) await quit(session).catch(() => session.app.process().kill());
  }
}
main().catch((error) => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
