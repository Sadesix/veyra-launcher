(() => {
  'use strict';
  const api = window.launcher;
  const el = id => document.getElementById('share-' + id);
  const dialog = el('dialog');
  const labels = { vanilla: 'Vanilla', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' };
  let plan, exporting = false, working = false, revision = 0, resolving = false, lookupRevision = 0;
  let installId = '', installing = false, completed = false, checkingExternal = false, externalQueued = false;

  function error(text = '') {
    el('error').textContent = text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
    el('error').hidden = !text;
  }

  function controls(value) {
    working = value;
    el('submit').disabled = value || !plan || resolving;
    el('all').disabled = el('embed').disabled = value;
    el('cancel').disabled = el('close').disabled = value;
  }

  function listMissing(items) {
    el('missing').hidden = !items.length;
    el('missing').open = false;
    el('missing-title').textContent = 'Добавить вручную · ' + items.length;
    el('missing-list').replaceChildren(...items.map(item => {
      const row = document.createElement('li');
      row.textContent = item.name + (item.version ? ' · ' + item.version : '');
      return row;
    }));
  }

  function showPlan(result) {
    plan = result;
    el('name-field').hidden = exporting;
    el('name').value = result.name.slice(0, 40);
    listMissing(result.unresolved || []);
    el('all-field').hidden = !exporting || !result.count;
    el('all').checked = true;
    el('embed-field').hidden = true;
    el('embed').checked = false;
    el('profile').hidden = exporting;
    if (!exporting) {
      el('build-icon').src = '../assets/brands/' + (result.loader === 'vanilla' ? 'minecraft' : result.loader) + '.png';
      el('build-title').textContent = result.name;
      el('build-version').textContent = 'Minecraft ' + result.minecraftVersion + ' · ' + labels[result.loader] +
        (result.loaderVersion ? ' ' + result.loaderVersion : '');
    }
    el('summary').textContent = exporting ?
      result.name + ' · модов ' + result.count + '. Конфиги и ресурсы войдут в архив.' :
      'Модов ' + result.count + (result.embedded ? ' · JAR в архиве ' + result.embedded : '') +
      (result.unresolved.length ? '. Добавьте недостающие моды перед запуском игры.' : '');
    controls(false);
  }

  async function open(isExport, id, external) {
    if (dialog.open) return;
    const request = ++revision;
    exporting = isExport;
    plan = null;
    resolving = false;
    installId = '';
    completed = false;
    el('title').textContent = exporting ? 'Поделиться сборкой' : 'Установка сборки';
    el('submit-label').textContent = exporting ? 'Сохранить .veyra' : 'Установить сборку';
    el('submit').hidden = false;
    el('close').hidden = false;
    el('cancel').textContent = 'Отмена';
    el('summary').textContent = exporting ? 'Читаем файлы сборки…' : external ? 'Проверяем файл .veyra…' : 'Выберите файл .veyra';
    for (const field of ['name-field', 'missing', 'all-field', 'embed-field', 'profile', 'install-status', 'install-cancel']) el(field).hidden = true;
    error();
    controls(false);
    dialog.showModal();
    try {
      if (external?.error) throw external.error;
      const result = external?.plan || (exporting ? await api.shareInspectExport(id) : await api.shareOpen());
      if (request !== revision || !dialog.open) return;
      if (result) showPlan(result);
      else dialog.close();
    } catch (failure) { if (request === revision) error(failure.message); }
  }

  async function checkExternal() {
    if (dialog.open || checkingExternal) return;
    checkingExternal = true;
    externalQueued = false;
    try {
      const result = await api.shareOpenPending();
      if (result) await open(false, '', { plan: result });
    } catch (failure) { await open(false, '', { error: failure }); }
    finally {
      checkingExternal = false;
      if (externalQueued && !dialog.open) checkExternal();
    }
  }

  function installProgress(phase, text, percent) {
    el('install-phase').textContent = phase;
    const label = text && text !== phase ? text : '';
    el('install-message').textContent = label;
    el('install-message').hidden = !label;
    const known = Number.isFinite(percent);
    const track = el('install-progress');
    track.classList.toggle('is-indeterminate', !known);
    track.setAttribute('aria-valuetext', phase + (known ? ' · ' + percent + '%' : ''));
    if (known) track.setAttribute('aria-valuenow', percent);
    else track.removeAttribute('aria-valuenow');
    el('install-percent').textContent = known ? percent + '%' : '';
    el('install-fill').style.width = known ? percent + '%' : '';
  }

  async function install() {
    if (!installId) {
      const result = await api.shareInstall(plan.token, el('name').value);
      installId = result.id;
      el('build-title').textContent = el('name').value.trim() || plan.name;
    }
    installing = true;
    el('name-field').hidden = true;
    el('install-status').hidden = false;
    el('install-cancel').hidden = false;
    el('install-cancel').disabled = false;
    el('cancel').hidden = true;
    el('submit').hidden = true;
    el('close').hidden = true;
    el('install-cancel').focus();
    installProgress('Подготовка', 'Проверяем файлы сборки.');
    try {
      const result = await api.installInstance(installId);
      completed = Boolean(result.instances.find(instance => instance.id === installId)?.installed);
      installProgress(completed ? 'Сборка готова' : 'Установка приостановлена',
        completed ? 'Можно открыть её в библиотеке.' : 'Продолжите установку, когда будете готовы.', completed ? 100 : 0);
    } catch (failure) {
      installProgress('Установка остановлена', 'Можно повторить установку из этого окна.', 0);
      throw failure;
    } finally {
      installing = false;
      el('install-cancel').hidden = true;
      el('submit').hidden = false;
      el('close').hidden = false;
      el('cancel').hidden = false;
      el('cancel').textContent = 'Закрыть';
    }
  }

  window.addEventListener('veyra:share-build', event => open(true, event.detail.id));
  el('open').addEventListener('click', () => open(false));
  el('close').addEventListener('click', () => dialog.close());
  el('cancel').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { revision++; lookupRevision++; el('cancel').hidden = false; checkExternal(); });
  dialog.addEventListener('cancel', event => { if (working) event.preventDefault(); });
  api.onEvent(event => {
    if (event.type === 'open-share') { externalQueued = true; checkExternal(); }
    if (installing && event.type === 'progress') installProgress(event.phase, event.message, event.percent);
  });
  checkExternal();
  el('install-cancel').addEventListener('click', async () => {
    el('install-cancel').disabled = true;
    await api.cancelOperation().catch(failure => error(failure.message));
  });
  el('all').addEventListener('change', async () => {
    if (!plan) return;
    const request = ++lookupRevision;
    const all = el('all').checked;
    resolving = !all;
    listMissing([]);
    el('embed-field').hidden = true;
    el('summary').textContent = all ? plan.name + ' · модов ' + plan.count + '. Конфиги и ресурсы войдут в архив.' : 'Ищем точные версии на Modrinth…';
    controls(false);
    if (all) return;
    const result = await api.shareResolveExport(plan.token).catch(() => null);
    if (request !== lookupRevision || !dialog.open) return;
    resolving = false;
    if (!result) {
      el('all').checked = true;
      el('summary').textContent = 'Modrinth недоступен. Можно сохранить архив со всеми модами.';
    } else {
      plan.unresolved = result.unresolved;
      el('summary').textContent = plan.name + ' · ссылок на Modrinth ' + (plan.count - result.unresolved.length) + '.';
      listMissing(result.unresolved);
      el('embed-field').hidden = !result.unresolved.length;
      el('embed').checked = true;
      el('missing-title').textContent = 'Моды для архива · ' + result.unresolved.length;
    }
    controls(false);
  });
  el('embed').addEventListener('change', () => {
    el('missing-title').textContent = (el('embed').checked ? 'Моды для архива · ' : 'Добавить вручную · ') + (plan?.unresolved?.length || 0);
  });
  el('form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!plan || working) return;
    if (completed) {
      dialog.close();
      document.querySelector('.rail-button[data-view="home"]').click();
      return;
    }
    controls(true);
    el('submit-label').textContent = exporting ? 'Сохраняем…' : 'Готовим импорт…';
    error();
    try {
      if (exporting) {
        if (await api.shareSave(plan.token, el('all').checked ? 'all' : el('embed').checked ? 'missing' : 'links')) dialog.close();
      } else await install();
    } catch (failure) { if (dialog.open) error(failure.message); }
    finally {
      el('submit-label').textContent = exporting ? 'Сохранить .veyra' : completed ? 'Открыть сборку' : installId ? 'Продолжить установку' : 'Установить сборку';
      controls(false);
    }
  });
})();
