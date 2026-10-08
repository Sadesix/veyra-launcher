const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
function safeIcon(url) { try { const value = new URL(url); return value.protocol === 'https:' && value.hostname === 'cdn.modrinth.com' ? value.href.slice(0, 4096) : ''; } catch { return ''; } }
function selections(value) {
  if (!Array.isArray(value) || value.length > 40) throw new Error('В корзине может быть до 40 проектов');
  const ids = new Set();
  return value.map(item => {
    if (!item || !['mods', 'shaders', 'resourcepacks'].includes(item.kind) || typeof item.projectId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(item.projectId) || ids.has(item.projectId)) throw new Error('Некорректный проект в корзине');
    ids.add(item.projectId);
    if (typeof item.versionId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(item.versionId)) throw new Error('Выберите версию проекта');
    return { projectId: item.projectId, kind: item.kind, versionId: item.versionId, preview: item.preview === true, title: String(item.title || item.projectId).slice(0, 180), version: String(item.version || '').slice(0, 100), icon: safeIcon(item.icon) };
  });
}
class CartStore {
  constructor(file) { this.file = file; this.queue = Promise.resolve(); }
  async read() {
    try {
      const text = await fs.readFile(this.file, 'utf8');
      const data = JSON.parse(text);
      if (data.schema !== 1 || !data.builds || typeof data.builds !== 'object' || Array.isArray(data.builds)) throw new Error();
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return { schema: 1, builds: {} };
      throw new Error('Не удалось прочитать сохранённую корзину. Файл content-carts.json оставлен для восстановления');
    }
  }
  async get(id) { await this.queue.catch(() => {}); return selections((await this.read()).builds[id] || []); }
  set(id, value) {
    const selected = selections(value);
    const operation = this.queue.catch(() => {}).then(async () => {
      const data = await this.read(); data.builds[id] = selected;
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temporary = this.file + '.tmp-' + randomUUID();
      try { await fs.writeFile(temporary, JSON.stringify(data)); await fs.rename(temporary, this.file); }
      finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      return selected;
    });
    this.queue = operation;
    return operation;
  }
}
module.exports = { CartStore, selections };
