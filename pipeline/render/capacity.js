#!/usr/bin/env node
'use strict';
// How much copy each component holds, measured rather than guessed.
//
//   node pipeline/render/capacity.js           # measure and rewrite component-capacity.json
//   node pipeline/render/capacity.js --check   # measure and fail if the file is out of date
//
// The write stage is handed these budgets so the copy fits by construction, and
// an overflow at QA is a bug rather than a routine outcome. Nothing is
// estimated from character counts: every number comes from the real templates,
// laid out in Chromium in the real fonts at the real sizes on the real
// 1080x1350 canvas, and tested with qa.js's own text-overflow rule. Change a
// token, a template or a font and this file is stale — run it again.
//
// The budgets hold TOGETHER. A field measured on its own runs to the bottom of
// an otherwise empty slide, and a slide whose every field is at that maximum
// overflows; a set of per-field maxima is not a budget. So each component is
// grown from a reference slide the pipeline has really written: every field
// takes a step, the whole slide is re-rendered, and a step that overflows is
// refused. What is written out is a state that was rendered and fits, less the
// margin in rules.js.
const fs = require('fs');
const path = require('path');
const { loadTokens } = require('./lib/tokens');
const cutoutsLib = require('./lib/cutouts');
const htmlLib = require('./lib/html');
const { buildSlide } = require('./lib/slides');
const browser = require('./lib/browser');
const RULES = require('./lib/rules');
const { textOverflowFlags } = require('./qa');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_FILE = path.join(__dirname, 'component-capacity.json');

// Running copy, so the measurement sees the letter frequencies and word lengths
// a deck actually carries. Numeric fields get digits: a hero number at 300px is
// set in figures, and figures are not the width of letters.
const VOCAB = ('easy pace is the effort you can hold while talking in full sentences and most '
  + 'runners start too fast on the days that were meant to be slow which is why the '
  + 'first mile matters more than the last one and why the week after a hard session '
  + 'decides what the next block looks like for your legs breathing and head').split(/\s+/);
const DIGITS = '12,345.6 78,901.2 ';
const NUMERIC = /(^|\.)(value|numeral)$/;

// `seed` starts the vocabulary at a different word for each field, so two
// fields on one slide never carry the same opening words and the line count
// below can tell them apart.
function filler(n, numeric, seed = 0) {
  if (numeric) {
    let s = '';
    while (s.length < n) s += DIGITS.slice(seed % DIGITS.length) + DIGITS;
    return s.slice(0, n).replace(/[ ,.]$/, '0');
  }
  let s = '';
  for (let i = 0; s.length <= n; i++) s += (i ? ' ' : '') + VOCAB[(i + seed) % VOCAB.length];
  return s.slice(0, n).trimEnd();
}

