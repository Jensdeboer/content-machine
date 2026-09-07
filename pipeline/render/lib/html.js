'use strict';
// HTML skeleton and chrome (mark, kicker, slide header, footer). Every colour
// and size is a token role or a value from component-metrics.json.
const fs = require('fs');
const path = require('path');

const metrics = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'component-metrics.json'), 'utf8'));
const FONTS_DIR = path.join(__dirname, '..', 'fonts');
// Pages are served from this routed origin (see browser.js) so fonts load without file:// restrictions.
const ORIGIN = 'http://pv.local';

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const px = (n) => `${n}px`;
const v = (name) => `var(--pv-${name})`;
const color = (role) => v(`color-${role}`);
const size = (step) => v(`size-${step}`);
const space = (n) => v(`space-${n}`);

// Inline style from an object; keys are CSS property names.
function st(obj) {
  return Object.entries(obj)
    .filter(([, val]) => val !== undefined && val !== null && val !== false)
    .map(([k, val]) => `${k}:${val}`)
    .join(';');
}

// Type roles used across components.
const type = {
  data: (extra = {}) => st({
    'font-family': v('font-data'), 'font-weight': v('weight-data'), 'font-size': size('label'),
    'letter-spacing': v('track-label'), 'text-transform': 'uppercase', ...extra,
  }),
  displayBold: (step, extra = {}) => st({
    'font-family': v('font-display'), 'font-weight': v('weight-display-bold'), 'font-size': size(step), ...extra,
  }),
  displaySemi: (step, extra = {}) => st({
    'font-family': v('font-display'), 'font-weight': v('weight-display-semi'), 'font-size': size(step), ...extra,
  }),
  body: (step, extra = {}) => st({
    'font-family': v('font-body'), 'font-weight': v('weight-body'), 'font-size': size(step),
    'line-height': v('lead-copy'), ...extra,
  }),
  aside: (extra = {}) => st({
    'font-family': v('font-body'), 'font-weight': v('weight-body-light'), 'font-style': 'italic',
    'font-size': size('lead'), 'line-height': v('lead-aside'), ...extra,
  }),
};

// Mark C: stem in mute (or mute-inv on dark grounds), arrow in the mark colour.
function mark(sizePx, { arrow, stem }) {
  const m = metrics.mark;
  return `<span data-role="mark" style="${st({ color: color(arrow), display: 'flex' })}">` +
    `<svg viewBox="${m.viewBox}" width="${sizePx}" height="${sizePx}" fill="currentColor">` +
    `<rect x="${m.stem.x}" y="${m.stem.y}" width="${m.stem.width}" height="${m.stem.height}" fill="${color(stem)}"></rect>` +
    `<polygon points="${m.arrow}"></polygon></svg></span>`;
}

function groundRoles(ground) {
  if (ground === 'white') return { bg: color('ground'), ink: 'ink', muted: 'mute', stem: 'mute', family: 'white' };
  if (ground === 'navy') return { bg: color('ground-navy'), ink: 'on-accent', muted: 'mute-inv', stem: 'mute-inv', family: 'navy' };
  if (ground === 'deep') return { bg: color('ground-deep'), ink: 'on-accent', muted: 'mute-inv', stem: 'mute-inv', family: 'navy' };
  if (ground === 'accent') return { bg: color('accent'), ink: 'on-accent', muted: 'on-accent', stem: 'mute-inv', family: 'navy' };
  throw new Error(`unknown ground ${ground}`);
}

// Cover kicker, top-left. Plain (mute / mute-inv) or a signal chip, or signal
// type on navy. `zIndex` keeps chrome above figure and headline.
function coverKicker(text, ground, signal) {
  const g = groundRoles(ground);
  const base = { position: 'absolute', top: v('margin'), left: v('margin'), 'z-index': 6 };
  let extra;
  if (signal === 'chip') {
    extra = { background: color('signal'), color: color('ink'), padding: `${space(12)} ${space(24)}` };
  } else if (signal === 'type') {
    extra = { color: color('signal') };
  } else {
    extra = { color: color(g.muted) };
  }
  const role = signal === 'chip' || signal === 'type' ? ' data-signal="kicker"' : '';
  return `<span data-role="kicker"${role} style="${st(base)};${type.data(extra)}">${esc(text)}</span>`;
}

function coverMark(ground) {
  const g = groundRoles(ground);
  return `<span style="${st({ position: 'absolute', top: v('margin'), right: v('margin'), 'z-index': 6, display: 'flex' })}">` +
    mark(metrics.mark.cover, { arrow: g.ink, stem: g.stem }) + `</span>`;
}

// Slide header: series left, "NN / NN" right.
function slideHeader(series, index, total, ground) {
  const c = ground === 'accent' ? 'on-accent' : 'accent-ink';
  return `<div data-role="header" style="${st({ display: 'flex', 'justify-content': 'space-between' })};${type.data({ color: color(c) })}">` +
    `<span>${esc(series)}</span><span data-role="counter">${String(index).padStart(2, '0')} / ${String(total).padStart(2, '0')}</span></div>`;
}

// Slide footer: mark left, mono label right, on the 96 footer zone.
function slideFooter(ground, label) {
  const onAccent = ground === 'accent';
  return `<div data-role="footer" style="${st({ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center', height: v('footer-height') })}">` +
    mark(metrics.mark.footer, onAccent ? { arrow: 'on-accent', stem: 'mute-inv' } : { arrow: 'accent-ink', stem: 'mute' }) +
    `<span data-role="swipe" style="${type.data({ color: color(onAccent ? 'on-accent' : 'mute') })}">${esc(label)}</span></div>`;
}

function fontFaces() {
  const face = (family, weight, style, file) =>
    `@font-face{font-family:'${family}';font-style:${style};font-weight:${weight};src:url('${ORIGIN}/fonts/${file}') format('truetype');}`;
  return [
    face('Sora', 700, 'normal', 'Sora-700.ttf'),
    face('Sora', 800, 'normal', 'Sora-800.ttf'),
    face('IBM Plex Sans', 400, 'normal', 'IBMPlexSans-400.ttf'),
    face('IBM Plex Sans', 300, 'italic', 'IBMPlexSans-300italic.ttf'),
    face('IBM Plex Mono', 500, 'normal', 'IBMPlexMono-500.ttf'),
  ].join('\n');
}

// A full document holding one slide canvas. `canvasStyle` is the canvas's own
// inline style (ground, padding, flex) from the component.
function page({ tokens, slideIndex, slideType, canvasInner, canvasStyle, extraHead = '' }) {
  return `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(slideType)} ${slideIndex}</title>
<style>
${fontFaces()}
${tokens.cssVars()}
html,body{margin:0;padding:0;background:transparent}
body{-webkit-font-smoothing:antialiased}
.canvas{position:relative;overflow:hidden;width:var(--pv-canvas-width);height:var(--pv-canvas-height);box-sizing:border-box;font-family:var(--pv-font-body)}
</style>${extraHead}</head><body>
<div class="canvas" data-role="canvas" data-slide="${slideIndex}" data-type="${esc(slideType)}" style="${canvasStyle}">
${canvasInner}
</div></body></html>`;
}

module.exports = { metrics, esc, px, v, color, size, space, st, type, mark, groundRoles, coverKicker, coverMark, slideHeader, slideFooter, page, FONTS_DIR, ORIGIN };
