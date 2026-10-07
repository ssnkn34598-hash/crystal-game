(() => {
  'use strict';

  // ================== Настройки баланса ==================
  const CFG = {
    pulsePeriod: 1000,      // мс между вспышками
    perfectBefore: 110,     // окно «Идеально» до пика вспышки, мс
    perfectAfter: 140,      // окно «Идеально» после пика вспышки, мс
    growNormal: 1,          // рост за обычный тап
    growPerfect: 2,         // рост за идеальный тап
    crackBase: 3,           // базовые трещины за тап, %
    crackPerSqrtSize: 1.15, // добавка трещин от размера, %
    maxCrackLines: 30,      // сколько линий трещин рисуется при 100%
    helperIdleLimit: 20000, // помощник работает, если игрок что-то делал за последние N мс
    priceGrowth: 1.5,       // каждый следующий уровень дороже в 1.5 раза
    saveKey: 'crystal_dont_break_v1',
  };

  // ================== Магазин ==================
  // Цены подобраны симуляцией: в первые 10 минут покупка примерно каждые 30–60 секунд
  const UPGRADES = [
    {
      id: 'glue', name: 'Клей', icon: '🧴', basePrice: 150, max: 15,
      desc: (l) => `Трещины от тапа: <b>−${pct(1 - glueFactor(l))}</b>` +
        (l < 15 ? ` → −${pct(1 - glueFactor(l + 1))}` : ''),
    },
    {
      id: 'helper', name: 'Помощник', icon: '🧚', basePrice: 250, max: 25,
      desc: (l) => `Рост без трещин: <b>+${l}/сек</b>` + (l < 25 ? ` → +${l + 1}/сек` : ''),
    },
    {
      id: 'rhythm', name: 'Широкий ритм', icon: '🎵', basePrice: 180, max: 6,
      desc: (l) => `Окно «Идеально»: <b>${perfectWindow(l)} мс</b>` +
        (l < 6 ? ` → ${perfectWindow(l + 1)} мс` : ''),
    },
  ];

  const CRYSTALS = [
    { name: 'Кварц «Искра»', short: 'Кварц', hue: 195, mult: 1, price: 0 },
    { name: 'Рубин «Алое сердце»', short: 'Рубин', hue: 350, mult: 2, price: 900 },
    { name: 'Изумруд «Лесной страж»', short: 'Изумруд', hue: 145, mult: 3.5, price: 5500 },
    { name: 'Аметист «Звёздная пыль»', short: 'Аметист', hue: 275, mult: 6, price: 26000 },
  ];

  const glueFactor = (l) => Math.pow(0.9, l);
  const perfectBefore = (l) => CFG.perfectBefore + l * 15;
  const perfectAfter = (l) => CFG.perfectAfter + l * 25;
  const perfectWindow = (l) => perfectBefore(l) + perfectAfter(l);
  const pct = (x) => Math.round(x * 100) + '%';
  const upgradePrice = (u) => Math.ceil(u.basePrice * Math.pow(CFG.priceGrowth, state.upgrades[u.id]));

  // ================== DOM ==================
  const $ = (id) => document.getElementById(id);
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  const stage = $('stage');
  const elShards = $('shards');
  const elSize = $('size');
  const elRecord = $('record');
  const elCrackPct = $('crackPct');
  const elCrackFill = $('crackFill');
  const elCrackBar = elCrackFill.parentElement;
  const elSellBtn = $('sellBtn');
  const elSellValue = $('sellValue');
  const elHint = $('hint');
  const elSoundBtn = $('soundBtn');
  const elCrystalName = $('crystalName');
  const elShopBtn = $('shopBtn');
  const elShopDot = $('shopDot');
  const elSheet = $('sheet');
  const elSheetHead = $('sheetHead');
  const elBackdrop = $('sheetBackdrop');
  const elShopShards = $('shopShards');
  const elUpgradeList = $('upgradeList');
  const elCrystalList = $('crystalList');

  // ================== Состояние ==================
  const state = {
    shards: 0,
    size: 1,
    cracks: 0,
    record: 1,
    totalTaps: 0,
    upgrades: { glue: 0, helper: 0, rhythm: 0 },
    crystalOwned: 0,         // самый дорогой купленный кристалл
    crystal: 0,              // выбранный кристалл
    muted: false,
  };

  let crackLines = [];       // геометрия трещин в единичных координатах
  let particles = [];
  let floaters = [];
  let shatterPieces = [];
  let stars = [];
  let rings = [];

  let W = 0, H = 0, DPR = 1;
  let startTime = performance.now();
  let lastPerfectPulse = -1;
  let perfectCombo = 0;
  let tapBounce = 0;         // анимация «пружинки» при тапе
  let appear = 1;            // 0..1 — появление нового кристалла
  let brokenUntil = 0;       // пока кристалл разбит — он не рисуется
  let lastPulseIdx = -1;
  let paused = false;
  let lastInput = performance.now();
  let helperAcc = 0;
  let lastFrame = performance.now();
  let K = 1;                 // множитель шага анимации (1 = 60 к/с), чтобы на 120 Гц не было ускорения
  let shake = 0;             // тряска экрана
  let flash = 0;             // вспышка всего экрана
  let flashHue = 50;
  let perfectGlow = 0;       // дополнительное свечение кристалла после идеального тапа
  let crackKick = 0;         // толчок кристалла при новой трещине
  let chips = [];            // мелкие осколки при тапе
  let coins = [];            // осколки-валюта, летящие к счётчику
  let pendingPieces = null;  // осколки ждут конца «стоп-кадра» при разбитии

  // ================== Сохранение ==================
  function load() {
    try {
      const raw = localStorage.getItem(CFG.saveKey);
      if (!raw) return;
      const d = JSON.parse(raw);
      const num = (v, def) => (typeof v === 'number' && isFinite(v) ? v : def);
      state.shards = Math.max(0, Math.floor(num(d.shards, 0)));
      state.size = Math.max(1, Math.floor(num(d.size, 1)));
      state.cracks = Math.min(99, Math.max(0, num(d.cracks, 0)));
      state.record = Math.max(state.size, Math.floor(num(d.record, 1)));
      state.totalTaps = Math.max(0, Math.floor(num(d.totalTaps, 0)));
      state.muted = d.muted === true;
      const up = d.upgrades || {};
      for (const u of UPGRADES) {
        state.upgrades[u.id] = Math.min(u.max, Math.max(0, Math.floor(num(up[u.id], 0))));
      }
      state.crystalOwned = Math.min(CRYSTALS.length - 1, Math.max(0, Math.floor(num(d.crystalOwned, 0))));
      state.crystal = Math.min(state.crystalOwned, Math.max(0, Math.floor(num(d.crystal, state.crystalOwned))));
    } catch (e) { /* повреждённое сохранение — начинаем заново */ }
  }

  let saveTimer = 0;
  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    try {
      localStorage.setItem(CFG.saveKey, JSON.stringify(state));
    } catch (e) { /* хранилище недоступно */ }
  }
  function save() {
    if (!saveTimer) saveTimer = setTimeout(saveNow, 400);
  }

  // ================== Звук (WebAudio, без файлов) ==================
  let audio = null;
  let master = null;
  let noiseBuf = null;

  function initAudio() {
    if (!audio) {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        audio = new AC();
        const comp = audio.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.ratio.value = 4;
        master = audio.createGain();
        master.gain.value = state.muted ? 0 : 0.9;
        master.connect(comp).connect(audio.destination);
        // общий буфер белого шума для трещин и взрыва
        noiseBuf = audio.createBuffer(1, audio.sampleRate, audio.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      } catch (e) { audio = null; return; }
    }
    if (audio.state === 'suspended' && !paused) audio.resume().catch(() => {});
  }

  const canPlay = () => audio && audio.state === 'running' && !paused && !state.muted;

  // Короткий тон с огибающей; freqEnd — для глиссандо
  function tone(freq, dur, { type = 'sine', vol = 0.1, delay = 0, freqEnd = 0, attack = 0.005 } = {}) {
    if (!canPlay()) return;
    const t = audio.currentTime + delay;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // Колокольчик: основной тон + негармонические обертоны, как у стекла
  function bell(freq, dur, vol, delay = 0) {
    tone(freq, dur, { vol, delay });
    tone(freq * 2.76, dur * 0.6, { vol: vol * 0.45, delay });
    tone(freq * 5.4, dur * 0.35, { vol: vol * 0.2, delay });
  }

  function noise(dur, { vol = 0.2, delay = 0, type = 'highpass', freq = 1000, q = 1, freqEnd = 0 } = {}) {
    if (!canPlay()) return;
    const t = audio.currentTime + delay;
    const src = audio.createBufferSource();
    const f = audio.createBiquadFilter();
    const g = audio.createGain();
    src.buffer = noiseBuf;
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    f.Q.value = q;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  const rnd = (a, b) => a + Math.random() * (b - a);

  const sfx = {
    // звонкий «тинь»; чем больше трещин, тем ниже и тревожнее
    tap() {
      const f = (1250 - state.cracks * 4) * rnd(0.97, 1.03);
      bell(f, 0.16, 0.07);
      tone(f * 0.5, 0.06, { type: 'triangle', vol: 0.05 });
    },
    // аккорд колокольчиков + мерцание
    perfect() {
      const base = 1047 * Math.pow(1.0595, Math.min(perfectCombo - 1, 7)); // серия поднимает тон
      [1, 1.26, 1.5].forEach((m, i) => bell(base * m, 0.55, 0.06, i * 0.045));
      for (let i = 0; i < 4; i++) tone(rnd(3000, 4500), 0.08, { vol: 0.025, delay: 0.1 + i * 0.05 });
    },
    // сухой треск из нескольких щелчков
    crack() {
      const n = 2 + Math.floor(state.cracks / 30);
      const vol = 0.05 + state.cracks / 100 * 0.12;
      for (let i = 0; i < n; i++) {
        noise(0.025, { vol, delay: i * rnd(0.012, 0.03), type: 'bandpass', freq: rnd(2200, 4200), q: 4 });
      }
      noise(0.05, { vol: vol * 0.6, type: 'lowpass', freq: 500 });
    },
    // удар + рассыпающееся стекло
    shatter() {
      tone(140, 0.55, { vol: 0.35, freqEnd: 38 });
      noise(0.7, { vol: 0.32, type: 'highpass', freq: 5000, freqEnd: 900 });
      noise(0.25, { vol: 0.25, type: 'lowpass', freq: 900 });
      for (let i = 0; i < 16; i++) {
        bell(rnd(1800, 5200), rnd(0.06, 0.18), rnd(0.015, 0.04), 0.03 + Math.pow(Math.random(), 1.6) * 0.9);
      }
    },
    // звон монеток по восходящей
    sell() {
      [784, 988, 1175, 1568].forEach((f, i) => {
        tone(f, 0.22, { type: 'square', vol: 0.03, delay: i * 0.055 });
        bell(f * 2, 0.25, 0.03, i * 0.055);
      });
      noise(0.3, { vol: 0.04, type: 'highpass', freq: 7000, delay: 0.15 });
    },
    buy() {
      tone(523, 0.12, { type: 'triangle', vol: 0.09 });
      tone(784, 0.2, { type: 'triangle', vol: 0.09, delay: 0.08 });
    },
    click() { tone(900, 0.05, { type: 'triangle', vol: 0.05 }); },
  };

  function setMuted(m) {
    state.muted = m;
    if (master) master.gain.setTargetAtTime(m ? 0 : 0.9, audio.currentTime, 0.02);
    elSoundBtn.classList.toggle('muted', m);
    elSoundBtn.setAttribute('aria-label', m ? 'Включить звук' : 'Выключить звук');
    elSoundBtn.title = m ? 'Включить звук' : 'Выключить звук';
    saveNow();
  }

  // ================== Геометрия кристалла ==================
  // Внешний контур (единичные координаты, высота 2)
  const OUTER = [
    [0, -1], [0.56, -0.52], [0.56, 0.48], [0, 1], [-0.56, 0.48], [-0.56, -0.52],
  ];
  // Внутренняя «площадка» огранки
  const INNER = OUTER.map(([x, y]) => [x * 0.42 + 0.04, y * 0.5 - 0.06]);
  // Яркость граней (имитация освещения сверху-слева)
  const FACET_LIGHT = [0.95, 0.55, 0.3, 0.2, 0.45, 0.8];

  function crystalHue() {
    // у каждого кристалла свой цвет, с ростом оттенок немного смещается
    return CRYSTALS[state.crystal].hue + Math.min(state.size, 300) / 300 * 25;
  }

  function crystalRadius() {
    const base = Math.min(W, H * 0.62) * 0.36;
    const growth = 1 - 1 / (1 + (state.size - 1) / 30);
    return base * (0.55 + 0.45 * growth);
  }

  function pointInPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function randomPointInCrystal() {
    for (let i = 0; i < 30; i++) {
      const x = (Math.random() * 2 - 1) * 0.56;
      const y = Math.random() * 2 - 1;
      if (pointInPoly(x, y, OUTER)) return [x, y];
    }
    return [0, 0];
  }

  function makeCrackLine(origin) {
    const pts = [origin || randomPointInCrystal()];
    let ang = Math.random() * Math.PI * 2;
    const steps = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < steps; i++) {
      ang += (Math.random() - 0.5) * 1.3;
      const len = 0.06 + Math.random() * 0.11;
      const [px, py] = pts[pts.length - 1];
      pts.push([px + Math.cos(ang) * len, py + Math.sin(ang) * len]);
    }
    const line = { pts, branches: [], born: performance.now() };
    if (Math.random() < 0.55) {
      const from = pts[1 + Math.floor(Math.random() * (pts.length - 1))];
      const b = [from];
      let a2 = ang + (Math.random() < 0.5 ? 1 : -1) * (0.6 + Math.random() * 0.8);
      for (let i = 0; i < 2; i++) {
        const [px, py] = b[b.length - 1];
        const len = 0.05 + Math.random() * 0.07;
        b.push([px + Math.cos(a2) * len, py + Math.sin(a2) * len]);
        a2 += (Math.random() - 0.5) * 1.0;
      }
      line.branches.push(b);
    }
    return line;
  }

  // instant = true — при загрузке сохранения трещины появляются сразу, без анимации
  function syncCrackLines(instant) {
    const target = Math.round((state.cracks / 100) * CFG.maxCrackLines);
    const fresh = [];
    while (crackLines.length < target) {
      // новые трещины часто растут из конца старых — выглядит естественнее
      let origin = null;
      if (crackLines.length && Math.random() < 0.45) {
        const prev = crackLines[Math.floor(Math.random() * crackLines.length)];
        origin = prev.pts[prev.pts.length - 1].slice();
      }
      const line = makeCrackLine(origin);
      crackLines.push(line);
      fresh.push(line);
    }
    if (crackLines.length > target) crackLines.length = target;
    if (instant) {
      fresh.forEach((l) => { l.born = -1e9; });
      return;
    }
    // пыль из точки, где пошла трещина, и толчок кристалла
    if (fresh.length) {
      const c = crystalCenter();
      const r = crystalRadius();
      for (const l of fresh) {
        const [ux, uy] = l.pts[0];
        burst(c.x + ux * r, c.y + uy * r, 4, 220, false, { speed: 1.5, light: 92 });
      }
      crackKick = Math.min(1, crackKick + 0.5 + fresh.length * 0.15);
    }
  }

  // Рисует первые frac (0..1) длины ломаной — так трещина «бежит» по кристаллу
  function strokePartial(pts, frac, r) {
    if (frac <= 0) return;
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    let left = total * Math.min(1, frac);
    ctx.beginPath();
    ctx.moveTo(pts[0][0] * r, pts[0][1] * r);
    for (let i = 1; i < pts.length && left > 0; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
      const seg = Math.hypot(bx - ax, by - ay);
      const t = Math.min(1, left / seg);
      ctx.lineTo((ax + (bx - ax) * t) * r, (ay + (by - ay) * t) * r);
      left -= seg;
    }
    ctx.stroke();
  }

  // ================== Пульс ==================
  function pulseInfo(now) {
    const t = now - startTime;
    const idx = Math.round(t / CFG.pulsePeriod); // ближайший пик
    const offset = t - idx * CFG.pulsePeriod;    // <0 — до пика, >0 — после
    return { idx, offset };
  }

  function pulseGlow(now) {
    const { offset } = pulseInfo(now);
    const d = offset / CFG.pulsePeriod;
    return Math.exp(-(d * d) / (2 * 0.055 * 0.055));
  }

  // ================== Игровые действия ==================
  function crystalCenter() {
    return { x: W / 2, y: H * 0.47 };
  }

  function tap(px, py) {
    const now = performance.now();
    if (now < brokenUntil) return;
    lastInput = now;
    initAudio();
    elHint.classList.add('hidden');

    const c = crystalCenter();
    const r = crystalRadius();
    // точка эффекта — место тапа, если оно на кристалле, иначе центр
    let ex = c.x, ey = c.y;
    if (px !== undefined) {
      const ux = (px - c.x) / r, uy = (py - c.y) / r;
      if (pointInPoly(ux, uy, OUTER)) { ex = px; ey = py; }
    }

    const { idx, offset } = pulseInfo(now);
    const rl = state.upgrades.rhythm;
    const isPerfect = offset >= -perfectBefore(rl) && offset <= perfectAfter(rl) && idx !== lastPerfectPulse;

    state.totalTaps++;
    tapBounce = 1;

    if (isPerfect) {
      lastPerfectPulse = idx;
      perfectCombo++;
      state.size += CFG.growPerfect;
      sfx.perfect();
      const label = perfectCombo > 1 ? `Идеально! ×${perfectCombo}` : 'Идеально!';
      addFloater(label, c.x, c.y - r * 1.15, '#ffe27a', 1.35);
      addFloater(`+${CFG.growPerfect}`, ex, ey - 10, '#bff8ff', 0.9);
      // вспышка: экран, кольца, звёздочки и лучи
      flash = Math.min(0.55, 0.32 + perfectCombo * 0.04);
      flashHue = 48;
      perfectGlow = 1;
      rings.push({ x: c.x, y: c.y, r: r * 0.7, life: 1, hue: 50, w: 5, speed: 6 });
      rings.push({ x: c.x, y: c.y, r: r * 0.4, life: 0.8, hue: crystalHue(), w: 3, speed: 4 });
      burst(ex, ey, 26, 50, true, { star: true, speed: 7 });
      burst(c.x, c.y, 14, 45, true, { streak: true, speed: 10 });
      spawnChips(ex, ey, 4);
    } else {
      perfectCombo = 0;
      const crackAdd = (CFG.crackBase + Math.sqrt(state.size) * CFG.crackPerSqrtSize) *
        glueFactor(state.upgrades.glue);
      state.size += CFG.growNormal;
      state.cracks += crackAdd;
      sfx.tap();
      sfx.crack();
      addFloater(`+${CFG.growNormal}`, ex, ey - 10, '#d8d4ff', 0.8);
      burst(ex, ey, 12, crystalHue(), false, { speed: 4.5 });
      burst(ex, ey, 5, crystalHue(), false, { streak: true, speed: 7 });
      spawnChips(ex, ey, 3 + Math.floor(state.cracks / 25));
    }

    if (state.size > state.record) {
      state.record = state.size;
      bump(elRecord);
    }

    if (state.cracks >= 100) {
      shatter();
    } else {
      syncCrackLines();
    }
    bump(elSize);
    updateUI();
    save();
  }

  // Точка на контуре кристалла в направлении угла a (единичные координаты)
  function outlinePoint(a) {
    const dx = Math.cos(a), dy = Math.sin(a);
    let best = 1;
    for (let i = 0; i < OUTER.length; i++) {
      const [x1, y1] = OUTER[i], [x2, y2] = OUTER[(i + 1) % OUTER.length];
      const ex = x2 - x1, ey = y2 - y1;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = (x1 * ey - y1 * ex) / den;
      const u = (x1 * dy - y1 * dx) / den;
      if (t > 0 && u >= 0 && u <= 1) best = t;
    }
    return [dx * best, dy * best];
  }

  // Режем кристалл на треугольники по его настоящей форме: лучи из центра × кольца
  function makeShatterPieces(c, r, hue) {
    const N = 11;
    const angles = [];
    for (let i = 0; i < N; i++) angles.push((i + rnd(-0.3, 0.3)) / N * Math.PI * 2);
    const ringK = [0.38, 0.72, 1];
    const pt = (i, ring) => {
      const [ox, oy] = outlinePoint(angles[i % N]);
      const k = ring === 2 ? 1 : ringK[ring] * rnd(0.85, 1.15);
      return [ox * k, oy * k];
    };
    const grid = [0, 1, 2].map((ring) => angles.map((_, i) => pt(i, ring)));
    const tris = [];
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      tris.push([[0, 0], grid[0][i], grid[0][j]]);
      for (let ring = 0; ring < 2; ring++) {
        const a = grid[ring][i], b = grid[ring][j], cc = grid[ring + 1][j], d = grid[ring + 1][i];
        tris.push([a, b, cc], [a, cc, d]);
      }
    }
    return tris.map((t) => {
      const cx = (t[0][0] + t[1][0] + t[2][0]) / 3;
      const cy = (t[0][1] + t[1][1] + t[2][1]) / 3;
      const dist = Math.hypot(cx, cy) || 0.01;
      const sp = rnd(4, 11) * (0.6 + dist);
      return {
        x: c.x + cx * r, y: c.y + cy * r,
        vx: (cx / dist) * sp + rnd(-1, 1), vy: (cy / dist) * sp - rnd(2, 6),
        rot: 0, vr: rnd(-0.25, 0.25),
        pts: t.map(([x, y]) => [(x - cx) * r, (y - cy) * r]),
        light: rnd(40, 78), hue: hue + rnd(-12, 12),
        life: 1, decay: rnd(0.006, 0.011), bounced: 0,
      };
    });
  }

  function shatter() {
    const c = crystalCenter();
    const r = crystalRadius();
    const hue = crystalHue();
    const lost = state.size;

    // «стоп-кадр» на долю секунды: кристалл белеет, потом разлетается
    pendingPieces = { at: performance.now() + 70, pieces: makeShatterPieces(c, r, hue) };
    flash = 0.75;
    flashHue = hue;
    shake = 18;
    rings.push({ x: c.x, y: c.y, r: r * 0.3, life: 1, hue, w: 10, speed: 11 });
    rings.push({ x: c.x, y: c.y, r: r * 0.2, life: 0.9, hue: 0, w: 4, speed: 7, white: true });
    burst(c.x, c.y, 50, hue, true, { speed: 13 });
    burst(c.x, c.y, 30, hue, true, { streak: true, speed: 16 });
    burst(c.x, c.y, 20, 0, true, { star: true, speed: 9, light: 100 });

    addFloater('Разбит!', c.x, c.y - r * 0.2, '#ff6b81', 1.6);
    addFloater(`−${lost} размера`, c.x, c.y + r * 0.35, '#ff9fae', 0.9);
    sfx.shatter();
    vibrate([25, 40, 45]);

    state.size = 1;
    state.cracks = 0;
    perfectCombo = 0;
    crackLines = [];
    brokenUntil = performance.now() + 1200;
    appear = 0;
    saveNow();
  }

  function sell() {
    const now = performance.now();
    if (now < brokenUntil || state.size < 2) return;
    lastInput = now;
    initAudio();

    const value = sellValue();
    const c = crystalCenter();
    const r = crystalRadius();
    state.shards += value;
    bump(elShards);
    addFloater(`+${formatNum(value)} ◆`, c.x, c.y - r * 0.2, '#9ff3ff', 1.5);
    burst(c.x, c.y, 30, crystalHue(), true, { star: true, speed: 6 });
    rings.push({ x: c.x, y: c.y, r: r * 0.6, life: 1, hue: 190, w: 4, speed: 5 });
    spawnCoins(c.x, c.y, Math.min(14, 4 + Math.floor(Math.log2(value + 1))));
    flash = 0.2;
    flashHue = 190;
    sfx.sell();

    state.size = 1;
    state.cracks = 0;
    perfectCombo = 0;
    crackLines = [];
    appear = 0;
    updateUI();
    saveNow();
  }

  // Цена растёт чуть быстрее размера, чтобы большой кристалл был выгоднее,
  // чем бесконечно продавать крошечные
  function sellValue() {
    const s = state.size;
    return Math.floor(s * (1 + Math.sqrt(s) / 4) * CRYSTALS[state.crystal].mult);
  }

  // ================== Помощник ==================
  function updateHelper(now, dt) {
    const lvl = state.upgrades.helper;
    if (!lvl || now < brokenUntil || now - lastInput > CFG.helperIdleLimit) {
      helperAcc = 0;
      return;
    }
    helperAcc += dt;
    if (helperAcc < 1000) return;
    helperAcc -= 1000;
    state.size += lvl;
    if (state.size > state.record) state.record = state.size;
    const c = crystalCenter();
    const r = crystalRadius();
    addFloater(`+${lvl} 🧚`, c.x + r * 0.75, c.y - r * 0.55, '#c8ffe9', 0.75);
    burst(c.x + r * 0.5, c.y - r * 0.4, 5, 150, false);
    updateUI();
    save();
  }

  function vibrate(p) {
    try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { /* нет поддержки */ }
  }

  // ================== Эффекты ==================
  function addFloater(text, x, y, color, scale = 1) {
    floaters.push({ text, x, y, vy: -1.1, life: 1, color, scale });
  }

  // Искры: точки, звёздочки (star) или светящиеся штрихи (streak)
  function burst(x, y, n, hue, sparkle, opt = {}) {
    const speed = opt.speed || (sparkle ? 6 : 3.5);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 0.6 + Math.random() * speed;
      particles.push({
        x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 1, decay: 0.014 + Math.random() * 0.024,
        size: (opt.star ? 3 : 1.5) + Math.random() * (sparkle ? 3.5 : 2.5),
        hue: hue + (Math.random() - 0.5) * 30,
        light: opt.light || 70,
        kind: opt.star ? 'star' : opt.streak ? 'streak' : 'dot',
        spin: Math.random() * Math.PI,
      });
    }
  }

  // Мелкие стеклянные осколки, отскакивающие от кристалла при тапе
  function spawnChips(x, y, n) {
    const hue = crystalHue();
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + rnd(-1.3, 1.3);
      const sp = rnd(2.5, 6);
      const s = rnd(2.5, 5.5);
      chips.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        rot: rnd(0, 6.28), vr: rnd(-0.4, 0.4),
        pts: [[0, -s], [s * rnd(0.5, 1), s * 0.7], [-s * rnd(0.5, 1), s * 0.5]],
        hue: hue + rnd(-15, 15), light: rnd(55, 85), life: 1,
      });
    }
  }

  // Осколки-валюта летят к счётчику «Осколки»
  function spawnCoins(x, y, n) {
    const cr = canvas.getBoundingClientRect();
    const tr = elShards.getBoundingClientRect();
    const tx = tr.left + tr.width / 2 - cr.left;
    const ty = tr.top + tr.height / 2 - cr.top;
    for (let i = 0; i < n; i++) {
      coins.push({
        sx: x + rnd(-20, 20), sy: y + rnd(-20, 20),
        cx: x + rnd(-W * 0.35, W * 0.35), cy: y - rnd(40, 160),
        tx, ty, t: -i * 0.05, hue: crystalHue(),
      });
    }
  }

  function initStars() {
    const n = Math.round((W * H) / 6000);
    stars = [];
    for (let i = 0; i < n; i++) {
      stars.push({
        x: Math.random() * W, y: Math.random() * H,
        r: Math.random() * 1.4 + 0.3,
        tw: Math.random() * Math.PI * 2,
        sp: 0.05 + Math.random() * 0.15,
      });
    }
  }

  // ================== UI ==================
  function formatNum(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace('.', ',') + ' млрд';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + ' млн';
    return Math.floor(n).toLocaleString('ru-RU');
  }

  function bump(el) {
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }

  function updateUI() {
    elShards.textContent = formatNum(state.shards);
    elSize.textContent = formatNum(state.size);
    elRecord.textContent = formatNum(state.record);
    const pct = Math.min(100, Math.floor(state.cracks));
    elCrackPct.textContent = pct + '%';
    elCrackFill.style.width = pct + '%';
    elCrackFill.style.backgroundSize = (pct > 0 ? (10000 / pct) : 100) + '% 100%';
    elCrackBar.classList.toggle('danger', pct >= 70);
    elSellValue.textContent = `+${formatNum(sellValue())} ◆`;
    elSellBtn.disabled = state.size < 2;
    elShopDot.classList.toggle('on', canAffordSomething());
    if (shopOpen) renderShop();
  }

  // ================== Магазин: логика и интерфейс ==================
  let shopOpen = false;

  function canAffordSomething() {
    if (UPGRADES.some((u) => state.upgrades[u.id] < u.max && state.shards >= upgradePrice(u))) return true;
    const next = CRYSTALS[state.crystalOwned + 1];
    return !!next && state.shards >= next.price;
  }

  function buyUpgrade(id) {
    const u = UPGRADES.find((x) => x.id === id);
    if (!u || state.upgrades[id] >= u.max) return false;
    const price = upgradePrice(u);
    if (state.shards < price) return false;
    state.shards -= price;
    state.upgrades[id]++;
    return true;
  }

  function buyCrystal(i) {
    if (i <= state.crystalOwned) {          // уже куплен — просто выбираем
      state.crystal = i;
      return true;
    }
    if (i !== state.crystalOwned + 1 || state.shards < CRYSTALS[i].price) return false;
    state.shards -= CRYSTALS[i].price;
    state.crystalOwned = i;
    state.crystal = i;
    return true;
  }

  function crystalIcon(hue) {
    return `<svg viewBox="-1 -1.1 2 2.2"><polygon points="0,-1 0.56,-0.52 0.56,0.48 0,1 -0.56,0.48 -0.56,-0.52"
      fill="hsl(${hue},75%,55%)" stroke="hsl(${hue},100%,85%)" stroke-width="0.06"/>
      <polygon points="0.04,-0.56 0.28,-0.32 0.28,0.18 0.04,0.44 -0.2,0.18 -0.2,-0.32" fill="hsl(${hue},90%,78%)"/></svg>`;
  }

  // Карточки создаются один раз, дальше обновляются только тексты и состояния кнопок
  function buildShop() {
    elUpgradeList.innerHTML = UPGRADES.map((u) => `
      <div class="shop-item" data-up="${u.id}">
        <div class="shop-icon">${u.icon}</div>
        <div class="shop-info">
          <div class="shop-name">${u.name}<span class="shop-level"></span></div>
          <div class="shop-desc"></div>
        </div>
        <button class="shop-buy" type="button"></button>
      </div>`).join('');
    elCrystalList.innerHTML = CRYSTALS.map((c, i) => `
      <div class="shop-item" data-crystal="${i}" style="--item-color: hsl(${c.hue},90%,65%)">
        <div class="shop-icon">${crystalIcon(c.hue)}</div>
        <div class="shop-info">
          <div class="shop-name">${c.name}</div>
          <div class="shop-desc">Осколки при продаже: <b>×${String(c.mult).replace('.', ',')}</b></div>
        </div>
        <button class="shop-buy" type="button"></button>
      </div>`).join('');
  }

  function renderShop() {
    elShopShards.textContent = formatNum(state.shards);
    for (const el of elUpgradeList.children) {
      const u = UPGRADES.find((x) => x.id === el.dataset.up);
      const l = state.upgrades[u.id];
      const btn = el.querySelector('.shop-buy');
      el.querySelector('.shop-level').textContent = ` · ур. ${l}${l >= u.max ? ' (макс.)' : ''}`;
      el.querySelector('.shop-desc').innerHTML = u.desc(l);
      btn.classList.remove('ghost');
      if (l >= u.max) {
        btn.textContent = 'Макс.';
        btn.disabled = true;
        btn.classList.add('done');
      } else {
        const price = upgradePrice(u);
        btn.textContent = `${formatNum(price)} ◆`;
        btn.disabled = state.shards < price;
        btn.classList.remove('done');
      }
    }
    for (const el of elCrystalList.children) {
      const i = +el.dataset.crystal;
      const c = CRYSTALS[i];
      const btn = el.querySelector('.shop-buy');
      el.classList.toggle('active', i === state.crystal);
      btn.classList.remove('ghost', 'done');
      if (i === state.crystal) {
        btn.textContent = 'Выбран';
        btn.disabled = true;
        btn.classList.add('done');
      } else if (i <= state.crystalOwned) {
        btn.textContent = 'Выбрать';
        btn.disabled = false;
        btn.classList.add('ghost');
      } else if (i === state.crystalOwned + 1) {
        btn.textContent = `${formatNum(c.price)} ◆`;
        btn.disabled = state.shards < c.price;
      } else {
        btn.textContent = '🔒';
        btn.disabled = true;
      }
    }
  }

  function onShopClick(e) {
    const btn = e.target.closest('.shop-buy');
    if (!btn || btn.disabled) return;
    const item = btn.closest('.shop-item');
    initAudio();
    lastInput = performance.now();
    let ok = false, bought = false;
    if (item.dataset.up) {
      ok = bought = buyUpgrade(item.dataset.up);
    } else {
      const i = +item.dataset.crystal;
      bought = i > state.crystalOwned;
      ok = buyCrystal(i);
      if (ok) { appear = 0.4; updateCrystalName(); }
    }
    if (!ok) return;
    if (bought) {
      sfx.buy();
      bump(elShards);
    } else {
      sfx.click();
    }
    btn.classList.remove('flash');
    void btn.offsetWidth;
    btn.classList.add('flash');
    updateUI();
    saveNow();
  }

  function updateCrystalName() {
    const c = CRYSTALS[state.crystal];
    elCrystalName.style.setProperty('--crystal-color', `hsl(${c.hue}, 90%, 72%)`);
    elCrystalName.innerHTML = `${c.name}<small>×${String(c.mult).replace('.', ',')}</small>`;
  }

  function openShop() {
    if (shopOpen) return;
    shopOpen = true;
    renderShop();
    elSheet.style.transform = '';
    elSheet.classList.add('open');
    elBackdrop.classList.add('open');
    lastInput = performance.now();
  }

  function closeShop() {
    if (!shopOpen) return;
    shopOpen = false;
    elSheet.style.transform = '';
    elSheet.classList.remove('open');
    elBackdrop.classList.remove('open');
  }

  // Свайп вниз за шапку панели закрывает магазин
  (() => {
    let startY = 0, dy = 0, dragging = false;
    elSheetHead.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true;
      startY = e.clientY;
      dy = 0;
      elSheet.classList.add('dragging');
      elSheetHead.setPointerCapture(e.pointerId);
    });
    elSheetHead.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      dy = Math.max(0, e.clientY - startY);
      elSheet.style.transform = `translate(-50%, ${dy}px)`;
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      elSheet.classList.remove('dragging');
      elSheet.style.transform = '';
      if (dy > 80) closeShop();
    };
    elSheetHead.addEventListener('pointerup', end);
    elSheetHead.addEventListener('pointercancel', end);
  })();

  elShopBtn.addEventListener('click', openShop);
  $('sheetClose').addEventListener('click', closeShop);
  elBackdrop.addEventListener('click', closeShop);
  elUpgradeList.addEventListener('click', onShopClick);
  elCrystalList.addEventListener('click', onShopClick);

  // ================== Отрисовка ==================
  function resize() {
    const rect = stage.getBoundingClientRect();
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(1, rect.width);
    H = Math.max(1, rect.height);
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    initStars();
  }

  function drawBackground(now, glow) {
    ctx.clearRect(0, 0, W, H);
    for (const s of stars) {
      s.y -= s.sp;
      if (s.y < -2) { s.y = H + 2; s.x = Math.random() * W; }
      const a = 0.35 + 0.35 * Math.sin(now / 700 + s.tw);
      ctx.fillStyle = `rgba(200, 200, 255, ${a})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    // мягкое свечение за кристаллом
    const c = crystalCenter();
    const r = crystalRadius();
    const hue = crystalHue();
    const g = ctx.createRadialGradient(c.x, c.y, r * 0.2, c.x, c.y, r * (2.2 + glow * 0.6));
    g.addColorStop(0, `hsla(${hue}, 90%, 60%, ${0.22 + glow * 0.28})`);
    g.addColorStop(1, `hsla(${hue}, 90%, 40%, 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  function polyPath(pts, r) {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * r, y * r) : ctx.moveTo(x * r, y * r)));
    ctx.closePath();
  }

  function drawCrystal(now, glow) {
    if (now < brokenUntil) return;
    const c = crystalCenter();
    const hue = crystalHue();
    const danger = state.cracks / 100;

    appear = Math.min(1, appear + 0.06 * K);
    // упругое появление с небольшим перелётом
    const appearEase = appear >= 1 ? 1 : 1 + 2.2 * Math.pow(appear - 1, 3) + 1.2 * Math.pow(appear - 1, 2);
    const breathe = 1 + Math.sin(now / 900) * 0.012;
    const scale = appearEase * breathe * (1 + tapBounce * 0.07) * (1 + glow * 0.025);
    glow = Math.min(1.6, glow + perfectGlow * 0.9);
    const r = crystalRadius() * scale;
    if (r < 1) return;

    // дрожание при сильных трещинах
    let sx = 0, sy = 0;
    if (danger > 0.65) {
      const k = (danger - 0.65) / 0.35 * 3.5;
      sx = (Math.random() - 0.5) * k;
      sy = (Math.random() - 0.5) * k;
    }
    // толчок от новой трещины
    sx += (Math.random() - 0.5) * crackKick * 6;
    sy += (Math.random() - 0.5) * crackKick * 4;

    ctx.save();
    ctx.translate(c.x + sx, c.y + sy + Math.sin(now / 1300) * 4);

    // внешнее свечение
    ctx.shadowColor = `hsla(${hue}, 100%, 70%, ${0.6 + glow * 0.4})`;
    ctx.shadowBlur = 25 + glow * 45;
    polyPath(OUTER, r);
    ctx.fillStyle = `hsl(${hue}, 70%, 35%)`;
    ctx.fill();
    ctx.shadowBlur = 0;

    // грани
    for (let i = 0; i < OUTER.length; i++) {
      const j = (i + 1) % OUTER.length;
      const l = 30 + FACET_LIGHT[i] * 40 + glow * 18;
      ctx.beginPath();
      ctx.moveTo(OUTER[i][0] * r, OUTER[i][1] * r);
      ctx.lineTo(OUTER[j][0] * r, OUTER[j][1] * r);
      ctx.lineTo(INNER[j][0] * r, INNER[j][1] * r);
      ctx.lineTo(INNER[i][0] * r, INNER[i][1] * r);
      ctx.closePath();
      const fg = ctx.createLinearGradient(OUTER[i][0] * r, OUTER[i][1] * r, INNER[j][0] * r, INNER[j][1] * r);
      fg.addColorStop(0, `hsla(${hue + 10}, 85%, ${l + 10}%, 0.95)`);
      fg.addColorStop(1, `hsla(${hue - 10}, 80%, ${l - 8}%, 0.95)`);
      ctx.fillStyle = fg;
      ctx.fill();
    }
    // центральная площадка
    polyPath(INNER, r);
    const ig = ctx.createLinearGradient(-r * 0.3, -r * 0.6, r * 0.3, r * 0.5);
    ig.addColorStop(0, `hsla(${hue}, 90%, ${80 + glow * 12}%, 0.95)`);
    ig.addColorStop(1, `hsla(${hue + 20}, 80%, ${50 + glow * 15}%, 0.95)`);
    ctx.fillStyle = ig;
    ctx.fill();

    // рёбра
    ctx.strokeStyle = `hsla(${hue}, 100%, 92%, ${0.35 + glow * 0.5})`;
    ctx.lineWidth = Math.max(1, r * 0.012);
    for (let i = 0; i < OUTER.length; i++) {
      ctx.beginPath();
      ctx.moveTo(OUTER[i][0] * r, OUTER[i][1] * r);
      ctx.lineTo(INNER[i][0] * r, INNER[i][1] * r);
      ctx.stroke();
    }
    polyPath(INNER, r);
    ctx.stroke();
    polyPath(OUTER, r);
    ctx.stroke();

    // блик
    ctx.save();
    polyPath(OUTER, r);
    ctx.clip();
    const shinePos = ((now / 2600) % 1.6) - 0.3;
    if (shinePos > 0.08 && shinePos < 0.92) {
      const sg = ctx.createLinearGradient(-r, -r, r, r);
      sg.addColorStop(shinePos - 0.08, 'rgba(255,255,255,0)');
      sg.addColorStop(shinePos, 'rgba(255,255,255,0.28)');
      sg.addColorStop(shinePos + 0.08, 'rgba(255,255,255,0)');
      ctx.fillStyle = sg;
      ctx.fillRect(-r, -r, r * 2, r * 2);
    }

    // трещины: «бегут» от точки начала, свежие ярко светятся
    if (crackLines.length) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const w = Math.max(1, r * 0.014);
      const grow = (l) => Math.min(1, (now - l.born) / 230);
      const each = (fn) => {
        for (const l of crackLines) {
          const g = grow(l);
          // плавное замедление в конце
          const e = 1 - Math.pow(1 - g, 2);
          fn(l.pts, e, 1);
          const be = Math.max(0, (g - 0.45) / 0.55);
          l.branches.forEach((b) => fn(b, be, 0.7));
        }
      };
      // тёмная подложка + светлая кромка = «объёмная» трещина
      ctx.strokeStyle = `rgba(10, 5, 30, ${0.55 + danger * 0.3})`;
      each((pts, f, k) => { ctx.lineWidth = w * 1.8 * k; strokePartial(pts, f, r); });
      ctx.strokeStyle = danger > 0.7
        ? `rgba(255, 140, 160, ${0.55 + Math.min(glow, 1) * 0.3})`
        : `rgba(235, 245, 255, ${0.55 + Math.min(glow, 1) * 0.3})`;
      each((pts, f, k) => { ctx.lineWidth = w * 0.6 * k; strokePartial(pts, f, r); });
      // свечение свежих трещин
      ctx.globalCompositeOperation = 'lighter';
      for (const l of crackLines) {
        const age = now - l.born;
        if (age > 500) continue;
        const a = 1 - age / 500;
        ctx.strokeStyle = `rgba(255, 255, 255, ${a * 0.9})`;
        ctx.shadowColor = `hsla(${hue}, 100%, 80%, ${a})`;
        ctx.shadowBlur = 12;
        ctx.lineWidth = w * 1.4;
        strokePartial(l.pts, Math.min(1, age / 230), r);
      }
      ctx.shadowBlur = 0;
      ctx.globalCompositeOperation = 'source-over';
    }

    // белая вспышка кристалла после идеального тапа
    if (perfectGlow > 0.02) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(255, 245, 200, ${perfectGlow * 0.35})`;
      ctx.fillRect(-r, -r, r * 2, r * 2);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();

    ctx.restore();
  }

  function drawStar(x, y, s, rot) {
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = rot + (i * Math.PI) / 4;
      const rr = i % 2 ? s * 0.28 : s;
      i ? ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr) : ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
  }

  function drawEffects(now) {
    // кольца и ударные волны
    for (let i = rings.length - 1; i >= 0; i--) {
      const g = rings[i];
      g.r += (g.speed || 4) * K;
      g.life -= 0.03 * K;
      if (g.life <= 0) { rings.splice(i, 1); continue; }
      const c = g.x !== undefined ? g : crystalCenter();
      ctx.strokeStyle = g.white
        ? `rgba(255, 255, 255, ${g.life * 0.8})`
        : `hsla(${g.hue}, 100%, 75%, ${g.life * 0.7})`;
      ctx.lineWidth = (g.w || 3) * g.life;
      ctx.beginPath();
      ctx.arc(c.x, c.y, g.r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // большие осколки разбитого кристалла
    if (pendingPieces && now >= pendingPieces.at) {
      shatterPieces.push(...pendingPieces.pieces);
      pendingPieces = null;
    }
    const floor = H - 6;
    for (let i = shatterPieces.length - 1; i >= 0; i--) {
      const p = shatterPieces[i];
      p.vy += 0.32 * K;
      p.vx *= Math.pow(0.99, K);
      p.x += p.vx * K; p.y += p.vy * K;
      p.rot += p.vr * K;
      // отскок от нижнего края
      if (p.y > floor && p.vy > 0 && p.bounced < 2) {
        p.y = floor;
        p.vy *= -0.4;
        p.vx *= 0.7;
        p.vr *= 0.6;
        p.bounced++;
      }
      p.life -= p.decay * K;
      if (p.life <= 0 || p.y > H + 80) { shatterPieces.splice(i, 1); continue; }
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = Math.min(1, p.life * 1.6);
      ctx.beginPath();
      p.pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      // блеск при вращении
      const glint = Math.max(0, Math.sin(p.rot * 2 + p.hue)) * 25;
      ctx.fillStyle = `hsl(${p.hue}, 80%, ${Math.min(95, p.light + glint)}%)`;
      ctx.shadowColor = `hsl(${p.hue}, 100%, 70%)`;
      ctx.shadowBlur = 12;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = `hsla(${p.hue}, 100%, 92%, 0.7)`;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }

    // мелкие осколки от тапов
    for (let i = chips.length - 1; i >= 0; i--) {
      const p = chips[i];
      p.vy += 0.28 * K;
      p.x += p.vx * K; p.y += p.vy * K;
      p.rot += p.vr * K;
      p.life -= 0.022 * K;
      if (p.life <= 0) { chips.splice(i, 1); continue; }
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = Math.min(1, p.life * 2);
      ctx.beginPath();
      p.pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fillStyle = `hsl(${p.hue}, 85%, ${p.light}%)`;
      ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    // искры
    ctx.globalCompositeOperation = 'lighter';
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * K; p.y += p.vy * K;
      const drag = Math.pow(0.95, K);
      p.vx *= drag; p.vy = p.vy * drag + 0.05 * K;
      p.life -= p.decay * K;
      p.spin += 0.1 * K;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      const col = `hsla(${p.hue}, 100%, ${p.light}%, ${p.life})`;
      if (p.kind === 'streak') {
        ctx.strokeStyle = col;
        ctx.lineWidth = Math.max(1, p.size * 0.6 * p.life);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 3, p.y - p.vy * 3);
        ctx.stroke();
      } else if (p.kind === 'star') {
        ctx.fillStyle = col;
        drawStar(p.x, p.y, p.size * (0.6 + p.life * 0.6), p.spin);
      } else {
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // осколки-валюта летят к счётчику по кривой
    for (let i = coins.length - 1; i >= 0; i--) {
      const m = coins[i];
      m.t += 0.028 * K;
      if (m.t <= 0) continue;
      if (m.t >= 1) {
        coins.splice(i, 1);
        bump(elShards);
        sfx.click();
        continue;
      }
      const t = m.t * m.t * (3 - 2 * m.t);
      const u = 1 - t;
      const x = u * u * m.sx + 2 * u * t * m.cx + t * t * m.tx;
      const y = u * u * m.sy + 2 * u * t * m.cy + t * t * m.ty;
      ctx.fillStyle = `hsla(${m.hue}, 100%, 75%, 0.95)`;
      ctx.shadowColor = `hsl(${m.hue}, 100%, 70%)`;
      ctx.shadowBlur = 10;
      const s = 6 - t * 2;
      ctx.beginPath();
      ctx.moveTo(x, y - s); ctx.lineTo(x + s * 0.7, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s * 0.7, y);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    ctx.globalCompositeOperation = 'source-over';

    // всплывающие надписи
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const base = Math.max(16, Math.min(W, 520) * 0.065);
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      f.y += f.vy * K;
      f.vy *= Math.pow(0.97, K);
      f.life -= 0.018 * K;
      if (f.life <= 0) { floaters.splice(i, 1); continue; }
      const pop = f.life > 0.85 ? 1 + (f.life - 0.85) * 2.5 : 1;
      ctx.font = `800 ${Math.round(base * f.scale * pop)}px "Segoe UI", Roboto, Arial, sans-serif`;
      ctx.globalAlpha = Math.min(1, f.life * 1.6);
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(10, 5, 35, 0.75)';
      ctx.strokeText(f.text, f.x, f.y);
      ctx.shadowColor = f.color;
      ctx.shadowBlur = 12;
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (paused) { lastFrame = now; return; }

    const dt = Math.min(now - lastFrame, 250);
    updateHelper(now, dt);
    lastFrame = now;
    K = Math.min(3, dt / 16.67);

    // затухание эффектов
    tapBounce *= Math.pow(0.82, K);
    crackKick *= Math.pow(0.8, K);
    perfectGlow *= Math.pow(0.9, K);
    flash *= Math.pow(0.86, K);
    shake *= Math.pow(0.87, K);

    const glow = pulseGlow(now);
    const { idx } = pulseInfo(now);
    // кольцо на каждом пике вспышки — подсказка ритма
    if (idx !== lastPulseIdx && Math.abs(pulseInfo(now).offset) < 40) {
      lastPulseIdx = idx;
      if (now >= brokenUntil) rings.push({ r: crystalRadius() * 0.7, life: 0.6, hue: crystalHue() });
    }

    drawBackground(now, glow);
    ctx.save();
    if (shake > 0.3) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    // пока идёт «стоп-кадр» разбития, кристалл ещё виден — белый
    if (pendingPieces) drawFrozenCrystal();
    else drawCrystal(now, glow);
    drawEffects(now);
    ctx.restore();

    if (flash > 0.01) {
      const c = crystalCenter();
      const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, Math.max(W, H) * 0.8);
      g.addColorStop(0, `hsla(${flashHue}, 100%, 92%, ${flash})`);
      g.addColorStop(1, `hsla(${flashHue}, 100%, 70%, ${flash * 0.25})`);
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  function drawFrozenCrystal() {
    const c = crystalCenter();
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.shadowColor = '#fff';
    ctx.shadowBlur = 50;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    for (const t of pendingPieces.pieces) {
      ctx.beginPath();
      t.pts.forEach(([x, y], k) => {
        const px = x + t.x - c.x, py = y + t.y - c.y;
        k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      });
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  // ================== Ввод ==================
  stage.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    tap(e.clientX - rect.left, e.clientY - rect.top);
  });
  elSellBtn.addEventListener('click', sell);
  // кнопка звука лежит поверх сцены — не даём её нажатию засчитаться как тап
  elSoundBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
  elSoundBtn.addEventListener('click', () => {
    initAudio();
    setMuted(!state.muted);
    sfx.click();
  });
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.code === 'Escape' || e.code === 'KeyM') { shopOpen ? closeShop() : (e.code === 'KeyM' && openShop()); return; }
    if (shopOpen) return;
    if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); tap(); }
    if (e.code === 'KeyS') sell();
    if (e.code === 'KeyN') setMuted(!state.muted);
  });
  // запрет контекстного меню и жестов (требование Яндекс Игр)
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('dblclick', (e) => e.preventDefault());
  document.addEventListener('gesturestart', (e) => e.preventDefault());

  window.addEventListener('resize', resize);
  if (window.ResizeObserver) new ResizeObserver(resize).observe(stage);

  // ================== Пауза при сворачивании ==================
  function setPaused(p) {
    if (paused === p) return;
    paused = p;
    if (audio) {
      if (p) audio.suspend().catch(() => {});
      else audio.resume().catch(() => {});
    }
    if (p) {
      saveNow();
      ysdkGameplay('stop');
    } else {
      ysdkGameplay('start');
    }
  }
  document.addEventListener('visibilitychange', () => setPaused(document.hidden));
  window.addEventListener('pagehide', saveNow);
  window.addEventListener('blur', saveNow);

  // ================== Яндекс Игры SDK ==================
  let ysdk = null;
  function ysdkGameplay(action) {
    try {
      const api = ysdk && ysdk.features && ysdk.features.GameplayAPI;
      if (api) action === 'start' ? api.start() : api.stop();
    } catch (e) { /* SDK недоступен */ }
  }
  function initYandex() {
    if (!window.YaGames || ysdk) return;
    window.YaGames.init().then((sdk) => {
      ysdk = sdk;
      try { sdk.features.LoadingAPI && sdk.features.LoadingAPI.ready(); } catch (e) { /* */ }
      ysdkGameplay('start');
    }).catch(() => {});
  }
  window.__ysdkLoaded = initYandex;

  // ================== Старт ==================
  load();
  buildShop();
  updateCrystalName();
  resize();
  syncCrackLines(true);
  setMuted(state.muted);
  updateUI();
  if (state.totalTaps > 0) elHint.classList.add('hidden');
  startTime = performance.now();
  requestAnimationFrame(frame);
  initYandex();
})();
