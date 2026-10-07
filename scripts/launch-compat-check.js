const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { launch, Version } = require('@xmcl/core');
const { prechecks, javaArguments } = require('../main/launch-runtime');

async function main() {
  process.stdout.write('Preparing isolated NeoForge launch…\n');
  const resources = path.resolve(process.argv[2]);
  const marker = JSON.parse(fs.readFileSync(path.join(resources, '.veyra-instance-ready.json'), 'utf8'));
  assert.equal(marker.loaderVersion, '26.3.0.56-beta');
  const root = path.join(__dirname, '..');
  const gamePath = path.join(root, 'test-output', 'compat-game');
  fs.mkdirSync(gamePath, { recursive: true });
  // Reach the title screen, where the reported NeoForge failure happens.
  fs.writeFileSync(path.join(gamePath, 'options.txt'), 'onboardAccessibility:false\nlang:ru_ru\n');
  const version = await Version.parse(resources, marker.versionId);
  process.stdout.write('Version parsed; checking resources and natives…\n');
  const javaPath = path.join(process.env.APPDATA, 'veyra-launcher', 'runtimes', 'java-runtime-epsilon', 'bin', 'java.exe');
  const child = await launch({
    gamePath, resourcePath: resources, javaPath, version,
    nativeRoot: path.join(gamePath, 'natives'),
    gameProfile: { name: 'CompatTest', id: 'a'.repeat(32) }, accessToken: '0', userType: 'legacy',
    maxMemory: 4096, extraJVMArgs: javaArguments(['-javaagent:' + path.join(root, 'assets', 'compat', 'neoforge-version-guard.jar')]),
    resolution: { width: 854, height: 480 }, extraExecOption: { windowsHide: true },
    prechecks: prechecks.map((check) => async (...args) => {
      process.stdout.write('Checking ' + check.name + '…\n');
      await check(...args);
      process.stdout.write(check.name + ' complete.\n');
    }),
  });
  process.stdout.write('Minecraft process started.\n');
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    const result = await Promise.race([
      new Promise((resolve) => child.once('close', (code) => resolve({ code }))),
      new Promise((resolve) => setTimeout(() => resolve({ alive: true }), 50000)),
    ]);
    fs.writeFileSync(path.join(gamePath, 'launch-output.log'), output);
    assert.ok(result.alive, 'Game exited: ' + result.code + '\n' + output.slice(-6000));
    assert.ok(output.includes('NeoForge update-check null guard active.'), output.slice(-5000));
    assert.ok(!output.includes('Reported exception thrown!'), output.slice(-5000));
    process.stdout.write('OK: NeoForge 26.3.0.56-beta reached the menu and remained alive for 50 seconds with the compatibility guard.\n');
  } finally { child.kill(); }
}
// ZIP prechecks may use workers without active handles. Keep this check alive
// until the complete launch assertion has finished, with a bounded deadline.
const deadline = setTimeout(() => { process.stderr.write('Launch check timed out.\n'); process.exit(1); }, 120000);
main().catch((error) => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; })
  .finally(() => clearTimeout(deadline));
