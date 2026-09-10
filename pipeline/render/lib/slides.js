'use strict';
// Body slide components, ported one-to-one from design/04-slides/*.dc.html.
// Each function returns the inner HTML of the canvas; slideShell wraps it in
// the header, footer and ground the templates share.
//
// Every caption-bearing part of a component is built through the helpers in
// lib/treatments.js rather than inline: the deck's caption treatment decides
// colour role, weight, size step, emphasis style and anchor, and a component
// never hard-codes those. Roles a component does hard-code (rules, markers,
// chart ink) go through h.tone() so an inverted treatment does not paint navy
// on navy. Geometry stays here and in component-metrics.json.
const { metrics, esc, px, v, color, size, space, st, type, mark, slideFooter } = require('./html');

const SWIPE_LABEL = 'SWIPE →'; // 05-chrome/footer.dc.html
const RULE = (tone) => `${px(metrics.rule.slide)} solid ${color(tone)}`;
const gapVal = (n) => (n ? space(n) : '0');

// cta's constant like / save / send row (design/HANDOFF.md v0.7, 24-unit viewBox paths).
const CTA_ICONS = [
  ['M12 20.5s-7.5-4.6-7.5-10A4.2 4.2 0 0 1 12 8a4.2 4.2 0 0 1 7.5 2.5c0 5.4-7.5 10-7.5 10z'], // like
  ['M6 3.5h12v17l-6-4-6 4z'], // save
  ['M21 3 3 10.5l7.5 2.5L13 21z', 'M21 3 10.5 13'], // send
];

// The hero number row. Its ink follows the treatment's ground, so the figure
// stays visible when the slide inverts.
const valueRow = (h, value, unit, step, gap = 24) =>
  `<div data-role="value" style="${st({ display: 'flex', 'align-items': 'baseline', gap: space(gap), 'flex-wrap': 'wrap' })}">` +
  `<span style="${type.displayBold(h.valueStep(step), { 'line-height': metrics.leading.hero, 'letter-spacing': v('track-statement'), color: color(h.tone('accent-ink')) })}">${esc(value)}</span>` +
  (unit ? `<span style="${type.data({ 'font-size': size('body'), 'letter-spacing': v('track-wide'), color: color(h.tone('accent-ink')) })}">${esc(unit)}</span>` : '') + `</div>`;

function slideShell({ ground = 'white', inner, footer }) {
  const bg = ground === 'accent' ? color('accent') : color('ground');
  const canvasStyle = st({ padding: v('margin'), background: bg, display: 'flex', 'flex-direction': 'column' });
  const canvasInner = inner + (footer ?? slideFooter(ground, SWIPE_LABEL));
  return { canvasStyle, canvasInner };
}

