(() => {
  'use strict';
  // Пасхалки: код Konami, змейка, экран отладки F3 и стук по логотипу. Достижения за них выдаёт extras.js.
  const api = window.launcher, el = id => document.getElementById(id);
  const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const trophy = id => window.veyraTrophy?.(id);
  const typing = () => document.activeElement?.matches('input:not([type="checkbox"]):not([type="range"]), textarea, select, [contenteditable="true"]');
  let data = null;

  // ── Последовательности клавиш: по физическим кнопкам, поэтому раскладка не важна ──
  const sequences = [
    { keys: ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'KeyB', 'KeyA'], run: konami },
    { keys: ['KeyS', 'KeyN', 'KeyA', 'KeyK', 'KeyE'], run: openSnake },
  ];
  const progress = new Map();
  document.addEventListener('keydown', event => {
    if (event.repeat || event.ctrlKey || event.altKey || event.metaKey || typing()) return;
    if (event.code === 'F3') { event.preventDefault(); toggleDebug(); return; }
    if (document.querySelector('dialog[open]')) return;
    for (const sequence of sequences) {
      let step = progress.get(sequence) || 0;
      step = event.code === sequence.keys[step] ? step + 1 : event.code === sequence.keys[0] ? 1 : 0;
      if (step === sequence.keys.length) { step = 0; sequence.run(); }
      progress.set(sequence, step);
    }
  });

  // ── Код Konami: дождь из блоков и тридцать жизней ──
  function konami() {
    trophy('konami');
    window.dispatchEvent(new CustomEvent('veyra:notify', { detail: { message: '+30 жизней. Теперь точно не страшно копать вниз' } }));
    if (calm()) return;
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d'), scale = devicePixelRatio || 1;
    canvas.className = 'block-rain';
    canvas.width = innerWidth * scale; canvas.height = innerHeight * scale;
    document.body.append(canvas);
    context.scale(scale, scale);
    const colors = ['#d29a8a', '#a7acc9', '#8eae91', '#f0e1d3', '#cf7d74', '#ecccc1'];
    const blocks = Array.from({ length: 70 }, () => ({
      x: Math.random() * innerWidth, y: -40 - Math.random() * innerHeight * .8, size: 12 + Math.floor(Math.random() * 4) * 6,
      speed: 3 + Math.random() * 5, spin: Math.floor(Math.random() * 4), color: colors[Math.floor(Math.random() * colors.length)],
    }));
    const started = performance.now();
    const frame = now => {
      context.clearRect(0, 0, innerWidth, innerHeight);
      for (const block of blocks) {
        block.y += block.speed;
        context.fillStyle = block.color; context.fillRect(Math.round(block.x), Math.round(block.y), block.size, block.size);
        context.fillStyle = 'rgba(23, 19, 26, .35)'; context.fillRect(Math.round(block.x), Math.round(block.y) + block.size - 3, block.size, 3);
        context.fillStyle = 'rgba(255, 255, 255, .28)'; context.fillRect(Math.round(block.x), Math.round(block.y), block.size, 3);
      }
      if (now - started < 3200) requestAnimationFrame(frame);
      else canvas.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: 'steps(4)' }).finished.catch(() => {}).finally(() => canvas.remove());
    };
    requestAnimationFrame(frame);
  }

  // ── Змейка ──
  const dialog = el('snake-dialog'), board = el('snake-board'), paint = board.getContext('2d');
  const SIZE = 18, CELL = board.width / SIZE;
  const bestScore = () => { try { return Number(localStorage.getItem('veyra.snakeBest')) || 0; } catch { return 0; } };
  let game = null, timer = 0;
  function openSnake() {
    trophy('snake');
    reset();
    if (!dialog.open) dialog.showModal();
    board.focus();
  }
  function reset() {
    clearTimeout(timer);
    const middle = SIZE >> 1;
    game = { body: [[middle, middle], [middle - 1, middle], [middle - 2, middle]], direction: [1, 0], queued: [], apple: null, score: 0, state: 'ready' };
    placeApple();
    draw();
  }
  function placeApple() {
    const free = [];
    for (let x = 0; x < SIZE; x++) for (let y = 0; y < SIZE; y++) if (!game.body.some(([bx, by]) => bx === x && by === y)) free.push([x, y]);
    game.apple = free[Math.floor(Math.random() * free.length)] || null;
  }
  function tick() {
    if (!game || game.state !== 'playing') return;
    const next = game.queued.shift();
    if (next) game.direction = next;
    const [hx, hy] = game.body[0], head = [hx + game.direction[0], hy + game.direction[1]];
    const eating = game.apple && head[0] === game.apple[0] && head[1] === game.apple[1];
    const body = eating ? game.body : game.body.slice(0, -1);
    if (head[0] < 0 || head[1] < 0 || head[0] >= SIZE || head[1] >= SIZE || body.some(([bx, by]) => bx === head[0] && by === head[1])) return over();
    game.body = [head, ...body];
    if (eating) {
      game.score++;
      if (game.score === 10) trophy('snake-10');
      if (game.score === 30) trophy('snake-30');
      placeApple();
      if (!game.apple) return over();
    }
    draw();
    timer = setTimeout(tick, Math.max(60, 140 - game.score * 3));
  }
  function over() {
    game.state = 'over';
    try { if (game.score > bestScore()) localStorage.setItem('veyra.snakeBest', String(game.score)); } catch { /* рекорд живёт до перезапуска */ }
    draw();
  }
  function steer(direction) {
    if (!game) return;
    if (game.state !== 'playing') {
      if (game.state === 'over') reset();
      game.state = 'playing';
      timer = setTimeout(tick, 140);
    }
    const last = game.queued.at(-1) || game.direction;
    if (direction[0] === -last[0] && direction[1] === -last[1] || direction[0] === last[0] && direction[1] === last[1]) return;
    if (game.queued.length < 3) game.queued.push(direction);
  }
  function draw() {
    paint.fillStyle = '#1d181f'; paint.fillRect(0, 0, board.width, board.height);
    paint.fillStyle = '#231d25';
    for (let x = 0; x < SIZE; x++) for (let y = (x % 2); y < SIZE; y += 2) paint.fillRect(x * CELL, y * CELL, CELL, CELL);
    if (game.apple) {
      const [ax, ay] = game.apple, unit = CELL / 6;
      paint.fillStyle = '#cf7d74'; paint.fillRect(ax * CELL + unit, ay * CELL + unit * 1.5, unit * 4, unit * 4);
      paint.fillStyle = '#ecccc1'; paint.fillRect(ax * CELL + unit * 1.5, ay * CELL + unit * 2, unit, unit);
      paint.fillStyle = '#8eae91'; paint.fillRect(ax * CELL + unit * 3, ay * CELL + unit * .5, unit * 1.5, unit);
    }
    game.body.forEach(([x, y], index) => {
      paint.fillStyle = index === 0 ? '#d29a8a' : index % 2 ? '#8eae91' : '#729275';
      paint.fillRect(x * CELL + 1, y * CELL + 1, CELL - 2, CELL - 2);
    });
    const [hx, hy] = game.body[0], [dx, dy] = game.direction, eye = CELL / 6;
    paint.fillStyle = '#17131a';
    for (const side of [-1, 1]) paint.fillRect(hx * CELL + CELL / 2 - eye / 2 + (dy ? side * eye * 1.4 : dx * eye), hy * CELL + CELL / 2 - eye / 2 + (dx ? side * eye * 1.4 : dy * eye), eye, eye);
    el('snake-score').textContent = game.score;
    el('snake-best').textContent = Math.max(bestScore(), game.score);
    const message = el('snake-message');
    message.hidden = game.state === 'playing';
    message.textContent = game.state === 'over' ? 'Конец игры · яблок: ' + game.score + '. Стрелка — заново' : game.state === 'paused' ? 'Пауза · пробел — продолжить' : 'Стрелки или WASD — начать';
  }
  const directions = { ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1], ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0] };
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') return;
    if (directions[event.code]) { event.preventDefault(); event.stopPropagation(); steer(directions[event.code]); return; }
    if (event.code === 'Space' && game && game.state !== 'ready') {
      event.preventDefault(); event.stopPropagation();
      if (game.state === 'over') { reset(); return; }
      game.state = game.state === 'paused' ? 'playing' : 'paused';
      clearTimeout(timer);
      if (game.state === 'playing') timer = setTimeout(tick, 140);
      draw();
    }
  });
  // Закрытая змейка не тратит процессор и не продолжает игру в фоне.
  dialog.addEventListener('close', () => { clearTimeout(timer); if (game?.state === 'playing') game.state = 'paused'; });
  el('snake-restart').addEventListener('click', () => { reset(); board.focus(); });

  // ── Экран отладки F3 ──
  const debug = el('debug-screen');
  let debugTimer = 0, pointer = [0, 0], fps = 0, frames = 0, counted = performance.now();
  document.addEventListener('pointermove', event => { pointer = [event.clientX, event.clientY]; }, { passive: true });
  const count = now => {
    frames++;
    if (now - counted >= 1000) { fps = Math.round(frames * 1000 / (now - counted)); frames = 0; counted = now; }
    if (!debug.hidden) requestAnimationFrame(count);
  };
  function toggleDebug() {
    debug.hidden = !debug.hidden;
    clearInterval(debugTimer);
    if (debug.hidden) return;
    trophy('debug');
    frames = 0; counted = performance.now(); requestAnimationFrame(count);
    renderDebug();
    debugTimer = setInterval(renderDebug, 500);
  }
  function renderDebug() {
    const state = data, view = document.querySelector('.rail-button.is-active')?.dataset.tip || 'Главная';
    const played = state ? state.instances.reduce((sum, item) => sum + (item.playedMs || 0), 0) : 0;
    const clients = state?.runningClients || [], used = clients.reduce((sum, run) => sum + run.memoryGb, 0) + (state?.server?.pid ? state.server.memoryGb || 0 : 0);
    const facing = ['юг (к +Z)', 'запад (к −X)', 'север (к −Z)', 'восток (к +X)'][Math.floor(((Math.atan2(pointer[1] - innerHeight / 2, pointer[0] - innerWidth / 2) * 180 / Math.PI) + 405) % 360 / 90)];
    const left = [
      'Veyra ' + (state?.appVersion || '') + ' (veyra/' + (state?.settings.accountMode || 'local') + ')',
      fps + ' fps · T: ∞ · vsync',
      'Сборок: ' + (state?.instances.length || 0) + ' · клиентов: ' + clients.length + ' · сервер: ' + (state?.server?.status === 'ready' ? 'работает' : 'спит'),
      '',
      'XYZ: ' + pointer[0] + ' / 64 / ' + pointer[1],
      'Блок: ' + (pointer[0] >> 4) + ' 4 ' + (pointer[1] >> 4),
      'Направление: ' + facing,
      'Биом: veyra:' + (view === 'Сервер' ? 'server_plains' : view === 'Достижения' ? 'trophy_hills' : view === 'Журнал' ? 'log_forest' : 'launcher_meadow'),
      'Время в игре: ' + Math.floor(played / 3600000) + ' ч ' + Math.floor(played % 3600000 / 60000) + ' мин',
    ];
    const right = [
      'Java: Electron ' + (navigator.userAgent.match(/Electron\/([\d.]+)/)?.[1] || '?'),
      'Память: ' + used + ' из ' + (state?.maxMemoryGb || '?') + ' ГБ выделено',
      'Экран: ' + innerWidth + '×' + innerHeight,
      '',
      'Раздел: ' + view,
      'F3 — закрыть',
    ];
    const column = lines => lines.map(line => { const row = document.createElement('span'); row.textContent = line; if (!line) row.className = 'is-gap'; return row; });
    el('debug-left').replaceChildren(...column(left));
    el('debug-right').replaceChildren(...column(right));
  }

  // ── Логотип: десять стуков подряд, и он делает сальто ──
  const logo = document.querySelector('.rail-logo');
  let knocks = 0, knockTimer = 0;
  logo.addEventListener('click', () => {
    clearTimeout(knockTimer);
    knockTimer = setTimeout(() => { knocks = 0; }, 1500);
    if (++knocks < 10) { if (!calm()) logo.animate([{ translate: '0 0' }, { translate: '0 3px' }, { translate: '0 0' }], { duration: 120, easing: 'steps(2)' }); return; }
    knocks = 0;
    trophy('woodpecker');
    if (!calm()) logo.animate([{ rotate: '0deg', scale: 1 }, { rotate: '180deg', scale: 1.3 }, { rotate: '360deg', scale: 1 }], { duration: 700, easing: 'steps(12)' });
  });

  api.onEvent(event => { if (event.type === 'state') data = event.state; });
  api.getState().then(state => { data ||= state; }).catch(() => {});
})();
