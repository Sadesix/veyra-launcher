const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const sharp = require('sharp');
const { chromium, _electron: electron } = require('playwright-core');

// Проверяет трёхмерный просмотр скина (renderer/skin3d.js) в Edge по пикселям снимков.
// Тестовые скины рисуются здесь же: каждая грань каждой части — свой цвет, левая верхняя четверть грани — тот же цвет вдвое темнее.
// По цвету видно, какая часть развёртки попала на грань, а по тёмной четверти — как она повёрнута и не отражена ли.
const root = path.join(__dirname, '..');
const output = path.join(root, 'test-output');
const FACES = ['top', 'bottom', 'right', 'front', 'left', 'back'];
// Развёртка игрока 64×64 (как в игре): основной слой и второй слой каждой части, размеры коробки.
const PARTS = slim => [
  { name: 'head', uv: [0, 0], over: [32, 0], size: [8, 8, 8] },
  { name: 'body', uv: [16, 16], over: [16, 32], size: [8, 12, 4] },
  { name: 'rightArm', uv: [40, 16], over: [40, 32], size: [slim ? 3 : 4, 12, 4] },
  { name: 'leftArm', uv: [32, 48], over: [48, 48], size: [slim ? 3 : 4, 12, 4] },
  { name: 'rightLeg', uv: [0, 16], over: [0, 32], size: [4, 12, 4] },
  { name: 'leftLeg', uv: [16, 48], over: [0, 48], size: [4, 12, 4] },
];
const regions = ([u, v], [w, h, d]) => ({ top: [u + d, v, w, d], bottom: [u + d + w, v, w, d], right: [u, v + d, d, h], front: [u + d, v + d, w, h], left: [u + d + w, v + d, d, h], back: [u + 2 * d + w, v + d, w, h] });
// К какой соседней грани прилегает левый верхний угол развёртки каждой грани (по ModelPart.Cube в игре):
// по горизонтали и по вертикали. Например, левый край лица — правый бок игрока, верх лица — макушка, верх макушки — затылок.
const CORNER = { front: ['right', 'top'], back: ['left', 'top'], right: ['back', 'top'], left: ['front', 'top'], top: ['right', 'back'], bottom: ['right', 'back'] };
// Ракурсы: имя совпадает с гранью, которая смотрит в камеру. Положительное рысканье поворачивает лицо модели вправо.
const VIEWS = [['front', 0, 0], ['back', 180, 0], ['right', 90, 0], ['left', -90, 0], ['top', 0, 90], ['bottom', 0, -90]];

const hsv = (hue, saturation, value) => [5, 3, 1].map(n => { const k = (n + hue / 60) % 6; return Math.round(255 * (value - value * saturation * Math.max(0, Math.min(k, 4 - k, 1)))); });
const PALETTE = Array.from({ length: 36 }, (_value, index) => hsv(index * 70 % 360, .85, .95));
const WHITE = [255, 255, 255], GREY = [128, 128, 128];
const CANDIDATES = [...PALETTE, WHITE, GREY];
const colorOf = (part, face) => PALETTE[['head', 'body', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg'].indexOf(part) * 6 + FACES.indexOf(face)];
const darker = color => color.map(channel => Math.round(channel / 2));

// ── Тестовые скины ──
function fixture({ slim = false, layer = 'base', legacy = false, keepHat = false } = {}) {
  const width = 64, height = legacy ? 32 : 64, data = Buffer.alloc(width * height * 4);
  const put = (x, y, color, alpha = 255) => data.set([...color, alpha], (y * width + x) * 4);
  const paint = ([x, y, w, h], color) => {
    for (let row = 0; row < h; row++) for (let column = 0; column < w; column++) put(x + column, y + row, column < Math.floor(w / 2) && row < Math.floor(h / 2) ? darker(color) : color);
  };
  if (legacy) for (let y = 0; y < 32; y++) for (let x = 32; x < 64; x++) put(x, y, WHITE); // сплошь непрозрачная шапка и пустые места рядом
  for (const part of PARTS(slim)) {
    if (legacy && (part.name === 'leftArm' || part.name === 'leftLeg')) continue;
    const base = regions(part.uv, part.size), over = regions(part.over, part.size);
    for (const face of FACES) {
      if (layer === 'base') paint(base[face], colorOf(part.name, face));
      else { paint(base[face], GREY); paint(over[face], colorOf(part.name, face)); }
    }
  }
  // Хотя бы один прозрачный пиксель в области 32,0–64,32 (не только в шапке, как в игре) — и хак Нотча не срабатывает.
  if (keepHat === 'hat') put(63, 0, WHITE, 0);
  if (keepHat === 'pad') put(33, 17, WHITE, 0);
  return sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
}
// Голова для drawHead: лицо одного цвета, у шапки закрашена только верхняя строка.
function headFixture() {
  const data = Buffer.alloc(64 * 64 * 4);
  for (let y = 8; y < 16; y++) for (let x = 8; x < 16; x++) data.set([...PALETTE[3], 255], (y * 64 + x) * 4);
  for (let x = 40; x < 48; x++) data.set([...PALETTE[20], 255], (8 * 64 + x) * 4);
  return sharp(data, { raw: { width: 64, height: 64, channels: 4 } }).png().toBuffer();
}
// Лицо с прозрачными пикселями основного слоя: игра делает их непрозрачными и оставляет записанный в файле цвет.
const CLEAR = [[1, 1, [255, 255, 255, 0]], [2, 1, [200, 100, 50, 40]]];
function clearFixture() {
  const data = Buffer.alloc(64 * 64 * 4);
  for (let y = 8; y < 16; y++) for (let x = 8; x < 16; x++) data.set([...PALETTE[3], 255], (y * 64 + x) * 4);
  for (const [x, y, color] of CLEAR) data.set(color, ((8 + y) * 64 + 8 + x) * 4);
  return sharp(data, { raw: { width: 64, height: 64, channels: 4 } }).png().toBuffer();
}

// ── Страница и сервер ──
const page = `<!doctype html><html><head><meta charset="utf-8"><title>skin3d</title>
<style>html,body{margin:0;background:#201b22}#stage{position:fixed;left:0;top:0;width:480px;height:480px}#shot{position:fixed;left:500px;top:0;width:360px;height:480px;background:#2f2932}</style></head>
<body><div id="stage"></div><div id="shot"></div>
<script>
  // Ошибки окна вроде «ResizeObserver loop…» не попадают в pageerror, поэтому собираются отдельно.
  window.windowErrors = [];
  window.addEventListener('error', event => window.windowErrors.push(String(event.message)));
  window.frameCount = 0;
  // window.slowFrames — кадры раз в 50 мс (20 Гц) вместо частоты экрана: так видно, что инерция считается по времени.
  const raf = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
  window.requestAnimationFrame = callback => window.slowFrames
    ? -setTimeout(() => { window.frameCount++; callback(performance.now()); }, 50)
    : raf(time => { window.frameCount++; callback(time); });
  window.cancelAnimationFrame = id => id < 0 ? clearTimeout(-id) : cancel(id);
</script>
<script src="/renderer/skin3d.js"></script></body></html>`;
const files = new Map();
const server = http.createServer(async (request, response) => {
  const name = decodeURIComponent(new URL(request.url, 'http://local').pathname);
  if (name === '/') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return response.end(page); }
  if (name === '/site.html' || name === '/nested/launcher.html') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return response.end('<!doctype html><meta charset="utf-8"><script src="' + (name === '/site.html' ? '/site/assets/skin3d.js' : '/nested/renderer/skin3d.js') + '"></script>');
  }
  if (name === '/favicon.ico') { response.writeHead(204); return response.end(); }
  // Строгая политика как в админке сайта: ни встроенных скриптов, ни атрибутов style — модель всё равно должна работать.
  if (name === '/strict.html') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'" });
    return response.end('<!doctype html><meta charset="utf-8"><body><script src="/renderer/skin3d.js"></script><script src="/strict.js"></script></body>');
  }
  if (name === '/strict.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript' });
    return response.end("document.body.style.margin = '0'; const box = document.createElement('div'); box.id = 'stage'; box.style.width = '480px'; box.style.height = '480px'; document.body.append(box);\n" +
      "window.current = VeyraSkin.view(box, { skin: '/fixtures/base.png', rotate: false, animation: 'none', yaw: 0, pitch: 0 });");
  }
  if (files.has(name)) {
    // ?delay=… — медленный ответ для проверки гонок.
    const delay = Number(new URL(request.url, 'http://local').searchParams.get('delay')) || 0;
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    response.writeHead(200, { 'Content-Type': 'image/png' });
    return response.end(files.get(name));
  }
  const script = /\/skin3d\.js$/.test(name) ? path.join(root, 'renderer', 'skin3d.js') : null;
  const file = script || (name.startsWith('/assets/skins/') ? path.join(root, name) : null);
  if (!file || !fs.existsSync(file)) { response.writeHead(404); return response.end(); }
  response.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'image/png' });
  fs.createReadStream(file).pipe(response);
});
// Другой адрес с теми же скинами: /cors/… разрешает чтение пикселей, /plain/… — нет (картинка «пачкает» холст).
const foreign = http.createServer((request, response) => {
  const [, mode, name] = /^\/(cors|plain)(\/fixtures\/.+)$/.exec(new URL(request.url, 'http://local').pathname) || [];
  if (!files.has(name)) { response.writeHead(404); return response.end(); }
  response.writeHead(200, { 'Content-Type': 'image/png', ...mode === 'cors' ? { 'Access-Control-Allow-Origin': '*' } : {} });
  response.end(files.get(name));
});

