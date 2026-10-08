const {
  getLoaderArtifactListFor,
  installFabric,
  installForgeTask,
  installNeoForgedTask,
} = require('@xmcl/installer');

const FORGE_METADATA = 'https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json';
const FORGE_PROMOTIONS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const NEOFORGE_METADATA = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml';
const cache = new Map();

function validVersion(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._+-]{1,100}$/.test(value);
}

async function getText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error('Сервер загрузчика вернул HTTP ' + response.status);
  return response.text();
}

async function getJson(url) {
  return JSON.parse(await getText(url));
}

function sortVersions(items) {
  return items.sort((a, b) => b.id.localeCompare(a.id, 'en', { numeric: true }));
}

async function fetchLoaderVersions(loader, minecraftVersion) {
  if (!validVersion(minecraftVersion)) throw new Error('Некорректная версия Minecraft');
  if (loader === 'vanilla') return [];
  const key = loader + ':' + minecraftVersion;
  const previous = cache.get(key);
  if (previous && Date.now() - previous.time < 10 * 60 * 1000) return previous.items;
  try {
    let items;
    if (loader === 'fabric') {
      const artifacts = await getLoaderArtifactListFor(minecraftVersion);
      items = artifacts.map((artifact) => ({
        id: artifact.loader.version,
        stable: Boolean(artifact.loader.stable),
        label: artifact.loader.version + (artifact.loader.stable ? '' : ' · beta'),
      }));
    } else if (loader === 'forge') {
      const [all, promotions] = await Promise.all([getJson(FORGE_METADATA), getJson(FORGE_PROMOTIONS)]);
      const recommended = promotions.promos?.[minecraftVersion + '-recommended'];
      const versions = Array.isArray(all[minecraftVersion]) ? all[minecraftVersion] : [];
      items = versions.map((full) => {
        const id = full.startsWith(minecraftVersion + '-') ? full.slice(minecraftVersion.length + 1) : '';
        return {
          id,
          stable: true,
          label: id + (id === recommended ? ' · рекомендуется' : ''),
          recommended: id === recommended,
        };
      }).filter((item) => validVersion(item.id));
    } else if (loader === 'neoforge') {
      const prefix = (minecraftVersion.startsWith('1.') ? minecraftVersion.slice(2) : minecraftVersion) + '.';
      const xml = await getText(NEOFORGE_METADATA);
      items = [...xml.matchAll(/<version>([^<]+)<\/version>/g)]
        .map((match) => match[1])
        .filter((id) => id.startsWith(prefix) && validVersion(id))
        .map((id) => ({
          id,
          stable: !/-(beta|alpha|snapshot|rc)/i.test(id),
          label: id + (/-beta/i.test(id) ? ' · beta' : ''),
        }));
    } else {
      throw new Error('Неизвестный загрузчик');
    }
    items = sortVersions(items);
    const stable = items.filter((item) => item.stable);
    if (stable.length) items = [...stable, ...items.filter((item) => !item.stable)];
    cache.set(key, { time: Date.now(), items });
    return items;
  } catch (error) {
    if (previous) return previous.items;
    throw error;
  }
}

async function installLoader(instance, javaPath, runTask, processOptions = {}) {
  if (instance.loader === 'vanilla') return instance.minecraftVersion;
  if (!validVersion(instance.loaderVersion)) throw new Error('Выберите версию загрузчика');
  const directory = instance.directory;
  if (instance.loader === 'fabric') {
    return installFabric({
      minecraftVersion: instance.minecraftVersion,
      version: instance.loaderVersion,
      minecraft: directory,
      side: 'client',
    });
  }
  if (instance.loader === 'forge') {
    const full = instance.minecraftVersion + '-' + instance.loaderVersion;
    const task = installForgeTask({
      mcversion: instance.minecraftVersion,
      version: instance.loaderVersion,
      installer: {
        path: 'https://maven.minecraftforge.net/net/minecraftforge/forge/' + full + '/forge-' + full + '-installer.jar',
      },
    }, directory, {
      ...processOptions,
      side: 'client',
      java: javaPath,
      mavenHost: ['https://maven.minecraftforge.net', 'https://maven.neoforged.net/releases'],
    });
    return runTask(task);
  }
  if (instance.loader === 'neoforge') {
    const task = installNeoForgedTask('neoforge', instance.loaderVersion, directory, {
      ...processOptions,
      side: 'client',
      java: javaPath,
      mavenHost: ['https://maven.neoforged.net/releases', 'https://maven.minecraftforge.net'],
    });
    return runTask(task);
  }
  throw new Error('Неизвестный загрузчик');
}

module.exports = { fetchLoaderVersions, installLoader, validVersion };
