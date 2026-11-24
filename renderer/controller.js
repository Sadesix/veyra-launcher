(() => {
  'use strict';
  const api = window.launcher;
  const el = id => document.getElementById('controller-' + id);
  const panel = el('panel');
  const labels = { ready: 'Работает', starting: 'Запускается', stopping: 'Останавливается', stopped: 'Остановлен', error: 'Ошибка' };
  const loaders = { vanilla: 'Vanilla', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' };
  const size = bytes => (bytes / 1024 ** 3).toLocaleString('ru', { maximumFractionDigits: 1 });
  const formatAddress = (host, port) => (host.includes(':') ? '[' + host + ']' : host) + ':' + port;
  const versionPattern = /^(?:1\.(?:[89]|[1-9][0-9])(?:\.\d+)?|[2-9]\d\.\d+(?:\.\d+)?)$/;
  const hosts = { list: [], selected: '', connected: '' };
  const rows = new Map();
  let snapshot, worldId = '', busy = false, refreshing = false, degraded = false, logText = '', lastLogWorld = '', connectionRevision = 0;
  let keyFile = '', trust = '', copyTimer;
  let builds = [], buildScan = 0, autoName = '';
  const world = () => snapshot?.worlds.find(item => item.id === worldId);
  const visible = () => !panel.hidden && !document.getElementById('server-page').hidden && !document.hidden;
  const workspace = window.veyraControllerWorkspace({
    context: () => ({ host: hosts.connected, world: world(), busy, degraded, ram: snapshot?.vm.ramTotal || 0 }),
    task, message,
    reload: async selected => {
      const result = await api.controllerSnapshot(hosts.connected, selected || worldId);
      if (selected) worldId = selected;
      apply(result);
    },
  });

  function message(target, text = '') {
    const node = el(target);
    node.textContent = String(text || '').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
    node.hidden = !text;
  }

  function mode(remote) {
    panel.hidden = !remote;
    document.getElementById('server-local').hidden = remote;
    for (const [name, active] of [['local', !remote], ['controller', remote]]) {
      const button = document.getElementById('server-mode-' + name);
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    if (remote) {
      syncHosts().catch(error => message('error', error.message));
      refresh();
    }
  }

  function status() {
    const connecting = busy && !hosts.connected;
    const state = connecting ? 'busy' : degraded ? 'error' : hosts.connected ? 'connected' : 'idle';
    el('link').dataset.state = state;
    const text = { busy: 'Подключаемся по SSH…', connected: 'SSH подключён', idle: 'Нет подключения', error: 'Связь потеряна' }[state];
    if (el('link-text').textContent !== text) el('link-text').textContent = text;
  }

  function updateHosts() {
    const select = el('host-select');
    select.replaceChildren(...(hosts.list.length ? hosts.list.map(host => new Option(host.name + (host.name === host.host ? '' : ' · ' + host.host), host.id)) :
      [new Option('Нет сохранённых ВМ', '')]));
    if (!hosts.list.some(host => host.id === hosts.selected)) hosts.selected = hosts.list[0]?.id || '';
    select.value = hosts.selected;
    render();
  }

  async function syncHosts() {
    hosts.list = await api.controllerList();
    updateHosts();
  }

  function selectWorld(id) {
    if (busy) return;
    worldId = id;
    el('command').value = '';
    render();
    refresh();
  }

  function updateWorlds() {
    const container = el('worlds');
    const present = new Set();
    let index = 0;
    for (const item of snapshot.worlds) {
      present.add(item.id);
      if (!rows.has(item.id)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'controller-world';
        const light = document.createElement('i');
        light.className = 'controller-world-light';
        const copy = document.createElement('span');
        copy.className = 'controller-world-info';
        const title = document.createElement('strong'), subtitle = document.createElement('small');
        const port = document.createElement('span');
        port.className = 'controller-world-port';
        copy.append(title, subtitle);
        button.append(light, copy, port);
        button.addEventListener('click', () => selectWorld(item.id));
        rows.set(item.id, { button, title, subtitle, port });
      }
      const { button, title, subtitle, port } = rows.get(item.id);
      button.dataset.status = item.status;
      button.setAttribute('aria-pressed', String(item.id === worldId));
      title.textContent = item.name;
      title.title = item.name;
      subtitle.textContent = (loaders[item.loader] || 'Vanilla') + ' ' + item.minecraftVersion + ' · ' + labels[item.status];
      port.textContent = ':' + item.port;
      if (container.children[index] !== button) container.insertBefore(button, container.children[index] || null);
      index++;
    }
    for (const [id, row] of rows) {
      if (present.has(id)) continue;
      row.button.remove();
      rows.delete(id);
    }
    el('count').textContent = snapshot.worlds.length;
    el('no-worlds').hidden = snapshot.worlds.length > 0;
    el('server-grid').hidden = snapshot.worlds.length === 0;
  }

  function renderLog(item, details) {
    const text = details?.logs || (details ? 'Вывод появится после запуска мира.' : 'Загружаем журнал…');
    if (text === logText && lastLogWorld === item.id) return;
    const log = el('log');
    const follow = lastLogWorld !== item.id || log.scrollHeight - log.scrollTop - log.clientHeight < 35;
    logText = text;
    lastLogWorld = item.id;
    log.textContent = text;
    if (follow) log.scrollTop = log.scrollHeight;
  }

  function render() {
    status();
    el('overview').hidden = !hosts.list.length;
    el('overview').classList.toggle('has-resources', Boolean(snapshot));
    el('resources').hidden = !snapshot;
    el('add-host').disabled = busy;
    el('share-open').disabled = busy;
    el('add-host').classList.toggle('button-primary', hosts.list.length === 0);
    el('add-host').classList.toggle('button-secondary', hosts.list.length > 0);
    el('host-select').disabled = busy || !hosts.list.length;
    el('attach').disabled = busy || !hosts.selected;
    el('attach').textContent = hosts.connected ? (degraded ? 'Переподключить' : 'Отключиться') : 'Подключиться';
    el('attach').classList.toggle('button-primary', !hosts.connected || degraded);
    el('attach').classList.toggle('button-secondary', Boolean(hosts.connected) && !degraded);
    el('forget').hidden = !hosts.selected || Boolean(hosts.connected);
    el('forget').disabled = busy;
    el('empty').hidden = Boolean(snapshot);
    el('empty-note').textContent = hosts.list.length ?
      'Выберите сохранённую ВМ, чтобы открыть её серверы.' :
      'Укажите адрес и данные SSH. Veyra установит контроллер на вашу ВМ.';
    el('dashboard').hidden = !snapshot;
    workspace.render();
    if (!snapshot) return;
    const vm = snapshot.vm;
    el('load').textContent = vm.load.toLocaleString('ru') + ' / ' + vm.cpuCount;
    for (const [name, used, total] of [['load', vm.load, vm.cpuCount], ['ram', vm.ramUsed, vm.ramTotal], ['disk', vm.diskUsed, vm.diskTotal]]) {
      if (name !== 'load') el(name).textContent = size(used) + ' / ' + size(total) + ' ГБ';
      const meter = el(name + '-meter');
      meter.max = total;
      meter.high = total * 0.85;
      meter.value = Math.min(used, total);
    }
    el('create').disabled = el('create-first').disabled = busy || degraded;
    updateWorlds();
    const item = world();
    el('detail').hidden = !item;
    if (!item) return;
    const ready = item.status === 'ready';
    const details = snapshot.details?.id === item.id ? snapshot.details : null;
    el('world-title').textContent = item.name;
    el('world-meta').textContent = (loaders[item.loader] || 'Vanilla') + ' ' + item.minecraftVersion +
      (item.loaderVersion ? ' · ' + item.loaderVersion : '') + (item.modCount ? ' · Модов ' + item.modCount : '') +
      ' · ' + item.memoryGb + ' ГБ · ' + (item.veyraLogin ? 'Вход Veyra' : 'Локальные ники');
    el('address').textContent = formatAddress(hosts.list.find(host => host.id === hosts.connected).host, item.port);
    el('world-status').dataset.status = degraded ? 'stopped' : item.status;
    el('world-status').lastElementChild.textContent = degraded ? 'Нет свежих данных' : labels[item.status];
    el('players').textContent = Number.isInteger(details?.players) && !degraded ? 'Игроки ' + details.players + ' / ' + item.maxPlayers : '';
    el('power').checked = ready || item.status === 'starting';
    el('power').disabled = busy || degraded || item.status === 'stopping';
    el('power-label').textContent = ready || item.status === 'starting' ? 'Сервер включён' : item.status === 'stopping' ? 'Останавливается…' : 'Сервер выключен';
    el('restart').hidden = el('join').hidden = !ready;
    for (const name of ['restart', 'copy', 'join', 'sync-build']) el(name).disabled = busy || degraded;
    el('command').disabled = el('send').disabled = degraded || !ready;
    el('send').disabled ||= busy;
    renderLog(item, details);
  }

  function apply(result) {
    snapshot = result;
    if (!world()) worldId = result.details?.id || result.worlds[0]?.id || '';
    degraded = false;
  }

  function resetConnection() {
    const id = hosts.connected;
    connectionRevision++;
    hosts.connected = '';
    snapshot = null;
    worldId = '';
    degraded = false;
    if (id) api.controllerClose(id).catch(() => {});
  }

  async function refresh() {
    if (!visible() || !hosts.connected || refreshing || busy || degraded) return;
    const id = hosts.connected, selected = worldId, revision = connectionRevision;
    refreshing = true;
    try {
      const result = await api.controllerSnapshot(id, selected);
      if (connectionRevision === revision && worldId === selected && !busy) apply(result);
    } catch (error) {
      if (connectionRevision === revision && !busy) {
        degraded = true;
        message('error', error.message);
      }
    } finally {
      refreshing = false;
      render();
    }
  }

  function disconnect() {
    resetConnection();
    message('error');
    render();
  }

  async function task(callback, location = 'error') {
    if (busy) return;
    busy = true;
    message(location);
    render();
    try { return await callback(); }
    catch (error) { message(location, error.message); }
    finally {
      busy = false;
      for (const dialog of [el('host-dialog'), el('world-dialog')]) if (dialog.open) setDialogBusy(dialog, false);
      render();
    }
  }

  function setDialogBusy(dialog, value) {
    for (const button of dialog.querySelectorAll('button')) button.disabled = value;
  }

  function keySelection(file) {
    keyFile = file;
    el('password-field').hidden = Boolean(file);
    el('host-password').required = !file;
    el('host-password').value = '';
    el('passphrase-field').hidden = !file;
    el('host-passphrase').value = '';
    el('key-clear').hidden = !file;
    el('key-name').textContent = file.split(/[\\/]/).pop();
  }

  function trustStep(result) {
    trust = result?.token || '';
    el('host-fields').hidden = Boolean(trust);
    el('trust').hidden = !trust;
    el('fingerprint').textContent = result?.fingerprint || '';
    el('host-submit').textContent = trust ? 'Доверять и установить' : 'Подключиться';
  }

  function hostForm() {
    el('host-form').reset();
    keySelection('');
    trustStep();
    message('host-error');
    el('host-dialog').showModal();
    el('host-address').focus();
  }

  function hostValues() {
    return { name: el('host-name').value, host: el('host-address').value, username: el('host-user').value,
      port: Number(el('host-port').value), password: el('host-password').value, keyFile, passphrase: el('host-passphrase').value };
  }

  function freePort() {
    const used = new Set(snapshot.worlds.map(item => item.port));
    for (let port = 25565; port <= 65535; port++) if (!used.has(port)) return port;
    for (let port = 1024; port < 25565; port++) if (!used.has(port)) return port;
    return 25565;
  }

  function authHint() {
    el('auth-hint').textContent = el('world-auth').checked ? '' : 'Локальный ник доступен без проверки аккаунта. Используйте этот режим для закрытых игр.';
    el('auth-hint').hidden = !el('auth-hint').textContent;
  }

  async function selectBuild() {
    const request = ++buildScan;
    const build = builds.find(item => item.id === el('build-select').value);
    el('version-field').hidden = Boolean(build);
    el('world-version').required = !build;
    el('build-content').hidden = !build;
    el('save-field').hidden = el('mods').hidden = true;
    el('build-online-field').hidden = el('build-all-field').hidden = true;
    el('mods').open = false;
    el('mods-list').replaceChildren();
    el('save-select').replaceChildren(new Option('Создать новый мир', ''));
    message('world-error');
    if (!build) {
      el('world-submit').disabled = !el('world-version').options.length;
      if (el('world-submit').disabled) {
        try {
          await api.refreshVersions();
          const data = await api.getState();
          if (request !== buildScan || !el('world-dialog').open) return;
          fillVersions(data.versions);
          if (!el('world-version').options.length) throw new Error('Список Minecraft недоступен');
          el('world-submit').disabled = false;
        } catch (error) { if (request === buildScan) message('world-error', error.message); }
      }
      return;
    }
    const name = el('world-name');
    if (!name.value || name.value === autoName) name.value = autoName = build.name;
    el('world-submit').disabled = true;
    el('build-hint').textContent = 'Проверяем моды и сохранения…';
    try {
      const result = await api.controllerInspectBuild(build.id, el('build-online').checked);
      if (request !== buildScan || !el('world-dialog').open) return;
      el('build-hint').textContent = (loaders[build.loader] || build.loader) + ' ' + build.minecraftVersion +
        (build.loaderVersion ? ' · ' + build.loaderVersion : '') + '. Конфиги будут скопированы на ВМ.';
      for (const name of result.worlds) el('save-select').add(new Option(name, name));
      el('save-field').hidden = !result.worlds.length;
      el('mods').hidden = !result.mods.length;
      el('build-online-field').hidden = !result.mods.length;
      el('build-all-field').hidden = !result.mods.some(mod => mod.supported && !mod.verified);
      const refreshCount = () => {
        const checked = el('mods-list').querySelectorAll('input:checked').length;
        el('mods-title').textContent = 'Моды для сервера · ' + checked + ' из ' + result.mods.length;
      };
      for (const mod of result.mods) {
        const note = !mod.supported ? 'Только для клиента' : !mod.verified ? 'Совместимость неизвестна · можно выбрать вручную' : '';
        const { input, label } = window.veyraControllerSwitch(mod.name, note);
        const unknown = mod.supported && !mod.verified;
        if (unknown) input.dataset.unknown = '';
        input.value = mod.name; input.disabled = !mod.supported; input.checked = mod.verified || (unknown && el('build-all').checked);
        input.addEventListener('change', refreshCount);
        el('mods-list').append(label);
      }
      refreshCount();
      el('world-submit').disabled = false;
    } catch (error) {
      if (request === buildScan) {
        el('build-hint').textContent = '';
        message('world-error', error.message);
      }
    }
  }

  function fillVersions(versions) {
    el('world-version').replaceChildren(...versions.filter(item => item.type === 'release' && versionPattern.test(item.id))
      .map(item => new Option(item.id, item.id)));
  }

  async function worldForm() {
    const form = el('world-form');
    form.reset();
    buildScan++;
    autoName = '';
    el('world-port').value = freePort();
    const maxMemory = Math.max(1, Math.floor(snapshot.vm.ramTotal / 1024 ** 3));
    el('world-memory').max = maxMemory;
    el('world-memory').value = Math.min(2, maxMemory);
    el('world-limit').value = 8;
    el('world-auth').checked = true;
    el('build-content').hidden = true;
    el('world-version').required = false;
    const data = await api.getState();
    builds = data.instances.filter(build => build.installed);
    const picker = el('build-select');
    picker.replaceChildren(new Option('Новая Vanilla', ''), ...builds.map(build =>
      new Option(build.name + ' · ' + loaders[build.loader] + ' ' + build.minecraftVersion, build.id)));
    picker.value = builds.some(build => build.id === data.settings.selectedInstanceId) ? data.settings.selectedInstanceId : builds[0]?.id || '';
    fillVersions(data.versions);
    authHint();
    message('world-error');
    el('world-dialog').showModal();
    el('world-name').focus();
  }

  async function changeWorld(action, id, value) {
    const host = hosts.connected;
    const buildId = action === 'create' ? el('build-select').value : '';
    const result = buildId ? await api.controllerImportBuild(host, buildId, value) : await api.controllerAction(host, action, id, value);
    const selected = result.id || id;
    worldId = selected;
    apply(await api.controllerSnapshot(host, selected));
  }

  document.getElementById('server-mode-local').addEventListener('click', () => mode(false));
  document.getElementById('server-mode-controller').addEventListener('click', () => mode(true));
  document.getElementById('hero-server').addEventListener('click', () => mode(false));
  window.addEventListener('veyra:view', event => { if (event.detail.view === 'server') refresh(); });
  document.addEventListener('visibilitychange', refresh);
  setInterval(refresh, 3500);

  el('add-host').addEventListener('click', hostForm);
  el('host-dialog').addEventListener('close', () => { el('host-form').reset(); keySelection(''); trustStep(); });
  el('host-select').addEventListener('change', () => { hosts.selected = el('host-select').value; disconnect(); });
  el('attach').addEventListener('click', () => {
    if (hosts.connected && !degraded) { disconnect(); return; }
    task(async () => {
      resetConnection();
      render();
      const result = await api.controllerAttach(hosts.selected);
      hosts.connected = hosts.selected;
      apply(result);
    });
  });
  el('forget').addEventListener('click', () => task(async () => {
    hosts.list = await api.controllerForget(hosts.selected);
    updateHosts();
  }));
  el('key').addEventListener('click', async () => {
    try {
      const file = await api.controllerChooseKey();
      if (file && el('host-dialog').open) keySelection(file);
    } catch (error) { message('host-error', error.message); }
  });
  el('key-clear').addEventListener('click', () => keySelection(''));
  el('share-open').addEventListener('click', () => {
    el('share-form').reset();
    message('share-error');
    el('share-dialog').showModal();
    el('share-id').focus();
  });
  el('share-form').addEventListener('submit', event => {
    event.preventDefault();
    task(async () => {
      const dialog = el('share-dialog'), button = el('share-submit');
      setDialogBusy(dialog, true);
      button.textContent = 'Проверяем доступ и сборку…';
      try {
        await api.controllerDownloadShared(el('share-id').value);
        dialog.close();
        document.querySelector('.rail-button[data-view="home"]').click();
      } finally {
        button.textContent = 'Получить сборку';
        setDialogBusy(dialog, false);
      }
    }, 'share-error');
  });
  for (const dialog of [el('host-dialog'), el('world-dialog'), el('share-dialog')]) {
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    for (const button of dialog.querySelectorAll('[data-controller-close]')) button.addEventListener('click', () => dialog.close());
  }
  el('host-form').addEventListener('submit', event => {
    event.preventDefault();
    task(async () => {
      setDialogBusy(el('host-dialog'), true);
      el('host-submit').textContent = trust ? 'Устанавливаем…' : 'Проверяем SSH…';
      try {
        const result = await api.controllerConnect(hostValues(), trust);
        if (result.token) { trustStep(result); setDialogBusy(el('host-dialog'), false); el('host-submit').focus(); return; }
        if (hosts.connected && hosts.connected !== result.host.id) resetConnection();
        connectionRevision++;
        hosts.list = [...hosts.list.filter(host => host.id !== result.host.id), result.host];
        hosts.selected = hosts.connected = result.host.id;
        worldId = '';
        apply(result.snapshot);
        updateHosts();
        message('error');
        setDialogBusy(el('host-dialog'), false);
        el('host-dialog').close();
      } catch (error) {
        trustStep();
        throw error;
      }
    }, 'host-error');
  });
  function newServer() { task(worldForm).then(() => { if (el('world-dialog').open) selectBuild(); }); }
  el('create').addEventListener('click', newServer);
  el('create-first').addEventListener('click', newServer);
  el('eula-link').addEventListener('click', () => api.openServerEula().catch(error => message('world-error', error.message)));
  el('world-auth').addEventListener('change', authHint);
  el('build-select').addEventListener('change', selectBuild);
  el('build-online').addEventListener('change', selectBuild);
  el('build-all').addEventListener('change', () => {
    for (const input of el('mods-list').querySelectorAll('input[data-unknown]')) {
      input.checked = el('build-all').checked;
      input.dispatchEvent(new Event('change'));
    }
  });
  el('upload-cancel').addEventListener('click', () => api.cancelOperation().catch(error => message('world-error', error.message)));
  api.onEvent(event => {
    if (event.type === 'progress' && event.phase === 'Перенос сборки на ВМ' && !el('upload-cancel').hidden) {
      el('world-submit').textContent = event.percent === null ? 'Переносим…' : 'Переносим · ' + event.percent + '%';
    }
  });
  el('world-form').addEventListener('submit', event => {
    event.preventDefault();
    task(async () => {
      setDialogBusy(el('world-dialog'), true);
      const uploading = Boolean(el('build-select').value);
      el('upload-cancel').hidden = !uploading;
      el('upload-cancel').disabled = false;
      if (uploading) el('world-submit').textContent = 'Готовим сборку…';
      try {
        await changeWorld('create', '', { name: el('world-name').value,
          minecraftVersion: el('world-version').value, port: Number(el('world-port').value),
          memoryGb: Number(el('world-memory').value), maxPlayers: Number(el('world-limit').value),
          veyraLogin: el('world-auth').checked, eula: el('eula').checked,
          saveName: el('save-select').value, mods: [...el('mods-list').querySelectorAll('input:checked')].map(input => input.value) });
      } finally {
        el('upload-cancel').hidden = true;
        el('world-submit').textContent = 'Создать сервер';
      }
      setDialogBusy(el('world-dialog'), false);
      el('world-dialog').close();
      el('power').focus();
    }, 'world-error');
  });
  el('power').addEventListener('change', event => {
    const action = event.target.checked ? 'start' : 'stop';
    task(() => changeWorld(action, worldId));
  });
  el('restart').addEventListener('click', () => task(() => changeWorld('restart', worldId)));
  el('join').addEventListener('click', () => task(() => api.controllerJoin(hosts.connected, worldId)));
  el('sync-build').addEventListener('click', () => task(async () => {
    el('sync-feedback').textContent = '';
    const result = await api.controllerSyncBuild(hosts.connected, worldId);
    if (!result) return;
    const text = result.disabled ? 'Синхронизация отключена.' :
      result.queued ? 'Моды применятся при следующем запуске сервера.' : 'Моды сервера обновлены.';
    el('sync-feedback').textContent = text +
      (result.shared ? ' Код сборки скопирован.' : '') +
      (result.shared && !result.published && !result.shareError ? ' Доступ появится после применения ревизии на сервере.' : '') +
      (result.shareError ? ' Публикация для игроков: ' + result.shareError : '') +
      (result.skipped?.length ? ' Пропущены моды: ' + result.skipped.join(', ') : '');
  }));
  el('copy').addEventListener('click', () => task(async () => {
    await api.controllerCopy(hosts.connected, worldId);
    el('copy').textContent = 'Скопировано';
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { el('copy').textContent = 'Копировать'; }, 1500);
  }));
  el('command-form').addEventListener('submit', event => {
    event.preventDefault();
    const text = el('command').value;
    task(async () => {
      await api.controllerAction(hosts.connected, 'command', worldId, text);
      if (el('command').value === text) el('command').value = '';
      el('command').focus();
    }).then(refresh);
  });
})();
