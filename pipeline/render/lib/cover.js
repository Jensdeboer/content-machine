'use strict';
// Cover composition. Sizes the headline in the real font, places the figure
// from the manifest's type-space, and verifies occlusion pixel by pixel.
const { metrics, esc, px, v, color, size, space, st, type, coverKicker, coverMark, groundRoles } = require('./html');
const cut = require('./cutouts');
const RULES = require('./rules');

const MODE = {
  shout: { weight: 'bold', tracking: 'shout', leading: metrics.leading.shout, start: 'hero', transform: 'uppercase' },
  sentence: { weight: 'semi', tracking: 'statement', leading: metrics.leading.sentence, start: 'm', transform: 'none' },
  number: { weight: 'bold', tracking: 'monument', leading: metrics.leading.number, start: null, transform: 'none' },
};

function numberStart(text) {
  const digits = text.replace(/\D/g, '').length;
  return digits <= 2 ? 'monument' : digits === 3 ? 'hero' : 'xl';
}

function lineStyle(mode, step, inkRole, extra = {}) {
  const m = MODE[mode];
  const fn = m.weight === 'bold' ? type.displayBold : type.displaySemi;
  return fn(step, {
    'line-height': m.leading, 'letter-spacing': v(`track-${m.tracking}`), color: color(inkRole),
    'text-transform': m.transform, 'white-space': 'nowrap', ...extra,
  });
}

// ---------------------------------------------------------------- sizing ---
// Steps down through the token size scale, measuring in the browser, until
// every line fits the 888 measure and the block fits the safe height.
async function fitHeadline(page, tokens, brief, inkRole) {
  const c = brief.cover;
  const mode = c.mode;
  const explicit = Array.isArray(c.lines) && c.lines.length > 0;
  let step = mode === 'number' ? numberStart(c.headline) : MODE[mode].start;
  const attempts = [];
  while (step) {
    const stepPx = tokens.size(step);
    const lineH = stepPx * MODE[mode].leading;
    let lines;
    if (explicit) lines = c.lines.slice();
    else if (mode === 'shout') lines = c.headline.split(/\s+/);
    else if (mode === 'number') lines = [c.headline];
    else lines = await greedyBreak(page, c.headline, lineStyle(mode, step, inkRole), tokens.safe.width);
    const widths = (await page.evaluate((items) => window.__pv.measure(items), lines.map((text) => ({ text, style: lineStyle(mode, step, inkRole) })))).map((m) => m.w);
    const widest = Math.max(...widths);
    const blockH = lines.length * lineH;
    const fits = widest <= tokens.safe.width && blockH <= tokens.safe.height;
    attempts.push({ step, widest: Math.round(widest), lines: lines.length, fits });
    if (fits) return { step, stepPx, lineH, lines, widths, blockH, attempts };
    step = tokens.stepDown(step);
  }
  return { step: null, attempts };
}

// Greedy line breaking on measured word widths at one size.
async function greedyBreak(page, text, style, measure) {
  const words = text.split(/\s+/).filter(Boolean);
  const widths = await page.evaluate((items) => window.__pv.measure(items), [...words, ' '].map((t) => ({ text: t === ' ' ? ' ' : t, style })));
  const spaceW = widths[widths.length - 1].w;
  const lines = []; let cur = []; let curW = 0;
  words.forEach((w, i) => {
    const ww = widths[i].w;
    if (cur.length && curW + spaceW + ww > measure) { lines.push(cur.join(' ')); cur = [w]; curW = ww; }
    else { curW = cur.length ? curW + spaceW + ww : ww; cur.push(w); }
  });
  if (cur.length) lines.push(cur.join(' '));
  return lines;
}

// ------------------------------------------------------------- geometry ---
function lineRect(tokens, fit, align, top, i) {
  const w = fit.widths[i];
  const x = align === 'right' ? tokens.canvas.width - tokens.margin - w
    : align === 'centre' ? (tokens.canvas.width - w) / 2 : tokens.margin;
  return { x, y: top + i * fit.lineH, w, h: fit.lineH };
}

function positionLabel(tokens, box) {
  const W = tokens.canvas.width, H = tokens.canvas.height;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const h = cx < W / 3 ? 'left' : cx > (2 * W) / 3 ? 'right' : 'centre';
  let vpos;
  if (box.y + box.h >= H) vpos = 'bottom';
  else if (box.y <= 0) vpos = 'top';
  else vpos = cy < H / 3 ? 'upper' : cy > (2 * H) / 3 ? 'lower' : 'middle';
  return `${vpos}-${h}`;
}

