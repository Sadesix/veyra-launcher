const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const sharp = require('sharp');
const { getPath7za } = require('app-builder-lib/out/toolsets/7zip');

// Собирает dist/Veyra-Launcher-Setup-<версия>.exe — установщик на WPF (.NET Framework 4.8, он есть в Windows 10 и 11).
// Компилятор C# берётся из Windows, 7-Zip — из кеша electron-builder, поэтому ставить ничего не нужно.
// Устройство файла: [программа установки][7z-архив dist/win-unpacked][сведения JSON][32 байта: VEYRAPK1, смещение, длина, длина сведений].
// Флаги для проверок: --version 9.9.9, --app-dir папка (другая сборка приложения), --out путь, --fast (быстрое сжатие).
const root = path.join(__dirname, '..');
const pkg = require('../package.json');
const work = path.join(root, 'dist', '.installer');
const framework = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const option = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : ''; };

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    let output = '';
    child.stdout?.on('data', chunk => { output += chunk; });
    child.stderr?.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(path.basename(command) + ' завершился с кодом ' + code + '\n' + output.slice(-6000))));
  });
}
async function hashFiles(files) {
  const hash = createHash('sha256');
  for (const file of files) for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) total += entry.isDirectory() ? dirSize(path.join(dir, entry.name)) : fs.statSync(path.join(dir, entry.name)).size;
  return total;
}

