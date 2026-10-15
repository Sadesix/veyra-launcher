(() => {
  'use strict';
  // Хеллоуин: с 15 октября по 2 ноября тема включена по умолчанию, и только в эти дни в настройках виден её переключатель.
  // Скрипт подключён сразу после иконок, чтобы праздничная палитра была на месте уже на заставке.
  const root = document.documentElement, el = id => document.getElementById(id);
  const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const allowed = window.launcher?.festive !== 'off';
  const inSeason = (date = new Date()) => allowed && (date.getMonth() === 9 && date.getDate() >= 15 || date.getMonth() === 10 && date.getDate() <= 2);
  // Выбор хранится для каждого года отдельно: выключенная в этом году тема в следующем снова включится сама.
  const key = () => 'veyra.halloween.' + new Date().getFullYear();
  const chosen = () => { try { return localStorage.getItem(key()) !== '0'; } catch { return true; } };
  const icon = (name, className = '') => '<svg class="icon ' + className + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>';

  const phrases = ['Сладость или гадость!', 'Тыквы уже горят', 'Крипер? Показалось.', 'Скелеты тоже празднуют', 'Наденьте тыкву — эндермен не тронет', 'Джек-фонарь светит ярче факела',
    'Полнолуние — слаймы в болотах', 'Зомби пришли за конфетами', 'Бу!', 'Не копай вниз в Хеллоуин', 'Ведьма уже варит зелья', 'Летучие мыши знают все пещеры',
    'Призраки любят Незер', 'Ночь длинная — факелов больше', 'Паутина? Нужны ножницы', 'Тыквенный пирог сам себя не испечёт', 'Кто-то скребётся в сундуке…',
    '↑ ↑ ↓ ↓ ← → ← → B A', 'Ссс… набери snake'];
  function greeting(date = new Date()) {
    const hour = date.getHours();
    if (date.getMonth() === 9 && date.getDate() === 31) return 'Счастливого Хеллоуина';
    return hour < 6 ? 'Ведьминой ночи' : hour < 12 ? 'Жуткого утра' : hour < 18 ? 'Страшно доброго дня' : 'Жуткого вечера';
  }
  const note = 'Тыквы зажжены, мобы надели костюмы. Самое время для жуткого приключения.';

  // ── Пиксельная луна и паутина: та же сетка, что у иконок ──
  const MOON = ['.....######.....', '...##########...', '..####oo######..', '.####oooo######.', '.####oooo###oo#.', '####oo####o#oo##', '###########o####', '#####oo#########',
    '####oooo####oo##', '####oooo###oooo#', '.####oo####oooo.', '.###########oo#.', '..############..', '...##########...', '.....######.....', '................'];
  function moon() {
    let cells = '';
    MOON.forEach((row, y) => [...row].forEach((tone, x) => { if (tone !== '.') cells += '<rect x="' + x + '" y="' + y + '" width="1" height="1"' + (tone === 'o' ? ' class="crater"' : '') + '/>'; }));
    return '<svg class="spooky-moon" viewBox="0 0 16 16" aria-hidden="true">' + cells + '</svg>';
  }
  function web(className) {
    const rays = [0, 18, 36, 54, 72, 90].map(angle => [Math.cos(angle * Math.PI / 180), Math.sin(angle * Math.PI / 180)]);
    let path = rays.map(([x, y]) => 'M0 0L' + (x * 120).toFixed(1) + ' ' + (y * 120).toFixed(1)).join('');
    for (const radius of [22, 44, 68, 94]) {
      path += rays.map(([x, y], index) => {
        const point = (x * radius).toFixed(1) + ' ' + (y * radius).toFixed(1);
        if (!index) return 'M' + point;
        const [px, py] = rays[index - 1], sag = radius * .82;
        return 'Q' + (((px + x) / 2) * sag).toFixed(1) + ' ' + (((py + y) / 2) * sag).toFixed(1) + ' ' + point;
      }).join('');
    }
    return '<svg class="spooky-web ' + className + '" viewBox="0 0 120 120" aria-hidden="true"><path d="' + path + '"/></svg>';
  }

  // ── Украшения: луна и звёзды позади окна, паутина, паук, туман, мыши и призрак поверх ──
  let back = null, front = null, extras = [], timers = [], spawned = new Set();
  function decorate() {
    if (front) return;
    back = document.createElement('div');
    back.className = 'spooky-back';
    back.innerHTML = moon() + Array.from({ length: 16 }, (_value, index) => '<i class="spooky-star" style="--x:' + ((index * 37 + 11) % 97) + ';--y:' + ((index * 53 + 7) % 23) + ';--d:' + (index % 7) + '"></i>').join('');
    front = document.createElement('div');
    front.className = 'spooky-front';
    front.innerHTML = web('is-left') + web('is-right') + '<div class="spooky-fog"><i></i><i></i></div>' +
      '<button class="spooky-spider" type="button" tabindex="-1" aria-label="Паук"><i></i>' + icon('spider') + '</button>';
    document.body.append(back, front);
    front.querySelector('.spooky-spider').addEventListener('click', event => {
      const spider = event.currentTarget;
      if (spider.classList.contains('is-climbing')) return;
      spider.classList.add('is-climbing');
      setTimeout(() => spider.classList.remove('is-climbing'), 4200);
    });
    // Тыквы-фонари по краям хотбара и на обложке выбранной сборки.
    const rail = document.querySelector('.icon-rail'), hero = el('hero-card');
    for (const side of ['left', 'right']) {
      const lantern = document.createElement('span');
      lantern.className = 'hotbar-lantern is-' + side;
      lantern.innerHTML = icon('pumpkin');
      rail?.append(lantern); extras.push(lantern);
    }
    if (hero) {
      const scene = document.createElement('div');
      scene.className = 'hero-spooky';
      scene.setAttribute('aria-hidden', 'true');
      scene.innerHTML = web('is-hero') + '<span class="hero-lantern is-big">' + icon('pumpkin') + '</span><span class="hero-lantern is-small">' + icon('pumpkin') + '</span>';
      hero.querySelector('.hero-motes')?.after(scene); extras.push(scene);
    }
    const mark = document.querySelector('.wordmark');
    if (mark) { const bat = document.createElement('span'); bat.className = 'wordmark-bat'; bat.innerHTML = icon('bat'); mark.append(bat); extras.push(bat); }
    if (!calm()) {
      timers.push(setTimeout(() => flock(3), 2500));
      timers.push(setTimeout(ghostLoop, 25000 + Math.random() * 15000));
      timers.push(setTimeout(batLoop, 14000));
    } else timers.push(setTimeout(ghostLoop, 25000));
  }
  function undecorate() {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
    for (const node of [back, front, ...extras, ...spawned]) node?.remove();
    back = front = null; extras = []; spawned = new Set();
  }
  function batLoop() {
    if (!document.hidden) flock(1 + Math.floor(Math.random() * 3));
    timers.push(setTimeout(batLoop, 14000 + Math.random() * 14000));
  }
  // Мыши летят стайкой по волнистой траектории и машут крыльями; после пролёта элементы удаляются.
  function flock(count) {
    if (!front) return;
    const width = front.clientWidth, height = front.clientHeight, ltr = Math.random() > .5;
    for (let index = 0; index < count; index++) {
      const bat = document.createElement('span');
      bat.className = 'spooky-bat';
      bat.innerHTML = icon('bat');
      bat.style.setProperty('--size', (18 + Math.round(Math.random() * 3) * 6) + 'px');
      front.append(bat); spawned.add(bat);
      const start = 40 + Math.random() * height * .45, lift = 30 + Math.random() * 60, from = ltr ? -60 : width + 60, to = ltr ? width + 60 : -60;
      const frames = Array.from({ length: 7 }, (_value, step) => ({ transform: 'translate(' + (from + (to - from) * step / 6) + 'px,' + (start + Math.sin(step * 1.3 + index) * lift - step * 6) + 'px)' + (ltr ? '' : ' scaleX(-1)') }));
      bat.animate(frames, { duration: 6500 + Math.random() * 2500, delay: index * 260, easing: 'linear', fill: 'both' })
        .finished.catch(() => {}).finally(() => { bat.remove(); spawned.delete(bat); });
    }
  }
  function ghostLoop() {
    if (!document.hidden) summonGhost();
    timers.push(setTimeout(ghostLoop, 50000 + Math.random() * 60000));
  }
  // Призрак проплывает внизу окна; поймавший его получает секретное достижение.
  function summonGhost() {
    if (!front || front.querySelector('.spooky-ghost')) return null;
    const ghost = document.createElement('button');
    ghost.type = 'button'; ghost.tabIndex = -1; ghost.className = 'spooky-ghost'; ghost.setAttribute('aria-label', 'Призрак');
    ghost.innerHTML = icon('ghost');
    front.append(ghost); spawned.add(ghost);
    const width = front.clientWidth, height = front.clientHeight, ltr = Math.random() > .5, base = height * (.45 + Math.random() * .3);
    const done = () => { ghost.remove(); spawned.delete(ghost); };
    const flight = calm()
      ? ghost.animate([{ opacity: 0, transform: 'translate(' + width * .7 + 'px,' + base + 'px)' }, { opacity: .85, offset: .1 }, { opacity: .85, offset: .9 }, { opacity: 0, transform: 'translate(' + width * .7 + 'px,' + base + 'px)' }], { duration: 10000, fill: 'both' })
      : ghost.animate(Array.from({ length: 9 }, (_value, step) => ({
        transform: 'translate(' + ((ltr ? -70 : width + 70) + (ltr ? 1 : -1) * (width + 140) * step / 8) + 'px,' + (base + Math.sin(step * 1.1) * 26) + 'px)' + (ltr ? '' : ' scaleX(-1)'),
        opacity: step === 0 || step === 8 ? 0 : step % 3 === 0 ? .55 : .85,
      })), { duration: 16000, easing: 'linear', fill: 'both' });
    flight.finished.then(done, () => {});
    ghost.addEventListener('click', () => {
      if (ghost.classList.contains('is-caught')) return;
      ghost.classList.add('is-caught');
      const box = ghost.getBoundingClientRect(), shell = front.getBoundingClientRect();
      flight.cancel();
      ghost.style.transform = 'translate(' + (box.left - shell.left) + 'px,' + (box.top - shell.top) + 'px)';
      window.veyraTrophy?.('ghostbuster');
      window.dispatchEvent(new CustomEvent('veyra:notify', { detail: { message: 'Бу! Призрак пойман' } }));
      ghost.animate([{ opacity: .9, scale: 1 }, { opacity: 0, scale: 2.2 }], { duration: calm() ? 1 : 420, easing: 'steps(6)', fill: 'forwards' }).finished.finally(done);
    });
    return ghost;
  }

  // ── Заставка: мыши кружат вокруг логотипа ──
  function introBats() {
    const stage = document.querySelector('.intro-stage');
    if (!stage || el('intro')?.hidden || calm()) return;
    for (let index = 0; index < 3; index++) {
      const bat = document.createElement('span');
      bat.className = 'intro-bat';
      bat.style.setProperty('--i', index);
      bat.innerHTML = icon('bat');
      stage.append(bat); extras.push(bat);
    }
  }

  // ── Включение и выключение ──
  function apply(on, announce = true) {
    const was = root.classList.contains('is-halloween');
    root.classList.toggle('is-halloween', on);
    const toggle = el('ui-halloween');
    if (toggle) toggle.checked = on;
    const small = document.querySelector('#advancement small');
    if (small) small.textContent = on ? 'Жуткое достижение!' : 'Достижение получено!';
    if (on && document.body) decorate(); else undecorate();
    if (announce && was !== on) window.dispatchEvent(new CustomEvent('veyra:halloween', { detail: { on } }));
  }
  function refresh() {
    const season = inSeason();
    const row = el('halloween-row');
    if (row) row.hidden = !season;
    apply(season && chosen());
  }
  root.classList.toggle('is-halloween', inSeason() && chosen());
  window.veyraHalloween = Object.freeze({ inSeason, active: () => root.classList.contains('is-halloween'), phrases, greeting, note, summonGhost });

  document.addEventListener('DOMContentLoaded', () => {
    el('ui-halloween')?.addEventListener('change', event => {
      try { localStorage.setItem(key(), event.target.checked ? '1' : '0'); } catch { /* выбор действует до перезапуска */ }
      apply(event.target.checked);
    });
    refresh();
    if (root.classList.contains('is-halloween')) introBats();
    // Сезон начинается и заканчивается в полночь — лаунчер, открытый в эти дни, переключится сам.
    setInterval(refresh, 60000);
  });
})();