function horizontalFacing(cutout) {
  const f = (cutout.faces || '').split(',')[0].trim();
  return f === 'left' || f === 'right' ? f : null;
}

// Brief override, else the manifest's crop wording (written from the source
// photo), else alpha detection. The wording wins when the two disagree: the
// alpha of several cutouts is eroded at the crop.
function slicedEdges(cutout, edgeStats, override) {
  if (override) return { edges: override.slice(), from: 'brief' };
  const worded = cut.cropEdgesFromManifest(cutout);
  if (worded.length) return { edges: worded, from: 'manifest crop wording' };
  const detected = cut.EDGES.filter((e) => edgeStats[e].frac >= RULES.slicedEdgeFrac || edgeStats[e].run >= RULES.slicedEdgeRun);
  return { edges: detected, from: `alpha (${detected.join(',') || 'none'})` };
}

// Candidate figure placements in preference order.
function figureCandidates(tokens, cutout, fixed, sliced, align, subject) {
  const W = tokens.canvas.width, H = tokens.canvas.height;
  const out = [];
  const scales = fixed.scale !== undefined ? [fixed.scale] : RULES.scaleSteps;
  for (const scale of scales) {
    if (scale > RULES.maxScale) continue;
    const w = cutout.width * scale, h = cutout.height * scale;
    if (fixed.x !== undefined && fixed.y !== undefined) { out.push({ x: fixed.x, y: fixed.y, scale, anchor: 'explicit' }); continue; }
    const hx = {
      'left-bleed': -w * 0.25, left: 0, 'centre-left': W / 4 - w / 2, centre: (W - w) / 2,
      'centre-right': (3 * W) / 4 - w / 2, right: W - w, 'right-bleed': W - w * 0.75,
    };
    const vy = { top: 0, upper: H / 4 - h / 2, middle: (H - h) / 2, lower: (3 * H) / 4 - h / 2, bottom: H - h, 'bottom-deep': H - h * 0.8 };
    let hs = align === 'right' ? ['left', 'left-bleed', 'centre-left', 'centre', 'centre-right', 'right', 'right-bleed']
      : align === 'centre' ? ['centre', 'right', 'left', 'centre-right', 'centre-left', 'right-bleed', 'left-bleed']
        : ['right', 'right-bleed', 'centre-right', 'centre', 'centre-left', 'left', 'left-bleed'];
    let vs = ['bottom', 'lower', 'middle', 'upper', 'top'];
    if (sliced.includes('left')) hs = ['left', 'left-bleed'];
    if (sliced.includes('right')) hs = ['right', 'right-bleed'];
    if (sliced.includes('left') && sliced.includes('right')) hs = ['left', 'right', 'left-bleed', 'right-bleed'];
    if (sliced.includes('bottom')) vs = ['bottom', 'bottom-deep'];
    if (sliced.includes('top')) vs = ['top'];
    if (sliced.includes('top') && sliced.includes('bottom')) vs = ['top', 'bottom'];
    for (const vk of vs) for (const hk of hs) {
      const x = fixed.x !== undefined ? fixed.x : hx[hk];
      const y = fixed.y !== undefined ? fixed.y : vy[vk];
      const bleeds = x < 0 || y < 0 || x + w > W || y + h > H;
      if (subject === 'detail' && !bleeds) continue; // detail covers bleed off an edge
      // Sliced edges sit on or beyond the canvas edge.
      if (sliced.includes('bottom') && y + h < H - 0.5) continue;
      if (sliced.includes('top') && y > 0.5) continue;
      if (sliced.includes('left') && x > 0.5) continue;
      if (sliced.includes('right') && x + w < W - 0.5) continue;
      out.push({ x: Math.round(x), y: Math.round(y), scale, anchor: `${vk}-${hk}` });
    }
  }
  return out;
}

// Rect-based checks of one headline layout against the placed figure.
function zoneChecks(tokens, fit, align, top, zBehind, cutout, place, chromeRects) {
  const zones = cut.zoneRects(cutout, place);
  const box = cut.figureBox(cutout, place);
  const problems = [];
  let behindOverlap = 0, typeSpaceShare = 1;
  fit.lines.forEach((text, i) => {
    const r = lineRect(tokens, fit, align, top, i);
    for (const cr of chromeRects) if (cut.intersects(r, cr.rect)) problems.push(`line ${i} collides with the ${cr.role}`);
    if (!zBehind[i]) return;
    const ov = cut.intersection(r, box);
    if (!ov) return;
    behindOverlap += cut.area(ov);
    let ts = 0;
    for (const z of zones) {
      const zi = cut.intersection(r, z.rect);
      if (!zi) continue;
      if (z.kind === 'dense') problems.push(`line ${i} ("${text}") sits in dense zone ${z.name}`);
      if (z.kind === 'type-space') ts += cut.area(zi);
    }
    typeSpaceShare = Math.min(typeSpaceShare, ts / cut.area(ov));
  });
  for (const cr of chromeRects) {
    const ov = cut.intersection(cr.rect, box);
    if (!ov) continue;
    const bad = zones.some((z) => z.kind !== 'type-space' && cut.intersection(cr.rect, z.rect));
    if (bad) problems.push(`${cr.role} does not sit on clear ground`);
  }
  return { ok: problems.length === 0, problems, behindOverlap, typeSpaceShare };
}

