"""SSH control plane and systemd entry point for Veyra's Linux worlds."""

import base64
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import socket
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.request
import uuid
import zipfile


PROTOCOL = 2
HOME = Path('/usr/local/lib/veyra-controller')
ROOT = Path('/var/lib/veyra-controller')
WORLDS = ROOT / 'worlds'
BUNDLES = ROOT / 'bundles'
CACHE = Path('/var/cache/veyra-controller')
UNIT = 'veyra-minecraft@'
UNIT_FILE = Path('/etc/systemd/system') / (UNIT + '.service')
MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
WORLD_ID = re.compile(r'[0-9a-f]{32}')
VERSION_ID = re.compile(r'[0-9A-Za-z][0-9A-Za-z._+-]{0,99}')
READY = re.compile(r'\bDone \([\d.,]+s\)!|For help, type "help"')
PACK_DIRS = {'mods', 'config', 'defaultconfigs', 'kubejs', 'scripts', 'global_packs',
             'openloader', 'paxi', 'datapacks', 'patchouli_books', 'world'}
MAX_PACK_BYTES = 64 * 1024 ** 3
MAX_PACK_FILES = 100000
SODIUM_ENTRIES = {'net/caffeinemc/mods/sodium/service/SodiumWorkarounds.class',
                  'net/caffeinemc/mods/sodium/client/SodiumClientMod.class',
                  'me/jellysquid/mods/sodium/client/SodiumClientMod.class'}
UNIT_TEXT = """[Unit]
Description=Veyra Minecraft world %i
Wants=network-online.target
After=network-online.target

[Service]
Type=notify
NotifyAccess=main
DynamicUser=yes
StateDirectory=veyra-world-%i
StateDirectoryMode=0700
RuntimeDirectory=veyra-world-%i
RuntimeDirectoryMode=0700
WorkingDirectory=/var/lib/veyra-world-%i
UMask=0022
ExecStartPre=+/usr/bin/python3 -I /usr/local/lib/veyra-controller/controller.py prepare %i
ExecStart=/usr/bin/python3 -I /usr/local/lib/veyra-controller/controller.py run %i
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
NoNewPrivileges=yes
KillMode=mixed
TimeoutStartSec=15min
TimeoutStopSec=150s

[Install]
WantedBy=multi-user.target
"""


class ControllerError(Exception):
    pass


def atomic_write(target, content, mode=0o644):
    with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as output:
        temporary = Path(output.name)
        try:
            os.fchmod(output.fileno(), mode)
            output.write(content)
            output.close()
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)


def json_file(target, value):
    atomic_write(target, json.dumps(value, ensure_ascii=False).encode())


def systemctl(*args):
    result = subprocess.run(['systemctl', '--no-pager', *args], capture_output=True,
                            text=True, encoding='utf-8', errors='replace', timeout=20)
    if result.returncode:
        raise ControllerError(result.stderr.strip() or 'systemd отклонил запрос')
    return result.stdout


