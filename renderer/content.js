(() => {
  'use strict';
  const api = window.launcher;
  const el = id => document.getElementById(id);
  const names = { mods: 'Моды', saves: 'Сохранения', shaders: 'Шейдеры', resourcepacks: 'Ресурспаки' };
  const glyphs = { mods: 'puzzle', saves: 'save', shaders: 'spark', resourcepacks: 'layers' };
  const categoriesRu = { adventure: 'Приключения', atmosphere: 'Атмосфера', audio: 'Звук', blocks: 'Блоки', bloom: 'Свечение', cartoon: 'Мультяшные', challenging: 'Сложность', colored_lighting: 'Цветное освещение', combat: 'Бои', core: 'Библиотеки', cursed: 'Необычные', decoration: 'Декор', economy: 'Экономика', entities: 'Существа', environment: 'Окружение', equipment: 'Снаряжение', fantasy: 'Фэнтези', foliage: 'Растительность', fonts: 'Шрифты', food: 'Еда', game_mechanics: 'Механики', gui: 'Интерфейс', high: 'Высокая нагрузка', items: 'Предметы', kitchen_sink: 'Разное', library: 'Библиотеки', lightweight: 'Лёгкие', low: 'Низкая нагрузка', magic: 'Магия', management: 'Управление', medium: 'Средняя нагрузка', minigame: 'Мини-игры', mobs: 'Мобы', multiplayer: 'Мультиплеер', optimization: 'Оптимизация', path_tracing: 'Трассировка', realistic: 'Реалистичные', reflections: 'Отражения', shadows: 'Тени', simplistic: 'Минимализм', social: 'Социальные', storage: 'Хранение', technology: 'Технологии', themed: 'Тематические', transportation: 'Транспорт', utility: 'Утилиты', vanilla_like: 'В стиле Vanilla', worldgen: 'Генерация' };
  const categoryName = name => categoriesRu[name.replaceAll('-', '_')] || name;
  const s = { id: '', kind: 'mods', mode: 'installed', data: null, local: null, offset: 0, request: 0, planRequest: 0, plan: null, project: '', working: false, renaming: '' };
  const build = () => s.data?.instances.find(item => item.id === s.id);
  const bytes = size => size == null ? 'Папка' : size < 1024 ? size + ' Б' : size < 1024 ** 2 ? Math.round(size / 1024) + ' КБ' : (size / 1024 ** 2).toFixed(1) + ' МБ';
  const node = (tag, className, text) => { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; };
  const icon = name => { const value = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); value.classList.add('icon'); value.dataset.motion = name; const use = document.createElementNS(value.namespaceURI, 'use'); use.setAttribute('href', '#i-' + name); value.append(use); return value; };
  const locked = () => s.working || Boolean(s.data?.operation || s.data?.runningInstanceId);
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
    catch (failure) { error(failure.message || String(failure)); return { ok: false }; }
    finally { s.working = false; renderBusy(); }
  }
  function button(glyph, title, action, text = '') {
    const value = node('button', text ? 'content-row-action' : 'button-icon content-row-action');
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
    el('content-build-select').disabled = s.working || Boolean(s.data?.operation);
    el('content-import').disabled = busy;
    for (const input of el('content-results').querySelectorAll('[data-mutation]')) input.disabled = busy;
    el('content-plan-install').disabled = busy || !s.plan || !s.plan.entries.some(item => !item.installed || item.disabled);
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
          const rename = button('edit', 'Переименовать папку', () => { s.renaming = item.name; el('save-rename-input').value = item.name; el('save-rename-dialog').classList.remove('is-closing'); el('save-rename-dialog').showModal(); el('save-rename-input').focus(); el('save-rename-input').select(); }); rename.dataset.mutation = ''; actions.append(rename);
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
      const result = await api.searchContent(s.id, s.kind, { query: el('content-search').value, category: el('content-category').value, sort: el('content-catalog-sort').value, offset: s.offset });
      if (request !== s.request) return;
      el('content-count').textContent = result.total.toLocaleString('ru-RU') + ' проектов · Minecraft ' + build().minecraftVersion;
      const fragment = document.createDocumentFragment();
      for (const item of result.hits) {
        const card = node('article', 'catalog-card'); card.dataset.projectId = item.id;
        const head = node('div', 'catalog-card-head'); const title = node('div'); title.append(node('strong', '', item.title), node('small', '', item.author)); head.append(artwork(item, s.kind), title); card.append(head);
        card.append(node('p', '', item.description));
        const tags = node('div', 'catalog-tags'); for (const tag of item.categories.filter(tag => !['fabric', 'forge', 'neoforge'].includes(tag)).slice(0, 3)) tags.append(node('span', '', categoryName(tag))); card.append(tags);
        const foot = node('div', 'catalog-card-foot'); foot.append(node('small', '', new Intl.NumberFormat('ru-RU', { notation: 'compact' }).format(item.downloads) + ' загрузок'));
        foot.append(button('arrow', 'Выбрать ' + item.title, () => openPlan(item.id), 'Добавить')); card.append(foot); fragment.append(card);
      }
      if (result.hits.length) { el('content-results').classList.add('is-catalog'); el('content-results').replaceChildren(fragment); }
      else empty('Ничего подходящего', 'Измените запрос или категорию. Версия Minecraft и загрузчик фильтруются автоматически.');
      el('content-pagination').hidden = result.total <= 18;
      el('content-page').textContent = (Math.floor(s.offset / 18) + 1) + ' / ' + Math.ceil(result.total / 18);
      el('content-previous').disabled = s.offset === 0;
      el('content-next').disabled = s.offset + 18 >= result.total || s.offset + 18 > 9800;
    } catch (failure) { if (request === s.request) { error(failure.message); empty('Каталог временно недоступен', 'Можно добавить файлы вручную или повторить запрос.'); } }
  }
  async function categories() {
    const kind = s.kind;
    try { const result = await api.contentCategories(kind); if (s.kind !== kind) return; el('content-category').replaceChildren(new Option('Все категории', ''), ...result.map(item => new Option(categoryName(item.name), item.name))); }
    catch { el('content-category').replaceChildren(new Option('Все категории', '')); }
  }
  async function refresh() { el('content-results').classList.toggle('is-catalog', s.mode === 'catalog'); return s.mode === 'catalog' ? loadCatalog() : loadLocal(); }
  function closePlan() { s.planRequest++; s.plan = null; el('content-plan').hidden = true; el('content-dialog').classList.remove('has-plan'); }
  async function openPlan(projectId) {
    s.project = projectId; el('content-preview').checked = false; el('content-plan').hidden = false; el('content-dialog').classList.add('has-plan');
    return loadPlan();
  }
  async function loadPlan(versionId = '') {
    const request = ++s.planRequest;
    s.plan = null; error('', true); el('content-plan-title').textContent = 'Проверяем зависимости…'; el('content-plan-entries').replaceChildren(node('p', 'plan-loading', 'Подбираем совместимые файлы…')); el('content-plan-size').textContent = ''; el('content-version').disabled = true; renderBusy();
    try {
      const result = await api.planContent(s.id, s.kind, s.project, { preview: el('content-preview').checked, versionId });
      if (request !== s.planRequest) return;
      s.plan = result; el('content-plan-title').textContent = result.title;
      el('content-version').replaceChildren(...result.versions.map(item => new Option(item.name + (item.channel === 'release' ? '' : ' · ' + item.channel), item.id)));
      el('content-version').value = versionId || result.versions[0]?.id || '';
      el('content-version').disabled = false;
      const fragment = document.createDocumentFragment();
      for (const item of result.entries) {
        const row = node('div', 'plan-entry'); row.append(icon(item.dependency ? 'layers' : glyphs[item.kind])); const info = node('div'); info.append(node('strong', '', item.title), node('small', '', item.version + ' · ' + names[item.kind])); row.append(info, node('span', '', item.disabled ? 'Включим' : item.installed ? 'Уже есть' : item.updating ? 'Обновим' : item.dependency ? 'Зависимость' : 'Добавим')); fragment.append(row);
      }
      el('content-plan-entries').replaceChildren(fragment); el('content-plan-size').textContent = bytes(result.totalBytes);
      el('content-plan-install').querySelector('span').textContent = result.entries.some(item => !item.installed || item.disabled) ? 'Добавить в сборку' : 'Уже установлено';
    } catch (failure) { if (request === s.planRequest) { el('content-plan-title').textContent = 'Не удалось подобрать файлы'; el('content-plan-entries').replaceChildren(); error(failure.message, true); } }
    finally { if (request === s.planRequest) renderBusy(); }
  }
  async function open(id) {
    s.data = await api.getState(); s.id = id; if (!build()) return;
    s.kind = 'mods'; s.mode = 'installed'; s.offset = 0; el('content-search').value = ''; el('content-local-filter').value = 'all'; closePlan(); error(''); renderHeader();
    clearTimeout(el('content-dialog').closeTimer); el('content-dialog').classList.remove('is-closing'); if (!el('content-dialog').open) el('content-dialog').showModal();
    await loadLocal();
  }
  window.addEventListener('veyra:content-open', event => open(event.detail.id).catch(failure => error(failure.message)));
  api.onEvent(event => {
    if (event.type === 'state') { s.data = event.state; if (el('content-dialog').open) { renderHeader(); if (!build()) el('content-dialog').close(); } }
    if (event.type === 'progress' && s.data?.operation?.type === 'content' && s.data.operation.instanceId === s.id) renderProgress(event);
    if (event.type === 'content-changed' && event.instanceId === s.id && el('content-dialog').open && s.mode === 'installed') loadLocal();
  });
  for (const value of document.querySelectorAll('[data-content-kind]')) value.addEventListener('click', async () => { s.kind = value.dataset.contentKind; if (s.kind === 'saves') s.mode = 'installed'; s.offset = 0; s.local = null; el('content-search').value = ''; closePlan(); error(''); renderHeader(); if (s.mode === 'catalog') await categories(); await refresh(); });
  for (const value of document.querySelectorAll('[data-content-mode]')) value.addEventListener('click', async () => { s.mode = value.dataset.contentMode; s.offset = 0; closePlan(); error(''); renderHeader(); if (s.mode === 'catalog') await categories(); await refresh(); });
  el('content-build-select').addEventListener('change', async event => { s.id = event.target.value; s.offset = 0; closePlan(); s.data = await api.selectInstance(s.id); renderHeader(); await refresh(); });
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
  el('content-plan-install').addEventListener('click', async () => { if (!s.plan) return; const token = s.plan.token; closePlan(); const result = await act(() => api.installContent(s.id, token), false); if (result.ok) { s.mode = 'installed'; el('content-search').value = ''; el('content-local-filter').value = 'all'; renderHeader(); await refresh(); } });
  el('save-rename-form').addEventListener('submit', async event => { event.preventDefault(); const result = await act(() => api.renameSave(s.id, s.renaming, el('save-rename-input').value)); if (result.ok) el('save-rename-dialog').close(); });
  el('content-dialog').addEventListener('close', () => { s.request++; clearTimeout(s.searchTimer); closePlan(); });
})();
