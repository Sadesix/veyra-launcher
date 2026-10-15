const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

// Скины по умолчанию: свой персонаж Veyra в фирменной палитре, не Стив и не Алекс.
// Сливовое худи с персиковой окантовкой, сиреневые брюки, сапоги с опушкой; у классического — капюшон на голове, у тонкого — длинные волосы.
const colors = {
  skin: ['#f6dccb', '#ecc8b2', '#dcb09a', '#c99582'], blush: '#e8a998', mouth: '#d39587',
  hair: ['#5e4859', '#46344a', '#35283a', '#271d2b'], white: '#f7efe8', iris: ['#7c84b3', '#545c8c'],
  plum: ['#977c9f', '#7a6183', '#644e6e', '#4f3d59', '#3b2e44'], peach: ['#f1c2b0', '#d9a08f', '#ba7d6d', '#8d5a4d'],
  cream: ['#fbf1e6', '#f0e1d3', '#d8c4b5'], peri: ['#bcc1dc', '#9fa5c7', '#848ab0', '#666c90'],
  boot: ['#8a645a', '#6e4c45', '#563a36', '#2c2228'],
};
const rgb = hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
function random(seed) {
  return () => { seed = seed + 0x6D2B79F5 | 0; let value = Math.imul(seed ^ seed >>> 15, 1 | seed); value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value; return ((value ^ value >>> 14) >>> 0) / 4294967296; };
}

