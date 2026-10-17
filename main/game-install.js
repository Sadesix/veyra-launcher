const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { MinecraftFolder, Version } = require('@xmcl/core');
const { describeError } = require('./network');
// @xmcl/installer загружается ~0,2 с, поэтому подключается при первой установке, а не при запуске лаунчера.
const installer = () => require('@xmcl/installer');

function cancelled(operation) {
  if (operation.signal?.aborted) throw new Error('Операция отменена');
}

async function assetObjects(version, folder, operation, progress) {
  const info = version.assetIndex;
  if (!info?.url) throw new Error('У этой версии нет индекса ресурсов');
  const indexPath = folder.getAssetsIndex(version.assets);
  let bytes;
  try {
    bytes = await fs.readFile(indexPath);
    if (info.sha1 && createHash('sha1').update(bytes).digest('hex') !== info.sha1) bytes = null;
  } catch { bytes = null; }
  if (!bytes) {
    progress({ phase: 'Ресурсы', completed: 0, total: 0, message: 'Получаем индекс ресурсов' });
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      cancelled(operation);
      try {
        const response = await fetch(info.url, {
          signal: AbortSignal.any([operation.signal, AbortSignal.timeout(30000)]),
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        bytes = Buffer.from(await response.arrayBuffer());
        if (info.sha1 && createHash('sha1').update(bytes).digest('hex') !== info.sha1) {
          throw new Error('Контрольная сумма индекса не совпала');
        }
        await fs.mkdir(path.dirname(indexPath), { recursive: true });
        await fs.writeFile(indexPath, bytes);
        if (info.sha1 && info.sha1 !== version.assets) {
          await fs.writeFile(folder.getAssetsIndex(info.sha1), bytes);
        }
        break;
      } catch (error) {
        lastError = error;
        bytes = null;
        if (operation.signal.aborted) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 700));
      }
    }
    if (!bytes) throw new Error('Не удалось получить индекс ресурсов: ' + describeError(lastError));
  }
  let data;
  try { data = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Индекс ресурсов повреждён'); }
  if (!data.objects || typeof data.objects !== 'object') throw new Error('Индекс ресурсов имеет неверный формат');
  return Object.entries(data.objects).map(([name, item]) => ({ name, hash: item.hash, size: item.size }));
}

async function installLibraries(version, directory, operation, runTask, progress) {
  const libraries = version.libraries || [];
  const batchSize = 16;
  for (let index = 0; index < libraries.length; index += batchSize) {
    cancelled(operation);
    const batch = libraries.slice(index, index + batchSize);
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      cancelled(operation);
      try {
        const task = installer().installResolvedLibrariesTask(batch, directory, { throwErrorImmediately: true });
        await runTask(task, operation, 'Библиотеки');
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (operation.signal.aborted) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 600));
      }
    }
    if (lastError) throw new Error('Не удалось загрузить библиотеки: ' + describeError(lastError));
    progress({
      phase: 'Библиотеки',
      completed: Math.min(index + batch.length, libraries.length),
      total: libraries.length,
      message: 'Библиотеки: ' + Math.min(index + batch.length, libraries.length) + ' / ' + libraries.length,
    });
  }
}

async function installAssets(version, directory, operation, runTask, progress) {
  const folder = MinecraftFolder.from(directory);
  const objects = await assetObjects(version, folder, operation, progress);
  const total = objects.reduce((sum, item) => sum + Number(item.size || 0), 0);
  const batchSize = 24;
  let completed = 0;
  for (let index = 0; index < objects.length; index += batchSize) {
    cancelled(operation);
    const batch = objects.slice(index, index + batchSize);
    const batchBytes = batch.reduce((sum, item) => sum + Number(item.size || 0), 0);
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      cancelled(operation);
      try {
        await runTask(installer().installResolvedAssetsTask(batch, folder), operation, 'Ресурсы', (rootTask) => {
          const current = Number.isFinite(rootTask.progress) ? rootTask.progress : 0;
          progress({
            phase: 'Ресурсы',
            completed: Math.min(total, completed + current),
            total,
            message: 'Ресурсы: ' + Math.min(index + batch.length, objects.length) + ' / ' + objects.length,
          });
        });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (operation.signal.aborted) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 700));
      }
    }
    if (lastError) throw new Error('Не удалось загрузить ресурсы: ' + describeError(lastError));
    completed += batchBytes;
    progress({
      phase: 'Ресурсы',
      completed,
      total,
      message: 'Ресурсы: ' + Math.min(index + batch.length, objects.length) + ' / ' + objects.length,
    });
  }
}

async function installBase(instance, metadata, operation, runTask, progress) {
  await fs.mkdir(instance.directory, { recursive: true });
  progress({ phase: 'Minecraft', completed: 0, total: 0, message: 'Получаем файлы версии ' + instance.minecraftVersion });
  const version = await runTask(installer().installVersionTask(metadata, instance.directory, { side: 'client' }), operation, 'Minecraft');
  cancelled(operation);
  await installLibraries(version, instance.directory, operation, runTask, progress);
  cancelled(operation);
  await installAssets(version, instance.directory, operation, runTask, progress);
  return version;
}

async function installModdedLibraries(directory, versionId, operation, runTask, progress) {
  const version = await Version.parse(directory, versionId);
  await installLibraries(version, directory, operation, runTask, progress);
}

module.exports = { installBase, installModdedLibraries };
