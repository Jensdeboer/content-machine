#!/usr/bin/env node
'use strict';
// Deck renderer. Brief JSON in, 5 or 7 JPEGs at 2160x2700 out, then QA.
//   node pipeline/render/index.js pipeline/render/examples/PV-01.json
//   options: --out <dir> (default out) --brand <dir> (default brands/pacevector) --no-qa
const fs = require('fs');
const path = require('path');
const { loadTokens } = require('./lib/tokens');
const { validate } = require('./lib/schema-check');
const history = require('./lib/history');
const cutouts = require('./lib/cutouts');
const htmlLib = require('./lib/html');
const { buildSlide } = require('./lib/slides');
const { composeCover } = require('./lib/cover');
const browser = require('./lib/browser');
const RULES = require('./lib/rules');
const qa = require('./qa');

const ROOT = path.resolve(__dirname, '..', '..');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, 'brief.schema.json'), 'utf8'));

// Strings the cta template fixes (design/04-slides/cta.dc.html).
const CTA_DEFAULTS = { wordmark: 'PaceVector', tagline: 'MOVE WITH PURPOSE', handle: '@PACEVECTOR' };

function parseArgs(argv) {
  const args = { out: path.join(ROOT, 'out'), brand: path.join(ROOT, 'brands', 'pacevector'), qa: true };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--brand') args.brand = path.resolve(argv[++i]);
    else if (a === '--no-qa') args.qa = false;
    else rest.push(a);
  }
  args.brief = rest[0];
  return args;
}

class Blocked extends Error {
  constructor(blocks) { super('deck blocked'); this.blocks = blocks; }
}

const words = (s) => String(s).trim().split(/\s+/).filter(Boolean);
const EMOJI = /\p{Extended_Pictographic}/u;