// Paths into a sample: "headline", "left.body", "items[]" (every element),
// "rows[].text", "cells[].phrase". An array path sets every element, because a
// list is written to one length, not to one long item and two short ones.
function atPath(obj, spec) {
  const parts = spec.split('.');
  let node = obj;
  for (let i = 0; i < parts.length; i++) {
    const [, key, isArray] = parts[i].match(/^([^[]+)(\[\])?$/);
    if (isArray) {
      const rest = parts.slice(i + 1);
      const first = node[key][0];
      return rest.length ? rest.reduce((n, k) => n[k], first) : first;
    }
    node = node[key];
  }
  return node;
}

function setPath(obj, spec, value) {
  const out = JSON.parse(JSON.stringify(obj));
  const parts = spec.split('.');
  let node = out;
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    const [, key, isArray] = parts[i].match(/^([^[]+)(\[\])?$/);
    if (isArray) {
      const rest = parts.slice(i + 1);
      node[key] = node[key].map((el) => {
        if (!rest.length) return value;
        const copy = JSON.parse(JSON.stringify(el));
        let n = copy;
        for (let j = 0; j < rest.length - 1; j++) n = n[rest[j]];
        n[rest[rest.length - 1]] = value;
        return copy;
      });
      return out;
    }
    if (last) node[key] = value;
    else node = node[key];
  }
  return out;
}

// --------------------------------------------------------------------------
// Reference slides: what the pipeline has actually written, so a field is grown
// from real copy and against real siblings. Components no run has produced yet
// carry the shortest schema-valid shape their template supports.
// --------------------------------------------------------------------------
const SOURCE = { figure: '2', quote: 'reference row', url: 'https://example.org/x', publisher: 'Reference', retrieved: '2026-01-01', crossChecked: true };

function samples(cutoutId) {
  return {
    stat: {
      type: 'stat', label: '01 · EASY MEANS EASY', value: '~2', unit: 'MIN/KM SLOWER THAN 5K PACE',
      headline: 'That is roughly what easy feels like at first: too slow.', source: SOURCE,
    },
    // The third state of the stat template: a wide value stepped down to `l`.
    // Worth its own row, because the step is what decides whether a figure like
    // "~2,000" can be set at all.
    'stat-wide': {
      type: 'stat', valueStep: 'l', label: '01 · WHAT IS IN THE TANK', value: '~2,000', unit: 'KCAL OF STORED GLYCOGEN',
      headline: 'That is the tank most runners set off on.', source: SOURCE,
    },
    explainer: {
      type: 'explainer', label: '03 · WHAT EASY BUILDS', headline: 'Slow running is not wasted running.',
      body: 'Easy effort is where most of the aerobic work happens. It is quiet, it is boring, and it is the part that lasts.',
    },
    'numeral-point': {
      type: 'numeral-point', numeral: '02', headline: 'If you cannot talk in full sentences, slow down.',
      body: 'The talk test is the whole check, and it costs nothing to run.',
    },
    'numeral-point-pair': {
      type: 'numeral-point',
      items: [
        { numeral: '01', headline: 'Start slower than feels reasonable.', body: 'The first mile sets the rest of the run.' },
        { numeral: '02', headline: 'Finish thinking you could do it again.', body: 'That is the whole test, and it is enough.' },
      ],
    },
    checklist: {
      type: 'checklist', label: '04 · HOW TO KNOW IT IS EASY', headline: 'Three checks on your next easy run.',
      items: ['You can speak a full sentence out loud', 'Your breathing settles within a minute of stopping', 'You finish thinking you could do it again'],
    },
    'checklist-rows': {
      type: 'checklist', headline: 'What each session is for.',
      rows: [
        { label: 'MON', text: 'Easy, conversational, no watch.' },
        { label: 'WED', text: 'Steady, one gear up, still talking.' },
        { label: 'SAT', text: 'Long, slow, and boring on purpose.' },
      ],
    },
    'pull-statement': {
      type: 'pull-statement', label: '05 · THIS WEEK', headline: 'Run one session this week slower than feels reasonable.',
      aside: 'Yes, that slow.',
    },
    compare: {
      type: 'compare', label: '02 · TWO WAYS TO RUN IT', headline: 'Same distance, two different weeks.',
      left: { label: 'MOST RUNNERS', headline: 'Every run at the same pace.', body: 'Hard enough to tire, easy enough to feel fine.' },
      right: { label: 'WHAT WORKS', headline: 'Most runs slow, one run hard.', body: 'The easy days are what make the hard day possible.' },
      source: SOURCE,
    },
    'progress-scale': {
      type: 'progress-scale', label: '05 · THE TEN PERCENT RULE', headline: 'Add distance in weeks, not days.',
      fill: { from: 0, to: 60 }, marker: 70, ticks: [{ label: 'WEEK 1' }, { label: 'WEEK 4' }, { label: 'WEEK 8', tone: 'accent' }],
      body: 'The jump that hurts is rarely the long run itself.', caption: 'Weekly volume, first eight weeks', source: SOURCE,
    },
    chart: {
      type: 'chart', numeral: '03', headline: 'Effort climbs long before pace does.',
      points: [[0, 0.1], [0.3, 0.2], [0.6, 0.45], [1, 0.9]], reference: { x: 0.6, y: 0.45, label: 'THE TURN' },
      xLabel: 'MINUTES INTO THE RUN', body: 'The last third costs more than the first two.', source: SOURCE,
    },
    'metrics-table': {
      type: 'metrics-table', headline: 'What an easy week looks like.',
      cells: [
        { label: 'EASY', value: '80', unit: '%', phrase: 'of weekly minutes' },
        { label: 'HARD', value: '20', unit: '%', phrase: 'and never back to back' },
      ],
      source: SOURCE,
    },
    'figure-panel': {
      type: 'figure-panel', label: '04 · THE SHAPE OF IT', headline: 'Slow is a pace, not a mood.',
      body: 'It is the same run you already do, run two minutes slower.', cutout: cutoutId,
    },
    cta: { type: 'cta', credit: 'SOURCE · BRITISH JOURNAL OF SPORTS MEDICINE', wordmark: 'PaceVector', tagline: 'MOVE WITH PURPOSE' },
  };
}

// The fields write puts copy into, per component shape. Order is editorial
// priority: growth goes round the fields in this order, so what is listed first
// claims contested space (a stat's hero number before its unit strap) instead
// of losing it to a field nobody reads first.
const FIELDS = {
  stat: ['headline', 'value', 'unit', 'label'],
  'stat-wide': ['headline', 'value', 'unit', 'label'],
  explainer: ['headline', 'body', 'label'],
  'numeral-point': ['headline', 'body'],
  'numeral-point-pair': ['items[].headline', 'items[].body'],
  checklist: ['headline', 'items[]', 'label'],
  'checklist-rows': ['headline', 'rows[].label', 'rows[].text'],
  'pull-statement': ['headline', 'aside', 'label'],
  compare: ['headline', 'left.headline', 'right.headline', 'left.body', 'right.body', 'left.label', 'right.label', 'label'],
  'progress-scale': ['headline', 'body', 'ticks[].label', 'caption', 'label'],
  chart: ['headline', 'reference.label', 'xLabel', 'body'],
  'metrics-table': ['headline', 'cells[].value', 'cells[].unit', 'cells[].label', 'cells[].phrase'],
  'figure-panel': ['headline', 'body', 'label'],
  cta: ['credit'],
};

// Variant rows named the way write meets them in the schema, so a budget line
// says which shape of the template it belongs to.
const LABELS = {
  'stat-wide': 'stat with valueStep "l"',
  'numeral-point-pair': 'numeral-point, items variant',
  'checklist-rows': 'checklist, rows variant',
};

// --------------------------------------------------------------------------
// Measurement.
// --------------------------------------------------------------------------
async function fits(page, tokens, ctx, slide, { creditOnly } = {}) {
  const built = buildSlide(slide, { ctx });
  const html = htmlLib.page({ tokens, slideIndex: 2, slideType: slide.type, canvasInner: built.canvasInner, canvasStyle: built.canvasStyle });
  await browser.show(page, html);
  const audit = await page.evaluate(() => window.__pv.audit());
  // The cta credit is the one string the template truncates on purpose, so the
  // overflow rule skips it. Its budget is the one line deck-rules allows it.
  if (creditOnly) {
    const credit = audit.texts.find((t) => t.role === 'credit');
    return { ok: !!credit && !credit.scrollOverflow, audit };
  }
  const canvasBox = { x: 0, y: 0, w: tokens.canvas.width, h: tokens.canvas.height };
  const safeBox = { x: tokens.safe.x, y: tokens.safe.y, w: tokens.safe.width, h: tokens.safe.height };
  return { ok: textOverflowFlags(audit, { canvasBox, safeBox, isCover: false }).length === 0, audit };
}

// Grow the fields of one component to their wall, one at a time, in priority
// order: each is bisected against the slide as it stands, so a field is
// measured with everything ahead of it already at full length and the state
// that comes out is one that was rendered whole. Growing them in parallel
// instead lets a unit strap widen into the row the hero number needs, and
// hands back a budget that says a stat value may be four characters when
// "~2,000" plainly renders.
async function measureComponent(page, tokens, ctx, name, sample, fields, log) {
  const creditOnly = fields.length === 1 && fields[0] === 'credit';
  const ref = {};
  for (const f of fields) ref[f] = String(atPath(sample, f)).length;
  const cap = {};
  for (const f of fields) cap[f] = Math.max(Math.ceil(ref[f] * RULES.copyBudgetMaxScale), ref[f] + RULES.copyBudgetMinHeadroom);

  const seed = (f) => fields.indexOf(f) * 7 + 3;
  const build = (vals) => fields.reduce((s, f) => setPath(s, f, filler(vals[f], NUMERIC.test(f), seed(f))), sample);
  const test = async (vals) => (await fits(page, tokens, ctx, build(vals), { creditOnly })).ok;

  let cur = { ...ref };
  if (!await test(cur)) throw new Error(`${name}: the reference slide does not fit; the sample or the template is wrong`);

  for (const f of fields) {
    if (await test({ ...cur, [f]: cap[f] })) { cur[f] = cap[f]; continue; }
    let lo = cur[f], hi = cap[f];                       // lo fits, hi does not
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (await test({ ...cur, [f]: mid })) lo = mid; else hi = mid;
    }
    cur[f] = lo;
  }

  // The margin applies to the growth, never to the reference: reference copy is
  // copy that shipped, and a budget under it would be a lie about the box.
  const out = {};
  const budgets = {};
  for (const f of fields) budgets[f] = ref[f] + Math.floor((cur[f] - ref[f]) * RULES.copyBudgetMargin);
  const { audit } = await fits(page, tokens, ctx, build(budgets), { creditOnly });
  for (const f of fields) {
    // Exact match: every field draws from one vocabulary, so a short field's
    // filler turns up inside a longer field's and `includes` counts the wrong
    // node's lines.
    const text = filler(budgets[f], NUMERIC.test(f), seed(f));
    const hit = audit.texts.filter((t) => t.text.trim() === text);
    out[f] = {
      budget: budgets[f],
      fits: cur[f],
      reference: ref[f],
      lines: hit.length ? Math.max(...hit.map((t) => t.rects.length)) : 1,
      ...(cur[f] >= cap[f] ? { capped: true } : {}),
    };
    log(`  ${name}.${f}: ${budgets[f]} chars, ${out[f].lines} line(s)  (reference ${ref[f]}, fits ${cur[f]}${out[f].capped ? ', capped' : ''})`);
  }
  return out;
}

