const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { manifest } = require('../main/updater');

// Выкладывает собранный лаунчер на сайт: загружает EXE частями через панель, сервер сверяет SHA-256,
// делает версию текущей, а скрипт проверяет файл обновлений тем же разбором, что и лаунчер.
//   npm run release            — собрать и выложить версию из package.json
//   npm run release:upload     — выложить уже собранный dist/Veyra-Launcher-Setup-<версия>.exe
// Флаги: --draft (загрузить без публикации), --replace (заменить файл уже выложенной версии), --file <путь>.
const root = path.join(__dirname, '..');
const SETTINGS = path.join(root, '.veyra-site.json');

function readSettings(file = SETTINGS) {
  if (!fs.existsSync(file)) throw new Error('Нет файла .veyra-site.json с адресом сайта и ключом. Выполните «npm run site» и загрузите сайт на хостинг.');
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!/^https?:\/\//.test(settings.url || '') || !settings.key) throw new Error('В .veyra-site.json нужны поля url и key');
  return settings;
}
// Пункты для версии берутся из CHANGELOG.md: раздел «## 0.7.3», строки «- …».
function changelog(version, file = path.join(root, 'CHANGELOG.md')) {
  if (!fs.existsSync(file)) return [];
  const notes = [];
  let inside = false;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const heading = line.match(/^##\s+v?(\d+(?:\.\d+){1,3})\b/);
    if (heading) { if (inside) break; inside = heading[1] === version; continue; }
    const item = inside && line.match(/^\s*[-*]\s+(.+)$/);
    if (item) notes.push(item[1].trim());
  }
  return notes.slice(0, 12);
}
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
const megabytes = bytes => (bytes / 1024 ** 2).toFixed(1) + ' МБ';

async function publish({ site, key, file, version, notes = [], draft = false, replace = false, fetch: fetcher = (...args) => fetch(...args), log = () => {} }) {
  const base = new URL(site.endsWith('/') ? site : site + '/');
  async function call(action, { body, query = {}, raw } = {}) {
    const url = new URL('admin/api.php', base);
    url.searchParams.set('action', action);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value));
    const headers = { 'X-Veyra-Key': key, Accept: 'application/json', 'User-Agent': 'VeyraPublish' };
    const options = { method: body !== undefined || raw ? 'POST' : 'GET', headers, signal: AbortSignal.timeout(180000) };
    if (raw) { headers['Content-Type'] = 'application/octet-stream'; options.body = raw; }
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
    const response = await fetcher(url, options);
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: response.status === 413 ? 'Сервер не принял такой большой кусок' : 'Сервер ответил HTTP ' + response.status + (response.status === 404 ? ': на сайте нет admin/api.php — загрузите свежую папку site' : '') }; }
    if (!response.ok) { const error = new Error(data.error || 'HTTP ' + response.status); error.status = response.status; error.data = data; throw error; }
    return data;
  }

  const size = fs.statSync(file).size, hash = await sha256(file);
  const status = await call('status');
  const existing = status.releases.find(release => release.version === version);
  let release;
  if (existing && existing.sha256 === hash && existing.exists) {
    // Тот же файл уже лежит на сайте: остаётся только опубликовать и обновить список изменений.
    log('Файл ' + version + ' уже на сайте, повторно не загружаем.\n');
    if (notes.length) await call('notes', { body: { version, notes } });
    release = draft || existing.current ? existing : (await call('publish', { body: { version } })).release;
  } else {
    if (existing && !replace) throw new Error('Версия ' + version + ' уже есть на сайте с другим файлом. Поднимите версию в package.json или запустите с флагом --replace.');
    const start = await call('upload-start', { body: { version, size, replace: Boolean(existing) } });
    let offset = start.received, chunk = start.chunk, failures = 0;
    const handle = await fs.promises.open(file, 'r'), started = Date.now();
    try {
      while (offset < size) {
        const length = Math.min(chunk, size - offset), buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, offset);
        try {
          offset = (await call('upload-chunk', { query: { id: start.id, offset }, raw: buffer })).received;
          failures = 0;
          const seconds = Math.max(.1, (Date.now() - started) / 1000);
          log('\rЗагрузка: ' + String(Math.floor(offset / size * 100)).padStart(3) + '% · ' + megabytes(offset) + ' из ' + megabytes(size) + ' · ' + (offset / seconds / 1024 ** 2).toFixed(1) + ' МБ/с   ');
        } catch (error) {
          // nginx и PHP ограничивают размер запроса по-разному: при отказе кусок уменьшается вдвое.
          // nginx на слишком большой запрос нередко просто рвёт соединение, поэтому обрыв тоже уменьшает кусок.
          if (error.status === 413 && chunk > 256 * 1024) { chunk = Math.floor(chunk / 2); continue; }
          if ((!error.status || error.status >= 500) && ++failures <= 6) { if (!error.status) chunk = Math.max(256 * 1024, Math.floor(chunk / 2)); await new Promise(resolve => setTimeout(resolve, 1000 * failures)); continue; }
          throw error;
        }
      }
    } catch (error) {
      await call('upload-cancel', { body: { id: start.id } }).catch(() => {});
      throw error;
    } finally { await handle.close(); }
    log('\nСервер проверяет файл…\n');
    release = (await call('upload-finish', { body: { id: start.id, sha256: hash, notes, publish: !draft } })).release;
  }
  if (draft) return { release, feed: null };

  // Файл обновлений читается так же, как его прочтёт лаунчер, и должен указывать на этот же файл.
  const feedUrl = new URL('update.php', base).href;
  const response = await fetcher(feedUrl, { headers: { 'User-Agent': 'VeyraPublish', Accept: 'application/json' }, cache: 'no-store' });
  if (!response.ok) throw new Error('update.php ответил HTTP ' + response.status);
  const feed = manifest(await response.json(), { base: feedUrl, insecure: base.hostname === '127.0.0.1' });
  if (feed.version !== version || feed.sha256 !== hash || feed.size !== size) throw new Error('update.php отдаёт ' + feed.version + ' вместо ' + version + ' — проверьте панель сайта');
  return { release, feed };
}

