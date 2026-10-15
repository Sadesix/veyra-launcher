(() => {
  'use strict';
  const api = window.launcher, el = id => document.getElementById(id);
  const loaderNames = { vanilla: 'Vanilla', fabric: 'Fabric', neoforge: 'NeoForge', forge: 'Forge' };
  const defaults = { levelName: 'world', seed: '', gamemode: 'survival', difficulty: 'normal', hardcore: false, allowFlight: false, maxPlayers: 8, viewDistance: 10, motd: '', port: 25565, memoryGb: null, veyraLogin: false };
  const statusNames = { preparing: 'Подготовка', starting: 'Запускается', ready: 'Готов', stopping: 'Сохраняем и останавливаем', stopped: 'Остановлен', error: 'Ошибка' };
  let data, id = '', busy = false, forceArmed = false, config = { ...defaults }, loading = 0, history = [], historyIndex = 0, logText = null;
  const clean = text => String(text || '').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  const active = server => Boolean(server && ['preparing', 'starting', 'ready', 'stopping'].includes(server.status));
  const build = () => data?.instances.find(item => item.id === id);
  const node = (tag, className, text) => { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; };
  const error = text => { el('sessions-error').textContent = clean(text); el('sessions-error').hidden = !text; };
  const span = ms => { const minutes = Math.floor(Math.max(0, ms) / 60000); return minutes >= 60 ? Math.floor(minutes / 60) + ' ч ' + minutes % 60 + ' мин' : minutes + ' мин'; };
  async function act(callback) {
    busy = true; error(''); render();
    try { const result = await callback(); data = await api.getState(); return result; }
    catch (failure) { error(failure.message); }
    finally { busy = false; render(); }
  }

  // Работающий сервер закрепляет страницу за своей сборкой; иначе она следует за выбранной.
  async function sync() {
    if (!data) return;
    const target = active(data.server) ? data.server.instanceId : data.settings.selectedInstanceId;
    if (target === id) return;
    id = target; logText = null;
    const request = ++loading;
    if (!build()) { render(); return; }
    try {
      const [saved, accepted] = await Promise.all([api.getServerConfig(id), api.serverEula(id)]);
      if (request !== loading) return;
      config = { ...defaults, ...saved };
      el('server-eula').checked = accepted;
      fill();
    } catch (failure) { if (request === loading) error(failure.message); }
    render();
  }
  function fill() {
    el('server-level-name').value = config.levelName;
    el('server-seed').value = config.seed;
    el('server-motd').value = config.motd;
    el('server-port').value = config.port;
    el('server-max-players').value = config.maxPlayers;
    el('server-view-distance').value = config.viewDistance;
    el('server-hardcore').checked = config.hardcore;
    el('server-flight').checked = config.allowFlight;
    el('server-veyra-login').checked = config.veyraLogin;
    for (const input of el('server-builder').querySelectorAll('[aria-invalid]')) window.veyraValidation.clear(input);
  }
  function read() {
    return { ...config, levelName: el('server-level-name').value.trim(), seed: el('server-seed').value.trim(), motd: el('server-motd').value.trim(),
      port: Number(el('server-port').value), maxPlayers: Number(el('server-max-players').value), viewDistance: Number(el('server-view-distance').value),
      hardcore: el('server-hardcore').checked, allowFlight: el('server-flight').checked, veyraLogin: el('server-veyra-login').checked };
  }

  function renderBuilds(locked) {
    const target = el('server-builds'), signature = JSON.stringify(data.instances.map(item => [item.id, item.name, item.coverUrl])) + id + locked;
    if (target.dataset.signature === signature) return;
    target.dataset.signature = signature;
    target.replaceChildren(...data.instances.map(item => {
      const chip = node('button', 'builder-build' + (item.id === id ? ' is-selected' : ''));
      chip.type = 'button'; chip.disabled = locked;
      chip.dataset.tip = item.name; chip.dataset.tipLore = loaderNames[item.loader] + ' · Minecraft ' + item.minecraftVersion;
      const art = node('i'); if (item.coverUrl) art.style.backgroundImage = 'url("' + item.coverUrl + '")';
      chip.append(art, node('span', '', item.name));
      chip.addEventListener('click', () => act(() => api.selectInstance(item.id)).then(sync));
      return chip;
    }));
  }
  function renderMemory(item) {
    const target = el('server-memory-blocks'), maximum = Math.min(data.maxMemoryGb, 16);
    const automatic = Math.min(4, item.memoryGb || data.settings.memoryGb);
    if (target.childElementCount !== maximum + 1) {
      const auto = node('button', 'block-auto', 'Авто'); auto.type = 'button';
      auto.addEventListener('click', () => { config.memoryGb = null; render(); });
      target.replaceChildren(auto);
      for (let amount = 1; amount <= maximum; amount++) {
        const block = node('button'); block.type = 'button'; block.dataset.amount = amount;
        block.setAttribute('aria-label', amount + ' ГБ'); block.dataset.tip = amount + ' ГБ';
        block.addEventListener('click', () => { config.memoryGb = amount; render(); });
        target.append(block);
      }
    }
    for (const block of target.children) block.classList.toggle('is-filled', block.dataset.amount ? Number(block.dataset.amount) <= (config.memoryGb || automatic) : config.memoryGb === null);
    el('server-memory-value').textContent = config.memoryGb ? config.memoryGb + ' ГБ' : 'Авто · ' + automatic + ' ГБ';
    el('server-memory-hint').textContent = 'Клиентам и серверу вместе доступно до ' + data.maxMemoryGb + ' ГБ.';
  }
  function renderLog(server, own) {
    const text = own && server?.lines ? server.lines : '';
    if (text === logText) return;
    logText = text;
    const log = el('server-log'), follow = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
    if (!text) { log.textContent = 'Здесь появится вывод сервера.'; return; }
    const fragment = document.createDocumentFragment();
    for (const line of text.split('\n')) {
      const kind = line.startsWith('> ') ? 'command' : /ERROR|FATAL|Exception/.test(line) ? 'error' : /WARN/.test(line) ? 'warn' : /(joined|left) the game$|Done \(/.test(line) ? 'event' : '';
      fragment.append(node('span', kind ? 'log-' + kind : '', line + '\n'));
    }
    log.replaceChildren(fragment);
    if (follow) log.scrollTop = log.scrollHeight;
  }
  function renderPeople(server, own) {
    const players = own && active(server) ? server.players || [] : [];
    el('server-player-count').textContent = players.length;
    const list = el('server-players');
    if (list.dataset.signature !== players.join('\n') + server?.status) {
      list.dataset.signature = players.join('\n') + server?.status;
      list.replaceChildren(...players.map(name => {
        const row = node('div', 'server-player'); const head = node('canvas', 'player-head'); head.width = head.height = 8; window.veyraHead?.(head, name);
        row.append(head, node('strong', '', name));
        if (/^[A-Za-z0-9_]{1,16}$/.test(name)) for (const [glyph, title, command] of [['crown', 'Сделать оператором', 'op '], ['close', 'Отключить от сервера', 'kick ']]) {
          const button = node('button', 'button-icon'); button.type = 'button'; button.dataset.tip = title; button.setAttribute('aria-label', title + ': ' + name);
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.classList.add('icon'); const use = document.createElementNS(svg.namespaceURI, 'use'); use.setAttribute('href', '#i-' + glyph); svg.append(use); button.append(svg);
          button.addEventListener('click', () => act(() => api.sendServerCommand(command + name)));
          row.append(button);
        }
        return row;
      }));
      if (!players.length) list.textContent = server?.status === 'ready' && own ? 'Пока никого. Позовите друзей по адресу выше.' : 'Список появится, когда сервер запустится.';
    }
    const clients = el('sessions-list'), signature = JSON.stringify(data.runningClients) + data.instances.map(item => item.name).join();
    if (clients.dataset.signature === signature) return;
    clients.dataset.signature = signature;
    clients.replaceChildren(...(data.runningClients || []).map(run => {
      const row = node('div', 'client-session'); const head = node('canvas', 'player-head'); head.width = head.height = 8; window.veyraHead?.(head, run.name);
      const text = node('div'); text.append(node('strong', '', run.name), node('small', '', (data.instances.find(item => item.id === run.instanceId)?.name || '') + ' · ' + run.memoryGb + ' ГБ'));
      const stop = node('button', 'text-button', run.stopping ? 'Останавливаем…' : 'Остановить'); stop.type = 'button'; stop.disabled = run.stopping;
      stop.addEventListener('click', () => act(() => api.stopGame(run.id)));
      row.append(head, text, stop); return row;
    }));
    if (!clients.children.length) clients.textContent = 'Клиенты пока не запущены';
  }
  function render() {
    if (!data) return;
    const server = data.server, live = active(server);
    document.querySelector('.rail-button[data-view="server"]').classList.toggle('has-alert', live);
    if (el('server-page').hidden) return;
    const item = build();
    el('server-empty').hidden = Boolean(item);
    el('server-layout').hidden = !item;
    if (!item) { el('server-state').textContent = statusNames.stopped; el('server-lamp').dataset.status = 'stopped'; return; }
    const own = server?.instanceId === id, status = own ? server.status : 'stopped';
    const owner = data.instances.find(entry => entry.id === server?.instanceId);
    el('server-lamp').dataset.status = live ? server.status : status;
    el('server-state').textContent = live && !own ? 'Работает · ' + (owner?.name || '') : statusNames[status] + (status === 'ready' ? ' · ' + item.name : '');
    el('sessions-build').textContent = item.name + ' · Minecraft ' + item.minecraftVersion + ' · ' + loaderNames[item.loader] + '. Отдельная папка и свои сохранения.';

    // Карточка — как запись в списке серверов игры.
    const shown = own && live ? { ...config, ...server.config, port: server.port } : read();
    el('server-card-icon').style.backgroundImage = item.coverUrl ? 'url("' + item.coverUrl + '")' : '';
    el('server-card-name').textContent = item.name;
    el('server-card-motd').textContent = shown.motd || 'A Minecraft Server';
    el('server-card-meta').textContent = loaderNames[item.loader] + ' · Minecraft ' + item.minecraftVersion + ' · мир «' + (shown.levelName || 'world') + '»' + (shown.veyraLogin ? ' · вход через Veyra' : '');
    el('server-card-players').textContent = own && live ? (server.players || []).length : 0;
    el('server-card-max').textContent = shown.maxPlayers || defaults.maxPlayers;
    el('server-ping').dataset.status = status;
    el('server-uptime').textContent = status === 'ready' && server.readyAt ? 'В сети ' + span(Date.now() - server.readyAt) : '';
    const port = shown.port || defaults.port;
    el('server-local-address').textContent = '127.0.0.1:' + port;
    const lan = own && live ? server.addresses || [] : [];
    if (el('server-lan').dataset.signature !== lan.join()) {
      el('server-lan').dataset.signature = lan.join();
      el('server-lan').replaceChildren(...lan.map(address => {
        const chip = node('button', 'server-lan-chip', address); chip.type = 'button'; chip.dataset.tip = 'Скопировать адрес'; chip.dataset.tipLore = 'Для друзей в вашей сети';
        chip.addEventListener('click', () => act(async () => { await api.copyServerAddress(address); chip.textContent = 'Скопировано'; setTimeout(() => { chip.textContent = address; }, 1600); }));
        return chip;
      }));
    }
    el('server-network-addresses').textContent = lan.length ? 'Друзьям в вашей сети подойдёт любой сетевой адрес справа. Вам самим — 127.0.0.1:' + port + '.' : 'Сетевые адреса появятся после запуска. На этом ПК подключайтесь к 127.0.0.1:' + port + '.';

    // Конструктор виден, пока сервер этой сборки не работает.
    el('server-builder').hidden = live;
    renderBuilds(busy || Boolean(data.operation));
    for (const [group, key] of [['server-gamemodes', 'gamemode'], ['server-difficulties', 'difficulty']]) for (const button of el(group).children) {
      const selected = button.dataset[key] === config[key];
      button.classList.toggle('is-selected', selected); button.setAttribute('aria-pressed', String(selected));
    }
    renderMemory(item);
    el('server-view-value').textContent = el('server-view-distance').value + ' чанков';
    const veyraLogin = own && live ? Boolean(server.config?.veyraLogin) : el('server-veyra-login').checked;
    el('server-auth-note').textContent = veyraLogin ? 'Вход через Veyra: зайдут только игроки с аккаунтом Veyra, их скины видны всем. Режим и сложность применяются при запуске.' : 'Локальные ники без проверки аккаунта. Режим и сложность применяются при запуске.';
    el('server-start').disabled = busy || Boolean(data.operation) || !el('server-eula').checked;
    el('server-reset').disabled = busy;

    // Консоль: подготовка, работа и журнал последнего запуска.
    el('server-console').hidden = !(own && (live || server.lines));
    el('server-console-title').textContent = live ? 'Консоль сервера' : 'Журнал последнего запуска';
    el('server-stop').hidden = !own || !server?.pid || !live || server.status === 'preparing'; el('server-stop').disabled = server?.status === 'stopping';
    el('server-force').hidden = !own || server?.status !== 'stopping';
    el('server-cancel').hidden = data.operation?.type !== 'server';
    el('server-join').hidden = !own || server?.status !== 'ready'; el('server-join').disabled = busy || Boolean(data.operation);
    // Сервер со входом через Veyra пускает только аккаунты Veyra: подсказка заранее говорит, с каким профилем зайдёт клиент.
    const veyraOnly = Boolean(own && live && server.config?.veyraLogin);
    el('server-join').dataset.tip = veyraOnly ? 'Вход через Veyra' : 'Клиент → сервер';
    el('server-join').dataset.tipLore = veyraOnly ? (data.account.mode === 'veyra' ? 'Зайдёт аккаунт ' + data.account.name : 'Сначала выберите аккаунт Veyra в профиле') : 'Ещё один клиент сразу подключится к серверу';
    const commands = own && ['starting', 'ready'].includes(server?.status);
    el('server-command-form').hidden = el('server-quick').hidden = !(own && live);
    el('server-command').disabled = el('server-command-send').disabled = !commands;
    for (const button of el('server-quick').children) button.disabled = !commands || busy;
    // Аккаунт Veyra играет только в одном клиенте: дополнительные клиенты — с локальным ником.
    const veyraMode = data.account.mode === 'veyra', veyraBusy = veyraMode && data.account.veyraPlaying;
    el('sessions-add').disabled = busy || Boolean(data.operation) || !item.installed || veyraBusy;
    if (veyraBusy) { el('sessions-add').dataset.tip = 'Аккаунт Veyra уже в игре'; el('sessions-add').dataset.tipLore = 'Для второго клиента выберите в профиле локальный ник'; }
    else { delete el('sessions-add').dataset.tip; delete el('sessions-add').dataset.tipLore; }
    el('sessions-note').textContent = veyraMode ? 'Аккаунт Veyra играет только в одном клиенте. Для дополнительных клиентов выберите в профиле локальный ник.' : 'Дополнительные клиенты получают отдельные папки и разные локальные ники.';
    renderLog(server, own);
    renderPeople(server, own);
    el('server-skipped').hidden = !own || !server?.skipped?.length;
    el('server-skipped-title').textContent = 'Пропущено модов: ' + (server?.skipped?.length || 0);
    el('server-skipped-list').replaceChildren(...(own ? server?.skipped || [] : []).map(entry => node('li', '', entry.name + ' — ' + entry.reason)));
    if (own && server?.error && !busy) error(server.error);
  }

  async function show() { data = await api.getState(); await sync(); render(); }
  el('hero-server').addEventListener('click', () => document.querySelector('.rail-button[data-view="server"]').click());
  el('server-create-build').addEventListener('click', () => el('create-top').click());
  // Сначала показываем уже известное состояние, затем сверяемся с главным процессом.
  window.addEventListener('veyra:view', event => { if (event.detail.view === 'server') { render(); show().catch(failure => error(failure.message)); } });
  el('server-builder').addEventListener('input', render);
  el('server-builder').addEventListener('submit', event => event.preventDefault());
  for (const [group, key] of [['server-gamemodes', 'gamemode'], ['server-difficulties', 'difficulty']]) for (const button of el(group).children) {
    button.addEventListener('click', () => { config[key] = button.dataset[key]; render(); });
  }
  el('server-reset').addEventListener('click', () => { config = { ...defaults }; fill(); render(); });
  el('server-eula').addEventListener('change', render);
  el('server-eula-link').addEventListener('click', event => { event.preventDefault(); act(() => api.openServerEula()); });
  el('server-start').addEventListener('click', () => {
    if (!window.veyraValidation.validate(el('server-builder'))) return;
    act(async () => { config = { ...defaults, ...await api.saveServerConfig(id, read()) }; return api.startServer(id, el('server-eula').checked); });
  });
  el('server-stop').addEventListener('click', async () => { const stopped = await act(() => api.stopServer()); if (stopped === false) error('Сервер не ответил на stop. Принудительная остановка может повредить сохранения.'); });
  el('server-force').addEventListener('click', () => {
    if (!forceArmed) { forceArmed = true; el('server-force').textContent = 'Подтвердить завершение'; error('Несохранённые изменения могут потеряться. Нажмите ещё раз для подтверждения.'); setTimeout(() => { forceArmed = false; el('server-force').textContent = 'Принудительно'; }, 5000); return; }
    forceArmed = false; act(() => api.stopServer(true));
  });
  el('server-cancel').addEventListener('click', () => api.cancelOperation());
  el('sessions-add').addEventListener('click', () => act(() => api.launchInstance(id)));
  el('server-join').addEventListener('click', () => act(() => api.launchInstance(id, true)));
  el('server-copy').addEventListener('click', () => act(async () => { await api.copyServerAddress(); el('server-copy').textContent = 'Скопировано'; setTimeout(() => { el('server-copy').textContent = 'Копировать'; }, 1800); }));
  el('server-folder').addEventListener('click', () => act(() => api.openServerFolder(id)));
  // Командная строка сервера с историей по стрелкам.
  el('server-command-form').addEventListener('submit', async event => {
    event.preventDefault();
    const text = el('server-command').value.trim();
    if (!text) return;
    history = [...history.filter(entry => entry !== text), text].slice(-30); historyIndex = history.length;
    el('server-command').value = '';
    await act(() => api.sendServerCommand(text));
    el('server-command').focus();
  });
  el('server-command').addEventListener('keydown', event => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    historyIndex = Math.max(0, Math.min(history.length, historyIndex + (event.key === 'ArrowUp' ? -1 : 1)));
    el('server-command').value = history[historyIndex] || '';
  });
  for (const button of el('server-quick').children) button.addEventListener('click', () => act(() => api.sendServerCommand(button.dataset.command)));
  api.onEvent(event => { if (event.type === 'state') { data = event.state; sync().then(render); } });
  api.getState().then(state => { data = state; return sync(); }).then(render).catch(() => {});
  setInterval(() => { if (!el('server-page').hidden && data?.server?.status === 'ready') render(); }, 30000);
})();
