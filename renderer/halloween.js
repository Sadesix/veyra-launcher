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
  // Паутина — веер из шести лучей и четырёх провисших колец в углу рисунка 120 × 120.
  const RAYS = [0, 18, 36, 54, 72, 90].map(angle => [Math.cos(angle * Math.PI / 180), Math.sin(angle * Math.PI / 180)]), RINGS = [22, 44, 68, 94];
  function web(className) {
    let path = RAYS.map(([x, y]) => 'M0 0L' + (x * 120).toFixed(1) + ' ' + (y * 120).toFixed(1)).join('');
    for (const radius of RINGS) {
      path += RAYS.map(([x, y], index) => {
        const point = (x * radius).toFixed(1) + ' ' + (y * radius).toFixed(1);
        if (!index) return 'M' + point;
        const [px, py] = RAYS[index - 1], sag = radius * .82;
        return 'Q' + (((px + x) / 2) * sag).toFixed(1) + ' ' + (((py + y) / 2) * sag).toFixed(1) + ' ' + point;
      }).join('');
    }
    return '<svg class="spooky-web ' + className + '" viewBox="0 0 120 120" aria-hidden="true"><path d="' + path + '"/></svg>';
  }
  // Паук висит на узле внешнего кольца правой паутины: верх нити привязан к узлу, качается только её длина.
  // Узел задан в долях стороны рисунка; правая паутина отражена, поэтому x отсчитан от левого края.
  function corner() {
    const [x, y] = RAYS[3], knot = '--knot-x:' + (1 - x * RINGS[3] / 120).toFixed(4) + ';--knot-y:' + (y * RINGS[3] / 120).toFixed(4);
    return '<div class="spooky-corner" style="' + knot + '">' + web('is-right') +
      '<div class="spooky-drop"><i class="spooky-thread"></i><button class="spooky-spider" type="button" tabindex="-1" aria-label="Паук">' + icon('spider') + '</button></div></div>';
  }
  // Мышь — полоска кадров «крылья вверх, середина, вниз, середина»: steps(4) листает их, а тело подпрыгивает в такт взмахам.
  const BAT = ['bat', 'batmid', 'batdown', 'batmid'];
  const bat = () => '<span class="bat-sprite"><svg class="icon bat-strip" viewBox="0 0 48 12" aria-hidden="true">' + BAT.map((name, index) => '<use href="#i-' + name + '" x="' + index * 12 + '" width="12" height="12"/>').join('') + '</svg></span>';

  // ── Украшения: луна и звёзды позади окна, паутина, паук, туман, мыши и призрак поверх ──
  let back = null, front = null, extras = [], timers = [], spawned = new Set();
  function decorate() {
    if (front) return;
    back = document.createElement('div');
    back.className = 'spooky-back';
    back.innerHTML = moon() + Array.from({ length: 16 }, (_value, index) => '<i class="spooky-star" style="--x:' + ((index * 37 + 11) % 97) + ';--y:' + ((index * 53 + 7) % 23) + ';--d:' + (index % 7) + '"></i>').join('');
    front = document.createElement('div');
    front.className = 'spooky-front';
    front.innerHTML = web('is-left') + corner() + '<div class="spooky-fog"><i></i><i></i></div>';
    document.body.append(back, front);
    const drop = front.querySelector('.spooky-drop');
    // Без @property длина нити менялась бы рывками — в таком браузере паук просто висит.
    if (!window.CSS?.registerProperty) drop.classList.add('is-still');
    // Испуганный паук сматывает нить и прячется в паутине, а потом снова спускается.
    drop.querySelector('.spooky-spider').addEventListener('click', () => {
      if (drop.classList.contains('is-climbing')) return;
      drop.classList.add('is-climbing');
      setTimeout(() => drop.classList.remove('is-climbing'), 2900);
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
    if (mark) { const perched = document.createElement('span'); perched.className = 'wordmark-bat'; perched.innerHTML = bat(); mark.append(perched); extras.push(perched); }
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
  // Мыши летят стайкой, но у каждой свой размер, частота взмахов и путь; после пролёта элементы удаляются.
  function flock(count) {
    if (!front) return;
    const width = front.clientWidth, height = front.clientHeight, ltr = Math.random() > .5;
    for (let index = 0; index < count; index++) {
      const flyer = document.createElement('span');
      flyer.className = 'spooky-bat';
      flyer.innerHTML = bat();
      flyer.style.setProperty('--size', (18 + Math.round(Math.random() * 3) * 6) + 'px');
      flyer.style.setProperty('--flap', Math.round(260 + Math.random() * 140) + 'ms');
      flyer.style.setProperty('--phase', -Math.round(Math.random() * 400) + 'ms');
      front.append(flyer); spawned.add(flyer);
      fly(flyer, ltr ? -60 : width + 60, ltr ? width + 60 : -60, 40 + Math.random() * height * .45, 6500 + Math.random() * 3000, index * 260 + Math.random() * 300);
    }
  }
  // Путь — плавная кривая из двух волн с набором высоты. Скорость то растёт, то падает, а иногда мышь
  // расправляет крылья и планирует вниз: класс is-gliding держит средний кадр, пока она скользит.
  function fly(flyer, from, to, start, duration, delay) {
    const steps = 48, rand = (low, high) => low + Math.random() * (high - low), smooth = value => value <= 0 ? 0 : value >= 1 ? 1 : value * value * (3 - 2 * value);
    const waves = [[rand(14, 40), rand(.6, 1.5), rand(0, 7)], [rand(4, 12), rand(2.2, 3.8), rand(0, 7)]], pace = [rand(1, 2.2), rand(0, 7)];
    const glide = Math.random() < .65 ? [rand(.2, .62), rand(.1, .18)] : null;
    // 1 посреди планирования и 0 вне его; края сглажены, чтобы кривая не ломалась.
    const gliding = t => glide ? smooth((t - glide[0]) / .04) * (1 - smooth((t - glide[0] - glide[1]) / .04)) : 0;
    const speed = t => (1 + .38 * Math.sin(t * Math.PI * 2 * pace[0] + pace[1])) * (1 + .25 * gliding(t));
    const travelled = [0];
    for (let step = 0; step < steps; step++) travelled.push(travelled[step] + speed((step + .5) / steps));
    const frames = travelled.map((distance, step) => {
      const t = step / steps, x = from + (to - from) * distance / travelled[steps];
      const sway = waves.reduce((sum, [amplitude, frequency, phase]) => sum + amplitude * Math.sin(t * Math.PI * 2 * frequency + phase), 0) * (1 - .7 * gliding(t));
      const sink = glide ? 30 * smooth((t - glide[0]) / glide[1]) : 0;
      return { transform: 'translate(' + x.toFixed(1) + 'px,' + (start + sway + sink - t * 36).toFixed(1) + 'px)' };
    });
    const flight = flyer.animate(frames, { duration, delay, easing: 'linear', fill: 'both' });
    if (glide) {
      setTimeout(() => flyer.classList.add('is-gliding'), delay + glide[0] * duration);
      setTimeout(() => flyer.classList.remove('is-gliding'), delay + (glide[0] + glide[1]) * duration);
    }
    flight.finished.catch(() => {}).finally(() => { flyer.remove(); spawned.delete(flyer); });
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
      const flyer = document.createElement('span');
      flyer.className = 'intro-bat';
      flyer.style.setProperty('--i', index);
      flyer.innerHTML = bat();
      stage.append(flyer); extras.push(flyer);
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