// ── Пиксели снимка ──
async function shot(tab) {
  const { data, info } = await sharp(await tab.screenshot({ clip: { x: 0, y: 0, width: 480, height: 480 } })).raw().toBuffer({ resolveWithObject: true });
  return (x, y) => {
    const sum = [0, 0, 0];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const index = ((Math.round(y) + dy) * info.width + Math.round(x) + dx) * info.channels;
      for (let channel = 0; channel < 3; channel++) sum[channel] += data[index + channel];
    }
    return sum.map(value => value / 9);
  };
}
// Цвет узнаётся по оттенку: тень грани и тёмная четверть меняют только яркость.
function residual(sample, color) {
  const scale = sample.reduce((sum, value, index) => sum + value * color[index], 0) / color.reduce((sum, value) => sum + value * value, 0);
  return { scale, error: Math.hypot(...sample.map((value, index) => value - scale * color[index])) };
}
function identify(sample) {
  let best = null;
  for (const color of CANDIDATES) { const { scale, error } = residual(sample, color); if (scale > .25 && scale < 1.15 && (!best || error < best.error)) best = { color, error }; }
  return best?.color;
}
const same = (a, b) => a && b && a.every((value, index) => value === b[index]);
const brightness = color => color[0] + color[1] + color[2];
const centre = box => [box.x + box.w / 2, box.y + box.h / 2];

