const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {tmpdir} = require('node:os');
const {createHash} = require('node:crypto');
const {ContentManager} = require('../main/content-manager');

(async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'veyra-addon-'));
  try {
    const instance = {id:'test',directory,loader:'fabric',minecraftVersion:'1.21.1'};
    const baseBytes = Buffer.from('matching manual base');
    const addonBytes = Buffer.from('addon content');
    const mod = (project, bytes, dependencies = []) => ({
      id: project+'Version', project_id: project, version_number: '1.0',
      game_versions: ['1.21.1'], loaders: ['fabric'], dependencies,
      files: [{filename: project+'.jar', primary: true, size: bytes.length, hashes: {sha512: createHash('sha512').update(bytes).digest('hex')}}],
    });
    const versions = {
      base: mod('base', baseBytes),
      addon: mod('addon', addonBytes, [{dependency_type:'required', project_id:'base', version_id:'baseVersion'}]),
    };
    const content = new ContentManager();
    content.cached = async route => route.startsWith('/project/') ? {
      id: route.split('/').at(-1), title: route.split('/').at(-1), project_type:'mod',server_side:'required',
    } : versions[route.split('/').at(-1).replace(/Version$/, '')];
    content.versions = async (_instance, _kind, project) => [versions[project]];
    content.download = async (file, destination) => {
      assert.equal(file.filename,'addon.jar','matching dependency must not download again');
      await fs.writeFile(destination,addonBytes);
    };
    const mods = await content.root(instance,'mods');
    await fs.writeFile(path.join(mods,'manual-base.jar.disabled'),baseBytes);
    const plan = await content.plan(instance,'mods','addon');
    assert(plan.entries.find(node=>node.projectId==='base'&&node.installed&&node.disabled&&node.dependency));
    await content.install(instance,plan.token,new AbortController().signal,()=>{});
    assert.deepEqual(await fs.readFile(path.join(mods,'manual-base.jar')),baseBytes);
    assert.deepEqual(await fs.readFile(path.join(mods,'addon.jar')),addonBytes);
    const saved = await content.manifest(instance);
    assert.deepEqual(saved.items.find(item=>item.projectId==='addon').dependencies,['base']);
    assert.equal(saved.items.find(item=>item.projectId==='base').serverSide,'required');
    console.log('OK: add-on uses the matching manual dependency, re-enables it in the transaction and retains server compatibility.');
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
})().catch(error=>{console.error(error);process.exitCode=1;});
