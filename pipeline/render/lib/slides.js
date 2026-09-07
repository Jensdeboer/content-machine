'use strict';
// Body slide components, ported one-to-one from design/04-slides/*.dc.html.
// Each function returns the inner HTML of the canvas; slideShell wraps it in
// the header, footer and ground the templates share.
const { metrics, esc, px, v, color, size, space, st, type, mark, slideHeader, slideFooter } = require('./html');

const SWIPE_LABEL = 'SWIPE →'; // 05-chrome/footer.dc.html
const RULE = (tone) => `${px(metrics.rule.slide)} solid ${color(tone)}`;

// Headline text may carry one [[accented]] phrase and \n line breaks.
function richText(text) {
  const parts = String(text).split(/(\[\[.*?\]\])/g);
  return parts.map((p) => {
    const m = p.match(/^\[\[(.*)\]\]$/);
    if (m) return `<span data-accent style="${st({ color: color('accent-ink') })}">${esc(m[1])}</span>`;
    return esc(p).replace(/\n/g, '<br>');
  }).join('');
}

const kicker = (text) => `<span data-role="label" style="${type.data({ color: color('mute') })}">${esc(text)}</span>`;
const headline = (text, step, extra = {}) =>
  `<h3 data-role="headline" style="margin:0;${type.displaySemi(step, { 'line-height': v('lead-headline'), 'letter-spacing': v('track-headline'), color: color('ink'), ...extra })}">${richText(text)}</h3>`;
const body = (text, step = 'body-lg', extra = {}) =>
  `<p data-role="body" style="margin:0;max-width:${px(metrics.copyMaxWidth)};${type.body(step, { color: color('ink-soft'), ...extra })}">${richText(text)}</p>`;
const valueRow = (value, unit, step, gap = 24) =>
  `<div data-role="value" style="${st({ display: 'flex', 'align-items': 'baseline', gap: space(gap), 'flex-wrap': 'wrap' })}">` +
  `<span style="${type.displayBold(step, { 'line-height': metrics.leading.hero, 'letter-spacing': v('track-statement'), color: color('accent-ink') })}">${esc(value)}</span>` +
  (unit ? `<span style="${type.data({ 'font-size': size('body'), 'letter-spacing': v('track-wide'), color: color('accent-ink') })}">${esc(unit)}</span>` : '') + `</div>`;

const centre = (gap, inner, extra = {}) =>
  `<div data-role="content" style="${st({ flex: 1, display: 'flex', 'flex-direction': 'column', 'justify-content': 'center', gap: space(gap), ...extra })}">${inner}</div>`;

function slideShell({ series, index, total, ground = 'white', inner, footer }) {
  const bg = ground === 'accent' ? color('accent') : color('ground');
  const canvasStyle = st({ padding: v('margin'), background: bg, display: 'flex', 'flex-direction': 'column' });
  const canvasInner = slideHeader(series, index, total, ground) + inner + (footer ?? slideFooter(ground, SWIPE_LABEL));
  return { canvasStyle, canvasInner };
}

