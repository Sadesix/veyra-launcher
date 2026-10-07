const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');

async function main() {
  const executablePath = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-stop-'));
  const game = path.join(dataDirectory, 'instances', 'stop-check');
  const version = path.join(game, 'versions', '26.3');
  fs.mkdirSync(version, { recursive: true });
  fs.writeFileSync(path.join(version, '26.3.jar'), 'fixture');
  fs.writeFileSync(path.join(version, '26.3.json'), JSON.stringify({
    id: '26.3', type: 'release', mainClass: 'net.minecraft.client.main.Main', assets: '26.3',
    javaVersion: { majorVersion: 25, component: 'java-runtime-epsilon' }, libraries: [], downloads: { client: {} },
    arguments: { jvm: ['-classpath', '${classpath}'], game: ['--username', '${auth_player_name}'] },
  }));
  fs.writeFileSync(path.join(game, '.veyra-instance-ready.json'), JSON.stringify({ id: 'stop-check', versionId: '26.3' }));
  fs.writeFileSync(path.join(dataDirectory, 'settings.json'), JSON.stringify({
    javaPath: path.join(process.env.VEYRA_JAVA_HOME || path.join(process.env.APPDATA, 'veyra-launcher', 'runtimes', 'java-runtime-epsilon'), 'bin', 'java.exe'),
    instances: [{ id: 'stop-check', name: 'Stop check', directory: game, versionId: '26.3', minecraftVersion: '26.3', loader: 'vanilla' }],
  }));
  const app = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], cwd: path.join(__dirname, '..'),
    env: { ...process.env, VEYRA_TEST_DATA_DIR: dataDirectory }, timeout: 120000 });
  try {
    const page = await app.firstWindow();
    await page.locator('#main-action').waitFor();
    await app.evaluate(({ app }) => {
      const nodeRequire = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
      const childProcess = nodeRequire('node:child_process');
      const originalSpawn = childProcess.spawn;
      childProcess.spawn = (command, args, options) => {
        if (!args.includes('net.minecraft.client.main.Main')) return originalSpawn(command, args, options);
        // A real idle child replaces the game only; launch IPC and process termination remain real.
        const child = originalSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          ...options, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        });
        globalThis.__stopCheckPid = child.pid;
        return child;
      };
    });
    await page.evaluate(() => { window.__stopCrashes = 0; window.launcher.onEvent((event) => {
      if (event.type === 'game-crash') window.__stopCrashes++;
    }); });
    for (const control of ['footer', 'hero']) {
      await page.locator('#main-action').click();
      await page.waitForFunction(() => document.getElementById('launch-stage').hidden);
      await page.waitForFunction(() => document.getElementById('main-action-label').textContent === 'Остановить игру');
      const pid = await app.evaluate(() => globalThis.__stopCheckPid);
      assert.ok(pid > 0);
      if (control === 'footer') {
        await page.locator('.rail-button[data-view="settings"]').click();
        await page.locator('#stop-game-footer').click();
      } else await page.locator('#main-action').click();
      await page.waitForFunction(() => document.getElementById('stop-game-footer').hidden);
      const after = await page.evaluate(() => window.launcher.getState());
      assert.equal(after.runningInstanceId, null);
      assert.equal(after.lastCrash, null);
      assert.equal(await app.evaluate((_context, targetPid) => {
        try { process.kill(targetPid, 0); return false; } catch { return true; }
      }, pid), true, 'Child process still exists');
      await page.locator('.rail-button[data-view="home"]').click();
      await page.waitForFunction(() => document.getElementById('main-action-label').textContent === 'Играть');
    }
    assert.equal(await page.evaluate(() => window.__stopCrashes), 0);
    process.stdout.write('OK: both stop buttons terminate a real child, restore Play, allow relaunch and emit no crash. Game replaced with an idle process.\n');
  } finally {
    const page = await app.firstWindow().catch(() => null);
    await page?.evaluate(() => window.launcher.stopGame()).catch(() => {});
    await app.close();
  }
}
main().catch((error) => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
