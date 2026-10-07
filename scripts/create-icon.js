const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

async function main() {
  const assets = path.join(__dirname, '..', 'assets');
  const source = path.join(assets, 'veyra-mark.svg');
  const svg = await fs.readFile(source);
  const render = (size) => sharp(svg, { density: 300 }).resize(size, size).png().toBuffer();
  const [small, large] = await Promise.all([render(64), render(256)]);
  await Promise.all([
    fs.writeFile(path.join(assets, 'veyra-logo-64.png'), small),
    fs.writeFile(path.join(assets, 'veyra-logo-256.png'), large),
    fs.writeFile(path.join(assets, 'icon.png'), large),
  ]);
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(large.length, 14);
  header.writeUInt32LE(22, 18);
  await fs.writeFile(path.join(assets, 'icon.ico'), Buffer.concat([header, large]));
  process.stdout.write('Veyra mark updated.\n');
}
main().catch((error) => { process.stderr.write((error.stack || error) + '\n'); process.exitCode = 1; });
