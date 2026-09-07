'use strict';
// Code that runs inside the Chromium page: real-font measurement, per-glyph
// occlusion against the figure's alpha, a DOM audit for QA and a perceptual
// hash. Injected as a script tag; everything hangs off window.__pv.
module.exports = `
window.__pv = (() => {
  const canvasEl = () => document.querySelector('[data-role="canvas"]');
  const W = () => canvasEl().clientWidth, H = () => canvasEl().clientHeight;

  // Width/height of each string set in the given CSS font declaration.
  function measure(items) {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;white-space:nowrap';
    document.body.appendChild(host);
    const out = items.map((it) => {
      const s = document.createElement('span');
      s.style.cssText = it.style + ';white-space:nowrap;display:inline-block';
      s.textContent = it.text;
      host.appendChild(s);
      const r = s.getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
    host.remove();
    return out;
  }

  // Per-glyph boxes of one text element, grouped into words, in canvas space.
  function glyphs(el) {
    const node = el.firstChild;
    if (!node || node.nodeType !== 3) return [];
    const base = canvasEl().getBoundingClientRect();
    const text = node.textContent;
    const words = []; let cur = null;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === ' ') { cur = null; continue; }
      const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + 1);
      const b = r.getBoundingClientRect();
      const g = { ch, x: b.left - base.left, y: b.top - base.top, w: b.width, h: b.height };
      if (!cur) { cur = { text: '', glyphs: [] }; words.push(cur); }
      cur.text += ch; cur.glyphs.push(g);
    }
    return words;
  }

  // Baseline of a text element: a zero-size inline-block sits on the baseline.
  function baselineY(el) {
    const probe = document.createElement('span');
    probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
    el.appendChild(probe);
    const y = probe.getBoundingClientRect().top - canvasEl().getBoundingClientRect().top;
    probe.remove();
    return y;
  }

  // Alpha of the figure image as laid out (position, size, mirror), over the
  // whole canvas. Returns a Uint8ClampedArray of length W*H (0..255).
  async function figureAlpha(img) {
    if (!img.complete) await img.decode();
    const base = canvasEl().getBoundingClientRect();
    const r = img.getBoundingClientRect();
    const c = document.createElement('canvas'); c.width = W(); c.height = H();
    const ctx = c.getContext('2d');
    const mirrored = /matrix\\(-1|scaleX\\(-1/.test(getComputedStyle(img).transform) || getComputedStyle(img).transform.startsWith('matrix(-1');
    ctx.save();
    if (mirrored) { ctx.translate(r.left - base.left + r.width, r.top - base.top); ctx.scale(-1, 1); ctx.drawImage(img, 0, 0, r.width, r.height); }
    else ctx.drawImage(img, r.left - base.left, r.top - base.top, r.width, r.height);
    ctx.restore();
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const a = new Uint8ClampedArray(c.width * c.height);
    for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
    return a;
  }

  // Ink of one text element drawn with the same font on an offscreen canvas.
  function textInk(el) {
    const cs = getComputedStyle(el);
    const c = document.createElement('canvas'); c.width = W(); c.height = H();
    const ctx = c.getContext('2d');
    ctx.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
    if ('letterSpacing' in ctx) ctx.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#000';
    const words = glyphs(el);
    const x0 = words.length ? Math.min(...words.map((w) => w.glyphs[0].x)) : 0;
    ctx.fillText(el.firstChild.textContent, x0, baselineY(el));
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const a = new Uint8ClampedArray(c.width * c.height);
    for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
    return { alpha: a, words };
  }

  // Coverage of each glyph's ink by figure alpha: fraction 0..1. Lines in front
  // of the figure are reported with front:true and coverage 0 by definition.
  async function occlusion(lineSelector, imgSelector, opts) {
    const img = document.querySelector(imgSelector);
    const lines = [...document.querySelectorAll(lineSelector)];
    if (!img || !lines.length) return { lines: [] };
    const fig = await figureAlpha(img);
    const figZ = parseInt(getComputedStyle(img).zIndex || '0', 10);
    const w = W(), h = H();
    const inkT = opts.inkThreshold, figT = opts.figureThreshold;
    const out = [];
    for (const el of lines) {
      const z = parseInt(getComputedStyle(el).zIndex || '0', 10);
      const front = z > figZ;
      const { alpha, words } = textInk(el);
      const lineOut = { index: +el.dataset.line, front, words: [] };
      for (const wd of words) {
        const wo = { text: wd.text, glyphs: [] };
        for (const g of wd.glyphs) {
          const x1 = Math.max(0, Math.floor(g.x) - 1), x2 = Math.min(w, Math.ceil(g.x + g.w) + 1);
          const y1 = Math.max(0, Math.floor(g.y) - 1), y2 = Math.min(h, Math.ceil(g.y + g.h) + 1);
          let ink = 0, covered = 0;
          for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) {
            const i = y * w + x;
            if (alpha[i] >= inkT) { ink++; if (fig[i] >= figT) covered++; }
          }
          wo.glyphs.push({ ch: g.ch, coverage: ink ? covered / ink : 0, ink });
        }
        lineOut.words.push(wo);
      }
      out.push(lineOut);
    }
    return { lines: out };
  }

  // Fraction of the figure's opaque pixels along each edge of the image.
  async function edgeAlpha(img) {
    if (!img.complete) await img.decode();
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const a = (x, y) => d[(y * c.width + x) * 4 + 3];
    const scan = (pts) => { let n = 0, run = 0, best = 0; for (const [x, y] of pts) { if (a(x, y) >= 128) { n++; run++; if (run > best) best = run; } else run = 0; } return { frac: n / pts.length, run: best }; };
    const top = [], bottom = [], left = [], right = [];
    for (let x = 0; x < c.width; x++) { top.push([x, 0]); bottom.push([x, c.height - 1]); }
    for (let y = 0; y < c.height; y++) { left.push([0, y]); right.push([c.width - 1, y]); }
    return { top: scan(top), right: scan(right), bottom: scan(bottom), left: scan(left) };
  }

  // Everything QA needs from the DOM in one pass.
  function audit() {
    const base = canvasEl().getBoundingClientRect();
    const rel = (r) => ({ x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height });
    const texts = [];
    const walker = document.createTreeWalker(canvasEl(), NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (!n.textContent.trim()) continue;
      const el = n.parentElement;
      const cs = getComputedStyle(el);
      const range = document.createRange(); range.selectNodeContents(n);
      const rects = [...range.getClientRects()].map(rel);
      texts.push({
        text: n.textContent, tag: el.tagName.toLowerCase(), role: el.closest('[data-role]')?.dataset.role || null,
        line: el.dataset.line !== undefined ? +el.dataset.line : null,
        fontSize: parseFloat(cs.fontSize), fontFamily: cs.fontFamily, color: cs.color, background: cs.backgroundColor,
        fill: cs.fill, whiteSpace: cs.whiteSpace,
        rects, scrollOverflow: el.scrollWidth > el.clientWidth + 1,
        clientW: el.clientWidth, scrollW: el.scrollWidth,
        accent: !!el.closest('[data-accent]'),
      });
    }
    const images = [...canvasEl().querySelectorAll('img')].map((img) => {
      const cs = getComputedStyle(img);
      return {
        cutout: img.dataset.cutout || null, rect: rel(img.getBoundingClientRect()),
        naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
        mixBlendMode: cs.mixBlendMode, opacity: parseFloat(cs.opacity), filter: cs.filter,
        mask: cs.maskImage || cs.webkitMaskImage, clipPath: cs.clipPath, transform: cs.transform, zIndex: cs.zIndex,
      };
    });
    const painted = [...canvasEl().querySelectorAll('*')].map((el) => {
      const cs = getComputedStyle(el);
      return { tag: el.tagName.toLowerCase(), role: el.dataset.role || null, signal: el.dataset.signal || null,
        color: cs.color, background: cs.backgroundColor, backgroundImage: cs.backgroundImage, fill: cs.fill, stroke: cs.stroke,
        rect: rel(el.getBoundingClientRect()), hasText: !!el.textContent.trim() };
    });
    const roles = [...canvasEl().querySelectorAll('[data-role]')].map((el) => ({ role: el.dataset.role, rect: rel(el.getBoundingClientRect()), text: el.textContent.trim().slice(0, 40) }));
    const canvasCs = getComputedStyle(canvasEl());
    return { texts, images, painted, roles, canvas: { w: base.width, h: base.height, background: canvasCs.backgroundColor, backgroundImage: canvasCs.backgroundImage } };
  }

  // 64-bit DCT perceptual hash of an image data URI, as 16 hex chars.
  async function phash(dataUri) {
    const img = new Image(); img.src = dataUri; await img.decode();
    const N = 32;
    const c = document.createElement('canvas'); c.width = N; c.height = N;
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, N, N);
    const d = ctx.getImageData(0, 0, N, N).data;
    const g = new Float64Array(N * N);
    for (let i = 0; i < N * N; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    const cosT = []; for (let u = 0; u < N; u++) { cosT[u] = []; for (let x = 0; x < N; x++) cosT[u][x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N)); }
    const rows = new Float64Array(N * N);
    for (let y = 0; y < N; y++) for (let u = 0; u < 8; u++) { let s = 0; for (let x = 0; x < N; x++) s += g[y * N + x] * cosT[u][x]; rows[y * N + u] = s; }
    const dct = [];
    for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) { let s = 0; for (let y = 0; y < N; y++) s += rows[y * N + u] * cosT[v][y]; dct.push(s); }
    const ac = dct.slice(1).sort((a, b) => a - b); const med = ac[Math.floor(ac.length / 2)];
    let bits = '';
    for (let i = 0; i < 64; i++) bits += dct[i] > med ? '1' : '0';
    let hex = '';
    for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    return hex;
  }

  return { measure, glyphs, occlusion, edgeAlpha, audit, phash };
})();
`;
