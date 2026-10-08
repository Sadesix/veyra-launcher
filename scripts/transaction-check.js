const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ContentManager } = require('../main/content-manager');
const { ContentTransaction } = require('../main/content-transaction');
const { CartStore } = require('../main/cart-store');
const { fixtures } = require('./content-check');
const picks = [{ kind: 'mods', projectId: 'mainmod', versionId: 'mod2' }, { kind: 'mods', projectId: 'secondmod', versionId: 'second1' }];
const instanceFor = directory => ({ id: 'aurora', directory, minecraftVersion: '1.21.8', loader: 'fabric' });
const managerFor = () => new ContentManager({ fetch: fixtures().fetcher });
const install = (manager, instance, plan) => manager.install(instance, plan.token, new AbortController().signal, () => {});
async function worker(directory, point) {
  const manager = managerFor(), instance = instanceFor(directory);
  if (point === 'begin') {
    const begin = ContentTransaction.prototype.begin;
    ContentTransaction.prototype.begin = async function () { await begin.call(this); process.exit(79); };
  } else if (point === 'manifest') {
    const save = manager.save;
    manager.save = async function (...args) { await save.apply(this, args); process.exit(79); };
  } else {
    const move = ContentTransaction.prototype.move; let count = 0;
    ContentTransaction.prototype.move = async function (...args) { await move.apply(this, args); if (++count === Number(point)) process.exit(79); };
  }
  await install(manager, instance, await manager.planBatch(instance, picks));
  throw new Error('Crash point was not reached: ' + point);
}
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'veyra-recovery-'));
  for (const point of ['begin', '1', '2', '3', '4', 'manifest']) {
    const directory = path.join(root, point), manager = managerFor(), instance = instanceFor(directory);
    await install(manager, instance, await manager.plan(instance, 'mods', 'mainmod', { versionId: 'mod1' }));
    const before = await manager.manifest(instance);
    const original = await fs.readFile(path.join(directory, 'mods', 'mainmod-1.0.jar'));
    const store = new CartStore(path.join(root, 'carts-' + point + '.json')); await store.set(instance.id, picks);
    const crashed = spawnSync(process.execPath, [__filename, '--crash-worker', directory, point], { windowsHide: true, encoding: 'utf8' });
    assert.equal(crashed.status, 79, crashed.stderr);
    const recovered = managerFor();
    const listed = await recovered.list(instance, 'mods');
    if (point === 'manifest') {
      assert.equal(listed.entries.length, 3); assert.ok(listed.entries.some(item => item.versionId === 'mod2'));
      assert.equal(listed.trash.length, 1, 'Committed update keeps the original version in trash');
      const repeated = await install(recovered, instance, await recovered.planBatch(instance, picks));
      assert.equal(repeated.added, 0, 'A committed batch can be safely retried after a crash');
    } else {
      assert.equal(listed.entries.length, 2); assert.deepEqual(await recovered.manifest(instance), before);
      assert.deepEqual(await fs.readFile(path.join(directory, 'mods', 'mainmod-1.0.jar')), original);
      await install(recovered, instance, await recovered.planBatch(instance, picks));
      assert.equal((await recovered.list(instance, 'mods')).entries.length, 3);
    }
    assert.equal((await store.get(instance.id)).length, 2, 'No crash point discards cart selections');
    assert.deepEqual(await fs.readdir(path.join(directory, '.veyra-content-staging')), []);
    await assert.rejects(fs.stat(path.join(directory, '.veyra-content-transaction.json')), { code: 'ENOENT' });
  }
  // Never remove or move an externally changed file during recovery.
  const directory = path.join(root, 'changed'), manager = managerFor(), instance = instanceFor(directory);
  await install(manager, instance, await manager.plan(instance, 'mods', 'mainmod', { versionId: 'mod1' }));
  assert.equal(spawnSync(process.execPath, [__filename, '--crash-worker', directory, '1'], { windowsHide: true }).status, 79);
  const journalPath = path.join(directory, '.veyra-content-transaction.json');
  const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  const backup = path.join(directory, journal.moves[0].to);
  await fs.writeFile(backup, 'externally changed');
  await assert.rejects(managerFor().recover(instance), /изменён/);
  assert.equal(await fs.readFile(backup, 'utf8'), 'externally changed');
  const outside = path.join(root, 'keep.txt'); await fs.writeFile(outside, 'keep');
  journal.moves[0].to = '../../keep.txt'; await fs.writeFile(journalPath, JSON.stringify(journal));
  await assert.rejects(managerFor().recover(instance), /путь/);
  assert.equal(await fs.readFile(outside, 'utf8'), 'keep');
  process.stdout.write('OK: abrupt exit during download preparation, every commit move and after manifest save; original mods recover, completed installs remain, retry is idempotent, cart persists, changed files and external paths are preserved.\n');
}
(process.argv[2] === '--crash-worker' ? worker(process.argv[3], process.argv[4]) : main()).catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