const components = {
  stat(d, ctx, h) {
    const step = d.valueStep || 'xl';
    return h.stack(40, {
      wide: true, // hero number
      label: d.label ? h.kicker(d.label) : '',
      main: valueRow(h, d.value, d.unit, step, step === 'xl' ? 24 : 16) +
        h.headline(d.headline, 'title') +
        (d.body ? h.body(d.body) : ''),
    });
  },

  explainer(d, ctx, h) {
    return h.stack(56, { label: d.label ? h.kicker(d.label) : '', main: h.headline(d.headline, 's') + h.body(d.body) });
  },

  'numeral-point'(d, ctx, h) {
    if (d.items) {
      const rows = d.items.map((it, i) =>
        `<div style="${st({ display: 'flex', gap: space(40), 'align-items': 'flex-start', padding: `${space(40)} 0`, 'border-top': RULE(h.tone(i === 0 ? 'ink' : 'line')) })}">` +
        `<span data-role="numeral" style="${type.displayBold('s', { 'line-height': metrics.leading.hero, 'letter-spacing': v('track-statement'), color: color(h.tone('accent-ink')) })}">${esc(it.numeral)}</span>` +
        `<div style="${st({ display: 'flex', 'flex-direction': 'column', gap: space(16) })}">${h.headline(it.headline, 'subtitle')}${it.body ? h.body(it.body) : ''}</div></div>`).join('');
      return h.stack(0, { label: '', main: rows });
    }
    return h.stack(48, {
      label: '',
      main: `<span data-role="numeral" style="${type.displayBold('m', { 'line-height': metrics.leading.hero, 'letter-spacing': v('track-statement'), color: color(h.tone('accent-ink')) })}">${esc(d.numeral)}</span>` +
        h.headline(d.headline, 's') + (d.body ? h.body(d.body) : ''),
    });
  },

  checklist(d, ctx, h) {
    if (d.rows) {
      const rows = d.rows.map((r) =>
        `<div style="${st({ display: 'flex', gap: space(32) })}">` +
        `<span style="${type.data({ 'line-height': metrics.leading.monoRow, color: color(h.tone('accent-ink')), width: px(metrics.checklist.labelColumn), flex: 'none' })}">${esc(r.label)}</span>` +
        `<span style="${type.body('body-lg', { color: color(h.tone('ink-soft')) })}">${h.richText(r.text)}</span></div>`).join('');
      return h.stack(56, {
        label: '',
        main: h.headline(d.headline, 's') +
          `<div style="${st({ 'border-top': RULE(h.tone('ink')), 'padding-top': space(40), display: 'flex', 'flex-direction': 'column', gap: space(24) })}">${rows}</div>`,
      });
    }
    const items = d.items.map((it) =>
      `<div style="${st({ display: 'flex', gap: space(32), 'align-items': 'flex-start', padding: `${space(24)} 0`, 'border-top': RULE(h.tone('line')) })}">` +
      `<span style="${st({ width: px(metrics.checklist.marker), height: px(metrics.checklist.marker), background: color(h.tone('accent')), flex: 'none', 'margin-top': px(metrics.checklist.markerOffset) })}"></span>` +
      `<span style="${type.body('body-lg', { 'line-height': metrics.leading.checklistItem, color: color(h.tone('ink-soft')) })}">${h.richText(it)}</span></div>`).join('');
    return h.stack(48, {
      label: d.label ? h.kicker(d.label) : '',
      main: h.headline(d.headline, 's') +
        `<div style="display:flex;flex-direction:column">${items}<div style="${st({ 'border-top': RULE(h.tone('line')) })}"></div></div>`,
    });
  },

  'pull-statement'(d, ctx, h) {
    if (d.ground === 'accent') {
      const a = metrics.pullArrow;
      const w = 888; // svg viewBox width equals the safe width; drawn at 100% of the content column
      return h.stack(56, {
        label: '',
        main: h.headline(d.headline, 'm', { color: color('on-accent') }) +
          `<svg viewBox="0 0 ${w} ${a.height}" width="100%" height="${a.height}" style="color:${color('on-accent')}"><line x1="0" y1="${a.height / 2}" x2="${w - a.headWidth + 2}" y2="${a.height / 2}" stroke="currentColor" stroke-width="${a.stroke}"></line><polygon points="${w - a.headWidth},2 ${w},${a.height / 2} ${w - a.headWidth},${a.height - 2}" fill="currentColor"></polygon></svg>`,
      });
    }
    // The kicker stays inside the rule sandwich rather than being handed to
    // stack() as a label: on this component it is part of the device, and a
    // side-label treatment must not lift it out above the top rule.
    return h.stack(48, {
      label: '',
      main: `<div style="${st({ 'border-top': RULE(h.tone('ink')) })}"></div>` +
        (d.label ? h.kicker(d.label) : '') +
        h.headline(d.headline, 's') +
        (d.aside ? `<p data-role="aside" style="margin:0;max-width:${px(metrics.copyMaxWidth)};${type.aside({ color: color(h.tone('ink-soft')) })}">${esc(d.aside)}</p>` : '') +
        `<div style="${st({ 'border-top': RULE(h.tone('ink')) })}"></div>`,
    });
  },

  compare(d, ctx, h) {
    const col = (c, side) => {
      const tone = h.tone(side === 'left' ? 'ink' : 'accent-ink');
      const labelTone = h.tone(side === 'left' ? 'mute' : 'accent-ink');
      const pad = side === 'left' ? `${space(40)} ${space(40)} 0 0` : `${space(40)} 0 0 ${space(40)}`;
      let inner = `<span style="${type.data({ 'font-size': size('floor'), color: color(labelTone) })}">${esc(c.label)}</span>`;
      if (c.value !== undefined) inner += valueRow(h, c.value, c.unit, 'l', 12);
      if (c.headline) inner += `<span style="${type.displaySemi('subtitle', { 'line-height': metrics.leading.compareHeadline, 'letter-spacing': v('track-headline'), color: color(tone) })}">${h.richText(c.headline)}</span>`;
      if (c.body) inner += h.body(c.body, 'body');
      return `<div style="${st({ padding: pad, 'border-right': side === 'left' ? RULE(h.tone('line')) : undefined, display: 'flex', 'flex-direction': 'column', gap: space(16) })}">${inner}</div>`;
    };
    return h.stack(56, {
      wide: true, // two measured columns
      label: d.label ? h.kicker(d.label) : '',
      main: h.headline(d.headline, 's') +
        `<div style="${st({ display: 'grid', 'grid-template-columns': '1fr 1fr', 'border-top': RULE(h.tone('ink')) })}">${col(d.left, 'left')}${col(d.right, 'right')}</div>`,
    });
  },

  'progress-scale'(d, ctx, h) {
    if (d.variant === 'ruler') {
      const t = metrics.tickRuler, w = 888, n = d.ticks || 5, stepX = (w - 2) / (n - 1);
      const lines = [];
      for (let i = 0; i < n; i++) {
        const x = Math.round(i === n - 1 ? w - 2 : i * stepX);
        const major = i % 2 === 0;
        const last = i === n - 1;
        lines.push(`<line x1="${x}" y1="${major ? t.majorPad : t.minorPad}" x2="${x}" y2="${t.height - (major ? t.majorPad : t.minorPad)}" stroke="${color(h.tone(last ? 'accent' : 'ink'))}" stroke-width="${last ? t.accentStroke : t.stroke}"></line>`);
      }
      return h.stack(56, {
        wide: true, // full-measure ruler
        label: d.label ? h.kicker(d.label) : '',
        main: h.headline(d.headline, 's') +
          `<svg viewBox="0 0 ${w} ${t.height}" width="100%" height="${t.height}"><line x1="0" y1="${t.height / 2}" x2="${w}" y2="${t.height / 2}" stroke="${color(h.tone('ink'))}" stroke-width="${t.stroke}"></line>${lines.join('')}</svg>` +
          (d.caption ? h.kicker(d.caption) : ''),
      });
    }
    const p = metrics.progressScale;
    const ticks = (d.ticks || []).map((t) => `<span style="${st({ color: color(h.tone(t.tone === 'accent' ? 'accent-ink' : 'ink')) })}">${esc(t.label)}</span>`).join('');
    return h.stack(56, {
      wide: true, // full-measure bar
      label: d.label ? h.kicker(d.label) : '',
      main: h.headline(d.headline, 's') +
        `<div style="${st({ display: 'flex', 'flex-direction': 'column', gap: space(24) })}">` +
        `<div style="${st({ position: 'relative', height: px(p.barHeight), background: color(h.tone('line')) })}">` +
        `<div style="${st({ position: 'absolute', left: `${d.fill.from}%`, width: `${d.fill.to - d.fill.from}%`, top: 0, bottom: 0, background: color(h.tone('accent')) })}"></div>` +
        (d.marker !== undefined ? `<div style="${st({ position: 'absolute', left: `${d.marker}%`, top: px(p.markerOffset), width: px(p.markerWidth), height: px(p.markerHeight), background: color(h.tone('ink')) })}"></div>` : '') +
        `</div><div style="${st({ display: 'flex', 'justify-content': 'space-between' })};${type.data({ color: color(h.tone('mute')) })}">${ticks}</div></div>` +
        (d.body ? h.body(d.body) : ''),
    });
  },

  chart(d, ctx, h) {
    const c = metrics.chart, w = 888;
    const numeral = d.numeral ? `<span data-role="numeral" style="${type.displayBold('m', { 'line-height': metrics.leading.hero, 'letter-spacing': v('track-statement'), color: color(h.tone('accent-ink')) })}">${esc(d.numeral)}</span>` : '';
    if (d.variant === 'two-series') {
      const t = c.twoSeries, pb = t.plotBottom;
      const map = (pt) => `${(pt[0] * w).toFixed(1)},${(pb - pt[1] * pb).toFixed(1)}`;
      const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => `<line x1="${f * w}" y1="0" x2="${f * w}" y2="${pb}"></line>`).join('');
      const planned = d.planned.map(map).join(' ');
      const actual = d.actual.map(map).join(' ');
      const first = d.actual[0], last = d.actual[d.actual.length - 1];
      return h.stack(40, {
        wide: true, // plotted chart
        label: '',
        main: numeral + h.headline(d.headline, 's') +
          `<svg viewBox="0 0 ${w} ${t.height}" width="100%" height="${t.height}"><g stroke="${color(h.tone('line'))}" stroke-width="${t.gridStroke}">${grid}</g>` +
          `<line x1="0" y1="${pb}" x2="${w}" y2="${pb}" stroke="${color(h.tone('ink'))}" stroke-width="${t.axisStroke}"></line>` +
          `<polyline points="${planned}" fill="none" stroke="${color(h.tone('ink'))}" stroke-width="${t.plannedStroke}" stroke-dasharray="${t.plannedDash}"></polyline>` +
          `<polyline points="${actual}" fill="none" stroke="${color(h.tone('accent'))}" stroke-width="${t.actualStroke}"></polyline>` +
          `<circle cx="${first[0] * w}" cy="${pb - first[1] * pb}" r="${t.dotRadius}" fill="${color(h.tone('accent'))}"></circle><circle cx="${last[0] * w}" cy="${pb - last[1] * pb}" r="${t.dotRadius}" fill="${color(h.tone('accent'))}"></circle></svg>` +
          (d.legend ? h.kicker(d.legend) : ''),
      });
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
      extra += `<line x1="${rx}" y1="0" x2="${rx}" y2="${pb}" stroke="${color(h.tone('line'))}" stroke-width="${c.refStroke}" stroke-dasharray="${c.refDash}"></line><circle cx="${rx}" cy="${ry}" r="${c.dotRadius}" fill="${color(h.tone('ink'))}"></circle>`;
      if (d.reference.label) extra += `<text x="${rx + 20}" y="60" font-family="${v('font-data')}" font-size="${c.labelSize}" fill="${color(h.tone('accent'))}" letter-spacing="2">${esc(d.reference.label)}</text>`;
    }
    if (d.xLabel) extra += `<text x="0" y="${c.axisLabelY}" font-family="${v('font-data')}" font-size="${c.axisLabelSize}" fill="${color(h.tone('mute'))}" letter-spacing="2">${esc(d.xLabel)}</text>`;
    return h.stack(40, {
      wide: true, // plotted chart
      label: '',
      main: numeral + h.headline(d.headline, 's') +
        `<svg viewBox="0 0 ${w} ${height}" width="100%" height="${height}"><line x1="0" y1="${pb}" x2="${w}" y2="${pb}" stroke="${color(h.tone('ink'))}" stroke-width="${c.axisStroke}"></line><line x1="0" y1="${pb}" x2="0" y2="0" stroke="${color(h.tone('ink'))}" stroke-width="${c.axisStroke}"></line><path d="${path}" fill="none" stroke="${color(h.tone('accent'))}" stroke-width="${c.lineStroke}"></path>${extra}</svg>` +
        (d.body ? h.body(d.body) : ''),
    });
  },

  'metrics-table'(d, ctx, h) {
    const n = d.cells.length;
    const cells = d.cells.map((cell, i) => {
      const last = i === n - 1;
      const inner = `<p style="margin:0 0 ${space(8)};${type.data({ 'font-size': size('floor'), color: color(h.tone('mute')) })}">${esc(cell.label)}</p>` +
        (cell.phrase !== undefined
          ? `<p style="margin:0;${type.displaySemi('body-lg', { 'line-height': metrics.leading.metricsPhrase, 'letter-spacing': v('track-headline'), color: color(h.tone('ink')) })}">${esc(cell.phrase)}</p>`
          : `<p style="margin:0;${type.displayBold('title', { 'line-height': metrics.leading.hero, 'letter-spacing': v('track-statement'), color: color(h.tone('ink')) })}">${esc(cell.value)}<span style="${type.data({ color: color(h.tone('accent-ink')) })}">${esc(cell.unit || '')}</span></p>`);
      return `<div style="${st({ padding: `${space(32)} 0 ${space(32)} ${i === 0 ? 0 : space(32)}`, 'border-right': last ? undefined : RULE(h.tone('line')) })}">${inner}</div>`;
    }).join('');
    return h.stack(56, {
      wide: true, // measured cell grid
      label: '',
      main: h.headline(d.headline, 's') +
        `<div style="${st({ display: 'grid', 'grid-template-columns': Array(n).fill('1fr').join(' '), 'border-top': RULE(h.tone('ink')) })}">${cells}</div>`,
    });
  },

  'figure-panel'(d, ctx, h) {
    const fp = metrics.figurePanel[d.variant || 'narrow'];
    const cut = ctx.cutouts.byId.get(d.cutout);
    if (!cut) throw new Error(`figure-panel: unknown cutout ${d.cutout}`);
    // A cutout is never scaled beyond its native pixel size.
    const imgH = Math.min(fp.imageHeight, cut.height);
    const text = (d.label ? h.kicker(d.label) : '') + h.headline(d.headline, d.variant === 'wide' ? 's' : 'title') + (d.body ? h.body(d.body) : '');
    return `<div data-role="content" style="${st({ flex: 1, display: 'grid', 'grid-template-columns': `minmax(0,1fr) ${px(fp.width)}`, gap: space(48), 'align-items': d.variant === 'wide' ? 'stretch' : 'center' })}">` +
      `<div style="${st({ display: 'flex', 'flex-direction': 'column', 'justify-content': 'center', gap: space(40) })}">${text}</div>` +
      `<div style="${st({ background: color('ground-alt'), height: px(fp.height), position: 'relative', overflow: 'hidden' })}"><img data-cutout="${esc(cut.id)}" src="${ctx.cutouts.dataUri(cut)}" style="${st({ position: 'absolute', bottom: 0, left: '50%', transform: 'translateX(-50%)', height: px(imgH) })}"></div></div>`;
  },

  // The end card is fixed brand furniture, not a caption surface: it keeps its
  // own ground, sizes and colours whatever treatment the deck is carrying.
  cta(d) {
    const icons = CTA_ICONS.map((paths) =>
      `<svg viewBox="0 0 24 24" width="${metrics.ctaIcon.size}" height="${metrics.ctaIcon.size}" fill="none" stroke="currentColor" stroke-width="${metrics.ctaIcon.strokeWidth}" stroke-linecap="round" stroke-linejoin="round">` +
      paths.map((dAttr) => `<path d="${esc(dAttr)}"></path>`).join('') + `</svg>`).join('');
    const inner = `<div data-role="content" style="${st({ flex: 1, display: 'flex', 'flex-direction': 'column', 'justify-content': 'center', 'align-items': 'center', gap: space(56), 'text-align': 'center' })}">` +
      mark(metrics.mark.cta, { arrow: 'on-accent', stem: 'mute-inv' }) +
      `<div style="${st({ display: 'flex', 'flex-direction': 'column', gap: space(16) })}">` +
      `<span style="${type.displaySemi('s', { 'line-height': metrics.leading.hero, 'letter-spacing': v('track-statement'), color: color('on-accent') })}">${esc(d.wordmark)}</span>` +
      `<span style="${type.data({ 'font-size': size('body'), 'letter-spacing': v('track-wide'), color: color('on-accent') })}">${esc(d.tagline)}</span></div>` +
      `<div style="${st({ display: 'flex', gap: space(40), color: color('on-accent') })}">${icons}</div></div>`;
    // Footer band: nothing but one line of source credit (deck-rules), truncated with an ellipsis if it overruns.
    const footer = `<div data-role="cta-footer" style="${st({ display: 'flex', 'align-items': 'center', 'min-height': v('footer-height') })}">` +
      (d.credit ? `<span data-role="credit" style="${st({ display: 'block', width: '100%', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' })};${type.data({ color: color('on-accent') })}">${esc(d.credit)}</span>` : '') +
      `</div>`;
    return { inner, footer };
  },
};

// Build one body slide. Returns { canvasStyle, canvasInner }.
// `h` is the treatment helper set from lib/treatments.js.
function buildSlide(slide, { ctx, h = ctx && ctx.h }) {
  if (!h) throw new Error('buildSlide needs a caption treatment: pass h, or set ctx.h from lib/treatments.js helpers()');
  const fn = components[slide.type];
  if (!fn) throw new Error(`unknown slide type "${slide.type}"`);
  const out = fn(slide, ctx, h);
  const inverted = h && h.treatment && h.treatment.ground === 'accent';
  const ground = slide.type === 'cta' || slide.ground === 'accent' || (inverted && slide.type !== 'cta') ? 'accent' : 'white';
  if (typeof out === 'string') return slideShell({ ground, inner: out });
  return slideShell({ ground, inner: out.inner, footer: out.footer });
}

module.exports = { buildSlide, components, valueRow, gapVal };
