"""SSH control plane and systemd entry point for Veyra's Linux worlds."""

import base64
from contextlib import contextmanager
from datetime import datetime, timezone
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


PROTOCOL = 3
HOME = Path('/usr/local/lib/veyra-controller')
ROOT = Path('/var/lib/veyra-controller')
WORLDS = ROOT / 'worlds'
BUNDLES = ROOT / 'bundles'
TRASH = ROOT / 'trash'
PENDING_MODS = ROOT / 'pending-mods'
SHARE_WORKERS = ROOT / 'share-workers'
PRIVATE = Path('/var/lib/private')
CACHE = Path('/var/cache/veyra-controller')
UNIT = 'veyra-minecraft@'
UNIT_FILE = Path('/etc/systemd/system') / (UNIT + '.service')
SHARE_SERVICE = Path('/etc/systemd/system/veyra-build-access.service')
SHARE_TIMER = SHARE_SERVICE.with_suffix('.timer')
MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
WORLD_ID = re.compile(r'[0-9a-f]{32}')
VERSION_ID = re.compile(r'[0-9A-Za-z][0-9A-Za-z._+-]{0,99}')
READY = re.compile(r'\bDone \([\d.,]+s\)!|For help, type "help"')
BUILD_DIRS = {'mods', 'config', 'defaultconfigs', 'kubejs', 'scripts', 'global_packs',
              'openloader', 'paxi', 'datapacks', 'patchouli_books'}
