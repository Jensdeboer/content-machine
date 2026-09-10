'use strict';
// Caption treatments: design/04-slides/caption-treatments.json, and the helper
// factory that turns one treatment into the kicker/headline/body/stack builders
// the components use. Loaded and validated once at startup, the same way
// cutouts.js validates its manifest, so a bad role name fails loudly here
// instead of rendering a slide with an unresolved CSS variable.
const fs = require('fs');
const path = require('path');
const { metrics, esc, px, v, color, size, space, st, type } = require('./html');

const ANCHORS = { top: 'flex-start', centre: 'center', bottom: 'flex-end' };
const LAYOUTS = ['stack', 'side-label'];
const EMPHASES = ['colour', 'weight', 'chip', 'underline', 'signal'];
const CONTAINERS = ['none', 'band', 'tint', 'rules'];
const GROUNDS = ['white', 'accent'];
const WEIGHTS = ['semi', 'bold'];

// Every tone in the manifest must be a colour role tokens.json actually
// defines: the manifest carries role names, never values, so this is the
// only place the two vocabularies are checked against each other.
function validate(manifest, tokens) {
  const problems = [];
  const seen = new Set();
  const roleOk = (role, where) => {
    if (role === undefined || role === null) return;
    try { tokens.color(role); } catch (e) { problems.push(`${where}: "${role}" is not a colour role in ${path.basename(tokens.file)}`); }
  };
  for (const t of manifest.treatments) {
    if (!t.id) { problems.push('a treatment has no id'); continue; }
    if (seen.has(t.id)) problems.push(`duplicate treatment id "${t.id}"`);
    seen.add(t.id);
    if (!GROUNDS.includes(t.ground)) problems.push(`${t.id}: ground "${t.ground}" is not one of ${GROUNDS.join(', ')}`);
    if (!ANCHORS[t.anchor]) problems.push(`${t.id}: anchor "${t.anchor}" is not one of ${Object.keys(ANCHORS).join(', ')}`);
    if (!LAYOUTS.includes(t.layout)) problems.push(`${t.id}: layout "${t.layout}" is not one of ${LAYOUTS.join(', ')}`);
    if (!EMPHASES.includes(t.emphasis)) problems.push(`${t.id}: emphasis "${t.emphasis}" is not one of ${EMPHASES.join(', ')}`);
    if (!CONTAINERS.includes(t.container)) problems.push(`${t.id}: container "${t.container}" is not one of ${CONTAINERS.join(', ')}`);
    if (!WEIGHTS.includes(t.headline.weight)) problems.push(`${t.id}: headline weight "${t.headline.weight}" is not one of ${WEIGHTS.join(', ')}`);
    // Upward size shifts would invalidate the measured copy budgets in
    // component-capacity.json, which were taken at the component's own step.
    if (!(t.headline.stepShift <= 0)) problems.push(`${t.id}: headline stepShift ${t.headline.stepShift} grows the headline; re-run capacity.js before allowing a positive shift`);
    if (!(t.body.stepShift <= 0)) problems.push(`${t.id}: body stepShift ${t.body.stepShift} grows the body copy; re-run capacity.js before allowing a positive shift`);
    roleOk(t.kicker.tone, `${t.id}.kicker.tone`);
    roleOk(t.kicker.bandTone, `${t.id}.kicker.bandTone`);
    roleOk(t.headline.tone, `${t.id}.headline.tone`);
    roleOk(t.body.tone, `${t.id}.body.tone`);
    if (t.kicker.container === 'band' && !t.kicker.bandTone) problems.push(`${t.id}: kicker container "band" needs a bandTone`);
  }
  if (problems.length) throw new Error(`caption-treatments.json failed validation:\n  ${problems.join('\n  ')}`);
}

