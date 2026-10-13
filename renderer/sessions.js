(() => {
  const api = window.launcher, el = id => document.getElementById(id);
  let data, id = '', busy = false, forceArmed = false;
  const error = text => { el('sessions-error').textContent = String(text || '').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); el('sessions-error').hidden = !text; };
  async function act(callback) { busy = true; error(''); render(); try { const result = await callback(); data = await api.getState(); return result; } catch (failure) { error(failure.message); } finally { busy = false; render(); } }
  function render() {
    if (!data || !el('sessions-dialog').open) return;
    const build = data.instances.find(item => item.id === id), server = data.server;
    el('sessions-build').textContent = build ? build.name + ' · Minecraft ' + build.minecraftVersion + ' · ' + build.loader : '';
    const running = server && ['preparing','starting','ready','stopping'].includes(server.status);
    const owner = data.instances.find(item => item.id === server?.instanceId);
    el('server-network-addresses').textContent = server?.addresses?.length ? 'Для других компьютеров: ' + server.addresses.join(' · ') : 'На этом ПК: 127.0.0.1:25565. Для подключения из сети используйте IP этого компьютера.';
    el('server-state').textContent = server ? ({ preparing: 'Подготовка', starting: 'Запускается', ready: 'Готов · ' + (owner?.name || ''), stopping: 'Сохраняем и останавливаем', stopped: 'Остановлен', error: 'Ошибка' }[server.status]) : 'Остановлен';
    el('server-start').hidden = running; el('server-start').disabled = busy || Boolean(data.operation) || !el('server-eula').checked;
    el('server-stop').hidden = !server?.pid || !running || server.status === 'preparing'; el('server-stop').disabled = server?.status === 'stopping';
    el('server-force').hidden = server?.status !== 'stopping';
    el('server-cancel').hidden = data.operation?.type !== 'server';
    el('server-join').hidden = server?.status !== 'ready' || server.instanceId !== id; el('server-join').disabled = busy || Boolean(data.operation);
    el('server-eula-row').hidden = running;
    el('sessions-add').disabled = busy || Boolean(data.operation) || !build?.installed;
    const list = el('sessions-list'), signature = JSON.stringify(data.runningClients) + data.instances.map(item => item.name).join();
    if (list.dataset.signature !== signature) { list.dataset.signature = signature; list.replaceChildren();
    for (const run of data.runningClients || []) {
      const row = document.createElement('div'); row.className = 'client-session'; const text = document.createElement('div'); const title = document.createElement('strong'); title.textContent = run.name; const subtitle = document.createElement('small'); subtitle.textContent = (data.instances.find(item => item.id === run.instanceId)?.name || '') + ' · ' + run.memoryGb + ' ГБ'; text.append(title, subtitle);
      const stop = document.createElement('button'); stop.className = 'text-button'; stop.type = 'button'; stop.textContent = run.stopping ? 'Останавливаем…' : 'Остановить'; stop.disabled = run.stopping; stop.addEventListener('click', () => act(() => api.stopGame(run.id))); row.append(text, stop); list.append(row);
    }
    if (!list.children.length) list.textContent = 'Клиенты пока не запущены';
    }
    const log = el('server-log'), follow = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    if (log.textContent !== server?.lines && server?.lines) { log.textContent = server.lines; if (follow) log.scrollTop = log.scrollHeight; }
    el('server-skipped').hidden = !server?.skipped?.length;
    el('server-skipped-title').textContent = 'Пропущено модов: ' + (server?.skipped?.length || 0);
    el('server-skipped-list').replaceChildren(...(server?.skipped || []).map(item => { const li = document.createElement('li'); li.textContent = item.name + ' — ' + item.reason; return li; }));
    if (server?.error && !busy) error(server.error);
  }
  el('hero-server').addEventListener('click', async () => { data = await api.getState(); id = data.settings.selectedInstanceId; el('server-eula').checked = await api.serverEula(id); error(''); clearTimeout(el('sessions-dialog').closeTimer); el('sessions-dialog').classList.remove('is-closing'); el('sessions-dialog').showModal(); render(); });
  el('server-eula').addEventListener('change', render);
  el('server-eula-link').addEventListener('click', event => { event.preventDefault(); act(() => api.openServerEula()); });
  el('server-start').addEventListener('click', () => act(() => api.startServer(id, el('server-eula').checked)));
  el('server-stop').addEventListener('click', async () => { const stopped = await act(() => api.stopServer()); if (stopped === false) error('Сервер не ответил на stop. Принудительная остановка может повредить сохранения.'); });
  el('server-force').addEventListener('click', () => { if (!forceArmed) { forceArmed = true; el('server-force').textContent = 'Подтвердить завершение'; error('Несохранённые изменения могут потеряться. Нажмите ещё раз для подтверждения.'); setTimeout(() => { forceArmed = false; el('server-force').textContent = 'Принудительно'; }, 5000); return; } forceArmed = false; act(() => api.stopServer(true)); });
  el('server-cancel').addEventListener('click', () => api.cancelOperation());
  el('sessions-add').addEventListener('click', () => act(() => api.launchInstance(id)));
  el('server-join').addEventListener('click', () => act(() => api.launchInstance(id, true)));
  el('server-copy').addEventListener('click', () => act(async () => { await api.copyServerAddress(); el('server-copy').textContent = 'Скопировано'; setTimeout(() => { el('server-copy').textContent = 'Копировать'; }, 1800); }));
  el('server-folder').addEventListener('click', () => act(() => api.openServerFolder(data.server?.pid && !['stopped','error'].includes(data.server.status) ? data.server.instanceId : id)));
  api.onEvent(event => { if (event.type === 'state') { data = event.state; render(); } });
})();