PACK_DIRS = BUILD_DIRS | {'world'}
MAX_PACK_BYTES = 64 * 1024 ** 3
MAX_PACK_FILES = 100000
MAX_TEXT_BYTES = 1024 ** 2
DIR_FLAGS = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_DIRECTORY', 0)
FILE_FLAGS = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)
GAME_RULES = {
    'gamemode': ('survival', ('survival', 'creative', 'adventure', 'spectator')),
    'difficulty': ('normal', ('peaceful', 'easy', 'normal', 'hard')),
    'view-distance': (10, (2, 32)), 'simulation-distance': (10, (3, 32)),
    'spawn-protection': (16, (0, 256)), 'motd': ('A Minecraft Server', 160), 'level-seed': ('', 128),
    'pvp': (True, None), 'hardcore': (False, None), 'allow-flight': (False, None),
    'white-list': (False, None), 'enable-command-block': (False, None), 'allow-nether': (True, None),
    'force-gamemode': (False, None), 'generate-structures': (True, None),
}
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
    TRASH.mkdir(mode=0o700, exist_ok=True)
    with (ROOT / 'control.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        atomic_write(HOME / 'controller.py', source.encode())
        json_file(HOME / 'account.json', account)
        atomic_write(UNIT_FILE, UNIT_TEXT.encode())
        atomic_write(SHARE_SERVICE, b'[Service]\nType=oneshot\nExecStart=/usr/bin/python3 -I /usr/local/lib/veyra-controller/controller.py share-requests\nNoNewPrivileges=yes\nProtectSystem=strict\nPrivateTmp=yes\n')
        atomic_write(SHARE_TIMER, b'[Timer]\nOnActiveSec=3s\nOnUnitInactiveSec=8s\nAccuracySec=2s\n[Install]\nWantedBy=timers.target\n')
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
        for key in ('hasBundle', 'modCount', 'modsRevision'):
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
    if parts[0] == 'mods' and (len(parts) != 2 or not parts[1].lower().endswith(('.jar', '.jar.disabled'))):
        raise ControllerError('Недопустимый файл мода')
    return Path(*parts)


def receive_build(stream, header, stage, directories):
    count = integer(header, 'count', 0, MAX_PACK_FILES, 'Слишком много файлов сборки')
    total = integer(header, 'total', 0, MAX_PACK_BYTES, 'Слишком большая сборка')
    if total * 2 > shutil.disk_usage(ROOT).free:
        raise ControllerError('На ВМ не хватает места для переноса сборки и её рабочего экземпляра')
    stage.mkdir(mode=0o755)
    received = 0
    mods = 0
    for _ in range(count):
        item = stream_header(stream)
        relative = pack_path(item['path'])
        if relative.parts[0] not in directories:
            raise ControllerError('Этот файл не входит в выбранный тип переноса')
        length = integer(item, 'size', 0, total - received, 'Неверный размер файла сборки')
        target = stage / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as output:
            copy_exact(stream, output, length)
        received += length
        mods += relative.parts[0] == 'mods'
    if received != total or stream.read(1):
        raise ControllerError('Размер сборки не совпал')
    return count, mods


def import_build(stream):
    header = stream_header(stream)
    world = settings(header['settings'])
    os.umask(0o022)
    storage = BUNDLES / world['id']
    with tempfile.TemporaryDirectory(dir=BUNDLES) as temporary:
        stage = Path(temporary) / 'files'
        count, mods = receive_build(stream, header, stage, PACK_DIRS)
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


def copy_exact(stream, output, remaining):
    while remaining:
        block = stream.read(min(1024 ** 2, remaining))
        if not block:
            raise ControllerError('Передача файла прервалась')
        output.write(block)
        remaining -= len(block)


def path_parts(value, allow_root=False, internal=False):
    if allow_root and value == '':
        return ()
    if not isinstance(value, str) or len(value) > 8192:
        raise ControllerError('Некорректный путь')
    parts = value.split('/')
    if len(parts) > 48 or any(not part or part in ('.', '..') or len(part.encode()) > 255 or
                            re.search(r'[:\\\x00-\x1f\x7f]', part) for part in parts):
        raise ControllerError('Некорректный путь')
    if not internal and (parts[0] == '.veyra' or any(part.startswith('.veyra-upload-') for part in parts)):
        raise ControllerError('Служебная папка контроллера')
    return tuple(parts)


def state_path(world):
    return PRIVATE / ('veyra-world-' + world['id'])


@contextmanager
def directory_fd(root, parts=(), create=False):
    fd = os.open(root, DIR_FLAGS)
    try:
        owner = os.fstat(fd)
        for part in parts:
            if create:
                try:
                    os.mkdir(part, mode=0o755, dir_fd=fd)
                    os.chown(part, owner.st_uid, owner.st_gid, dir_fd=fd, follow_symlinks=False)
                except FileExistsError:
                    pass
            next_fd = os.open(part, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        yield fd
    finally:
        os.close(fd)


@contextmanager
def regular_file(fd, name):
    with os.fdopen(os.open(name, FILE_FLAGS, dir_fd=fd), 'rb') as file:
        info = os.fstat(file.fileno())
        # Mod code can create links in the world directory. Never expose their targets.
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ControllerError('Доступен только обычный файл без ссылок')
        yield file, info


def replace_file(fd, name, fill, owner, replace=True, etag=None):
    try:
        with regular_file(fd, name) as (old, info):
            if not replace:
                raise ControllerError('Файл «' + name + '» уже есть в этой папке')
            if etag is not None and (info.st_size > MAX_TEXT_BYTES or hashlib.sha256(old.read(MAX_TEXT_BYTES + 1)).hexdigest() != etag):
                raise ControllerError('Файл изменился на ВМ. Откройте его снова перед сохранением')
            mode = stat.S_IMODE(info.st_mode) & 0o777
    except FileNotFoundError:
        if etag is not None:
            raise ControllerError('Файл удалён на ВМ. Откройте список файлов снова')
        mode = 0o644
    tmp = '.veyra-upload-' + uuid.uuid4().hex
    try:
        descriptor = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=fd)
        with os.fdopen(descriptor, 'wb') as output:
            os.fchown(output.fileno(), owner.st_uid, owner.st_gid)
            os.fchmod(output.fileno(), mode)
            fill(output)
        os.replace(tmp, name, src_dir_fd=fd, dst_dir_fd=fd)
    finally:
        try:
            os.unlink(tmp, dir_fd=fd)
        except FileNotFoundError:
            pass


def ensure_workspace(world):
    root = state_path(world)
    PRIVATE.mkdir(mode=0o700, exist_ok=True)
    try:
        root.mkdir(mode=0o700)
        os.chown(root, 65534, 65534, follow_symlinks=False)
    except FileExistsError:
        pass
    with directory_fd(root) as root_fd:
        owner = os.fstat(root_fd)
    bundle = BUNDLES / world['id']
    if world.get('hasBundle'):
        with directory_fd(root, ('.veyra',), create=True) as cache:
            try:
                os.stat('build-applied', dir_fd=cache, follow_symlinks=False)
                return root
            except FileNotFoundError:
                pass
            if not bundle.is_dir():
                raise ControllerError('Файлы импортированной сборки не найдены')
            for source in bundle.rglob('*'):
                if source.is_symlink() or not source.is_file():
                    continue
                relative = source.relative_to(bundle).parts
                with directory_fd(root, relative[:-1], create=True) as handle:
                    try:
                        replace_file(handle, relative[-1], lambda out: copy_local(source, out), owner, replace=False)
                    except ControllerError:
                        with regular_file(handle, relative[-1]):
                            pass
            replace_file(cache, 'build-applied', lambda out: out.write(b'1\n'), owner)
    return root


def copy_local(path, output):
    with path.open('rb') as source:
        shutil.copyfileobj(source, output, 1024 ** 2)


def list_files(root, relative):
    parts = path_parts(relative, allow_root=True)
    entries = []
    try:
        with directory_fd(root, parts) as fd:
            with os.scandir(fd) as directory:
                for entry in directory:
                    if entry.name == '.veyra' or entry.name.startswith('.veyra-upload-'):
                        continue
                    info = entry.stat(follow_symlinks=False)
                    if stat.S_ISDIR(info.st_mode):
                        kind = 'directory'
                    elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                        kind = 'file'
                    else:
                        continue
                    entries.append({'name': entry.name, 'kind': kind, 'size': info.st_size,
                                    'modified': int(info.st_mtime * 1000)})
                    if len(entries) >= 5000:
                        break
    except FileNotFoundError:
        if parts:
            raise ControllerError('Папка на ВМ не найдена')
    return sorted(entries, key=lambda item: (item['kind'] != 'directory', item['name'].casefold()))


def read_file(root, name):
    parts = path_parts(name)
    with directory_fd(root, parts[:-1]) as fd, regular_file(fd, parts[-1]) as (file, info):
        if info.st_size > MAX_TEXT_BYTES:
            raise ControllerError('Редактор открывает текстовые файлы до 1 МБ')
        content = file.read(MAX_TEXT_BYTES + 1)
        if len(content) > MAX_TEXT_BYTES or b'\0' in content:
            raise ControllerError('Файл доступен для скачивания')
        try:
            text = content.decode('utf-8')
        except UnicodeDecodeError as error:
            raise ControllerError('Редактор открывает файлы UTF-8. Этот файл можно скачать') from error
        return {'text': text, 'etag': hashlib.sha256(content).hexdigest(),
                'liveConfig': is_mod_config(root, parts)}


def property_data(root):
    try:
        with directory_fd(root) as fd, regular_file(fd, 'server.properties') as (file, info):
            if info.st_size > MAX_TEXT_BYTES:
                raise ControllerError('server.properties превышает 1 МБ')
            return file.read(MAX_TEXT_BYTES + 1)
    except FileNotFoundError:
        return b''


def property_values(content):
    result = {}
    for line in content.decode('utf-8', errors='replace').splitlines():
        match = re.match(r'^\s*([\w.-]+)\s*[:=]\s*(.*)$', line)
        if match:
            result[match[1]] = re.sub(r'\\u([a-fA-F0-9]{4})|\\(.)',
                                     lambda m: chr(int(m[1], 16)) if m[1] else m[2], match[2])
    # Java writes a surrogate pair for characters outside the BMP.
    return {key: value.encode('utf-16', 'surrogatepass').decode('utf-16', 'replace') for key, value in result.items()}


def merged_properties(content, values):
    pattern = re.compile(rb'^\s*([A-Za-z0-9_.-]+)\s*[:=]')
    lines = [line for line in content.splitlines() if not (match := pattern.match(line)) or match[1].decode() not in values]
    def escaped(value):
        text = str(value).lower() if type(value) is bool else str(value)
        text = text.replace('\\', '\\\\')
        units = text.encode('utf-16-le', 'surrogatepass')
        codes = [int.from_bytes(units[i:i+2], 'little') for i in range(0, len(units), 2)]
        return ''.join(chr(code) if 32 <= code <= 126 else '\\u%04x' % code for code in codes)
    lines.extend(f'{key}={escaped(value)}'.encode() for key, value in values.items())
    return b'\n'.join(lines) + b'\n'


def game_rules(content, changes=None):
    stored = property_values(content)
    values = {}
    for key, (default, limits) in GAME_RULES.items():
        value = stored.get(key, default)
        if changes is not None:
            value = changes.get(key, default)
        elif type(default) is bool and type(value) is str:
            value = {'true': True, 'false': False}.get(value, default)
        elif type(default) is int and type(value) is str:
            value = int(value) if re.fullmatch(r'[0-9]{1,6}', value) else default
        if type(default) is bool:
            valid = type(value) is bool
        elif type(default) is int:
            valid = type(value) is int and limits[0] <= value <= limits[1]
        elif type(limits) is tuple:
            valid = value in limits
        else:
            valid = isinstance(value, str) and len(value) <= limits and not re.search(r'[\x00-\x1f\x7f]', value)
        if changes is not None and not valid:
            raise ControllerError('Недопустимое значение ' + key)
        values[key] = value if valid else default
    return values


def save_game_rules(root, changes, etag):
    before = property_data(root)
    if hashlib.sha256(before).hexdigest() != etag:
        raise ControllerError('Настройки изменились на ВМ. Откройте их снова')
    values = game_rules(before, changes)
    with directory_fd(root) as fd:
        replace_file(fd, 'server.properties', lambda out: out.write(merged_properties(before, values)), os.fstat(fd))


def save_server_config(world, root, request):
    config = settings(request['settings'], world)
    before = property_data(root)
    if hashlib.sha256(before).hexdigest() != request['etag']:
        raise ControllerError('Настройки изменились на ВМ. Откройте их снова')
    values = game_rules(before, request['rules'])
    values.update({'server-port': config['port'], 'max-players': config['maxPlayers'],
                   'online-mode': config['veyraLogin']})
    with directory_fd(root) as fd:
        owner = os.fstat(fd)
        try:
            os.stat('server.properties', dir_fd=fd, follow_symlinks=False)
            existed = True
        except FileNotFoundError:
            existed = False
        replace_file(fd, 'server.properties', lambda out: out.write(merged_properties(before, values)), owner)
        try:
            json_file(WORLDS / (world['id'] + '.json'), config)
        except OSError:
            if existed:
                replace_file(fd, 'server.properties', lambda out: out.write(before), owner)
            else:
                os.unlink('server.properties', dir_fd=fd)
            raise
    return {'id': world['id']}


def level_folder(root):
    name = property_values(property_data(root)).get('level-name', '') or 'world'
    if len(path_parts(name)) != 1 or name.startswith('.') or name in BUILD_DIRS | {'libraries', 'logs', 'versions'}:
        raise ControllerError('Проверьте level-name в server.properties')
    return name


def require_stopped(world_id):
    if states().get(world_id, 'stopped') not in ('stopped', 'error'):
        raise ControllerError('Остановите сервер перед изменением файлов или переносом')


def is_mod_config(root, parts):
    return (len(parts) >= 2 and parts[0] in ('config', 'defaultconfigs') or
            len(parts) >= 3 and parts[1] == 'serverconfig' and parts[0] == level_folder(root))


def trash_directory(world, kind):
    name = uuid.uuid4().hex
    folder = TRASH / name
    folder.mkdir(mode=0o700)
    detail = {'id': name, 'serverId': world['id'], 'name': world['name'], 'kind': kind,
              'time': datetime.now(timezone.utc).isoformat()}
    return folder, detail


def move_files(pairs, finish):
    moved = []
    try:
        for source, target in pairs:
            if not source.exists() and not source.is_symlink():
                continue
            if target.exists() or target.is_symlink():
                raise ControllerError('Путь на ВМ уже занят: ' + target.name)
            source.rename(target)
            moved.append((source, target))
        return finish()
    except Exception:
        for source, target in reversed(moved):
            target.rename(source)
        raise


def delete_server(world):
    root = state_path(world)
    folder, detail = trash_directory(world, 'server')
    config = WORLDS / (world['id'] + '.json')
    move_files([(root, folder / 'state'), (BUNDLES / world['id'], folder / 'bundle'),
                (PENDING_MODS / world['id'], folder / 'pending-mods'),
                (SHARE_WORKERS / world['id'], folder / 'share-worker'),
                (config, folder / 'server.json')], lambda: json_file(folder / 'entry.json', detail))
    return detail


def delete_level(world, root):
    level = level_folder(root)
    source = root / level
    if not source.is_dir() or source.is_symlink():
        raise ControllerError('Сохранение мира отсутствует')
    folder, detail = trash_directory(world, 'world')
    move_files([(source, folder / 'level')], lambda: json_file(folder / 'entry.json', detail))
    return detail


def restore_trash(identifier):
    if not isinstance(identifier, str) or not WORLD_ID.fullmatch(identifier):
        raise ControllerError('Запись корзины не найдена')
    folder = TRASH / identifier
    info = json.loads((folder / 'entry.json').read_text(encoding='utf-8'))
    if info['kind'] == 'server':
        server = json.loads((folder / 'server.json').read_text(encoding='utf-8'))
        if any(item['id'] == server['id'] or item['port'] == server['port'] for item in read_worlds()):
            raise ControllerError('Сервер с таким идентификатором или портом уже есть на ВМ')
        port_available(server['port'])
        PRIVATE.mkdir(mode=0o700, exist_ok=True)
        move_files([(folder / 'state', state_path(server)), (folder / 'bundle', BUNDLES / server['id']),
                    (folder / 'pending-mods', PENDING_MODS / server['id']),
                    (folder / 'share-worker', SHARE_WORKERS / server['id']),
                    (folder / 'server.json', WORLDS / (server['id'] + '.json'))], (folder / 'entry.json').unlink)
        return {'id': server['id']}
    server = get_world(info['serverId'])
    require_stopped(server['id'])
    root = ensure_workspace(server)
    if info['kind'] == 'transfer':
        directories = transfer_mode(info['mode'])
        level = level_folder(root)
        backup, record = trash_directory(server, 'transfer')
        record.update(mode=info['mode'], modCount=server.get('modCount', 0), sourceId=server.get('sourceId', ''),
                      modsRevision=server.get('modsRevision', ''))
        backups, replacements = [], []
        for name in sorted(directories):
            target = root / (level if name == 'world' else name)
            if target.is_symlink():
                raise ControllerError('Заменяемая папка является ссылкой: ' + target.name)
            backups.append((target, backup / name))
            replacements.append((folder / name, target))
        config = WORLDS / (server['id'] + '.json')
        original = config.read_bytes()
        def commit():
            if info['mode'] != 'world':
                server.update(modCount=info['modCount'], sourceId=info['sourceId'], modsRevision=info.get('modsRevision', ''))
                json_file(config, server)
            try:
                json_file(backup / 'entry.json', record)
                (folder / 'entry.json').unlink()
            except OSError:
                (backup / 'entry.json').unlink(missing_ok=True)
                atomic_write(config, original)
                raise
        move_files(backups + replacements, commit)
        folder.rmdir()
        return {'id': server['id']}
    if info['kind'] != 'world':
        raise ControllerError('Запись корзины не поддерживается')
    level = root / level_folder(root)
    if level.exists() or level.is_symlink():
        raise ControllerError('Выбранный сервер уже содержит мир. Сначала переместите его в корзину')
    move_files([(folder / 'level', level)], (folder / 'entry.json').unlink)
    folder.rmdir()
    return {'id': server['id']}


def purge_trash(identifier):
    if not isinstance(identifier, str) or not WORLD_ID.fullmatch(identifier):
        raise ControllerError('Запись корзины не найдена')
    folder = TRASH / identifier
    if folder.is_symlink() or not (folder / 'entry.json').is_file() or folder.resolve().parent != TRASH.resolve():
        raise ControllerError('Запись корзины не найдена')
    shutil.rmtree(folder)
    return True


def transfer_mode(mode):
    allowed = {'build': BUILD_DIRS, 'world': {'world'}, 'both': PACK_DIRS, 'mods': {'mods'}}
    if mode not in allowed:
        raise ControllerError('Выберите тип переноса')
    return allowed[mode]


def replace_build(stream):
    request = stream_header(stream)
    world_id = request['worldId']
    directories = transfer_mode(request['mode'])
    get_world(world_id)
    if request['mode'] == 'mods':
        return receive_mod_update(stream, request, world_id)
    require_stopped(world_id)
    with tempfile.TemporaryDirectory(dir=ROOT) as temporary:
        stage = Path(temporary) / 'new'
        count, mods = receive_build(stream, request, stage, directories)
        if not count or ('world' in directories and not (stage / 'world' / 'level.dat').is_file()):
            raise ControllerError('В выбранном переносе нет файлов или сохранения level.dat')
        if request['mode'] != 'world' and not any((stage / name).is_dir() for name in BUILD_DIRS):
            raise ControllerError('В выбранном переносе отсутствуют файлы сборки')
        with (ROOT / 'control.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            world = get_world(world_id)
            require_stopped(world_id)
            compatibility = request.get('compatibility')
            if compatibility and any(compatibility.get(key, default) != world.get(key, default)
                                     for key, default in [('minecraftVersion', ''), ('loader', 'vanilla'), ('loaderVersion', '')]):
                raise ControllerError('Для замены сборки выберите ту же версию Minecraft и загрузчика')
            skipped = []
            for mod in (stage / 'mods').glob('*.jar'):
                if client_only_mod(mod, world.get('loader', 'vanilla')):
                    skipped.append(mod.name)
                    mod.unlink()
            root = ensure_workspace(world)
            level = level_folder(root)
            with directory_fd(root) as fd:
                owner = os.fstat(fd)
            for child in [stage, *stage.rglob('*')]:
                os.chown(child, owner.st_uid, owner.st_gid, follow_symlinks=False)
            folder, detail = trash_directory(world, 'transfer')
            detail.update(mode=request['mode'], modCount=world.get('modCount', 0), sourceId=world.get('sourceId', ''),
                          modsRevision=world.get('modsRevision', ''))
            backups, new = [], []
            for name in sorted(directories):
                target = root / (level if name == 'world' else name)
                if target.is_symlink():
                    raise ControllerError('Заменяемая папка является ссылкой: ' + target.name)
                backups.append((target, folder / name))
                new.append((stage / name, target))
            config = WORLDS / (world_id + '.json')
            original = config.read_bytes()
            def commit():
                if request['mode'] != 'world':
                    world['modCount'] = mods - len(skipped)
                    world['sourceId'] = request.get('sourceId', '')
                    world.pop('modsRevision', None)
                    json_file(config, world)
                try:
                    json_file(folder / 'entry.json', detail)
                except OSError:
                    atomic_write(config, original)
                    raise
            move_files(backups + new, commit)
    return {'id': world_id, 'archive': detail['id'], 'skipped': skipped}


def apply_mod_update(world, pending):
    root = ensure_workspace(world)
    active = root / 'mods'
    if active.is_symlink() or (active.exists() and not active.is_dir()):
        raise ControllerError('Папка mods должна быть обычной папкой')
    with directory_fd(root) as fd:
        owner = os.fstat(fd)
    backup, detail = trash_directory(world, 'transfer')
    detail.update(mode='mods', modCount=world.get('modCount', 0), sourceId=world.get('sourceId', ''),
                  modsRevision=world.get('modsRevision', ''))
    config = WORLDS / (world['id'] + '.json')
    original = config.read_bytes()
    updated = {**world, **json.loads((pending / 'update.json').read_text(encoding='utf-8'))}
    def commit():
        json_file(config, updated)
        try:
            json_file(backup / 'entry.json', detail)
        except OSError:
            atomic_write(config, original)
            raise
    # systemd can bind-mount StateDirectory separately from the controller's
    # spool and trash. Keep both sides of each live rename in StateDirectory.
    with tempfile.TemporaryDirectory(prefix='.veyra-upload-', dir=root) as temporary:
        staging = Path(temporary)
        incoming = shutil.copytree(pending / 'mods', staging / 'incoming', symlinks=True)
        for entry in [incoming, *incoming.iterdir()]:
            os.chown(entry, owner.st_uid, owner.st_gid, follow_symlinks=False)
        if active.is_dir():
            archived = shutil.copytree(active, backup / 'mods', symlinks=True)
            for entry in [archived, *archived.rglob('*')]:
                original_entry = (active / entry.relative_to(archived)).lstat()
                os.chown(entry, original_entry.st_uid, original_entry.st_gid, follow_symlinks=False)
        move_files([(active, staging / 'previous'), (incoming, active)], commit)
    shutil.rmtree(pending)


def receive_mod_update(stream, request, world_id):
    source_id = request.get('sourceId')
    revision = request.get('revision')
    if not isinstance(source_id, str) or not re.fullmatch(r'[0-9a-zA-Z-]{1,80}', source_id):
        raise ControllerError('Выберите локальную сборку')
    if not isinstance(revision, str) or not re.fullmatch(r'[0-9a-f]{64}', revision):
        raise ControllerError('Некорректная ревизия модов')
    PENDING_MODS.mkdir(mode=0o700, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=PENDING_MODS) as temporary:
        stage = Path(temporary) / 'stage'
        _, count = receive_build(stream, request, stage, {'mods'})
        (stage / 'mods').mkdir(exist_ok=True)
        with (ROOT / 'control.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            world = get_world(world_id)
            compatibility = request.get('compatibility')
            if not isinstance(compatibility, dict) or any(compatibility.get(key) != world.get(key, default)
                    for key, default in [('minecraftVersion', ''), ('loader', 'vanilla'), ('loaderVersion', '')]):
                raise ControllerError('Для синхронизации нужна та же версия Minecraft и загрузчика')
            skipped = []
            for mod in (stage / 'mods').iterdir():
                if not mod.name.lower().endswith('.jar') or client_only_mod(mod, world.get('loader', 'vanilla')):
                    skipped.append(mod.name)
                    mod.unlink()
            json_file(stage / 'update.json', {'modCount': count - len(skipped), 'sourceId': source_id, 'modsRevision': revision})
            pending = PENDING_MODS / world_id
            move_files([(pending, Path(temporary) / 'previous'), (stage, pending)], lambda: None)
            queued = states().get(world_id, 'stopped') not in ('stopped', 'error')
            if not queued:
                apply_mod_update(world, pending)
            return {'id': world_id, 'queued': queued, 'skipped': skipped}


def upload_file(stream):
    request = stream_header(stream)
    parts = path_parts(request['path'])
    length = integer(request, 'size', 0, MAX_PACK_BYTES, 'Недопустимый размер файла')
    world = get_world(request['worldId'])
    etag = request.get('etag')
    if etag is not None:
        if not isinstance(etag, str) or not re.fullmatch(r'[0-9a-f]{64}', etag) or length > MAX_TEXT_BYTES:
            raise ControllerError('Откройте текстовый файл до 1 МБ перед сохранением')
    else:
        require_stopped(world['id'])
    if length * 2 > shutil.disk_usage(ROOT).free:
        raise ControllerError('На ВМ не хватает места для загрузки')
    with tempfile.TemporaryFile(dir=ROOT) as staging:
        copy_exact(stream, staging, length)
        if stream.read(1):
            raise ControllerError('Размер файла не совпал')
        staging.seek(0)
        if etag is not None:
            content = staging.read()
            try:
                content.decode('utf-8')
            except UnicodeDecodeError as error:
                raise ControllerError('Сохранять можно только текст UTF-8') from error
            if b'\0' in content:
                raise ControllerError('Сохранять можно только текст UTF-8')
            staging.seek(0)
        with (ROOT / 'control.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            world = get_world(world['id'])
            status = states().get(world['id'], 'stopped')
            root = state_path(world)
            if status in ('stopped', 'error'):
                root = ensure_workspace(world)
            elif status != 'ready' or etag is None or not is_mod_config(root, parts):
                raise ControllerError('Остановите сервер перед изменением этого файла')
            with directory_fd(root) as root_fd, directory_fd(root, parts[:-1]) as fd:
                replace_file(fd, parts[-1], lambda out: copy_exact(staging, out, length), os.fstat(root_fd),
                             request.get('replace') is True, etag)
            if parts[0] == 'mods' and world.pop('modsRevision', None):
                json_file(WORLDS / (world['id'] + '.json'), world)
    return True


def write_backup(zip_file, root, parts, arcname):
    with directory_fd(root, parts) as fd:
        for entry in os.listdir(fd):
            if entry == 'session.lock':
                continue
            if arcname == 'mods' and not entry.lower().endswith(('.jar', '.jar.disabled')):
                continue
            info = os.stat(entry, dir_fd=fd, follow_symlinks=False)
            child = arcname + '/' + entry
            if stat.S_ISDIR(info.st_mode):
                if arcname == 'mods':
                    continue
                write_backup(zip_file, root, parts + (entry,), child)
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                with regular_file(fd, entry) as (file, _), zip_file.open(child, 'w', force_zip64=True) as target:
                    shutil.copyfileobj(file, target, 1024 ** 2)


def download_files(request, output):
    world = get_world(request['worldId'])
    kind = request['kind']
    if kind == 'file':
        parts = path_parts(request['path'])
        with directory_fd(state_path(world), parts[:-1]) as fd, regular_file(fd, parts[-1]) as (file, _):
            shutil.copyfileobj(file, output, 1024 ** 2)
        return
    with (ROOT / 'control.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        world = get_world(world['id'])
        directories = {'mods'} if kind == 'mods' else transfer_mode(kind)
        status = states().get(world['id'], 'stopped')
        if 'world' in directories:
            require_stopped(world['id'])
        root = ensure_workspace(world) if status in ('stopped', 'error') else state_path(world)
        if 'world' in directories:
            level = level_folder(root)
            if not (root / level / 'level.dat').is_file():
                raise ControllerError('На сервере ещё нет сохранения мира')
        if kind == 'mods' and not (root / 'mods').is_dir():
            raise ControllerError('На сервере нет папки mods')
        with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
            metadata = {key: world.get(key, default) for key, default in
                        [('minecraftVersion', ''), ('loader', 'vanilla'), ('loaderVersion', '')]}
            archive.writestr('.veyra-server.json', json.dumps(metadata))
            for name in sorted(directories):
                folder = level if name == 'world' else name
                if name == 'world' or (root / folder).is_dir():
                    write_backup(archive, root, (folder,), name)


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


def share_worker(world):
    if not world.get('veyraLogin'):
        raise ControllerError('Для выдачи сборки по белому списку включите вход через Veyra')
    SHARE_WORKERS.mkdir(mode=0o700, exist_ok=True)
    file = SHARE_WORKERS / world['id']
    if not file.exists():
        atomic_write(file, os.urandom(32).hex().encode(), mode=0o600)
    systemctl('enable', '--now', SHARE_TIMER.name)
    return {'key': file.read_text(encoding='ascii')}


def whitelist_members(world):
    if not world.get('veyraLogin'):
        return set()
    try:
        with directory_fd(state_path(world)) as fd, regular_file(fd, 'whitelist.json') as (file, info):
            if info.st_size > MAX_TEXT_BYTES:
                return set()
            entries = json.loads(file.read(MAX_TEXT_BYTES + 1))
    except (OSError, ValueError, ControllerError):
        return set()
    if not isinstance(entries, list):
        return set()
    ids = (str(entry.get('uuid', '')).lower().replace('-', '') for entry in entries if isinstance(entry, dict))
    return {value for value in ids if WORLD_ID.fullmatch(value)}


def share_requests():
    root = json.loads((HOME / 'account.json').read_text(encoding='utf-8')).get('api', '')
    if not isinstance(root, str) or not root.startswith('https://'):
        return
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    opener = urllib.request.build_opener(NoRedirect)
    for file in SHARE_WORKERS.glob('*'):
        if not WORLD_ID.fullmatch(file.name):
            continue
        try:
            world = get_world(file.name)
            key = file.read_text(encoding='ascii')
            def request(action, data):
                url = root.rstrip('/') + '/veyra/build-sync/' + file.name + '/' + action
                req = urllib.request.Request(url, json.dumps(data).encode(), {
                    'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key})
                with opener.open(req, timeout=5) as reply:
                    return json.loads(reply.read(MAX_TEXT_BYTES))
            pending = request('poll', {})
            jobs = pending.get('jobs', {})
            if jobs:
                members = whitelist_members(world) if world.get('modsRevision') and world['modsRevision'] == pending.get('revision') else set()
                request('approve', {'allowed': [job for job, profile in jobs.items() if profile in members], 'seen': list(jobs)})
        except (OSError, ValueError, AttributeError, ControllerError):
            continue


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
    if action == 'trash':
        entries = []
        for file in TRASH.glob('*/entry.json'):
            info = json.loads(file.read_text(encoding='utf-8'))
            entries.append(info)
        return sorted(entries, key=lambda item: item['time'], reverse=True)
    with (ROOT / 'control.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if action == 'restore':
            return restore_trash(request.get('entryId'))
        if action == 'purge':
            return purge_trash(request.get('entryId'))
        if action != 'create':
            world = get_world(selected)
            states_now = states()
            status = states_now.get(selected, 'stopped')
        if action == 'share-worker':
            return share_worker(world)
        if action == 'share-worker-disable':
            (SHARE_WORKERS / selected).unlink(missing_ok=True)
            return True
        if action in ('create', 'save'):
            if action == 'save' and status not in ('stopped', 'error'):
                raise ControllerError('Остановите мир перед изменением настроек')
            world = settings(request['settings'], world if action == 'save' else None)
            json_file(WORLDS / (world['id'] + '.json'), world)
            return {'id': world['id']}
        if action in ('files', 'read-file', 'game-rules', 'save-rules', 'save-config', 'mkdir', 'delete-world', 'delete-server'):
            stopped = status in ('stopped', 'error')
            if not stopped and action in ('save-rules', 'save-config', 'mkdir', 'delete-world', 'delete-server'):
                raise ControllerError('Остановите сервер перед изменением файлов или удалением')
            if action == 'delete-server':
                return delete_server(world)
            root = ensure_workspace(world) if stopped else state_path(world)
            if action == 'files':
                return list_files(root, request.get('path', ''))
            if action == 'read-file':
                return read_file(root, request['path'])
            if action == 'game-rules':
                contents = property_data(root)
                level = level_folder(root)
                exists = (root / level / 'level.dat').is_file() and not (root / level).is_symlink()
                return {'rules': game_rules(contents), 'etag': hashlib.sha256(contents).hexdigest(),
                        'worldFolder': level, 'worldExists': exists}
            if action == 'save-rules':
                save_game_rules(root, request['rules'], request['etag'])
                return True
            if action == 'save-config':
                return save_server_config(world, root, request)
            if action == 'delete-world':
                return delete_level(world, root)
            parts = path_parts(request['path'])
            with directory_fd(root, parts[:-1]) as fd, directory_fd(root) as root_fd:
                owner = os.fstat(root_fd)
                os.mkdir(parts[-1], mode=0o755, dir_fd=fd)
                os.chown(parts[-1], owner.st_uid, owner.st_gid, dir_fd=fd, follow_symlinks=False)
            return True
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
    previous = properties.read_bytes() if properties.exists() else b''
    atomic_write(properties, merged_properties(previous, values))
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
    with (ROOT / 'control.lock').open('a') as control_lock:
        fcntl.flock(control_lock, fcntl.LOCK_EX)
        world = get_world(world_id)
        pending = PENDING_MODS / world_id
        if (pending / 'mods').is_dir():
            apply_mod_update(world, pending)
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
    if sys.argv[1:] == ['share-requests']:
        share_requests()
        sys.exit(0)
    if sys.argv[1:] == ['import-build']:
        response(lambda: import_build(sys.stdin.buffer))
        sys.exit(0)
    if sys.argv[1:] == ['replace-build']:
        response(lambda: replace_build(sys.stdin.buffer))
        sys.exit(0)
    if sys.argv[1:] == ['upload-file']:
        response(lambda: upload_file(sys.stdin.buffer))
        sys.exit(0)
    if sys.argv[1:] == ['download-files']:
        try:
            download_files(json.loads(sys.stdin.buffer.read(65537)), sys.stdout.buffer)
        except (OSError, ValueError, TypeError, KeyError, AttributeError, subprocess.SubprocessError, ControllerError) as error:
            print(str(error), file=sys.stderr)
            sys.exit(1)
        sys.exit(0)
    if len(sys.argv) == 3 and sys.argv[1] in ('prepare', 'run'):
        try:
            sys.exit(prepare_world(sys.argv[2]) if sys.argv[1] == 'prepare' else run_world(sys.argv[2]))
        except Exception as error:
            print(f'Veyra Controller: {error}', file=sys.stderr, flush=True)
            sys.exit(1)
    response(lambda: control(json.loads(sys.stdin.buffer.read(65537))))
