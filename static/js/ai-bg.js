// ══════════════════════════════════════════════════════════════════════════════
// AIアシスタント画面の背景 — ゆっくり流れる文字の海と、タップで広がる青い波
//   ・文字はグリッドに並べ、2つのノイズを重ねた濃淡で「雲」のように見え隠れさせる
//   ・tzWave(x, y) で、その位置から青い波紋が文字を染めながら広がる
//   ・画面が非表示のとき・タブが裏のときは描画を止める。動きを減らす設定なら静止画にする
// ══════════════════════════════════════════════════════════════════════════════
const TZ_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const TZ_FPS = 40;

const tzBg = {
  canvas: null, ctx: null, w: 0, h: 0, dpr: 1,
  cw: 9, ch: 18, fs: 13, cols: 0, rows: 0,
  chars: null,          // Uint8Array: 各セルの文字（TZ_CHARS の添字）
  waves: [],            // { x, y, t0, power }
  running: false, last: 0, t: 0,
  reduced: false,
  quiet: false,         // 会話が始まったら背景を止める（チャットの文字を読みやすくするため）
};

function tzRandChar() { return (Math.random() * TZ_CHARS.length) | 0; }

// ── 値ノイズ（なめらかな濃淡を作る） ──
function tzHash(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function tzNoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = tzHash(xi, yi), b = tzHash(xi + 1, yi);
  const c = tzHash(xi, yi + 1), d = tzHash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function tzBgResize() {
  const cv = tzBg.canvas;
  if (!cv) return;
  const r = cv.getBoundingClientRect();
  if (!r.width || !r.height) return;
  // Claude Code の画面に合わせ、小さめの等幅文字を少し字間をあけて並べる
  tzBg.fs = 10.5;
  tzBg.cw = 7.4;
  tzBg.ch = 13.5;
  tzBg.dpr = Math.min(window.devicePixelRatio || 1, 2);
  tzBg.w = r.width; tzBg.h = r.height;
  cv.width = Math.round(r.width * tzBg.dpr);
  cv.height = Math.round(r.height * tzBg.dpr);
  const cols = Math.ceil(r.width / tzBg.cw), rows = Math.ceil(r.height / tzBg.ch);
  if (cols !== tzBg.cols || rows !== tzBg.rows || !tzBg.chars) {
    tzBg.cols = cols; tzBg.rows = rows;
    tzBg.chars = new Uint8Array(cols * rows);
    tzBg.shade = new Float32Array(cols * rows);   // 各文字の明るさのばらつき（波の中で使う）
    for (let i = 0; i < tzBg.chars.length; i++) { tzBg.chars[i] = tzRandChar(); tzBg.shade[i] = Math.random(); }
  }
  const ctx = tzBg.ctx;
  ctx.setTransform(tzBg.dpr, 0, 0, tzBg.dpr, 0, 0);
  ctx.font = `${tzBg.fs}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  ctx.textBaseline = 'top';
  if (tzBg.reduced) tzBgDraw();
}

const TZ_WAVE_LIFE = 2.6;   // 秒

function tzBgDraw() {
  const { ctx, cols, rows, cw, ch, chars, shade } = tzBg;
  const t = tzBg.t;
  ctx.clearRect(0, 0, tzBg.w, tzBg.h);

  // 波: 文字でできた太い輪が、ふちをゆらがせながら広がって消える
  const speed = Math.min(520, Math.max(300, Math.max(tzBg.w, tzBg.h) * 0.42));   // px/秒
  tzBg.waves = tzBg.waves.filter(wv => t - wv.t0 < TZ_WAVE_LIFE);
  const waves = tzBg.waves.map(wv => {
    const age = t - wv.t0;
    return {
      x: wv.x, y: wv.y, seed: wv.seed,
      r: 10 + age * speed * (1 - age / (TZ_WAVE_LIFE * 2.2)),   // だんだん遅くなる
      half: 26 + age * 70,                                       // 輪の太さ（半分）
      life: wv.power * Math.pow(1 - age / TZ_WAVE_LIFE, 1.3),
    };
  });

  // 文字を色と明るさごとにまとめて描く（fillStyle の切り替えを減らす）
  const buckets = new Map();
  const put = (key, x, y, c) => {
    let b = buckets.get(key);
    if (!b) buckets.set(key, b = []);
    b.push(x, y, c);
  };

  const drift = t * 0.04;
  for (let row = 0; row < rows; row++) {
    const y = row * ch;
    for (let col = 0; col < cols; col++) {
      const x = col * cw;
      const i = row * cols + col;
      // ふだんは、ところどころに薄い文字のかたまりがあるだけ
      const n = tzNoise(col * 0.035 + drift, row * 0.07 - drift * 0.6) * 0.7
              + tzNoise(col * 0.12 - drift * 1.5, row * 0.2 + drift) * 0.3;
      let base = (n - 0.62) / 0.22;
      base = base <= 0 ? 0 : base >= 1 ? 1 : base * base * (3 - 2 * base);

      // 波の輪の中にいるか
      let wave = 0;
      for (const wv of waves) {
        const dx = x - wv.x, dy = y - wv.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > wv.r + wv.half * 1.6 || dist < wv.r - wv.half * 1.6) continue;
        // ふちを角度とノイズでゆらがせる
        const ang = Math.atan2(dy, dx);
        const wob = (tzNoise(ang * 2.2 + wv.seed, t * 0.8) - 0.5) * wv.half * 1.1;
        const d = Math.abs(dist - (wv.r + wob)) / wv.half;
        if (d >= 1) continue;
        const k = d < 0.55 ? 1 : 1 - (d - 0.55) / 0.45;   // 輪の中はほぼ一様、ふちでフェード
        wave = Math.max(wave, k * wv.life);
      }

      if (wave > 0.02) {
        // 輪の文字は1つずつ明るさが違う（明るい青と、くすんだ青が混ざる）
        const sh = shade[i];
        if (Math.random() < 0.04) chars[i] = tzRandChar();
        const a = wave * (0.28 + 0.72 * sh);
        if (a < 0.04) continue;
        const level = Math.min(9, Math.round(a * 9));
        put((sh > 0.55 ? 20 : 10) + level, x, y, chars[i]);
      } else {
        if (base < 0.15) continue;
        if (Math.random() < 0.001) chars[i] = tzRandChar();
        put(Math.min(9, Math.round(base * 9)), x, y, chars[i]);
      }
    }
  }

  const palette = [
    [150, 150, 150],   // 0: ふだんの文字（灰）
    [44, 92, 130],     // 1: 波のくすんだ青
    [52, 146, 222],    // 2: 波の明るい青
  ];
  for (const [key, list] of buckets) {
    const kind = (key / 10) | 0, level = key % 10;
    const [r, g, b] = palette[kind];
    // ふだんの文字はほとんど見えないくらい薄く（最大 0.09）、波の文字ははっきり
    const alpha = kind === 0 ? (level / 9) * 0.09 : level / 9;
    ctx.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
    for (let j = 0; j < list.length; j += 3) ctx.fillText(TZ_CHARS[list[j + 2]], list[j], list[j + 1]);
  }
}

function tzBgLoop(now) {
  const page = document.getElementById('page-ai');
  const open = page?.classList.contains('active') || document.body.classList.contains('tz-float');
  if (!open || document.hidden || tzBg.quiet) { tzBg.running = false; return; }
  requestAnimationFrame(tzBgLoop);
  if (now - tzBg.last < 1000 / TZ_FPS) return;
  tzBg.t += Math.min(0.1, (now - (tzBg.last || now)) / 1000);
  tzBg.last = now;
  tzBgDraw();
}

/** 背景を開始する（画面を開くたびに呼ぶ。動いていれば何もしない） */
function tzBgStart() {
  const cv = document.getElementById('tz-bg');
  if (!cv) return;
  if (!tzBg.canvas) {
    tzBg.canvas = cv;
    tzBg.ctx = cv.getContext('2d');
    tzBg.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.addEventListener('resize', () => { tzLayout(); tzBgResize(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tzBgStart(); });
    // 背景（会話の外側も含む）を押すと波が立つ。入力欄やボタンの上でも同じ
    document.getElementById('tz').addEventListener('pointerdown', e => {
      const r = cv.getBoundingClientRect();
      tzWave(e.clientX - r.left, e.clientY - r.top, 1);
    });
  }
  tzLayout();
  tzBgResize();
  if (tzBg.quiet) return;
  if (tzBg.reduced) { tzBgDraw(); return; }
  if (!tzBg.running) {
    tzBg.running = true;
    tzBg.last = 0;
    requestAnimationFrame(tzBgLoop);
  }
}

/** (x, y) から青い波を出す。座標は canvas 内の px。power は 0〜1 */
function tzWave(x, y, power = 1) {
  if (tzBg.reduced || tzBg.quiet || !tzBg.canvas) return;
  tzBg.waves.push({ x, y, t0: tzBg.t, power, seed: Math.random() * 100 });
  if (tzBg.waves.length > 6) tzBg.waves.shift();
}

/**
 * 会話中は背景を消して止める（quiet=true）。最初の画面に戻ったら再開する。
 * 消すときはフェードアウトしてから描画を止め、canvas を空にする。
 */
function tzBgSetQuiet(quiet) {
  if (tzBg.quiet === quiet) return;
  tzBg.quiet = quiet;
  document.getElementById('tz')?.classList.toggle('quiet', quiet);
  clearTimeout(tzBg.quietTimer);
  if (quiet) {
    tzBg.waves = [];
    tzBg.quietTimer = setTimeout(() => { if (tzBg.quiet && tzBg.ctx) tzBg.ctx.clearRect(0, 0, tzBg.w, tzBg.h); }, 700);
  } else {
    tzBgStart();
  }
}

/** 要素の中心から波を出す */
function tzWaveFrom(el, power = 1) {
  if (!el || !tzBg.canvas) return;
  const a = el.getBoundingClientRect(), b = tzBg.canvas.getBoundingClientRect();
  tzWave(a.left + a.width / 2 - b.left, a.top + a.height / 2 - b.top, power);
}

// ── 画面の位置合わせ ──
// AIアシスタント画面は上部バーの下・サイドバーの右を固定で覆う。スマホではキーボードの分だけ下を空ける。
function tzLayout() {
  const tz = document.getElementById('tz');
  if (!tz) return;
  const mobile = window.matchMedia('(max-width:768px)').matches;
  const vv0 = window.visualViewport;
  const kb0 = vv0 ? Math.max(0, window.innerHeight - vv0.height - vv0.offsetTop) : 0;
  if (document.body.classList.contains('tz-float')) {
    // 浮かぶパネル: パソコンは CSS の位置（右下）、スマホは全画面（キーボードの分だけ上げる）
    tz.style.top = mobile ? '0px' : '';
    tz.style.left = mobile ? '0px' : '';
    tz.style.bottom = mobile ? kb0 + 'px' : '';
    return;
  }
  const top = document.querySelector('.topbar')?.getBoundingClientRect().bottom || 0;
  const left = mobile ? 0 : (document.getElementById('sb')?.getBoundingClientRect().right || 0);
  tz.style.top = Math.max(0, top) + 'px';
  tz.style.left = Math.max(0, left) + 'px';
  const vv = window.visualViewport;
  const kb = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
  tz.style.bottom = kb + 'px';
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => { tzLayout(); tzBgResize(); });
  window.visualViewport.addEventListener('scroll', tzLayout);
}

// ── ドット絵のアイコン（AIアシスタント） ──
// 吹き出しと、きらめき。. 空白 / B 吹き出し / L 縁の明るい色 / S きらめき / E 目
const TZ_PONY = [
  '...........S....',
  '..........SSS...',
  '.BBBBBBBB..S....',
  'BLLLLLLLLB......',
  'BLBBBBBBBLB.....',
  'BLBEBBBEBLB.....',
  'BLBBBBBBBLB.....',
  'BLBBEEEBBLB.....',
  'BLLLLLLLLB......',
  '.BBBBBBBB.......',
  '...BB...........',
  '..BB.......S....',
  '..B.......SSS...',
  '...........S....',
];
function tzPonySvg(px = 4) {
  const color = { B: '#3b82f6', L: '#93c5fd', E: '#0b0d12', S: '#f59e0b' };
  const h = TZ_PONY.length, w = TZ_PONY[0].length;
  let rects = '';
  TZ_PONY.forEach((line, y) => [...line].forEach((c, x) => {
    if (color[c]) rects += `<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${color[c]}"/>`;
  }));
  return `<svg viewBox="0 0 ${w} ${h}" width="${w * px}" height="${h * px}" shape-rendering="crispEdges">${rects}</svg>`;
}
