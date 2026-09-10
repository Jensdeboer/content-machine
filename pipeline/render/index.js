#!/usr/bin/env node
'use strict';
// Deck renderer. Brief JSON in, 5 or 7 JPEGs at 2160x2700 out, then QA.
//   node pipeline/render/index.js pipeline/render/examples/PV-01.json   (a fixture: lands in out/test/)
//   options: --out <dir> (default out) --brand <dir> (default brands/pacevector) --no-qa
const fs = require('fs');
const path = require('path');
const { loadTokens } = require('./lib/tokens');
const { validate } = require('./lib/schema-check');
const history = require('./lib/history');
const cutouts = require('./lib/cutouts');
const htmlLib = require('./lib/html');
const { buildSlide } = require('./lib/slides');
const treatmentsLib = require('./lib/treatments');
const { composeCover } = require('./lib/cover');
const browser = require('./lib/browser');
const RULES = require('./lib/rules');
const qa = require('./qa');

const ROOT = path.resolve(__dirname, '..', '..');
const EXAMPLES = path.join(__dirname, 'examples');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, 'brief.schema.json'), 'utf8'));

// Strings the cta template fixes (design/04-slides/cta.dc.html). Constant
// across every carousel; credit is the slide's only deck input.
const CTA_DEFAULTS = { wordmark: 'PaceVector', tagline: 'MOVE WITH PURPOSE' };

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

// A brief from examples/ is a fixture. Its output never lands next to a real
// deck: whatever --out says, a fixture renders under <out>/test/, so a test
// run can never overwrite out/<deckId> of a deck the nightly produced. The
// fixture carries a real-looking deckId on purpose (the schema demands one),
// which is exactly why the folder, not the id, is what keeps them apart.
const isFixture = (brief) => !!brief && path.resolve(brief).startsWith(EXAMPLES + path.sep);

function fixtureSafeOut(args) {
  if (!isFixture(args.brief)) return args.out;
  if (path.basename(args.out) === 'test') return args.out;
  const out = path.join(args.out, 'test');
  console.log(`fixture brief: output redirected to ${path.relative(ROOT, out)}/`);
  return out;
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
  if (brief.cover.kicker && words(brief.cover.kicker).length > RULES.kickerWordsMax) blocks.push({ rule: 'kicker-words', detail: `kicker has ${words(brief.cover.kicker).length} words, max ${RULES.kickerWordsMax}` });
  return blocks;
}

