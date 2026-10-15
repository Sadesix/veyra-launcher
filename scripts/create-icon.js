const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

// Исходник логотипа — assets/brand/veyra-logo-source.png: эмблема сверху, надпись снизу.
// Палитра «Искусственная ностальгия» нужна для текстур блоков.
const colors = { P: '#3c343e', R: '#d29a8a' };
const rgb = hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
function random(seed) {
  return () => { seed = seed + 0x6D2B79F5 | 0; let value = Math.imul(seed ^ seed >>> 15, 1 | seed); value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value; return ((value ^ value >>> 14) >>> 0) / 4294967296; };
}
function png(size, scale, pixel) {
  const side = size * scale, data = Buffer.alloc(side * side * 4);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) data.set([...pixel(Math.floor(x / scale), Math.floor(y / scale)), 255], (y * side + x) * 4);
  return sharp(data, { raw: { width: side, height: side, channels: 4 } }).png().toBuffer();
}
// Мягкий шум блока: соседние пиксели слегка отличаются по яркости.
function block(base, spread, seed) {
  const next = random(seed), [r, g, b] = rgb(base);
  const noise = Array.from({ length: 256 }, () => Math.round((next() - .5) * 2 * spread));
  return (x, y) => [r, g, b].map(channel => Math.max(0, Math.min(255, channel + noise[y * 16 + x])));
}
// Доски таблички: две широкие доски на плитку, волокна идут вдоль.
function planks(seed) {
  const next = random(seed), grain = Array.from({ length: 16 }, () => Math.round((next() - .5) * 12)), noise = Array.from({ length: 256 }, () => Math.round((next() - .5) * 5));
  const [r, g, b] = rgb(colors.R);
  return (x, y) => {
    const seam = y % 8 === 7 || x === (Math.floor(y / 8) * 9 + 3) % 16 ? -22 : 0;
    return [r, g, b].map(channel => Math.max(0, Math.min(255, channel + seam + grain[y] + noise[y * 16 + x])));
  };
}

// Границы непрозрачной части и пустая полоса между эмблемой и надписью.
async function regions(source) {
  const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const filled = Array.from({ length: info.height }, (_row, y) => { for (let x = 0; x < info.width; x++) if (data[(y * info.width + x) * 4 + 3] > 20) return true; return false; });
  const top = filled.indexOf(true), bottom = filled.lastIndexOf(true);
  let gap = -1;
  for (let y = Math.round((top + bottom) / 2); y < bottom; y++) if (!filled[y]) { gap = y; break; }
  if (top < 0 || gap < 0) throw new Error('В логотипе не найдена полоса между эмблемой и надписью');
  const span = (from, to) => {
    let left = info.width, right = 0;
    for (let y = from; y <= to; y++) for (let x = 0; x < info.width; x++) if (data[(y * info.width + x) * 4 + 3] > 20) { left = Math.min(left, x); right = Math.max(right, x); }
    return { left, top: from, width: right - left + 1, height: to - from + 1 };
  };
  return { whole: span(top, bottom), emblem: span(top, gap - 1) };
}
const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
// Вырезанная часть вписывается в прямоугольник с прозрачными полями.
function fit(source, region, width, height, margin = 0) {
  return sharp(source).extract(region).resize(width - margin * 2, height - margin * 2, { fit: 'contain', background: transparent })
    .extend({ top: margin, bottom: margin, left: margin, right: margin, background: transparent }).png().toBuffer();
}

async function main() {
  const assets = path.join(__dirname, '..', 'assets');
  const source = path.join(assets, 'brand', 'veyra-logo-source.png');
  const { whole, emblem } = await regions(source);
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const icons = await Promise.all(sizes.map(size => fit(source, emblem, size, size, Math.round(size / 32))));
  await fs.mkdir(path.join(assets, 'textures'), { recursive: true });
  await Promise.all([
    fit(source, whole, 720, Math.round(720 * whole.height / whole.width)).then(bytes => fs.writeFile(path.join(assets, 'veyra-logo.png'), bytes)),
    fit(source, emblem, 512, Math.round(512 * emblem.height / emblem.width)).then(bytes => fs.writeFile(path.join(assets, 'veyra-emblem.png'), bytes)),
    fit(source, emblem, 96, 96).then(bytes => fs.writeFile(path.join(assets, 'veyra-emblem-96.png'), bytes)),
    fs.writeFile(path.join(assets, 'icon.png'), icons.at(-1)),
    png(16, 4, block(colors.P, 5, 7)).then(bytes => fs.writeFile(path.join(assets, 'textures', 'stone.png'), bytes)),
    png(16, 4, block('#201b22', 4, 19)).then(bytes => fs.writeFile(path.join(assets, 'textures', 'deep.png'), bytes)),
    png(16, 4, planks(31)).then(bytes => fs.writeFile(path.join(assets, 'textures', 'planks.png'), bytes)),
  ]);
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, index) => {
    const entry = 6 + index * 16;
    header.writeUInt8(size === 256 ? 0 : size, entry);
    header.writeUInt8(size === 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(icons[index].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += icons[index].length;
  });
  await fs.writeFile(path.join(assets, 'icon.ico'), Buffer.concat([header, ...icons]));
  process.stdout.write('Veyra logo, icons and block textures updated.\n');
}
main().catch((error) => { process.stderr.write((error.stack || error) + '\n'); process.exitCode = 1; });
