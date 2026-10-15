(() => {
  'use strict';
  // Трёхмерный скин Minecraft на CSS 3D: шесть частей тела, у каждой два слоя-коробки из шести граней-холстов.
  // Без библиотек и внешних стилей, поэтому одинаково работает в лаунчере (строгий CSP) и на сайте.
  const script = new URL(document.currentScript?.src || [...document.scripts].map(node => node.src).reverse().find(src => /skin3d\.js(?:[?#]|$)/.test(src)) || location.href, location.href);
  // В лаунчере скрипт лежит в renderer/, на сайте — в assets/: скины по умолчанию ищутся относительно него.
  const skins = new URL(/\/assets\/[^/]*$/.test(script.pathname) ? 'skins/' : '../assets/skins/', script).href;
  const defaultSkin = slim => skins + (slim ? 'veyra-slim.png' : 'veyra-classic.png');
  const U = 10, R = 4; // CSS-пикселей и пикселей холста на один пиксель скина
  const FACES = ['top', 'bottom', 'right', 'front', 'left', 'back'];
  // Свет сверху и чуть слева: верх ярче всех, бока и низ темнее.
  const SHADE = { top: 1, front: .9, back: .84, right: .78, left: .72, bottom: .58 };
  const PRESERVE = 'position:absolute;left:0;top:0;width:0;height:0;transform-style:preserve-3d;';

  // ── Текстура: загрузка и приведение к 64×64, как это делает игра (HttpTexture.processLegacySkin) ──
  // Старый скин 64×32 получает зеркальные левые руку и ногу, основной слой становится непрозрачным
  // с теми цветами, что записаны в файле, а сплошь непрозрачная шапка старого скина — прозрачной (хак Нотча).
  const LEGACY = [[4, 16, 16, 32, 4, 4], [8, 16, 16, 32, 4, 4], [0, 20, 24, 32, 4, 12], [4, 20, 16, 32, 4, 12], [8, 20, 8, 32, 4, 12], [12, 20, 16, 32, 4, 12],
    [44, 16, -8, 32, 4, 4], [48, 16, -8, 32, 4, 4], [40, 20, 0, 32, 4, 12], [44, 20, -8, 32, 4, 12], [48, 20, -16, 32, 4, 12], [52, 20, -8, 32, 4, 12]];
  const SOLID = [[0, 0, 32, 16], [0, 16, 64, 32], [16, 48, 48, 64]];
  function load(url) {
    const target = new URL(url, location.href);
    // Чужой адрес (http(s) или veyra:// лаунчера у страницы с file://) сначала пробуем с CORS, чтобы пиксели можно было прочитать;
    // не вышло — грузим как есть. Для veyra:// лаунчер регистрирует схему с corsEnabled и отвечает Access-Control-Allow-Origin.
    const cors = /^(?:https?|veyra):$/.test(target.protocol) && target.origin !== location.origin;
    return new Promise((resolve, reject) => {
      const attempt = cross => {
        const image = new Image();
        if (cross) image.crossOrigin = 'anonymous';
        image.onload = () => {
          const { naturalWidth: width, naturalHeight: height } = image;
          if (width >= 64 && width % 64 === 0 && (height === width || height * 2 === width)) resolve(image);
          else reject(new Error('Скин должен быть 64×64 или 64×32, а не ' + width + '×' + height));
        };
        image.onerror = () => cross ? attempt(false) : reject(new Error('Скин не загрузился: ' + target.href));
        image.src = target.href;
      };
      attempt(cors);
    });
  }
  // Пиксели картинки ровно как в файле: холст 2D хранит цвет умноженным на прозрачность, и у прозрачного пикселя
  // цвет пропадает, а игра делает такие пиксели основного слоя непрозрачными с записанным цветом. WebGL отдаёт исходные байты.
  let gl = null;
  function raw(image, width, height) {
    try {
      if (!gl || gl.isContextLost()) gl = document.createElement('canvas').getContext('webgl', { antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
      if (!gl) return null;
      const texture = gl.createTexture(), buffer = gl.createFramebuffer();
      try {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        gl.bindFramebuffer(gl.FRAMEBUFFER, buffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null;
        const data = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
        return gl.getError() === gl.NO_ERROR ? data : null;
      } finally {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.bindTexture(gl.TEXTURE_2D, null);
        gl.deleteFramebuffer(buffer); gl.deleteTexture(texture);
      }
    } catch { /* картинка с чужого адреса без CORS или WebGL недоступен */ return null; }
  }
  function prepare(image) {
    const scale = image.naturalWidth / 64, size = 64 * scale, legacy = image.naturalHeight * 2 === image.naturalWidth;
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d', { willReadFrequently: true });
    canvas.width = canvas.height = size;
    context.imageSmoothingEnabled = false;
    const source = raw(image, size, image.naturalHeight);
    let pixels = null;
    if (source) {
      pixels = context.createImageData(size, size);
      const data = pixels.data;
      data.set(source);
      if (legacy) for (const [x, y, dx, dy, w, h] of LEGACY) for (let row = 0; row < h * scale; row++) for (let column = 0; column < w * scale; column++) {
        const from = ((y * scale + row) * size + x * scale + column) * 4, to = (((y + dy) * scale + row) * size + (x + dx + w) * scale - 1 - column) * 4;
        data.copyWithin(to, from, from + 4);
      }
    } else {
      // Запасной путь через холст 2D: прозрачные пиксели основного слоя здесь станут чёрными, а не цветом из файла.
      context.drawImage(image, 0, 0);
      if (legacy) for (const [x, y, dx, dy, w, h] of LEGACY) {
        context.setTransform(-1, 0, 0, 1, (2 * (x + dx) + w) * scale, 0);
        context.drawImage(image, x * scale, y * scale, w * scale, h * scale, (x + dx) * scale, (y + dy) * scale, w * scale, h * scale);
      }
      context.setTransform(1, 0, 0, 1, 0, 0);
      try { pixels = context.getImageData(0, 0, size, size); } catch { /* картинка с чужого адреса: пиксели не читаются */ }
    }
    if (pixels) {
      const data = pixels.data;
      const each = ([x0, y0, x1, y1], visit) => { for (let y = y0 * scale; y < y1 * scale; y++) for (let x = x0 * scale; x < x1 * scale; x++) if (visit((y * size + x) * 4 + 3) === false) return false; return true; };
      const solid = area => each(area, index => { data[index] = 255; });
      solid(SOLID[0]);
      if (legacy && each([32, 0, 64, 32], index => data[index] >= 128)) each([32, 0, 64, 32], index => { data[index] = 0; });
      solid(SOLID[1]); solid(SOLID[2]);
      context.putImageData(pixels, 0, 0);
    } else {
      // Без доступа к пикселям (чужой адрес без CORS) основной слой просто подкладывается чёрным, а хак Нотча не применяется.
      context.globalCompositeOperation = 'destination-over'; context.fillStyle = '#000';
      for (const [x0, y0, x1, y1] of SOLID) context.fillRect(x0 * scale, y0 * scale, (x1 - x0) * scale, (y1 - y0) * scale);
      context.globalCompositeOperation = 'source-over';
    }
    return { canvas, scale, legacy, pixels };
  }
  // Готовые текстуры переиспользуются: один и тот же скин часто показан и головой, и моделью.
  const cache = new Map();
  function texture(url) {
    let promise = cache.get(url);
    if (!promise) {
      promise = Promise.resolve().then(() => load(url)).then(prepare);
      promise.catch(() => { if (cache.get(url) === promise) cache.delete(url); });
      cache.set(url, promise);
      if (cache.size > 16) cache.delete(cache.keys().next().value);
    }
    return promise;
  }
  async function textureOrDefault(url, slim) {
    if (url) try { return { skin: await texture(url), state: 'ready' }; } catch { /* дальше скин по умолчанию */ }
    return { skin: await texture(defaultSkin(slim)), state: url ? 'fallback' : 'ready' };
  }
  // Пустая грань второго слоя не нужна в разметке: меньше слоёв для браузера.
  function empty(skin, [x, y, w, h]) {
    if (!skin.pixels) return false;
    const { data, width } = skin.pixels, s = skin.scale;
    for (let row = y * s; row < (y + h) * s; row++) for (let column = x * s; column < (x + w) * s; column++) if (data[(row * width + column) * 4 + 3]) return false;
    return true;
  }
  // Грань — свой маленький холст: кусок текстуры, при необходимости перевёрнутый, с тенью по направлению грани.
  function crop(skin, [x, y, w, h], flip, shade) {
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d'), s = skin.scale;
    canvas.width = w * R; canvas.height = h * R;
    context.imageSmoothingEnabled = false;
    if (flip) context.setTransform(1, 0, 0, -1, 0, canvas.height);
    context.drawImage(skin.canvas, x * s, y * s, w * s, h * s, 0, 0, canvas.width, canvas.height);
    if (shade < 1) {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.globalCompositeOperation = 'source-atop';
      context.fillStyle = 'rgba(0, 0, 0, ' + (1 - shade).toFixed(3) + ')';
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    return canvas;
  }

  // ── Модель: части тела как в игре (PlayerModel) ──
  // Точка поворота и коробка в пикселях модели (ось Y вниз, ноль — шея), развёртки двух слоёв и раздувание второго.
  function parts(slim) {
    const arm = slim ? 3 : 4, shoulder = slim ? 2.5 : 2;
    return [
      { name: 'head', pivot: [0, 0], box: [-4, -8, -4, 8, 8, 8], uv: [0, 0], over: [32, 0], grow: .5 },
      { name: 'body', pivot: [0, 0], box: [-4, 0, -2, 8, 12, 4], uv: [16, 16], over: [16, 32], grow: .25 },
      { name: 'rightArm', pivot: [-5, shoulder], box: [1 - arm, -2, -2, arm, 12, 4], uv: [40, 16], over: [40, 32], grow: .25 },
      { name: 'leftArm', pivot: [5, shoulder], box: [-1, -2, -2, arm, 12, 4], uv: [32, 48], over: [48, 48], grow: .25 },
      { name: 'rightLeg', pivot: [-2, 12], box: [-2, 0, -2, 4, 12, 4], uv: [0, 16], over: [0, 32], grow: .25 },
      { name: 'leftLeg', pivot: [2, 12], box: [-2, 0, -2, 4, 12, 4], uv: [16, 48], over: [0, 48], grow: .25 },
    ];
  }
  // Развёртка коробки: [x, y, ширина, высота] каждой грани. right — правый бок самого игрока (слева, когда он смотрит на нас).
  function regions([u, v], w, h, d) {
    return { top: [u + d, v, w, d], bottom: [u + d + w, v, w, d], right: [u, v + d, d, h], front: [u + d, v + d, w, h], left: [u + d + w, v + d, d, h], back: [u + 2 * d + w, v + d, w, h] };
  }
  // Грань в CSS: размер и поворот от центра коробки. Нижняя грань в игре перевёрнута по вертикали.
  function placement(face, w, h, d) {
    return {
      top: [w, d, 'rotateX(90deg) translateZ(' + h / 2 + 'px)'], bottom: [w, d, 'rotateX(-90deg) translateZ(' + h / 2 + 'px)'],
      right: [d, h, 'rotateY(-90deg) translateZ(' + w / 2 + 'px)'], front: [w, h, 'translateZ(' + d / 2 + 'px)'],
      left: [d, h, 'rotateY(90deg) translateZ(' + w / 2 + 'px)'], back: [w, h, 'rotateY(180deg) translateZ(' + d / 2 + 'px)'],
    }[face];
  }
  const node = style => { const value = document.createElement('div'); value.style.cssText = style; return value; };
  function build(skin, slim) {
    const scene = node(PRESERVE + 'left:50%;top:50%'), limbs = {};
    for (const part of parts(slim)) {
      const group = node(PRESERVE);
      group.dataset.part = part.name;
      const [bx, by, bz, w, h, d] = part.box;
      for (const layer of ['base', 'over']) {
        // У старого скина второго слоя нет нигде, кроме шапки.
        if (layer === 'over' && skin.legacy && part.name !== 'head') continue;
        const grow = layer === 'over' ? part.grow : 0, areas = regions(layer === 'base' ? part.uv : part.over, w, h, d);
        const box = node(PRESERVE + 'transform:translate3d(' + (bx + w / 2) * U + 'px,' + (by + h / 2) * U + 'px,' + -(bz + d / 2) * U + 'px)');
        box.dataset.layer = layer;
        for (const face of FACES) {
          if (layer === 'over' && empty(skin, areas[face])) continue;
          const [width, height, transform] = placement(face, (w + grow * 2) * U, (h + grow * 2) * U, (d + grow * 2) * U);
          const canvas = crop(skin, areas[face], face === 'bottom', SHADE[face]);
          canvas.dataset.face = face;
          canvas.style.cssText = 'position:absolute;display:block;left:' + -width / 2 + 'px;top:' + -height / 2 + 'px;width:' + width + 'px;height:' + height + 'px;' +
            'image-rendering:pixelated;backface-visibility:hidden;-webkit-backface-visibility:hidden;transform:' + transform;
          box.append(canvas);
        }
        if (box.childElementCount) group.append(box);
      }
      scene.append(group);
      limbs[part.name] = { node: group, pivot: part.pivot };
    }
    scene.append(shadow());
    return { scene, limbs };
  }
  // Мягкая пиксельная тень под ногами: круг 12×12 пикселей со ступенчатой прозрачностью.
  function shadow() {
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d'), size = 12;
    canvas.width = canvas.height = size;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x + .5 - size / 2, y + .5 - size / 2) / (size / 2);
      if (distance >= 1) continue;
      context.fillStyle = 'rgba(12, 8, 14, ' + (Math.ceil((1 - distance * distance) * 4) * .09).toFixed(2) + ')';
      context.fillRect(x, y, 1, 1);
    }
    canvas.dataset.shadow = '';
    canvas.style.cssText = 'position:absolute;display:block;left:' + -size * U / 2 + 'px;top:' + -size * U / 2 + 'px;width:' + size * U + 'px;height:' + size * U + 'px;' +
      'image-rendering:pixelated;backface-visibility:hidden;-webkit-backface-visibility:hidden;pointer-events:none;transform:translate3d(0,' + (24 * U + 1) + 'px,0) rotateX(90deg)';
    return canvas;
  }

  // ── Просмотр: вращение мышью или пальцем, лёгкое покачивание, ходьба и дыхание ──
  const ANIMATIONS = ['walk', 'idle', 'none'];
  function view(container, options = {}) {
    const settings = { skin: null, slim: false, animation: 'idle', rotate: true, yaw: -30, pitch: 12, scale: 1, ...options };
    settings.slim = !!settings.slim;
    if (!ANIMATIONS.includes(settings.animation)) settings.animation = 'none';
    // Контейнер без высоты получает модель в пропорции 3:4 силами CSS: при заданной высоте контейнера aspect-ratio не действует,
    // а без неё height:100% считается auto. Скрытый контейнер подхватит размер сам, когда его покажут.
    const stage = node('position:relative;width:100%;height:100%;aspect-ratio:3 / 4;overflow:hidden;touch-action:pan-y;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent');
    stage.dataset.skinView = '';
    stage.setAttribute('role', 'img');
    stage.setAttribute('aria-label', 'Трёхмерная модель скина');
    container.append(stage);
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let model = null, zoom = 1, frame = 0, ticket = 0, visible = true, destroyed = false;
    // spin — скорость докрутки в градусах за миллисекунду, spinAt — когда она последний раз применялась.
    let yaw = Number(settings.yaw) || 0, pitch = Number(settings.pitch) || 0, spin = 0, spinAt = 0, swayFrom = performance.now(), sway = 0, drag = null;
    const cursor = () => { stage.style.cursor = !settings.rotate ? '' : drag ? 'grabbing' : 'grab'; };
    cursor();

    function fit() {
      const width = stage.clientWidth, height = stage.clientHeight;
      zoom = Math.max(.05, Math.min(height / 40, width / 24) / U * (Number(settings.scale) || 1));
      stage.style.perspective = Math.round(32 * U * zoom * 4.5) + 'px';
    }
    const moving = () => !motion.matches && (settings.animation !== 'none' || settings.rotate);
    function pose(now) {
      if (!model) return;
      if (!drag && spin) {
        // Инерция идёт по времени, а не по кадрам: скорость тает на 10% за каждые 16,7 мс, а путь за промежуток
        // берётся точный (интеграл затухания, 16,7 / ln(1 / 0,9) ≈ 158,5 мс), поэтому на 30, 60 и 144 Гц модель докручивается одинаково.
        const passed = Math.max(0, Math.min(100, now - spinAt)), keep = Math.pow(.9, passed / 16.7);
        spinAt = now; yaw += spin * (1 - keep) * 158.5; spin *= keep;
        if (Math.abs(spin) < .003) { spin = 0; swayFrom = now; }
      }
      const still = motion.matches, t = now / 1000;
      sway = settings.rotate && !still && !drag && !spin ? Math.sin((now - swayFrom) / 1000 * .55) * 7 : 0;
      model.scene.style.transform = 'scale3d(' + zoom.toFixed(4) + ',' + zoom.toFixed(4) + ',' + zoom.toFixed(4) + ') rotateX(' + (-pitch).toFixed(2) + 'deg) rotateY(' + (yaw + sway).toFixed(2) + 'deg) translate3d(0,' + -8 * U + 'px,0)';
      const angles = { head: [0, 0, 0], body: [0, 0, 0], rightArm: [0, 0, 0], leftArm: [0, 0, 0], rightLeg: [0, 0, 0], leftLeg: [0, 0, 0] };
      if (!still && settings.animation === 'walk') {
        // Шаг как в игре: рука идёт вперёд вместе с противоположной ногой.
        const step = Math.sin(t * Math.PI * 2 / 1.15);
        angles.rightArm[0] = step * 28; angles.leftArm[0] = -step * 28;
        angles.rightLeg[0] = -step * 32; angles.leftLeg[0] = step * 32;
        angles.head[0] = Math.sin(t * Math.PI * 4 / 1.15) * 1.5;
      } else if (!still && settings.animation === 'idle') {
        // Дыхание: руки чуть отходят от тела и покачиваются, голова неторопливо осматривается.
        const breath = Math.cos(t * 1.8) * 2.6 + 2.6, swing = Math.sin(t * 1.34) * 2.6;
        angles.rightArm = [swing, 0, breath]; angles.leftArm = [-swing, 0, -breath];
        angles.head = [Math.sin(t * .7) * 2.5, Math.sin(t * .45) * 7, 0];
      }
      for (const [name, [x, y, z]] of Object.entries(angles)) {
        const limb = model.limbs[name];
        limb.node.style.transform = 'translate3d(' + limb.pivot[0] * U + 'px,' + limb.pivot[1] * U + 'px,0) rotateZ(' + z.toFixed(2) + 'deg) rotateY(' + y.toFixed(2) + 'deg) rotateX(' + x.toFixed(2) + 'deg)';
      }
    }
    function tick(now) { frame = 0; pose(now); schedule(); }
    function schedule() { if (!frame && !destroyed && visible && (drag || spin || moving())) frame = requestAnimationFrame(tick); }
    function update() { if (destroyed) return; pose(performance.now()); schedule(); }

    function mount(skin) {
      const next = build(skin, settings.slim);
      if (model) model.scene.replaceWith(next.scene); else stage.append(next.scene);
      model = next;
      update();
    }
    async function setSkin(url, slim) {
      const current = ++ticket;
      settings.skin = url || null;
      if (slim !== undefined) settings.slim = !!slim;
      stage.dataset.state = 'loading';
      let result = null;
      try { result = await textureOrDefault(settings.skin, settings.slim); } catch { /* даже скин по умолчанию недоступен */ }
      if (current !== ticket || destroyed) return;
      if (result) mount(result.skin);
      stage.dataset.state = result ? result.state : 'error';
    }
    function setAnimation(name) { settings.animation = ANIMATIONS.includes(name) ? name : 'none'; update(); }

    // Перетаскивание: рысканье без ограничений, наклон — в разумных пределах; после броска модель докручивается по инерции.
    // Скорость броска считается по движениям за последние 100 мс вместе с паузой перед отпусканием:
    // если указатель замер, модель остаётся под тем углом, куда её повернули.
    const FLING = 100, stamp = event => event.timeStamp || performance.now();
    let moves = [];
    stage.addEventListener('pointerdown', event => {
      if (!settings.rotate || event.button !== 0) return;
      yaw += sway; sway = 0; spin = 0; moves = [];
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, time: stamp(event) };
      try { stage.setPointerCapture(event.pointerId); } catch { /* указатель уже отпущен */ }
      cursor(); update();
    });
    stage.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y, time = stamp(event);
      // Каждое движение помнит свой сдвиг и время с прошлого; долгая пауза до него — это стояние, а не медленное движение.
      moves.push([time, dx * .6, Math.max(1, Math.min(32, time - drag.time))]);
      while (time - moves[0][0] > FLING) moves.shift();
      drag.x = event.clientX; drag.y = event.clientY; drag.time = time;
      yaw += dx * .6;
      pitch = Math.max(-35, Math.min(65, pitch + dy * .45));
      update();
    });
    const release = event => {
      if (!drag || event.pointerId !== drag.id) return;
      drag = null;
      const now = stamp(event), recent = moves.filter(([time]) => now - time <= FLING);
      const passed = recent.reduce((sum, move) => sum + move[2], 0) + (recent.length ? Math.max(0, now - recent.at(-1)[0]) : 0);
      const speed = recent.length ? recent.reduce((sum, move) => sum + move[1], 0) / Math.max(8, passed) : 0;
      spin = motion.matches ? 0 : Math.max(-.84, Math.min(.84, speed));
      moves = [];
      spinAt = swayFrom = performance.now();
      cursor(); update();
    };
    stage.addEventListener('pointerup', release);
    stage.addEventListener('pointercancel', release);
    stage.addEventListener('lostpointercapture', release);

    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { fit(); update(); }) : null;
    resize?.observe(stage);
    // Невидимая модель (вкладка скрыта или блок за краем) не тратит кадры.
    const seen = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => { visible = entries.at(-1).isIntersecting; update(); }) : null;
    seen?.observe(stage);
    motion.addEventListener?.('change', update);
    fit();
    const ready = setSkin(settings.skin, settings.slim);
    return {
      element: stage, ready, setSkin, setAnimation,
      destroy() {
        if (destroyed) return;
        destroyed = true; ticket++;
        cancelAnimationFrame(frame); frame = 0;
        resize?.disconnect(); seen?.disconnect();
        motion.removeEventListener?.('change', update);
        stage.remove();
      },
    };
  }

  // ── Голова для аватарок: лицо 8×8 и поверх него слой шапки ──
  // Если на тот же холст быстро просят другую голову, рисуется только последняя.
  const heads = new WeakMap();
  async function drawHead(canvas, url, slim) {
    const request = {};
    heads.set(canvas, request);
    let skin = null;
    try { skin = (await textureOrDefault(url, slim)).skin; } catch { /* даже скин по умолчанию недоступен */ }
    if (heads.get(canvas) !== request) return canvas;
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!canvas.style.imageRendering) canvas.style.imageRendering = 'pixelated';
    if (!skin) return canvas;
    const s = skin.scale;
    context.imageSmoothingEnabled = false;
    context.drawImage(skin.canvas, 8 * s, 8 * s, 8 * s, 8 * s, 0, 0, canvas.width, canvas.height);
    context.drawImage(skin.canvas, 40 * s, 8 * s, 8 * s, 8 * s, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  window.VeyraSkin = Object.freeze({ view, drawHead, defaultSkin });
})();
