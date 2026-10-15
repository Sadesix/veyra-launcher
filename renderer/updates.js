(() => {
  'use strict';
  const api = window.launcher, el = id => document.getElementById(id);
  const clean = text => String(text || '').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  const notify = message => window.dispatchEvent(new CustomEvent('veyra:notify', { detail: { message } }));
  const explain = {
    notify: 'Veyra проверяет обновления при запуске и сообщает о новой версии. Скачивание начинается только по вашей кнопке.',
    off: 'Veyra не проверяет обновления сам и ничего не показывает. Кнопка «Проверить сейчас» остаётся.',
    auto: 'Новая версия скачивается и устанавливается в фоне, сверившись по контрольной сумме. Она откроется при следующем запуске лаунчера.',
  };
  let data = null, announced = '', failure = '';
  const megabytes = size => size ? ' · ' + Math.round(size / 1024 ** 2) + ' МБ' : '';
  function statusText(update) {
    const version = update.version, time = update.checkedAt ? new Date(update.checkedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '';
    if (failure) return failure;
    if (update.status === 'unconfigured') return 'В этой сборке лаунчера не указан адрес обновлений.';
    if (update.status === 'checking') return 'Проверяем обновления…';
    if (update.status === 'current') return 'У вас последняя версия. Проверено в ' + time + '.';
    if (update.status === 'available') return update.error ? 'Версия ' + version + ' не скачалась: ' + update.error : 'Доступна версия ' + version + (update.published ? ' от ' + update.published : '') + megabytes(update.size) + '.';
    if (update.status === 'downloading') return 'Скачиваем версию ' + version + (update.progress == null ? '…' : ' · ' + update.progress + '%');
    if (update.status === 'preparing') return 'Устанавливаем версию ' + version + ' в фоне. Можно продолжать играть.';
    if (update.status === 'ready' && update.installed) return update.prepared ? 'Версия ' + version + ' установлена. Перезапустите лаунчер, чтобы перейти на неё.' : update.error || 'Версия ' + version + ' скачана — осталось её установить.';
    if (update.status === 'ready') return update.portable ? 'Версия ' + version + ' скачана и проверена. Перезапустите лаунчер, чтобы перейти на неё.' : 'Версия ' + version + ' скачана и проверена. Файл лежит в папке загрузок.';
    if (update.status === 'error') return 'Не удалось проверить обновления: ' + update.error;
    return 'Проверка ещё не выполнялась.';
  }
  function render() {
    if (!data) return;
    const update = data.update, mode = data.settings.updates, status = update.status;
    el('update-current').textContent = 'Установлена версия ' + data.appVersion;
    for (const button of el('update-modes').children) {
      const active = button.dataset.updateMode === mode;
      button.classList.toggle('is-active', active); button.setAttribute('aria-pressed', String(active));
    }
    el('update-explain').textContent = explain[mode];
    el('update-status').dataset.status = failure || (status === 'ready' && update.installed && !update.prepared && update.error) ? 'error' : status;
    el('update-status-text').textContent = statusText(update);
    const notes = ['available', 'downloading', 'preparing', 'ready'].includes(status) ? update.notes : [];
    el('update-notes').hidden = !notes.length;
    if (el('update-notes').dataset.signature !== notes.join('\n')) {
      el('update-notes').dataset.signature = notes.join('\n');
      el('update-notes').replaceChildren(...notes.map(text => Object.assign(document.createElement('li'), { textContent: text })));
    }
    el('update-track').hidden = status !== 'downloading' && status !== 'preparing';
    el('update-track').classList.toggle('is-indeterminate', status === 'preparing' || update.progress == null);
    el('update-fill').style.width = status === 'preparing' || update.progress == null ? '' : update.progress + '%';
    el('update-check').hidden = status === 'downloading' || status === 'preparing';
    el('update-check').disabled = status === 'checking' || status === 'unconfigured';
    el('update-download').hidden = status !== 'available' || !update.downloadable;
    el('update-cancel').hidden = status !== 'downloading';
    el('update-apply').hidden = status !== 'ready';
    el('update-apply-label').textContent = update.installed ? (update.prepared ? 'Перезапустить и обновить' : 'Установить обновление') : update.portable ? 'Перезапустить и обновить' : 'Показать файл';
    el('update-page').hidden = !update.page;

    // Напоминание вне настроек: кнопка внизу и метка на слоте настроек. В режиме «Не показывать» их нет.
    const pending = mode !== 'off' && ['available', 'downloading', 'preparing', 'ready'].includes(status);
    el('update-footer').hidden = !pending;
    el('update-footer-label').textContent = status === 'ready' ? 'Перезапустить · ' + update.version : status === 'preparing' ? 'Устанавливаем ' + update.version : status === 'downloading' ? 'Скачиваем ' + update.version + (update.progress == null ? '' : ' · ' + update.progress + '%') : 'Обновление ' + update.version;
    document.querySelector('.rail-button[data-view="settings"]').classList.toggle('has-alert', pending);
    if (mode === 'notify' && status === 'available' && announced !== update.version) { announced = update.version; notify('Вышла версия ' + update.version + ' — она ждёт в настройках'); }
    if (mode === 'auto' && status === 'ready' && (!update.installed || update.prepared) && announced !== 'ready ' + update.version) { announced = 'ready ' + update.version; notify('Версия ' + update.version + (update.installed ? ' установлена и откроется' : ' скачана и запустится') + ' при следующем запуске'); }
  }
  async function act(callback) {
    failure = '';
    try { return await callback(); }
    catch (error) { failure = clean(error.message); return null; }
    finally { render(); }
  }
  for (const button of el('update-modes').children) button.addEventListener('click', () => act(() => api.saveSettings({ updates: button.dataset.updateMode })));
  el('update-check').addEventListener('click', () => act(() => api.checkUpdates()));
  el('update-download').addEventListener('click', () => act(() => api.downloadUpdate()));
  el('update-cancel').addEventListener('click', () => act(() => api.cancelUpdate()));
  el('update-apply').addEventListener('click', () => act(() => api.applyUpdate()));
  el('update-page').addEventListener('click', () => act(() => api.openUpdatePage()));
  el('update-footer').addEventListener('click', () => {
    document.querySelector('.rail-button[data-view="settings"]').click();
    el('update-card').scrollIntoView({ block: 'center' });
  });
  api.onEvent(event => { if (event.type === 'state') { data = event.state; render(); } });
  api.getState().then(state => { data ||= state; render(); }).catch(() => {});
})();