def install(source, account):
    if sys.version_info < (3, 10) or sys.platform != 'linux' or not Path('/run/systemd/system').is_dir():
        raise ControllerError('Нужен Linux с systemd и Python 3.10 или новее')
    if platform.machine() not in ('x86_64', 'aarch64'):
        raise ControllerError('Поддерживаются Linux x86-64 и ARM64')
    if not hasattr(tarfile, 'data_filter'):
        raise ControllerError('Обновите системный Python: требуется поддержка безопасной распаковки tarfile.data_filter')
    os.umask(0o022)
    for directory in (HOME, ROOT, WORLDS, CACHE, BUNDLES):
        directory.mkdir(mode=0o755, exist_ok=True)
    with (ROOT / 'control.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        atomic_write(HOME / 'controller.py', source.encode())
        json_file(HOME / 'account.json', account)
        atomic_write(UNIT_FILE, UNIT_TEXT.encode())
        systemctl('daemon-reload')
    return {'protocol': PROTOCOL}


def unit(world_id):
    return UNIT + world_id + '.service'


def read_worlds():
    return sorted(
        (json.loads(file.read_text(encoding='utf-8'))
         for file in WORLDS.glob('*.json') if WORLD_ID.fullmatch(file.stem)),
        key=lambda world: (world['name'].casefold(), world['id']),
    )


def get_world(world_id):
    if isinstance(world_id, str) and WORLD_ID.fullmatch(world_id):
        try:
            return json.loads((WORLDS / (world_id + '.json')).read_text(encoding='utf-8'))
        except FileNotFoundError:
            pass
    raise ControllerError('Мир на ВМ не найден')


def states():
    mapping = {'active': 'ready', 'activating': 'starting', 'deactivating': 'stopping',
               'failed': 'error', 'reloading': 'ready', 'refreshing': 'ready'}
    output = systemctl('list-units', '--all', '--plain', '--no-legend', UNIT + '*.service')
    result = {}
    for line in output.splitlines():
        name, _, active, *_ = line.split(maxsplit=4)
        result[name[len(UNIT):-len('.service')]] = mapping.get(active, 'stopped')
    jobs = systemctl('list-jobs', '--no-legend', '--full', '--plain')
    for line in jobs.splitlines():
        columns = line.split(maxsplit=4)
        if len(columns) < 3:
            continue
        _, name, kind, *_ = columns
        if name.startswith(UNIT) and name.endswith('.service'):
            world_id = name[len(UNIT):-len('.service')]
            if kind in ('start', 'restart'):
                result[world_id] = 'starting'
            elif kind == 'stop':
                result[world_id] = 'stopping'
    return result


def vm_status():
    memory = {}
    for line in Path('/proc/meminfo').read_text().splitlines():
        key, value = line.split(':', 1)
        if key in ('MemTotal', 'MemAvailable'):
            memory[key] = int(value.split()[0]) * 1024
    disk = shutil.disk_usage('/var/lib')
    return {'hostname': socket.gethostname(), 'cpuCount': os.cpu_count() or 1,
            'load': round(os.getloadavg()[0], 2), 'ramTotal': memory['MemTotal'],
            'ramUsed': memory['MemTotal'] - memory['MemAvailable'],
            'diskTotal': disk.total, 'diskUsed': disk.used}


def integer(data, key, minimum, maximum, message):
    value = data.get(key)
    if type(value) is not int or not minimum <= value <= maximum:
        raise ControllerError(message)
    return value


def port_available(port):
    # Minecraft binds all interfaces. Check both protocol families where available.
    for family, address in ((socket.AF_INET, '0.0.0.0'), (socket.AF_INET6, '::')):
        try:
            with socket.socket(family, socket.SOCK_STREAM) as listener:
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                listener.bind((address, port))
        except OSError as error:
            if error.errno not in (errno.EAFNOSUPPORT, errno.EPROTONOSUPPORT, errno.EADDRNOTAVAIL):
                raise ControllerError(f'Игровой порт {port} занят или недоступен') from error


def settings(data, previous=None):
    name = data.get('name', '').strip()
    if not 1 <= len(name) <= 48 or any(ord(char) < 32 or ord(char) == 127 for char in name):
        raise ControllerError('Название мира должно содержать от 1 до 48 символов')
    version = previous['minecraftVersion'] if previous else data.get('minecraftVersion', '')
    if not VERSION_ID.fullmatch(version):
        raise ControllerError('Выберите версию Minecraft')
    port = integer(data, 'port', 1024, 65535, 'Игровой порт должен быть от 1024 до 65535')
    memory = integer(data, 'memoryGb', 1, vm_status()['ramTotal'] // (1024 ** 3) or 1,
                     'Выделенная Java память больше объёма ОЗУ ВМ')
    players = integer(data, 'maxPlayers', 1, 100, 'Укажите от 1 до 100 игроков')
    auth = data.get('veyraLogin')
    if type(auth) is not bool:
        raise ControllerError('Укажите режим входа')
    if not previous and data.get('eula') is not True:
        raise ControllerError('Примите Minecraft EULA')
    world_id = previous['id'] if previous else uuid.uuid4().hex
    if any(item['port'] == port and item['id'] != world_id for item in read_worlds()):
        raise ControllerError(f'Порт {port} уже назначен другому миру Veyra')
    if not previous or port != previous['port']:
        port_available(port)
    source = previous or data
    loader, loader_version = source.get('loader', 'vanilla'), source.get('loaderVersion', '')
    if loader not in ('vanilla', 'fabric', 'forge', 'neoforge') or loader != 'vanilla' and not VERSION_ID.fullmatch(loader_version):
        raise ControllerError('Некорректный загрузчик Minecraft')
    result = {'id': world_id, 'name': name, 'minecraftVersion': version, 'port': port,
              'memoryGb': memory, 'maxPlayers': players, 'veyraLogin': auth,
              'loader': loader, 'loaderVersion': loader_version, 'sourceId': source.get('sourceId', '')}
    if previous:
        for key in ('hasBundle', 'modCount'):
            if key in previous:
                result[key] = previous[key]
    return result


def stream_header(stream):
    line = stream.readline(16385)
    if len(line) > 16384 or not line.endswith(b'\n'):
        raise ControllerError('Отправка сборки прервалась или заголовок повреждён')
    return json.loads(line)


def pack_path(name):
    parts = name.split('/')
    if (not 2 <= len(parts) <= 48 or parts[0] not in PACK_DIRS or
        any(not part or part in ('.', '..') or len(part.encode()) > 255 or
            re.search(r'[:\\\x00-\x1f\x7f]', part) for part in parts)):
        raise ControllerError('Недопустимый путь файла сборки')
    if parts[0] == 'mods' and (len(parts) != 2 or not parts[1].lower().endswith('.jar')):
        raise ControllerError('Недопустимый файл мода')
    return Path(*parts)


def import_build(stream):
    header = stream_header(stream)
    world = settings(header['settings'])
    count = integer(header, 'count', 0, MAX_PACK_FILES, 'Слишком много файлов сборки')
    total = integer(header, 'total', 0, MAX_PACK_BYTES, 'Слишком большая сборка')
    if total * 2 > shutil.disk_usage(ROOT).free:
        raise ControllerError('На ВМ не хватает места для переноса сборки и её рабочего экземпляра')
    os.umask(0o022)
    storage = BUNDLES / world['id']
    with tempfile.TemporaryDirectory(dir=BUNDLES) as temporary:
        stage = Path(temporary) / 'files'
        stage.mkdir()
        received = 0
        mods = 0
        for _ in range(count):
            item = stream_header(stream)
            relative = pack_path(item['path'])
            length = integer(item, 'size', 0, total - received, 'Неверный размер файла сборки')
            target = stage / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('xb') as output:
                remaining = length
                while remaining:
                    block = stream.read(min(1024 ** 2, remaining))
                    if not block:
                        raise ControllerError('Отправка сборки прервалась')
                    output.write(block)
                    remaining -= len(block)
            received += length
            mods += relative.parts[0] == 'mods'
        if received != total or stream.read(1):
            raise ControllerError('Размер сборки не совпал')
        with (ROOT / 'control.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if any(item['port'] == world['port'] for item in read_worlds()):
                raise ControllerError('Игровой порт уже занят другим миром Veyra')
            port_available(world['port'])
            if count:
                stage.rename(storage)
            try:
                json_file(WORLDS / (world['id'] + '.json'), {**world, 'hasBundle': bool(count), 'modCount': mods})
            except OSError:
                if count:
                    storage.rename(stage)
                raise
    return {'id': world['id']}


def varint(value):
    packed = bytearray()
    while value >= 128:
        packed.append((value & 127) | 128)
        value >>= 7
    packed.append(value)
    return packed


def read_varint(stream):
    value = 0
    for shift in range(0, 35, 7):
        current = stream.read(1)
        if not current:
            raise ValueError('Ответ Minecraft оборвался')
        value |= (current[0] & 127) << shift
        if current[0] < 128:
            return value
    raise ValueError('Некорректный пакет Minecraft')


def players_online(port):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=0.5) as connection:
            host = b'localhost'
            handshake = b'\x00' + varint(47) + varint(len(host)) + host + struct.pack('!H', port) + b'\x01'
            connection.sendall(varint(len(handshake)) + handshake + b'\x01\x00')
            with connection.makefile('rb') as stream:
                length = read_varint(stream)
                if not 2 <= length <= 65536 or read_varint(stream) != 0:
                    return None
                length = read_varint(stream)
                if not 1 <= length <= 65536:
                    return None
                value = json.loads(stream.read(length))['players']['online']
                return value if type(value) is int and value >= 0 else None
    except (ValueError, KeyError, TypeError, OSError):
        return None


def snapshot(selected):
    status = states()
    worlds = [{**world, 'status': status.get(world['id'], 'stopped')} for world in read_worlds()]
    world = next((item for item in worlds if item['id'] == selected), worlds[0] if worlds else None)
    details = None
    if world:
        lines = subprocess.run(['journalctl', '--no-pager', '--quiet', '--output=cat',
                                '--lines=160', '--unit=' + unit(world['id'])],
                               capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=5)
        details = {'id': world['id'], 'logs': lines.stdout[-56000:],
                   'players': players_online(world['port']) if world['status'] == 'ready' else None}
    return {'protocol': PROTOCOL, 'vm': vm_status(), 'worlds': worlds, 'details': details}


def send_command(world_id, command):
    line = command.strip().removeprefix('/')
    if not 1 <= len(line) <= 256 or any(ord(char) < 32 or ord(char) == 127 for char in line):
        raise ControllerError('Команда должна содержать от 1 до 256 символов в одной строке')
    try:
        file = os.open('/run/veyra-world-' + world_id + '/console', os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            if not stat.S_ISFIFO(os.fstat(file).st_mode):
                raise ControllerError('Консоль мира недоступна')
            os.write(file, (line + '\n').encode())
        finally:
            os.close(file)
    except OSError as error:
        raise ControllerError('Консоль недоступна. Дождитесь запуска мира и повторите команду') from error


def control(request):
    action, selected = request.get('action'), request.get('worldId')
    if action == 'hello':
        account = json.loads((HOME / 'account.json').read_text(encoding='utf-8'))
        return {'protocol': PROTOCOL, 'revision': account.get('revision')}
    if action == 'snapshot':
        return snapshot(selected)
    with (ROOT / 'control.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if action != 'create':
            world = get_world(selected)
            states_now = states()
            status = states_now.get(selected, 'stopped')
        if action in ('create', 'save'):
            if action == 'save' and status not in ('stopped', 'error'):
                raise ControllerError('Остановите мир перед изменением настроек')
            world = settings(request['settings'], world if action == 'save' else None)
            json_file(WORLDS / (world['id'] + '.json'), world)
            return {'id': world['id']}
        if action in ('start', 'restart'):
            if status in ('starting', 'stopping'):
                raise ControllerError('Дождитесь завершения текущей операции')
            if status in ('stopped', 'error'):
                port_available(world['port'])
                reserved = sum(item['memoryGb'] for item in read_worlds()
                               if item['id'] != selected and states_now.get(item['id']) in ('ready', 'starting', 'stopping'))
                if (reserved + world['memoryGb']) * 1024 ** 3 > vm_status()['ramTotal']:
                    raise ControllerError('Уменьшите память Java или остановите другой мир: суммарный лимит выше ОЗУ ВМ')
            systemctl('--no-block', action, unit(selected))
        elif action == 'stop':
            systemctl('--no-block', 'stop', unit(selected))
        elif action == 'command':
            if status != 'ready':
                raise ControllerError('Дождитесь запуска мира')
            send_command(selected, request['command'])
        else:
            raise ControllerError('Неизвестное действие контроллера')
        return {'id': selected}


def response(callback):
    try:
        print(json.dumps({'ok': True, 'data': callback()}, ensure_ascii=True))
    except (OSError, ValueError, TypeError, KeyError, AttributeError, subprocess.SubprocessError, ControllerError) as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=True))


def request_url(url):
    if not isinstance(url, str) or not url.startswith('https://'):
        raise ControllerError('Источник загрузки должен использовать HTTPS')
    return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'VeyraController/1'}),
                                  timeout=25)


