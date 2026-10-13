(() => {
  'use strict';
  const api = window.launcher;
  const el = id => document.getElementById(id);
  const names = { mods: 'Моды', saves: 'Сохранения', shaders: 'Шейдеры', resourcepacks: 'Ресурспаки' };
  const glyphs = { mods: 'puzzle', saves: 'save', shaders: 'spark', resourcepacks: 'layers' };
  const categoriesRu = { adventure: 'Приключения', atmosphere: 'Атмосфера', audio: 'Звук', blocks: 'Блоки', bloom: 'Свечение', cartoon: 'Мультяшные', challenging: 'Сложность', colored_lighting: 'Цветное освещение', combat: 'Бои', core: 'Библиотеки', cursed: 'Необычные', decoration: 'Декор', economy: 'Экономика', entities: 'Существа', environment: 'Окружение', equipment: 'Снаряжение', fantasy: 'Фэнтези', foliage: 'Растительность', fonts: 'Шрифты', food: 'Еда', game_mechanics: 'Механики', gui: 'Интерфейс', high: 'Высокая нагрузка', items: 'Предметы', kitchen_sink: 'Разное', library: 'Библиотеки', lightweight: 'Лёгкие', low: 'Низкая нагрузка', magic: 'Магия', management: 'Управление', medium: 'Средняя нагрузка', minigame: 'Мини-игры', mobs: 'Мобы', multiplayer: 'Мультиплеер', optimization: 'Оптимизация', path_tracing: 'Трассировка', realistic: 'Реалистичные', reflections: 'Отражения', shadows: 'Тени', simplistic: 'Минимализм', social: 'Социальные', storage: 'Хранение', technology: 'Технологии', themed: 'Тематические', transportation: 'Транспорт', utility: 'Утилиты', vanilla_like: 'В стиле Vanilla', worldgen: 'Генерация' };
  const categoryName = name => categoriesRu[name.replaceAll('-', '_')] || name;
  const s = { id: '', kind: 'mods', mode: 'installed', data: null, local: null, offset: 0, request: 0, planRequest: 0, plan: null, project: '', working: false, renaming: '', cart: [], cartRequest: 0, cartPlan: null, cartSaving: false, cartOpen: false };
  const build = () => s.data?.instances.find(item => item.id === s.id);
  const bytes = size => size == null ? 'Папка' : size < 1024 ? size + ' Б' : size < 1024 ** 2 ? Math.round(size / 1024) + ' КБ' : (size / 1024 ** 2).toFixed(1) + ' МБ';
  const node = (tag, className, text) => { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; };
  const icon = name => { const value = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); value.classList.add('icon'); value.dataset.motion = name; const use = document.createElementNS(value.namespaceURI, 'use'); use.setAttribute('href', '#i-' + name); value.append(use); return value; };
  const locked = () => s.working || Boolean(s.data?.operation || s.data?.runningInstanceId || s.data?.server?.pid && !['stopped','error'].includes(s.data.server.status));
  function error(message, plan = false) { const target = el(plan ? 'content-plan-error' : 'content-error'); target.textContent = String(message || '').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); target.hidden = !message; }
  function notify(message, undo) {
    let undone = false;
    const undoOnce = undo ? async () => { if (undone) return; undone = true; el('content-feedback').hidden = true; await undo(); } : null;
    clearTimeout(s.feedbackTimer);
    if (el('content-dialog').open) {
      el('content-feedback-message').textContent = message;
      el('content-feedback').hidden = false;
      el('content-feedback-undo').hidden = !undo;
      el('content-feedback-undo').onclick = undoOnce;
      s.feedbackTimer = setTimeout(() => { el('content-feedback').hidden = true; }, 7000);
    }
    window.dispatchEvent(new CustomEvent('veyra:notify', { detail: { message, undo: undoOnce } }));
  }
  async function act(callback, refresh = true) {
    s.working = true; error(''); renderBusy();
    try { const result = await callback(); if (refresh && !result?.cancelled) await loadLocal(); return { ok: true, value: result }; }
    catch (failure) { const message = failure.message || String(failure); error(message); return { ok: false, error: message }; }
    finally { s.working = false; renderBusy(); }
  }
  function button(glyph, title, action, text = '') {
    const value = node('button', text ? 'content-row-action' : 'button-icon content-row-action');
    if (glyph === 'close') value.classList.add('close-control');
    value.type = 'button'; value.title = title; value.setAttribute('aria-label', title); value.append(icon(glyph));
    if (text) value.append(node('span', '', text));
    value.addEventListener('click', action);
    return value;
  }
  function artwork(item, kind) {
    const art = node('span', 'content-art');
    if (item.icon) { const img = node('img'); img.src = item.icon; img.alt = ''; img.loading = 'lazy'; img.addEventListener('error', () => { img.remove(); art.append(icon(glyphs[kind])); }, { once: true }); art.append(img); }
    else art.append(icon(glyphs[kind]));
    return art;
  }
  function renderHeader() {
    const item = build();
    if (!item) return;
    el('content-build-meta').textContent = item.name + ' · Minecraft ' + item.minecraftVersion + ' · ' + ({ vanilla: 'Vanilla', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' }[item.loader]);
    el('content-build-cover').style.backgroundImage = 'url("' + item.coverUrl + '")';
    const select = el('content-build-select');
    if ([...select.options].map(option => option.value + option.text).join() !== s.data.instances.map(item => item.id + item.name).join()) { select.replaceChildren(...s.data.instances.map(item => new Option(item.name, item.id))); }
    select.value = s.id;
    el('content-section-title').textContent = names[s.kind];
    el('content-section-hint').textContent = { mods: item.loader === 'vanilla' ? 'Для модов создайте сборку с Fabric, Forge или NeoForge.' : 'Совместимые моды и их обязательные зависимости.', saves: 'Копии, импорт и корзина для ваших сохранений.', shaders: 'Нужен Iris или OptiFine; шейдер выбирается внутри игры.', resourcepacks: 'Добавленные пакеты можно выбрать в настройках Minecraft.' }[s.kind];
    for (const value of document.querySelectorAll('[data-content-kind]')) { const active = value.dataset.contentKind === s.kind; value.classList.toggle('is-active', active); value.setAttribute('aria-pressed', String(active)); }
    for (const value of document.querySelectorAll('[data-content-mode]')) { const active = value.dataset.contentMode === s.mode; value.classList.toggle('is-active', active); value.setAttribute('aria-pressed', String(active)); }
    el('content-catalog-mode').hidden = s.kind === 'saves';
    const catalog = s.mode === 'catalog';
    for (const id of ['content-local-filter', 'content-local-sort']) el(id).hidden = catalog;
    for (const id of ['content-category', 'content-catalog-sort']) el(id).hidden = !catalog;
    el('content-import').hidden = catalog;
    el('content-search').placeholder = catalog ? 'Найти в Modrinth…' : 'Поиск по названию и файлу…';
    const save = s.kind === 'saves';
    for (const option of el('content-local-filter').options) option.hidden = save && ['enabled', 'disabled', 'managed'].includes(option.value);
    if (save && ['enabled', 'disabled', 'managed'].includes(el('content-local-filter').value)) el('content-local-filter').value = 'all';
    renderBusy();
  }
  function renderBusy() {
    const busy = locked();
    el('content-build-select').disabled = s.working || s.cartSaving || Boolean(s.pending?.size || s.data?.operation);
    el('content-import').disabled = busy;
    for (const input of el('content-results').querySelectorAll('[data-mutation]')) input.disabled = busy;
    el('content-plan-install').disabled = s.cartSaving || s.working || Boolean(s.data?.operation) || !s.plan || !s.plan.entries.some(item => !item.installed || item.disabled);
    for (const input of document.querySelectorAll('[data-queue]')) input.disabled = s.cartSaving || s.working || Boolean(s.data?.operation) || s.pending?.has(input.dataset.projectId);
    el('cart-install').disabled = busy || s.cartSaving || Boolean(s.pending?.size) || !s.cartPlan || !s.cart.length;
    el('cart-clear').disabled = s.cartSaving || s.working || Boolean(s.data?.operation);
    const operation = s.data?.operation;
    const active = operation?.type === 'content' && operation.instanceId === s.id;
    el('content-progress').hidden = !active;
    el('content-cancel').hidden = !operation?.cancellable;
    if (active) renderProgress(operation.progress);
  }
  function renderProgress(value) {
    if (!value) return;
    el('content-progress-text').textContent = (value.phase || 'Добавляем') + ' · ' + (value.message || '');
    el('content-progress-percent').textContent = value.percent == null ? '' : value.percent + '%';
    el('content-progress-fill').style.width = value.percent == null ? '30%' : value.percent + '%';
    el('content-progress').classList.toggle('is-indeterminate', value.percent == null);
  }
  function empty(title, description, glyph = glyphs[s.kind]) {
    const target = node('div', 'content-empty'); target.append(icon(glyph), node('strong', '', title), node('p', '', description)); el('content-results').replaceChildren(target);
  }
  async function loadLocal() {
    const request = ++s.request;
    const id = s.id, kind = s.kind;
    try { const result = await api.getContent(id, kind); if (request !== s.request) return; s.local = result; if (s.mode === 'installed') renderLocal(); }
    catch (failure) { if (request === s.request) error(failure.message); }
  }
  function renderLocal() {
    if (!s.local) return;
    const query = el('content-search').value.trim().toLowerCase();
    const filter = el('content-local-filter').value;
    const trash = filter === 'trash';
    let items = (trash ? s.local.trash : s.local.entries).filter(item => (item.title + ' ' + item.name + ' ' + (item.version || '')).toLowerCase().includes(query));
    if (!trash && filter !== 'all') items = items.filter(item => filter === 'enabled' ? item.enabled : filter === 'disabled' ? !item.enabled : filter === 'managed' ? item.source === 'modrinth' : item.source === 'local');
    const sort = el('content-local-sort').value;
    items.sort((a, b) => sort === 'modified' ? (b.modifiedAt || b.removedAt) - (a.modifiedAt || a.removedAt) : sort === 'size' ? (b.size || 0) - (a.size || 0) : a.title.localeCompare(b.title, 'ru', { numeric: true }));
    el('content-count').textContent = trash ? items.length + ' в корзине' : items.length + ' из ' + s.local.entries.length + ' · включено ' + s.local.counts.enabled;
    el('content-pagination').hidden = true;
    if (!items.length) return empty(trash ? 'Корзина пуста' : query || filter !== 'all' ? 'Совпадений нет' : 'Пока пусто', trash ? 'Удалённые файлы появятся здесь. Их можно восстановить.' : s.kind === 'saves' ? 'Добавьте папку сохранения или создайте сохранение в игре.' : 'Добавьте свои файлы или откройте каталог Modrinth.');
    const previous = new Map([...el('content-results').querySelectorAll('.content-row')].map(row => [row.dataset.contentName, row]));
    const ordered = [];
    for (const item of items) {
      const signature = JSON.stringify(item) + s.kind + trash;
      const cached = previous.get(item.name);
      if (cached?.dataset.signature === signature) { ordered.push(cached); continue; }
      const row = node('article', 'content-row' + (!trash && !item.enabled ? ' is-disabled' : ''));
      row.dataset.contentName = item.name;
      row.dataset.signature = signature;
      if (cached) row.style.animation = 'none';
      row.append(artwork(item, s.kind));
      const info = node('div', 'content-row-info');
      info.append(node('strong', '', item.title));
      const subtitle = trash ? new Date(item.removedAt).toLocaleString('ru-RU') : [item.version, item.source === 'modrinth' ? 'Modrinth' : 'Вручную', bytes(item.size)].filter(Boolean).join(' · ');
      info.append(node('small', '', subtitle));
      const filename = node('span', 'content-filename', item.name); filename.title = item.name; info.append(filename);
      if (item.dependency) info.append(node('span', 'content-dependency', 'Зависимость'));
      if (item.requiredBy?.length) { const hint = node('span', 'content-required', 'Нужен: ' + item.requiredBy.join(', ')); hint.title = hint.textContent; info.append(hint); }
      if (item.missingDependencies?.length) info.append(node('span', 'content-required is-warning', 'Есть отключённые или удалённые зависимости'));
      row.append(info);
      const actions = node('div', 'content-row-actions');
      if (trash) {
        const restore = button('refresh', 'Восстановить', () => act(() => api.restoreContent(s.id, item.id)), 'Вернуть'); restore.dataset.mutation = ''; actions.append(restore);
      } else {
        if (s.kind !== 'saves' && !item.directory) {
          const toggle = node('button', 'content-file-toggle'); toggle.type = 'button'; toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(item.enabled)); toggle.title = item.enabled ? 'Отключить' : 'Включить'; toggle.setAttribute('aria-label', toggle.title + ' ' + item.title); toggle.dataset.mutation = ''; toggle.append(node('i')); toggle.addEventListener('click', () => act(() => api.toggleContent(s.id, s.kind, item.name, !item.enabled))); actions.append(toggle);
        } else if (s.kind === 'saves') {
          const rename = button('edit', 'Переименовать папку', () => { s.renaming = item.name; el('save-rename-input').value = item.name; window.veyraValidation.clear(el('save-rename-input')); window.veyraValidation.alert(el('save-rename-form'), ''); el('save-rename-dialog').classList.remove('is-closing'); el('save-rename-dialog').showModal(); el('save-rename-input').focus(); el('save-rename-input').select(); }); rename.dataset.mutation = ''; actions.append(rename);
          const copy = button('copy', 'Сделать копию сохранения', () => act(() => api.duplicateSave(s.id, item.name))); copy.dataset.mutation = ''; actions.append(copy);
        }
        if (item.projectId) actions.append(button('refresh', 'Версии и обновление', () => openPlan(item.projectId)));
        actions.append(button('folder', 'Показать в папке', () => act(() => api.revealContent(s.id, s.kind, item.name), false)));
        const remove = button('trash', 'Переместить в корзину', async () => { const id = s.id; const result = await act(() => api.trashContent(id, s.kind, item.name)); if (result.ok) notify('Файл в корзине', async () => { await act(() => api.restoreContent(id, result.value)); }); }); remove.dataset.mutation = ''; actions.append(remove);
      }
      row.append(actions); ordered.push(row);
    }
    const target = el('content-results');
    for (const child of [...target.children]) if (!ordered.includes(child)) child.remove();
    ordered.forEach((row, index) => { if (target.children[index] !== row) target.insertBefore(row, target.children[index] || null); });
    renderBusy();
  }
  async function loadCatalog() {
    const request = ++s.request;
    if (s.kind === 'mods' && build()?.loader === 'vanilla') { el('content-pagination').hidden = true; el('content-count').textContent = 'Vanilla'; return empty('Нужен загрузчик модов', 'Создайте сборку с Fabric, Forge или NeoForge, затем добавьте моды.'); }
    error(''); empty('Ищем на Modrinth…', 'Подбираем проекты под Minecraft ' + build()?.minecraftVersion, 'search');
    try {
      const [result, local] = await Promise.all([api.searchContent(s.id, s.kind, { query: el('content-search').value, category: el('content-category').value, sort: el('content-catalog-sort').value, offset: s.offset }), api.getContent(s.id, s.kind)]);
      if (request !== s.request) return;
      s.local = local;
      el('content-count').textContent = result.total.toLocaleString('ru-RU') + ' проектов · Minecraft ' + build().minecraftVersion;
      const fragment = document.createDocumentFragment();
      for (const [index, item] of result.hits.entries()) {
        const card = node('article', 'catalog-card'); card.dataset.projectId = item.id;
        card.style.setProperty('--row-index', Math.min(index, 8));
        const head = node('div', 'catalog-card-head'); const title = node('div'); title.append(node('strong', '', item.title), node('small', '', item.author)); head.append(artwork(item, s.kind), title); card.append(head);
        card.append(node('p', '', item.description));
        const tags = node('div', 'catalog-tags'); for (const tag of item.categories.filter(tag => !['fabric', 'forge', 'neoforge'].includes(tag)).slice(0, 3)) tags.append(node('span', '', categoryName(tag))); card.append(tags);
        const foot = node('div', 'catalog-card-foot'); foot.append(node('small', '', new Intl.NumberFormat('ru-RU', { notation: 'compact' }).format(item.downloads) + ' загрузок'));
        const options = button('more', 'Версия и зависимости: ' + item.title, () => openPlan(item.id)); options.classList.add('catalog-options');
        const add = button('plus', 'Добавить ' + item.title + ' в корзину', () => quickAdd(item.id, card), 'Добавить'); add.classList.add('catalog-add'); add.dataset.queue = ''; add.dataset.projectId = item.id;
        const actions = node('div', 'catalog-actions'); actions.append(options, add); foot.append(actions); card.append(foot); fragment.append(card);
      }
      if (result.hits.length) { el('content-results').classList.add('is-catalog'); el('content-results').replaceChildren(fragment); }
      else empty('Ничего подходящего', 'Измените запрос или категорию. Версия Minecraft и загрузчик фильтруются автоматически.');
      el('content-pagination').hidden = result.total <= 18;
      el('content-page').textContent = (Math.floor(s.offset / 18) + 1) + ' / ' + Math.ceil(result.total / 18);
      el('content-previous').disabled = s.offset === 0;
      el('content-next').disabled = s.offset + 18 >= result.total || s.offset + 18 > 9800;
      syncCatalog(); renderBusy();
    } catch (failure) { if (request === s.request) { error(failure.message); empty('Каталог временно недоступен', 'Можно добавить файлы вручную или повторить запрос.'); } }
  }
  async function categories() {
    const kind = s.kind;
    try { const result = await api.contentCategories(kind); if (s.kind !== kind) return; el('content-category').replaceChildren(new Option('Все категории', ''), ...result.map(item => new Option(categoryName(item.name), item.name))); }
    catch { el('content-category').replaceChildren(new Option('Все категории', '')); }
  }
  async function refresh() { el('content-results').classList.toggle('is-catalog', s.mode === 'catalog'); return s.mode === 'catalog' ? loadCatalog() : loadLocal(); }
  function panelOpen(panel, open) {
    if (panel.targetOpen === open) return;
    panel.targetOpen = open; panel.panelMotion?.cancel(); panel.inert = !open;
    if (open) { panel.hidden = false; return; }
    if (panel.hidden || !el('content-dialog').open || matchMedia('(prefers-reduced-motion: reduce)').matches) { panel.hidden = true; return; }
    const motion = panel.animate([{ opacity: 1, transform: 'translateX(0)' }, { opacity: 0, transform: 'translateX(35px)' }], { duration: 220, easing: 'cubic-bezier(.4,0,1,1)' });
    panel.panelMotion = motion;
    motion.finished.then(() => { if (!panel.targetOpen) panel.hidden = true; }).catch(() => {});
  }
  function closePlan() { s.planRequest++; s.plan = null; panelOpen(el('content-plan'), false); el('content-dialog').classList.remove('has-plan'); }
  async function openPlan(projectId, kind = s.kind) {
    s.project = projectId; s.planKind = kind; const queued = s.cart.find(item => item.projectId === projectId); el('content-preview').checked = queued?.preview === true; panelOpen(el('content-plan'), true); el('content-dialog').classList.add('has-plan');
    return loadPlan(queued?.versionId || '');
  }
  async function loadPlan(versionId = '') {
    const request = ++s.planRequest;
    s.plan = null; error('', true); el('content-plan-title').textContent = 'Проверяем зависимости…'; el('content-plan-entries').replaceChildren(node('p', 'plan-loading', 'Подбираем совместимые файлы…')); el('content-plan-size').textContent = ''; el('content-version').disabled = true; renderBusy();
    try {
      const result = await api.planContent(s.id, s.planKind, s.project, { preview: el('content-preview').checked, versionId });
      if (request !== s.planRequest) return;
      s.plan = result; el('content-plan-title').textContent = result.title;
      el('content-version').replaceChildren(...result.versions.map(item => new Option(item.name + (item.channel === 'release' ? '' : ' · ' + item.channel), item.id)));
      el('content-version').value = result.entries.find(item => item.projectId === s.project)?.versionId || versionId || result.versions[0]?.id || '';
      el('content-version').disabled = false;
      const fragment = document.createDocumentFragment();
      for (const item of result.entries) {
        const row = node('div', 'plan-entry'); row.append(icon(item.dependency ? 'layers' : glyphs[item.kind])); const info = node('div'); info.append(node('strong', '', item.title), node('small', '', item.version + ' · ' + names[item.kind])); row.append(info, node('span', '', item.disabled ? 'Включим' : item.installed ? 'Уже есть' : item.updating ? 'Обновим' : item.dependency ? 'Зависимость' : 'Добавим')); fragment.append(row);
      }
      el('content-plan-entries').replaceChildren(fragment); el('content-plan-size').textContent = bytes(result.totalBytes);
      el('content-plan-install').querySelector('span').textContent = result.entries.some(item => !item.installed || item.disabled) ? s.cart.some(item => item.projectId === s.project) ? 'Сохранить версию' : 'В корзину' : 'Уже установлено';
    } catch (failure) { if (request === s.planRequest) { el('content-plan-title').textContent = 'Не удалось подобрать файлы'; el('content-plan-entries').replaceChildren(); error(failure.message, true); } }
    finally { if (request === s.planRequest) renderBusy(); }
  }
  async function open(id) {
    s.data = await api.getState(); s.id = id; if (!build()) return;
    let cartFailure = '';
    try { s.cart = await api.getCart(id); } catch (failure) { s.cart = []; cartFailure = failure.message; }
    s.cartPlan = null; s.cartOpen = s.cart.length > 0 || Boolean(cartFailure);
    s.kind = 'mods'; s.mode = s.cart.length ? 'catalog' : 'installed'; s.offset = 0; el('content-search').value = ''; el('content-local-filter').value = 'all'; closePlan(); error(''); renderHeader(); renderCart();
    clearTimeout(el('content-dialog').closeTimer); el('content-dialog').classList.remove('is-closing'); if (!el('content-dialog').open) el('content-dialog').showModal();
    if (s.mode === 'catalog') await categories(); await refresh(); if (cartFailure) cartError(cartFailure); else refreshCartPlan();
  }
  function cartError(message = '') { el('cart-error').textContent = String(message).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); el('cart-error').hidden = !message; }
  function renderCart() {
    el('cart-count').textContent = s.cart.length;
    panelOpen(el('content-cart'), s.cartOpen);
    el('content-dialog').classList.toggle('has-cart', s.cartOpen);
    el('content-cart-open').classList.toggle('is-active', s.cartOpen);
    el('content-cart-open').setAttribute('aria-expanded', String(s.cartOpen));
    el('cart-clear').hidden = !s.cart.length;
    const target = el('cart-selected');
    const previous = new Map([...target.querySelectorAll('.cart-item')].map(item => [item.dataset.projectId, item]));
    const ordered = s.cart.map(item => {
      const signature = JSON.stringify(item); const cached = previous.get(item.projectId); if (cached?.dataset.signature === signature) return cached;
      const row = node('article', 'cart-item'); row.dataset.projectId = item.projectId; row.dataset.signature = signature;
      row.append(artwork(item, item.kind)); const info = node('div'); info.append(node('strong', '', item.title), node('small', '', names[item.kind] + ' · ' + item.version)); row.append(info);
      const options = button('more', 'Изменить версию ' + item.title, () => openPlan(item.projectId, item.kind)); options.dataset.queue = '';
      const remove = button('close', 'Убрать ' + item.title + ' из корзины', () => saveCart(selected => selected.filter(other => other.projectId !== item.projectId))); remove.dataset.queue = '';
      row.append(options, remove); return row;
    });
    for (const child of [...target.children]) if (!ordered.includes(child)) child.remove();
    ordered.forEach((item, index) => { if (target.children[index] !== item) target.insertBefore(item, target.children[index] || null); });
    if (!s.cart.length) { const empty = node('div', 'cart-empty'); empty.append(icon('bag'), node('strong', '', 'Место для новых идей'), node('p', '', 'Добавляйте моды, шейдеры и ресурспаки. Скачаем всё одним нажатием.')); target.replaceChildren(empty); }
    syncCatalog(); renderBusy();
  }
  function syncCatalog() {
    for (const card of el('content-results').querySelectorAll('.catalog-card')) {
      const queued = s.cart.some(item => item.projectId === card.dataset.projectId);
      const installed = s.local?.entries.some(item => item.projectId === card.dataset.projectId && item.enabled);
      card.classList.toggle('is-queued', queued); card.classList.toggle('is-installed', installed === true);
      const add = card.querySelector('.catalog-add'); add.replaceChildren(icon(queued ? 'check' : 'plus'), node('span', '', queued ? 'В корзине' : 'Добавить'));
      add.title = queued ? 'Убрать из корзины' : 'Добавить в корзину'; add.setAttribute('aria-label', add.title + ' ' + card.querySelector('strong').textContent);
    }
  }
  async function refreshCartPlan() {
    const request = ++s.cartRequest, id = s.id;
    s.cartPlan = null; cartError(); el('cart-dependencies').replaceChildren();
    el('cart-summary').textContent = s.cart.length ? 'Проверяем общий набор…' : 'Добавляйте проекты из каталога'; renderBusy();
    if (!s.cart.length) return;
    try {
      const plan = await api.planCart(id); if (request !== s.cartRequest || id !== s.id) return;
      s.cartPlan = plan;
      const dependencies = plan.entries.filter(item => item.dependency);
      if (dependencies.length) {
        const heading = node('div', 'cart-dependency-heading'); heading.append(icon('layers'), node('span', '', 'Добавим зависимости · ' + dependencies.length)); el('cart-dependencies').append(heading);
        for (const item of dependencies) { const row = node('div', 'cart-dependency'); row.append(node('span', '', item.title), node('small', '', item.version + (item.installed ? ' · уже есть' : ''))); el('cart-dependencies').append(row); }
      }
      el('cart-summary').textContent = s.cart.length + ' проектов · ' + bytes(plan.totalBytes);
      el('cart-install').querySelector('span').textContent = 'Собрать и скачать';
    } catch (failure) { if (request === s.cartRequest) { cartError(failure.message); el('cart-summary').textContent = 'Выбор сохранён · исправьте конфликт или повторите'; } }
    finally { if (request === s.cartRequest) renderBusy(); }
  }
  function saveCart(selected) {
    const id = s.id;
    const operation = (s.cartWrites || Promise.resolve()).catch(() => {}).then(async () => {
      if (id !== s.id || s.working || s.data?.operation) return false;
      s.cartSaving = true; el('cart-saved').textContent = 'Сохраняем выбор…'; renderBusy();
      try {
        const saved = await api.saveCart(id, typeof selected === 'function' ? selected(s.cart) : selected); if (id !== s.id) return false;
        s.cart = saved; s.cartOpen = true; el('cart-saved').textContent = 'Сохранено · переживёт перезапуск'; renderCart(); refreshCartPlan(); return true;
      } catch (failure) { cartError(failure.message); el('cart-saved').textContent = 'Не удалось сохранить выбор'; return false; }
      finally { s.cartSaving = false; renderBusy(); }
    });
    s.cartWrites = operation; return operation;
  }
  async function addPlan(plan, projectId, kind, preview, source) {
    const root = plan.entries.find(item => item.projectId === projectId);
    if (!root) return;
    if (!plan.entries.some(item => !item.installed || item.disabled)) return notify('Этот проект уже установлен');
    const selection = { projectId, kind, versionId: root.versionId, version: root.version, title: root.title, icon: root.icon, preview };
    const saved = await saveCart(selected => [...selected.filter(item => item.projectId !== projectId), selection]);
    if (saved) { closePlan(); flyToCart(source); }
  }
  async function quickAdd(projectId, card) {
    if (s.working || s.data?.operation || s.pending?.has(projectId)) return;
    if (s.cart.some(item => item.projectId === projectId)) return saveCart(selected => selected.filter(item => item.projectId !== projectId));
    s.pending ||= new Set(); s.pending.add(projectId);
    const id = s.id, kind = s.kind; const control = card.querySelector('.catalog-add'); control.disabled = true; control.classList.add('is-loading');
    renderBusy();
    try { const plan = await api.planContent(id, kind, projectId, {}); if (id === s.id) await addPlan(plan, projectId, kind, false, card.querySelector('.content-art')); }
    catch (failure) { error(failure.message); }
    finally { s.pending.delete(projectId); control.classList.remove('is-loading'); renderBusy(); }
  }
  function flyToCart(source) {
    if (!source || matchMedia('(prefers-reduced-motion: reduce)').matches || !el('content-dialog').open) return;
    const origin = source.getBoundingClientRect(), target = el('cart-count').getBoundingClientRect(), base = el('content-dialog').getBoundingClientRect();
    const flying = source.cloneNode(true); flying.className = 'cart-flight'; Object.assign(flying.style, { left: origin.left - base.left + 'px', top: origin.top - base.top + 'px', width: origin.width + 'px', height: origin.height + 'px' }); el('content-dialog').append(flying);
    const dx = target.left - origin.left, dy = target.top - origin.top;
    const motion = flying.animate([{ transform: 'translate(0,0) scale(1)', opacity: 1 }, { transform: 'translate(' + dx * .5 + 'px,' + (dy - 45) + 'px) scale(.8)', opacity: .9, offset: .55 }, { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(.25)', opacity: 0 }], { duration: 640, easing: 'cubic-bezier(.3,.1,.2,1)', fill: 'forwards' }); motion.finished.catch(() => {}).finally(() => flying.remove());
    el('cart-count').animate([{ scale: 1 }, { scale: 1.35, offset: .65 }, { scale: 1 }], { duration: 850 });
  }
  window.addEventListener('veyra:content-open', event => open(event.detail.id).catch(failure => error(failure.message)));
  api.onEvent(event => {
    if (event.type === 'state') { s.data = event.state; if (el('content-dialog').open) { renderHeader(); if (!build()) el('content-dialog').close(); } }
    if (event.type === 'progress' && s.data?.operation?.type === 'content' && s.data.operation.instanceId === s.id) renderProgress(event);
    if (event.type === 'content-changed' && event.instanceId === s.id && el('content-dialog').open && s.mode === 'installed') loadLocal();
  });
  for (const value of document.querySelectorAll('[data-content-kind]')) value.addEventListener('click', async () => { s.kind = value.dataset.contentKind; if (s.kind === 'saves') s.mode = 'installed'; s.offset = 0; s.local = null; el('content-search').value = ''; closePlan(); error(''); renderHeader(); if (s.mode === 'catalog') await categories(); await refresh(); });
  for (const value of document.querySelectorAll('[data-content-mode]')) value.addEventListener('click', async () => { s.mode = value.dataset.contentMode; s.offset = 0; closePlan(); error(''); renderHeader(); if (s.mode === 'catalog') await categories(); await refresh(); });
  el('content-build-select').addEventListener('change', async event => { s.id = event.target.value; s.offset = 0; closePlan(); s.data = await api.selectInstance(s.id); s.cart = await api.getCart(s.id); s.cartOpen = s.cart.length > 0; renderHeader(); renderCart(); refreshCartPlan(); await refresh(); });
  el('content-search').addEventListener('input', () => { clearTimeout(s.searchTimer); s.offset = 0; if (s.mode === 'installed') renderLocal(); else s.searchTimer = setTimeout(loadCatalog, 350); });
  for (const id of ['content-local-filter', 'content-local-sort']) el(id).addEventListener('change', renderLocal);
  for (const id of ['content-category', 'content-catalog-sort']) el(id).addEventListener('change', () => { s.offset = 0; loadCatalog(); });
  el('content-refresh').addEventListener('click', refresh);
  el('content-previous').addEventListener('click', () => { s.offset = Math.max(0, s.offset - 18); loadCatalog(); });
  el('content-next').addEventListener('click', () => { s.offset += 18; loadCatalog(); });
  el('content-open-folder').addEventListener('click', () => act(() => api.openContentFolder(s.id, s.kind), false));
  el('content-import').addEventListener('click', () => act(() => api.importContent(s.id, s.kind)));
  el('content-cancel').addEventListener('click', () => api.cancelOperation());
  el('content-plan-close').addEventListener('click', closePlan);
  el('content-preview').addEventListener('change', () => loadPlan());
  el('content-version').addEventListener('change', event => loadPlan(event.target.value));
  el('content-plan-install').addEventListener('click', () => { if (s.plan) addPlan(s.plan, s.project, s.planKind, el('content-preview').checked, el('content-plan-install')); });
  el('content-cart-open').addEventListener('click', () => { s.cartOpen = !s.cartOpen; renderCart(); if (s.cartOpen && !s.cartPlan) refreshCartPlan(); });
  el('cart-close').addEventListener('click', () => { s.cartOpen = false; renderCart(); });
  el('cart-clear').addEventListener('click', async () => { const previous = [...s.cart]; if (await saveCart([])) notify('Корзина очищена', () => saveCart(previous)); });
  el('cart-install').addEventListener('click', async () => {
    if (locked() || s.cartSaving || s.pending?.size || !s.cartPlan || !s.cart.length) return;
    const result = await act(() => api.installCart(s.id), false);
    if (result.ok && !result.value?.cancelled) {
      s.cart = await api.getCart(s.id); s.cartOpen = s.cart.length > 0; renderCart(); refreshCartPlan(); await refresh();
      notify(result.value?.warning || 'Сборка пополнена · добавлено файлов: ' + result.value.added);
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) el('content-build-cover').animate([{ scale: 1 }, { scale: 1.14, filter: 'brightness(1.4)' }, { scale: 1 }], { duration: 750, easing: 'cubic-bezier(.16,1,.3,1)' });
    } else refreshCartPlan();
  });
  el('save-rename-form').addEventListener('submit', async event => { event.preventDefault(); const result = await act(() => api.renameSave(s.id, s.renaming, el('save-rename-input').value)); if (result.ok) el('save-rename-dialog').close(); else window.veyraValidation.alert(el('save-rename-form'), String(result.error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); });
  el('content-dialog').addEventListener('close', () => { s.request++; s.cartRequest++; clearTimeout(s.searchTimer); closePlan(); });
})();
