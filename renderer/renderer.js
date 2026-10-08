(() => {
  'use strict';

  const api = window.launcher;
  const el = (id) => document.getElementById(id);
  const state = { data: null, view: 'home', loader: 'vanilla', loaderRequest: 0, editingId: '', editAccent: 'violet', removingId: '', toastTimer: null, busy: false, javaMode: 'auto', profileTab: 'local' };
  // Microsoft integration is retained while its public interface is paused.
  const MICROSOFT_UI_ENABLED = false;
  const loaderNames = { vanilla: 'Vanilla', fabric: 'Fabric', neoforge: 'NeoForge', forge: 'Forge' };
  const loaderIcon = (loader) => '../assets/brands/' + ({ vanilla: 'minecraft', fabric: 'fabric', neoforge: 'neoforge', forge: 'forge' }[loader] || 'minecraft') + '.png';
  const icon = (name) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('icon');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
  };
  const friendlyError = (error) => error && error.message ? error.message : String(error || 'Неизвестная ошибка');
  const instances = () => state.data?.instances || [];
  const selected = () => instances().find((item) => item.id === state.data?.settings.selectedInstanceId) || instances()[0] || null;
  const setText = (id, value) => { if (el(id).textContent !== String(value)) el(id).textContent = String(value); };
  const countText = (n) => n + ' ' + (n % 10 === 1 && n % 100 !== 11 ? 'сборка' : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'сборки' : 'сборок'));
  const memoryMaximum = () => Math.max(1, Number(state.data?.maxMemoryGb) || 16);

  function notice(message, crash = false) {
    setText('notice-text', message);
    el('notice').hidden = false;
    el('notice-report').hidden = !crash;
  }
  function toast(message) {
    setText('toast-text', message);
    el('toast').hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { el('toast').hidden = true; }, 3800);
  }
  async function action(callback) {
    try { return await callback(); }
    catch (error) { notice(friendlyError(error)); return null; }
  }
  function showView(view) {
    hideContextMenu();
    if (state.view !== view) document.querySelector('.content').scrollTop = 0;
    if (state.view === 'settings' && view !== 'settings') applyAppearance(state.data.settings.appearance);
    state.view = view;
    for (const page of document.querySelectorAll('[data-page]')) {
      const active = page.dataset.page === view;
      page.hidden = !active;
      page.classList.toggle('is-visible', active);
    }
    for (const button of document.querySelectorAll('.rail-button')) {
      button.classList.toggle('is-active', button.dataset.view === view);
    }
    const navButtons = [...document.querySelectorAll('.rail-nav .rail-button')];
    const currentButton = navButtons.find((button) => button.dataset.view === view);
    el('rail-nav').style.setProperty('--nav-y', (currentButton?.offsetTop || 0) + 'px');
    setText('view-title', { home: 'Главная', instances: 'Сборки', logs: 'Журнал', settings: 'Настройки' }[view]);
    el('search-input').closest('.search-box').hidden = view !== 'home' && view !== 'instances';
    if (view === 'logs') refreshLogs();
    if (view === 'settings') renderSettings();
    if (view === 'instances' || view === 'home') renderCards();
  }
  function filteredInstances() {
    const query = el('search-input').value.trim().toLowerCase();
    return instances().filter((item) => !query ||
      (item.name + ' ' + item.minecraftVersion + ' ' + loaderNames[item.loader]).toLowerCase().includes(query))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite));
  }
  function addCard() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'instance-card add-card';
    const marker = document.createElement('span');
    marker.className = 'add-icon';
    marker.append(icon('plus'));
    const title = document.createElement('strong');
    title.textContent = 'Новая сборка';
    const hint = document.createElement('small');
    hint.textContent = 'Отдельная папка для новой игры';
    button.append(marker, title, hint);
    button.addEventListener('click', openCreate);
    return button;
  }
  function instanceCard(instance) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'instance-card accent-' + instance.accent + (instance.installed ? ' is-installed' : '') +
      (selected()?.id === instance.id ? ' is-selected' : '');
    button.setAttribute('aria-label', 'Выбрать ' + instance.name);
    button.dataset.instanceId = instance.id;
    const art = document.createElement('span');
    art.className = 'instance-art';
    if (instance.coverUrl) art.style.backgroundImage = 'url("' + instance.coverUrl + '")';
    const shade = document.createElement('span');
    shade.className = 'instance-shade';
    const content = document.createElement('span');
    content.className = 'instance-card-content';
    const top = document.createElement('span');
    top.className = 'instance-card-top';
    const pill = document.createElement('span');
    pill.className = 'pill';
    const loaderImage = document.createElement('img');
    loaderImage.className = 'brand-icon';
    loaderImage.src = loaderIcon(instance.loader);
    loaderImage.alt = '';
    const loaderText = document.createElement('span');
    loaderText.textContent = loaderNames[instance.loader] || instance.loader;
    pill.append(loaderImage, loaderText);
    top.append(pill);
    if (instance.favorite) {
      const favorite = document.createElement('span');
      favorite.className = 'card-favorite';
      favorite.append(icon('star'));
      top.append(favorite);
    }
    const name = document.createElement('strong');
    name.textContent = instance.name;
    const version = document.createElement('small');
    version.textContent = 'Minecraft ' + instance.minecraftVersion;
    const status = document.createElement('span');
    status.className = 'instance-state';
    status.textContent = instance.installed ? 'Готов к игре' : 'Нужна установка';
    content.append(top, name, version, status);
    button.append(art, shade, content);
    button.addEventListener('click', async () => {
      closeQuickRename();
      await action(() => api.selectInstance(instance.id));
      showView('home');
    });
    button.addEventListener('contextmenu', (event) => openContextMenu(event, instance.id));
    return button;
  }
  function renderCards() {
    const items = filteredInstances();
    for (const [id, limit] of [['home-instance-grid', 4], ['all-instance-grid', Infinity]]) {
      const grid = el(id);
      const current = new Map([...grid.querySelectorAll('[data-instance-id]')].map(card => [card.dataset.instanceId, card]));
      const ordered = [];
      for (const [index, instance] of items.slice(0, limit).entries()) {
        const signature = JSON.stringify([instance.name, instance.accent, instance.coverUrl, instance.favorite, instance.installed, instance.loader, instance.minecraftVersion]);
        let card = current.get(instance.id);
        if (!card || card.dataset.signature !== signature) {
          const replacement = instanceCard(instance);
          replacement.dataset.signature = signature;
          if (card) { replacement.style.animation = 'none'; card.replaceWith(replacement); }
          card = replacement;
        }
        card.classList.toggle('is-selected', selected()?.id === instance.id);
        card.style.setProperty('--order', Math.min(index, 7));
        ordered.push(card);
      }
      ordered.push(grid.querySelector('.add-card') || addCard());
      for (const card of [...grid.children]) if (!ordered.includes(card)) card.remove();
      ordered.forEach((card, index) => { if (grid.children[index] !== card) grid.insertBefore(card, grid.children[index] || null); });
    }
    setText('home-count', countText(instances().length));
    setText('footer-instance-count', countText(instances().length));
  }
  function renderHero() {
    const item = selected();
    transitionHero(item);
    el('hero-empty').hidden = Boolean(item);
    el('hero-active').hidden = !item;
    if (!item) {
      closeQuickRename();
      el('hero-image').style.backgroundImage = '';
      for (const id of ['detail-loader', 'detail-version', 'detail-folder', 'capsule-last']) setText(id, '—');
      setText('detail-java', 'Автоматически');
      setText('detail-memory', (state.data?.settings.memoryGb || 4) + ' ГБ');
      setText('capsule-note', 'Создайте сборку и оставьте первую заметку к сборке.');
      setText('capsule-launches', '0');
      renderPlaytime();
      return;
    }
    const hero = el('hero-card');
    if (!hero.classList.contains('accent-' + item.accent)) {
      hero.classList.remove('accent-violet', 'accent-blue', 'accent-rose', 'accent-amber');
      hero.classList.add('accent-' + item.accent);
    }
    el('hero-image').style.backgroundImage = item.coverUrl ? 'url("' + item.coverUrl + '")' : '';
    el('hero-favorite').hidden = !item.favorite;
    setText('hero-name', item.name);
    el('hero-loader').querySelector('img').src = loaderIcon(item.loader);
    el('hero-loader').querySelector('span').textContent = loaderNames[item.loader] || item.loader;
    el('hero-version').querySelector('span').textContent = 'Minecraft ' + item.minecraftVersion;
    setText('hero-description', item.installed
      ? 'Сборка готова. Моды, сохранения и настройки останутся внутри этой сборки.'
      : 'Сборка создана. Установите игру, чтобы начать.');
    setText('detail-loader', loaderNames[item.loader] || item.loader);
    setText('detail-version', item.minecraftVersion);
    setText('detail-java', item.javaPath || state.data.settings.javaPath ? 'Своя Java' : 'Автоматически');
    setText('detail-memory', (item.memoryGb || state.data.settings.memoryGb) + ' ГБ');
    setText('detail-folder', item.legacy ? 'Старая папка' : 'Своя папка');
    el('detail-folder').title = item.directory;
    setText('capsule-note', item.note || 'Оставьте здесь цель или напоминание для этой сборки.');
    el('capsule-note').title = item.note || '';
    setText('capsule-launches', item.launchCount || 0);
    setText('capsule-last', item.lastPlayedAt
      ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(new Date(item.lastPlayedAt))
      : '—');
    const operation = state.data.operation;
    const running = state.data.runningInstanceId === item.id;
    const stopping = running && state.data.stoppingGame;
    const working = operation?.instanceId === item.id;
    setText('main-action-label', working ? (operation.type === 'launch' ? 'Запускаем…' : 'Устанавливаем…') :
      (stopping ? 'Останавливаем…' : (running ? 'Остановить игру' : (item.installed ? 'Играть' : 'Установить'))));
    el('main-action-icon').querySelector('use').setAttribute('href', '#i-' + (running ? 'stop' : (item.installed ? 'play' : 'download')));
    el('main-action').classList.toggle('button-danger', running);
    el('main-action').classList.toggle('button-primary', !running);
    el('main-action').disabled = Boolean(operation || stopping || (state.data.runningInstanceId && !running));
    el('hero-edit').disabled = working;
    const box = el('progress-box');
    box.hidden = !working;
    el('cancel-operation').disabled = false;
    if (working) renderProgress(operation.progress || null);
    renderPlaytime();
  }
  function renderProgress(value) {
    if (!value) {
      setText('progress-phase', 'Подготовка');
      setText('progress-percent', '');
      setText('progress-message', 'Подготавливаем файлы…');
      el('progress-track').classList.add('is-indeterminate');
      return;
    }
    setText('progress-phase', value.phase || 'Подготовка');
    setText('progress-percent', value.percent == null ? '' : value.percent + '%');
    setText('progress-message', value.message || '');
    const track = el('progress-track');
    track.classList.toggle('is-indeterminate', value.percent == null);
    track.setAttribute('aria-valuenow', value.percent == null ? 0 : value.percent);
    el('progress-fill').style.width = value.percent == null ? '' : value.percent + '%';
  }
  function renderSettings() {
    if (!state.data) return;
    const settings = state.data.settings;
    el('player-name').value = settings.playerName;
    setText('settings-account-status', (MICROSOFT_UI_ENABLED && state.data.account.mode === 'microsoft' ? 'Microsoft · ' : '') + state.data.account.name);
    const maximum = memoryMaximum();
    el('memory-gb').max = String(maximum);
    el('memory-range').max = String(maximum);
    el('memory-gb').value = settings.memoryGb;
    el('memory-range').value = settings.memoryGb;
    setText('memory-limit-hint', 'На компьютере ' + state.data.systemMemoryGb + ' ГБ. Лимит для игры — ' + maximum + ' ГБ; 2 ГБ оставляем системе.');
    for (const button of document.querySelectorAll('[data-memory]')) button.disabled = Number(button.dataset.memory) > maximum;
    el('show-snapshots').checked = settings.showSnapshots;
    el('java-path').value = settings.javaPath || '';
    state.javaMode = settings.javaPath ? 'manual' : 'auto';
    renderJavaMode();
    renderJavaCandidates();
    setText('data-path', state.data.instancesDirectory);
    el('data-path').title = state.data.instancesDirectory;
    state.appearanceDraft = { ...settings.appearance };
    renderAppearance();
  }
  function renderJavaMode() {
    const automatic = state.javaMode === 'auto';
    el('java-auto').classList.toggle('is-active', automatic);
    el('java-manual').classList.toggle('is-active', !automatic);
    el('manual-java').hidden = automatic;
    setText('java-explain', automatic
      ? 'Veyra подберёт нужную Java и при необходимости загрузит официальную сборку.'
      : 'Выбранная Java должна соответствовать версии Minecraft. Для разных сборок можно указать отдельный путь.');
  }
  function renderJavaCandidates() {
    const target = el('java-candidates');
    target.replaceChildren();
    const list = state.data?.javaCandidates || [];
    if (!list.length) {
      const message = document.createElement('span');
      message.className = 'muted';
      message.textContent = 'Java пока не найдена. Автоматическая загрузка доступна при установке.';
      target.append(message);
      return;
    }
    for (const item of list) {
      const chip = document.createElement('span');
      chip.className = 'java-chip';
      chip.textContent = 'Java ' + item.major + ' · ' + (item.source || 'Компьютер');
      chip.title = item.path;
      target.append(chip);
    }
  }
  function render() {
    if (!state.data) return;
    renderProfile();
    renderGreeting();
    if (state.view !== 'settings') applyAppearance(state.data.settings.appearance, false);
    const running = instances().find((item) => item.id === state.data.runningInstanceId);
    el('stop-game-footer').hidden = !running;
    el('stop-game-footer').disabled = Boolean(state.data.stoppingGame);
    el('stop-game-footer').title = running ? 'Завершить процесс: ' + running.name : '';
    setText('stop-game-footer-label', state.data.stoppingGame ? 'Останавливаем…' : 'Остановить игру');
    renderHero();
    renderCards();
    setText('app-version', state.data.appVersion);
    if (el('create-dialog').open && state.versionsKey !== JSON.stringify(state.data.versions)) {
      state.versionsKey = JSON.stringify(state.data.versions);
      renderVersionOptions();
      refreshLoaderOptions();
    }
  }
  function renderProfile() {
    const account = state.data.account;
    const auth = account.auth;
    setText('profile-chip-name', account.name);
    setText('profile-chip-mode', account.mode === 'microsoft' ? (MICROSOFT_UI_ENABLED ? 'Microsoft' : 'Игровой профиль') : 'Локальный профиль');
    setText('rail-profile-initial', account.name.slice(0, 1).toUpperCase());
    setText('profile-avatar', account.name.slice(0, 1).toUpperCase());
    setText('profile-active-name', account.name);
    setText('profile-active-mode', account.mode === 'microsoft' ? (MICROSOFT_UI_ENABLED ? 'Microsoft · Minecraft Java' : 'Игровой профиль') : 'Локальный профиль');
    el('profile-rail').title = 'Профиль: ' + account.name;
    for (const button of document.querySelectorAll('[data-account-mode]')) {
      button.classList.toggle('is-selected', button.dataset.accountMode === state.profileTab);
    }
    el('account-tabs').hidden = !MICROSOFT_UI_ENABLED;
    el('profile-local-panel').hidden = MICROSOFT_UI_ENABLED && state.profileTab !== 'local';
    el('profile-microsoft-panel').hidden = !MICROSOFT_UI_ENABLED || state.profileTab !== 'microsoft';
    el('microsoft-signed').hidden = !account.microsoft;
    el('microsoft-intro').hidden = Boolean(account.microsoft);
    setText('microsoft-name', account.microsoft?.name || '');
    setText('microsoft-uuid', account.microsoft?.id || '');
    el('device-login').hidden = !auth.busy;
    setText('microsoft-code', auth.userCode || '…');
    setText('microsoft-phase', auth.phase || '');
    el('microsoft-copy').disabled = !auth.userCode;
    el('microsoft-browser').disabled = !auth.verificationUri;
    el('microsoft-error').hidden = !auth.error;
    setText('microsoft-error', auth.error || '');
    el('microsoft-login-actions').hidden = auth.busy;
    el('microsoft-start').disabled = !account.configured || auth.busy;
    setText('microsoft-start-label', account.microsoft ? 'Сменить аккаунт' : 'Войти в Microsoft');
    el('microsoft-logout').hidden = !account.microsoft;
    el('microsoft-not-configured').hidden = account.configured;
    if (document.activeElement !== el('microsoft-client-id')) el('microsoft-client-id').value = account.clientId;
  }
  function openProfile() {
    state.profileTab = MICROSOFT_UI_ENABLED ? state.data.account.mode : 'local';
    el('profile-name-input').value = state.data.settings.playerName;
    el('profile-feedback').hidden = true;
    renderProfile();
    showDialog(el('profile-dialog'));
    if (state.profileTab === 'local') {
      el('profile-name-input').focus();
      el('profile-name-input').select();
    }
  }
  async function profileAction(callback) {
    el('profile-feedback').hidden = true;
    try { return await callback(); }
    catch (error) {
      setText('profile-feedback', friendlyError(error));
      el('profile-feedback').hidden = false;
      return null;
    }
  }
  function availableVersions() {
    const versions = state.data?.versions || [];
    return versions.filter((item) => state.data.settings.showSnapshots || item.type === 'release');
  }
  function renderVersionOptions() {
    const select = el('create-version');
    const previous = select.value;
    select.replaceChildren();
    const versions = availableVersions();
    if (!versions.length) {
      const option = new Option('Не удалось получить версии', '');
      select.add(option);
      el('create-submit').disabled = true;
      renderVersionTiles();
      return;
    }
    for (const version of versions) {
      select.add(new Option(version.id + (version.type === 'snapshot' ? ' · Snapshot' : ''), version.id));
    }
    const preferred = versions.filter(item => item.type === (state.versionKind || 'release'));
    select.value = preferred.some(item => item.id === previous) ? previous : preferred[0]?.id || '';
    el('create-submit').disabled = !select.value;
    renderVersionTiles();
  }
  function renderVersionTiles() {
    const query = el('version-search').value.trim().toLowerCase();
    const kind = state.versionKind || 'release';
    const versions = availableVersions().filter(item => item.type === kind && (!query || item.id.toLowerCase().includes(query)));
    const target = el('version-tiles');
    target.replaceChildren();
    for (const [index, version] of versions.slice(0, state.versionLimit || 24).entries()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'version-tile';
      button.dataset.version = version.id;
      button.classList.toggle('is-selected', el('create-version').value === version.id);
      button.setAttribute('aria-pressed', String(el('create-version').value === version.id));
      const title = document.createElement('strong');
      title.textContent = version.id;
      const subtitle = document.createElement('small');
      subtitle.textContent = index === 0 && !query ? (kind === 'snapshot' ? 'Свежий Snapshot' : 'Последняя версия') : (kind === 'snapshot' ? 'Snapshot' : 'Релиз');
      button.append(icon('check'), title, subtitle);
      button.addEventListener('click', () => {
        el('create-version').value = version.id;
        for (const tile of target.children) {
          tile.classList.toggle('is-selected', tile === button);
          tile.setAttribute('aria-pressed', String(tile === button));
        }
        setText('chosen-version', version.id);
        refreshLoaderOptions();
      });
      target.append(button);
    }
    if (!versions.length) {
      const hint = document.createElement('p');
      hint.className = 'version-empty';
      hint.textContent = state.data.versions.length ? 'Версия не найдена. Попробуйте другой запрос.' : 'Загружаем каталог Minecraft…';
      target.append(hint);
    }
    el('version-more').hidden = versions.length <= (state.versionLimit || 24);
    setText('chosen-version', el('create-version').value || 'Выберите версию');
    for (const button of document.querySelectorAll('[data-version-kind]')) {
      button.classList.toggle('is-active', button.dataset.versionKind === kind);
      button.setAttribute('aria-pressed', String(button.dataset.versionKind === kind));
    }
  }
  function renderGreeting() {
    if (!state.data) return;
    const hour = new Date().getHours();
    setText('greeting-time', hour < 6 ? 'Доброй ночи' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер');
    setText('greeting-name', state.data.account.name);
  }
  function duration(ms, live = false) {
    const seconds = Math.floor(Math.max(0, ms) / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds / 60) % 60;
    if (live && hours === 0 && minutes === 0) return seconds + ' сек';
    return hours ? hours + ' ч ' + minutes + ' мин' : Math.floor(seconds / 60) + ' мин';
  }
  function renderPlaytime() {
    const item = selected();
    const session = state.data?.runningSession;
    const running = session?.instanceId === item?.id && Boolean(item);
    const total = (item?.playedMs || 0) + (running ? Math.max(0, Date.now() - session.accountedAt) : 0);
    setText('capsule-playtime', duration(total, running || total < 60000 && total > 0));
    setText('capsule-session', running ? 'Сейчас в игре · ' + duration(Date.now() - session.startedAt, true) : total ? 'Время вашей истории' : 'Впереди первая игра');
    el('capsule-session').classList.toggle('is-playing', running);
  }
  function transitionHero(item) {
    const key = item ? item.id + '|' + (item.coverUrl || '') : '';
    const hero = el('hero-card');
    if (state.heroKey === key) return;
    const previous = state.heroKey;
    state.heroKey = key;
    hero.dataset.instanceId = item?.id || '';
    hero.querySelectorAll('.hero-outgoing').forEach(node => node.remove());
    for (const node of [el('hero-image'), el('hero-active')]) node.getAnimations().forEach(animation => animation.cancel());
    if (previous === undefined || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const image = el('hero-image').cloneNode(true);
    const content = (previous ? el('hero-active') : el('hero-empty')).cloneNode(true);
    for (const node of [image, content]) {
      node.removeAttribute('id');
      node.querySelectorAll('[id]').forEach(child => child.removeAttribute('id'));
      node.classList.add('hero-outgoing');
      node.inert = true;
      node.setAttribute('aria-hidden', 'true');
      hero.append(node);
    }
    content.hidden = false;
    image.style.zIndex = '1';
    content.style.zIndex = '4';
    const timing = { duration: 680, easing: 'cubic-bezier(.22,1,.36,1)' };
    image.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.06)' }], timing).finished.catch(() => {}).finally(() => image.remove());
    content.animate([{ opacity: 1, transform: 'translateY(0)', filter: 'blur(0)' }, { opacity: 0, transform: 'translateY(-18px)', filter: 'blur(7px)' }], { ...timing, duration: 420 }).finished.catch(() => {}).finally(() => content.remove());
    el('hero-image').animate([{ opacity: .3, scale: 1.055 }, { opacity: 1, scale: 1 }], timing);
    const incoming = item ? el('hero-active') : el('hero-empty');
    incoming.classList.add('has-switched');
    incoming.animate([{ opacity: 0, transform: 'translateY(20px)', filter: 'blur(6px)' }, { opacity: 1, transform: 'translateY(0)', filter: 'blur(0)' }], { ...timing, duration: 600 });
  }
  function showDialog(dialog) {
    clearTimeout(dialog.closeTimer);
    dialog.classList.remove('is-closing');
    if (!dialog.open) dialog.showModal();
  }
  function closeDialog(dialog) {
    if (!dialog.open || dialog.classList.contains('is-closing')) return;
    dialog.classList.add('is-closing');
    if (dialog.id === 'create-dialog') state.loaderRequest++;
    dialog.closeTimer = setTimeout(() => { dialog.close(); dialog.classList.remove('is-closing'); }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 260);
  }
  const atmospherePresets = { solid: { transparency: 0, brightness: 100, blur: 18 }, mist: { transparency: 18, brightness: 80, blur: 28 }, crystal: { transparency: 40, brightness: 110, blur: 8 } };
  function applyAppearance(value, native = true) {
    if (!value) return;
    const root = document.documentElement;
    root.style.setProperty('--background-alpha', 1 - value.transparency / 100);
    root.style.setProperty('--background-brightness', value.brightness / 100);
    root.style.setProperty('--background-blur', value.blur + 'px');
    if (native) {
      clearTimeout(state.appearanceTimer);
      state.appearanceTimer = setTimeout(() => api.previewAppearance(value).catch(() => {}), 120);
    }
  }
  function renderAppearance() {
    const value = state.appearanceDraft;
    if (!value) return;
    applyAppearance(value);
    for (const key of ['transparency', 'brightness', 'blur']) {
      el('appearance-' + key).value = value[key];
      setText('appearance-' + key + '-value', value[key] + (key === 'blur' ? ' px' : '%'));
    }
    const preview = el('atmosphere-preview');
    preview.style.setProperty('--preview-alpha', 1 - value.transparency / 100);
    preview.style.setProperty('--preview-light', value.brightness / 100);
    preview.style.setProperty('--preview-blur', value.blur / 4 + 'px');
    for (const button of document.querySelectorAll('[data-atmosphere]')) {
      const preset = atmospherePresets[button.dataset.atmosphere];
      const active = Object.keys(preset).every(key => preset[key] === value[key]);
      button.classList.toggle('is-selected', active);
      button.setAttribute('aria-pressed', String(active));
    }
  }
  function hideContextMenu() { el('build-context-menu').hidden = true; }
  function openContextMenu(event, id) {
    event.preventDefault();
    if (document.querySelector('dialog[open]')) return;
    const item = instances().find(entry => entry.id === id);
    const menu = el('build-context-menu');
    menu.replaceChildren();
    const heading = document.createElement('p');
    heading.className = 'context-heading';
    heading.textContent = item?.name || 'Библиотека';
    menu.append(heading);
    const entries = item ? [
      [state.data.runningInstanceId === id ? 'stop' : item.installed ? 'play' : 'download', state.data.runningInstanceId === id ? 'Остановить игру' : item.installed ? 'Играть' : 'Установить', async () => {
        await api.selectInstance(id); showView('home');
        if (state.data.runningInstanceId === id) await api.stopGame();
        else if (item.installed) await launchWithScene(item); else await api.installInstance(id);
      }, Boolean(state.data.operation || state.data.stoppingGame || state.data.runningInstanceId && state.data.runningInstanceId !== id)],
      ['edit', 'Переименовать', async () => { await api.selectInstance(id); showView('home'); openQuickRename(); }],
      ['image', 'Сменить обложку', () => api.setInstanceCover(id), Boolean(item.legacy)],
      ['star', item.favorite ? 'Убрать из избранного' : 'В избранное', () => api.updateInstance(id, { favorite: !item.favorite })],
      ['folder', 'Открыть папку', () => api.openInstanceFolder(id)],
      ['settings', 'Настройки сборки', () => openEdit(item)],
      ['trash', 'Удалить сборку', () => { state.removingId = id; showDialog(el('remove-dialog')); }, Boolean(state.data.operation?.instanceId === id || state.data.runningInstanceId === id)],
    ] : [['plus', 'Новая сборка', openCreate], ['folder', 'Папка сборок', () => api.openDataFolder()]];
    for (const [glyph, label, callback, disabled] of entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.disabled = Boolean(disabled);
      button.dataset.action = glyph;
      if (glyph === 'trash') button.className = 'context-danger';
      const text = document.createElement('span'); text.textContent = label;
      button.append(icon(glyph), text);
      button.addEventListener('click', () => { hideContextMenu(); action(callback); });
      menu.append(button);
    }
    menu.hidden = false;
    const box = menu.getBoundingClientRect();
    const anchor = event.currentTarget?.getBoundingClientRect();
    const x = event.clientX || anchor?.left || 100;
    const y = event.clientY || anchor?.bottom || 100;
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - box.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - box.height - 8)) + 'px';
    menu.querySelector('button:not(:disabled)')?.focus();
    state.contextAnchor = event.currentTarget;
  }
  async function refreshLoaderOptions() {
    const token = ++state.loaderRequest;
    const loader = state.loader;
    const field = el('loader-version-field');
    field.hidden = loader === 'vanilla';
    if (field.hidden) { el('create-submit').disabled = !el('create-version').value; return; }
    const select = el('create-loader-version');
    select.replaceChildren(new Option('Получаем версии…', ''));
    el('loader-version-hint').textContent = 'Ищем совместимые версии загрузчика…';
    el('create-submit').disabled = true;
    try {
      const versions = await api.getLoaderVersions(loader, el('create-version').value);
      if (token !== state.loaderRequest) return;
      select.replaceChildren();
      if (!versions.length) {
        select.add(new Option('Нет совместимой версии', ''));
        el('loader-version-hint').textContent = 'Попробуйте другую версию Minecraft или загрузчик.';
        return;
      }
      for (const item of versions.slice(0, 80)) select.add(new Option(item.id + (item.stable === false ? ' · beta' : ''), item.id));
      el('loader-version-hint').textContent = versions.length + ' совместимых версий';
      el('create-submit').disabled = false;
    } catch (error) {
      if (token !== state.loaderRequest) return;
      select.replaceChildren(new Option('Не удалось получить версии', ''));
      el('loader-version-hint').textContent = friendlyError(error);
    }
  }
  function openCreate() {
    if (!state.data) return;
    state.loaderRequest++;
    el('create-form').reset();
    state.loader = 'vanilla';
    state.versionKind = 'release';
    state.versionLimit = 24;
    el('version-search').value = '';
    for (const button of document.querySelectorAll('[data-loader]')) button.classList.toggle('is-selected', button.dataset.loader === 'vanilla');
    renderVersionOptions();
    el('loader-version-field').hidden = true;
    showDialog(el('create-dialog'));
    el('create-name').focus();
  }
  function openEdit(item) {
    if (!item) return;
    state.editingId = item.id;
    setText('instance-dialog-title', item.name);
    setText('instance-dialog-meta', loaderNames[item.loader] + ' · Minecraft ' + item.minecraftVersion);
    el('edit-name').value = item.name;
    el('edit-note').value = item.note || '';
    el('edit-memory-default').checked = item.memoryGb == null;
    el('edit-memory').value = item.memoryGb || state.data.settings.memoryGb;
    el('edit-memory').max = String(memoryMaximum());
    el('edit-memory').disabled = item.memoryGb == null;
    el('edit-java-auto').checked = !item.javaPath;
    el('edit-java-path').value = item.javaPath || '';
    el('edit-java-group').hidden = !item.javaPath;
    state.editAccent = item.accent || 'violet';
    renderAccentOptions();
    el('edit-favorite').checked = Boolean(item.favorite);
    renderCoverPreview(item);
    setText('edit-directory', item.directory);
    el('edit-directory').title = item.directory;
    showDialog(el('instance-dialog'));
  }
  function renderCoverPreview(item) {
    el('cover-preview').style.backgroundImage = item?.coverUrl ? 'url("' + item.coverUrl + '")' : '';
    el('cover-preview').classList.toggle('has-custom-cover', Boolean(item?.coverUrl));
    el('cover-preview').classList.remove('accent-violet', 'accent-blue', 'accent-rose', 'accent-amber');
    el('cover-preview').classList.add('accent-' + state.editAccent);
    el('reset-cover').disabled = !item?.coverUrl;
    el('edit-cover').disabled = Boolean(item?.legacy);
  }
  function renderAccentOptions() {
    for (const button of document.querySelectorAll('[data-accent]')) {
      button.classList.toggle('is-selected', button.dataset.accent === state.editAccent);
    }
  }
  function openQuickRename() {
    const item = selected();
    if (!item) return;
    el('hero-rename-input').value = item.name;
    el('hero-title-line').hidden = true;
    el('hero-rename-form').hidden = false;
    el('hero-rename-input').focus();
    el('hero-rename-input').select();
  }
  function closeQuickRename() {
    el('hero-rename-form').hidden = true;
    el('hero-title-line').hidden = false;
  }
  function hideLaunchStage() {
    const stage = el('launch-stage');
    if (stage.hidden) return;
    stage.classList.add('is-exiting');
    setTimeout(() => { stage.hidden = true; stage.classList.remove('is-exiting'); }, 300);
  }
  async function launchWithScene(item) {
    const stage = el('launch-stage');
    stage.classList.remove('is-exiting');
    el('launch-stage-image').style.backgroundImage = item.coverUrl ? 'url("' + item.coverUrl + '")' : '';
    setText('launch-stage-name', item.name);
    setText('launch-stage-message', 'Проверяем Java и файлы игры…');
    stage.hidden = false;
    const started = Date.now();
    const result = await action(() => api.launchInstance(item.id));
    if (result) {
      setText('launch-stage-message', 'Minecraft запущен. Хорошей игры.');
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 950 - (Date.now() - started))));
    }
    hideLaunchStage();
  }
  async function refreshLogs() {
    const content = await action(() => api.getLogs());
    if (content != null) setText('logs-content', content || 'Журнал пока пуст.');
  }
  function receive(event) {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'state') { state.data = event.state; render(); }
    if (event.type === 'progress') {
      if (state.data?.operation) state.data.operation.progress = event;
      renderHero();
      if (!el('launch-stage').hidden && state.data?.operation?.type === 'launch') {
        setText('launch-stage-message', event.message || 'Запускаем Minecraft…');
      }
    }
    if (event.type === 'status') {
      setText('footer-message', event.message || 'Готово');
      if (event.level === 'error') notice(event.message);
      if (event.level === 'success') toast(event.message);
    }
    if (event.type === 'error') notice(event.message || 'Неизвестная ошибка');
    if (event.type === 'game-crash') notice(event.message, true);
    if (event.type === 'log' && state.view === 'logs') refreshLogs();
  }
  function bind() {
    for (const icon of document.querySelectorAll('svg.icon')) {
      const name = icon.querySelector('use')?.getAttribute('href')?.replace('#i-', '');
      if (name) icon.dataset.motion = name;
    }
    document.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      const icon = button?.querySelector('svg.icon');
      if (!icon || button.disabled || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      if (icon.dataset.motion === 'settings' || icon.dataset.motion === 'refresh') {
        icon.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(180deg)' }], { duration: 600, easing: 'cubic-bezier(.16,1,.3,1)' });
      } else {
        icon.animate([{ scale: 1 }, { scale: .75, offset: .2 }, { scale: 1.2, offset: .55 }, { scale: 1 }], { duration: 460, easing: 'cubic-bezier(.2,.8,.2,1)' });
      }
    });
    for (const button of document.querySelectorAll('[data-view]')) {
      button.addEventListener('click', () => showView(button.dataset.view));
    }
    for (const id of ['create-top', 'create-empty']) el(id).addEventListener('click', openCreate);
    for (const button of document.querySelectorAll('[data-close]')) {
      button.addEventListener('click', () => closeDialog(el(button.dataset.close)));
    }
    for (const dialog of document.querySelectorAll('dialog')) {
      dialog.addEventListener('cancel', (event) => { event.preventDefault(); closeDialog(dialog); });
      let outsideDown = false;
      const outside = (event) => {
        const box = dialog.getBoundingClientRect();
        return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
      };
      dialog.addEventListener('pointerdown', event => { outsideDown = event.target === dialog && outside(event); });
      dialog.addEventListener('click', event => { if (outsideDown && outside(event)) closeDialog(dialog); outsideDown = false; });
    }
    for (const id of ['hero-card', 'home-instance-grid', 'all-instance-grid']) {
      el(id).addEventListener('contextmenu', event => {
        if (event.target.closest('[data-instance-id]') && id !== 'hero-card' || event.target.closest('input, textarea')) return;
        openContextMenu(event, id === 'hero-card' ? selected()?.id : null);
      });
    }
    document.addEventListener('pointerdown', event => {
      if (!event.target.closest('#build-context-menu')) hideContextMenu();
    });
    document.querySelector('.content').addEventListener('scroll', hideContextMenu);
    window.addEventListener('resize', hideContextMenu);
    el('build-context-menu').addEventListener('keydown', event => {
      const buttons = [...el('build-context-menu').querySelectorAll('button:not(:disabled)')];
      const index = buttons.indexOf(document.activeElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      } else if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault(); hideContextMenu(); state.contextAnchor?.focus();
      }
    });
    for (const key of ['transparency', 'brightness', 'blur']) {
      el('appearance-' + key).addEventListener('input', event => { state.appearanceDraft[key] = Number(event.target.value); renderAppearance(); });
    }
    for (const button of document.querySelectorAll('[data-atmosphere]')) {
      button.addEventListener('click', () => { state.appearanceDraft = { ...atmospherePresets[button.dataset.atmosphere] }; renderAppearance(); });
    }
    el('version-search').addEventListener('input', () => { state.versionLimit = 24; renderVersionTiles(); });
    el('version-search').addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); el('version-tiles').querySelector('button')?.click(); }
    });
    el('version-more').addEventListener('click', () => { state.versionLimit += 24; renderVersionTiles(); });
    for (const button of document.querySelectorAll('[data-version-kind]')) {
      button.addEventListener('click', async () => {
        state.versionKind = button.dataset.versionKind;
        state.versionLimit = 24;
        el('version-search').value = '';
        if (state.versionKind === 'snapshot' && !state.data.settings.showSnapshots) {
          const saved = await action(() => api.saveSettings({ showSnapshots: true }));
          if (!saved) return;
        }
        renderVersionOptions();
        if (!availableVersions().some(item => item.id === el('create-version').value && item.type === state.versionKind)) {
          el('create-version').value = availableVersions().find(item => item.type === state.versionKind)?.id || '';
          renderVersionTiles();
        }
        refreshLoaderOptions();
      });
    }
    el('search-input').addEventListener('input', renderCards);
    document.addEventListener('keydown', (event) => {
      if (event.ctrlKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        showView('instances');
        el('search-input').focus();
      } else if (event.key === 'F2' && selected() && !document.querySelector('dialog[open]') &&
        !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
        event.preventDefault();
        showView('home');
        openQuickRename();
      }
    });
    el('notice-close').addEventListener('click', () => { el('notice').hidden = true; });
    el('notice-report').addEventListener('click', () => action(() => api.openCrashReport()));
    for (const id of ['profile-rail', 'profile-top', 'settings-profile']) el(id).addEventListener('click', openProfile);
    for (const button of document.querySelectorAll('[data-account-mode]')) {
      button.addEventListener('click', async () => {
        state.profileTab = button.dataset.accountMode;
        renderProfile();
        if (state.profileTab === 'local') {
          await profileAction(() => api.cancelMicrosoftLogin());
          await profileAction(() => api.selectAccount('local'));
          el('profile-name-input').value = state.data.settings.playerName;
          el('profile-name-input').focus();
          el('profile-name-input').select();
        } else if (state.data.account.microsoft) await profileAction(() => api.selectAccount('microsoft'));
        else if (!state.data.account.configured) el('microsoft-setup').open = true;
      });
    }
    el('profile-name-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const saved = await profileAction(() => api.saveSettings({ playerName: el('profile-name-input').value.trim() }));
      if (saved) {
        await profileAction(() => api.selectAccount('local'));
        el('player-name').value = state.data.settings.playerName;
        closeDialog(el('profile-dialog'));
        toast('Ник сохранён: ' + state.data.settings.playerName);
      }
    });
    el('profile-dialog').addEventListener('close', () => {
      if (state.data?.account.auth.busy) api.cancelMicrosoftLogin().catch(() => {});
    });
    el('microsoft-start').addEventListener('click', async () => {
      const started = await profileAction(() => api.startMicrosoftLogin());
      if (started) await profileAction(() => api.openAccountLink('login'));
    });
    el('microsoft-browser').addEventListener('click', () => profileAction(() => api.openAccountLink('login')));
    el('microsoft-copy').addEventListener('click', async () => {
      await profileAction(() => api.copyLoginCode());
      toast('Код скопирован');
    });
    el('microsoft-cancel').addEventListener('click', () => profileAction(() => api.cancelMicrosoftLogin()));
    el('microsoft-logout').addEventListener('click', () => profileAction(() => api.logoutMicrosoft()));
    el('microsoft-refresh').addEventListener('click', async () => {
      el('microsoft-refresh').disabled = true;
      try {
        const refreshed = await profileAction(() => api.refreshAccount());
        if (refreshed) toast('Профиль Minecraft обновлён');
      } finally { el('microsoft-refresh').disabled = false; }
    });
    el('microsoft-name-change').addEventListener('click', () => profileAction(() => api.openAccountLink('profile')));
    el('microsoft-setup-help').addEventListener('click', () => profileAction(() => api.openAccountLink('setup')));
    el('microsoft-config-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const saved = await profileAction(() => api.saveMicrosoftClientId(el('microsoft-client-id').value.trim()));
      if (saved) {
        renderProfile();
        el('microsoft-setup').open = !state.data.account.configured;
        toast('Настройка Microsoft сохранена');
      }
    });
    el('window-minimize').addEventListener('click', () => action(() => api.minimizeWindow()));
    el('window-maximize').addEventListener('click', () => action(() => api.maximizeWindow()));
    el('window-close').addEventListener('click', () => action(() => api.closeWindow()));
    el('main-action').addEventListener('click', () => {
      const item = selected();
      if (item) {
        if (state.data.runningInstanceId === item.id) action(() => api.stopGame());
        else if (item.installed) launchWithScene(item);
        else action(() => api.installInstance(item.id));
      }
    });
    el('stop-game-footer').addEventListener('click', () => action(() => api.stopGame()));
    el('launch-stage-dismiss').addEventListener('click', hideLaunchStage);
    el('hero-folder').addEventListener('click', () => { const item = selected(); if (item) action(() => api.openInstanceFolder(item.id)); });
    el('hero-edit').addEventListener('click', () => openEdit(selected()));
    el('hero-rename').addEventListener('click', openQuickRename);
    el('hero-rename-cancel').addEventListener('click', closeQuickRename);
    el('hero-rename-input').addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); closeQuickRename(); }
    });
    el('hero-rename-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const item = selected();
      if (!item) return closeQuickRename();
      const updated = await action(() => api.updateInstance(item.id, { name: el('hero-rename-input').value.trim() }));
      if (updated) { closeQuickRename(); toast('Название изменено'); }
    });
    const hero = el('hero-card');
    hero.addEventListener('pointermove', (event) => {
      if (event.pointerType !== 'mouse' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const box = hero.getBoundingClientRect();
      const x = ((event.clientX - box.left) / box.width - .5) * 18;
      const y = ((event.clientY - box.top) / box.height - .5) * 14;
      hero.style.setProperty('--scene-x', x.toFixed(1) + 'px');
      hero.style.setProperty('--scene-y', y.toFixed(1) + 'px');
    });
    hero.addEventListener('pointerleave', () => {
      hero.style.setProperty('--scene-x', '0px');
      hero.style.setProperty('--scene-y', '0px');
    });
    el('cancel-operation').addEventListener('click', async () => {
      await action(() => api.cancelOperation());
      el('cancel-operation').disabled = true;
      setText('progress-message', 'Отменяем…');
    });
    for (const button of document.querySelectorAll('[data-loader]')) {
      button.addEventListener('click', () => {
        state.loader = button.dataset.loader;
        for (const peer of document.querySelectorAll('[data-loader]')) peer.classList.toggle('is-selected', peer === button);
        refreshLoaderOptions();
      });
    }
    el('create-version').addEventListener('change', () => { renderVersionTiles(); refreshLoaderOptions(); });
    el('create-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (state.busy) return;
      state.busy = true;
      el('create-submit').disabled = true;
      const input = {
        name: el('create-name').value.trim(),
        minecraftVersion: el('create-version').value,
        loader: state.loader,
        loaderVersion: state.loader === 'vanilla' ? '' : el('create-loader-version').value,
      };
      const result = await action(() => api.createInstance(input));
      state.busy = false;
      if (result) {
        closeDialog(el('create-dialog'));
        showView('home');
        action(() => api.installInstance(result.id));
      } else el('create-submit').disabled = false;
    });
    el('edit-memory-default').addEventListener('change', () => {
      el('edit-memory').disabled = el('edit-memory-default').checked;
    });
    el('edit-java-auto').addEventListener('change', () => {
      el('edit-java-group').hidden = el('edit-java-auto').checked;
    });
    el('edit-pick-java').addEventListener('click', async () => {
      const path = await action(() => api.pickJava());
      if (path) el('edit-java-path').value = path;
    });
    for (const button of document.querySelectorAll('[data-accent]')) {
      button.addEventListener('click', () => {
        state.editAccent = button.dataset.accent;
        renderAccentOptions();
        el('cover-preview').classList.remove('accent-violet', 'accent-blue', 'accent-rose', 'accent-amber');
        el('cover-preview').classList.add('accent-' + state.editAccent);
      });
    }
    el('edit-cover').addEventListener('click', async () => {
      const updated = await action(() => api.setInstanceCover(state.editingId));
      if (updated) {
        const item = instances().find((entry) => entry.id === state.editingId);
        renderCoverPreview(item);
      }
    });
    el('reset-cover').addEventListener('click', async () => {
      const updated = await action(() => api.resetInstanceCover(state.editingId));
      if (updated) {
        const item = instances().find((entry) => entry.id === state.editingId);
        renderCoverPreview(item);
      }
    });
    el('instance-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const id = state.editingId;
      const updated = await action(() => api.updateInstance(id, {
        name: el('edit-name').value.trim(),
        note: el('edit-note').value,
        memoryGb: el('edit-memory-default').checked ? null : Number(el('edit-memory').value),
        javaPath: el('edit-java-auto').checked ? '' : el('edit-java-path').value,
        accent: state.editAccent,
        favorite: el('edit-favorite').checked,
      }));
      if (updated) { closeDialog(el('instance-dialog')); toast('Настройки сборки сохранены'); }
    });
    el('edit-open-folder').addEventListener('click', () => action(() => api.openInstanceFolder(state.editingId)));
    el('remove-instance').addEventListener('click', () => {
      state.removingId = state.editingId;
      el('instance-dialog').close();
      showDialog(el('remove-dialog'));
    });
    el('confirm-remove').addEventListener('click', async () => {
      const removed = await action(() => api.removeInstance(state.removingId));
      if (removed) { closeDialog(el('remove-dialog')); toast('Сборка убрана из библиотеки'); }
    });
    el('java-auto').addEventListener('click', () => { state.javaMode = 'auto'; renderJavaMode(); });
    el('java-manual').addEventListener('click', () => { state.javaMode = 'manual'; renderJavaMode(); });
    el('pick-java').addEventListener('click', async () => {
      const path = await action(() => api.pickJava());
      if (path) el('java-path').value = path;
    });
    el('memory-gb').addEventListener('input', () => {
      el('memory-range').value = Math.min(memoryMaximum(), Math.max(1, Number(el('memory-gb').value) || 1));
    });
    el('memory-gb').addEventListener('change', () => {
      el('memory-gb').value = Math.min(memoryMaximum(), Math.max(1, Number(el('memory-gb').value) || 1));
    });
    el('memory-range').addEventListener('input', () => { el('memory-gb').value = el('memory-range').value; });
    for (const button of document.querySelectorAll('[data-memory]')) {
      button.addEventListener('click', () => { el('memory-gb').value = button.dataset.memory; el('memory-range').value = button.dataset.memory; });
    }
    el('save-settings').addEventListener('click', async () => {
      const saved = await action(() => api.saveSettings({
        playerName: el('player-name').value.trim(),
        memoryGb: Number(el('memory-gb').value),
        javaPath: state.javaMode === 'auto' ? '' : el('java-path').value,
        showSnapshots: el('show-snapshots').checked,
        appearance: state.appearanceDraft,
      }));
      if (saved) { renderSettings(); renderVersionOptions(); toast('Настройки сохранены'); }
    });
    for (const id of ['open-data-folder', 'settings-open-data']) el(id).addEventListener('click', () => action(() => api.openDataFolder()));
    el('reload-logs').addEventListener('click', refreshLogs);
  }
  async function initialize() {
    bind();
    api.onEvent(receive);
    const data = await action(() => api.getState());
    if (!data) return;
    state.data = data;
    render();
    setText('footer-message', 'Готов к игре');
    showView('home');
    if (!data.versions.length) await action(() => api.refreshVersions());
    action(() => api.scanJava());
    setInterval(() => { renderGreeting(); renderPlaytime(); }, 1000);
  }
  initialize();
})();
