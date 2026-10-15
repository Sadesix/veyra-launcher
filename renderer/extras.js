(() => {
  'use strict';
  const api = window.launcher, el = id => document.getElementById(id);
  const node = (tag, className, text) => { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; };
  const icon = name => { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.classList.add('icon'); const use = document.createElementNS(svg.namespaceURI, 'use'); use.setAttribute('href', '#i-' + name); svg.append(use); return svg; };
  const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const pref = (key, fallback) => { try { const value = localStorage.getItem('veyra.' + key); return value === null ? fallback : value === '1'; } catch { return fallback; } };
  const savePref = (key, value) => { try { localStorage.setItem('veyra.' + key, value ? '1' : '0'); } catch { /* настройка действует до перезапуска */ } };
  let data = null;

  // ── Голова игрока: восемь на восемь пикселей, свой рисунок для каждого ника ──
  function head(canvas, name) {
    let seed = 2166136261;
    for (const character of String(name || 'Player')) seed = Math.imul(seed ^ character.codePointAt(0), 16777619);
    const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
    const pick = list => list[Math.floor(next() * list.length)];
    const skin = pick(['#e8c4a8', '#d9a98c', '#c58f73', '#f0d5bf', '#a8785f']);
    const hair = pick(['#3c343e', '#5d5162', '#8d5a4d', '#666c8e', '#58765b', '#b17868', '#cdbfb4']);
    const eyes = pick(['#666c8e', '#58765b', '#3c343e', '#8d5a4d']);
    const shade = '#' + [1, 3, 5].map(index => Math.round(parseInt(skin.slice(index, index + 2), 16) * .8).toString(16).padStart(2, '0')).join('');
    const long = next() > .55, smile = next() > .4;
    const context = canvas.getContext('2d');
    const dot = (x, y, color) => { context.fillStyle = color; context.fillRect(x, y, 1, 1); };
    context.fillStyle = skin; context.fillRect(0, 0, 8, 8);
    context.fillStyle = hair; context.fillRect(0, 0, 8, 2);
    for (let x = 0; x < 8; x++) if (x === 0 || x === 7 || next() > .5) dot(x, 2, hair);
    if (long) for (let y = 3; y < 6; y++) { dot(0, y, hair); dot(7, y, hair); }
    dot(1, 4, '#f0e1d3'); dot(2, 4, eyes); dot(5, 4, eyes); dot(6, 4, '#f0e1d3');
    dot(3, 5, shade); dot(4, 5, shade);
    for (let x = smile ? 2 : 3; x <= (smile ? 5 : 4); x++) dot(x, 6, '#7a4a40');
    if (smile) { dot(2, 6, shade); dot(5, 6, shade); }
  }
  window.veyraHead = head;
  function renderHeads() {
    const name = data?.account.name || 'Player';
    for (const canvas of document.querySelectorAll('canvas[data-head]')) if (canvas.dataset.head !== name) { canvas.dataset.head = name; head(canvas, name); }
  }

  // ── Подсказка предмета следует за курсором и живёт в верхнем слое, поверх окон ──
  const tooltip = el('tooltip');
  let tipTarget = null;
  tooltip.popover = 'manual';
  function placeTip(event) {
    const box = tooltip.getBoundingClientRect();
    const x = Math.min(event.clientX + 16, innerWidth - box.width - 9), y = event.clientY + 22 + box.height > innerHeight - 9 ? event.clientY - box.height - 14 : event.clientY + 22;
    tooltip.style.left = Math.max(9, x) + 'px'; tooltip.style.top = Math.max(9, y) + 'px';
  }
  function hideTip() {
    if (!tipTarget) return;
    tipTarget = null;
    if (tooltip.matches(':popover-open')) tooltip.hidePopover();
    tooltip.hidden = true;
  }
  document.addEventListener('pointermove', event => {
    const target = event.pointerType === 'mouse' ? event.target.closest?.('[data-tip]') : null;
    if (!target) return hideTip();
    if (target !== tipTarget || el('tooltip-title').textContent !== target.dataset.tip) {
      hideTip(); tipTarget = target;
      el('tooltip-title').textContent = target.dataset.tip;
      el('tooltip-lore').textContent = target.dataset.tipLore || '';
      tooltip.hidden = false; tooltip.showPopover();
    }
    placeTip(event);
  });
  for (const type of ['pointerdown', 'keydown', 'wheel', 'blur']) window.addEventListener(type, hideTip, true);
  document.addEventListener('pointerleave', hideTip);

  // ── Фразы рядом с приветствием ──
  const phrases = ['Теперь с блоками!', 'Не копай прямо вниз!', 'Сделано из пикселей', 'Ещё один мир — и спать', 'Алмазы сами себя не добудут', 'Сначала дерево!', 'Сохранись перед походом',
    'Ностальгия включена', 'Тёплый металл, мягкий свет', 'Здесь могла быть ваша база', 'Кровать сама себя не поставит', 'Сегодня без лавы', 'Проверь моды дважды', 'Вдвоём ночь короче',
    'Крипер? Показалось.', 'Место, где ты не был', 'F3 знает всё', 'Факелов много не бывает', 'Собери свой мир', 'Хорошего приключения!',
    '↑ ↑ ↓ ↓ ← → ← → B A', 'Ссс… набери snake', 'Тук-тук по логотипу'];
  const CREEPER = 'Крипер? Показалось.';
  // В сезон Хеллоуина фразы берутся из праздничного набора halloween.js.
  const lines = () => window.veyraHalloween?.active() ? window.veyraHalloween.phrases : phrases;
  let phrase = -1, flips = 0;
  function renderSplash(change = false) {
    const splash = el('splash'), shown = pref('splash', true);
    splash.hidden = !shown;
    if (!shown || !change && phrase >= 0) return;
    const value = new Uint32Array(1); crypto.getRandomValues(value);
    const list = lines();
    phrase = (phrase < 0 ? value[0] : phrase + 1 + value[0] % (list.length - 1)) % list.length;
    splash.textContent = list[phrase];
    if (change && !calm()) splash.animate([{ scale: .7, opacity: .2 }, { scale: 1.12 }, { scale: 1 }], { duration: 320, easing: 'steps(6)' });
  }
  // Крипер в приветствии взрывается от щелчка, а пятнадцать фраз подряд открывают «Болтуна».
  el('splash').addEventListener('click', () => {
    if (++flips === 15) unlock('chatterbox');
    if (lines()[phrase] !== CREEPER) return renderSplash(true);
    unlock('creeper');
    if (calm()) return renderSplash(true);
    document.querySelector('.app-shell').animate([{ translate: '0 0' }, { translate: '-6px 3px' }, { translate: '5px -4px' }, { translate: '-4px -2px' }, { translate: '3px 4px' }, { translate: '0 0' }], { duration: 360, easing: 'steps(5)' });
    el('splash').animate([{ scale: 1, filter: 'brightness(1)' }, { scale: 1.3, filter: 'brightness(2.6)' }, { scale: 1.5, opacity: 0, filter: 'brightness(4)' }], { duration: 380, easing: 'steps(6)' })
      .finished.catch(() => {}).finally(() => renderSplash(true));
  });
  function setSplash(shown) {
    savePref('splash', shown);
    el('ui-splash').checked = shown;
    renderSplash();
  }
  el('splash').addEventListener('contextmenu', event => window.veyraMenu(event, 'Фраза на главной', [
    ['refresh', 'Другая фраза', () => renderSplash(true)],
    ['eye', 'Скрыть фразы', () => {
      setSplash(false);
      window.dispatchEvent(new CustomEvent('veyra:notify', { detail: { message: 'Фразы скрыты. Вернуть их можно в настройках', undo: () => setSplash(true) } }));
    }],
  ]));

  // ── Часы: солнце днём, луна ночью, а в Хеллоуин и новогоднюю ночь — свои значки ──
  let season = '';
  function renderClock() {
    const now = new Date(), hour = now.getHours(), night = hour < 6 || hour >= 21, day = now.getMonth() * 100 + now.getDate();
    season = day === 931 ? 'pumpkin' : day === 1131 || day === 1 ? 'new-year' : '';
    el('clock-time').textContent = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    el('clock-icon').setAttribute('href', season === 'pumpkin' ? '#i-pumpkin' : season === 'new-year' ? '#i-spark' : night ? '#i-moon' : '#i-sun');
    el('world-clock').classList.toggle('is-night', night);
    el('world-clock').classList.toggle('is-festive', Boolean(season));
    el('world-clock').dataset.tipLore = season === 'pumpkin' ? 'Тыквы светятся. Что-то не так с часами…' : season === 'new-year' ? 'Бой курантов совсем близко' :
      hour < 6 ? 'Ночь — время тихих строек' : hour < 12 ? 'Утро — мобы уже сгорели' : hour < 18 ? 'День — лучшее время для похода' : hour < 21 ? 'Вечер — пора ставить факелы' : 'Ночь — время тихих строек';
  }
  el('world-clock').addEventListener('click', () => {
    if (!season) return;
    unlock(season);
    if (!calm()) el('clock-icon').parentElement.animate([{ rotate: '0deg' }, { rotate: '-20deg' }, { rotate: '20deg' }, { rotate: '0deg' }], { duration: 360, easing: 'steps(4)' });
  });

  // ── Полоса опыта: уровень — часы в игре, а во время работы — её прогресс ──
  const operations = { install: 'Установка', launch: 'Запуск', content: 'Содержимое', server: 'Сервер' };
  function totalPlayed() {
    const live = data.runningSession ? Math.max(0, Date.now() - data.runningSession.accountedAt) : 0;
    return data.instances.reduce((sum, item) => sum + (item.playedMs || 0), 0) + live;
  }
  function renderXp(progress) {
    if (!data) return;
    const operation = data.operation, bar = el('xp');
    bar.classList.toggle('is-busy', Boolean(operation));
    el('xp-label').hidden = !operation;
    if (operation) {
      const value = progress || operation.progress, percent = value?.percent;
      bar.classList.toggle('is-indeterminate', percent == null);
      el('xp-fill').style.width = (percent ?? 30) + '%';
      el('xp-label').textContent = (operations[operation.type] || 'Работа') + (percent == null ? '…' : ' · ' + percent + '%');
      return;
    }
    bar.classList.remove('is-indeterminate');
    const played = totalPlayed();
    el('xp-level').textContent = Math.floor(played / 3600000);
    el('xp-fill').style.width = (played % 3600000 / 36000).toFixed(1) + '%';
  }

  // ── Достижения ──
  // [id, иконка, название, условие, проверка по состоянию лаунчера, подсказка]. С подсказкой достижение секретное:
  // до открытия на доске видны только «???» и намёк, а получают его пасхалки из eggs.js и часы в праздники.
  const hour = 3600000;
  const trophies = [
    ['first-build', 'box', 'Первый блок', 'Создать первую сборку', s => s.builds >= 1],
    ['modded', 'puzzle', 'Инженер', 'Создать сборку с загрузчиком модов', s => s.modded],
    ['collector', 'layers', 'Коллекционер', 'Собрать три сборки', s => s.builds >= 3],
    ['first-launch', 'play', 'Первый шаг', 'Запустить игру впервые', s => s.launches >= 1],
    ['regular', 'refresh', 'Завсегдатай', 'Запустить игру десять раз', s => s.launches >= 10],
    ['hour', 'clock', 'Час в пути', 'Провести в игре один час', s => s.played >= hour],
    ['veteran', 'sword', 'Старожил', 'Провести в игре десять часов', s => s.played >= 10 * hour],
    ['legend', 'crown', 'Легенда', 'Провести в игре сто часов', s => s.played >= 100 * hour],
    ['favorite', 'star', 'Любимчик', 'Закрепить сборку в избранном', s => s.favorite],
    ['chronicler', 'book', 'Летописец', 'Оставить заметку на табличке', s => s.note],
    ['artist', 'image', 'Художник', 'Поставить сборке свою обложку', s => s.cover],
    ['host', 'server', 'Хозяин мира', 'Запустить собственный сервер', s => s.server],
    ['party', 'users', 'Вдвоём веселее', 'Запустить два клиента одновременно', s => s.clients >= 2],
    ['owl', 'moon', 'Полуночник', 'Играть между полуночью и пятью утра', s => s.clients >= 1 && s.night],
    ['architect', 'grid', 'Зодчий', 'Собрать десять сборок', s => s.builds >= 10],
    ['polyglot', 'globe', 'Полиглот', 'Завести сборки на Fabric, Forge и NeoForge', s => s.loaders >= 3],
    ['old-school', 'save', 'Олдскул', 'Создать сборку на Minecraft 1.12.2 или ещё старше', s => s.oldSchool],
    ['devoted', 'bolt', 'Преданный', 'Запустить игру пятьдесят раз', s => s.launches >= 50],
    ['marathon', 'coffee', 'Марафонец', 'Играть три часа без перерыва', s => s.session >= 3 * hour],
    ['trio', 'heart', 'Трое в лодке', 'Запустить три клиента одновременно', s => s.clients >= 3],
    ['lan', 'link', 'Свои люди', 'Играть, пока работает свой сервер', s => s.server && s.clients >= 1],
    ['worldmaker', 'leaf', 'Создатель миров', 'Сохранить пять миров в одной сборке', s => s.worlds >= 5],
    ['modpacker', 'cpu', 'Модпакер', 'Включить двадцать пять модов в одной сборке', s => s.mods >= 25],
    ['trick-or-treat', 'candy', 'Сладость или гадость', 'Поиграть в сезон Хеллоуина — с 15 октября по 2 ноября', s => s.halloween && s.clients >= 1],
    ['konami', 'gamepad', 'Тридцать жизней', 'Ввести код Konami', null, 'Код из эпохи картриджей'],
    ['debug', 'terminal', 'Всё знает F3', 'Открыть экран отладки', null, 'Одна клавиша знает всё — совсем как в игре'],
    ['snake', 'snake', 'Ссссс…', 'Найти спрятанную змейку', null, 'Кое-что ползучее можно просто набрать на клавиатуре'],
    ['snake-10', 'apple', 'Длинный хвост', 'Съесть в змейке десять яблок', null, 'Сначала найдите змейку'],
    ['snake-30', 'crown', 'Анаконда', 'Съесть в змейке тридцать яблок', null, 'Змейка очень любит яблоки'],
    ['woodpecker', 'eye', 'Дятел', 'Постучать по логотипу десять раз', null, 'Логотип любит внимание'],
    ['chatterbox', 'volume', 'Болтун', 'Перелистать пятнадцать фраз на главной', null, 'Фразы на главной не заканчиваются'],
    ['creeper', 'creeper', 'Показалось', 'Нажать на крипера в приветствии', null, 'Кто-то шипит рядом с приветствием'],
    ['ghostbuster', 'ghost', 'Охотник за привидениями', 'Поймать призрака', null, 'В праздничные ночи по лаунчеру кто-то летает'],
    ['pumpkin', 'pumpkin', 'Тыквоголовый', 'Нажать на часы в Хеллоуин', null, 'Часы ведут себя странно в конце октября'],
    ['new-year', 'spark', 'С Новым годом!', 'Нажать на часы в новогоднюю ночь', null, 'Загляните в часы, когда всё в огоньках'],
  ];
  const requested = new Set(), queue = [], seen = { worlds: 0, mods: 0 };
  let unlocking = false, showing = false;
  function summary() {
    const items = data.instances, clients = data.runningClients || [];
    return {
      builds: items.length, modded: items.some(item => item.loader !== 'vanilla'), launches: items.reduce((sum, item) => sum + (item.launchCount || 0), 0), played: totalPlayed(),
      favorite: items.some(item => item.favorite), note: items.some(item => item.note), cover: items.some(item => item.coverFile),
      server: data.server?.status === 'ready', clients: clients.length, night: new Date().getHours() < 5,
      loaders: new Set(items.map(item => item.loader).filter(loader => loader !== 'vanilla')).size,
      oldSchool: items.some(item => { const match = /^1\.(\d+)(?:\.|$)/.exec(item.minecraftVersion || ''); return match && Number(match[1]) <= 12; }),
      session: Math.max(0, ...clients.map(run => Date.now() - run.startedAt)), worlds: seen.worlds, mods: seen.mods,
      halloween: Boolean(window.veyraHalloween?.inSeason()),
    };
  }
  // Пасхалки открывают свои достижения сами; уже полученное повторно не засчитывается.
  function unlock(id) {
    const trophy = trophies.find(([key]) => key === id);
    if (!trophy || data?.achievements?.[id] || requested.has(id)) return false;
    requested.add(id);
    api.unlockAchievements([id]).then(() => { queue.push(trophy); announce(); }, () => requested.delete(id));
    return true;
  }
  window.veyraTrophy = unlock;
  async function checkTrophies() {
    if (unlocking) return;
    const state = summary(), earned = trophies.filter(([id, , , , test]) => test && !data.achievements?.[id] && !requested.has(id) && test(state));
    if (!earned.length) return;
    unlocking = true;
    for (const [id] of earned) requested.add(id);
    try {
      await api.unlockAchievements(earned.map(([id]) => id));
      queue.push(...earned);
      announce();
    } catch { for (const [id] of earned) requested.delete(id); }
    finally { unlocking = false; }
  }
  // Выключенные достижения продолжают копиться, но раздел, слот хотбара и уведомления скрыты.
  function renderTrophyAccess() {
    const shown = pref('trophies', true), slot = document.querySelector('.rail-button[data-view="trophies"]');
    if (!shown && !el('trophies-page').hidden) document.querySelector('.rail-button[data-view="home"]').click();
    slot.hidden = !shown;
    for (const [index, button] of [...document.querySelectorAll('.rail-nav .rail-button:not([hidden])')].entries()) {
      button.querySelector('kbd').textContent = index + 1;
      button.dataset.tipLore = 'Клавиша ' + (index + 1);
    }
    el('rail-nav').style.setProperty('--nav-x', (document.querySelector('.rail-button.is-active')?.offsetLeft || 0) + 'px');
    if (!shown) { queue.length = 0; el('advancement').hidden = true; }
  }
  function announce() {
    if (!pref('trophies', true)) { queue.length = 0; return; }
    if (showing || !queue.length) return;
    const [, glyph, title] = queue.shift(), toast = el('advancement'), rest = queue.length;
    showing = true;
    el('advancement-icon').setAttribute('href', '#i-' + glyph);
    el('advancement-title').textContent = rest > 2 ? title + ' и ещё ' + queue.splice(0).length : title;
    toast.classList.remove('is-leaving'); toast.hidden = false;
    setTimeout(() => {
      toast.classList.add('is-leaving');
      setTimeout(() => { toast.hidden = true; showing = false; announce(); }, calm() ? 0 : 340);
    }, 3600);
  }
  function duration(ms) { const minutes = Math.floor(ms / 60000); return minutes >= 60 ? Math.floor(minutes / 60) + ' ч ' + minutes % 60 + ' мин' : minutes + ' мин'; }
  function renderTrophies() {
    if (!data || el('trophies-page').hidden) return;
    const items = data.instances, state = summary(), earned = data.achievements || {};
    el('stats-name').textContent = data.account.name;
    const first = items.map(item => Date.parse(item.createdAt)).filter(Number.isFinite).sort((a, b) => a - b)[0];
    el('stats-since').textContent = first ? 'В игре с ' + new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(first)) : 'История начинается сегодня';
    el('stats-playtime').textContent = duration(state.played);
    el('stats-launches').textContent = state.launches;
    el('stats-builds').textContent = state.builds;
    const ranked = [...items].sort((a, b) => (b.playedMs || 0) - (a.playedMs || 0)), top = ranked[0];
    el('stats-favorite').textContent = top?.playedMs ? top.name : '—';
    el('stats-favorite').title = top?.playedMs ? top.name : '';
    const bars = ranked.filter(item => item.playedMs >= 60000).slice(0, 8), peak = bars[0]?.playedMs || 1;
    el('stats-bars').replaceChildren(...bars.map(item => {
      const row = node('div', 'stat-bar accent-' + item.accent), labels = node('div'), track = node('i'), fill = node('i');
      labels.append(node('span', '', item.name), node('b', '', duration(item.playedMs)));
      fill.style.width = Math.max(2, item.playedMs / peak * 100) + '%'; track.append(fill); row.append(labels, track);
      return row;
    }));
    if (!bars.length) el('stats-bars').append(node('p', 'stat-empty', 'Сыграйте хотя бы минуту — здесь появятся полосы времени по каждой сборке.'));
    el('trophy-count').textContent = trophies.filter(([id]) => earned[id]).length + ' из ' + trophies.length;
    el('trophy-grid').replaceChildren(...trophies.map(([id, glyph, title, description, , hint]) => {
      const secret = Boolean(hint) && !earned[id];
      const card = node('article', 'trophy' + (earned[id] ? ' is-unlocked' : '') + (secret ? ' is-secret' : '')), frame = node('span', 'trophy-frame'), copy = node('div');
      frame.append(icon(earned[id] ? glyph : 'lock'));
      const date = earned[id] && Number.isFinite(Date.parse(earned[id])) ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(earned[id])) : '';
      copy.append(node('strong', '', secret ? '???' : title), node('small', '', earned[id] ? 'Получено ' + date : secret ? 'Секретное достижение' : description));
      card.dataset.tip = secret ? 'Секретное достижение' : title;
      card.dataset.tipLore = secret ? hint : description + (earned[id] ? '\nПолучено ' + date : '\nЕщё не открыто');
      card.append(frame, copy);
      return card;
    }));
  }

  // ── Миры выбранной сборки на главной ──
  let worldsKey = '', worldsRequest = 0;
  const openContent = (id, kind) => window.dispatchEvent(new CustomEvent('veyra:content-open', { detail: { id, kind } }));
  async function renderWorlds(force = false) {
    if (!data) return;
    const id = data.settings.selectedInstanceId, item = data.instances.find(entry => entry.id === id);
    // Список перечитывается при смене сборки и после завершения игры или установки.
    const key = id + '|' + (data.runningClients || []).length + '|' + Boolean(data.operation);
    if (!force && key === worldsKey) return;
    worldsKey = key;
    const list = el('home-worlds'), request = ++worldsRequest;
    el('worlds-open').hidden = !item;
    if (!item) { el('worlds-summary').textContent = 'Сохранения сборки'; list.textContent = 'Создайте сборку — здесь появятся её миры.'; return; }
    try {
      const [saves, mods] = await Promise.all([api.getContent(id, 'saves'), api.getContent(id, 'mods')]);
      if (request !== worldsRequest) return;
      const worlds = saves.entries.sort((a, b) => b.modifiedAt - a.modifiedAt), count = worlds.length;
      seen.worlds = Math.max(seen.worlds, count); seen.mods = Math.max(seen.mods, mods.counts.enabled);
      checkTrophies();
      const word = count % 10 === 1 && count % 100 !== 11 ? 'мир' : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'мира' : 'миров';
      el('worlds-summary').textContent = count + ' ' + word + ' · модов включено: ' + mods.counts.enabled;
      list.replaceChildren(...worlds.slice(0, 3).map(world => {
        const row = node('button', 'world-row'), copy = node('div');
        row.type = 'button'; row.dataset.tip = world.title; row.dataset.tipLore = 'Открыть сохранения сборки';
        copy.append(node('strong', '', world.title), node('small', '', new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(world.modifiedAt))));
        row.append(node('i'), copy);
        row.addEventListener('click', () => openContent(id, 'saves'));
        return row;
      }));
      if (!count) list.textContent = 'Миров пока нет. Первый появится после игры.';
    } catch { if (request === worldsRequest) list.textContent = 'Не удалось прочитать сохранения сборки.'; }
  }
  el('worlds-open').addEventListener('click', () => { if (data?.settings.selectedInstanceId) openContent(data.settings.selectedInstanceId); });

  // ── Звуки интерфейса: короткий синтезированный щелчок, выключен по умолчанию ──
  let audio = null;
  document.addEventListener('pointerdown', event => {
    if (!pref('sounds', false) || !event.target.closest?.('button:not(:disabled), .toggle-row, .switch-field')) return;
    try {
      audio ||= new AudioContext();
      const start = audio.currentTime, wave = audio.createOscillator(), gain = audio.createGain();
      wave.type = 'square'; wave.frequency.setValueAtTime(240, start); wave.frequency.exponentialRampToValueAtTime(120, start + .05);
      gain.gain.setValueAtTime(.04, start); gain.gain.exponentialRampToValueAtTime(.0001, start + .07);
      wave.connect(gain).connect(audio.destination); wave.start(start); wave.stop(start + .08);
    } catch { /* без звукового устройства интерфейс остаётся беззвучным */ }
  }, true);
  el('ui-sounds').checked = pref('sounds', false);
  el('ui-splash').checked = pref('splash', true);
  el('ui-sounds').addEventListener('change', event => savePref('sounds', event.target.checked));
  el('ui-splash').addEventListener('change', event => setSplash(event.target.checked));
  el('ui-trophies').checked = pref('trophies', true);
  el('ui-trophies').addEventListener('change', event => { savePref('trophies', event.target.checked); renderTrophyAccess(); });
  renderTrophyAccess();

  // ── Заставка: держится, пока лаунчер не готов (но не меньше 0,4 с, чтобы не мелькать), затем каркас собирается из панелей ──
  const intro = el('intro'), opened = performance.now();
  let closed = false;
  function closeIntro() {
    if (closed) return;
    closed = true;
    if (calm()) { intro.hidden = true; return; }
    setTimeout(() => {
      intro.classList.add('is-done');
      document.body.classList.add('is-booting');
      setTimeout(() => { intro.hidden = true; }, 260);
      setTimeout(() => document.body.classList.remove('is-booting'), 900);
    }, Math.max(0, 400 - (performance.now() - opened)));
  }
  if (window.veyraReady) closeIntro(); else window.addEventListener('veyra:ready', closeIntro);
  setTimeout(closeIntro, 6000);

  function render() {
    if (!data) return;
    renderHeads(); renderXp(); renderTrophies(); renderWorlds(); checkTrophies();
  }
  api.onEvent(event => {
    if (event.type === 'state') { data = event.state; render(); }
    if (event.type === 'progress' && data?.operation) renderXp(event);
    if (event.type === 'content-changed') renderWorlds(true);
  });
  window.addEventListener('veyra:view', event => { if (event.detail.view === 'trophies') renderTrophies(); if (event.detail.view === 'home') renderWorlds(true); });
  window.addEventListener('veyra:halloween', () => { phrase = -1; renderSplash(); });
  api.getState().then(state => { data ||= state; render(); }).catch(() => {});
  renderSplash(); renderClock();
  setInterval(() => { renderClock(); renderXp(); }, 5000);
})();