// Пиксельные иконки из renderer/icons.js превращаются в геометрию WPF: та же сетка 12 × 12.
function icons(names) {
  const source = fs.readFileSync(path.join(root, 'renderer', 'icons.js'), 'utf8');
  const result = {};
  for (const name of names) {
    const match = source.match(new RegExp('^\\s{4}' + name + ': `([\\s\\S]*?)`', 'm'));
    if (!match) throw new Error('В renderer/icons.js нет иконки ' + name);
    const rows = match[1].trim().split('\n');
    let data = '';
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        if (row[x] !== '#' && row[x] !== 'o') continue;
        let end = x;
        while (end + 1 < row.length && (row[end + 1] === '#' || row[end + 1] === 'o')) end++;
        data += 'M' + x + ',' + y + 'h' + (end - x + 1) + 'v1h-' + (end - x + 1) + 'z';
        x = end;
      }
    });
    // Невидимые углы задают рамку 12 × 12, чтобы Stretch не растягивал узкие иконки.
    result[name] = 'M0,0h0.01v0.01h-0.01z M11.99,11.99h0.01v0.01h-0.01z ' + data;
  }
  return result;
}
function button(name, face, hi, lo, text) {
  return `<Style x:Key="${name}" TargetType="Button">
      <Setter Property="Foreground" Value="${text}" />
      <Setter Property="FontFamily" Value="{DynamicResource MonoFont}" />
      <Setter Property="FontSize" Value="14" />
      <Setter Property="TextOptions.TextRenderingMode" Value="Aliased" />
      <Setter Property="Cursor" Value="Hand" />
      <Setter Property="FocusVisualStyle" Value="{x:Null}" />
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="Line" BorderBrush="#17131a" BorderThickness="3">
              <Grid x:Name="Face" Background="${face}" MinHeight="39">
                <Rectangle x:Name="Hi" Height="3" VerticalAlignment="Top" Fill="${hi}" />
                <Rectangle x:Name="Lo" Height="6" VerticalAlignment="Bottom" Fill="${lo}" />
                <ContentPresenter x:Name="Content" Margin="18,3,18,7" HorizontalAlignment="Center" VerticalAlignment="Center" />
              </Grid>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="Line" Property="BorderBrush" Value="#f0e1d3" /></Trigger>
              <Trigger Property="IsKeyboardFocused" Value="True"><Setter TargetName="Line" Property="BorderBrush" Value="#f0e1d3" /></Trigger>
              <Trigger Property="IsPressed" Value="True"><Setter TargetName="Content" Property="Margin" Value="18,6,18,4" /><Setter TargetName="Lo" Property="Visibility" Value="Collapsed" /><Setter TargetName="Hi" Property="Fill" Value="${lo}" /></Trigger>
              <Trigger Property="IsEnabled" Value="False"><Setter TargetName="Face" Property="Opacity" Value="0.45" /><Setter Property="Cursor" Value="Arrow" /></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>`;
}
function xaml() {
  let text = fs.readFileSync(path.join(root, 'installer', 'Setup.xaml'), 'utf8');
  const drawn = icons(['close', 'folder', 'download', 'check', 'play', 'refresh', 'trash']);
  text = text.replace(/\{\{BUTTON:([A-Za-z]+)\|(#[0-9a-f]{6})\|(#[0-9a-f]{6})\|(#[0-9a-f]{6})\|(#[0-9a-f]{6})\}\}/g, (_match, name, face, hi, lo, color) => button(name, face, hi, lo, color));
  text = text.replace(/\{\{ICON:([a-z]+)\}\}/g, (_match, name) => { if (!drawn[name]) throw new Error('Иконка ' + name + ' не собрана'); return drawn[name]; });
  text = text.replace('xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"', 'xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" xmlns:sys="clr-namespace:System;assembly=mscorlib"');
  text = text.replace('</Grid.Resources>', Object.entries(drawn).map(([name, data]) => `    <sys:String x:Key="icon.${name}">${data}</sys:String>\n`).join('') + '  </Grid.Resources>');
  if (/\{\{/.test(text)) throw new Error('В Setup.xaml остались незаменённые вставки');
  return text;
}

async function compile(out, sources, extra) {
  const csc = path.join(framework, 'csc.exe');
  if (!fs.existsSync(csc)) throw new Error('Нет компилятора C# ' + csc + ': нужен .NET Framework 4.8');
  await run(csc, ['-nologo', '-codepage:65001', '-optimize+', '-target:winexe', '-platform:anycpu', '-out:' + out, '-win32icon:' + path.join(root, 'assets', 'icon.ico'),
    '-win32manifest:' + path.join(root, 'installer', 'app.manifest'), ...extra, ...sources]);
}

async function main() {
  const version = option('--version') || pkg.version;
  const appDir = path.resolve(option('--app-dir') || path.join(root, 'dist', 'win-unpacked')), appExe = pkg.build.productName + '.exe';
  for (const file of [appExe, path.join('resources', 'app.asar')]) if (!fs.existsSync(path.join(appDir, file))) throw new Error('Нет dist/win-unpacked/' + file.replace(/\\/g, '/') + ': сначала выполните «electron-builder --win dir»');
  fs.mkdirSync(work, { recursive: true });
  const started = Date.now();

  // Номер сборки зависит от содержимого: тот же лаунчер, собранный заново, не распаковывается повторно.
  const contentHash = (await hashFiles([path.join(appDir, appExe), path.join(appDir, 'resources', 'app.asar')])).slice(0, 10);
  const build = version + '-' + contentHash;
  const fast = process.argv.includes('--fast');
  const archive = path.join(work, 'app-' + contentHash + (fast ? '-fast' : '') + '.7z');
  if (!fs.existsSync(archive)) {
    // Готовый архив сборки переиспользуется, а архивы прежних сборок удаляются (быстрые тестовые сборки ничего не трогают).
    if (!fast) for (const old of fs.readdirSync(work)) if (/^app-.*\.7z(\.tmp)?$/.test(old)) fs.rmSync(path.join(work, old), { force: true });
    process.stdout.write('Сжимаем лаунчер (7-Zip, LZMA2)…\n');
    await run(await getPath7za(), ['a', '-t7z', '-m0=LZMA2', fast ? '-mx=1' : '-mx=9', '-mmt=on', '-md=64m', '-bso0', '-bsp0', archive + '.tmp', '.'], { cwd: appDir });
    fs.renameSync(archive + '.tmp', archive);
  }

  // Картины и шрифты лаунчера внутри установщика.
  const scene = path.join(work, 'scene.jpg');
  await sharp(path.join(root, 'assets', 'backgrounds', 'scene-7.webp')).resize(660, 1120, { fit: 'cover', position: 'left' }).jpeg({ quality: 86, mozjpeg: true }).toFile(scene);
  fs.writeFileSync(path.join(work, 'Setup.xaml'), xaml());
  const parts = version.split('.').map(Number);
  while (parts.length < 4) parts.push(0);
  const numeric = parts.slice(0, 4).join('.');
  const info = (title) => `[assembly: System.Reflection.AssemblyTitle(${JSON.stringify(title)})]
[assembly: System.Reflection.AssemblyProduct("Veyra Launcher")]
[assembly: System.Reflection.AssemblyCompany("Veyra")]
[assembly: System.Reflection.AssemblyCopyright(${JSON.stringify('© ' + new Date().getFullYear() + ' Veyra')})]
[assembly: System.Reflection.AssemblyVersion("${numeric}")]
[assembly: System.Reflection.AssemblyFileVersion("${numeric}")]
[assembly: System.Reflection.AssemblyInformationalVersion("${version}")]
`;
  fs.writeFileSync(path.join(work, 'SetupInfo.cs'), info('Установка Veyra Launcher'));
  fs.writeFileSync(path.join(work, 'StubInfo.cs'), info('Veyra Launcher').replace(/\[assembly: System\.Reflection\.Assembly(Title|Product)[^\n]*\n/g, ''));

  const stub = path.join(work, 'VeyraStub.exe');
  await compile(stub, [path.join(root, 'installer', 'Stub.cs'), path.join(work, 'StubInfo.cs')], ['-r:System.Windows.Forms.dll']);
  const resources = {
    'ui.xaml': path.join(work, 'Setup.xaml'), 'app.stub': stub, 'tool.7za': await getPath7za(),
    'font.mono': path.join(root, 'assets', 'fonts', 'Monocraft.otf'), 'font.body': path.join(root, 'assets', 'fonts', 'DotumChe-RUS.ttf'),
    'img.logo': path.join(root, 'assets', 'veyra-logo.png'), 'img.scene': scene, 'img.deep': path.join(root, 'assets', 'textures', 'deep.png'), 'img.icon': path.join(root, 'assets', 'icon.png'),
  };
  const program = path.join(work, 'Setup.exe');
  const wpf = ['PresentationFramework.dll', 'PresentationCore.dll', 'WindowsBase.dll'].map(name => '-r:' + path.join(framework, 'WPF', name));
  await compile(program, ['Setup.cs', 'Engine.cs', 'Native.cs'].map(name => path.join(root, 'installer', name)).concat(path.join(work, 'SetupInfo.cs')),
    [...wpf, '-r:System.Xaml.dll', '-r:System.Web.Extensions.dll', ...Object.entries(resources).map(([name, file]) => '-resource:' + file + ',' + name)]);

  // Программа, архив, сведения и хвост с их размерами — одним файлом.
  const head = fs.readFileSync(program);
  const meta = Buffer.from(JSON.stringify({ product: pkg.build.productName, version, build, publisher: 'Veyra', site: 'https://veyra-launcher.com/', size: dirSize(appDir) }), 'utf8');
  const archiveSize = fs.statSync(archive).size;
  const trailer = Buffer.alloc(32);
  trailer.write('VEYRAPK1', 0, 'ascii');
  trailer.writeBigInt64LE(BigInt(head.length), 8);
  trailer.writeBigInt64LE(BigInt(archiveSize), 16);
  trailer.writeInt32LE(meta.length, 24);
  const output = path.resolve(option('--out') || path.join(root, 'dist', 'Veyra-Launcher-Setup-' + version + '.exe'));
  const temporary = output + '.tmp';
  const stream = fs.createWriteStream(temporary);
  stream.write(head);
  await new Promise((resolve, reject) => { fs.createReadStream(archive).on('error', reject).on('end', resolve).pipe(stream, { end: false }); });
  stream.write(meta);
  stream.end(trailer);
  await new Promise((resolve, reject) => { stream.on('finish', resolve); stream.on('error', reject); });
  fs.rmSync(output, { force: true });
  fs.renameSync(temporary, output);
  const size = fs.statSync(output).size;
  process.stdout.write('Установщик: ' + path.relative(root, output) + ' · ' + (size / 1024 ** 2).toFixed(1) + ' МБ · сборка ' + build + ' · программа установки ' + Math.round(head.length / 1024) + ' КБ · ' + Math.round((Date.now() - started) / 1000) + ' с\n');
}
main().catch((error) => { process.stderr.write((error.stack || error) + '\n'); process.exitCode = 1; });