async function main() {
  const args = process.argv.slice(2), flag = name => args.includes(name);
  const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : ''; };
  const { version } = require('../package.json');
  const settings = readSettings();
  const file = path.resolve(option('--file') || path.join(root, 'dist', 'Veyra-Launcher-Setup-' + version + '.exe'));
  if (!fs.existsSync(file)) throw new Error('Нет файла ' + path.relative(root, file) + '. Сначала соберите лаунчер: npm run dist');
  const notes = changelog(version);
  if (!notes.length) process.stdout.write('Внимание: в CHANGELOG.md нет раздела «## ' + version + '» — версия выйдет без списка изменений.\n');
  process.stdout.write('Выкладываем Veyra ' + version + ' на ' + settings.url + (flag('--draft') ? ' черновиком' : '') + '…\n');
  const { release, feed } = await publish({ site: settings.url, key: settings.key, file, version, notes, draft: flag('--draft'), replace: flag('--replace'), log: text => process.stdout.write(text) });
  if (!feed) { process.stdout.write('Черновик ' + release.version + ' загружен. Опубликовать: панель сайта → «Сделать текущей» или npm run release:upload.\n'); return; }
  process.stdout.write('Готово: ' + release.version + ' — текущая версия на сайте (SHA-256 ' + feed.sha256.slice(0, 12) + '…, ' + megabytes(feed.size) + ').\n'
    + 'Лаунчеры 0.7.3+ увидят её при запуске или в течение шести часов. Панель: ' + new URL('admin/', settings.url.endsWith('/') ? settings.url : settings.url + '/').href + '\n');
}
if (require.main === module) main().catch((error) => { process.stderr.write('\nОшибка: ' + error.message + '\n'); process.exitCode = 1; });
module.exports = { publish, changelog, readSettings };