// Pixel occlusion rules on the in-page measurement.
function occlusionProblems(occ, lastLineIndex) {
  const problems = [];
  for (const line of occ.lines) {
    if (line.front) continue;
    line.words.forEach((w, wi) => {
      const isFinalWord = line.index === lastLineIndex && wi === line.words.length - 1;
      w.glyphs.forEach((g, gi) => {
        const edge = gi === 0 || gi === w.glyphs.length - 1;
        if (isFinalWord && g.coverage > RULES.finalWordMaxCoverage) problems.push({ line: line.index, word: w.text, glyph: g.ch, coverage: g.coverage, rule: 'final-word-occluded' });
        else if (edge && g.coverage > RULES.edgeGlyphMaxCoverage) problems.push({ line: line.index, word: w.text, glyph: g.ch, coverage: g.coverage, rule: 'edge-letter-lost' });
        else if (g.coverage > RULES.glyphMaxCoverage) problems.push({ line: line.index, word: w.text, glyph: g.ch, coverage: g.coverage, rule: 'glyph-over-40' });
      });
    });
  }
  return problems;
}

// ------------------------------------------------------------------ html ---
function headlineHtml(tokens, fit, mode, align, top, zBehind, inkRole, extraStyle = {}) {
  return fit.lines.map((text, i) => {
    const r = lineRect(tokens, fit, align, top, i);
    const pos = align === 'right' ? { right: v('margin'), 'text-align': 'right' }
      : align === 'centre' ? { left: 0, right: 0, 'text-align': 'center' } : { left: v('margin') };
    const style = st({ position: 'absolute', top: px(Math.round(r.y)), ...pos, 'z-index': zBehind[i] ? 1 : 3 }) + ';' + lineStyle(mode, fit.step, inkRole, extraStyle[i] || {});
    return `<div data-role="headline-line" data-line="${i}" style="${style}">${esc(text)}</div>`;
  }).join('\n');
}

function figureHtml(cutout, place, dataUri) {
  const b = cut.figureBox(cutout, place);
  return `<img data-role="figure" data-cutout="${esc(cutout.id)}" src="${dataUri}" style="${st({
    position: 'absolute', left: px(place.x), top: px(place.y), width: px(Math.round(b.w)), height: px(Math.round(b.h)),
    transform: place.mirror ? 'scaleX(-1)' : undefined, 'z-index': 2,
  })}">`;
}

function asideHtml(tokens, text, top, inkRole, align) {
  const pos = align === 'right' ? { right: v('margin'), 'text-align': 'right' } : align === 'centre' ? { left: 0, right: 0, 'text-align': 'center' } : { left: v('margin') };
  return `<div data-role="aside" style="${st({ position: 'absolute', top: px(top), ...pos, 'z-index': 4, 'white-space': 'nowrap' })};${type.aside({ color: color(inkRole) })}">${esc(text)}</div>`;
}

function payoffHtml(tokens, text, top, inkRole, step) {
  return `<div data-role="payoff" style="${st({ position: 'absolute', top: px(top), left: v('margin'), 'z-index': 3, 'white-space': 'nowrap' })};${type.displaySemi(step, { 'line-height': metrics.leading.payoff, 'letter-spacing': v('track-statement'), color: color(inkRole) })}">${esc(text)}</div>`;
}

function signalBlockHtml(tokens, rect) {
  const sb = metrics.cover.signalBlock;
  return `<div data-role="signal-block" data-signal="block" style="${st({
    position: 'absolute', left: 0, width: px(tokens.canvas.width - sb.rightInset), top: px(Math.round(rect.y - sb.pad)), height: px(Math.round(rect.h + sb.pad * 2)),
    background: color('signal'), 'z-index': 0,
  })}"></div>`;
}