async function open(tab, options) {
  await tab.evaluate(async options => {
    window.current?.destroy();
    window.current = window.VeyraSkin.view(document.getElementById('stage'), { rotate: false, animation: 'none', ...options });
    await window.current.ready;
  }, options);
}
// Оставляет на сцене одну часть тела (или всю модель) и возвращает рамки её граней на экране.
function isolate(tab, part) {
  return tab.evaluate(part => {
    const stage = document.getElementById('stage');
    for (const node of stage.querySelectorAll('[data-part]')) node.style.display = !part || node.dataset.part === part ? '' : 'none';
    stage.querySelector('[data-shadow]').style.display = part ? 'none' : '';
    const result = {};
    for (const face of stage.querySelectorAll('[data-face]')) {
      const box = face.getBoundingClientRect();
      result[face.closest('[data-part]').dataset.part + ':' + face.parentNode.dataset.layer + ':' + face.dataset.face] = { x: box.left, y: box.top, w: box.width, h: box.height };
    }
    return result;
  }, part);
}
// Грань, смотрящая в камеру: её цвет и угол с тёмной четвертью на экране.
function inspect(pixel, rects, part, layer, face) {
  const box = rects[part + ':' + layer + ':' + face];
  assert.ok(box && box.w > 8 && box.h > 8, part + ' ' + layer + ' ' + face + ' is visible');
  const quadrants = [['left', 'top', .25, .25], ['right', 'top', .75, .25], ['left', 'bottom', .25, .75], ['right', 'bottom', .75, .75]]
    .map(([h, v, fx, fy]) => ({ h, v, color: pixel(box.x + box.w * fx, box.y + box.h * fy) }));
  quadrants.sort((a, b) => brightness(a.color) - brightness(b.color));
  const [marker, ...rest] = quadrants, light = rest.reduce((sum, item) => sum + brightness(item.color), 0) / 3;
  const ratio = brightness(marker.color) / light;
  const average = [0, 1, 2].map(channel => rest.reduce((sum, item) => sum + item.color[channel], 0) / 3);
  // Соседние грани показывают, где на экране «право игрока», «верх» и так далее.
  const [cx, cy] = centre(box), [across, down] = CORNER[face];
  const expected = [centre(rects[part + ':base:' + across])[0] < cx ? 'left' : 'right', centre(rects[part + ':base:' + down])[1] < cy ? 'top' : 'bottom'];
  return { color: identify(average), marker: [marker.h, marker.v], ratio, expected };
}
const flipped = ([h, v]) => [h === 'left' ? 'right' : 'left', v];
// Голова скина по умолчанию прямо из файла: шапка там, где она непрозрачна, иначе лицо.
async function defaultHead(slim) {
  const { data } = await sharp(path.join(root, 'assets', 'skins', slim ? 'veyra-slim.png' : 'veyra-classic.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const expected = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const hat = ((8 + y) * 64 + 40 + x) * 4, face = ((8 + y) * 64 + 8 + x) * 4;
    expected.push(...(data[hat + 3] ? data.subarray(hat, hat + 3) : data.subarray(face, face + 3)), 255);
  }
  return expected;
}

// ── Лаунчер в Electron: страница file:// с CSP лаунчера, скины аккаунта по veyra://skin/<hash> ──
// Схема зарегистрирована так, как это делает лаунчер для скинов: corsEnabled и Access-Control-Allow-Origin в ответе.
// Без этого холст «пачкается»: хак Нотча не применяется, а голову с аватарки нельзя прочитать.
async function electronCheck() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-skin3d-'));
  const csp = /<meta http-equiv="Content-Security-Policy"[^>]*>/.exec(fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8'))[0];
  fs.writeFileSync(path.join(folder, 'legacy.png'), await fixture({ legacy: true }));
  fs.writeFileSync(path.join(folder, 'clear.png'), await clearFixture());
  fs.writeFileSync(path.join(folder, 'index.html'), '<!doctype html><html><head><meta charset="utf-8">' + csp + '</head><body style="margin:0">' +
    '<div id="stage" style="width:300px;height:400px"></div><script src="' + pathToFileURL(path.join(root, 'renderer', 'skin3d.js')).href + '"></script></body></html>');
  fs.writeFileSync(path.join(folder, 'main.js'), `const { app, BrowserWindow, protocol } = require('electron');
const fs = require('node:fs'), path = require('node:path');
app.setPath('userData', path.join(__dirname, 'data'));
protocol.registerSchemesAsPrivileged([{ scheme: 'veyra', privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true } }]);
let window = null;
app.whenReady().then(() => {
  protocol.handle('veyra', request => {
    const url = new URL(request.url), file = path.join(__dirname, path.basename(url.pathname) + '.png');
    if (url.hostname !== 'skin' || !fs.existsSync(file)) return new Response('', { status: 404 });
    return new Response(fs.readFileSync(file), { headers: { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' } });
  });
  window = new BrowserWindow({ width: 640, height: 480, show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  window.loadFile(path.join(__dirname, 'index.html'));
});
app.on('window-all-closed', () => app.quit());
`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: require('electron'), args: [path.join(folder, 'main.js')], env, timeout: 120000 });
  try {
    const win = await app.firstWindow(), problems = [];
    win.on('console', message => { if (message.type() === 'error') problems.push(message.text()); });
    win.on('pageerror', error => problems.push(error.message));
    await win.waitForFunction(() => !!window.VeyraSkin);
    const result = await win.evaluate(async () => {
      const read = async url => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8;
        await window.VeyraSkin.drawHead(canvas, url);
        try { return [...canvas.getContext('2d').getImageData(0, 0, 8, 8).data]; } catch { return 'tainted'; }
      };
      const view = window.VeyraSkin.view(document.getElementById('stage'), { skin: 'veyra://skin/legacy', rotate: false, animation: 'none', yaw: 0, pitch: 0 });
      await view.ready;
      return { state: view.element.dataset.state, over: view.element.querySelectorAll('[data-layer="over"] [data-face]').length, legacy: await read('veyra://skin/legacy'), clear: await read('veyra://skin/clear'), fallback: await read(null) };
    });
    assert.equal(result.state, 'ready', 'Electron: veyra:// skin loads');
    assert.equal(result.over, 0, 'Electron: the opaque hat of a legacy veyra:// skin is hidden (Notch hack)');
    assert.notEqual(result.legacy, 'tainted', 'Electron: a veyra:// head does not taint the canvas');
    const texel = (data, x, y) => data.slice((y * 8 + x) * 4, (y * 8 + x) * 4 + 4);
    assert.deepEqual(texel(result.legacy, 4, 4), [...colorOf('head', 'front'), 255], 'Electron: legacy veyra:// head shows the face, not the hat');
    for (const [x, y, color] of CLEAR) assert.deepEqual(texel(result.clear, x, y), [...color.slice(0, 3), 255], 'Electron: transparent base pixel keeps its stored colour');
    assert.deepEqual(result.fallback, await defaultHead(false), 'Electron: default skin from ../assets/skins/');
    assert.deepEqual(problems, [], 'Electron: no console errors');
  } finally { await app.close(); fs.rmSync(folder, { recursive: true, force: true }); }
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  // Скины по умолчанию: 64×64, основной слой непрозрачен, второй слой есть.
  for (const name of ['veyra-classic', 'veyra-slim']) {
    const { data, info } = await sharp(path.join(root, 'assets', 'skins', name + '.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([info.width, info.height], [64, 64], name);
    for (const part of PARTS(name.endsWith('slim'))) for (const [x, y, w, h] of Object.values(regions(part.uv, part.size))) {
      for (let row = y; row < y + h; row++) for (let column = x; column < x + w; column++) assert.equal(data[(row * 64 + column) * 4 + 3], 255, name + ' base layer is opaque at ' + column + ',' + row);
    }
    let overlay = 0;
    for (const part of PARTS(name.endsWith('slim'))) for (const [x, y, w, h] of Object.values(regions(part.over, part.size))) {
      for (let row = y; row < y + h; row++) for (let column = x; column < x + w; column++) if (data[(row * 64 + column) * 4 + 3]) overlay++;
    }
    assert.ok(overlay > 150, name + ' has a second layer');
  }

  files.set('/fixtures/base.png', await fixture());
  files.set('/fixtures/over.png', await fixture({ layer: 'over' }));
  files.set('/fixtures/slim.png', await fixture({ slim: true }));
  files.set('/fixtures/slim-over.png', await fixture({ slim: true, layer: 'over' }));
  files.set('/fixtures/legacy.png', await fixture({ legacy: true }));
  files.set('/fixtures/legacy-hat.png', await fixture({ legacy: true, keepHat: 'hat' }));
  files.set('/fixtures/legacy-pad.png', await fixture({ legacy: true, keepHat: 'pad' }));
  files.set('/fixtures/head.png', await headFixture());
  files.set('/fixtures/clear.png', await clearFixture());
  {
    // В самом файле прозрачные пиксели хранят свой цвет — иначе проверка ниже ничего бы не доказывала.
    const { data } = await sharp(files.get('/fixtures/clear.png')).raw().toBuffer({ resolveWithObject: true });
    for (const [x, y, color] of CLEAR) assert.deepEqual([...data.subarray(((8 + y) * 64 + 8 + x) * 4, ((8 + y) * 64 + 8 + x) * 4 + 4)], color, 'clear.png keeps the colour of a transparent pixel');
  }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port, elsewhere = 'http://127.0.0.1:' + foreign.address().port;
  const browser = await chromium.launch({ channel: 'msedge' });
  try {
    const context = await browser.newContext({ viewport: { width: 900, height: 520 } });
    const tab = await context.newPage(), errors = [];
    tab.on('pageerror', error => errors.push(error.message));
    // Ожидаемые ошибки: отсутствующий скин и запрет CORS у «чужого» адреса без заголовков.
    tab.on('console', message => { if (message.type() === 'error' && !/\/fixtures\/missing\.png(?:\s|$)|\/plain\/fixtures\//.test(message.location().url + ' ' + message.text())) errors.push(message.text()); });
    await tab.goto(url + '/');

    // Скрипт находит скины по умолчанию рядом с собой: renderer/ → ../assets/skins/, assets/ → skins/.
    assert.equal(await tab.evaluate(() => window.VeyraSkin.defaultSkin(false)), url + '/assets/skins/veyra-classic.png');
    for (const [address, expected] of [['/site.html', '/site/assets/skins/veyra-slim.png'], ['/nested/launcher.html', '/nested/assets/skins/veyra-slim.png']]) {
      const other = await context.newPage();
      await other.goto(url + address);
      assert.equal(await other.evaluate(() => window.VeyraSkin.defaultSkin(true)), url + expected);
      await other.close();
    }

    // ── Каждая грань каждой части: нужный кусок развёртки, без лишних поворотов и отражений ──
    let checked = 0;
    const sweep = async ({ skin, slim = false, layer = 'base', parts, expect }) => {
      for (const [view, yaw, pitch] of VIEWS) {
        await open(tab, { skin, slim, yaw, pitch });
        for (const part of parts) {
          const rects = await isolate(tab, part), pixel = await shot(tab);
          const result = inspect(pixel, rects, part, layer, view), { color, mirror } = expect(part, view);
          const label = skin + ' ' + part + ' ' + layer + ' ' + view;
          assert.ok(same(result.color, color), label + ': expected colour ' + color + ', got ' + result.color);
          assert.ok(result.ratio < .7, label + ': the darker quarter is visible (' + result.ratio.toFixed(2) + ')');
          assert.deepEqual(result.marker, mirror ? flipped(result.expected) : result.expected, label + ': texture orientation');
          if (layer === 'over') {
            // Второй слой раздут как в игре: шапка на 0,5 пикселя с каждой стороны, остальное на 0,25.
            const [w, h, d] = PARTS(slim).find(item => item.name === part).size, grow = part === 'head' ? .5 : .25;
            const [fw, fh] = { front: [w, h], back: [w, h], right: [d, h], left: [d, h], top: [w, d], bottom: [w, d] }[view];
            const outer = rects[part + ':over:' + view], inner = rects[part + ':base:' + view];
            assert.ok(Math.abs(outer.w / inner.w - (fw + grow * 2) / fw) < .02 && Math.abs(outer.h / inner.h - (fh + grow * 2) / fh) < .02, label + ': second layer is inflated');
          }
          checked++;
        }
      }
    };
    const all = PARTS(false).map(part => part.name);
    await sweep({ skin: '/fixtures/base.png', parts: all, expect: (part, face) => ({ color: colorOf(part, face) }) });
    await sweep({ skin: '/fixtures/over.png', layer: 'over', parts: all, expect: (part, face) => ({ color: colorOf(part, face) }) });
    await sweep({ skin: '/fixtures/slim.png', slim: true, parts: ['rightArm', 'leftArm'], expect: (part, face) => ({ color: colorOf(part, face) }) });
    await sweep({ skin: '/fixtures/slim-over.png', slim: true, layer: 'over', parts: ['rightArm', 'leftArm'], expect: (part, face) => ({ color: colorOf(part, face) }) });
    // Старый скин: левые рука и нога — зеркальные копии правых (бока меняются местами).
    const mirrorSide = { left: 'right', right: 'left' };
    await sweep({ skin: '/fixtures/legacy.png', parts: all, expect: (part, face) => {
      const source = { leftArm: 'rightArm', leftLeg: 'rightLeg' }[part];
      return source ? { color: colorOf(source, mirrorSide[face] || face), mirror: true } : { color: colorOf(part, face) };
    } });

    // ── Модель целиком: правая рука игрока слева от зрителя, голова сверху, тонкие руки в 3 пикселя ──
    const whole = async (skin, slim, yaw, pitch) => { await open(tab, { skin, slim, yaw, pitch }); return { rects: await isolate(tab, null), pixel: await shot(tab) }; };
    const partBox = (rects, part) => {
      const boxes = Object.entries(rects).filter(([key]) => key.startsWith(part + ':base:')).map(([, box]) => box);
      const left = Math.min(...boxes.map(box => box.x)), top = Math.min(...boxes.map(box => box.y));
      return { x: left, y: top, w: Math.max(...boxes.map(box => box.x + box.w)) - left, h: Math.max(...boxes.map(box => box.y + box.h)) - top };
    };
    const at = (pixel, x, y) => identify(pixel(x, y));
    for (const slim of [false, true]) {
      const { rects, pixel } = await whole(slim ? '/fixtures/slim.png' : '/fixtures/base.png', slim, 0, 0);
      const arm = partBox(rects, 'rightArm'), body = partBox(rects, 'body'), head = partBox(rects, 'head'), leg = partBox(rects, 'rightLeg');
      const [ax, ay] = [arm.x + arm.w * .75, arm.y + arm.h * .75], [bx, by] = [body.x + body.w * .75, body.y + body.h * .75];
      assert.ok(same(at(pixel, ax, ay), colorOf('rightArm', 'front')) && same(at(pixel, bx, by), colorOf('body', 'front')), 'Front view shows the arm and body fronts');
      assert.ok(same(at(pixel, head.x + head.w * .75, head.y + head.h * .75), colorOf('head', 'front')), 'Front view shows the face');
      assert.ok(ax < bx, 'The right arm is on the viewer\'s left when the player faces us');
      assert.ok(centre(head)[1] < centre(body)[1] && centre(body)[1] < centre(leg)[1], 'Head above body above legs');
      // Руки длиной 12 пикселей; тонкие в игре опущены на полпикселя ниже плеч.
      const armFront = rects['rightArm:base:front'], bodyFront = rects['body:base:front'], unit = bodyFront.h / 12;
      assert.ok(Math.abs(armFront.h / unit - 12) < .15 && Math.abs((armFront.y - bodyFront.y) / unit - (slim ? .5 : 0)) < .1, (slim ? 'Slim' : 'Classic') + ' arm placement');
      // Ширина руки по пикселям того же цвета в строке — относительно туловища в 8 пикселей.
      const run = (y, color, from) => { let start = from, end = from; while (same(at(pixel, start - 1, y), color)) start--; while (same(at(pixel, end + 1, y), color)) end++; return end - start + 1; };
      const ratio = run(ay, colorOf('rightArm', 'front'), ax) / run(ay, colorOf('body', 'front'), bx);
      assert.ok(Math.abs(ratio - (slim ? 3 / 8 : 4 / 8)) < .04, (slim ? 'Slim' : 'Classic') + ' arm width ratio ' + ratio.toFixed(3));
    }
    {
      const { rects, pixel } = await whole('/fixtures/base.png', false, 0, 90);
      const head = partBox(rects, 'head');
      assert.ok(same(at(pixel, head.x + head.w * .75, head.y + head.h * .75), colorOf('head', 'top')), 'From above the top of the head is seen');
    }
    {
      const { rects, pixel } = await whole('/fixtures/base.png', false, 0, -90);
      const leg = rects['rightLeg:base:bottom'];
      assert.ok(same(at(pixel, leg.x + leg.w * .75, leg.y + leg.h * .75), colorOf('rightLeg', 'bottom')), 'From below the soles are seen');
    }
    {
      // Положительное рысканье разворачивает лицо вправо: видны лицо и правый бок, лицо правее.
      const { rects, pixel } = await whole('/fixtures/base.png', false, 50, 0);
      const front = rects['head:base:front'], side = rects['head:base:right'];
      assert.ok(same(at(pixel, front.x + front.w * .75, front.y + front.h * .75), colorOf('head', 'front')) && same(at(pixel, side.x + side.w * .75, side.y + side.h * .75), colorOf('head', 'right')));
      assert.ok(centre(front)[0] > centre(side)[0], 'Positive yaw turns the face to the right');
    }

    // ── Старый скин: без второго слоя на теле; сплошная шапка прозрачна (хак Нотча), шапка с прозрачным пикселем видна ──
    {
      const { rects, pixel } = await whole('/fixtures/legacy.png', false, 0, 0);
      assert.equal(Object.keys(rects).filter(key => key.includes(':over:')).length, 0, 'Legacy skin has no second layer, and its opaque hat is hidden');
      const head = rects['head:base:front'];
      assert.ok(same(at(pixel, head.x + head.w * .75, head.y + head.h * .75), colorOf('head', 'front')));
    }
    for (const skin of ['/fixtures/legacy-hat.png', '/fixtures/legacy-pad.png']) {
      const { rects, pixel } = await whole(skin, false, 0, 0);
      assert.deepEqual(Object.keys(rects).filter(key => key.includes(':over:')).map(key => key.split(':')[0]).filter((value, index, list) => list.indexOf(value) === index), ['head']);
      const hat = rects['head:over:front'];
      assert.ok(same(at(pixel, hat.x + hat.w * .75, hat.y + hat.h * .75), WHITE), 'A legacy hat with transparency in 32,0–64,32 stays visible: ' + skin);
    }

    // ── drawHead: лицо 8×8 и шапка поверх; старая сплошная шапка не рисуется; без скина — свой скин по умолчанию ──
    const head = (skin, slim) => tab.evaluate(async ([skin, slim]) => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8;
      await window.VeyraSkin.drawHead(canvas, skin, slim);
      return [...canvas.getContext('2d').getImageData(0, 0, 8, 8).data];
    }, [skin, slim]);
    const texel = (data, x, y) => data.slice((y * 8 + x) * 4, (y * 8 + x) * 4 + 4);
    const fixtureHead = await head('/fixtures/head.png');
    assert.deepEqual(texel(fixtureHead, 3, 0), [...PALETTE[20], 255], 'Hat layer is drawn over the face');
    assert.deepEqual(texel(fixtureHead, 3, 5), [...PALETTE[3], 255], 'Face shows through the transparent hat');
    assert.deepEqual(texel(await head('/fixtures/legacy.png'), 4, 4), [...colorOf('head', 'front'), 255], 'Opaque legacy hat is skipped');
    assert.deepEqual(texel(await head('/fixtures/legacy-hat.png'), 4, 4), [...WHITE, 255], 'Legacy hat with transparency is drawn');
    // Как setNoAlpha в игре: прозрачный пиксель основного слоя становится непрозрачным с записанным в файле цветом, а не чёрным.
    const clearHead = await head('/fixtures/clear.png');
    for (const [x, y, color] of CLEAR) assert.deepEqual(texel(clearHead, x, y), [...color.slice(0, 3), 255], 'Transparent base pixel ' + x + ',' + y + ' keeps its stored colour');
    assert.deepEqual(texel(clearHead, 4, 4), [...PALETTE[3], 255]);
    const raced = await tab.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8;
      await Promise.all([window.VeyraSkin.drawHead(canvas, '/fixtures/legacy-hat.png?delay=300'), window.VeyraSkin.drawHead(canvas, '/fixtures/head.png')]);
      return [...canvas.getContext('2d').getImageData(0, 0, 8, 8).data];
    });
    assert.deepEqual(texel(raced, 3, 5), [...PALETTE[3], 255], 'A slow earlier drawHead does not overwrite a newer one');
    for (const slim of [false, true]) {
      const expected = await defaultHead(slim);
      assert.deepEqual(await head(null, slim), expected, 'Default ' + (slim ? 'slim' : 'classic') + ' head');
      assert.deepEqual(await head('/fixtures/missing.png', slim), expected, 'Missing skin falls back to the default head');
    }

    // ── setSkin меняет текстуру, недоступный скин заменяется скином по умолчанию ──
    const headColour = async () => {
      const rects = await isolate(tab, null), pixel = await shot(tab), box = rects['head:over:front'] || rects['head:base:front'];
      return at(pixel, box.x + box.w * .75, box.y + box.h * .75);
    };
    await open(tab, { skin: '/fixtures/base.png', yaw: 0, pitch: 0 });
    assert.ok(same(await headColour(), colorOf('head', 'front')));
    await tab.evaluate(() => window.current.setSkin('/fixtures/legacy-hat.png'));
    assert.equal(await tab.evaluate(() => window.current.element.dataset.state), 'ready');
    assert.ok(same(await headColour(), WHITE), 'setSkin swaps the texture');
    await tab.evaluate(() => window.current.setSkin(null, false));
    const defaultShot = await tab.screenshot({ clip: { x: 0, y: 0, width: 480, height: 480 } });
    await tab.evaluate(() => window.current.setSkin('/fixtures/missing.png'));
    assert.equal(await tab.evaluate(() => window.current.element.dataset.state), 'fallback');
    assert.ok(defaultShot.equals(await tab.screenshot({ clip: { x: 0, y: 0, width: 480, height: 480 } })), 'A broken skin shows the default skin');
    await tab.evaluate(() => Promise.all([window.current.setSkin('/fixtures/legacy-hat.png?delay=300'), window.current.setSkin('/fixtures/base.png')]));
    assert.ok(same(await headColour(), colorOf('head', 'front')), 'A slow earlier setSkin does not replace a newer skin');
    await tab.evaluate(() => window.current.setSkin('/fixtures/slim.png', true));
    assert.equal(await tab.evaluate(() => getComputedStyle(document.querySelector('#stage [data-part="rightArm"] [data-layer="base"] [data-face="front"]')).width), '30px', 'setSkin switches to slim arms');

    // ── Анимации: ходьба машет руками и ногами в противофазе, дыхание покачивает руки, «none» стоит ──
    const limbs = () => tab.evaluate(() => Object.fromEntries([...document.querySelectorAll('#stage [data-part]')].map(node => [node.dataset.part, node.style.transform])));
    const angle = (transform, axis) => Number(new RegExp('rotate' + axis + '\\((-?[\\d.]+)deg\\)').exec(transform)[1]);
    await open(tab, { skin: '/fixtures/base.png', animation: 'walk' });
    const walk = [];
    for (let step = 0; step < 6; step++) { walk.push(await limbs()); await tab.waitForTimeout(110); }
    assert.ok(new Set(walk.map(item => item.rightArm)).size > 3, 'Walking moves the arms');
    const swing = walk.find(item => Math.abs(angle(item.rightArm, 'X')) > 5) || walk[0];
    assert.ok(Math.sign(angle(swing.rightArm, 'X')) === -Math.sign(angle(swing.leftArm, 'X')) && Math.sign(angle(swing.rightArm, 'X')) === -Math.sign(angle(swing.rightLeg, 'X')), 'Arms and legs swing in opposite phases');
    await tab.evaluate(() => window.current.setAnimation('idle'));
    const idle = [];
    for (let step = 0; step < 4; step++) { idle.push(await limbs()); await tab.waitForTimeout(150); }
    assert.ok(new Set(idle.map(item => item.rightArm)).size > 2 && idle.every(item => angle(item.rightArm, 'Z') >= 0 && angle(item.leftArm, 'Z') <= 0), 'Idle sways the arms outwards');
    await tab.evaluate(() => window.current.setAnimation('none'));
    await tab.waitForTimeout(100);
    const still = await limbs(), frames = await tab.evaluate(() => window.frameCount);
    await tab.waitForTimeout(300);
    assert.deepEqual(await limbs(), still);
    assert.equal(await tab.evaluate(() => window.frameCount), frames, 'A still model without rotation does not request frames');

    // ── Вращение мышью: рысканье без ограничений, наклон ограничен ──
    await open(tab, { skin: '/fixtures/base.png', rotate: true, yaw: 0, pitch: 10 });
    const scene = () => tab.evaluate(() => document.querySelector('#stage [data-part]').parentNode.style.transform);
    const before = angle(await scene(), 'Y');
    await tab.mouse.move(240, 240); await tab.mouse.down(); await tab.mouse.move(300, 240, { steps: 6 }); await tab.mouse.move(360, 240, { steps: 6 }); await tab.mouse.up();
    assert.ok(angle(await scene(), 'Y') - before > 45, 'Dragging right turns the model');
    await tab.mouse.move(240, 100); await tab.mouse.down(); await tab.mouse.move(240, 470, { steps: 10 }); await tab.mouse.up();
    assert.equal(angle(await scene(), 'X'), -65, 'Pitch is clamped from above');
    await tab.mouse.move(240, 470); await tab.mouse.down(); await tab.mouse.move(240, 0, { steps: 10 }); await tab.mouse.move(240, 470, { steps: 2 }); await tab.mouse.move(240, 0, { steps: 2 }); await tab.mouse.up();
    assert.equal(angle(await scene(), 'X'), 35, 'Pitch is clamped from below');
    // Бросок: быстрое движение с отпусканием докручивает модель; если указатель замер перед отпусканием, модель остаётся на месте
    // (дальше только покачивание не больше 7°).
    await open(tab, { skin: '/fixtures/base.png', rotate: true, yaw: 0, pitch: 0 });
    await tab.mouse.move(240, 240); await tab.mouse.down(); await tab.mouse.move(300, 240, { steps: 4 });
    await tab.waitForTimeout(1500);
    const held = angle(await scene(), 'Y');
    await tab.mouse.up();
    await tab.waitForTimeout(800);
    const drift = angle(await scene(), 'Y') - held;
    assert.ok(Math.abs(drift) <= 7.5, 'A pointer held still before release does not fling the model (drift ' + drift.toFixed(1) + '°)');
    await tab.mouse.move(240, 240); await tab.mouse.down(); await tab.mouse.move(300, 240, { steps: 4 }); await tab.mouse.up();
    const flung = angle(await scene(), 'Y');
    await tab.waitForTimeout(800);
    const travel = angle(await scene(), 'Y') - flung;
    assert.ok(travel > 15 && travel < 160, 'A quick flick keeps the model turning for a while (' + travel.toFixed(1) + '°)');
    // При 20 кадрах в секунду докрутка за 300 мс проходит ту же долю пути, что и при частоте экрана (около 85%);
    // счёт по кадрам прошёл бы меньше половины. Углы снимаются в самой странице от момента отпускания.
    await open(tab, { skin: '/fixtures/base.png', rotate: true, yaw: 0, pitch: 0 });
    await tab.evaluate(() => {
      window.slowFrames = true; window.fling = {};
      const read = () => Number(/rotateY\((-?[\d.]+)deg\)/.exec(document.querySelector('#stage [data-part]').parentNode.style.transform)[1]);
      window.addEventListener('pointerup', () => {
        window.fling.start = read();
        setTimeout(() => { window.fling.middle = read(); }, 300);
        setTimeout(() => { window.fling.end = read(); }, 1600);
      }, { once: true });
    });
    await tab.mouse.move(150, 240); await tab.mouse.down(); await tab.mouse.move(330, 240, { steps: 3 }); await tab.mouse.up();
    await tab.waitForTimeout(1800);
    const fling = await tab.evaluate(() => { window.slowFrames = false; return window.fling; });
    const share = (fling.middle - fling.start) / (fling.end - fling.start);
    assert.ok(fling.end - fling.start > 30 && share > .65, 'Fling decays by time, not by frames (' + JSON.stringify(fling) + ', ' + share.toFixed(2) + ')');

    // ── destroy убирает разметку и останавливает кадры ──
    await open(tab, { skin: '/fixtures/base.png', animation: 'walk', rotate: true });
    await tab.waitForTimeout(200);
    const running = await tab.evaluate(() => window.frameCount);
    await tab.waitForTimeout(200);
    assert.ok(await tab.evaluate(() => window.frameCount) > running, 'Animated model requests frames');
    await tab.evaluate(() => { window.current.destroy(); window.current = null; });
    assert.equal(await tab.evaluate(() => document.getElementById('stage').childElementCount), 0, 'destroy removes the model');
    const stopped = await tab.evaluate(() => window.frameCount);
    await tab.waitForTimeout(300);
    assert.equal(await tab.evaluate(() => window.frameCount), stopped, 'destroy stops the animation');

    // ── Без движения по просьбе системы: ни ходьбы, ни покачивания, но мышью вращать можно ──
    const calmContext = await browser.newContext({ viewport: { width: 900, height: 520 }, reducedMotion: 'reduce' });
    const calm = await calmContext.newPage();
    calm.on('pageerror', error => errors.push(error.message));
    await calm.goto(url + '/');
    await calm.evaluate(async () => { window.current = window.VeyraSkin.view(document.getElementById('stage'), { skin: '/fixtures/base.png', animation: 'walk', rotate: true }); await window.current.ready; });
    const snapshot = () => calm.evaluate(() => [...document.querySelectorAll('#stage [data-part]')].map(node => node.style.transform).join('|') + document.querySelector('#stage [data-part]').parentNode.style.transform);
    const first = await snapshot();
    await calm.waitForTimeout(400);
    assert.equal(await snapshot(), first, 'Reduced motion: no automatic motion');
    await calm.mouse.move(240, 240); await calm.mouse.down(); await calm.mouse.move(320, 240, { steps: 5 }); await calm.mouse.up();
    assert.notEqual(await snapshot(), first, 'Reduced motion: dragging still rotates');
    await calmContext.close();

    // ── Скин с другого адреса: с CORS всё как дома; без CORS пиксели не читаются, но модель всё равно верная (кроме хака Нотча) ──
    {
      const { rects, pixel } = await whole(elsewhere + '/cors/fixtures/legacy.png', false, 0, 0), face = rects['head:base:front'];
      assert.equal(await tab.evaluate(() => window.current.element.dataset.state), 'ready');
      assert.ok(same(at(pixel, face.x + face.w * .75, face.y + face.h * .75), colorOf('head', 'front')), 'Cross-origin skin with CORS gets the Notch hack');
    }
    {
      const { rects, pixel } = await whole(elsewhere + '/plain/fixtures/base.png', false, 0, 0);
      assert.equal(await tab.evaluate(() => window.current.element.dataset.state), 'ready');
      for (const part of ['head', 'body', 'rightArm', 'leftLeg']) {
        const box = rects[part + ':base:front'];
        assert.ok(same(at(pixel, box.x + box.w * .75, box.y + box.h * .75), colorOf(part, 'front')), 'Cross-origin skin without CORS: ' + part);
      }
      const legacy = await whole(elsewhere + '/plain/fixtures/legacy.png', false, 0, 0), arm = legacy.rects['leftArm:base:front'];
      assert.ok(same(at(legacy.pixel, arm.x + arm.w * .75, arm.y + arm.h * .75), colorOf('rightArm', 'front')), 'Cross-origin legacy skin without CORS still mirrors the left arm');
      assert.equal(await tab.evaluate(async address => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8; return (await window.VeyraSkin.drawHead(canvas, address)) === canvas; }, elsewhere + '/plain/fixtures/base.png'), true, 'drawHead accepts a cross-origin skin');
    }

    // ── Строгий CSP, скрытый контейнер и контейнер без высоты ──
    {
      const strict = await context.newPage(), violations = [];
      strict.on('console', message => { if (message.type() === 'error') violations.push(message.text()); });
      strict.on('pageerror', error => violations.push(error.message));
      await strict.goto(url + '/strict.html');
      await strict.evaluate(() => window.current.ready);
      const rects = await isolate(strict, null), pixel = await shot(strict), face = rects['head:base:front'];
      assert.ok(same(at(pixel, face.x + face.w * .75, face.y + face.h * .75), colorOf('head', 'front')), 'Works under a strict CSP without inline styles');
      assert.deepEqual(violations, []);
      await strict.close();
    }
    const sizes = await tab.evaluate(async () => {
      const hidden = document.createElement('div'), auto = document.createElement('div'), wrap = document.createElement('div'), loose = document.createElement('div');
      hidden.style.cssText = 'display:none;width:240px;height:320px';
      auto.style.cssText = 'width:300px';
      // Скрытая обёртка вокруг контейнера без высоты: после показа модель получает 3:4 без ошибок ResizeObserver.
      wrap.style.cssText = 'display:none';
      loose.style.cssText = 'width:240px';
      wrap.append(loose);
      document.body.append(hidden, auto, wrap);
      const views = [hidden, auto, loose].map(box => window.VeyraSkin.view(box, { rotate: false, animation: 'none' }));
      await Promise.all(views.map(item => item.ready));
      hidden.style.display = 'block'; wrap.style.display = 'block';
      await new Promise(resolve => setTimeout(resolve, 300));
      const size = item => [item.element.clientWidth, item.element.clientHeight, item.element.querySelector('[data-face="front"]').getBoundingClientRect().width];
      const result = { hidden: size(views[0]), auto: size(views[1]), loose: size(views[2]) };
      for (const item of views) item.destroy();
      hidden.remove(); auto.remove(); wrap.remove();
      return result;
    });
    assert.deepEqual(sizes.hidden.slice(0, 2), [240, 320], 'A view created in a hidden container keeps its size');
    assert.ok(sizes.hidden[2] > 40, 'A view created hidden fits the model once shown');
    assert.deepEqual(sizes.auto.slice(0, 2), [300, 400], 'A container without height gets a 3:4 view');
    assert.deepEqual(sizes.loose.slice(0, 2), [240, 320], 'A hidden container without height gets a 3:4 view once shown');
    assert.ok(sizes.loose[2] > 40, 'A hidden container without height fits the model once shown');
    assert.deepEqual(await tab.evaluate(() => window.windowErrors), [], 'No window errors (ResizeObserver loop and the like)');

    // ── Без WebGL: запасной путь через холст 2D — зеркало старого скина, хак Нотча и голова на месте,
    // только прозрачные пиксели основного слоя здесь чёрные, а не цвета из файла ──
    {
      const bare = await browser.newContext({ viewport: { width: 900, height: 520 } });
      await bare.addInitScript(() => {
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...rest) { return /webgl/i.test(type) ? null : original.call(this, type, ...rest); };
      });
      const plain = await bare.newPage();
      plain.on('pageerror', error => errors.push(error.message));
      plain.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await plain.goto(url + '/');
      await plain.evaluate(async () => { window.current = window.VeyraSkin.view(document.getElementById('stage'), { skin: '/fixtures/legacy.png', rotate: false, animation: 'none', yaw: 0, pitch: 0 }); await window.current.ready; });
      const rects = await isolate(plain, null), pixel = await shot(plain);
      assert.equal(Object.keys(rects).filter(key => key.includes(':over:')).length, 0, 'Without WebGL the opaque legacy hat is still hidden');
      for (const [part, source] of [['head', 'head'], ['rightArm', 'rightArm'], ['leftArm', 'rightArm'], ['leftLeg', 'rightLeg']]) {
        const box = rects[part + ':base:front'];
        assert.ok(same(at(pixel, box.x + box.w * .75, box.y + box.h * .75), colorOf(source, 'front')), 'Without WebGL: ' + part + ' front');
      }
      // Левая нога — зеркальная копия правой: тёмная четверть лица ноги на другой стороне.
      const legRects = await isolate(plain, 'leftLeg'), leg = inspect(await shot(plain), legRects, 'leftLeg', 'base', 'front');
      assert.ok(same(leg.color, colorOf('rightLeg', 'front')) && leg.ratio < .7, 'Without WebGL the legacy left leg copies the right one');
      assert.deepEqual(leg.marker, flipped(leg.expected), 'Without WebGL the legacy left leg is mirrored');
      const clear = await plain.evaluate(async () => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8;
        await window.VeyraSkin.drawHead(canvas, '/fixtures/clear.png');
        return [...canvas.getContext('2d').getImageData(0, 0, 8, 8).data];
      });
      assert.deepEqual(texel(clear, 1, 1), [0, 0, 0, 255], 'Without WebGL a transparent base pixel is black but opaque');
      assert.deepEqual(texel(clear, 4, 4), [...PALETTE[3], 255]);
      await bare.close();
    }

    // ── Лаунчер: страница file:// с его CSP и скины по veyra://skin/… (схема с corsEnabled и ответом Access-Control-Allow-Origin) ──
    await electronCheck();

    // ── Снимки скинов по умолчанию в три четверти для глаз ──
    const review = await browser.newContext({ viewport: { width: 900, height: 520 }, deviceScaleFactor: 2 });
    const pretty = await review.newPage();
    pretty.on('pageerror', error => errors.push(error.message));
    await pretty.goto(url + '/');
    for (const slim of [false, true]) {
      await pretty.evaluate(async slim => { window.current?.destroy(); window.current = window.VeyraSkin.view(document.getElementById('shot'), { slim, rotate: false, animation: 'none' }); await window.current.ready; }, slim);
      await pretty.locator('#shot').screenshot({ path: path.join(output, slim ? 'skin3d-slim.png' : 'skin3d-classic.png') });
    }
    await review.close();

    assert.deepEqual(errors, []);
    process.stdout.write('OK: 3D skin viewer — ' + checked + ' faces by pixels (classic, slim, second layer, legacy mirror), player orientation, slim 3 px arms, Notch hat hack, stored colours of transparent base pixels, drawHead, setSkin and fallback, walk/idle, drag with clamped pitch and time-based fling, reduced motion, destroy, cross-origin skins, no-WebGL fallback, strict CSP, hidden and auto-height containers, veyra:// skins in Electron.\n');
  } finally { await browser.close(); server.close(); foreign.close(); }
}
main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; server.close(); foreign.close(); });