// Холст скина 64×64 с развёрткой коробок как в игре.
class Skin {
  constructor(seed) { this.data = Buffer.alloc(64 * 64 * 4); this.next = random(seed); }
  // Пиксель с лёгким шумом яркости, чтобы ткань не была плоской.
  dot(x, y, color, noise = 3) {
    if (!color) return;
    const shift = noise ? Math.round((this.next() - .5) * 2 * noise) : 0;
    this.data.set([...rgb(color).map(channel => Math.max(0, Math.min(255, channel + shift))), 255], (y * 64 + x) * 4);
  }
  // Грани коробки: [x, y, ширина, высота] в текстуре.
  static faces([u, v], w, h, d) {
    return { top: [u + d, v, w, d], bottom: [u + d + w, v, w, d], right: [u, v + d, d, h], front: [u + d, v + d, w, h], left: [u + d + w, v + d, d, h], back: [u + 2 * d + w, v + d, w, h] };
  }
  face([x, y, w, h], paint, noise) { for (let row = 0; row < h; row++) for (let column = 0; column < w; column++) this.dot(x + column, y + row, paint(column, row), noise); }
  // Боковые грани идут в текстуре сплошной лентой: правый бок, перед, левый бок, спина.
  strip([u, v], w, h, d, paint, noise) {
    for (let row = 0; row < h; row++) for (let s = 0; s < 2 * (w + d); s++) {
      const side = s < d ? 'right' : s < d + w ? 'front' : s < 2 * d + w ? 'left' : 'back';
      this.dot(u + s, v + d + row, paint(side, s - { right: 0, front: d, left: d + w, back: 2 * d + w }[side], row), noise);
    }
  }
  // Рисунок из строк: символ — ключ палитры, точка — пропуск.
  picture([x, y], rows, palette, noise) { rows.forEach((line, row) => [...line].forEach((key, column) => { if (key !== '.') this.dot(x + column, y + row, palette[key], noise); })); }
  png() { return sharp(this.data, { raw: { width: 64, height: 64, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer(); }
}

const HAIR = { H: colors.hair[1], h: colors.hair[0], d: colors.hair[2], D: colors.hair[3] };
const FACE = { ...HAIR, S: colors.skin[1], L: colors.skin[0], s: colors.skin[2], k: colors.skin[3], W: colors.white, I: colors.iris[1], i: colors.iris[0], B: colors.blush, M: colors.mouth };
const HOOD = { P: colors.plum[2], p: colors.plum[1], q: colors.plum[0], o: colors.plum[3], O: colors.plum[4], T: colors.peach[1], t: colors.peach[0], r: colors.peach[2] };
// Пряди: вертикальные тёмные линии и блик в верхнем ряду.
const strands = (column, row) => row === 1 && column % 3 !== 2 ? HAIR.h : column % 4 === 2 ? HAIR.d : row > 5 ? HAIR.d : HAIR.H;

// ── Голова: лицо и волосы основного слоя ──
function head(skin, long) {
  const box = Skin.faces([0, 0], 8, 8, 8);
  skin.picture(box.front, long ? [
    'HhHHHhHH',
    'HHhHdHhH',
    'HdSSHSSH',
    'HSLSSSSH',
    'dWISSIWd',
    'dBSSSSBd',
    'DSSSMSsD',
    'DsSSSSsD',
  ] : [
    'HHhHHHHH',
    'HhHHdHhH',
    'dHSHHSSd',
    'SLSSSSSs',
    'SWISSIWs',
    'SBSSSSBs',
    'SSSMMSSs',
    'sSSSSSss',
  ], FACE, 2);
  // Затылок, бока и макушка — волосы; у короткой стрижки на боках видны уши и щёки.
  skin.face(box.top, strands, 3);
  skin.face(box.back, strands, 3);
  const cheek = (column, row) => row > 5 ? colors.skin[2] : column === 3 && row === 4 ? colors.skin[3] : colors.skin[1];
  skin.face(box.right, (column, row) => !long && row > 2 && column > 3 ? cheek(7 - column, row) : strands(column, row), 3);
  skin.face(box.left, (column, row) => !long && row > 2 && column < 4 ? cheek(column, row) : strands(column, row), 3);
  skin.face(box.bottom, (column, row) => row < 2 ? HAIR.d : row > 5 ? colors.skin[2] : colors.skin[3], 2);
}

// ── Капюшон на слое шапки: сливовая ткань, персиковый кант вокруг лица, шов по макушке ──
function hood(skin) {
  const box = Skin.faces([32, 0], 8, 8, 8);
  skin.picture(box.front, ['tTTTTTTt', 'T......T', 'T......T', 'r......r', 'r......r', 'r......r', 'r......r', 'r......r'], HOOD, 2);
  skin.face(box.top, (column, row) => row === 7 ? HOOD.T : column === 3 ? HOOD.o : column === 4 ? HOOD.q : row < 3 || column < 2 || column > 5 ? HOOD.P : HOOD.p, 3);
  // Бока: у лица кант, ткань темнеет к затылку и книзу, складка у шеи.
  const side = flip => (column, row) => {
    const edge = flip ? 7 - column : column;
    if (edge === 0) return row < 3 ? HOOD.T : HOOD.r;
    if (row === 7) return edge > 5 ? HOOD.O : HOOD.o;
    if (row === 5 && edge > 1 && edge < 6) return HOOD.o;
    return edge > 5 || row > 5 ? HOOD.P : row < 2 && edge < 4 ? HOOD.q : HOOD.p;
  };
  skin.face(box.right, side(true), 3);
  skin.face(box.left, side(false), 3);
  skin.picture(box.back, ['PPPopPPP', 'PpPopPpP', 'PpPopPpP', 'PPPoPPPP', 'PPPoPPPP', 'PPPPPPPP', 'PoPPPPoP', 'OoooooOO'], HOOD, 3);
  // Снизу капюшон открыт: видна только кромка по бокам и сзади.
  skin.face(box.bottom, (column, row) => row === 0 || column === 0 || column === 7 ? (row === 7 ? null : HOOD.o) : null, 2);
}

// ── Длинные волосы на слое шапки: объёмная чёлка, пряди по бокам и сзади, персиковая заколка ──
function hair(skin) {
  const box = Skin.faces([32, 0], 8, 8, 8);
  skin.picture(box.front, ['hHHhHHHH', 'HhH.dHtT', 'H.....rH', 'H......H', 'd......d', 'd......d', 'D......D', '........'], { ...HAIR, t: colors.peach[0], T: colors.peach[1], r: colors.peach[2] }, 2);
  skin.face(box.top, (column, row) => column === 5 && row > 1 ? HAIR.D : strands(column, row), 3);
  skin.face(box.back, strands, 3);
  skin.face(box.right, (column, row) => row === 7 && column > 3 ? null : strands(column, row), 3);
  skin.face(box.left, (column, row) => row === 7 && column < 4 ? null : column === 0 && row === 1 ? colors.peach[1] : strands(column, row), 3);
  skin.face(box.bottom, (column, row) => row === 0 ? HAIR.D : null, 2);
}

// ── Худи: основной слой туловища ──
const CHEST = [
  'ooTkkToo',
  'pppTTppp',
  'ppPPPPpp',
  'pPPPPPPp',
  'PPPPPPPP',
  'PPPPPPPP',
  'PPPPPPPP',
  'PooooooP',
  'POppppOP',
  'POppppOP',
  'PPPPPPPP',
];
function body(skin, long) {
  const palette = { ...HOOD, k: colors.skin[3] };
  skin.strip([16, 16], 8, 12, 4, (side, x, row) => {
    if (row === 11) return (x + (side === 'back' ? 1 : 0)) % 3 === 0 ? colors.peach[2] : colors.peach[1];
    if (side === 'front') return palette[CHEST[row][x]];
    if (side === 'back') {
      // Большая персиковая «V» на спине; у тонкого её верх закрывают волосы.
      const mark = ['.T....T.', '.T....T.', '..T..T..', '..T..T..', '...TT...'][row - (long ? 5 : 3)];
      if (mark?.[x] === 'T') return colors.peach[1];
      return row === 0 || x === 0 || x === 7 ? colors.plum[3] : colors.plum[2];
    }
    return (side === 'right' ? x === 0 : x === 3) ? colors.plum[3] : colors.plum[2];
  }, 3);
  const box = Skin.faces([16, 16], 8, 12, 4);
  skin.face(box.top, column => column === 3 || column === 4 ? colors.skin[3] : colors.plum[1], 2);
  skin.face(box.bottom, () => colors.plum[3], 2);
}

// ── Второй слой куртки: объёмный подол и шнурки капюшона; у тонкого — волосы по спине ──
function jacket(skin, long) {
  skin.strip([16, 32], 8, 12, 4, (side, x, row) => {
    if (row === 11) return (x + (side === 'back' ? 1 : 0)) % 3 === 0 ? colors.peach[2] : x % 2 ? colors.peach[1] : colors.peach[0];
    if (side === 'front' && (x === 2 || x === 5) && row >= 1 && row <= 4) return row === 4 ? colors.peach[2] : row === 1 ? colors.cream[0] : colors.cream[1];
    if (long && side === 'back') {
      const length = [3, 4, 5, 5, 5, 5, 4, 3][x];
      if (row < length) return row === length - 1 ? HAIR.d : strands(x, row);
    }
    if (long && (side === 'right' ? x === 3 : side === 'left' && x === 0) && row < 2) return HAIR.d;
    // Капюшон классического скина спускается на плечи сзади.
    if (!long && side === 'back' && row === 0) return x === 0 || x === 7 ? colors.plum[3] : colors.plum[2];
    return null;
  }, 2);
  if (!long) skin.face(Skin.faces([16, 32], 8, 12, 4).top, (column, row) => row === 0 ? colors.plum[3] : null, 2);
}

// ── Руки: рукава худи, персиковая манжета на втором слое, кисти ──
function arm(skin, uv, over, width, inner) {
  skin.strip(uv, width, 12, 4, (side, x, row) => {
    if (row >= 10) return row === 11 ? colors.skin[2] : colors.skin[1];
    if (side === inner) return row === 5 ? colors.plum[4] : colors.plum[3];
    if (row === 0) return colors.plum[1];
    if (row === 5 && x % 2 === 0) return colors.plum[3];
    if (row === 9) return colors.plum[3];
    return side === 'back' ? colors.plum[3] : row < 4 && side === 'front' ? colors.plum[1] : colors.plum[2];
  }, 3);
  const box = Skin.faces(uv, width, 12, 4);
  skin.face(box.top, () => colors.plum[1], 2);
  skin.face(box.bottom, () => colors.skin[2], 2);
  skin.strip(over, width, 12, 4, (side, x, row) => row === 9 ? (x % 3 === 1 ? colors.peach[2] : colors.peach[1]) : null, 2);
}

// ── Ноги: сиреневые брюки, сапоги; кремовая опушка сапог — второй слой ──
function leg(skin, uv, over, inner) {
  skin.strip(uv, 4, 12, 4, (side, x, row) => {
    if (row === 11) return colors.boot[3];
    if (row >= 9) return side === 'front' && row === 9 && (x === 1 || x === 2) ? colors.boot[0] : side === inner || side === 'back' ? colors.boot[2] : colors.boot[1];
    if (side === inner) return colors.peri[3];
    if (side === 'front') return x === (inner === 'left' ? 2 : 1) && row < 8 ? colors.peri[0] : row === 5 ? colors.peri[2] : colors.peri[1];
    if (side === 'back') return row === 4 ? colors.peri[3] : colors.peri[2];
    return colors.peri[1];
  }, 3);
  const box = Skin.faces(uv, 4, 12, 4);
  skin.face(box.top, () => colors.peri[1], 2);
  skin.face(box.bottom, (column, row) => row === 0 || row === 3 ? colors.boot[3] : colors.boot[2], 2);
  skin.strip(over, 4, 12, 4, (side, x, row) => row === 8 ? ((x + (side === 'back' ? 1 : 0)) % 2 ? colors.cream[1] : colors.cream[0]) : null, 2);
}

function paint(slim) {
  const skin = new Skin(slim ? 23 : 11), width = slim ? 3 : 4;
  head(skin, slim);
  if (slim) hair(skin); else hood(skin);
  body(skin, slim);
  jacket(skin, slim);
  arm(skin, [40, 16], [40, 32], width, 'left');
  arm(skin, [32, 48], [48, 48], width, 'right');
  leg(skin, [0, 16], [0, 32], 'left');
  leg(skin, [16, 48], [0, 48], 'right');
  return skin.png();
}

async function main() {
  const folder = path.join(__dirname, '..', 'assets', 'skins');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'veyra-classic.png'), await paint(false));
  await fs.writeFile(path.join(folder, 'veyra-slim.png'), await paint(true));
  process.stdout.write('OK: assets/skins/veyra-classic.png и veyra-slim.png\n');
}
main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