def get_json(url, limit=5 * 1024 * 1024):
    with request_url(url) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ControllerError('Источник вернул слишком большой JSON')
    return json.loads(data), data


def digest(path, algorithm):
    checksum = hashlib.new(algorithm)
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 ** 2), b''):
            checksum.update(block)
    return checksum.hexdigest()


def download(path, urls, expected, algorithm, limit):
    if path.is_file() and (expected is None or digest(path, algorithm) == expected):
        return
    failures = []
    for url in urls:
        temporary = path.with_name(path.name + '.part')
        try:
            with request_url(url) as response, temporary.open('wb') as output:
                total = 0
                for block in iter(lambda: response.read(1024 ** 2), b''):
                    total += len(block)
                    if total > limit:
                        raise ControllerError('Размер загрузки превысил ожидаемый')
                    output.write(block)
            if expected is not None and digest(temporary, algorithm) != expected:
                raise ControllerError('Контрольная сумма загрузки не совпала')
            temporary.replace(path)
            return
        except (OSError, ControllerError) as error:
            failures.append(str(error))
        finally:
            temporary.unlink(missing_ok=True)
    raise ControllerError(f'Не удалось загрузить {path.name}: ' + ' | '.join(failures))


def minecraft(version, cache):
    metadata_file = cache / (version + '.json')
    if not metadata_file.exists():
        manifest, _ = get_json(MANIFEST)
        selected = next((item for item in manifest['versions'] if item['id'] == version), None)
        if not selected:
            raise ControllerError('В каталоге Mojang отсутствует релиз ' + version)
        download(metadata_file, [selected['url']], selected['sha1'], 'sha1', 5 * 1024 ** 2)
    metadata = json.loads(metadata_file.read_text(encoding='utf-8'))
    server = metadata.get('downloads', {}).get('server')
    if not server:
        raise ControllerError('Mojang не публикует отдельный сервер для версии ' + version)
    jar = cache / ('minecraft-' + version + '.jar')
    download(jar, [server['url']], server['sha1'], 'sha1', server['size'])
    return jar, metadata.get('javaVersion', {}).get('majorVersion', 8)


