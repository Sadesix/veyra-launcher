const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { changelog } = require('./publish');
// Выпуск на GitHub: тег v<версия> на текущем коммите, установщик и его копия с постоянным именем —
// https://github.com/<владелец>/<репозиторий>/releases/latest/download/Veyra-Launcher-Setup.exe всегда ведёт на последнюю версию.
//   npm run release:github   — выпустить уже собранный dist/Veyra-Launcher-Setup-<версия>.exe
// Флаги: --draft (черновик), --file <путь>. Нужен GitHub CLI с выполненным «gh auth login».
const root = path.join(__dirname, '..');
const STABLE = 'Veyra-Launcher-Setup.exe';
const option = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : ''; };

function gh() {
  const candidates = [process.env.GH_PATH, 'gh', path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', 'gh.exe')].filter(Boolean);
  for (const candidate of candidates) if (spawnSync(candidate, ['--version'], { windowsHide: true }).status === 0) return candidate;
  throw new Error('Не найден GitHub CLI. Установите его (winget install GitHub.cli) и выполните «gh auth login».');
}
function run(command, args, { input } = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', windowsHide: true, input });
  if (result.status !== 0) throw new Error(path.basename(command) + ' ' + args.slice(0, 2).join(' ') + ': ' + (result.stderr || result.stdout || 'код ' + result.status).trim());
  return result.stdout.trim();
}
function sha256(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

async function main() {
  const cli = gh();
  const { version } = require('../package.json');
  const tag = 'v' + version;
  const file = path.resolve(option('--file') || path.join(root, 'dist', 'Veyra-Launcher-Setup-' + version + '.exe'));
  if (!fs.existsSync(file)) throw new Error('Нет установщика ' + path.relative(root, file) + '. Сначала «npm run dist».');
  // Выпуск должен совпадать с опубликованным кодом: незакоммиченные изменения в него не попадут.
  const dirty = run('git', ['status', '--porcelain', '--untracked-files=no']);
  if (dirty) throw new Error('Есть незакоммиченные изменения — закоммитьте их, чтобы выпуск совпадал с кодом на GitHub:\n' + dirty);
  const commit = run('git', ['rev-parse', 'HEAD']);
  process.stdout.write('Отправляем коммиты на GitHub…\n');
  run('git', ['push', 'origin', 'HEAD']);
  const repo = run(cli, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
  const hash = sha256(file), size = fs.statSync(file).size;
  const notes = changelog(version);
  const body = [
    notes.length ? '## Что нового\n\n' + notes.map(note => '- ' + note).join('\n') : '',
    '## Скачать\n\n**' + path.basename(file) + '** — установщик для Windows 10 и 11 (64 бита), ' + (size / 1024 ** 2).toFixed(1) + ' МБ. '
      + 'Тот же файл лежит под постоянным именем **' + STABLE + '**: ссылка https://github.com/' + repo + '/releases/latest/download/' + STABLE + ' всегда ведёт на последнюю версию.',
    'SHA-256: `' + hash + '`',
    'Сайт: https://veyra-launcher.com · Telegram: https://t.me/veyra_launcher',
  ].filter(Boolean).join('\n\n') + '\n';
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-github-'));
  try {
    const notesFile = path.join(work, 'notes.md'), stable = path.join(work, STABLE);
    fs.writeFileSync(notesFile, body);
    fs.copyFileSync(file, stable);
    const exists = spawnSync(cli, ['release', 'view', tag, '--repo', repo], { cwd: root, windowsHide: true }).status === 0;
    if (exists) {
      // Повторный запуск дозагружает файлы и обновляет описание, не создавая второй выпуск.
      process.stdout.write('Выпуск ' + tag + ' уже есть — обновляем файлы и описание…\n');
      run(cli, ['release', 'upload', tag, file, stable, '--clobber', '--repo', repo]);
      run(cli, ['release', 'edit', tag, '--notes-file', notesFile, '--title', 'Veyra ' + version, '--repo', repo]);
    } else {
      process.stdout.write('Создаём выпуск ' + tag + ' и загружаем установщик (' + (size / 1024 ** 2).toFixed(1) + ' МБ)…\n');
      run(cli, ['release', 'create', tag, file, stable, '--repo', repo, '--target', commit, '--title', 'Veyra ' + version, '--notes-file', notesFile,
        ...(process.argv.includes('--draft') ? ['--draft'] : ['--latest'])]);
    }
    // Проверка глазами GitHub: оба файла на месте и одного размера с установщиком.
    const assets = JSON.parse(run(cli, ['release', 'view', tag, '--repo', repo, '--json', 'assets,url']));
    for (const name of [path.basename(file), STABLE]) {
      const asset = assets.assets.find(item => item.name === name);
      if (!asset || asset.size !== size) throw new Error('На GitHub нет файла ' + name + ' нужного размера');
    }
    process.stdout.write('Готово: ' + assets.url + '\nПоследняя версия: https://github.com/' + repo + '/releases/latest/download/' + STABLE + '\n');
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}
if (require.main === module) main().catch((error) => { process.stderr.write('\nОшибка: ' + error.message + '\n'); process.exitCode = 1; });