// Type-led devices (03-covers/cover-type-led.dc.html) and conceptual graphics
// (03-covers/cover-concept.dc.html). Return extra HTML and any headline top.
function deviceHtml(tokens, brief, fit, top, inkRole, ground) {
  const c = brief.cover;
  const W = tokens.canvas.width, safeW = tokens.safe.width, m = tokens.margin;
  const rule = px(metrics.rule.cover);
  const parts = [];
  if (c.subject === 'type-led') {
    const dev = c.device || 'plain';
    if (dev === 'rule-cut' && fit.lines.length >= 2) {
      const y = top + fit.lineH - metrics.cover.typeLed.ruleCutGap;
      parts.push(`<div data-role="device" style="${st({ position: 'absolute', left: v('margin'), right: 0, top: px(Math.round(y)), 'border-top': `${rule} solid ${color(inkRole)}`, 'z-index': 1 })}"></div>`);
    }
    if (dev === 'hairline-stack') {
      const g = metrics.cover.typeLed.hairlineGap;
      for (const y of [top - g, top + fit.blockH + g]) {
        parts.push(`<div data-role="device" style="${st({ position: 'absolute', left: v('margin'), right: v('margin'), top: px(Math.round(y)), 'border-top': `${rule} solid ${color(inkRole)}`, 'z-index': 1 })}"></div>`);
      }
    }
    return parts.join('\n');
  }
  if (c.subject === 'conceptual') {
    const dev = c.device;
    const k = metrics.cover.concept;
    const stroke = ground === 'white' ? color('ink') : color('on-accent');
    const wrap = (inner, gTop, h) => `<div data-role="device" style="${st({ position: 'absolute', top: px(gTop), left: v('margin'), 'z-index': 1 })}"><svg viewBox="0 0 ${safeW} ${h}" width="${safeW}" height="${h}">${inner}</svg></div>`;
    const gTop = c.layout && c.layout.graphicTop !== undefined ? c.layout.graphicTop : k[dev].top;
    if (dev === 'paceLine') {
      const p = k.paceLine;
      const pl = p.planned.map((q) => q.join(',')).join(' '), ac = p.actual.map((q) => q.join(',')).join(' ');
      const last = p.actual[p.actual.length - 1];
      parts.push(wrap(`<polyline points="${pl}" fill="none" stroke="${stroke}" stroke-opacity="${p.plannedOpacity}" stroke-width="${p.plannedStroke}" stroke-dasharray="${p.plannedDash}"></polyline><polyline points="${ac}" fill="none" stroke="${stroke}" stroke-width="${p.actualStroke}"></polyline><circle cx="${last[0]}" cy="${last[1]}" r="${p.dotRadius}" fill="${stroke}"></circle>`, gTop, p.height));
    } else if (dev === 'splitRuler') {
      const p = k.splitRuler, mid = p.height / 2;
      const ticks = p.ticks.map((x, i) => { const half = i % 2 === 0 ? p.majorHalf : p.minorHalf; return `<line x1="${x}" y1="${mid - half}" x2="${x}" y2="${mid + half}"></line>`; }).join('');
      parts.push(wrap(`<line x1="0" y1="${mid}" x2="${safeW}" y2="${mid}" stroke="${stroke}" stroke-width="${p.stroke}"></line><g stroke="${stroke}" stroke-width="${p.stroke}">${ticks}</g>`, gTop, p.height));
    } else if (dev === 'markedKm') {
      const p = k.markedKm, at = (c.deviceData && c.deviceData.at !== undefined ? c.deviceData.at : p.at) * safeW;
      const tickColor = c.signal === 'mark' ? color('signal') : stroke;
      const tickAttr = c.signal === 'mark' ? ' data-signal="mark"' : '';
      parts.push(wrap(`<line x1="0" y1="${p.height / 2}" x2="${safeW}" y2="${p.height / 2}" stroke="${stroke}" stroke-opacity="${p.lineOpacity}" stroke-width="${p.stroke}"></line><line${tickAttr} x1="${at}" y1="0" x2="${at}" y2="${p.height}" stroke="${tickColor}" stroke-width="${p.tickStroke}"></line>`, gTop, p.height));
    } else if (dev === 'threeZones') {
      const p = k.threeZones, weights = (c.deviceData && c.deviceData.weights) || p.weights;
      const tones = ground === 'white' ? ['accent', 'line', 'accent'] : ['on-accent', 'mute-inv', 'on-accent'];
      const bars = weights.map((wgt, i) => `<div style="${st({ flex: wgt, background: color(tones[i % 3]) })}"></div>`).join('');
      parts.push(`<div data-role="device" style="${st({ position: 'absolute', top: px(gTop), left: v('margin'), right: v('margin'), display: 'flex', height: px(p.height), 'z-index': 1 })}">${bars}</div>`);
    } else if (dev === 'effortCurve') {
      const p = k.effortCurve;
      const curve = ground === 'white' ? color('accent') : color('on-accent');
      parts.push(wrap(`<line x1="0" y1="${p.plotBottom}" x2="${safeW}" y2="${p.plotBottom}" stroke="${stroke}" stroke-width="${p.axisStroke}"></line><line x1="0" y1="${p.plotBottom}" x2="0" y2="0" stroke="${stroke}" stroke-width="${p.axisStroke}"></line><path d="${p.path}" fill="none" stroke="${curve}" stroke-width="${p.curveStroke}"></path>`, gTop, p.height));
    } else if (dev === 'effortDots') {
      const p = k.effortDots, filled = (c.deviceData && c.deviceData.filled) !== undefined ? c.deviceData.filled : 7;
      const fillTone = ground === 'white' ? color('accent') : color('on-accent');
      const emptyTone = ground === 'white' ? color('line') : color('mute-inv');
      let dots = '';
      for (let i = 0; i < p.total; i++) {
        const cx = p.first + i * p.pitch;
        dots += i < filled ? `<circle cx="${cx}" cy="${p.height / 2}" r="${p.radius}" fill="${fillTone}"></circle>` : `<circle cx="${cx}" cy="${p.height / 2}" r="${p.radius}" fill="none" stroke="${emptyTone}" stroke-width="${p.stroke}"></circle>`;
      }
      parts.push(wrap(dots, gTop, p.height));
    }
    return parts.join('\n');
  }
  return '';
}