def java_runtime(major, cache):
    arch = {'x86_64': 'x64', 'aarch64': 'aarch64'}[platform.machine()]
    runtime = cache / ('temurin-' + str(major))
    java = runtime / 'bin' / 'java'
    if java.is_file():
        return java
    base = f'https://api.adoptium.net/v3/assets/feature_releases/{major}/ga?architecture={arch}&os=linux&jvm_impl=hotspot&vendor=eclipse&page_size=1&image_type='
    for image in ('jre', 'jdk'):
        try:
            builds, _ = get_json(base + image)
        except urllib.error.HTTPError as error:
            if error.code != 404:
                raise
            builds = []
        if builds and builds[0]['binaries']:
            package = builds[0]['binaries'][0]['package']
            break
    else:
        raise ControllerError(f'Adoptium не предоставляет Java {major} для Linux {arch}')
    archive = cache / ('temurin-' + str(major) + '.tar.gz')
    download(archive, [package['link']], package['checksum'], 'sha256', package['size'])
    with tempfile.TemporaryDirectory(dir=cache) as staging:
        with tarfile.open(archive, 'r:gz') as bundle:
            bundle.extractall(staging, filter='data')
        candidates = list(Path(staging).glob('*/bin/java'))
        if len(candidates) != 1 or not candidates[0].is_file():
            raise ControllerError('В архиве Java отсутствует bin/java')
        candidates[0].parent.parent.replace(runtime)
    archive.unlink()
    return java