function loadTreatments(brandDir, tokens) {
  const file = path.join(brandDir, 'design', '04-slides', 'caption-treatments.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  validate(manifest, tokens);
  const byId = new Map(manifest.treatments.map((t) => [t.id, t]));
  return { file, manifest, treatments: manifest.treatments, byId, default: manifest.treatments[0] };
}

// Shift a step name along the token size scale. Clamped at both ends: a
// treatment never pushes type under the floor.
function shiftStep(tokens, step, shift) {
  if (!shift) return step;
  const i = tokens.sizeSteps.findIndex(([k]) => k === step);
  if (i < 0) return step;
  const j = Math.min(tokens.sizeSteps.length - 1, Math.max(0, i - shift));
  return tokens.sizeSteps[j][0];
}

// A component's own hard-coded roles are written for a light ground. On a
// treatment that inverts the slide they map to their dark-ground equivalents,
// so a navy slide never paints navy type on navy. The treatment's own tones
// (kicker.tone and friends) are already ground-correct in the manifest and are
// never passed through here.
const ON_DARK = {
  ink: 'on-accent', 'ink-soft': 'mute-inv', mute: 'mute-inv', line: 'mute-inv',
  accent: 'on-accent', 'accent-ink': 'on-accent',
};

// The builders every component draws its caption stack with, bound to one
// treatment. Components never read the treatment directly; they call these.
// Compaction ladder. A slide whose copy runs past the content area pushes the
// footer off the safe zone, which is how "SWIPE →" kept turning up out of
// bounds: nothing measured a body slide before it was committed. Rather than
// clip the copy or loosen the rule, the composer re-sets the same slide a
// little tighter and measures again — the body-slide equivalent of the
// cover's fitHeadline stepping down the size scale.
//
// Rungs, in the order they cost the least: first the anchor inset and the
// container padding, which are breathing room; then the type, one step at a
// time, headline before body because a headline at 96px buys more height per
// step than body copy at 36px.
const COMPACTION = [
  {},
  { dropEdgeInset: true, tightContainer: true },
  { dropEdgeInset: true, tightContainer: true, headline: -1 },
  { dropEdgeInset: true, tightContainer: true, headline: -1, body: -1 },
  { dropEdgeInset: true, tightContainer: true, headline: -2, body: -1, tightGaps: true },
];

function helpers(t, tokens, compaction = 0) {
  const squeeze = COMPACTION[Math.min(compaction, COMPACTION.length - 1)] || {};
  const k = metrics.caption;
  const displayFn = (weight) => (weight === 'bold' ? type.displayBold : type.displaySemi);
  const tone = (role) => (t.ground === 'accent' ? ON_DARK[role] || role : role);

  // [[bracketed]] phrases. Always exactly one [data-accent] element whatever
  // the style, so the qa accent-count rule reads the same across treatments.
  function richText(text, { tone } = {}) {
    const parts = String(text).split(/(\[\[.*?\]\])/g);
    return parts.map((p) => {
      const m = p.match(/^\[\[(.*)\]\]$/);
      if (!m) return esc(p).replace(/\n/g, '<br>');
      const inner = esc(m[1]);
      if (t.emphasis === 'weight') return `<span data-accent style="${st({ 'font-weight': v('weight-display-bold') })}">${inner}</span>`;
      if (t.emphasis === 'chip') return `<span data-accent style="${st({ background: color('ink'), color: color('on-accent'), padding: `${space(k.chipPadY)} ${space(k.chipPadX)}` })}">${inner}</span>`;
      if (t.emphasis === 'underline') return `<span data-accent style="${st({ 'border-bottom': `${px(k.emphasisUnderlineWeight)} solid ${color('accent-ink')}`, 'padding-bottom': px(k.emphasisUnderlineOffset) })}">${inner}</span>`;
      // Signal is a pop accent on one phrase, never a ground and never the ink
      // of a whole caption. On a dark ground it is legible as ink (12:1 on
      // Vector Navy). On white it is not (1.4:1), so there it takes the form
      // the grammar already sanctions for signal on white: a fill with black
      // type, inline and phrase-sized rather than a block.
      if (t.emphasis === 'signal') {
        return t.ground === 'accent'
          ? `<span data-accent data-signal="emphasis" style="${st({ color: color('signal') })}">${inner}</span>`
          : `<span data-accent data-signal="emphasis" style="${st({ background: color('signal'), color: color('ink'), padding: `${space(k.chipPadY)} ${space(k.chipPadX)}` })}">${inner}</span>`;
      }
      return `<span data-accent style="${st({ color: color(tone === 'on-accent' ? 'on-accent' : 'accent-ink') })}">${inner}</span>`;
    }).join('');
  }

  const kicker = (text) => {
    const base = type.data({ color: color(t.kicker.tone) });
    if (t.kicker.container !== 'band') return `<span data-role="label" style="${base}">${esc(text)}</span>`;
    const box = st({ display: 'inline-block', background: color(t.kicker.bandTone), padding: `${space(k.bandPadY)} ${space(k.bandPadX)}`, 'align-self': 'flex-start' });
    return `<span data-role="label" style="${box};${base}">${esc(text)}</span>`;
  };

  const headline = (text, step, extra = {}) => {
    const s = shiftStep(tokens, step, t.headline.stepShift + (squeeze.headline || 0));
    const style = displayFn(t.headline.weight)(s, {
      'line-height': v('lead-headline'), 'letter-spacing': v('track-headline'), color: color(t.headline.tone), ...extra,
    });
    const inner = richText(text, { tone: t.headline.tone });
    const rule = `${px(metrics.rule.slide)} solid ${color(t.headline.tone)}`;
    if (t.container !== 'rules') return `<h3 data-role="headline" style="margin:0;${style}">${inner}</h3>`;
    return `<div style="${st({ 'border-top': rule, 'border-bottom': rule, padding: `${space(k.ruleGap)} 0`, margin: 0 })}">` +
      `<h3 data-role="headline" style="margin:0;${style}">${inner}</h3></div>`;
  };

  const body = (text, step = 'body-lg', extra = {}) => {
    const s = shiftStep(tokens, step, t.body.stepShift + (squeeze.body || 0));
    return `<p data-role="body" style="margin:0;max-width:${px(metrics.copyMaxWidth)};${type.body(s, { color: color(t.body.tone), ...extra })}">${richText(text, { tone: t.body.tone })}</p>`;
  };

  // The content area. `anchor` positions the stack; `container: tint` wraps it
  // in a ground-alt block; `layout: side-label` splits the kicker into a left
  // column. Text stays inside the safe area in every combination: the tint
  // block pads inward from the content column, never outward past the margin.
  const stack = (gapIn, parts, extra = {}) => {
    const { label = '', main = '', wide = false } = parts;
    // Gaps snap to the space scale so a compacted slide still sits on the grid.
    const gap = squeeze.tightGaps && gapIn
      ? (tokens.spaceScale.filter((n) => n <= gapIn * 0.6).pop() || gapIn)
      : gapIn;
    let inner;
    // `wide` content needs the whole 888 measure — a hero number, a two-column
    // compare, a chart, a metrics row. The side-label column would leave it
    // 600px, which is not a tighter fit but a broken one: "~2,000" at the xl
    // step is wider than the column on its own. Those components keep the
    // stacked layout whatever the treatment; side-label is a text-stack idea.
    if (t.layout === 'side-label' && label && !wide) {
      inner = `<div style="${st({ display: 'grid', 'grid-template-columns': `${px(k.sideLabelColumn)} minmax(0,1fr)`, gap: space(k.sideLabelGap), 'align-items': 'start' })}">` +
        `<div>${label}</div><div style="${st({ display: 'flex', 'flex-direction': 'column', gap: gap ? space(gap) : '0' })}">${main}</div></div>`;
    } else {
      inner = `<div style="${st({ display: 'flex', 'flex-direction': 'column', gap: gap ? space(gap) : '0' })}">${label}${main}</div>`;
    }
    if (t.container === 'tint') {
      const pad = squeeze.tightContainer ? tokens.spaceScale.filter((n) => n <= k.tintPad / 2).pop() : k.tintPad;
      inner = `<div style="${st({ background: color('ground-alt'), padding: space(pad) })}">${inner}</div>`;
    }
    // A top- or bottom-anchored stack sits flush against the safe edge, and a
    // text rect is taller than its line box whenever leading is tight: the
    // numeral-point "02" at 140px with leading 1 puts 19px of glyph above its
    // own element, which is outside the safe zone even though the element is
    // inside it. The inset is one space step past the worst case at the largest
    // display size a body stack can lead with (xl 300 at the ~14% overshoot
    // measured on Sora), so tight leading has somewhere to go. Centre-anchored
    // stacks have slack on both sides already and take no inset.
    const edgeInset = squeeze.dropEdgeInset ? {}
      : t.anchor === 'top' ? { 'padding-top': space(k.edgeAnchorInset) }
        : t.anchor === 'bottom' ? { 'padding-bottom': space(k.edgeAnchorInset) } : {};
    return `<div data-role="content" style="${st({ flex: 1, display: 'flex', 'flex-direction': 'column', 'justify-content': ANCHORS[t.anchor], ...edgeInset, ...extra })}">${inner}</div>`;
  };

  return { treatment: t, compaction, tone, richText, kicker, headline, body, stack, shiftStep: (step, shift) => shiftStep(tokens, step, shift) };
}

// The deck's treatment: the first in manifest order that the no-repeat window
// allows, so the set cycles deterministically. Mirrors the cutout picker in
// cover.js — same history, same "exclude what the window holds" shape. With a
// window smaller than the set there is always a survivor; the fallback is the
// least recently used one rather than a throw, because a caption style is never
// a reason to block a deck.
function pick(set, rows, window) {
  const recent = rows.slice(-window).map((r) => r.treatment).filter(Boolean);
  const lastUsed = new Map();
  rows.forEach((r, i) => { if (r.treatment) lastUsed.set(r.treatment, i); });
  // Least recently used among those the window allows, manifest order breaking
  // ties so a never-used treatment comes first and the whole set is reached.
  // Taking simply the first allowed one instead looks correct — it satisfies
  // no-repeat-within-N — but with six treatments and a window of three it
  // settles into a four-cycle and the last two never render at all.
  const order = (t) => (lastUsed.has(t.id) ? lastUsed.get(t.id) : -1);
  const rank = new Map(set.treatments.map((t, i) => [t.id, i]));
  const pool = set.treatments.filter((t) => !recent.includes(t.id));
  return (pool.length ? pool : set.treatments).slice()
    .sort((a, b) => order(a) - order(b) || rank.get(a.id) - rank.get(b.id))[0];
}

module.exports = { loadTreatments, helpers, shiftStep, pick, COMPACTION, ANCHORS, LAYOUTS, EMPHASES, CONTAINERS, GROUNDS };
