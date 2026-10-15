(() => {
  'use strict';

  const api = window.launcher;
  const el = (id) => document.getElementById(id);
  const state = { data: null, view: 'home', loader: 'vanilla', loaderRequest: 0, editingId: '', editAccent: 'violet', removingId: '', toastTimer: null, busy: false, javaMode: 'auto', profileTab: 'local' };
  // Microsoft integration is retained while its public interface is paused.
  const MICROSOFT_UI_ENABLED = false;
  const loaderNames = { vanilla: 'Vanilla', fabric: 'Fabric', neoforge: 'NeoForge', forge: 'Forge' };
  const loaderLabel = item => (loaderNames[item.loader] || item.loader) + (item.loader !== 'vanilla' && item.loaderVersion ? ' ' + item.loaderVersion : '');
  const loaderIcon = (loader) => '../assets/brands/' + ({ vanilla: 'minecraft', fabric: 'fabric', neoforge: 'neoforge', forge: 'forge' }[loader] || 'minecraft') + '.png';
  const icon = (name) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('icon');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
  };
  const friendlyError = (error) => String(error && error.message ? error.message : error || 'Неизвестная ошибка').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  const instances = () => state.data?.instances || [];
  const selected = () => instances().find((item) => item.id === state.data?.settings.selectedInstanceId) || instances()[0] || null;
  const setText = (id, value) => { if (el(id).textContent !== String(value)) el(id).textContent = String(value); };
  const countText = (n) => n + ' ' + (n % 10 === 1 && n % 100 !== 11 ? 'сборка' : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'сборки' : 'сборок'));
  const memoryMaximum = () => Math.max(1, Number(state.data?.maxMemoryGb) || 16);
  const viewTitles = { home: 'Главная', instances: 'Сборки', server: 'Сервер', trophies: 'Достижения', logs: 'Журнал', settings: 'Настройки' };
  const hoursText = (ms) => ms >= 3600000 ? Math.floor(ms / 3600000) + 'ч' : ms >= 60000 ? Math.floor(ms / 60000) + 'м' : '';

  function notice(message, crash = false) {
    setText('notice-text', message);
    el('notice').hidden = false;
    el('notice-report').hidden = !crash;
  }
  function toast(message, undo = null) {
    setText('toast-text', message);
    el('toast').hidden = false;
    state.toastUndo = undo;
    el('toast-undo').hidden = !undo;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { el('toast').hidden = true; }, 3800);
  }
  async function action(callback) {
    try { return await callback(); }
    catch (error) { const form = [...document.querySelectorAll('dialog[open]')].at(-1)?.querySelector('form'); if (form) window.veyraValidation.alert(form, friendlyError(error)); else notice(friendlyError(error)); return null; }
  }
  // Незавершённый переход сворачивается сразу: быстрые нажатия не накладывают разделы друг на друга.
  function settleView() {
    const motion = state.viewMotion;
    if (!motion) return;
    state.viewMotion = null;
    for (const animation of motion.animations) animation.cancel();
    motion.leaving.classList.remove('is-leaving');
    motion.leaving.inert = false;
    for (const key of ['top', 'left', 'width']) motion.leaving.style.removeProperty(key);
    if (motion.leaving.dataset.page !== state.view) motion.leaving.hidden = true;
    document.querySelector('.content').classList.remove('is-switching');
  }
  function showView(view) {
    hideContextMenu();
    settleView();
    const content = document.querySelector('.content'), pages = [...document.querySelectorAll('[data-page]')];
    const order = [...document.querySelectorAll('.rail-nav .rail-button')].map(button => button.dataset.view);
    const forward = order.indexOf(view) >= order.indexOf(state.view) ? 1 : -1;
    // Прежний раздел запоминает своё место до сброса прокрутки и уезжает поверх нового.
    const leaving = state.view !== view && !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? pages.find(page => page.dataset.page === state.view && !page.hidden) : null;
    const place = leaving && { page: leaving.getBoundingClientRect(), content: content.getBoundingClientRect() };
    if (state.view !== view) content.scrollTop = 0;
    if (state.view === 'settings' && view !== 'settings') applyAppearance(state.data?.settings.appearance);
    state.view = view;
    for (const page of pages) {
      const active = page.dataset.page === view;
      page.hidden = !active;
      page.classList.toggle('is-visible', active);
    }
    if (leaving) {
      const entering = pages.find(page => page.dataset.page === view);
      leaving.hidden = false;
      leaving.inert = true;
      leaving.classList.add('is-leaving');
      Object.assign(leaving.style, { top: place.page.top - place.content.top + 'px', left: place.page.left - place.content.left + 'px', width: place.page.width + 'px' });
      content.classList.add('is-switching');
      const animations = [
        leaving.animate([{ opacity: 1, transform: 'translateX(0)' }, { opacity: 0, transform: 'translateX(' + -28 * forward + 'px)' }], { duration: 200, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }),
        entering.animate([{ opacity: 0, transform: 'translateX(' + 28 * forward + 'px)' }, { opacity: 1, transform: 'translateX(0)' }], { duration: 240, easing: 'cubic-bezier(.16,1,.3,1)' }),
      ];
      state.viewMotion = { leaving, animations };
      animations[1].finished.then(settleView, () => {});
    }
    for (const button of document.querySelectorAll('.rail-button')) {
      button.classList.toggle('is-active', button.dataset.view === view);
    }
    const navButtons = [...document.querySelectorAll('.rail-nav .rail-button')];
    const currentButton = navButtons.find((button) => button.dataset.view === view);
    el('rail-nav').style.setProperty('--nav-x', (currentButton?.offsetLeft || 0) + 'px');
    setText('view-title', viewTitles[view]);
    el('search-input').closest('.search-box').hidden = view !== 'home' && view !== 'instances';
    if (view === 'logs') refreshLogs();
    if (view === 'settings') renderSettings();
    if (view === 'instances' || view === 'home') renderCards();
    window.dispatchEvent(new CustomEvent('veyra:view', { detail: { view } }));
  }
  function filteredInstances() {
    const query = el('search-input').value.trim().toLowerCase();
    return instances().filter((item) => !query ||
      (item.name + ' ' + item.minecraftVersion + ' ' + loaderLabel(item)).toLowerCase().includes(query))
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
    button.dataset.tip = 'Новая сборка';
    button.dataset.tipLore = 'Своя версия, загрузчик и папка';
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
    loaderText.textContent = loaderLabel(instance);
    pill.title = loaderLabel(instance);
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
    // На полке главной подпись короткая, в разделе сборок — полная.
    for (const [className, text] of [['state-long', instance.installed ? 'Готов к игре' : 'Нужна установка'], ['state-short', instance.installed ? 'Готов' : 'Не скачана']]) {
      const part = document.createElement('span');
      part.className = className;
      part.textContent = text;
      status.append(part);
    }
    content.append(top, name, version, status);
    const hours = document.createElement('span');
    hours.className = 'instance-hours';
    hours.textContent = hoursText(instance.playedMs || 0);
    button.append(art, shade, content, hours);
    button.dataset.tip = instance.name;
    button.dataset.tipLore = [loaderLabel(instance) + ' · Minecraft ' + instance.minecraftVersion, instance.installed ? 'Готов к игре' : 'Нужна установка',
      instance.playedMs >= 60000 ? 'Сыграно: ' + duration(instance.playedMs) : 'Впереди первая игра', 'ПКМ — действия'].join('\n');
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
    for (const [id, limit] of [['home-instance-grid', 6], ['all-instance-grid', Infinity]]) {
      const grid = el(id);
      const current = new Map([...grid.querySelectorAll('[data-instance-id]')].map(card => [card.dataset.instanceId, card]));
      const ordered = [];
      for (const [index, instance] of items.slice(0, limit).entries()) {
        const signature = JSON.stringify([instance.name, instance.accent, instance.coverUrl, instance.favorite, instance.installed, instance.loader, instance.loaderVersion, instance.minecraftVersion, hoursText(instance.playedMs || 0)]);
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
    syncHeroName(item);
    if (state.launchingId && state.launchingId !== item?.id) hideLaunchStage();
    el('hero-empty').hidden = Boolean(item);
    el('hero-active').hidden = !item;
    if (!item) {
      closeQuickRename();
      el('hero-image').style.backgroundImage = '';
      for (const id of ['detail-folder', 'capsule-last']) setText(id, '—');
      setText('detail-java', 'Авто');
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
    el('hero-loader').querySelector('img').src = loaderIcon(item.loader);
    el('hero-loader').querySelector('span').textContent = loaderLabel(item);
    el('hero-loader').title = loaderLabel(item);
    el('hero-version').querySelector('span').textContent = 'Minecraft ' + item.minecraftVersion;
    setText('hero-description', item.installed
      ? 'Сборка готова. Моды, сохранения и настройки останутся внутри этой сборки.'
      : 'Сборка создана. Установите игру, чтобы начать.');
    setText('detail-java', item.javaPath || state.data.settings.javaPath ? 'Своя' : 'Авто');
    setText('detail-memory', (item.memoryGb || state.data.settings.memoryGb) + ' ГБ');
    setText('detail-folder', item.legacy ? 'Старая' : 'Своя');
    el('detail-folder').title = item.directory;
    setText('capsule-note', item.note || 'Оставьте здесь цель или напоминание для этой сборки.');
    el('capsule-note').title = item.note || '';
    setText('capsule-launches', item.launchCount || 0);
    setText('capsule-last', item.lastPlayedAt
      ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(new Date(item.lastPlayedAt))
      : '—');
    const operation = state.data.operation;
    const running = (state.data.runningClients || []).some(run => run.instanceId === item.id);
    const stopping = running && state.data.stoppingGame;
    const working = operation?.instanceId === item.id;
    setText('main-action-label', working ? (operation.type === 'launch' ? 'Запускаем…' : operation.type === 'content' ? 'Меняем содержимое…' : 'Устанавливаем…') :
      (stopping ? 'Останавливаем…' : (running ? 'Остановить игру' : (item.installed ? 'Играть' : 'Установить'))));
    el('main-action-icon').querySelector('use').setAttribute('href', '#i-' + (running ? 'stop' : (item.installed ? 'play' : 'download')));
    el('main-action').classList.toggle('button-danger', running);
    el('main-action').classList.toggle('button-primary', !running);
    el('main-action').disabled = Boolean(operation || stopping || (!item.installed && (state.data.runningInstanceId || state.data.server?.pid && !['stopped','error'].includes(state.data.server.status))));
    el('hero-multi').disabled = Boolean(operation || !item.installed);
    el('hero-edit').disabled = working;
    el('hero-console').hidden = state.data.installConsole?.instanceId !== item.id;
    const box = el('progress-box');
    box.hidden = !working || operation.type !== 'install';
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
    state.nicknameAny = settings.allowAnySymbols;
    renderNicknameRules();
    setText('settings-account-status', (MICROSOFT_UI_ENABLED && state.data.account.mode === 'microsoft' ? 'Microsoft · ' : '') + state.data.account.name);
    const maximum = memoryMaximum();
    el('memory-gb').max = String(maximum);
    el('memory-range').max = String(maximum);
    el('memory-gb').value = settings.memoryGb;
    el('memory-range').value = settings.memoryGb;
    setText('memory-limit-hint', 'На компьютере ' + state.data.systemMemoryGb + ' ГБ. Лимит для игры — ' + maximum + ' ГБ; 2 ГБ оставляем системе.');
    renderMemoryBlocks();
    for (const button of document.querySelectorAll('[data-memory]')) button.disabled = Number(button.dataset.memory) > maximum;
    el('show-snapshots').checked = settings.showSnapshots;
    el('discord-enabled').checked = settings.discordEnabled;
    renderDiscord();
    el('java-path').value = settings.javaPath || '';
    state.javaMode = settings.javaPath ? 'manual' : 'auto';
    renderJavaMode();
    renderJavaCandidates();
    setText('data-path', state.data.instancesDirectory);
    el('data-path').title = state.data.instancesDirectory;
    state.appearanceDraft = { ...settings.appearance };
    renderAppearance();
  }
  function renderMemoryBlocks() {
    const target = el('memory-blocks'), maximum = memoryMaximum(), value = Number(el('memory-gb').value) || 1;
    if (target.childElementCount !== Math.min(maximum, 32)) {
      target.replaceChildren();
      for (let amount = 1; amount <= Math.min(maximum, 32); amount++) {
        const block = document.createElement('button');
        block.type = 'button';
        block.dataset.memoryBlock = String(amount);
        block.setAttribute('aria-label', amount + ' ГБ');
        block.dataset.tip = amount + ' ГБ';
        block.addEventListener('click', () => { el('memory-gb').value = amount; el('memory-range').value = amount; renderMemoryBlocks(); });
        target.append(block);
      }
    }
    for (const block of target.children) block.classList.toggle('is-filled', Number(block.dataset.memoryBlock) <= value);
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
  function renderDiscord() {
    const value = state.data?.discordStatus || 'waiting';
    const labels = { disabled: 'Статус выключен', connecting: 'Подключаемся к Discord…', waiting: 'Откройте приложение Discord — подключимся автоматически', connected: 'Подключён · активность VeyraLauncher', error: 'Discord отклонил активность. Проверьте приложение в Developer Portal.' };
    setText('discord-status', labels[value] || labels.waiting);
    el('discord-status').classList.toggle('is-connected', value === 'connected');
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
    setText('stop-game-footer-label', state.data.stoppingGame ? 'Останавливаем…' : state.data.runningClients?.length > 1 ? 'Остановить все · ' + state.data.runningClients.length : 'Остановить игру');
    renderHero();
    renderCards();
    renderInstallConsole();
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
    setText('rail-profile-initial', Array.from(account.name)[0]?.toUpperCase() || 'P');
    setText('profile-avatar', Array.from(account.name)[0]?.toUpperCase() || 'P');
    setText('profile-active-name', account.name);
    setText('profile-active-mode', account.mode === 'microsoft' ? (MICROSOFT_UI_ENABLED ? 'Microsoft · Minecraft Java' : 'Игровой профиль') : 'Локальный профиль');
    el('profile-rail').dataset.tipLore = account.name;
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
    state.nicknameAny = state.data.settings.allowAnySymbols;
    renderNicknameRules();
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
      subtitle.textContent = index === 0 && !query ? (kind === 'snapshot' ? 'Новый Snapshot' : 'Последняя') : (kind === 'snapshot' ? 'Snapshot' : 'Релиз');
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
    renderRecipe();
    for (const button of document.querySelectorAll('[data-version-kind]')) {
      button.classList.toggle('is-active', button.dataset.versionKind === kind);
      button.setAttribute('aria-pressed', String(button.dataset.versionKind === kind));
    }
  }
  function renderRecipe() {
    const version = el('create-version').value;
    setText('recipe-version-label', version || '—');
    el('recipe-version').classList.toggle('is-empty', !version);
    el('recipe-loader-icon').src = loaderIcon(state.loader);
    setText('recipe-loader-label', loaderNames[state.loader] + (state.loader !== 'vanilla' && el('create-loader-version').value ? ' ' + el('create-loader-version').value : ''));
    setText('recipe-result-label', el('create-name').value.trim() || suggestedName());
    el('recipe-result').classList.toggle('is-ready', !el('create-submit').disabled);
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
    for (const input of dialog.querySelectorAll('[aria-invalid]')) window.veyraValidation.clear(input);
    dialog.querySelector('.form-alert')?.setAttribute('hidden', '');
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
    root.style.setProperty('--background-picture', value.picture === false ? 0 : .1);
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
    preview.classList.toggle('without-picture', value.picture === false);
    el('appearance-blur').disabled = value.picture === false;
    for (const button of document.querySelectorAll('[data-background-picture]')) {
      const active = (button.dataset.backgroundPicture === 'true') === (value.picture !== false);
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    for (const button of document.querySelectorAll('[data-atmosphere]')) {
      const preset = atmospherePresets[button.dataset.atmosphere];
      const active = Object.keys(preset).every(key => preset[key] === value[key]);
      button.classList.toggle('is-selected', active);
      button.setAttribute('aria-pressed', String(active));
    }
  }
  function finishNameTyping(value) {
    clearTimeout(state.nameTimer);
    state.nameTyping = false;
    el('hero-name').classList.remove('is-typing');
    if (value !== undefined) setText('hero-name', value);
  }
  function syncHeroName(item) {
    if (!item) { finishNameTyping(); state.nameInstanceId = ''; return; }
    if (state.nameInstanceId !== item.id) {
      finishNameTyping(item.name);
      state.nameInstanceId = item.id;
      state.nameActual = item.name;
      el('hero-name').setAttribute('aria-label', item.name);
      return;
    }
    if (state.nameActual === item.name) return;
    const previous = Array.from(el('hero-name').textContent);
    const next = Array.from(item.name);
    state.nameActual = item.name;
    finishNameTyping();
    el('hero-name').setAttribute('aria-label', item.name);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return finishNameTyping(item.name);
    state.nameTyping = true;
    el('hero-name').classList.add('is-typing');
    let removing = true;
    let typed = 0;
    const step = () => {
      if (removing) {
        previous.splice(Math.max(0, previous.length - Math.max(1, Math.ceil(previous.length / 15))));
        setText('hero-name', previous.join(''));
        if (!previous.length) removing = false;
        state.nameTimer = setTimeout(step, removing ? 18 : 100);
      } else {
        typed = Math.min(next.length, typed + Math.max(1, Math.ceil(next.length / 28)));
        setText('hero-name', next.slice(0, typed).join(''));
        if (typed < next.length) state.nameTimer = setTimeout(step, 24);
        else finishNameTyping(item.name);
      }
    };
    state.nameTimer = setTimeout(step, 60);
  }
  function renderNicknameRules() {
    const any = Boolean(state.nicknameAny);
    for (const id of ['profile-any-symbols', 'settings-any-symbols']) el(id).checked = any;
    for (const id of ['profile-name-input', 'player-name']) {
      const input = el(id);
      input.minLength = any ? 1 : 3;
      input.maxLength = any ? 64 : 16;
      if (any) input.removeAttribute('pattern'); else input.setAttribute('pattern', '[A-Za-z0-9_]{3,16}');
      validateNicknameInput(input);
    }
    const hint = any ? '1–32 символа: кириллица, пробелы, эмодзи. Сервер может ограничивать ник.' : '3–16 латинских букв, цифр или _. Enter сохраняет ник.';
    setText('profile-nickname-hint', hint);
    setText('settings-nickname-hint', hint);
  }
  function validateNicknameInput(input) {
    input.setCustomValidity(state.nicknameAny && (Array.from(input.value.trim()).length > 32 || /\p{Cc}/u.test(input.value)) ? 'Ник: не более 32 символов, без переносов строк' : '');
  }
  function renderLoaderTiles() {
    const target = el('loader-version-tiles');
    const query = el('loader-version-search').value.trim().toLowerCase();
    const versions = (state.loaderVersions || []).filter(item => item.id.toLowerCase().includes(query));
    target.replaceChildren();
    for (const item of versions.slice(0, state.loaderVersionLimit || 8)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'version-tile';
      button.dataset.loaderVersion = item.id;
      button.classList.toggle('is-selected', el('create-loader-version').value === item.id);
      button.setAttribute('aria-pressed', String(el('create-loader-version').value === item.id));
      const label = document.createElement('strong'); label.textContent = item.id;
      const hint = document.createElement('small'); hint.textContent = item.recommended ? 'Рекомендуется' : item.stable ? 'Стабильная' : 'Beta / preview';
      button.append(icon('check'), label, hint);
      button.addEventListener('click', () => {
        el('create-loader-version').value = item.id;
        setText('chosen-loader-version', item.id);
        for (const peer of target.querySelectorAll('button')) {
          peer.classList.toggle('is-selected', peer === button);
          peer.setAttribute('aria-pressed', String(peer === button));
        }
      });
      target.append(button);
    }
    setText('chosen-loader-version', el('create-loader-version').value || '');
    el('loader-version-more').hidden = versions.length <= (state.loaderVersionLimit || 8);
    renderRecipe();
  }
  function setConsoleVisible(visible) {
    const panel = el('install-scroll');
    const dashboard = panel.closest('.dashboard-grid');
    if (visible) {
      clearTimeout(state.consoleCloseTimer);
      panel.classList.remove('is-folding');
      panel.hidden = false;
      dashboard.classList.add('console-open');
    } else if (!panel.hidden && !panel.classList.contains('is-folding')) {
      panel.classList.add('is-folding');
      state.consoleCloseTimer = setTimeout(() => {
        panel.hidden = true;
        panel.classList.remove('is-folding');
        dashboard.classList.remove('console-open');
      }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 480);
    }
  }
  function renderInstallConsole() {
    const session = state.data.installConsole;
    const available = session && instances().some(item => item.id === session.instanceId);
    el('console-footer').hidden = !available;
    if (!session) return setConsoleVisible(false);
    if (state.consoleId !== session.id) {
      state.consoleId = session.id;
      state.consoleOpen = session.live;
      state.consolePaused = false;
      state.consoleFollow = true;
      state.consoleRenderedSequence = 0;
      el('install-console-output').replaceChildren();
    }
    const item = instances().find(item => item.id === session.instanceId);
    setText('console-build-name', item?.name || 'Сборка');
    setText('console-status', session.live ? 'Устанавливаем' : ({ success: 'Готово', cancelled: 'Отменено', error: 'Ошибка установки' }[session.outcome] || 'Завершено'));
    el('console-live').classList.toggle('is-live', session.live);
    setConsoleVisible(Boolean(state.consoleOpen && session.instanceId === selected()?.id));
    renderConsoleContent();
  }
  function scheduleConsoleRender() {
    if (state.consoleRenderTimer) return;
    state.consoleRenderTimer = setTimeout(() => { state.consoleRenderTimer = null; renderConsoleContent(); }, 60);
  }
  function renderConsoleContent() {
    const session = state.data?.installConsole;
    if (!session) return;
    const lines = session.lines;
    const last = lines.at(-1)?.sequence || 0;
    setText('console-line-count', last + ' строк' + (last > 400 ? ' · последние 400' : ''));
    el('console-copy').disabled = !lines.length;
    el('console-pause').setAttribute('aria-pressed', String(Boolean(state.consolePaused)));
    el('console-pause').querySelector('span').textContent = state.consolePaused ? 'Продолжить' : 'Пауза';
    el('console-pause').querySelector('use').setAttribute('href', '#i-' + (state.consolePaused ? 'play' : 'pause'));
    if (state.consolePaused || el('install-scroll').hidden) return;
    const output = el('install-console-output');
    const fragment = document.createDocumentFragment();
    for (const line of lines.filter(line => line.sequence > (state.consoleRenderedSequence || 0))) {
      const row = document.createElement('span');
      row.className = 'console-line source-' + line.source;
      row.title = line.source;
      const timestamp = document.createElement('span');
      timestamp.className = 'console-timestamp';
      timestamp.textContent = new Date(line.time).toLocaleTimeString('ru-RU', { hour12: false }) + ' ';
      row.append(timestamp, document.createTextNode(line.text + '\n'));
      fragment.append(row);
      state.consoleRenderedSequence = line.sequence;
    }
    output.append(fragment);
    while (output.childElementCount > 400) output.firstElementChild.remove();
    if (state.consoleFollow) {
      state.consoleAutoScroll = true;
      output.scrollTop = output.scrollHeight;
      requestAnimationFrame(() => { state.consoleAutoScroll = false; });
    }
  }
  async function revealConsole() {
    const session = state.data.installConsole;
    if (!session) return;
    const result = await action(() => api.selectInstance(session.instanceId));
    if (!result) return;
    showView('home');
    state.consoleOpen = true;
    renderInstallConsole();
  }
  function hideContextMenu() { el('build-context-menu').hidden = true; }
  function openContextMenu(event, id) {
    const item = instances().find(entry => entry.id === id);
    showMenu(event, item?.name || 'Библиотека', item ? [
      [(state.data.runningClients || []).some(run => run.instanceId === id) ? 'stop' : item.installed ? 'play' : 'download', (state.data.runningClients || []).some(run => run.instanceId === id) ? 'Остановить клиентов' : item.installed ? 'Играть' : 'Установить', async () => {
        await api.selectInstance(id); showView('home');
        if ((state.data.runningClients || []).some(run => run.instanceId === id)) await api.stopGame('', id);
        else if (item.installed) await launchWithScene(item); else await api.installInstance(id);
      }, Boolean(state.data.operation || state.data.stoppingGame)],
      ['edit', 'Переименовать', async () => { await api.selectInstance(id); showView('home'); openQuickRename(); }],
      ['image', 'Сменить обложку', () => api.setInstanceCover(id), Boolean(item.legacy)],
      ['puzzle', 'Моды и содержимое', () => window.dispatchEvent(new CustomEvent('veyra:content-open', { detail: { id } }))],
      ['star', item.favorite ? 'Убрать из избранного' : 'В избранное', () => api.updateInstance(id, { favorite: !item.favorite })],
      ['folder', 'Открыть папку', () => api.openInstanceFolder(id)],
      ['settings', 'Настройки сборки', () => openEdit(item)],
      ['trash', 'Удалить сборку', () => { state.removingId = id; showDialog(el('remove-dialog')); }, Boolean(state.data.operation?.instanceId === id || state.data.runningInstanceId === id)],
    ] : [['plus', 'Новая сборка', openCreate], ['folder', 'Папка сборок', () => api.openDataFolder()]]);
  }
  // Общее меню по правой кнопке: заголовок и пункты [иконка, подпись, действие, недоступен].
  function showMenu(event, title, entries) {
    event.preventDefault();
    if (document.querySelector('dialog[open]')) return;
    const menu = el('build-context-menu');
    menu.replaceChildren();
    const heading = document.createElement('p');
    heading.className = 'context-heading';
    heading.textContent = title;
    menu.append(heading);
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
    if (field.hidden) { el('create-submit').disabled = !el('create-version').value; renderRecipe(); return; }
    const select = el('create-loader-version');
    state.loaderVersions = [];
    state.loaderVersionLimit = 8;
    el('loader-version-search').value = '';
    select.replaceChildren(new Option('Получаем версии…', ''));
    el('loader-version-hint').textContent = 'Ищем совместимые версии загрузчика…';
    el('create-submit').disabled = true;
    renderLoaderTiles();
    try {
      const versions = await api.getLoaderVersions(loader, el('create-version').value);
      if (token !== state.loaderRequest) return;
      select.replaceChildren();
      state.loaderVersions = versions;
      if (!versions.length) {
        select.add(new Option('Нет совместимой версии', ''));
        el('loader-version-hint').textContent = 'Попробуйте другую версию Minecraft или загрузчик.';
        renderLoaderTiles();
        return;
      }
      for (const item of versions) select.add(new Option(item.label || item.id, item.id));
      select.value = (versions.find(item => item.recommended) || versions.find(item => item.stable) || versions[0]).id;
      renderLoaderTiles();
      el('loader-version-hint').textContent = versions.length + ' совместимых версий';
      el('create-submit').disabled = false;
      renderRecipe();
    } catch (error) {
      if (token !== state.loaderRequest) return;
      select.replaceChildren(new Option('Не удалось получить версии', ''));
      el('loader-version-hint').textContent = friendlyError(error);
      renderLoaderTiles();
    }
  }
  function openCreate() {
    if (!state.data) return;
    state.loaderRequest++;
    el('create-form').reset();
    el('create-name').placeholder = suggestedName();
    setText('create-name-hint', 'Если оставить пустым: ' + suggestedName());
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
    setText('instance-dialog-meta', loaderLabel(item) + ' · Minecraft ' + item.minecraftVersion);
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
    state.editBackground = item.backgroundId || 'default';
    state.editUsePreset = false;
    state.editCustomUrl = item.coverFile ? item.coverUrl : '';
    state.studioCoverKey = '';
    el('studio-error').hidden = true;
    setStudioTab('design');
    renderBackgroundGallery();
    renderAccentOptions();
    el('edit-favorite').checked = Boolean(item.favorite);
    renderCoverPreview(item);
    renderStudioText();
    setText('studio-memory-hint', 'На этом ПК до ' + memoryMaximum() + ' ГБ для игры.');
    setText('edit-directory', item.directory);
    el('edit-directory').title = item.directory;
    showDialog(el('instance-dialog'));
  }
  function renderCoverPreview(item) {
    const background = state.data.backgrounds.find(entry => entry.id === state.editBackground) || state.data.backgrounds[0];
    const custom = !state.editUsePreset && state.editCustomUrl;
    const url = custom || background.url;
    const art = el('cover-preview');
    if (state.studioCoverKey !== url) {
      const old = art.cloneNode(false); old.removeAttribute('id'); old.className = 'studio-art studio-art-outgoing';
      for (const layer of el('studio-scene').querySelectorAll('.studio-art-outgoing')) layer.remove();
      if (state.studioCoverKey && el('instance-dialog').open) { art.before(old); setTimeout(() => old.remove(), 710); }
      art.style.backgroundImage = 'url("' + url + '")';
      art.classList.remove('studio-art-incoming'); void art.offsetWidth; art.classList.add('studio-art-incoming');
      state.studioCoverKey = url;
    }
    setText('studio-cover-name', custom ? 'Своя обложка' : background.name);
    el('studio-scene').classList.remove('accent-violet', 'accent-blue', 'accent-rose', 'accent-amber');
    el('studio-scene').classList.add('accent-' + state.editAccent);
    el('reset-cover').hidden = !item?.coverFile;
    el('edit-cover').disabled = Boolean(item?.legacy);
    for (const button of el('background-gallery').children) {
      const active = !custom && button.dataset.backgroundId === state.editBackground;
      button.classList.toggle('is-selected', active); button.setAttribute('aria-pressed', String(active));
    }
  }
  function renderBackgroundGallery() {
    const gallery = el('background-gallery'); gallery.replaceChildren();
    for (const [i, background] of state.data.backgrounds.entries()) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'studio-background'; button.dataset.backgroundId = background.id;
      button.title = background.name; button.style.setProperty('--tile-order', i);
      const image = document.createElement('img'); image.src = background.thumbnail; image.alt = ''; image.draggable = false;
      const label = document.createElement('span'); label.textContent = background.name;
      button.append(image, label, icon('check'));
      button.addEventListener('click', () => chooseBackground(background.id));
      gallery.append(button);
    }
  }
  function chooseBackground(id) {
    state.editBackground = id; state.editUsePreset = true;
    renderCoverPreview(instances().find(item => item.id === state.editingId));
  }
  function setStudioTab(tab) {
    for (const button of document.querySelectorAll('[data-studio-tab]')) { const active = button.dataset.studioTab === tab; button.classList.toggle('is-active', active); button.setAttribute('aria-pressed', String(active)); }
    for (const panel of document.querySelectorAll('[data-studio-panel]')) panel.hidden = panel.dataset.studioPanel !== tab;
    el('studio-error').hidden = true;
    if (tab === 'shots') loadShots();
  }
  async function loadShots() {
    const id = state.editingId, grid = el('shots-grid');
    const item = instances().find(entry => entry.id === id);
    const shots = await studioAction(() => api.getScreenshots(id));
    if (!shots || id !== state.editingId) return;
    const starred = shots.filter(shot => shot.favorite).length;
    setText('shots-hint', shots.length ? 'Кадров: ' + shots.length + (starred ? ' · избранных: ' + starred : '') + ' · любой можно сделать обложкой' : 'Кадры из папки screenshots этой сборки');
    grid.replaceChildren();
    if (!shots.length) {
      const empty = document.createElement('div');
      empty.className = 'shots-empty';
      const title = document.createElement('strong'); title.textContent = 'Пока нет скриншотов';
      const hint = document.createElement('p'); hint.textContent = 'Нажмите F2 в игре — кадры появятся здесь, и любой можно сделать обложкой сборки.';
      empty.append(icon('camera'), title, hint);
      grid.append(empty);
      return;
    }
    for (const shot of shots) {
      const card = document.createElement('figure');
      card.className = 'shot' + (shot.favorite ? ' is-favorite' : '');
      const image = document.createElement('img'); image.src = shot.url; image.alt = ''; image.loading = 'lazy'; image.draggable = false;
      const caption = document.createElement('figcaption');
      caption.textContent = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(shot.time));
      const actions = document.createElement('div');
      const cover = document.createElement('button'); cover.type = 'button'; cover.className = 'button button-primary'; cover.textContent = 'Сделать обложкой'; cover.disabled = Boolean(item?.legacy);
      cover.addEventListener('click', async () => {
        const updated = await studioAction(() => api.coverFromScreenshot(id, shot.name));
        if (!updated) return;
        state.editCustomUrl = instances().find(entry => entry.id === id)?.coverUrl || ''; state.editUsePreset = false;
        renderCoverPreview(instances().find(entry => entry.id === id));
        toast('Скриншот стал обложкой');
      });
      const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'button button-secondary shot-copy'; copy.textContent = 'Скопировать';
      copy.addEventListener('click', async () => { if (await studioAction(() => api.copyScreenshot(id, shot.name))) toast('Скриншот скопирован'); });
      const star = document.createElement('button'); star.type = 'button'; star.className = 'button-icon shot-star' + (shot.favorite ? ' is-active' : '');
      star.dataset.tip = shot.favorite ? 'Убрать из избранного' : 'В избранное'; star.setAttribute('aria-label', star.dataset.tip); star.setAttribute('aria-pressed', String(Boolean(shot.favorite))); star.append(icon('star'));
      // Избранные кадры встают первыми, поэтому список перечитывается.
      star.addEventListener('click', async () => { if (await studioAction(() => api.favoriteScreenshot(id, shot.name, !shot.favorite))) loadShots(); });
      const open = document.createElement('button'); open.type = 'button'; open.className = 'button-icon'; open.dataset.tip = 'Открыть скриншот'; open.setAttribute('aria-label', 'Открыть скриншот'); open.append(icon('image'));
      open.addEventListener('click', () => studioAction(() => api.openScreenshot(id, shot.name)));
      actions.append(cover, copy, star, open);
      card.append(image, caption, actions);
      grid.append(card);
    }
  }
  function renderStudioText() {
    setText('instance-dialog-title', el('edit-name').value.trim() || suggestedName(state.editingId));
    setText('studio-note-preview', el('edit-note').value);
    const memory = el('edit-memory-default').checked ? state.data.settings.memoryGb : el('edit-memory').value;
    setText('studio-memory-preview', memory + ' ГБ памяти');
    setText('studio-java-preview', el('edit-java-auto').checked ? 'Java Auto' : 'Своя Java');
  }
  async function studioAction(callback) {
    try { el('studio-error').hidden = true; return await callback(); }
    catch (error) { setText('studio-error', friendlyError(error)); el('studio-error').hidden = false; return null; }
  }
  function suggestedName(excludeId = '') {
    const used = new Set(instances().filter(item => item.id !== excludeId).map(item => item.name.toLocaleLowerCase('ru')));
    let number = 1, name = 'Сборка'; while (used.has(name.toLocaleLowerCase('ru'))) name = 'Сборка ' + ++number;
    return name;
  }
  function renderAccentOptions() {
    for (const button of document.querySelectorAll('[data-accent]')) {
      button.classList.toggle('is-selected', button.dataset.accent === state.editAccent);
    }
  }
  function openQuickRename() {
    const item = selected();
    if (!item) return;
    finishNameTyping(item.name);
    window.veyraValidation.clear(el('hero-rename-input'));
    el('hero-rename-input').value = item.name;
    el('hero-title-line').hidden = true;
    el('hero-rename-form').hidden = false;
    el('hero-rename-input').focus();
    el('hero-rename-input').select();
  }
  function closeQuickRename() {
    el('hero-rename-form').hidden = true;
    el('hero-title-line').hidden = false;
    el('hero-rename-input').value = '';
  }
  function hideLaunchStage() {
    const stage = el('launch-stage');
    if (stage.hidden) return;
    clearTimeout(state.launchHideTimer);
    el('hero-card').classList.remove('is-launching');
    stage.classList.add('is-exiting');
    state.launchHideTimer = setTimeout(() => { stage.hidden = true; stage.classList.remove('is-exiting'); state.launchingId = ''; }, 240);
  }
  async function launchWithScene(item) {
    const stage = el('launch-stage');
    clearTimeout(state.launchHideTimer);
    state.launchingId = item.id;
    stage.classList.remove('is-exiting');
    setText('launch-stage-name', item.name);
    setText('launch-stage-message', 'Проверяем Java и файлы игры…');
    stage.hidden = false;
    el('hero-card').classList.add('is-launching');
    const started = Date.now();
    const result = await action(() => api.launchInstance(item.id));
    if (result) {
      setText('launch-stage-message', 'Процесс Minecraft запущен');
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 700 - (Date.now() - started))));
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
    if (event.type === 'discord' && state.data) { state.data.discordStatus = event.status; renderDiscord(); }
    if (event.type === 'install-output' && state.data?.installConsole?.id === event.id) {
      const session = state.data.installConsole;
      session.lines.push(...event.lines.filter(line => line.sequence > (session.lines.at(-1)?.sequence || 0)));
      session.lines = session.lines.slice(-400);
      scheduleConsoleRender();
    }
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
    window.addEventListener('veyra:notify', event => toast(event.detail.message, event.detail.undo));
    window.veyraMenu = showMenu;
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
      button.addEventListener('click', () => { state.appearanceDraft = { ...state.appearanceDraft, ...atmospherePresets[button.dataset.atmosphere] }; renderAppearance(); });
    }
    for (const button of document.querySelectorAll('[data-background-picture]')) {
      button.addEventListener('click', () => { state.appearanceDraft.picture = button.dataset.backgroundPicture === 'true'; renderAppearance(); });
    }
    for (const id of ['profile-any-symbols', 'settings-any-symbols']) {
      el(id).addEventListener('change', event => { state.nicknameAny = event.target.checked; renderNicknameRules(); });
    }
    for (const id of ['profile-name-input', 'player-name']) el(id).addEventListener('input', event => validateNicknameInput(event.target));
    el('loader-version-search').addEventListener('input', () => { state.loaderVersionLimit = 8; renderLoaderTiles(); });
    el('loader-version-search').addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); el('loader-version-tiles').querySelector('button')?.click(); }
    });
    el('loader-version-more').addEventListener('click', () => { state.loaderVersionLimit += 8; renderLoaderTiles(); });
    el('create-loader-version').addEventListener('change', renderLoaderTiles);
    for (const id of ['hero-console', 'console-footer']) el(id).addEventListener('click', revealConsole);
    el('console-close').addEventListener('click', () => { state.consoleOpen = false; renderInstallConsole(); });
    el('console-pause').addEventListener('click', () => { state.consolePaused = !state.consolePaused; renderConsoleContent(); });
    el('console-follow').addEventListener('click', () => { state.consoleFollow = true; state.consolePaused = false; renderConsoleContent(); });
    el('install-console-output').addEventListener('scroll', event => {
      if (state.consoleAutoScroll) return;
      state.consoleFollow = event.target.scrollHeight - event.target.scrollTop - event.target.clientHeight < 12;
    });
    el('console-copy').addEventListener('click', async () => { if (await action(() => api.copyInstallConsole())) toast('Вывод установки скопирован'); });
    el('toast-undo').addEventListener('click', async () => {
      const undo = state.toastUndo;
      if (!undo) return;
      el('toast-undo').disabled = true;
      await action(undo);
      el('toast-undo').disabled = false;
    });
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
    // Колесо над хотбаром листает разделы, как слоты в игре.
    el('rail-nav').addEventListener('wheel', (event) => {
      const buttons = [...document.querySelectorAll('.rail-nav .rail-button:not([hidden])')], index = buttons.findIndex(button => button.dataset.view === state.view);
      if (!event.deltaY || Date.now() - (state.wheelAt || 0) < 140) return;
      state.wheelAt = Date.now();
      showView(buttons[(index + (event.deltaY > 0 ? 1 : -1) + buttons.length) % buttons.length].dataset.view);
    }, { passive: true });
    document.addEventListener('keydown', (event) => {
      const dialog = document.querySelector('dialog[open]:not(.is-closing)');
      if (event.key === 'Escape' && dialog && !event.defaultPrevented) {
        event.preventDefault();
        closeDialog(dialog);
        return;
      }
      const slot = /^[1-6]$/.test(event.key) && !event.ctrlKey && !event.altKey && !event.metaKey && !document.querySelector('dialog[open]') &&
        !document.activeElement?.matches('input:not([type="checkbox"]):not([type="range"]), textarea, select') && document.querySelectorAll('.rail-nav .rail-button:not([hidden])')[Number(event.key) - 1];
      if (slot) { event.preventDefault(); showView(slot.dataset.view); return; }
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
      const saved = await profileAction(() => api.saveSettings({ playerName: el('profile-name-input').value.trim(), allowAnySymbols: el('profile-any-symbols').checked }));
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
        if ((state.data.runningClients || []).some(run => run.instanceId === item.id)) action(() => api.stopGame('', item.id));
        else if (item.installed) launchWithScene(item);
        else action(() => api.installInstance(item.id));
      }
    });
    el('stop-game-footer').addEventListener('click', () => action(() => api.stopGame()));
    el('launch-stage-dismiss').addEventListener('click', hideLaunchStage);
    el('hero-folder').addEventListener('click', () => { const item = selected(); if (item) action(() => api.openInstanceFolder(item.id)); });
    el('hero-content').addEventListener('click', () => { const item = selected(); if (item) window.dispatchEvent(new CustomEvent('veyra:content-open', { detail: { id: item.id } })); });
    el('hero-multi').addEventListener('click', () => { const item = selected(); if (item) launchWithScene(item); });
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
      const previousName = item.name;
      const updated = await action(() => api.updateInstance(item.id, { name: el('hero-rename-input').value.trim() }));
      if (updated) {
        closeQuickRename();
        toast('Название изменено', async () => {
          const restored = await api.updateInstance(item.id, { name: previousName });
          if (restored) toast('Прежнее название возвращено');
        });
      }
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
    el('create-name').addEventListener('input', renderRecipe);
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
        renderCoverPreview(instances().find(item => item.id === state.editingId));
      });
    }
    el('edit-cover').addEventListener('click', async () => {
      const updated = await studioAction(() => api.setInstanceCover(state.editingId));
      if (updated) {
        const item = instances().find((entry) => entry.id === state.editingId);
        state.editCustomUrl = item?.coverUrl || ''; state.editUsePreset = false;
        renderCoverPreview(item);
      }
    });
    el('reset-cover').addEventListener('click', async () => {
      const updated = await studioAction(() => api.resetInstanceCover(state.editingId));
      if (updated) {
        const item = instances().find((entry) => entry.id === state.editingId);
        state.editCustomUrl = '';
        renderCoverPreview(item);
      }
    });
    el('instance-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const id = state.editingId;
      const updated = await studioAction(() => api.updateInstance(id, {
        name: el('edit-name').value.trim(),
        note: el('edit-note').value,
        memoryGb: el('edit-memory-default').checked ? null : Number(el('edit-memory').value),
        javaPath: el('edit-java-auto').checked ? '' : el('edit-java-path').value,
        accent: state.editAccent,
        favorite: el('edit-favorite').checked,
        ...(state.editUsePreset ? { backgroundId: state.editBackground } : {}),
      }));
      if (updated) { closeDialog(el('instance-dialog')); toast('Настройки сборки сохранены'); }
    });
    el('edit-open-folder').addEventListener('click', () => action(() => api.openInstanceFolder(state.editingId)));
    for (const button of document.querySelectorAll('[data-studio-tab]')) button.addEventListener('click', () => setStudioTab(button.dataset.studioTab));
    for (const id of ['edit-name', 'edit-note', 'edit-memory', 'edit-memory-default', 'edit-java-auto']) el(id).addEventListener('input', renderStudioText);
    el('edit-name').addEventListener('invalid', () => setStudioTab('design'));
    el('random-cover').addEventListener('click', () => {
      const choices = state.data.backgrounds.filter(item => item.id !== 'default' && item.id !== state.editBackground);
      const value = new Uint32Array(1); crypto.getRandomValues(value);
      chooseBackground(choices[value[0] % choices.length].id);
    });
    el('studio-scene').addEventListener('pointermove', event => {
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const rect = event.currentTarget.getBoundingClientRect();
      event.currentTarget.style.setProperty('--scene-x', ((event.clientX - rect.left) / rect.width - .5) * 12 + 'px');
      event.currentTarget.style.setProperty('--scene-y', ((event.clientY - rect.top) / rect.height - .5) * 12 + 'px');
    });
    el('studio-scene').addEventListener('pointerleave', event => { event.currentTarget.style.setProperty('--scene-x', '0px'); event.currentTarget.style.setProperty('--scene-y', '0px'); });
    el('shots-folder').addEventListener('click', () => studioAction(() => api.openScreenshotsFolder(state.editingId)));
    el('studio-content').addEventListener('click', () => { el('instance-dialog').close(); window.dispatchEvent(new CustomEvent('veyra:content-open', { detail: { id: state.editingId } })); });
    el('discord-enabled').addEventListener('change', async () => {
      const result = await action(() => api.saveSettings({ discordEnabled: el('discord-enabled').checked }));
      if (!result) el('discord-enabled').checked = state.data.settings.discordEnabled;
    });
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
      renderMemoryBlocks();
    });
    el('memory-gb').addEventListener('change', () => {
      el('memory-gb').value = Math.min(memoryMaximum(), Math.max(1, Number(el('memory-gb').value) || 1));
    });
    el('memory-range').addEventListener('input', () => { el('memory-gb').value = el('memory-range').value; renderMemoryBlocks(); });
    for (const button of document.querySelectorAll('[data-memory]')) {
      button.addEventListener('click', () => { el('memory-gb').value = button.dataset.memory; el('memory-range').value = button.dataset.memory; renderMemoryBlocks(); });
    }
    el('save-settings').addEventListener('click', async () => {
      if (!window.veyraValidation.validate(el('settings-page'))) return;
      const saved = await action(() => api.saveSettings({
        playerName: el('player-name').value.trim(),
        allowAnySymbols: el('settings-any-symbols').checked,
        memoryGb: Number(el('memory-gb').value),
        javaPath: state.javaMode === 'auto' ? '' : el('java-path').value,
        showSnapshots: el('show-snapshots').checked,
        appearance: state.appearanceDraft,
        discordEnabled: el('discord-enabled').checked,
      }));
      if (saved) { renderSettings(); renderVersionOptions(); toast('Настройки сохранены'); }
    });
    for (const id of ['open-data-folder', 'settings-open-data']) el(id).addEventListener('click', () => action(() => api.openDataFolder()));
    el('reload-logs').addEventListener('click', refreshLogs);
  }
  // Готовность — флаг плюс событие: скрипты, подключённые позже, увидят флаг, даже если событие уже прошло.
  function ready() {
    window.veyraReady = true;
    window.dispatchEvent(new Event('veyra:ready'));
  }
  async function initialize() {
    bind();
    api.onEvent(receive);
    const data = await action(() => api.getState());
    if (!data) return ready();
    state.data = data;
    render();
    setText('footer-message', 'Готов к игре');
    showView('home');
    ready();
    // Java ищет главный процесс сразу после появления окна и присылает результат сам.
    if (!data.versions.length) await action(() => api.refreshVersions());
    setInterval(() => { renderGreeting(); renderPlaytime(); }, 1000);
  }
  initialize();
})();
