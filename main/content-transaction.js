const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const path = require('node:path');

const UUID = /^[a-f0-9-]{36}$/;
async function exists(file) { try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function checksum(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Файл установки должен быть обычным файлом');
  const hash = createHash('sha512');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
async function atomic(file, value) {
  const temporary = file + '.tmp-' + randomUUID();
  try { await fs.writeFile(temporary, JSON.stringify(value)); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}

// The move is recorded before touching game files. Recovery can infer a move
// completed even if the process died between rename() and the next statement.
class ContentTransaction {
  constructor(directory, id) {
    this.directory = path.resolve(directory);
    this.file = path.join(this.directory, '.veyra-content-transaction.json');
    this.data = { schema: 1, id, moves: [] };
    this.started = false;
  }
  resolve(relative) {
    if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('Некорректный путь восстановления');
    const parts = relative.split(/[\\/]/);
    const valid = parts.length === 2 && ['mods', 'shaderpacks', 'resourcepacks'].includes(parts[0]) || parts.length === 2 && parts[0] === '.veyra-content-trash' && UUID.test(parts[1]) || parts.length === 3 && parts[0] === '.veyra-content-staging' && parts[1] === this.data.id;
    if (!valid || parts.some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part))) throw new Error('Некорректный путь восстановления');
    return path.join(this.directory, ...parts);
  }
  async checkParents(file) {
    let directory = path.dirname(file);
    while (true) {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Папка восстановления содержит ссылку');
      if (directory === this.directory) return;
      directory = path.dirname(directory);
    }
  }
  async begin() { await atomic(this.file, this.data); this.started = true; }
  async move(source, target) {
    const from = path.relative(this.directory, source), to = path.relative(this.directory, target);
    this.resolve(from); this.resolve(to);
    if (await exists(target)) throw new Error('Файл появился во время установки: ' + path.basename(target));
    await this.checkParents(source); await this.checkParents(target);
    const sha512 = await checksum(source);
    this.data.moves.push({ from, to, sha512 });
    await atomic(this.file, this.data);
    await fs.rename(source, target);
  }
  async cleanup() {
    const stage = path.join(this.directory, '.veyra-content-staging', this.data.id);
    // A checked UUID under the verified staging directory is the only recursive target.
    if (!UUID.test(this.data.id)) throw new Error('Некорректная папка восстановления');
    if (await exists(stage)) { await this.checkParents(path.join(stage, 'probe')); await fs.rm(stage, { recursive: true, force: true }); }
    await fs.rm(this.file, { force: true });
  }
  async finish() { await this.cleanup(); }
  async recover() {
    let manifest;
    try { manifest = JSON.parse(await fs.readFile(path.join(this.directory, '.veyra-content.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Сведения об установке повреждены. Резервные копии сохранены'); }
    if (manifest?.transactionId !== this.data.id) {
      for (const move of [...this.data.moves].reverse()) {
        const from = this.resolve(move.from), to = this.resolve(move.to);
        if (!await exists(to)) continue;
        if (await exists(from)) throw new Error('Файлы изменены вне лаунчера. Резервные копии сохранены для восстановления');
        await this.checkParents(from); await this.checkParents(to);
        if (await checksum(to) !== move.sha512) throw new Error('Файл после сбоя изменён. Резервные копии сохранены для восстановления');
        await fs.rename(to, from);
      }
    }
    await this.cleanup();
  }
  static async recover(directory) {
    const transaction = new ContentTransaction(directory, '');
    if (!await exists(transaction.file)) return;
    const stat = await fs.lstat(transaction.file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Некорректный журнал восстановления');
    const data = JSON.parse(await fs.readFile(transaction.file, 'utf8'));
    if (data.schema !== 1 || !UUID.test(data.id) || !Array.isArray(data.moves) || data.moves.length > 180 || data.moves.some(move => !move || !/^[a-f0-9]{128}$/.test(move.sha512))) throw new Error('Журнал восстановления повреждён. Резервные копии сохранены');
    transaction.data = data;
    for (const move of data.moves) { transaction.resolve(move.from); transaction.resolve(move.to); }
    await transaction.recover();
  }
}
module.exports = { ContentTransaction };