async function measure({ brandDir, log = () => {} }) {
  const tokens = loadTokens(brandDir);
  const lib = cutoutsLib.loadManifest(brandDir);
  const cache = new Map();
  lib.dataUri = (c) => { if (!cache.has(c.id)) cache.set(c.id, cutoutsLib.fileDataUri(lib, c)); return cache.get(c.id); };
  const ctx = { tokens, cutouts: lib, show: browser.show };
  const sampleSet = samples(lib.cutouts[0].id);

  const b = await browser.launch();
  const out = {};
  try {
    const page = await b.newPage(tokens, 1);
    for (const [name, fields] of Object.entries(FIELDS)) {
      const fieldsOut = await measureComponent(page, tokens, ctx, name, sampleSet[name], fields, log);
      out[name] = LABELS[name] ? { $as: LABELS[name], fields: fieldsOut } : { fields: fieldsOut };
    }
  } finally {
    await b.close();
  }
  return out;
}

function document_(components, brandDir) {
  return {
    $note: 'Measured, not estimated. pipeline/render/capacity.js lays each template out in Chromium in the real fonts at the real sizes and grows every field of a component together until the slide fails qa.js\'s text-overflow rule. "budget" is what the write stage is told and the number to write to; "fits" is the length that was still fitting when growth stopped; "reference" is the length of the real copy it grew from; "lines" is how many lines the budget occupies. The budgets hold together: one slide carrying all of them at once was rendered and fits. Stale as soon as a token, template or font changes; run the script again.',
    $measured: new Date().toISOString().slice(0, 10),
    $brand: path.relative(ROOT, brandDir).replace(/\\/g, '/'),
    $rules: {
      margin: RULES.copyBudgetMargin,
      maxScale: RULES.copyBudgetMaxScale,
      minHeadroom: RULES.copyBudgetMinHeadroom,
    },
    components,
  };
}

