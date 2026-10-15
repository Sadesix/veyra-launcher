const GAMEMODES = ['survival', 'creative', 'adventure', 'spectator'];
const DIFFICULTIES = ['peaceful', 'easy', 'normal', 'hard'];
const DEFAULT_SERVER = Object.freeze({ levelName: 'world', seed: '', gamemode: 'survival', difficulty: 'normal', hardcore: false, allowFlight: false, maxPlayers: 8, viewDistance: 10, motd: '', port: 25565, memoryGb: null, veyraLogin: false });
const numbers = { maxPlayers: [1, 100, 'Игроков: от 1 до 100'], viewDistance: [2, 32, 'Дальность прорисовки: от 2 до 32 чанков'], port: [1024, 65535, 'Порт: от 1024 до 65535'] };
const texts = { seed: [64, 'Сид: до 64 символов в одну строку'], motd: [59, 'Описание: до 59 символов в одну строку'] };

// strict сообщает об ошибке поля; иначе неверное значение заменяется значением по умолчанию.
function serverConfig(value, { strict = false, maxMemoryGb = 64 } = {}) {
  const result = { ...DEFAULT_SERVER };
  const source = value && typeof value === 'object' ? value : {};
  const refuse = message => { if (strict) throw new Error(message); };
  if (source.levelName !== undefined) {
    const name = typeof source.levelName === 'string' ? source.levelName.trim().normalize('NFC') : '';
    if (name.length >= 1 && Array.from(name).length <= 32 && /^[\p{L}\p{N} _-]+$/u.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) result.levelName = name;
    else refuse('Название мира: до 32 букв, цифр, пробелов, _ и -');
  }
  for (const [key, [limit, message]] of Object.entries(texts)) {
    if (source[key] === undefined) continue;
    const text = typeof source[key] === 'string' ? source[key].trim().normalize('NFC') : null;
    if (text !== null && Array.from(text).length <= limit && !/\p{Cc}/u.test(text)) result[key] = text;
    else refuse(message);
  }
  if (source.gamemode !== undefined) { if (GAMEMODES.includes(source.gamemode)) result.gamemode = source.gamemode; else refuse('Неизвестный режим игры'); }
  if (source.difficulty !== undefined) { if (DIFFICULTIES.includes(source.difficulty)) result.difficulty = source.difficulty; else refuse('Неизвестная сложность'); }
  for (const key of ['hardcore', 'allowFlight', 'veyraLogin']) if (source[key] !== undefined) { if (typeof source[key] === 'boolean') result[key] = source[key]; else refuse('Некорректный переключатель сервера'); }
  for (const [key, [min, max, message]] of Object.entries(numbers)) {
    if (source[key] === undefined) continue;
    if (Number.isInteger(source[key]) && source[key] >= min && source[key] <= max) result[key] = source[key];
    else refuse(message);
  }
  if (source.memoryGb !== undefined && source.memoryGb !== null) {
    if (Number.isInteger(source.memoryGb) && source.memoryGb >= 1 && source.memoryGb <= maxMemoryGb) result.memoryGb = source.memoryGb;
    else refuse('Память сервера: от 1 до ' + maxMemoryGb + ' ГБ на этом компьютере');
  }
  return result;
}

// Java читает \uXXXX и в старом ISO-8859-1, и в новом UTF-8 формате server.properties.
const escapeValue = value => String(value).replace(/\\/g, '\\\\').replace(/^ /, '\\ ').replace(/[^\x20-\x7e]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
const unescapeValue = value => value.replace(/\\u([0-9a-fA-F]{4})|\\(.)/g, (_match, code, plain) => code ? String.fromCharCode(parseInt(code, 16)) : plain);

function serverProperties(config, port) {
  // С 26.3 сервер по умолчанию включает белый список и не пускает даже владельца: лаунчер его выключает при каждом запуске.
  const values = {
    'server-port': port, 'server-ip': '0.0.0.0', 'online-mode': 'false', 'white-list': 'false', 'enable-rcon': 'false', 'enable-query': 'false',
    'level-name': config.levelName, gamemode: config.gamemode, difficulty: config.difficulty, hardcore: config.hardcore,
    'allow-flight': config.allowFlight, 'max-players': config.maxPlayers, 'view-distance': config.viewDistance,
  };
  // Вход через Veyra: игроков проверяет сервер аккаунтов Veyra (authlib-injector), а ключей подписи чата у этих аккаунтов нет.
  if (config.veyraLogin) { values['online-mode'] = 'true'; values['enforce-secure-profile'] = 'false'; }
  // Пустые описание и сид оставляют значения, которые уже записал сервер или владелец.
  if (config.motd) values.motd = config.motd;
  if (config.seed) values['level-seed'] = config.seed;
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, escapeValue(value)]));
}

// Существующий server.properties становится исходными значениями конструктора.
function importProperties(text, options) {
  const found = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9.-]+)\s*[=:]\s?(.*)$/);
    if (match && !/^\s*[#!]/.test(line)) found[match[1]] = unescapeValue(match[2]);
  }
  const number = key => /^\d+$/.test(found[key] || '') ? Number(found[key]) : undefined;
  const flag = key => found[key] === 'true' ? true : found[key] === 'false' ? false : undefined;
  return serverConfig({
    levelName: found['level-name'], seed: found['level-seed'], motd: found.motd, gamemode: found.gamemode, difficulty: found.difficulty,
    hardcore: flag('hardcore'), allowFlight: flag('allow-flight'), maxPlayers: number('max-players'), viewDistance: number('view-distance'), port: number('server-port'),
  }, options);
}

module.exports = { DEFAULT_SERVER, GAMEMODES, DIFFICULTIES, serverConfig, serverProperties, importProperties };
