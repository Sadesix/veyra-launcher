const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { ServerManager, portFree } = require('../main/server-manager');
async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veyra-server-check-'));
  const holder = net.createServer(); await new Promise(resolve => holder.listen(0, '127.0.0.1', resolve)); const port = holder.address().port;
  try { await assert.rejects(portFree(port), /уже занят/); } finally { await new Promise(resolve => holder.close(resolve)); }
  let cancelInstaller = false; const urls = [], commands = [];
  const fetcher = async url => { urls.push(String(url)); if (String(url).endsWith('version.json')) return new Response(JSON.stringify({ downloads: { server: { url: 'https://fixture/server.jar', sha1: createHash('sha1').update('jar').digest('hex') } } })); if (String(url).endsWith('/installer')) return new Response(JSON.stringify([{ stable: true, version: '1.1.2' }])); return new Response('jar'); };
  const spawner = (java, args, options) => {
    commands.push(args);
    if (args.includes('--installServer')) {
      if (!cancelInstaller) { require('node:fs').writeFileSync(path.join(options.cwd, 'run.bat'), 'java @user_jvm_args.txt @libraries/net/example/win_args.txt %*'); require('node:fs').mkdirSync(path.join(options.cwd, 'libraries/net/example'), { recursive: true }); require('node:fs').writeFileSync(path.join(options.cwd, 'libraries/net/example/win_args.txt'), 'fixture'); }
      return spawn(process.execPath, ['-e', cancelInstaller ? 'setInterval(()=>{},1000)' : 'console.log("installer output");'], options);
    }
    return spawn(process.execPath, ['-e', "console.log('Done (0.1s)!');process.stdin.on('data',b=>{if(String(b).includes('stop')){require('fs').writeFileSync('saved.txt','saved');process.exit(0)}});setInterval(()=>{},1000);"], options);
  };
  for (const loader of ['vanilla', 'fabric', 'forge', 'neoforge']) {
    const instance = { id: loader, directory: path.join(directory, loader), minecraftVersion: '1.21.8', loaderVersion: loader === 'fabric' ? '0.17.2' : '21.8.1', loader };
    await fs.mkdir(path.join(instance.directory, 'mods'), { recursive: true });
    const manager = new ServerManager({ fetch: fetcher, spawn: spawner, port });
    await assert.rejects(manager.start(instance, { url: 'https://fixture/version.json' }, 'java', 1, false, new AbortController().signal), /EULA/);
    await manager.start(instance, { url: 'https://fixture/version.json' }, 'java', 1, true, new AbortController().signal);
    assert.equal(await manager.stop(), true); assert.equal(await fs.readFile(path.join(instance.directory, '.veyra-server', 'saved.txt'), 'utf8'), 'saved');
    const props = await fs.readFile(path.join(instance.directory, '.veyra-server', 'server.properties'), 'utf8'); assert.match(props, /online-mode=false/); assert.match(props, /server-ip=0.0.0.0/);
    assert.ok(!await fs.stat(path.join(instance.directory, 'eula.txt')).catch(() => null), 'Client directory must not receive server files');
    const marker = JSON.parse(await fs.readFile(path.join(instance.directory, '.veyra-server', '.veyra-server-ready.json'), 'utf8'));
    if (loader === 'forge' || loader === 'neoforge') assert.deepEqual(marker.args, ['@libraries/net/example/win_args.txt']);
  }
  assert.ok(urls.some(url => url.includes('meta.fabricmc.net/v2/versions/loader/1.21.8/0.17.2/1.1.2/server/jar')));
  assert.equal(commands.filter(args => args.includes('--installServer')).length, 2);
  cancelInstaller = true;
  const instance = { id: 'cancel', directory: path.join(directory, 'cancel'), minecraftVersion: '1.21.8', loader: 'forge', loaderVersion: '21.8.1' }; await fs.mkdir(path.join(instance.directory, 'mods'), { recursive: true });
  const manager = new ServerManager({ fetch: fetcher, spawn: (...args) => { const child = spawner(...args); setTimeout(() => controller.abort(), 100); return child; }, port }); const controller = new AbortController();
  await assert.rejects(manager.start(instance, { url: 'https://fixture/version.json' }, 'java', 1, true, controller.signal)); assert.equal(manager.run, null); assert.equal(manager.state.status, 'stopped');
  process.stdout.write('OK: occupied port, EULA gating, dedicated Vanilla/Fabric/Forge/NeoForge preparation, safe argument-file launches, graceful stop/save, isolation and cancellation of a real installer child. Downloads/processes use fixtures.\n');
}
main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