def java_agent(cache):
    account = json.loads((HOME / 'account.json').read_text(encoding='utf-8'))
    source = account['authlib']
    agent = cache / ('authlib-injector-' + source['version'] + '.jar')
    download(agent, source['urls'], source['sha256'], 'sha256', 4 * 1024 ** 2)
    metadata, raw = get_json(account['api'], 64 * 1024)
    if not isinstance(metadata.get('meta'), dict) or not isinstance(metadata.get('signaturePublickey'), str):
        raise ControllerError('API Veyra вернул неверное описание для входа и скинов')
    return [f"-javaagent:{agent}={account['api']}",
            '-Dauthlibinjector.yggdrasil.prefetched=' + base64.b64encode(raw).decode(),
            '-Dauthlibinjector.noShowServerName']


def configure_game(world):
    properties = Path('server.properties')
    values = {'server-port': world['port'], 'server-ip': '', 'max-players': world['maxPlayers'],
              'online-mode': str(world['veyraLogin']).lower(), 'enforce-secure-profile': 'false',
              'enable-rcon': 'false', 'enable-query': 'false'}
    if not properties.exists():
        values['white-list'] = 'false'
    previous = properties.read_bytes().splitlines() if properties.exists() else []
    pattern = re.compile(rb'^\s*([A-Za-z0-9_.-]+)\s*[:=]')
    kept = [line for line in previous if not (match := pattern.match(line)) or match[1].decode() not in values]
    kept.extend(f'{key}={value}'.encode() for key, value in values.items())
    atomic_write(properties, b'\n'.join(kept) + b'\n')
    atomic_write(Path('eula.txt'), b'eula=true\n')