// -------------------------------------------------------------- compose ---
// Returns { html, resolved } or throws with .blocks describing why.
async function composeCover(brief, ctx, page, buildPage) {
  const { tokens, cutouts } = ctx;
  const c = brief.cover;
  const ground = c.ground;
  const g = groundRoles(ground);
  const inkRole = g.ink;
  const align = c.align || (c.mode === 'number' ? 'centre' : 'left');
  const blocks = [];

  // Mark first so the fit loop can measure against it. The kicker, if any, is
  // no longer fixed chrome: its top depends on the headline layout resolved
  // below, so it is placed and checked afterwards (cover-grammar KICKER).
  const chrome = coverMark(ground);
  const canvasStyle = st({ background: g.bg });
  await ctx.show(page, buildPage({ slideIndex: 1, slideType: 'cover', canvasInner: chrome, canvasStyle }));
  const chromeRects = await page.evaluate(() => [...document.querySelectorAll('[data-role="mark"]')].map((el) => {
    const b = document.querySelector('[data-role="canvas"]').getBoundingClientRect(); const r = el.getBoundingClientRect();
    return { role: el.dataset.role, rect: { x: r.left - b.left, y: r.top - b.top, w: r.width, h: r.height } };
  }));

  const fit = await fitHeadline(page, tokens, brief, inkRole);
  if (!fit.step) {
    const err = new Error('headline does not fit the 888 measure at any size step');
    err.blocks = [{ rule: 'headline-fit', detail: JSON.stringify(fit.attempts) }];
    throw err;
  }
  const lastLine = fit.lines.length - 1;
  const hasFigure = c.subject === 'full-figure' || c.subject === 'detail';

  // Aside / payoff sizing.
  let aside = null;
  if (c.aside) {
    const [m] = await page.evaluate((items) => window.__pv.measure(items), [{ text: c.aside, style: type.aside() }]);
    if (m.w > tokens.safe.width) blocks.push({ rule: 'aside-fit', detail: `aside measures ${Math.round(m.w)}px, over the ${tokens.safe.width}px measure; aside is one line at lead` });
    aside = { text: c.aside, w: m.w, h: m.h };
  }
  let payoff = null;
  if (c.payoff) {
    let step = 'subtitle';
    while (step) {
      const [m] = await page.evaluate((items) => window.__pv.measure(items), [{ text: c.payoff, style: type.displaySemi(step, { 'letter-spacing': v('track-statement'), 'line-height': metrics.leading.payoff }) }]);
      if (m.w <= tokens.safe.width) { payoff = { text: c.payoff, step, h: m.h }; break; }
      step = tokens.stepDown(step);
    }
    if (!payoff) blocks.push({ rule: 'payoff-fit', detail: 'payoff line does not fit at any step' });
  }
  if (blocks.length) { const err = new Error('cover copy does not fit'); err.blocks = blocks; throw err; }

  const tops = [];
  const minTop = Math.max(...chromeRects.map((r) => r.rect.y + r.rect.h));
  const maxTop = tokens.safe.y + tokens.safe.height - fit.blockH - (aside ? metrics.cover.asideGap + aside.h : 0);
  for (let t = Math.ceil(minTop / RULES.layoutGridStep) * RULES.layoutGridStep; t <= maxTop; t += RULES.layoutGridStep) tops.push(t);

  let resolved = { mode: c.mode, subject: c.subject, ground, align, sizeStep: fit.step, sizePx: fit.stepPx, fitAttempts: fit.attempts, lines: [], figure: null, position: null, device: c.device || null };
  let layout = null;

  if (!hasFigure) {
    // Type-led / conceptual: headline top from brief, device default, or centred in the safe area.
    let top = c.layout && c.layout.headlineTop !== undefined ? c.layout.headlineTop : null;
    if (top === null && c.subject === 'conceptual' && c.device) top = metrics.cover.concept[c.device].headlineTop;
    if (top === null) top = Math.round((tokens.canvas.height - fit.blockH) / 2);
    top = Math.min(Math.max(top, minTop), maxTop);
    layout = { top, zBehind: fit.lines.map(() => false), figure: null, cutout: null };
  } else {
    // Figure covers: choose cutout, then search placements.
    const excluded = ctx.history.slice(-ctx.rules.CUTOUT_WINDOW).map((r) => r.cutout).filter(Boolean);
    const fig = c.figure || {};
    let candidates;
    if (fig.cutout) {
      const chosen = cutouts.byId.get(fig.cutout);
      if (!chosen) throw Object.assign(new Error(`unknown cutout ${fig.cutout}`), { blocks: [{ rule: 'cutout', detail: fig.cutout }] });
      const [scored] = cut.selectCandidates(cutouts, { subject: c.subject, ground, exclude: excluded }).filter((s) => s.cutout.id === fig.cutout);
      if (!scored.eligible) throw Object.assign(new Error(`cutout ${fig.cutout} is not eligible: ${scored.reasons.join('; ')}`), { blocks: scored.reasons.map((r) => ({ rule: 'cutout-eligibility', detail: r })) });
      candidates = [scored];
    } else {
      candidates = cut.selectCandidates(cutouts, { subject: c.subject, ground, hints: { energy: fig.energy, faces: fig.faces }, exclude: excluded }).filter((s) => s.eligible && s.autoSkip.length === 0);
      if (!candidates.length) throw Object.assign(new Error('no eligible cutout'), { blocks: [{ rule: 'cutout-selection', detail: `no ${c.subject} cutout allowed on ${ground} outside the rotation window` }] });
    }
    const tried = [];
    const explicitFront = !!(c.layout && Array.isArray(c.layout.front));
    let pixelBudget = RULES.pixelChecksMax;
    for (const cand of candidates) {
      if (layout) break;
      const cutout = cand.cutout;
      const dataUri = cutouts.dataUri(cutout);
      // Load the figure once to read its edge alpha and to run occlusion checks against it.
      const probeHtml = chrome + figureHtml(cutout, { x: 0, y: 0, scale: 1, mirror: false }, dataUri) +
        headlineHtml(tokens, fit, c.mode, align, 0, fit.lines.map(() => true), inkRole);
      await ctx.show(page, buildPage({ slideIndex: 1, slideType: 'cover', canvasInner: probeHtml, canvasStyle }));
      const edgeStats = await page.evaluate(() => window.__pv.edgeAlpha(document.querySelector('[data-role="figure"]')));
      const sliced = slicedEdges(cutout, edgeStats, fig.slicedEdges);
      const facing = horizontalFacing(cutout);
      const placements = figureCandidates(tokens, cutout, fig, sliced.edges, align, c.subject);
      const headlineCentreX = align === 'right' ? tokens.canvas.width - tokens.margin - Math.max(...fit.widths) / 2
        : align === 'centre' ? tokens.canvas.width / 2 : tokens.margin + Math.max(...fit.widths) / 2;

      // Pass 1: rect checks for every placement x headline top. Lines that hit a
      // dense zone or the chrome move in front (fix order step 3) and count as forced.
      const pool = [];
      for (const p of placements) {
        const box = cut.figureBox(cutout, p);
        let mirror = fig.mirror;
        if (mirror === undefined) {
          if (facing) { const toward = headlineCentreX < box.x + box.w / 2 ? 'left' : 'right'; mirror = facing !== toward; } else mirror = false;
        }
        const place = { ...p, mirror };
        const topList = c.layout && c.layout.headlineTop !== undefined ? [c.layout.headlineTop] : orderTops(tops, minTop, box, fit.blockH);
        topList.forEach((top, rank) => {
          const zBehind = fit.lines.map((_, i) => (explicitFront ? !c.layout.front.includes(i) : true));
          let forced = 0, zc = null;
          for (let round = 0; round <= fit.lines.length; round++) {
            zc = zoneChecks(tokens, fit, align, top, zBehind, cutout, place, chromeRects);
            if (zc.ok) break;
            const failing = new Set(zc.problems.map((m) => +(m.match(/^line (\d+)/) || [])[1]).filter((n) => !Number.isNaN(n)));
            const movable = [...failing].filter((i) => zBehind[i]);
            if (!movable.length || explicitFront) { zc = null; break; }
            movable.forEach((i) => { zBehind[i] = false; forced++; });
          }
          if (!zc) { if (tried.length < 40) tried.push({ cutout: cutout.id, place, top, stage: 'zones' }); return; }
          pool.push({ place, box, top, zBehind, forced, rank, typeSpaceShare: zc.typeSpaceShare, zc });
        });
      }
      // Fewest lines forced in front, then native scale, then type-space share, then the preferred top.
      pool.sort((x, y) => x.forced - y.forced || y.place.scale - x.place.scale || y.typeSpaceShare - x.typeSpaceShare || x.rank - y.rank);

      const runPixels = async (cand2, zBehind) => {
        const overlaps = fit.lines.some((_, i) => zBehind[i] && cut.intersection(lineRect(tokens, fit, align, cand2.top, i), cand2.box));
        if (!overlaps) return { occ: { lines: [] }, problems: [] };
        pixelBudget--;
        await page.evaluate(({ place: pl, lines }) => {
          const img = document.querySelector('[data-role="figure"]');
          img.style.left = pl.x + 'px'; img.style.top = pl.y + 'px'; img.style.width = pl.w + 'px'; img.style.height = pl.h + 'px';
          img.style.transform = pl.mirror ? 'scaleX(-1)' : 'none';
          lines.forEach((l) => { const el = document.querySelector(`[data-line="${l.i}"]`); el.style.top = l.top + 'px'; el.style.zIndex = l.z; });
        }, { place: { x: cand2.place.x, y: cand2.place.y, w: Math.round(cand2.box.w), h: Math.round(cand2.box.h), mirror: cand2.place.mirror }, lines: fit.lines.map((_, i) => ({ i, top: Math.round(cand2.top + i * fit.lineH), z: zBehind[i] ? 1 : 3 })) });
        const occ = await page.evaluate((opts) => window.__pv.occlusion('[data-role="headline-line"]', '[data-role="figure"]', opts), { inkThreshold: RULES.inkThreshold, figureThreshold: RULES.figureThreshold });
        return { occ, problems: occlusionProblems(occ, lastLine) };
      };
      const accept = (cand2, zBehind, occ) => { layout = { top: cand2.top, zBehind, figure: cand2.place, cutout, sliced, zone: cand2.zc, occlusion: occ, box: cand2.box }; };

      // Pass 2a: pixel occlusion as laid out. Pass 2b: the fix order, moving only failing lines in front.
      const deferred = [];
      for (const cand2 of pool) {
        if (pixelBudget <= 0) break;
        const { occ, problems } = await runPixels(cand2, cand2.zBehind);
        if (!problems.length) { accept(cand2, cand2.zBehind, occ); break; }
        deferred.push({ cand2, problems });
      }
      if (!layout && !explicitFront) {
        for (const { cand2, problems: first } of deferred) {
          if (pixelBudget <= 0) break;
          const zBehind = cand2.zBehind.slice();
          let problems = first;
          for (let round = 0; round < fit.lines.length && problems.length; round++) {
            new Set(problems.map((q) => q.line)).forEach((i) => { zBehind[i] = false; });
            const r = await runPixels(cand2, zBehind);
            problems = r.problems;
            if (!problems.length) { accept(cand2, zBehind, r.occ); break; }
          }
          if (layout) break;
        }
      }
      if (!layout && deferred.length && tried.length < 40) tried.push(...deferred.slice(0, 6).map((d) => ({ cutout: cutout.id, place: d.cand2.place, top: d.cand2.top, stage: 'occlusion', problems: d.problems.slice(0, 4) })));
    }
    if (!layout) {
      const err = new Error('no cover layout satisfies the occlusion and zone rules');
      err.blocks = [{ rule: 'cover-layout', detail: `tried ${tried.length} placements`, tried: tried.slice(0, 12) }];
      throw err;
    }
    resolved.figure = { id: layout.cutout.id, x: layout.figure.x, y: layout.figure.y, scale: layout.figure.scale, mirror: layout.figure.mirror, width: Math.round(layout.box.w), height: Math.round(layout.box.h), anchor: layout.figure.anchor, slicedEdges: layout.sliced, typeSpaceShare: layout.zone.typeSpaceShare, behindOverlapPx: Math.round(layout.zone.behindOverlap) };
    resolved.position = positionLabel(tokens, layout.box);
    resolved.occlusion = layout.occlusion.lines.map((l) => ({ line: l.index, front: l.front, maxCoverage: Math.max(0, ...l.words.flatMap((w) => w.glyphs.map((g) => g.coverage))) }));
  }

  // Kicker: optional, always a chip, placed against the now-resolved headline
  // block rather than a fixed corner (cover-grammar KICKER). Preferred above
  // the headline (headline-top - chip-height - gap), else below
  // (headline-bottom + gap); dropped rather than moving the headline if
  // neither position clears the figure, the mark or the safe area.
  resolved.kicker = null;
  if (c.kicker) {
    const k = metrics.cover;
    const [km] = await page.evaluate((items) => window.__pv.measure(items), [{ text: c.kicker, style: type.data({ 'line-height': k.kickerLineHeight }) }]);
    const chipH = Math.ceil(km.h) + k.kickerPadY * 2;
    const chipW = Math.ceil(km.w) + k.kickerPadX * 2;
    const chipRect = (top) => ({ x: tokens.margin, y: top, w: chipW, h: chipH });
    const fitsSafe = (top) => top >= tokens.safe.y && top + chipH <= tokens.safe.y + tokens.safe.height;
    const clear = (top) => (!layout.box || !cut.intersects(chipRect(top), layout.box)) && !chromeRects.some((r) => cut.intersects(chipRect(top), r.rect));
    const above = layout.top - chipH - k.kickerGap;
    const below = layout.top + fit.blockH + k.kickerGap;
    const chosen = [above, below].find((top) => fitsSafe(top) && clear(top));
    if (chosen !== undefined) resolved.kicker = { text: c.kicker, top: Math.round(chosen) };
  }

  // Final HTML.
  const top = layout.top;
  const parts = [chrome];
  const extraStyle = {};
  if (c.subject === 'type-led' && c.device === 'scale-break') {
    // Last line as a shout at the next-larger step that fits; measured, never assumed.
    extraStyle[lastLine] = { 'font-weight': v('weight-display-bold'), 'letter-spacing': v('track-shout') };
  }
  if (layout.figure) parts.push(figureHtml(layout.cutout, layout.figure, cutouts.dataUri(layout.cutout)));
  parts.push(headlineHtml(tokens, fit, c.mode, align, top, layout.zBehind, inkRole, extraStyle));
  if (resolved.kicker) parts.push(coverKicker(resolved.kicker.text, resolved.kicker.top));
  if (c.signal === 'block') parts.push(signalBlockHtml(tokens, lineRect(tokens, fit, align, top, lastLine)));
  parts.push(deviceHtml(tokens, brief, fit, top, inkRole, ground));
  if (aside) parts.push(asideHtml(tokens, aside.text, Math.round(top + fit.blockH + metrics.cover.asideGap), inkRole, align));
  if (payoff) parts.push(payoffHtml(tokens, payoff.text, Math.round(tokens.safe.y + tokens.safe.height - metrics.cover.typeLed.payoffBottomInset - payoff.h), inkRole, payoff.step));
  resolved.lines = fit.lines.map((text, i) => ({ text, top: Math.round(top + i * fit.lineH), width: Math.round(fit.widths[i]), front: !layout.zBehind[i] }));
  resolved.headlineTop = top;
  if (aside) resolved.aside = { text: aside.text, top: Math.round(top + fit.blockH + metrics.cover.asideGap) };
  if (payoff) resolved.payoff = { text: payoff.text, step: payoff.step };
  const html = buildPage({ slideIndex: 1, slideType: 'cover', canvasInner: parts.join('\n'), canvasStyle });
  return { html, resolved };
}

// Headline tops ordered by distance from the centre of the free band above the
// figure (or below it when the figure hangs from the top).
function orderTops(tops, minTop, box, blockH) {
  const freeTop = minTop, freeBottom = box.y > minTop ? box.y : Infinity;
  const ideal = freeBottom === Infinity ? minTop : (freeTop + freeBottom) / 2 - blockH / 2;
  return tops.slice().sort((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal) || a - b);
}

module.exports = { composeCover, MODE, numberStart, positionLabel };
