const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');

async function main() {
  const executablePath = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-auth-'));
  const gameDirectory = path.join(dataDirectory, 'instances', 'auth-launch-check');
  const versionDirectory = path.join(gameDirectory, 'versions', '26.3');
  fs.mkdirSync(versionDirectory, { recursive: true });
  fs.writeFileSync(path.join(versionDirectory, '26.3.jar'), 'fixture');
  fs.writeFileSync(path.join(versionDirectory, '26.3.json'), JSON.stringify({
    id: '26.3', type: 'release', mainClass: 'net.minecraft.client.main.Main', assets: '26.3',
    javaVersion: { majorVersion: 25, component: 'java-runtime-epsilon' }, libraries: [], downloads: { client: {} },
    arguments: { jvm: ['-classpath', '${classpath}'], game: ['--username', '${auth_player_name}',
      '--accessToken', '${auth_access_token}', '--uuid', '${auth_uuid}', '--userType', '${user_type}'] },
  }));
  fs.writeFileSync(path.join(gameDirectory, '.veyra-instance-ready.json'), JSON.stringify({ id: 'auth-launch-check', versionId: '26.3' }));
  fs.writeFileSync(path.join(dataDirectory, 'settings.json'), JSON.stringify({
    javaPath: path.join(process.env.VEYRA_JAVA_HOME || path.join(process.env.APPDATA, 'veyra-launcher', 'runtimes', 'java-runtime-epsilon'), 'bin', 'java.exe'),
    instances: [{ id: 'auth-launch-check', name: 'Launch check', directory: gameDirectory, versionId: '26.3',
      minecraftVersion: '26.3', loader: 'neoforge', loaderVersion: '26.3.0.56-beta' }],
  }));
  const options = {
    executablePath, args: executablePath ? [] : ['.'],
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, VEYRA_TEST_DATA_DIR: dataDirectory, VEYRA_MICROSOFT_CLIENT_ID: '' },
    timeout: 120000,
  };
  let app = await electron.launch(options);
  try {
    let page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.locator('#profile-top').click();
    await page.locator('#profile-name-input').fill('QuickNick');
    await page.locator('#profile-name-input').press('Enter');
    await page.waitForFunction(() => document.getElementById('profile-chip-name').textContent === 'QuickNick');
    await page.locator('#profile-top').click();
    if (!await page.locator('[data-account-mode="microsoft"]').isVisible()) {
      assert.equal(await page.locator('#microsoft-start').isVisible(), false);
      assert.equal(await page.locator('#microsoft-client-id').isVisible(), false);
      assert.equal(await page.locator('#profile-name-input').isVisible(), true);
      assert.deepEqual(errors, []);
      process.stdout.write('OK: quick nickname works; Microsoft tab, login and configuration stay hidden. Integration code retained.\n');
      return;
    }
    await page.locator('[data-account-mode="microsoft"]').click();
    assert.equal(await page.locator('#microsoft-start').isDisabled(), true);
    if (!await page.locator('#microsoft-client-id').isVisible()) await page.locator('#microsoft-setup summary').click();
    await page.locator('#microsoft-client-id').fill('11111111-2222-3333-4444-555555555555');
    await page.locator('#microsoft-config-form button[type="submit"]').click();
    await page.waitForFunction(() => !document.getElementById('microsoft-start').disabled);

    // Replace network methods only; IPC, UI, cancellation and Windows encryption remain real.
    await app.evaluate(({ app, shell }) => {
      const nodeRequire = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
      const { MicrosoftAuth } = nodeRequire('./main/microsoft-auth.js');
      shell.openExternal = async () => {};
      shell.openPath = async (value) => { globalThis.__openedReport = value; return ''; };
      const childProcess = nodeRequire('node:child_process');
      const originalSpawn = childProcess.spawn;
      childProcess.spawn = (command, args, options) => {
        if (!args.includes('net.minecraft.client.main.Main')) return originalSpawn(command, args, options);
        globalThis.__gameArgs = args;
        const child = new (nodeRequire('node:events').EventEmitter)();
        child.pid = 1234;
        child.stdout = new (nodeRequire('node:stream').PassThrough)();
        child.stderr = new (nodeRequire('node:stream').PassThrough)();
        globalThis.__gameChild = child;
        return child;
      };
      globalThis.__authName = 'LicensedUser';
      MicrosoftAuth.prototype.deviceCode = async () => ({
        deviceCode: 'fake-private-device', userCode: 'TESTCODE', verificationUri: 'https://microsoft.com/devicelogin',
        expiresAt: Date.now() + 60000, interval: 5,
      });
      MicrosoftAuth.prototype.poll = async (_id, _device, signal) => {
        await nodeRequire('node:timers/promises').setTimeout(1200, undefined, { signal });
        return { access_token: 'fake-ms-token', refresh_token: 'fake-refresh-secret' };
      };
      MicrosoftAuth.prototype.refresh = async () => ({ access_token: 'fake-ms-token', refresh_token: 'fake-refresh-secret' });
      MicrosoftAuth.prototype.minecraft = async (clientId) => ({
        clientId, profile: { id: 'a'.repeat(32), name: globalThis.__authName },
        accessToken: 'fake-access-secret', refreshToken: 'fake-refresh-secret', expiresAt: Date.now() + 3600000,
      });
    });
    await page.locator('#microsoft-start').click();
    await page.locator('#microsoft-code').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#microsoft-code').textContent(), 'TESTCODE');
    const previousClipboard = await app.evaluate(({ clipboard }) => clipboard.readText());
    await page.locator('#microsoft-copy').click();
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'TESTCODE');
    await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), previousClipboard);
    await page.locator('#microsoft-cancel').click();
    await page.waitForFunction(() => document.getElementById('device-login').hidden);
    assert.equal((await page.evaluate(() => window.launcher.getState())).account.microsoft, null);
    await page.locator('#microsoft-start').click();
    await page.waitForFunction(() => document.getElementById('profile-chip-name').textContent === 'LicensedUser');
    const signed = await page.evaluate(() => window.launcher.getState());
    assert.equal(signed.account.name, 'LicensedUser');
    assert.ok(!JSON.stringify(signed).includes('fake-access-secret'));
    assert.ok(!JSON.stringify(signed).includes('fake-refresh-secret'));
    const encrypted = fs.readFileSync(path.join(dataDirectory, 'microsoft-session.bin'));
    assert.ok(!encrypted.includes(Buffer.from('fake-access-secret')));
    assert.ok(!encrypted.includes(Buffer.from('fake-refresh-secret')));
    const output = path.join(__dirname, '..', 'test-output');
    fs.mkdirSync(output, { recursive: true });
    await page.waitForTimeout(650);
    await page.screenshot({ path: path.join(output, 'profile-microsoft.png') });
    await app.evaluate(() => { globalThis.__authName = 'UpdatedNick'; });
    await page.locator('#microsoft-refresh').click();
    await page.waitForFunction(() => document.getElementById('microsoft-name').textContent === 'UpdatedNick');
    await page.evaluate(() => window.launcher.launchInstance('auth-launch-check'));
    assert.equal(await app.evaluate(({ app }) => {
      const nodeRequire = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
      const args = globalThis.__gameArgs;
      const agent = args.find((value) => value.startsWith('-javaagent:')).slice(11);
      return args.includes('fake-access-secret') && args.includes('UpdatedNick') && args.includes('msa') &&
        args.includes('-XX:+UseG1GC') && nodeRequire('node:fs').existsSync(agent) && !agent.includes('app.asar');
    }), true, 'Authenticated launch arguments or packaged Java agent failed');
    await app.evaluate(() => globalThis.__gameChild.stdout.write('test fake-access-secret fake-refresh-secret\n'));
    fs.mkdirSync(path.join(gameDirectory, 'crash-reports'), { recursive: true });
    const report = path.join(gameDirectory, 'crash-reports', 'crash-check.txt');
    fs.writeFileSync(report, 'Fixture crash report');
    await app.evaluate(() => globalThis.__gameChild.emit('close', 4294967295));
    await page.waitForFunction(() => !document.getElementById('notice-report').hidden);
    assert.match(await page.locator('#notice-text').textContent(), /-1/);
    await page.evaluate(() => window.launcher.openCrashReport());
    assert.equal(await app.evaluate(() => globalThis.__openedReport), report);
    const logs = await page.evaluate(() => window.launcher.getLogs());
    assert.ok(!logs.includes('fake-access-secret') && !logs.includes('fake-refresh-secret'));
    assert.deepEqual(errors, []);

    await app.close();
    app = await electron.launch(options);
    page = await app.firstWindow();
    await page.locator('#profile-top').click();
    const restored = await page.evaluate(() => window.launcher.getState());
    assert.equal(restored.account.name, 'UpdatedNick');
    await page.locator('[data-account-mode="local"]').click();
    await page.waitForFunction(() => document.getElementById('profile-chip-name').textContent === 'QuickNick');
    await page.waitForTimeout(650);
    await page.screenshot({ path: path.join(output, 'profile-local.png') });
    await page.locator('[data-account-mode="microsoft"]').click();
    await page.locator('#microsoft-logout').click();
    await page.waitForFunction(() => document.getElementById('microsoft-signed').hidden);
    assert.ok(!fs.existsSync(path.join(dataDirectory, 'microsoft-session.bin')));
    process.stdout.write('OK: nickname, device code, cancellation, DPAPI persistence, authenticated launch, Java agent, crash report, redaction and logout. Microsoft network and game process mocked.\n');
  } finally { await app.close(); }
}
main().catch((error) => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
