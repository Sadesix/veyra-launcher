const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { ZipFile } = require('yazl');
const { buildFiles, inspectBuild } = require('../main/controller-build');
const { fileHash } = require('../main/modpacks');
const { declaredServerSide } = require('../main/server-manager');

async function jar(file, files) {
  const zip = new ZipFile();
  for (const [name, text] of Object.entries(files)) zip.addBuffer(Buffer.from(text), name);
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(file));
}

async function main() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'veyra-server-mods-'));
  try {
    const mods = path.join(directory, 'mods');
    await fs.mkdir(mods);
    const file = name => path.join(mods, name);
    await jar(file('renamed-renderer.jar'), {
      'META-INF/neoforge.mods.toml': 'modLoader = "javafml"\n[[mods]]\nmodId = "sodium"\n',
      'net/caffeinemc/mods/sodium/service/SodiumWorkarounds.class': '',
    });
    await jar(file('sodium-name-only.jar'), {
      'META-INF/neoforge.mods.toml': '[[mods]]\nmodId = "different_mod"\n',
    });
    await jar(file('graphics-addon.jar'), { 'META-INF/neoforge.mods.toml': '[[mods]]\nmodId = "client_addon"\n' });
    await jar(file('server-lib.jar'), { 'META-INF/neoforge.mods.toml': '[[mods]]\nmodId = "server_lib"\n' });
    const fromHash = {
      [await fileHash(file('graphics-addon.jar'), 'sha1')]: { project_id: 'client' },
      [await fileHash(file('server-lib.jar'), 'sha1')]: { project_id: 'common' },
    };
    const build = { directory, loader: 'neoforge' };
    const lookup = async id => ({ server_side: id === 'client' ? 'unsupported' : 'required' });
    const fromFiles = async hashes => {
      assert(!hashes.includes(await fileHash(file('renamed-renderer.jar'), 'sha1')));
      return fromHash;
    };
    const result = await inspectBuild(build, lookup, fromFiles);
    const byName = new Map(result.mods.map(mod => [mod.name, mod]));
    assert.equal(byName.get('renamed-renderer.jar').supported, false);
    assert.equal(byName.get('sodium-name-only.jar').supported, true);
    assert.equal(byName.get('sodium-name-only.jar').verified, false);
    assert.equal(byName.get('graphics-addon.jar').supported, false);
    assert.equal(byName.get('server-lib.jar').verified, true);
    const noLookup = async () => { throw new Error('classified mods should use their persisted decision'); };
    let calls = 0;
    const rejectRepeated = (...args) => { calls++; return noLookup(...args); };
    assert.deepEqual((await inspectBuild(build, rejectRepeated, rejectRepeated)).mods, result.mods);
    assert.equal(calls, 0);
    assert.deepEqual((await inspectBuild(build)).mods, result.mods);
    const copy = await buildFiles(build, ['renamed-renderer.jar', 'server-lib.jar']);
    assert.deepEqual(copy.files.map(item => item.remote), ['mods/server-lib.jar']);
    await jar(file('forge-client.jar'), { 'META-INF/mods.toml': 'clientSideOnly = true\n[[mods]]\nmodId="client"\n' });
    await jar(file('fabric-client.jar'), { 'fabric.mod.json': '{"environment":"client"}' });
    assert.equal(await declaredServerSide(file('forge-client.jar'), 'forge'), 'unsupported');
    assert.equal(await declaredServerSide(file('fabric-client.jar'), 'fabric'), 'unsupported');
    console.log('OK: renamed Sodium, unmanaged Modrinth mod lookup, existing Forge/Fabric metadata and controller transfer guard.');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