def notify_ready():
    address = os.environ.get('NOTIFY_SOCKET')
    if address:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as channel:
            channel.sendto(b'READY=1', '\0' + address[1:] if address.startswith('@') else address)


def apply_build(world, cache):
    marker = cache / 'build-applied'
    if not world.get('hasBundle') or marker.is_file():
        return
    source = BUNDLES / world['id']
    if not source.is_dir():
        raise ControllerError('Файлы импортированной сборки не найдены')
    print('Veyra Controller: переносим файлы сборки в папку мира', flush=True)
    for file in source.rglob('*'):
        if not file.is_file():
            continue
        target = file.relative_to(source)
        if target.exists():
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as output:
            temporary = Path(output.name)
            try:
                with file.open('rb') as input_file:
                    shutil.copyfileobj(input_file, output)
                output.close()
                temporary.replace(target)
            finally:
                temporary.unlink(missing_ok=True)
    atomic_write(marker, b'1\n')


def client_only_mod(file, loader):
    try:
        with zipfile.ZipFile(file) as jar:
            names = set(jar.namelist())
            toml = ('META-INF/neoforge.mods.toml', 'META-INF/mods.toml')
            for manifest in ('fabric.mod.json',) if loader == 'fabric' else toml:
                if manifest not in names or jar.getinfo(manifest).file_size > 1024 ** 2:
                    continue
                text = jar.read(manifest).decode('utf-8')
                if loader == 'fabric':
                    return json.loads(text).get('environment') == 'client'
                header = re.split(r'^\s*\[', text, maxsplit=1, flags=re.M)[0]
                if loader == 'forge' and re.search(r'^\s*clientSideOnly\s*=\s*true\s*(?:#.*)?$', header, re.M):
                    return True
                if names & SODIUM_ENTRIES and re.search(r'''^[ \t]*modId\s*=\s*["']sodium["']\s*(?:#.*)?$''', text, re.M):
                    return True
    except (OSError, ValueError, AttributeError, RuntimeError, zipfile.BadZipFile):
        pass
    return False


def isolate_imported_client_mods(world, cache):
    # Existing imports may include client jars. Check the original bundle so
    # this does not touch mods that the owner added or replaced on the VM.
    if not world.get('hasBundle'):
        return
    loader = world.get('loader', 'vanilla')
    imported = BUNDLES / world['id'] / 'mods'
    for original in imported.glob('*'):
        active = Path('mods') / original.name
        if (active.suffix.lower() != '.jar' or active.is_symlink() or not active.is_file() or
            not client_only_mod(original, loader) or digest(original, 'sha256') != digest(active, 'sha256')):
            continue
        archive = cache / 'client-only-mods'
        archive.mkdir(exist_ok=True)
        destination = archive / active.name
        if destination.exists() or destination.is_symlink():
            destination = archive / (uuid.uuid4().hex + '-' + active.name)
        active.rename(destination)
        print('Veyra Controller: клиентский мод перемещён в ' + str(destination), flush=True)


def launcher_args(world, java, jar, cache):
    loader, version = world.get('loader', 'vanilla'), world['minecraftVersion']
    if loader == 'vanilla':
        return ['-jar', str(jar)]
    loader_version = world['loaderVersion']
    marker = cache / 'launcher-ready.json'
    if marker.is_file():
        return json.loads(marker.read_text(encoding='utf-8'))
    print(f'Veyra Controller: Minecraft {version}, {loader} {loader_version}', flush=True)
    if loader == 'fabric':
        builds, _ = get_json('https://meta.fabricmc.net/v2/versions/installer')
        installer = next((item['version'] for item in builds if item.get('stable')), '')
        if not VERSION_ID.fullmatch(installer):
            raise ControllerError('Некорректная версия установщика Fabric')
        url = f'https://meta.fabricmc.net/v2/versions/loader/{version}/{loader_version}/{installer}/server/jar'
        filename = cache / 'fabric-server.jar'
        download(filename, [url], None, 'sha1', 16 * 1024 ** 2)
        atomic_write(Path('fabric-server-launcher.properties'), f'serverJar={jar}\n'.encode())
        args = ['-jar', str(filename)]
    else:
        group = 'net/minecraftforge/forge' if loader == 'forge' else 'net/neoforged/neoforge'
        full = version + '-' + loader_version if loader == 'forge' else loader_version
        base = 'https://maven.minecraftforge.net/' if loader == 'forge' else 'https://maven.neoforged.net/releases/'
        url = f'{base}{group}/{full}/{loader}-{full}-installer.jar'
        with request_url(url + '.sha1') as response:
            checksum = response.read(200).decode().strip().split()[0]
        if not re.fullmatch(r'[0-9a-fA-F]{40}', checksum):
            raise ControllerError('У установщика загрузчика нет корректного SHA-1')
        installer = cache / 'loader-installer.jar'
        download(installer, [url], checksum.lower(), 'sha1', 128 * 1024 ** 2)
        subprocess.run([str(java), '-Xmx768M', '-jar', str(installer), '--installServer'], check=True)
        arguments = Path('libraries') / group / full / 'unix_args.txt'
        if arguments.is_file():
            args = ['@' + str(arguments)]
        elif loader == 'forge':
            server_jar = next((file for file in sorted(Path('.').glob('forge-*.jar'))
                               if 'installer' not in file.name and file.is_file()), None)
            if not server_jar:
                raise ControllerError('Установщик Forge не создал команду запуска сервера')
            args = ['-jar', str(server_jar)]
        else:
            raise ControllerError('Установщик NeoForge не создал unix_args.txt')
    json_file(marker, args)
    return args