// --------------------------------------------------------------------------
// Reading a written brief back against the budgets.
// --------------------------------------------------------------------------

// Which measured shape a written slide is: two of the templates have a second
// state the schema selects with a field, and they hold different amounts.
function componentKey(slide) {
  if (slide.type === 'stat' && slide.valueStep === 'l') return 'stat-wide';
  if (slide.type === 'numeral-point' && slide.items) return 'numeral-point-pair';
  if (slide.type === 'checklist' && slide.rows) return 'checklist-rows';
  return slide.type;
}

// The [[accent]] brackets mark the accent phrase and a literal backslash-n
// forces a line break; neither is set on the slide, so neither is spent out of
// the budget.
const plain = (s) => String(s).replace(/\[\[|\]\]/g, '').replace(/\\n/g, ' ');

// Every value a field path names, with where it sits, skipping what is absent:
// most fields are optional and an unwritten field is not an over-long one.
function valuesAt(node, spec, where) {
  const parts = spec.split('.');
  let cur = [{ node, where }];
  for (const part of parts) {
    const [, key, isArray] = part.match(/^([^[]+)(\[\])?$/);
    const next = [];
    for (const c of cur) {
      const v = c.node == null ? undefined : c.node[key];
      if (v === undefined || v === null) continue;
      if (isArray) v.forEach((el, i) => next.push({ node: el, where: `${c.where}.${key}[${i}]` }));
      else next.push({ node: v, where: `${c.where}.${key}` });
    }
    cur = next;
  }
  return cur.filter((c) => typeof c.node === 'string');
}

// What a written brief puts over budget. The write stage is given these back to
// rewrite once; anything still over is a warning, not a block, because the
// budget is 90% of what fitted and over-budget copy may well still render. QA
// stays the gate.
function budgetFindings(brief, capacity) {
  const out = [];
  if (!capacity || !brief || !Array.isArray(brief.slides)) return out;
  brief.slides.forEach((slide, i) => {
    const key = componentKey(slide);
    const def = capacity.components[key];
    if (!def) return;
    for (const [field, f] of Object.entries(def.fields)) {
      for (const hit of valuesAt(slide, field, `slides[${i}]`)) {
        const chars = plain(hit.node).length;
        if (chars > f.budget) out.push({ where: hit.where, component: def.$as || key, field, chars, budget: f.budget });
      }
    }
  });
  return out;
}

// The budgets as the write stage is told them: one line per field, because this
// goes into every write prompt.
function promptLines(capacity) {
  const lines = [];
  for (const [component, def] of Object.entries(capacity.components)) {
    for (const [field, f] of Object.entries(def.fields)) {
      lines.push(`${def.$as || component}.${field}: ${f.budget} characters, ${f.lines} line${f.lines === 1 ? '' : 's'}`);
    }
  }
  return lines;
}

function load() {
  if (!fs.existsSync(OUT_FILE)) return null;
  return JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
}

async function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const brandDir = argv.includes('--brand') ? path.resolve(argv[argv.indexOf('--brand') + 1]) : path.join(ROOT, 'brands', 'pacevector');

  console.log(`measuring component capacity against ${path.relative(ROOT, brandDir)}`);
  const started = Date.now();
  const components = await measure({ brandDir, log: (s) => console.log(s) });
  const next = document_(components, brandDir);
  console.log(`measured in ${Math.round((Date.now() - started) / 1000)}s`);

  if (check) {
    const current = load();
    const same = current && JSON.stringify(current.components) === JSON.stringify(next.components);
    console.log(same ? 'component-capacity.json is current' : 'component-capacity.json is STALE; run without --check');
    process.exit(same ? 0 : 1);
  }

  fs.writeFileSync(OUT_FILE, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`wrote ${path.relative(ROOT, OUT_FILE)}`);
}

module.exports = { measure, load, promptLines, budgetFindings, componentKey, filler, setPath, atPath, OUT_FILE };

if (require.main === module) main().catch((e) => { console.error(e.stack || e); process.exit(1); });