// Copy rules that block (banned.md "Copy", cover-grammar NEGATIVE LIST / KICKER).
function lintCopy(brief) {
  const blocks = [];
  const texts = [];
  const walk = (val, where) => {
    if (typeof val === 'string') texts.push([where, val]);
    else if (Array.isArray(val)) val.forEach((x, i) => walk(x, `${where}[${i}]`));
    else if (val && typeof val === 'object') for (const [k, x] of Object.entries(val)) if (k !== 'source' && k !== 'figure' && k !== 'layout' && k !== 'deviceData') walk(x, `${where}.${k}`);
  };
  walk(brief.cover, 'cover');
  brief.slides.forEach((s, i) => walk(s, `slides[${i}]`));
  for (const [where, t] of texts) {
    if (/—/.test(t)) blocks.push({ rule: 'no-em-dash', detail: `${where}: "${t}"` });
    if (/!/.test(t)) blocks.push({ rule: 'no-exclamation', detail: `${where}: "${t}"` });
    if (EMOJI.test(t)) blocks.push({ rule: 'no-emoji', detail: `${where}: "${t}"` });
    if (/(^|\s)#\w/.test(t)) blocks.push({ rule: 'no-hashtags', detail: `${where}: "${t}"` });
  }
  if (words(brief.cover.kicker).length > RULES.kickerWordsMax) blocks.push({ rule: 'kicker-words', detail: `kicker has ${words(brief.cover.kicker).length} words, max ${RULES.kickerWordsMax}` });
  return blocks;
}

// Structure rules from deck-rules.md.
function checkStructure(brief) {
  const blocks = [];
  const n = brief.slides.length + 1;
  if (!RULES.slideCount.includes(n)) blocks.push({ rule: 'slide-count', detail: `${n} slides; decks are ${RULES.slideCount.join(' or ')}` });
  const last = brief.slides[brief.slides.length - 1];
  if (!last || last.type !== 'cta') blocks.push({ rule: 'last-slide-cta', detail: `last slide is ${last ? last.type : 'missing'}` });
  const second = brief.slides[0];
  if (second && !(second.type === 'stat' || /\?\s*$/.test(second.headline || ''))) blocks.push({ rule: 'slide-2-stands-alone', detail: 'slide 2 must be a stat or a question that stands alone' });
  let run = 1;
  for (let i = 1; i < brief.slides.length; i++) {
    run = brief.slides[i].type === brief.slides[i - 1].type ? run + 1 : 1;
    if (run > RULES.sameComponentRunMax) blocks.push({ rule: 'component-run', detail: `${brief.slides[i].type} appears ${run} times in a row at slide ${i + 2}` });
  }
  brief.slides.forEach((s, i) => {
    const showsFigure = s.type === 'stat' || s.type === 'metrics-table' || s.type === 'chart' || s.type === 'progress-scale' ||
      (s.type === 'compare' && (s.left.value !== undefined || s.right.value !== undefined));
    if (showsFigure && !s.source) blocks.push({ rule: 'source-row', detail: `slide ${i + 2} (${s.type}) shows a figure without a source row` });
  });
  // Signal validity by ground (cover-grammar SIGNAL).
  const c = brief.cover;
  if (c.signal === 'block' && c.ground !== 'white') blocks.push({ rule: 'signal-ground', detail: 'a signal fill block is white-ground only' });
  if (c.signal === 'type' && c.ground === 'white') blocks.push({ rule: 'signal-ground', detail: 'signal-coloured type is never used on white' });
  if (c.signal === 'mark' && c.subject !== 'conceptual') blocks.push({ rule: 'signal-ground', detail: 'a signal mark belongs to a conceptual device' });
  if (c.subject === 'conceptual' && !c.device) blocks.push({ rule: 'device', detail: 'conceptual covers name a device' });
  if (c.stopTest && c.stopTest.score < RULES.stopTestPass) blocks.push({ rule: 'stop-test', detail: `stop test ${c.stopTest.score}/5, pass is ${RULES.stopTestPass}` });
  return blocks;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.brief) { console.error('usage: node pipeline/render/index.js <brief.json> [--out dir] [--brand dir] [--no-qa]'); process.exit(1); }
  const brief = JSON.parse(fs.readFileSync(args.brief, 'utf8'));
  const schemaErrors = validate(SCHEMA, brief);
  if (schemaErrors.length) { console.error('brief does not match brief.schema.json:\n  ' + schemaErrors.join('\n  ')); process.exit(1); }
  brief.date = brief.date || new Date().toISOString().slice(0, 10);

  const tokens = loadTokens(args.brand);
  const lib = cutouts.loadManifest(args.brand);
  const dataUriCache = new Map();
  lib.dataUri = (c) => { if (!dataUriCache.has(c.id)) dataUriCache.set(c.id, cutouts.fileDataUri(lib, c)); return dataUriCache.get(c.id); };
  const rows = history.readHistory(args.brand);

  // --- rules before anything is rendered -----------------------------------
  const blocks = [...lintCopy(brief), ...checkStructure(brief)];
  const groundCheck = history.checkGround(rows, brief.cover.ground || (rows.length ? 'white' : 'white'));
  if (!brief.cover.ground) {
    brief.cover.ground = rows.length ? groundCheck.required : 'white';
  } else if (!groundCheck.ok) blocks.push(groundCheck);
  const mix = history.checkMix(rows, brief.cover.subject); if (!mix.ok) blocks.push(mix);
  const mode = history.checkMode(rows, brief.cover.mode); if (!mode.ok) blocks.push(mode);
  if (brief.cover.figure && brief.cover.figure.cutout) {
    const cr = history.checkCutout(rows, brief.cover.figure.cutout); if (!cr.ok) blocks.push(cr);
    const cutout = lib.byId.get(brief.cover.figure.cutout);
    if (cutout && !cutouts.allowedOnGround(cutout, brief.cover.ground)) blocks.push({ rule: 'excluded-ground', detail: `${cutout.id} is not allowed on ${brief.cover.ground} (manifest ground: ${cutout.ground})` });
  }
  if (blocks.length) throw new Blocked(blocks);

  const outDir = path.join(args.out, brief.deckId);
  fs.mkdirSync(path.join(outDir, 'html'), { recursive: true });

  const b = await browser.launch();
  try {
    const page = await b.newPage(tokens, 2);
    const ctx = { tokens, cutouts: lib, history: rows, rules: history, show: browser.show };
    const buildPage = (o) => htmlLib.page({ tokens, ...o });

    // Cover.
    let cover;
    try {
      cover = await composeCover(brief, ctx, page, buildPage);
    } catch (e) {
      if (e.blocks) throw new Blocked(e.blocks.map((x) => ({ ...x, stage: 'cover' })));
      throw e;
    }
    const posCheck = history.checkPosition(rows, cover.resolved.position);
    if (!posCheck.ok) throw new Blocked([posCheck]);
    if (cover.resolved.figure) {
      const cr = history.checkCutout(rows, cover.resolved.figure.id);
      if (!cr.ok) throw new Blocked([cr]);
    }

    // Body slides.
    const total = brief.slides.length + 1;
    const pages = [{ html: cover.html, type: 'cover' }];
    brief.slides.forEach((slide, i) => {
      const data = slide.type === 'cta' ? { ...CTA_DEFAULTS, handle: brief.handle || CTA_DEFAULTS.handle, ...slide } : slide;
      const built = buildSlide(data, { series: brief.series, index: i + 2, total, ctx });
      pages.push({ html: buildPage({ slideIndex: i + 2, slideType: slide.type, canvasInner: built.canvasInner, canvasStyle: built.canvasStyle }), type: slide.type });
    });

    // Screenshot each slide at deviceScaleFactor 2.
    const files = [];
    for (let i = 0; i < pages.length; i++) {
      const nn = String(i + 1).padStart(2, '0');
      const htmlFile = path.join(outDir, 'html', `${nn}.html`);
      fs.writeFileSync(htmlFile, pages[i].html);
      await browser.show(page, pages[i].html);
      const jpg = path.join(outDir, `${nn}.jpg`);
      await browser.screenshotJpeg(page, jpg, RULES.jpegQuality);
      files.push(jpg);
    }

    // Cover hash for the history row and the 90-day check.
    const coverHash = await page.evaluate((uri) => window.__pv.phash(uri), `data:image/jpeg;base64,${fs.readFileSync(files[0]).toString('base64')}`);
    cover.resolved.coverHash = coverHash;
    const postedRow = history.toPostedRow(brief, { cutout: cover.resolved.figure ? { id: cover.resolved.figure.id } : null, position: cover.resolved.position, coverHash });
    const deck = {
      deckId: brief.deckId, date: brief.date, rendered: new Date().toISOString(), brand: path.relative(ROOT, args.brand),
      output: { width: tokens.canvas.width * 2, height: tokens.canvas.height * 2, files: files.map((f) => path.basename(f)) },
      brief, cover: cover.resolved, historyChecks: { ground: groundCheck, mix, mode, position: posCheck }, postedRow,
    };
    fs.writeFileSync(path.join(outDir, 'deck.json'), JSON.stringify(deck, null, 2));
    console.log(`rendered ${files.length} slides to ${path.relative(ROOT, outDir)}/ (${tokens.canvas.width * 2}x${tokens.canvas.height * 2})`);
    console.log(`cover: ${brief.cover.subject} · ${brief.cover.mode} · ${brief.cover.ground} · size ${cover.resolved.sizeStep}` +
      (cover.resolved.figure ? ` · ${cover.resolved.figure.id} @ ${cover.resolved.figure.x},${cover.resolved.figure.y} ×${cover.resolved.figure.scale}${cover.resolved.figure.mirror ? ' mirrored' : ''} · position ${cover.resolved.position}` : ''));

    if (args.qa) {
      const review = await qa.review(outDir, { brandDir: args.brand, page, tokens, cutouts: lib, history: rows });
      fs.writeFileSync(path.join(outDir, 'review.json'), JSON.stringify(review, null, 2));
      qa.print(review);
    }
  } finally {
    await b.close();
  }
}

main().catch((e) => {
  if (e instanceof Blocked) {
    console.error('BLOCKED — the deck was not rendered:');
    for (const bl of e.blocks) console.error(`  [${bl.rule}] ${bl.detail}${bl.tried ? '\n    tried: ' + JSON.stringify(bl.tried.slice(0, 4)) : ''}`);
    process.exit(2);
  }
  console.error(e.stack || e);
  process.exit(1);
});