def prepare_world(world_id):
    # systemd mounts DynamicUser state noexec. The shared runtime lives in a
    # root-owned cache that worlds can read and execute but cannot modify.
    world = get_world(world_id)
    with (CACHE / 'assets.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        print('Veyra Controller: Minecraft ' + world['minecraftVersion'], flush=True)
        _, major = minecraft(world['minecraftVersion'], CACHE)
        print(f'Veyra Controller: Java {major}', flush=True)
        java_runtime(major, CACHE)


def run_world(world_id):
    world = get_world(world_id)
    cache = Path('.veyra')
    cache.mkdir(exist_ok=True)
    version = world['minecraftVersion']
    metadata = json.loads((CACHE / (version + '.json')).read_text(encoding='utf-8'))
    major = metadata.get('javaVersion', {}).get('majorVersion', 8)
    jar = CACHE / ('minecraft-' + version + '.jar')
    java = CACHE / ('temurin-' + str(major)) / 'bin' / 'java'
    apply_build(world, cache)
    isolate_imported_client_mods(world, cache)
    arguments = launcher_args(world, java, jar, cache)
    agent = java_agent(cache) if world['veyraLogin'] else []
    configure_game(world)
    pipe = Path(os.environ['RUNTIME_DIRECTORY']) / 'console'
    pipe.unlink(missing_ok=True)
    os.mkfifo(pipe, mode=0o600)
    console = os.open(pipe, os.O_RDWR | os.O_NONBLOCK)
    # Java should block while waiting for commands. The writer has its own non-blocking fd.
    with pipe.open('rb', buffering=0) as commands:
        stopping = False

        def stop(_signal, _frame):
            nonlocal stopping
            if not stopping:
                stopping = True
                try:
                    os.write(console, b'stop\n')
                except BlockingIOError:
                    pass

        signal.signal(signal.SIGTERM, stop)
        try:
            args = [str(java), '-Xms512M', f"-Xmx{world['memoryGb']}G", '-Djna.tmpdir=/tmp', *agent,
                    *arguments, 'nogui']
            with subprocess.Popen(args, stdin=commands, stdout=subprocess.PIPE,
                                  stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace') as game:
                ready = False
                for line in game.stdout:
                    print(line, end='', flush=True)
                    if not ready and not stopping and READY.search(line):
                        notify_ready()
                        ready = True
                return game.wait()
        finally:
            os.close(console)
            pipe.unlink(missing_ok=True)


if __name__ == '__main__':
    if sys.argv[1:] == ['import-build']:
        response(lambda: import_build(sys.stdin.buffer))
        sys.exit(0)
    if len(sys.argv) == 3 and sys.argv[1] in ('prepare', 'run'):
        try:
            sys.exit(prepare_world(sys.argv[2]) if sys.argv[1] == 'prepare' else run_world(sys.argv[2]))
        except Exception as error:
            print(f'Veyra Controller: {error}', file=sys.stderr, flush=True)
            sys.exit(1)
    response(lambda: control(json.loads(sys.stdin.buffer.read(65537))))
