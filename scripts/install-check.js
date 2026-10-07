const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');

async function main() {
  const loader = process.argv[2] || 'vanilla';
  const mc = process.argv[3] || '1.21.8';
  const dataDirectory = path.join(os.tmpdir(), 'veyra-install-check');
  fs.mkdirSync(dataDirectory, { recursive: true });
  const app = await electron.launch({
    args: ['.'],
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, VEYRA_TEST_DATA_DIR: dataDirectory },
    timeout: 120000,
  });
  try {
    const page = await app.firstWindow();
    page.on('console', (message) => { if (message.type() === 'error') process.stderr.write(message.text() + '\n'); });
    const values = await page.evaluate(async ({ loader, mc }) => {
      const api = window.launcher;
      await api.refreshVersions();
      const list = loader === 'vanilla' ? [] : await api.getLoaderVersions(loader, mc);
      const instance = await api.createInstance({
        name: 'Integration ' + loader + ' ' + mc,
        minecraftVersion: mc,
        loader,
        loaderVersion: list[0]?.id || '',
      });
      return { id: instance.id, directory: instance.directory, loaderVersion: list[0]?.id || '' };
    }, { loader, mc });
    process.stdout.write(JSON.stringify(values) + '\n');
    if (loader !== 'vanilla') {
      const source = fs.readdirSync(path.join(dataDirectory, 'instances'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== values.id)
        .map((entry) => path.join(dataDirectory, 'instances', entry.name))
        .find((directory) => {
          try {
            const marker = JSON.parse(fs.readFileSync(path.join(directory, '.veyra-instance-ready.json'), 'utf8'));
            return marker.minecraftVersion === mc && marker.loader === 'vanilla';
          } catch { return false; }
        });
      if (source) {
        fs.cpSync(source, values.directory, { recursive: true, force: true });
        process.stdout.write('Copied base files from ' + source + '\n');
      }
    }
    await page.evaluate(() => {
      window.launcher.onEvent((event) => {
        if (event.type === 'progress') window.__veyraProgress = event;
        if (event.type === 'error') window.__veyraError = event.message;
      });
    });
    const timer = setInterval(async () => {
      try {
        const value = await page.evaluate(() => window.__veyraProgress);
        if (value) process.stdout.write(value.phase + ' ' + (value.percent ?? '?') + '% ' + value.message + '\n');
      } catch {}
    }, 15000);
    try {
      const result = await page.evaluate((id) => window.launcher.installInstance(id), values.id);
      const item = result.instances.find((current) => current.id === values.id);
      if (!item?.installed) throw new Error('Установка не отмечена готовой');
      process.stdout.write('INSTALLED ' + item.versionId + ' ' + item.directory + '\n');
    } finally { clearInterval(timer); }
  } finally { await app.close(); }
}
main().catch((error) => { process.stderr.write((error.stack || error) + '\n'); process.exitCode = 1; });
