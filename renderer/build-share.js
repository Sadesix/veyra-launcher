(() => {
  'use strict';
  const api = window.launcher;
  const el = id => document.getElementById('share-' + id);
  const dialog = el('dialog');
  const labels = { vanilla: 'Vanilla', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' };
  let plan, exporting = false, working = false, revision = 0;

  function error(text = '') {
    el('error').textContent = text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
    el('error').hidden = !text;
  }

  function controls(value) {
    working = value;
    el('submit').disabled = value || !plan;
    el('cancel').disabled = el('close').disabled = value;
  }

  function showPlan(result) {
    plan = result;
    el('name-field').hidden = exporting;
    el('name').value = result.name.slice(0, 40);
    el('missing').hidden = !result.unresolved.length;
    el('missing').open = false;
    el('missing-title').textContent = 'Добавить вручную · ' + result.unresolved.length;
    el('missing-list').replaceChildren(...result.unresolved.map(item => {
      const row = document.createElement('li');
      row.textContent = item.name + (item.version ? ' · ' + item.version : '');
      return row;
    }));
    el('embed-field').hidden = !exporting || !result.unresolved.length;
    el('embed').checked = false;
    el('summary').textContent = exporting ?
      result.name + ' · модов ' + result.count + '. Версии с Modrinth сохранятся ссылками. Конфиги и ресурсы войдут в архив.' :
      labels[result.loader] + ' ' + result.minecraftVersion + (result.loaderVersion ? ' · ' + result.loaderVersion : '') +
      ' · модов ' + result.count + (result.embedded ? ' · JAR в архиве ' + result.embedded : '') +
      (result.unresolved.length ? '. Добавьте недостающие моды перед запуском игры.' : '');
    controls(false);
  }

  async function open(isExport, id) {
    if (dialog.open) return;
    const request = ++revision;
    exporting = isExport;
    plan = null;
    el('title').textContent = exporting ? 'Поделиться сборкой' : 'Импорт сборки';
    el('submit').textContent = exporting ? 'Сохранить .veyra' : 'Импортировать';
    el('summary').textContent = exporting ? 'Сверяем версии модов с Modrinth…' : 'Выберите файл .veyra';
    for (const field of ['name-field', 'missing', 'embed-field']) el(field).hidden = true;
    error();
    controls(false);
    dialog.showModal();
    try {
      const result = exporting ? await api.shareInspectExport(id) : await api.shareOpen();
      if (request !== revision || !dialog.open) return;
      if (result) showPlan(result);
      else dialog.close();
    } catch (failure) { if (request === revision) error(failure.message); }
  }

  window.addEventListener('veyra:share-build', event => open(true, event.detail.id));
  el('open').addEventListener('click', () => open(false));
  el('close').addEventListener('click', () => dialog.close());
  el('cancel').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { revision++; });
  dialog.addEventListener('cancel', event => { if (working) event.preventDefault(); });
  el('embed').addEventListener('change', () => {
    el('missing-title').textContent = (el('embed').checked ? 'Моды для архива · ' : 'Добавить вручную · ') + plan.unresolved.length;
  });
  el('form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!plan || working) return;
    controls(true);
    el('submit').textContent = exporting ? 'Сохраняем…' : 'Готовим импорт…';
    error();
    try {
      if (exporting) {
        if (await api.shareSave(plan.token, el('embed').checked)) dialog.close();
      } else {
        const result = await api.shareInstall(plan.token, el('name').value);
        dialog.close();
        document.querySelector('.rail-button[data-view="home"]').click();
        await api.installInstance(result.id);
      }
    } catch (failure) { if (dialog.open) error(failure.message); }
    finally {
      el('submit').textContent = exporting ? 'Сохранить .veyra' : 'Импортировать';
      controls(false);
    }
  });
})();