const components = {
  stat(d) {
    const step = d.valueStep || 'xl';
    return centre(40,
      (d.label ? kicker(d.label) : '') +
      valueRow(d.value, d.unit, step, step === 'xl' ? 24 : 16) +
      headline(d.headline, 'title') +
      (d.body ? body(d.body) : ''));
  },

  explainer(d) {
    return centre(56, headline(d.headline, 's') + body(d.body));
  },

  'numeral-point'(d) {
    if (d.items) {
      const rows = d.items.map((it, i) =>
        `<div style="${st({ display: 'flex', gap: space(40), 'align-items': 'flex-start', padding: `${space(40)} 0`, 'border-top': RULE(i === 0 ? 'ink' : 'line') })}">` +
        `<span data-role="numeral" style="${type.displayBold('s', { 'line-height': metrics.leading.hero, 'letter-spacing': v('track-statement'), color: color('accent-ink') })}">${esc(it.numeral)}</span>` +
        `<div style="${st({ display: 'flex', 'flex-direction': 'column', gap: space(16) })}">${headline(it.headline, 'subtitle')}${it.body ? body(it.body) : ''}</div></div>`).join('');
      return centre(0, rows);
    }
    return centre(48,
      `<span data-role="numeral" style="${type.displayBold('m', { 'line-height': metrics.leading.hero, 'letter-spacing': v('track-statement'), color: color('accent-ink') })}">${esc(d.numeral)}</span>` +
      headline(d.headline, 's') + (d.body ? body(d.body) : ''));
  },

  checklist(d) {
    if (d.rows) {
      const rows = d.rows.map((r) =>
        `<div style="${st({ display: 'flex', gap: space(32) })}">` +
        `<span style="${type.data({ 'line-height': metrics.leading.monoRow, color: color('accent-ink'), width: px(metrics.checklist.labelColumn), flex: 'none' })}">${esc(r.label)}</span>` +
        `<span style="${type.body('body-lg', { color: color('ink-soft') })}">${richText(r.text)}</span></div>`).join('');
      return centre(56, headline(d.headline, 's') +
        `<div style="${st({ 'border-top': RULE('ink'), 'padding-top': space(40), display: 'flex', 'flex-direction': 'column', gap: space(24) })}">${rows}</div>`);
    }
    const items = d.items.map((it) =>
      `<div style="${st({ display: 'flex', gap: space(32), 'align-items': 'flex-start', padding: `${space(24)} 0`, 'border-top': RULE('line') })}">` +
      `<span style="${st({ width: px(metrics.checklist.marker), height: px(metrics.checklist.marker), background: color('accent'), flex: 'none', 'margin-top': px(metrics.checklist.markerOffset) })}"></span>` +
      `<span style="${type.body('body-lg', { 'line-height': metrics.leading.checklistItem, color: color('ink-soft') })}">${richText(it)}</span></div>`).join('');
    return centre(48, (d.label ? kicker(d.label) : '') + headline(d.headline, 's') +
      `<div style="display:flex;flex-direction:column">${items}<div style="${st({ 'border-top': RULE('line') })}"></div></div>`);
  },

  'pull-statement'(d) {
    if (d.ground === 'accent') {
      const a = metrics.pullArrow;
      const w = 888; // svg viewBox width equals the safe width; drawn at 100% of the content column
      return centre(56,
        headline(d.headline, 'm', { color: color('on-accent') }) +
        `<svg viewBox="0 0 ${w} ${a.height}" width="100%" height="${a.height}" style="color:${color('on-accent')}"><line x1="0" y1="${a.height / 2}" x2="${w - a.headWidth + 2}" y2="${a.height / 2}" stroke="currentColor" stroke-width="${a.stroke}"></line><polygon points="${w - a.headWidth},2 ${w},${a.height / 2} ${w - a.headWidth},${a.height - 2}" fill="currentColor"></polygon></svg>`);
    }
    return centre(48,
      `<div style="${st({ 'border-top': RULE('ink') })}"></div>` +
      (d.label ? kicker(d.label) : '') +
      headline(d.headline, 's') +
      (d.aside ? `<p data-role="aside" style="margin:0;max-width:${px(metrics.copyMaxWidth)};${type.aside({ color: color('ink-soft') })}">${esc(d.aside)}</p>` : '') +
      `<div style="${st({ 'border-top': RULE('ink') })}"></div>`);
  },

  compare(d) {
    const col = (c, side) => {
      const tone = side === 'left' ? 'ink' : 'accent-ink';
      const labelTone = side === 'left' ? 'mute' : 'accent-ink';
      const pad = side === 'left' ? `${space(40)} ${space(40)} 0 0` : `${space(40)} 0 0 ${space(40)}`;
      let inner = `<span style="${type.data({ 'font-size': size('floor'), color: color(labelTone) })}">${esc(c.label)}</span>`;
      if (c.value !== undefined) inner += valueRow(c.value, c.unit, 'l', 12);
      if (c.headline) inner += `<span style="${type.displaySemi('subtitle', { 'line-height': metrics.leading.compareHeadline, 'letter-spacing': v('track-headline'), color: color(tone) })}">${richText(c.headline)}</span>`;
      if (c.body) inner += body(c.body, 'body');
      return `<div style="${st({ padding: pad, 'border-right': side === 'left' ? RULE('line') : undefined, display: 'flex', 'flex-direction': 'column', gap: space(16) })}">${inner}</div>`;
    };
    return centre(56, (d.label ? kicker(d.label) : '') + headline(d.headline, 's') +
      `<div style="${st({ display: 'grid', 'grid-template-columns': '1fr 1fr', 'border-top': RULE('ink') })}">${col(d.left, 'left')}${col(d.right, 'right')}</div>`);
  },

  'progress-scale'(d) {
    if (d.variant === 'ruler') {
      const t = metrics.tickRuler, w = 888, n = d.ticks || 5, stepX = (w - 2) / (n - 1);
      const lines = [];
      for (let i = 0; i < n; i++) {
        const x = Math.round(i === n - 1 ? w - 2 : i * stepX);
        const major = i % 2 === 0;
        const last = i === n - 1;
        lines.push(`<line x1="${x}" y1="${major ? t.majorPad : t.minorPad}" x2="${x}" y2="${t.height - (major ? t.majorPad : t.minorPad)}" stroke="${color(last ? 'accent' : 'ink')}" stroke-width="${last ? t.accentStroke : t.stroke}"></line>`);
      }
      return centre(56, headline(d.headline, 's') +
        `<svg viewBox="0 0 ${w} ${t.height}" width="100%" height="${t.height}"><line x1="0" y1="${t.height / 2}" x2="${w}" y2="${t.height / 2}" stroke="${color('ink')}" stroke-width="${t.stroke}"></line>${lines.join('')}</svg>` +
        (d.caption ? kicker(d.caption) : ''));
    }
    const p = metrics.progressScale;
    const ticks = (d.ticks || []).map((t) => `<span style="${st({ color: t.tone ? color(t.tone === 'accent' ? 'accent-ink' : 'ink') : undefined })}">${esc(t.label)}</span>`).join('');
    return centre(56, headline(d.headline, 's') +
      `<div style="${st({ display: 'flex', 'flex-direction': 'column', gap: space(24) })}">` +
      `<div style="${st({ position: 'relative', height: px(p.barHeight), background: color('line') })}">` +
      `<div style="${st({ position: 'absolute', left: `${d.fill.from}%`, width: `${d.fill.to - d.fill.from}%`, top: 0, bottom: 0, background: color('accent') })}"></div>` +
      (d.marker !== undefined ? `<div style="${st({ position: 'absolute', left: `${d.marker}%`, top: px(p.markerOffset), width: px(p.markerWidth), height: px(p.markerHeight), background: color('ink') })}"></div>` : '') +
      `</div><div style="${st({ display: 'flex', 'justify-content': 'space-between' })};${type.data({ color: color('mute') })}">${ticks}</div></div>` +
      (d.body ? body(d.body) : ''));
  },

  chart(d) {
    const c = metrics.chart, w = 888;
    const numeral = d.numeral ? `<span data-role="numeral" style="${type.displayBold('m', { 'line-height': metrics.leading.hero, 'letter-spacing': v('track-statement'), color: color('accent-ink') })}">${esc(d.numeral)}</span>` : '';
    if (d.variant === 'two-series') {
      const t = c.twoSeries, pb = t.plotBottom;
      const map = (pt) => `${(pt[0] * w).toFixed(1)},${(pb - pt[1] * pb).toFixed(1)}`;
      const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => `<line x1="${f * w}" y1="0" x2="${f * w}" y2="${pb}"></line>`).join('');
      const planned = d.planned.map(map).join(' ');
      const actual = d.actual.map(map).join(' ');
      const first = d.actual[0], last = d.actual[d.actual.length - 1];
      return centre(40, numeral + headline(d.headline, 's') +
        `<svg viewBox="0 0 ${w} ${t.height}" width="100%" height="${t.height}"><g stroke="${color('line')}" stroke-width="${t.gridStroke}">${grid}</g>` +
        `<line x1="0" y1="${pb}" x2="${w}" y2="${pb}" stroke="${color('ink')}" stroke-width="${t.axisStroke}"></line>` +
        `<polyline points="${planned}" fill="none" stroke="${color('ink')}" stroke-width="${t.plannedStroke}" stroke-dasharray="${t.plannedDash}"></polyline>` +
        `<polyline points="${actual}" fill="none" stroke="${color('accent')}" stroke-width="${t.actualStroke}"></polyline>` +
        `<circle cx="${first[0] * w}" cy="${pb - first[1] * pb}" r="${t.dotRadius}" fill="${color('accent')}"></circle><circle cx="${last[0] * w}" cy="${pb - last[1] * pb}" r="${t.dotRadius}" fill="${color('accent')}"></circle></svg>` +
        (d.legend ? kicker(d.legend) : ''));
    }
    const annotated = !!(d.reference || d.xLabel);
    const height = annotated ? c.annotatedHeight : c.height, pb = c.plotBottom;
    const pts = d.points.map((pt) => [pt[0] * w, pb - pt[1] * pb]);
    // Smooth path through the points (Catmull-Rom to Bezier), matching the template's single drawn curve.
    let path = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      path += ` C ${c1[0].toFixed(1)} ${c1[1].toFixed(1)}, ${c2[0].toFixed(1)} ${c2[1].toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
    }
    let extra = '';
    if (d.reference) {
      const rx = d.reference.x * w;
      const ry = d.reference.y !== undefined ? pb - d.reference.y * pb : pb / 2;
      extra += `<line x1="${rx}" y1="0" x2="${rx}" y2="${pb}" stroke="${color('line')}" stroke-width="${c.refStroke}" stroke-dasharray="${c.refDash}"></line><circle cx="${rx}" cy="${ry}" r="${c.dotRadius}" fill="${color('ink')}"></circle>`;
      if (d.reference.label) extra += `<text x="${rx + 20}" y="60" font-family="${v('font-data')}" font-size="${c.labelSize}" fill="${color('accent')}" letter-spacing="2">${esc(d.reference.label)}</text>`;
    }
    if (d.xLabel) extra += `<text x="0" y="${c.axisLabelY}" font-family="${v('font-data')}" font-size="${c.axisLabelSize}" fill="${color('mute')}" letter-spacing="2">${esc(d.xLabel)}</text>`;
    return centre(40, numeral + headline(d.headline, 's') +
      `<svg viewBox="0 0 ${w} ${height}" width="100%" height="${height}"><line x1="0" y1="${pb}" x2="${w}" y2="${pb}" stroke="${color('ink')}" stroke-width="${c.axisStroke}"></line><line x1="0" y1="${pb}" x2="0" y2="0" stroke="${color('ink')}" stroke-width="${c.axisStroke}"></line><path d="${path}" fill="none" stroke="${color('accent')}" stroke-width="${c.lineStroke}"></path>${extra}</svg>` +
      (d.body ? body(d.body) : ''));
  },

  'metrics-table'(d) {
    const n = d.cells.length;
    const cells = d.cells.map((cell, i) => {
      const last = i === n - 1;
      const inner = `<p style="margin:0 0 ${space(8)};${type.data({ 'font-size': size('floor'), color: color('mute') })}">${esc(cell.label)}</p>` +
        (cell.phrase !== undefined
          ? `<p style="margin:0;${type.displaySemi('body-lg', { 'line-height': metrics.leading.metricsPhrase, 'letter-spacing': v('track-headline') })}">${esc(cell.phrase)}</p>`
          : `<p style="margin:0;${type.displayBold('title', { 'line-height': metrics.leading.hero, 'letter-spacing': v('track-statement') })}">${esc(cell.value)}<span style="${type.data({ color: color('accent-ink') })}">${esc(cell.unit || '')}</span></p>`);
      return `<div style="${st({ padding: `${space(32)} 0 ${space(32)} ${i === 0 ? 0 : space(32)}`, 'border-right': last ? undefined : RULE('line') })}">${inner}</div>`;
    }).join('');
    return centre(56, headline(d.headline, 's') +
      `<div style="${st({ display: 'grid', 'grid-template-columns': Array(n).fill('1fr').join(' '), 'border-top': RULE('ink') })}">${cells}</div>`);
  },

  'figure-panel'(d, ctx) {
    const fp = metrics.figurePanel[d.variant || 'narrow'];
    const cut = ctx.cutouts.byId.get(d.cutout);
    if (!cut) throw new Error(`figure-panel: unknown cutout ${d.cutout}`);
    // A cutout is never scaled beyond its native pixel size.
    const imgH = Math.min(fp.imageHeight, cut.height);
    const text = (d.label ? kicker(d.label) : '') + headline(d.headline, d.variant === 'wide' ? 's' : 'title') + (d.body ? body(d.body) : '');
    return `<div data-role="content" style="${st({ flex: 1, display: 'grid', 'grid-template-columns': `minmax(0,1fr) ${px(fp.width)}`, gap: space(48), 'align-items': d.variant === 'wide' ? 'stretch' : 'center' })}">` +
      `<div style="${st({ display: 'flex', 'flex-direction': 'column', 'justify-content': 'center', gap: space(40) })}">${text}</div>` +
      `<div style="${st({ background: color('ground-alt'), height: px(fp.height), position: 'relative', overflow: 'hidden' })}"><img data-cutout="${esc(cut.id)}" src="${ctx.cutouts.dataUri(cut)}" style="${st({ position: 'absolute', bottom: 0, left: '50%', transform: 'translateX(-50%)', height: px(imgH) })}"></div></div>`;
  },

  cta(d) {
    const ask = Array.isArray(d.ask) ? d.ask.map(esc).join('<br>') : esc(d.ask);
    const inner = `<div data-role="content" style="${st({ flex: 1, display: 'flex', 'flex-direction': 'column', 'justify-content': 'center', 'align-items': 'center', gap: space(56), 'text-align': 'center' })}">` +
      mark(metrics.mark.cta, { arrow: 'on-accent', stem: 'mute-inv' }) +
      `<div style="${st({ display: 'flex', 'flex-direction': 'column', gap: space(16) })}">` +
      `<span style="${type.displaySemi('s', { 'line-height': metrics.leading.hero, 'letter-spacing': v('track-statement'), color: color('on-accent') })}">${esc(d.wordmark)}</span>` +
      `<span style="${type.data({ 'font-size': size('body'), 'letter-spacing': v('track-wide'), color: color('on-accent') })}">${esc(d.tagline)}</span></div></div>`;
    // Footer row: one line of source credit and the ask on the left, handle right.
    const footer = `<div data-role="cta-footer" style="${st({ display: 'flex', 'justify-content': 'space-between', 'align-items': 'flex-end', 'min-height': v('footer-height') })}">` +
      `<div style="${st({ display: 'flex', 'flex-direction': 'column', gap: space(12), 'max-width': px(metrics.ctaAskMaxWidth) })}">` +
      (d.credit ? `<span data-role="credit" style="${type.data({ color: color('on-accent') })}">${esc(d.credit)}</span>` : '') +
      `<p data-role="ask" style="margin:0;${type.body('body-lg', { 'line-height': metrics.leading.ctaAsk, color: color('on-accent') })}">${ask}</p></div>` +
      `<span data-role="handle" style="${type.data({ color: color('on-accent') })}">${esc(d.handle)}</span></div>`;
    return { inner, footer };
  },
};

// Build one body slide. Returns { canvasStyle, canvasInner }.
function buildSlide(slide, { series, index, total, ctx }) {
  const fn = components[slide.type];
  if (!fn) throw new Error(`unknown slide type "${slide.type}"`);
  const out = fn(slide, ctx);
  const ground = slide.type === 'cta' || slide.ground === 'accent' ? 'accent' : 'white';
  if (typeof out === 'string') return slideShell({ series, index, total, ground, inner: out });
  return slideShell({ series, index, total, ground, inner: out.inner, footer: out.footer });
}

module.exports = { buildSlide, components, richText };
