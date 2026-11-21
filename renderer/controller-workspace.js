(() => {
  'use strict';
  const api = window.launcher;
  const el = id => document.getElementById('controller-' + id);
  const fields = [
    ['level-seed', 'Сид нового мира', 'world', '', 128],
    ['gamemode', 'Режим игры', 'world', 'survival', { survival: ['Выживание', 'sword'], creative: ['Творчество', 'brush'], adventure: ['Приключение', 'compass'], spectator: ['Наблюдатель', 'eye'] }],
    ['difficulty', 'Сложность', 'rules', 'normal', { peaceful: ['Мирная', 'leaf'], easy: ['Лёгкая', 'heart'], normal: ['Нормальная', 'bolt'], hard: ['Сложная', 'skull'] }],
    ['spawn-protection', 'Защита спавна, блоков', 'rules', 16, [0, 256]],
    ['motd', 'Описание в списке серверов', 'network', 'A Minecraft Server', 160],
    ['view-distance', 'Дальность прорисовки', 'resources', 10, [2, 32]],
    ['simulation-distance', 'Дальность симуляции', 'resources', 10, [3, 32]],
  ];
  const switches = [
    ['pvp', 'PvP', true], ['hardcore', 'Хардкор', false], ['allow-flight', 'Разрешить полёт', false],
    ['white-list', 'Белый список', false, 'network'], ['enable-command-block', 'Командные блоки', false],
    ['allow-nether', 'Нижний мир', true], ['force-gamemode', 'Принудительный режим', false], ['generate-structures', 'Генерация структур', true],
  ];
  const terms = { build: 'сборку', world: 'мир', both: 'мир и сборку' };
  const create = (tag, className, text) => {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  };
  const glyph = name => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(svg.namespaceURI, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
  };
  const inputSwitch = (title, note) => {
    const input = create('input');
    input.type = 'checkbox';
    input.setAttribute('role', 'switch');
    const label = create('label', 'switch-field');
    const text = create('span', '', title);
    if (note) text.append(create('small', '', note));
    label.append(input, create('span', 'switch-track'), text);
    return { input, label };
  };
  window.veyraControllerSwitch = inputSwitch;

  window.veyraControllerWorkspace = ({ context, task, reload, message }) => {
    const tabs = [...document.querySelectorAll('[data-controller-section]')];
    const inputs = new Map();
    const options = new Map(), outputs = new Map();
    const configInputs = ['name', 'port', 'limit', 'auth', 'memory'].map(name => el('config-' + name));
    let tab = 'console', lastWorld = '', folder = '', rules = null, file = null, deletion = '';
    let direction = '', builds = [], transferRevision = 0, transferReady = true, fileFeedback = '', configFeedback = '';
    const get = () => context();
    const call = (action, options) => {
      const { host, world } = get();
      return api.controllerWorkspace(host, world?.id || '', action, options);
    };
    const stopped = world => ['stopped', 'error'].includes(world?.status);
    const join = (directory, filename) => directory ? directory + '/' + filename : filename;
    const disable = (id, value) => { el(id).disabled = Boolean(value); };
    const hide = (id, value) => { el(id).hidden = Boolean(value); };

    for (const [key, caption, group, fallback, spec] of fields) {
      const choice = typeof spec === 'object' && !Array.isArray(spec);
      const label = create(choice ? 'div' : 'label', 'form-field');
      const captionEl = create('span', '', caption);
      let input = create('input');
      let control = input;
      if (choice) {
        input.type = 'hidden';
        const buttons = create('div', 'choice-row controller-choices');
        buttons.setAttribute('role', 'group');
        buttons.setAttribute('aria-label', caption);
        for (const [value, [title, icon]] of Object.entries(spec)) {
          const button = create('button', '');
          button.type = 'button'; button.dataset.value = value;
          button.append(glyph(icon), create('span', '', title));
          button.addEventListener('click', () => setRule(key, value));
          buttons.append(button);
        }
        options.set(key, [...buttons.children]);
        control = create('div');
        control.append(input, buttons);
      } else {
        if (Array.isArray(spec)) {
          input.type = group === 'resources' ? 'range' : 'number';
          input.min = spec[0]; input.max = spec[1]; input.required = true;
          if (group === 'resources') {
            const output = create('output');
            captionEl.append(output);
            outputs.set(key, output);
            input.addEventListener('input', () => { output.textContent = input.value + ' чанков'; });
          }
        } else input.maxLength = spec;
      }
      inputs.set(key, input);
      label.append(captionEl, control);
      el('rules-' + group).append(label);
      setRule(key, fallback);
    }
    for (const [key, caption, fallback, group] of switches) {
      const { input, label } = inputSwitch(caption);
      inputs.set(key, input);
      el(group === 'network' ? 'network-switches' : 'rules-switches').append(label);
      setRule(key, fallback);
    }

    function setRule(key, value) {
      const input = inputs.get(key);
      if (input.type === 'checkbox') input.checked = value;
      else input.value = value;
      for (const button of options.get(key) || []) {
        const selected = button.dataset.value === value;
        button.setAttribute('aria-pressed', String(selected));
        button.classList.toggle('is-selected', selected);
      }
      if (outputs.has(key)) outputs.get(key).textContent = input.value + ' чанков';
    }
    const settingsMemory = el('config-memory');
    const showMemory = () => { el('config-memory-value').textContent = settingsMemory.value + ' ГБ'; };
    settingsMemory.addEventListener('input', showMemory);

    function changeTab(name) {
      tab = name;
      for (const button of tabs) {
        const active = button.dataset.controllerSection === name;
        button.setAttribute('aria-pressed', String(active));
        hide('section-' + button.dataset.controllerSection, !active);
      }
    }

    function render() {
      const { host, world, busy, degraded } = get();
      const locked = busy || degraded;
      const usable = Boolean(world && !locked);
      const writable = usable && stopped(world);
      hide('trash-open', !host);
      disable('trash-open', locked);
      if (lastWorld !== (world?.id || '')) {
        lastWorld = world?.id || '';
        folder = '';
        rules = null;
        fileFeedback = '';
        configFeedback = '';
        el('files-list').replaceChildren();
        el('file-replace').checked = false;
        changeTab('console');
      }
      for (const button of tabs) button.disabled = !usable;
      for (const id of ['transfer-upload', 'folder-add', 'file-upload', 'file-replace', 'delete-server']) disable(id, !writable);
      disable('transfer-download', !usable);
      disable('file-up', !folder || !usable);
      disable('file-refresh', !usable);
      for (const button of el('files-list').querySelectorAll('button')) button.disabled = !usable;
      disable('delete-world', !writable || !rules?.worldExists);
      for (const input of inputs.values()) input.disabled = !writable || !rules;
      for (const button of [...options.values()].flat()) button.disabled = !writable || !rules;
      for (const input of configInputs) input.disabled = !writable || !rules;
      disable('rules-reset', !writable || !rules);
      disable('rules-save', !writable || !rules);
      if (el('file-dialog').open) {
        const editable = file?.worldId === world?.id && (writable || (usable && world.status === 'ready' && file.liveConfig));
        el('file-text').readOnly = !editable;
        disable('file-save', !editable);
        el('file-hint').textContent = stopped(world) ? 'Текст UTF-8' : file?.liveConfig ?
          'Для применения настроек может потребоваться перезапуск сервера.' :
          'Остановите сервер, чтобы сохранить изменения в этом файле.';
      }
      if (!world) return;
      el('config-hint').textContent = stopped(world) ? configFeedback : 'Остановите сервер, чтобы изменить настройки или удалить данные.';
      el('files-hint').textContent = fileFeedback || (stopped(world) ? '' : 'Конфиги модов можно сохранить во время работы сервера.');
    }

    function show(id, focus) {
      el(id + '-dialog').showModal();
      if (focus) el(focus).focus();
    }
    function close(id) { el(id + '-dialog').close(); }
    const run = (callback, error) => task(callback, error || 'error');
    const download = (kind, path = '') => {
      const { host, world } = get();
      return api.controllerDownload(host, world.id, kind, path);
    };
    async function openFile(path) {
      const data = await call('read-file', { path });
      file = { path, worldId: get().world.id, etag: data.etag, liveConfig: data.liveConfig,
        crlf: data.text.includes('\r\n') && !/(?<!\r)\n/.test(data.text) };
      el('file-title').textContent = path;
      el('file-text').value = data.text;
      message('file-error');
      show('file', 'file-text');
    }

    async function loadFiles(path = folder) {
      const data = await call('files', { path });
      folder = path;
      fileFeedback = '';
      el('file-path').textContent = '/' + path;
      el('files-list').replaceChildren();
      if (!data.length) el('files-list').append(create('p', 'controller-help controller-empty-files', 'Папка пуста.'));
      for (const entry of data) {
        const row = create('div', 'controller-file-row');
        const name = create('button', 'controller-file-name');
        const jar = entry.kind === 'file' && /\.jar(?:\.disabled)?$/i.test(entry.name);
        name.type = 'button';
        name.title = jar ? 'Скачать ' + entry.name : entry.name;
        name.append(glyph(entry.kind === 'directory' ? 'folder' : jar ? 'download' : 'edit'), create('span', '', entry.name));
        const target = join(path, entry.name);
        const saveFile = () => run(async () => {
          fileFeedback = '';
          if (await download('file', target)) fileFeedback = 'Файл скачан · ' + entry.name;
        });
        if (entry.kind === 'directory') name.addEventListener('click', () => run(() => loadFiles(target)));
        else if (jar) name.addEventListener('click', saveFile);
        else name.addEventListener('click', () => run(() => openFile(target)));
        row.append(name);
        if (entry.kind === 'file') {
          const size = create('span', 'controller-file-size', Intl.NumberFormat('ru-RU').format(Math.ceil(entry.size / 1024)) + ' КБ');
          const save = create('button', 'controller-file-download');
          save.type = 'button'; save.setAttribute('aria-label', 'Скачать ' + entry.name);
          save.title = 'Скачать';
          save.append(glyph('download'));
          save.addEventListener('click', saveFile);
          row.append(size, save);
        }
        el('files-list').append(row);
      }
    }

    async function loadRules() {
      rules = await call('game-rules');
      for (const key of inputs.keys()) setRule(key, rules.rules[key]);
      const { world, ram } = get();
      el('config-name').value = world.name;
      el('config-port').value = world.port;
      el('config-limit').value = world.maxPlayers;
      el('config-auth').checked = world.veyraLogin;
      settingsMemory.max = Math.max(1, Math.floor(ram / 1024 ** 3), world.memoryGb);
      settingsMemory.value = world.memoryGb;
      showMemory();
      el('world-folder').textContent = rules.worldExists ? 'Сохранение · /' + rules.worldFolder : 'Сохранение появится после запуска сервера.';
    }

    function invalidate() {
      rules = null;
      folder = '';
      el('files-list').replaceChildren();
    }

    for (const button of tabs) button.addEventListener('click', () => {
      if (get().busy) return;
      const selected = button.dataset.controllerSection;
      changeTab(selected);
      if (selected === 'files') run(() => loadFiles());
      if (selected === 'config') run(loadRules);
    });
    el('file-up').addEventListener('click', () => run(() => loadFiles(folder.split('/').slice(0, -1).join('/'))));
    el('file-refresh').addEventListener('click', () => run(() => loadFiles()));
    el('file-upload').addEventListener('click', () => run(async () => {
      const { host, world } = get();
      try {
        const sent = await api.controllerFileUpload(host, world.id, folder, el('file-replace').checked);
        await loadFiles();
        if (sent) fileFeedback = 'Загружено файлов · ' + sent;
      } catch (error) {
        await loadFiles().catch(() => {});
        throw error;
      }
    }));
    el('folder-add').addEventListener('click', () => {
      el('folder-form').reset(); message('folder-error');
      show('folder', 'folder-name');
    });
    el('folder-form').addEventListener('submit', event => {
      event.preventDefault();
      run(async () => {
        const name = el('folder-name').value.trim();
        if (!name || /[/\\]/.test(name)) throw new Error('Введите имя одной папки');
        await call('mkdir', { path: join(folder, name) });
        close('folder');
        await loadFiles();
      }, 'folder-error');
    });
    el('file-form').addEventListener('submit', event => {
      event.preventDefault();
      run(async () => {
        const { host, world } = get();
        if (file?.worldId !== world?.id) throw new Error('Сервер изменился. Откройте файл заново.');
        const text = el('file-text').value;
        await api.controllerFileSave(host, world.id, file.path, file.crlf ? text.replaceAll('\n', '\r\n') : text, file.etag);
        close('file');
        await loadFiles();
        fileFeedback = 'Файл сохранён · ' + file.path;
      }, 'file-error');
    });
    el('rules-form').addEventListener('submit', event => {
      event.preventDefault();
      if (!rules) return;
      run(async () => {
        const data = {};
        for (const [key, input] of inputs) data[key] = input.type === 'checkbox' ? input.checked : ['number', 'range'].includes(input.type) ? Number(input.value) : input.value;
        const settings = { name: el('config-name').value, port: Number(el('config-port').value), maxPlayers: Number(el('config-limit').value),
          memoryGb: Number(settingsMemory.value), veyraLogin: el('config-auth').checked };
        await call('save-config', { rules: data, settings, etag: rules.etag });
        await reload();
        await loadRules();
        configFeedback = 'Настройки сохранены.';
      });
    });
    el('rules-reset').addEventListener('click', () => {
      for (const [key, , , fallback] of fields) setRule(key, fallback);
      for (const [key, , fallback] of switches) setRule(key, fallback);
    });

    async function refreshTransfer(preserveBuild = false) {
      const revision = ++transferRevision;
      const kind = el('transfer-kind').value;
      const library = direction === 'upload' && el('transfer-source').value === 'library';
      hide('transfer-build-field', !library);
      hide('transfer-save-field', true);
      hide('transfer-mods', true);
      hide('transfer-online-field', true);
      hide('transfer-all-field', true);
      el('transfer-mod-list').replaceChildren();
      el('transfer-hint').textContent = direction === 'upload' ?
        'Заменяемые файлы останутся в резервной копии на ВМ.' :
        stopped(get().world) ? 'Архив ZIP будет сохранён на этом ПК.' :
        'Моды и сборку можно скачать сразу. Для скачивания мира остановите сервер.';
      if (!library) { transferReady = true; disable('transfer-submit', false); return; }
      const { world } = get();
      const picker = el('transfer-build');
      const old = picker.value;
      const allowed = builds.filter(build => kind === 'world' || (world.minecraftVersion === build.minecraftVersion &&
        (world.loader || 'vanilla') === build.loader && (world.loaderVersion || '') === build.loaderVersion));
      picker.replaceChildren(...allowed.map(build => new Option(build.name, build.id)));
      if (allowed.some(build => build.id === old)) picker.value = old;
      transferReady = false;
      disable('transfer-submit', true);
      if (!picker.value) {
        el('transfer-hint').textContent = 'Для замены сборки нужна та же версия Minecraft и загрузчика. Выберите совместимую сборку или ZIP.';
        return;
      }
      if (preserveBuild) picker.value = old || picker.value;
      el('transfer-hint').textContent = 'Проверяем сборку…';
      const info = await api.controllerInspectBuild(picker.value, el('transfer-online').checked);
      if (revision !== transferRevision || !el('transfer-dialog').open) return;
      if (kind !== 'build') {
        el('transfer-save').replaceChildren(...info.worlds.map(name => new Option(name, name)));
        hide('transfer-save-field', false);
      }
      if (kind !== 'world') {
        for (const mod of info.mods) {
          const { input, label } = inputSwitch(mod.name, !mod.supported ? 'Только для клиента' : !mod.verified ? 'Совместимость неизвестна' : '');
          const unknown = mod.supported && !mod.verified;
          if (unknown) input.dataset.unknown = '';
          input.value = mod.name; input.checked = mod.verified || (unknown && el('transfer-all').checked); input.disabled = !mod.supported;
          el('transfer-mod-list').append(label);
        }
        hide('transfer-mods', !info.mods.length);
        hide('transfer-online-field', !info.mods.length);
        hide('transfer-all-field', !info.mods.some(mod => mod.supported && !mod.verified));
      }
      transferReady = kind === 'build' || Boolean(info.worlds.length);
      el('transfer-hint').textContent = transferReady ? 'Заменяемые файлы останутся в резервной копии на ВМ.' : 'В сборке нет одиночных сохранений.';
      disable('transfer-submit', !transferReady);
    }

    function openTransfer(action) {
      run(async () => {
        direction = action;
        const uploading = action === 'upload';
        if (uploading) builds = (await api.getState()).instances.filter(build => build.installed);
        el('transfer-form').reset();
        const kind = el('transfer-kind');
        const mods = kind.querySelector('[value="mods"]');
        mods.hidden = mods.disabled = uploading;
        for (const option of kind.options) {
          if (['world', 'both'].includes(option.value)) option.disabled = !uploading && !stopped(get().world);
        }
        kind.value = uploading ? 'build' : 'mods';
        el('transfer-title').textContent = uploading ? 'Загрузить на сервер' : 'Скачать с сервера';
        el('transfer-submit').textContent = uploading ? 'Загрузить' : 'Скачать ZIP';
        hide('transfer-source-field', !uploading);
        if (!builds.length && uploading) el('transfer-source').value = 'zip';
        message('transfer-error');
        show('transfer');
        await refreshTransfer();
      }, 'transfer-error');
    }
    el('transfer-upload').addEventListener('click', () => openTransfer('upload'));
    el('transfer-download').addEventListener('click', () => openTransfer('download'));
    for (const id of ['transfer-kind', 'transfer-source', 'transfer-build', 'transfer-online']) el(id).addEventListener('change', () => {
      if (!get().busy) refreshTransfer(id === 'transfer-build').catch(error => message('transfer-error', error.message));
    });
    el('transfer-all').addEventListener('change', () => {
      for (const input of el('transfer-mod-list').querySelectorAll('input[data-unknown]')) input.checked = el('transfer-all').checked;
    });
    el('transfer-form').addEventListener('submit', event => {
      event.preventDefault();
      if (!transferReady) return;
      run(async () => {
        const mode = el('transfer-kind').value;
        const { host, world } = get();
        const uploading = direction === 'upload';
        const submit = el('transfer-submit');
        submit.disabled = true;
        submit.textContent = uploading ? 'Загружаем…' : 'Скачиваем…';
        try {
          if (!uploading) {
            if (await download(mode)) {
              fileFeedback = 'Архив скачан.';
              close('transfer');
            }
            return;
          }
          const result = await api.controllerReplaceBuild(host, world.id, {
            mode, source: el('transfer-source').value, instanceId: el('transfer-build').value,
            saveName: el('transfer-save').value,
            mods: [...el('transfer-mod-list').querySelectorAll('input:checked')].map(input => input.value),
          });
          if (!result) return;
          close('transfer');
          invalidate();
          await reload();
          await loadFiles('');
          fileFeedback = result.skipped?.length ? 'Исключены клиентские моды · ' + result.skipped.join(', ') : 'Перенос завершён.';
        } finally {
          submit.textContent = uploading ? 'Загрузить' : 'Скачать ZIP';
          submit.disabled = !transferReady;
        }
      }, 'transfer-error');
    });
    api.onEvent(event => {
      if (get().busy && el('transfer-dialog').open && el('transfer-submit').disabled && event.type === 'progress' &&
        event.phase === 'Перенос сборки на ВМ' && event.percent !== null) el('transfer-submit').textContent = 'Загружаем · ' + event.percent + '%';
    });

    for (const kind of ['world', 'server']) el('delete-' + kind).addEventListener('click', () => {
      deletion = kind;
      const name = get().world.name;
      el('delete-title').textContent = kind === 'world' ? 'Удалить мир' : 'Удалить сервер';
      el('delete-note').textContent = kind === 'world' ?
        'Мир сервера «' + name + '» будет в корзине ВМ. При следующем запуске Minecraft создаст новый мир.' :
        'Сервер «' + name + '» вместе с файлами и настройками будет в корзине ВМ. Игровой порт освободится.';
      message('delete-error');
      show('delete');
    });
    el('delete-form').addEventListener('submit', event => {
      event.preventDefault();
      run(async () => {
        await call('delete-' + deletion);
        close('delete');
        invalidate();
        await reload();
        if (deletion === 'world') await loadRules();
      }, 'delete-error');
    });

    async function loadTrash() {
      const data = await call('trash');
      el('trash-list').replaceChildren();
      hide('trash-empty', data.length > 0);
      for (const entry of data) {
        const row = create('div', 'controller-trash-row');
        const details = create('div', 'controller-trash-details');
        const kind = { server: 'Сервер', world: 'Мир', transfer: 'Копия перед переносом' }[entry.kind];
        details.append(create('strong', '', entry.name), create('small', '', kind +
          ' · ' + new Date(entry.time).toLocaleString('ru-RU')));
        const restore = create('button', 'text-button', 'Восстановить');
        restore.type = 'button';
        restore.addEventListener('click', () => run(async () => {
          const result = await call('restore', { entryId: entry.id });
          invalidate();
          await reload(result.id);
          await loadTrash();
        }, 'trash-error'));
        const purge = create('button', 'text-button controller-purge', 'Удалить навсегда');
        purge.type = 'button';
        purge.addEventListener('click', () => run(async () => {
          if (await call('purge', { entryId: entry.id })) await loadTrash();
        }, 'trash-error'));
        const actions = create('div', 'controller-trash-actions');
        actions.append(restore, purge);
        row.append(details, actions);
        el('trash-list').append(row);
      }
    }
    el('trash-open').addEventListener('click', () => run(async () => {
      await loadTrash();
      message('trash-error');
      show('trash');
    }));
    for (const id of ['file', 'folder', 'transfer', 'delete', 'trash']) {
      const dialog = el(id + '-dialog');
      dialog.addEventListener('cancel', event => { if (get().busy) event.preventDefault(); });
      for (const button of dialog.querySelectorAll('[data-workspace-close]')) button.addEventListener('click', () => { if (!get().busy) close(id); });
    }
    return { render };
  };
})();
