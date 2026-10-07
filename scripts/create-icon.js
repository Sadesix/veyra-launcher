const fs = require('node:fs');
const path = require('node:path');

const assets = path.join(__dirname, '..', 'assets');
const source = path.join(assets, 'veyra-logo-256.png');
const png = fs.readFileSync(source);

// Windows ICO can embed a PNG payload directly. This keeps the original
// transparent Veyra dragon sharp without adding another image dependency.
const header = Buffer.alloc(22);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // icon
header.writeUInt16LE(1, 4); // one image
header[6] = 0;              // 256 px
header[7] = 0;              // 256 px
header[8] = 0;
header[9] = 0;
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14);
header.writeUInt32LE(22, 18);

fs.copyFileSync(source, path.join(assets, 'icon.png'));
fs.writeFileSync(path.join(assets, 'icon.ico'), Buffer.concat([header, png]));
console.log('Veyra icons refreshed.');
