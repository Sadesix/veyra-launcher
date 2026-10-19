(() => {
  'use strict';
  // Каталог сборок модов Modrinth: поиск, выбор версии и установка отдельной сборкой.
  const api = window.launcher;
  const el = id => document.getElementById(id);
  const loaderNames = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' };
  const channels = { release: '', beta: 'Beta', alpha: 'Alpha' };
  const s = { offset: 0, request: 0, planRequest: 0, hit: null, details: null, creating: false, games: '' };
  const node = (tag, className, text) => { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; };
  const icon = name => { const value = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); value.classList.add('icon'); const use = document.createElementNS(value.namespaceURI, 'use'); use.setAttribute('href', '#i-' + name); value.append(use); return value; };
  const clean = message => String(message || '').replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
  const bytes = size => size < 1024 ** 2 ? Math.max(1, Math.round(size / 1024)) + ' КБ' : (size / 1024 ** 2).toFixed(1) + ' МБ';
  const compact = value => new Intl.NumberFormat('ru-RU', { notation: 'compact' }).format(value);
  const date = value => { const time = new Date(value); return Number.isNaN(time.getTime()) ? '' : new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }).format(time); };

  function error(message, plan = false) { const target = el(plan ? 'modpack-plan-error' : 'modpack-error'); target.textContent = clean(message); target.hidden = !message; }
  function artwork(url) {
    const art = node('span', 'content-art');
    if (url) { const img = node('img'); img.src = url; img.alt = ''; img.loading = 'lazy'; img.addEventListener('error', () => { img.remove(); art.append(icon('layers')); }, { once: true }); art.append(img); }
    else art.append(icon('layers'));
    return art;
  }
  function empty(title, description, glyph = 'layers') {
    const target = node('div', 'content-empty'); target.append(icon(glyph), node('strong', '', title), node('p', '', description)); el('modpack-results').replaceChildren(target);
  }
  // Диапазон версий Minecraft в карточке: последняя и, если их много, сколько ещё.
  function games(list) { return list.length ? 'Minecraft ' + list.at(-1) + (list.length > 1 ? ' +' + (list.length - 1) : '') : ''; }

  async function fillGames() {
    const state = await api.getState();
    const key = JSON.stringify(state.versions.map(item => item.id));
    if (key === s.games) return;
    s.games = key;
    const select = el('modpack-game'), current = select.value;
    select.replaceChildren(new Option('Любой Minecraft', ''), ...state.versions.filter(item => item.type === 'release').map(item => new Option('Minecraft ' + item.id, item.id)));
    select.value = [...select.options].some(option => option.value === current) ? current : '';
  }

  async function load() {
    const request = ++s.request;
    error('');
    empty('Ищем сборки на Modrinth…', 'Подбираем наборы для Fabric, Forge и NeoForge.', 'search');
    el('modpack-pagination').hidden = true;
    try {
      const result = await api.searchModpacks({ query: el('modpack-search').value, loader: el('modpack-loader').value, gameVersion: el('modpack-game').value, sort: el('modpack-sort').value, offset: s.offset });
      if (request !== s.request) return;
      el('modpack-count').textContent = result.total.toLocaleString('ru-RU') + ' сборок · Modrinth';
      if (!result.hits.length) return empty('Ничего не нашлось', 'Измените запрос, загрузчик или версию Minecraft.');
      const fragment = document.createDocumentFragment();
      for (const [index, hit] of result.hits.entries()) fragment.append(card(hit, index));
      el('modpack-results').replaceChildren(fragment);
      el('modpack-pagination').hidden = result.total <= 18;
      el('modpack-page').textContent = (Math.floor(s.offset / 18) + 1) + ' / ' + Math.ceil(result.total / 18);
      el('modpack-previous').disabled = s.offset === 0;
      el('modpack-next').disabled = s.offset + 18 >= result.total || s.offset + 18 > 9800;
    } catch (failure) {
      if (request !== s.request) return;
      error(failure.message);
      empty('Каталог сборок недоступен', 'Проверьте интернет и нажмите «Обновить».');
    }
  }
  function card(hit, index) {
    const value = node('article', 'catalog-card modpack-card'); value.dataset.projectId = hit.id;
    value.style.setProperty('--row-index', Math.min(index, 8));
    const banner = node('div', 'modpack-banner');
    if (hit.image) banner.style.backgroundImage = 'url("' + hit.image + '")'; else banner.classList.add('is-empty');
    value.append(banner);
    const head = node('div', 'catalog-card-head'); const title = node('div'); title.append(node('strong', '', hit.title), node('small', '', hit.author)); head.append(artwork(hit.icon), title); value.append(head);
    value.append(node('p', '', hit.description));
    const tags = node('div', 'catalog-tags');
    for (const loader of hit.loaders) tags.append(node('span', 'modpack-loader is-' + loader, loaderNames[loader]));
    if (hit.gameVersions.length) { const range = node('span', '', games(hit.gameVersions)); range.title = hit.gameVersions.join(', '); tags.append(range); }
    value.append(tags);
    const foot = node('div', 'catalog-card-foot'); foot.append(node('small', '', compact(hit.downloads) + ' загрузок'));
    const install = node('button', 'content-row-action catalog-add modpack-choose'); install.type = 'button';
    install.append(icon('download'), node('span', '', 'Установить')); install.setAttribute('aria-label', 'Установить сборку ' + hit.title);
    install.addEventListener('click', () => openPlan(hit));
    const actions = node('div', 'catalog-actions'); actions.append(install); foot.append(actions); value.append(foot);
    return value;
  }

  function versionsShown() {
    const preview = el('modpack-preview').checked;
    const all = s.details?.versions || [];
    const shown = all.filter(item => preview || item.channel === 'release');
    // Если стабильных версий нет совсем, показываются все: иначе сборку не поставить.
    return shown.length ? shown : all;
  }
  function renderVersions(keep = '') {
    const select = el('modpack-version');
    const list = versionsShown();
    select.replaceChildren(...list.map(item => new Option(item.name + ' · Minecraft ' + item.gameVersions.join(', ') + ' · ' + item.loaders.map(name => loaderNames[name]).join(', ') + (channels[item.channel] ? ' · ' + channels[item.channel] : ''), item.id)));
    // Без явного выбора берётся свежая версия под Minecraft из фильтра каталога, если он задан.
    const wanted = el('modpack-game').value;
    select.value = list.some(item => item.id === keep) ? keep : (wanted && list.find(item => item.gameVersions.includes(wanted))?.id) || list[0]?.id || '';
    select.disabled = !list.length;
    renderFacts();
  }
  function renderFacts() {
    const version = s.details?.versions.find(item => item.id === el('modpack-version').value);
    const facts = el('modpack-facts');
    facts.replaceChildren();
    if (!version) { renderBusy(); return; }
    const add = (term, value) => { if (!value) return; facts.append(node('dt', '', term), node('dd', '', value)); };
    add('Minecraft', version.gameVersions.join(', '));
    add('Загрузчик', version.loaders.map(name => loaderNames[name]).join(', '));
    add('Файл сборки', bytes(version.size) + ' · моды скачаются отдельно');
    add('Выпущена', date(version.published) + (channels[version.channel] ? ' · ' + channels[version.channel] : ''));
    renderBusy();
  }
  function renderBusy() {
    const ready = Boolean(s.details && el('modpack-version').value);
    el('modpack-install').disabled = s.creating || !ready;
    el('modpack-install').querySelector('span').textContent = s.creating ? 'Создаём сборку…' : 'Установить сборку';
  }
  async function openPlan(hit) {
    const request = ++s.planRequest;
    s.hit = hit; s.details = null;
    el('modpack-plan').hidden = false;
    el('modpack-dialog').classList.add('has-plan');
    el('modpack-plan-title').textContent = hit.title;
    el('modpack-description').textContent = hit.description;
    el('modpack-art').style.backgroundImage = hit.image ? 'url("' + hit.image + '")' : '';
    el('modpack-art').hidden = !hit.image;
    el('modpack-name').value = '';
    el('modpack-name').placeholder = hit.title.slice(0, 40);
    el('modpack-preview').checked = false;
    el('modpack-version').replaceChildren(new Option('Получаем версии…', ''));
    el('modpack-version').disabled = true;
    el('modpack-facts').replaceChildren();
    error('', true);
    renderBusy();
    try {
      const details = await api.modpackDetails(hit.id);
      if (request !== s.planRequest) return;
      s.details = details;
      if (details.image) { el('modpack-art').style.backgroundImage = 'url("' + details.image + '")'; el('modpack-art').hidden = false; }
      if (!details.versions.length) { el('modpack-version').replaceChildren(new Option('Нет версий для Fabric, Forge или NeoForge', '')); error('У этой сборки нет версии, которую Veyra может поставить: нужен файл .mrpack для Fabric, Forge или NeoForge.', true); return renderBusy(); }
      // Под выбранный в фильтре Minecraft есть только Beta / Alpha — переключатель включается сам.
      const wanted = el('modpack-game').value;
      if (wanted && !details.versions.some(item => item.channel === 'release' && item.gameVersions.includes(wanted)) && details.versions.some(item => item.gameVersions.includes(wanted))) el('modpack-preview').checked = true;
      renderVersions();
    } catch (failure) {
      if (request !== s.planRequest) return;
      el('modpack-version').replaceChildren(new Option('Не удалось получить версии', ''));
      error(failure.message, true);
      renderBusy();
    }
  }
  function closePlan() {
    s.planRequest++; s.hit = null; s.details = null;
    el('modpack-plan').hidden = true;
    el('modpack-dialog').classList.remove('has-plan');
  }
  async function install() {
    if (s.creating || !s.details) return;
    const versionId = el('modpack-version').value;
    if (!versionId) return;
    s.creating = true; error('', true); renderBusy();
    try {
      const instance = await api.createModpackInstance({ projectId: s.details.id, versionId, name: el('modpack-name').value.trim() });
      close();
      // Установку запускает главное окно: прогресс, консоль и отмена — как у обычной сборки.
      window.dispatchEvent(new CustomEvent('veyra:install-new', { detail: { id: instance.id } }));
    } catch (failure) { error(failure.message, true); }
    finally { s.creating = false; renderBusy(); }
  }
  async function open() {
    const dialog = el('modpack-dialog');
    clearTimeout(dialog.closeTimer); dialog.classList.remove('is-closing');
    closePlan();
    if (!dialog.open) dialog.showModal();
    el('modpack-search').focus();
    await fillGames().catch(() => {});
    await load();
  }
  function close() {
    const dialog = el('modpack-dialog');
    if (!dialog.open || dialog.classList.contains('is-closing')) return;
    dialog.classList.add('is-closing');
    dialog.closeTimer = setTimeout(() => { dialog.close(); dialog.classList.remove('is-closing'); }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 260);
  }

  window.addEventListener('veyra:modpacks-open', () => { open().catch(failure => error(failure.message)); });
  el('modpack-search').addEventListener('input', () => { clearTimeout(s.searchTimer); s.offset = 0; s.searchTimer = setTimeout(load, 350); });
  for (const id of ['modpack-loader', 'modpack-game', 'modpack-sort']) el(id).addEventListener('change', () => { s.offset = 0; load(); });
  el('modpack-refresh').addEventListener('click', load);
  el('modpack-previous').addEventListener('click', () => { s.offset = Math.max(0, s.offset - 18); load(); });
  el('modpack-next').addEventListener('click', () => { s.offset += 18; load(); });
  el('modpack-plan-close').addEventListener('click', closePlan);
  el('modpack-preview').addEventListener('change', () => renderVersions(el('modpack-version').value));
  el('modpack-version').addEventListener('change', renderFacts);
  el('modpack-install').addEventListener('click', install);
  el('modpack-name').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); install(); } });
  el('modpack-page-link').addEventListener('click', () => { const id = s.details?.id || s.hit?.id; if (id) api.openContentProject(id).catch(failure => error(failure.message, true)); });
  el('modpack-dialog').addEventListener('close', () => { s.request++; clearTimeout(s.searchTimer); closePlan(); });
})();