// Structure rules from deck-rules.md.
const softStructure = [];
function checkStructure(brief) {
  const blocks = [];
  softStructure.length = 0;
  const n = brief.slides.length + 1;
  if (!RULES.slideCount.includes(n)) blocks.push({ rule: 'slide-count', detail: `${n} slides; decks are ${RULES.slideCount.join(' or ')}` });
  const last = brief.slides[brief.slides.length - 1];
  if (!last || last.type !== 'cta') blocks.push({ rule: 'last-slide-cta', detail: `last slide is ${last ? last.type : 'missing'}` });
  // Component runs are a variety rule, not a correctness one: three of the
  // same component in a row reads monotonous, it does not read broken. It is
  // reported and never blocks, like the other variety rules.
  let run = 1;
  for (let i = 1; i < brief.slides.length; i++) {
    run = brief.slides[i].type === brief.slides[i - 1].type ? run + 1 : 1;
    if (run > RULES.sameComponentRunMax) softStructure.push({ ok: false, rule: 'component-run', detail: `${brief.slides[i].type} appears ${run} times in a row at slide ${i + 2}` });
  }
  brief.slides.forEach((s, i) => {
    const showsFigure = s.type === 'stat' || s.type === 'metrics-table' || s.type === 'chart' || s.type === 'progress-scale' ||
      (s.type === 'compare' && (s.left.value !== undefined || s.right.value !== undefined));
    if (showsFigure && !s.source) blocks.push({ rule: 'source-row', detail: `slide ${i + 2} (${s.type}) shows a figure without a source row` });
  });
  // Signal validity by ground (cover-grammar SIGNAL).
  const c = brief.cover;
  if (c.kicker && c.signal) blocks.push({ rule: 'kicker-signal-conflict', detail: 'the kicker chip is already the cover\'s one signal element; signal must be omitted when kicker is set' });
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
  args.out = fixtureSafeOut(args);
  const brief = JSON.parse(fs.readFileSync(args.brief, 'utf8'));
  const schemaErrors = validate(SCHEMA, brief);
  if (schemaErrors.length) { console.error('brief does not match brief.schema.json:\n  ' + schemaErrors.join('\n  ')); process.exit(1); }
  brief.date = brief.date || new Date().toISOString().slice(0, 10);

  const tokens = loadTokens(args.brand);
  const lib = cutouts.loadManifest(args.brand);
  const dataUriCache = new Map();
  lib.dataUri = (c) => { if (!dataUriCache.has(c.id)) dataUriCache.set(c.id, cutouts.fileDataUri(lib, c)); return dataUriCache.get(c.id); };
  // History for every rotation rule: published decks from posted.jsonl plus
  // decks already rendered into this output directory. See lib/history.js.
  // A deck is never its own history: re-rendering PV-07 must not block on the
  // cutout, ground or mode that the previous render of PV-07 chose.
  //
  // A fixture is a regression test and reads only the committed record. Its
  // output directory is shared scratch that collects whatever anyone has
  // rendered lately, and a rotation rule that consulted it would make the
  // fixture's result depend on the contents of out/test rather than on the
  // brief — the same run passing or blocking depending on what sat next to it.
  const fixture = isFixture(args.brief);
  const rows = history.readHistory(args.brand, { outDir: fixture ? null : args.out })
    .filter((r) => r.deckId !== brief.deckId);
  if (fixture) console.log('fixture brief: rotation reads posted.jsonl only, not the output directory');
  // Caption treatment, rotated no-repeat-within-3 over caption-treatments.json.
  const treatments = treatmentsLib.loadTreatments(args.brand, tokens);
  const treatment = treatmentsLib.pick(treatments, rows, history.TREATMENT_WINDOW);
  const treatmentCheck = history.checkTreatment(rows, treatment.id);

  // --- rules before anything is rendered -----------------------------------
  //
  // Two kinds of rule, and they are not enforced the same way.
  //
  // CORRECTNESS is a gate: copy that breaks banned.md, a deck of the wrong
  // shape, a figure with no source row, type or a layer out of bounds. Those
  // block, because shipping them would be wrong.
  //
  // VARIETY is a preference: ground alternation, the subject mix, cutout and
  // position rotation, headline mode runs, kicker spacing, caption treatment
  // and deck shape. Those exist so a week of decks does not look like one
  // deck seven times — a good reason to choose differently, never a reason to
  // throw away a deck that is otherwise correct. They are recorded on the
  // deck (historyChecks) and logged, and they steer selection wherever the
  // composer still has a choice to make. A deck is never blocked by one.
  const blocks = [...lintCopy(brief), ...checkStructure(brief)];
  const preferences = [...softStructure];
  const prefer = (check) => { if (check && !check.ok) preferences.push(check); return check; };

  const groundCheck = history.checkGround(rows, brief.cover.ground || (rows.length ? 'white' : 'white'));
  if (!brief.cover.ground) brief.cover.ground = rows.length ? groundCheck.required : 'white';
  else prefer(groundCheck);
  const mix = prefer(history.checkMix(rows, brief.cover.subject));
  const shape = prefer(history.checkShape(rows, brief.shape));
  const mode = prefer(history.checkMode(rows, brief.cover.mode));
  if (brief.cover.figure && brief.cover.figure.cutout) {
    prefer(history.checkCutout(rows, brief.cover.figure.cutout));
    const cutout = lib.byId.get(brief.cover.figure.cutout);
    // Ground exclusion is not a preference: the manifest says the cutout does
    // not read on this ground, so the composer picks another one instead.
    if (cutout && !cutouts.allowedOnGround(cutout, brief.cover.ground)) {
      console.log(`cover: brief names ${cutout.id}, which the manifest excludes on ${brief.cover.ground}; choosing from the eligible pool instead`);
      delete brief.cover.figure.cutout;
    }
  }
  if (blocks.length) throw new Blocked(blocks);

  const outDir = path.join(args.out, brief.deckId);
  fs.mkdirSync(path.join(outDir, 'html'), { recursive: true });

  const b = await browser.launch();
  try {
    const page = await b.newPage(tokens, 2);
    const ctx = { tokens, cutouts: lib, history: rows, rules: history, show: browser.show, treatment };
    ctx.h = treatmentsLib.helpers(treatment, tokens);
    const buildPage = (o) => htmlLib.page({ tokens, ...o });

    // Cover.
    let cover;
    try {
      cover = await composeCover(brief, ctx, page, buildPage);
    } catch (e) {
      if (e.blocks) throw new Blocked(e.blocks.map((x) => ({ ...x, stage: 'cover' })));
      throw e;
    }
    // The composer already preferred a fresh position, cutout and kicker where
    // it had the choice. What it settled on is recorded either way: a repeat
    // means the pool left nothing fresher, which is a fact about the library,
    // not a fault in the deck.
    const posCheck = prefer(history.checkPosition(rows, cover.resolved.position));
    if (cover.resolved.figure) prefer(history.checkCutout(rows, cover.resolved.figure.id));
    const kickerCheck = prefer(history.checkKicker(rows, !!cover.resolved.kicker));

    // Body slides, each MEASURED before it is committed.
    //
    // A body slide used to be emitted from flow layout and never looked at
    // until qa. Copy longer than the content area then pushed the footer down
    // and out of the safe zone — the recurring "SWIPE →" overflow — and the
    // deck died for a layout nothing had checked. Now the slide is laid out,
    // measured, and re-set one rung tighter (lib/treatments.js COMPACTION)
    // until the content fits the space it has, the same way the cover steps
    // its headline down until it fits the measure.
    const compactions = [];
    const buildAt = (slide, i, level) => {
      const data = slide.type === 'cta' ? { ...slide, ...CTA_DEFAULTS } : slide;
      const h = treatmentsLib.helpers(treatment, tokens, level);
      const built = buildSlide(data, { ctx, h });
      return buildPage({ slideIndex: i + 2, slideType: slide.type, canvasInner: built.canvasInner, canvasStyle: built.canvasStyle });
    };
    // What "fits" means, measured the way the failure actually shows up.
    //
    // The content div is `flex: 1`, so it GROWS to hold its child: comparing
    // the child's height to it is vacuous, it always passes. What overflowing
    // copy really does is push the footer down — and the footer's designed
    // band is the last 96px of the safe zone, so the test is whether the
    // footer still ends inside it. That is the same thing qa flags when it
    // says "SWIPE → leaves the safe zone", checked before the deck is written
    // rather than after.
    const designedContentH = tokens.canvas.height - 2 * tokens.margin - tokens.footerHeight;
    const safeBottom = tokens.safe.y + tokens.safe.height;
    const canvasBox = { x: 0, y: 0, w: tokens.canvas.width, h: tokens.canvas.height };
    const safeBox = { x: tokens.safe.x, y: tokens.safe.y, w: tokens.safe.width, h: tokens.safe.height };
    const contentFits = async (html) => {
      await browser.show(page, html);
      const box = await page.evaluate(({ maxH, bottom }) => {
        const cv = document.querySelector('[data-role="canvas"]');
        const content = cv.querySelector('[data-role="content"]');
        if (!content) return { fits: true, have: 0, maxH, footBottom: 0 };
        const base = cv.getBoundingClientRect();
        const foot = cv.querySelector('[data-role="footer"],[data-role="cta-footer"]');
        const have = content.getBoundingClientRect().height;
        const footBottom = foot ? foot.getBoundingClientRect().bottom - base.top : 0;
        return {
          fits: have <= maxH + 0.5 && (!foot || footBottom <= bottom + 0.5),
          have: Math.round(have), maxH, footBottom: Math.round(footBottom),
        };
      }, { maxH: designedContentH, bottom: safeBottom });

      // Vertical fit is only half of it. Copy can also run out SIDEWAYS — a
      // wide stat value, a long compare label — and the ladder's smaller type
      // is exactly the fix, but only if something looks. Measured with qa's
      // own rule, so what the ladder chases is what qa would otherwise block.
      const audit = await page.evaluate(() => window.__pv.audit());
      const overflow = qa.textOverflowFlags(audit, { canvasBox, safeBox, isCover: false });
      return { ...box, fits: box.fits && overflow.length === 0, overflow: overflow.map((o) => o.detail) };
    };
    const pages = [{ html: cover.html, type: 'cover' }];
    for (let i = 0; i < brief.slides.length; i++) {
      const slide = brief.slides[i];
      let html = null, level = 0, last = null;
      for (; level < treatmentsLib.COMPACTION.length; level++) {
        html = buildAt(slide, i, level);
        last = await contentFits(html);
        if (last.fits) break;
      }
      if (!last.fits) {
        // Every rung tried and the copy still does not fit: that is too much
        // copy, not a layout that needs another notch, and it says so.
        throw new Blocked([{
          rule: 'slide-does-not-fit',
          detail: `slide ${i + 2} (${slide.type}) still does not fit at the tightest setting: ${last.have}px of content in ${last.maxH}px, footer ending at ${last.footBottom}`
            + `${last.overflow && last.overflow.length ? `; ${last.overflow.join('; ')}` : ''}`
            + '. The copy is over what the component holds — see component-capacity.json.',
        }]);
      }
      if (level > 0) compactions.push({ slide: i + 2, type: slide.type, level });
      pages.push({ html, type: slide.type });
    }
    if (compactions.length) {
      console.log(`fit: ${compactions.map((c) => `slide ${c.slide} (${c.type}) tightened to level ${c.level}`).join(', ')}`);
    }

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
    cover.resolved.treatment = treatment.id;
    const postedRow = history.toPostedRow(brief, { cutout: cover.resolved.figure ? { id: cover.resolved.figure.id } : null, position: cover.resolved.position, kicker: cover.resolved.kicker, treatment: treatment.id, coverHash });
    const deck = {
      deckId: brief.deckId, date: brief.date, rendered: new Date().toISOString(), brand: path.relative(ROOT, args.brand),
      output: { width: tokens.canvas.width * 2, height: tokens.canvas.height * 2, files: files.map((f) => path.basename(f)) },
      brief, cover: cover.resolved, compactions, historyChecks: { ground: groundCheck, mix, mode, position: posCheck, kicker: kickerCheck, treatment: treatmentCheck, shape }, unmetPreferences: preferences, postedRow,
    };
    fs.writeFileSync(path.join(outDir, 'deck.json'), JSON.stringify(deck, null, 2));
    console.log(`rendered ${files.length} slides to ${path.relative(ROOT, outDir)}/ (${tokens.canvas.width * 2}x${tokens.canvas.height * 2})`);
    console.log(`caption treatment: ${treatment.id} (${treatmentCheck.detail})`);
    console.log(`cover: ${brief.cover.subject} · ${brief.cover.mode} · ${brief.cover.ground} · size ${cover.resolved.sizeStep}` +
      (cover.resolved.figure ? ` · ${cover.resolved.figure.id} @ ${cover.resolved.figure.x},${cover.resolved.figure.y} ×${cover.resolved.figure.scale}${cover.resolved.figure.mirror ? ' mirrored' : ''} · position ${cover.resolved.position}` : ''));

    if (preferences.length) {
      console.log(`variety: ${preferences.length} preference(s) the pool could not satisfy tonight (recorded, not blocking):`);
      for (const p of preferences) console.log(`  [${p.rule}] ${p.detail}`);
    }

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
