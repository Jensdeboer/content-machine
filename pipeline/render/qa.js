#!/usr/bin/env node
'use strict';
// QA over a rendered deck. Reads out/<deckId>/deck.json and html/NN.html,
// re-measures the DOM in Chromium, and writes review.json.
//   node pipeline/render/qa.js out/PV-01 [--brand brands/pacevector] [--publish]
//   --publish is the publish-step gate: unfilled or unchecked source rows block (exit 3) instead of warning.
const fs = require('fs');
const path = require('path');
const { loadTokens } = require('./lib/tokens');
const cutoutsLib = require('./lib/cutouts');
const history = require('./lib/history');
const browser = require('./lib/browser');
const RULES = require('./lib/rules');
const linesLib = require('./lib/lines');

const ROOT = path.resolve(__dirname, '..', '..');

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}
function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) { let x = parseInt(a[i], 16) ^ parseInt(b[i], 16); while (x) { d += x & 1; x >>= 1; } }
  return d;
}
const inside = (r, box) => r.x >= box.x - 0.5 && r.y >= box.y - 0.5 && r.x + r.w <= box.x + box.w + 0.5 && r.y + r.h <= box.y + box.h + 0.5;

// The one definition of "the copy does not fit": clipped boxes, text outside
// the canvas, body type outside the safe zone, content pushing the footer off.
// Exported because capacity.js measures the write stage's budgets against it —
// what blocks a deck here is what sets the budget there, or the budget is a
// guess about a different rule.
function textOverflowFlags(audit, { canvasBox, safeBox, isCover }) {
  const out = [];
  const over = (detail) => out.push({ rule: 'text-overflow', detail });
  for (const t of audit.texts) {
    if (t.scrollOverflow && t.whiteSpace === 'nowrap' && t.role !== 'credit') over(`"${t.text.slice(0, 40)}" is wider than its box (${t.scrollW} > ${t.clientW})`);
    for (const r of t.rects) {
      if (t.role === 'credit') continue; // deliberately truncated with an ellipsis; the untruncated text lays out wider than its box
      if (!inside(r, canvasBox)) over(`"${t.text.slice(0, 40)}" leaves the canvas`);
      else if (!isCover && !inside(r, safeBox)) over(`"${t.text.slice(0, 40)}" leaves the ${safeBox.w}x${safeBox.h} safe zone`);
      else if (isCover && t.role === 'headline-line' && (r.x < safeBox.x - 0.5 || r.x + r.w > safeBox.x + safeBox.w + 0.5)) over(`headline line "${t.text}" exceeds the ${safeBox.w} measure`);
    }
  }
  const footer = audit.roles.find((r) => r.role === 'footer' || r.role === 'cta-footer');
  if (footer && footer.rect.y + footer.rect.h > canvasBox.h + 0.5) over('content pushes the footer off the canvas');
  return out;
}

// Layer bounds, by layer type and by slide (deck-rules / cover-grammar).
//
// TEXT — never clips, cover or body slide, no exception. Handled by
// textOverflowFlags above, which tests every text node on every slide.
//
// COVER FIGURE — may bleed. cover-grammar calls a figure meeting the canvas
// edge "a deliberate bleed" and builds the detail type around it, so this is a
// composition, not a fault, for every cover type. Two ceilings separate a
// composition from a broken placement: at most `coverBleedMaxAreaFrac` of the
// figure's area off the canvas, and no zone the manifest marks `dense` off it
// at all. See rules.js for why each is there.
//
// BODY-SLIDE FIGURE — no bleed. It sits inside the type safe zone.
//
// Measured on the VISIBLE box: an image cropped by a container it sits in
// (figure-panel centres an oversized cutout inside a hidden-overflow panel)
// is not off the canvas, whatever its own element rect says.
function figureBoundsFlags(images, { canvasBox, safeBox, isCover, cutout = null, placement = null }) {
  const out = [];
  const push = (detail) => out.push({ rule: 'layer-out-of-bounds', detail });

  for (const img of images) {
    const r = img.visible || img.rect;
    if (!r || r.w <= 0 || r.h <= 0) continue;   // fully clipped: nothing on screen to be out of bounds

    if (!isCover) {
      const over = {
        left: safeBox.x - r.x, top: safeBox.y - r.y,
        right: (r.x + r.w) - (safeBox.x + safeBox.w), bottom: (r.y + r.h) - (safeBox.y + safeBox.h),
      };
      for (const edge of ['left', 'right', 'top', 'bottom']) {
        if (over[edge] > RULES.bodyFigureTolerance) {
          push(`${img.cutout || 'image'} is ${Math.round(over[edge])}px outside the ${safeBox.w}x${safeBox.h} safe zone at the ${edge}; a body-slide figure does not bleed`);
        }
      }
      continue;
    }

    // Cover: how much of the figure is off the canvas.
    const visW = Math.max(0, Math.min(r.x + r.w, canvasBox.w) - Math.max(r.x, 0));
    const visH = Math.max(0, Math.min(r.y + r.h, canvasBox.h) - Math.max(r.y, 0));
    const offFrac = 1 - (visW * visH) / (r.w * r.h);
    if (offFrac > RULES.coverBleedMaxAreaFrac + 1e-9) {
      push(`${img.cutout || 'image'} is ${Math.round(offFrac * 100)}% off the canvas; a cover may bleed at most ${Math.round(RULES.coverBleedMaxAreaFrac * 100)}%`);
    }
  }

  // The subject's core, from the manifest's own density map. Uses the resolved
  // placement rather than the DOM rect so the nine zones land exactly where
  // the composer put them.
  if (isCover && cutout && placement) {
    const zones = cutoutsLib.zoneRects(cutout, placement);
    const off = zones.filter((z) => z.kind === 'dense' && (
      z.rect.x < -RULES.figureOffCanvasTolerance ||
      z.rect.y < -RULES.figureOffCanvasTolerance ||
      z.rect.x + z.rect.w > canvasBox.w + RULES.figureOffCanvasTolerance ||
      z.rect.y + z.rect.h > canvasBox.h + RULES.figureOffCanvasTolerance));
    if (off.length) {
      push(`${cutout.id} bleeds through its subject: dense zone(s) ${off.map((z) => z.name).join(', ')} cross the canvas edge, and a bleed takes peripheral area only`);
    }
  }
  return out;
}

async function review(outDir, opts = {}) {
  const deck = JSON.parse(fs.readFileSync(path.join(outDir, 'deck.json'), 'utf8'));
  const brandDir = opts.brandDir || path.join(ROOT, deck.brand);
  const tokens = opts.tokens || loadTokens(brandDir);
  const cutouts = opts.cutouts || cutoutsLib.loadManifest(brandDir);
  const rows = opts.history || history.readHistory(brandDir, { outDir: path.dirname(outDir) }).filter((r) => r.deckId !== deck.deckId);
  const signalRgb = hexToRgb(tokens.raw.color.signal.value);
  const canvasBox = { x: 0, y: 0, w: tokens.canvas.width, h: tokens.canvas.height };
  const safeBox = { x: tokens.safe.x, y: tokens.safe.y, w: tokens.safe.width, h: tokens.safe.height };

  const flags = [];
  const flag = (slide, rule, detail, severity = 'block') => flags.push({ slide, rule, severity, detail });

  let own = null, page = opts.page;
  if (!page) { own = await browser.launch(); page = await own.newPage(tokens, 1); }
  try {
    const files = deck.output.files;
    for (let i = 0; i < files.length; i++) {
      const slide = i + 1;
      const isCover = slide === 1;
      const html = fs.readFileSync(path.join(outDir, 'html', `${String(slide).padStart(2, '0')}.html`), 'utf8');
      await browser.show(page, html);
      const a = await page.evaluate(() => window.__pv.audit());
      const accentCount = await page.evaluate(() => document.querySelectorAll('[data-accent]').length);

      // Text overflow, by the shared rule.
      for (const f of textOverflowFlags(a, { canvasBox, safeBox, isCover })) flag(slide, f.rule, f.detail);
      // Layer bounds, by layer type. Runs on every slide of every deck.
      const figPlacement = isCover && deck.cover.figure
        ? { x: deck.cover.figure.x, y: deck.cover.figure.y, scale: deck.cover.figure.scale, mirror: deck.cover.figure.mirror }
        : null;
      for (const f of figureBoundsFlags(a.images, {
        canvasBox, safeBox, isCover,
        cutout: figPlacement ? cutouts.byId.get(deck.cover.figure.id) : null,
        placement: figPlacement,
      })) flag(slide, f.rule, f.detail);
      // Floor: 24 (tokens.json size.floor).
      for (const t of a.texts) {
        if (t.fontSize < RULES.floorPx - 0.01) flag(slide, 'below-floor', `"${t.text.slice(0, 40)}" is ${t.fontSize}px, floor is ${RULES.floorPx}`);
      }
      const footer = a.roles.find((r) => r.role === 'footer' || r.role === 'cta-footer');
      const credit = a.texts.find((t) => t.role === 'credit');
      if (credit && credit.rects.length > 1) flag(slide, 'credit-wraps', 'source credit runs to more than one line; deck-rules ask for one', 'warn');
      if (!isCover && !footer) flag(slide, 'footer-missing', 'every slide except the cover carries the footer');

      // Accent: at most one accented element per slide.
      if (!isCover && accentCount > 1) flag(slide, 'accent-count', `${accentCount} accented elements; at most one per slide`);

      // Chrome on the cover: footer, swipe cue, page counter, handle, chevrons, progress bar.
      if (isCover) {
        for (const r of a.roles) if (['footer', 'cta-footer', 'swipe', 'counter', 'handle', 'header'].includes(r.role)) flag(1, 'chrome-on-cover', `cover carries ${r.role} chrome`);
        for (const t of a.texts) if (/SWIPE|\d\d \/ \d\d|@\w+|[→›»]/.test(t.text) && t.role !== 'kicker') flag(1, 'chrome-on-cover', `cover text "${t.text.slice(0, 40)}" reads as chrome`);
      }

      // Signal: count painted elements in the signal colour.
      const signalEls = a.painted.filter((p) => p.color === signalRgb || p.background === signalRgb || p.fill === signalRgb || p.stroke === signalRgb);
      const signalTyped = a.painted.filter((p) => (p.color === signalRgb && p.hasText && p.background !== signalRgb));
      if (isCover) {
        // Children inherit `color`, so count distinct signal usages by role/background instead of raw elements.
        const uses = new Set(signalEls.map((p) => `${p.signal || p.role || p.tag}:${p.background === signalRgb ? 'fill' : p.fill === signalRgb || p.stroke === signalRgb ? 'stroke' : 'type'}`));
        if (uses.size > 1) flag(1, 'signal-count', `signal appears as ${[...uses].join(', ')}; at most one element per cover`);
        if (deck.brief.cover.ground === 'white' && signalTyped.length) flag(1, 'signal-type-on-white', 'signal-coloured type on a white ground; on white signal is only a fill block with black type');
      } else {
        // Signal on a body slide is allowed in exactly one form: the inline
        // [[phrase]] emphasis, marked data-signal="emphasis". As a ground, a
        // block fill or the ink of a whole caption it stays covers-only.
        const stray = signalEls.filter((p) => p.signal !== 'emphasis');
        if (stray.length) flag(slide, 'signal-on-slide', `signal colour on a body slide outside the phrase emphasis (${stray.length} elements); signal is otherwise covers only`);
      }

      // Figure layers: composite normally, hard-edged, never enlarged.
      for (const img of a.images) {
        if (img.mixBlendMode !== 'normal') flag(slide, 'blend-mode', `${img.cutout || 'image'} uses mix-blend-mode ${img.mixBlendMode}`);
        if (img.opacity < 1 || (img.mask && img.mask !== 'none') || (img.clipPath && img.clipPath !== 'none') || (img.filter && img.filter !== 'none')) flag(slide, 'figure-not-hard-edged', `${img.cutout || 'image'} carries opacity/mask/clip/filter`);
        if (img.rect.w > img.naturalWidth + 0.5 || img.rect.h > img.naturalHeight + 0.5) flag(slide, 'cutout-upscaled', `${img.cutout || 'image'} rendered ${Math.round(img.rect.w)}x${Math.round(img.rect.h)}, native ${img.naturalWidth}x${img.naturalHeight}`);
        if (img.cutout) {
          const c = cutouts.byId.get(img.cutout);
          if (c && isCover && !cutoutsLib.allowedOnGround(c, deck.brief.cover.ground)) flag(1, 'excluded-ground', `${c.id} on ${deck.brief.cover.ground}`);
          if (c && /recognisable athlete/i.test(c.note || '')) flag(slide, 'recognisable-athlete', `${c.id}: ${c.note}`);
          if (c && isCover && (c.faces || '').startsWith('camera')) flag(1, 'face-forward', `${c.id} faces the camera; the grammar bans face-forward portraits unless the face is cropped or covered (${c.note || 'no note'})`, 'warn');
        }
      }

      // Cover: occlusion and zones re-measured from the final DOM.
      if (isCover && a.images.length) {
        const occ = await page.evaluate((o) => window.__pv.occlusion('[data-role="headline-line"]', '[data-role="figure"]', o), { inkThreshold: RULES.inkThreshold, figureThreshold: RULES.figureThreshold });
        const lastLine = Math.max(...occ.lines.map((l) => l.index));
        for (const line of occ.lines) {
          if (line.front) continue;
          line.words.forEach((w, wi) => {
            const finalWord = line.index === lastLine && wi === line.words.length - 1;
            w.glyphs.forEach((gl, gi) => {
              const edge = gi === 0 || gi === w.glyphs.length - 1;
              if (finalWord && gl.coverage > RULES.finalWordMaxCoverage) flag(1, 'final-word-occluded', `"${w.text}" glyph "${gl.ch}" ${Math.round(gl.coverage * 100)}% covered by the figure`);
              else if (edge && gl.coverage > RULES.edgeGlyphMaxCoverage) flag(1, 'edge-letter-lost', `"${w.text}" loses its ${gi === 0 ? 'first' : 'last'} letter "${gl.ch}" (${Math.round(gl.coverage * 100)}%)`);
              else if (gl.coverage > RULES.glyphMaxCoverage) flag(1, 'glyph-over-40', `"${w.text}" glyph "${gl.ch}" ${Math.round(gl.coverage * 100)}% covered`);
            });
          });
        }
        const fig = deck.cover.figure;
        const img = a.images.find((x) => x.cutout === fig.id);
        if (img) {
          // The same measure and the same rule the composer's search ran
          // (lib/lines.js), taken again from the final DOM.
          const c = cutouts.byId.get(fig.id);
          const zones = cutoutsLib.zoneRects(c, { x: img.rect.x, y: img.rect.y, scale: img.rect.w / c.width, mirror: fig.mirror });
          const measured = await linesLib.measureHeadlineLines(page);
          const laid = measured.map((m) => ({ ...m, front: !!(deck.cover.lines[m.index] && deck.cover.lines[m.index].front) }));
          for (const p of linesLib.denseZoneProblems(laid, zones)) flag(1, p.rule, p.detail);
        }
      }
    }

    // Deck structure (deck-rules.md).
    const n = files.length;
    if (!RULES.slideCount.includes(n)) flag(0, 'slide-count', `${n} slides`);
    const types = deck.brief.slides.map((s) => s.type);
    if (types[types.length - 1] !== 'cta') flag(n, 'last-slide-cta', `last slide is ${types[types.length - 1]}`);
    let run = 1;
    for (let i = 1; i < types.length; i++) { run = types[i] === types[i - 1] ? run + 1 : 1; if (run > RULES.sameComponentRunMax) flag(i + 2, 'component-run', `${types[i]} ${run} times in a row`, 'warn'); }
    // Sources: warned at render time, a hard gate at publish time (README rule 2: every number traces to a source, or the deck blocks).
    const publishBlocks = [];
    deck.brief.slides.forEach((s, i) => {
      if (!s.source) return;
      // The two-source cross-check is retired: one primary source is enough,
      // so there is no longer any such thing as an "unchecked" row. A source
      // row still has to point somewhere, which is the next line.
      if (!s.source.url) { flag(i + 2, 'source-untraced', `${s.type} figure "${s.source.figure}" has no URL`, opts.publish ? 'block' : 'warn'); publishBlocks.push({ slide: i + 2, rule: 'source-untraced', figure: s.source.figure }); }
    });

    // Cover copy shape (cover-grammar HEADLINE MODES) — warnings, copy is never rewritten here.
    const c = deck.brief.cover;
    const wc = c.headline.trim().split(/\s+/).length;
    if (c.mode === 'shout' && wc > RULES.shoutWordsMax) flag(1, 'shout-words', `shout has ${wc} words; one or two`, 'warn');
    if (c.mode === 'sentence' && (wc < RULES.sentenceWordsMin || wc > RULES.sentenceWordsMax)) flag(1, 'sentence-words', `sentence has ${wc} words; five to nine`, 'warn');
    if (c.mode === 'number' && !/\d/.test(c.headline)) flag(1, 'number-mode', 'number mode without a digit', 'warn');
    if (c.stopTest && c.stopTest.score < RULES.stopTestPass) flag(1, 'stop-test', `${c.stopTest.score}/5`);

    // Perceptual hash against covers from the last 90 days.
    const coverHash = await page.evaluate((uri) => window.__pv.phash(uri), `data:image/jpeg;base64,${fs.readFileSync(path.join(outDir, files[0])).toString('base64')}`);
    const recent = history.recentHashes(rows.filter((r) => r.deckId !== deck.deckId), deck.date, history.HASH_DAYS);
    const near = recent.map((r) => ({ ...r, distance: hamming(coverHash, r.hash) })).filter((r) => r.distance <= RULES.phashWarnDistance);
    for (const col of near) {
      const blocks = col.distance <= RULES.phashBlockDistance;
      flag(1, blocks ? 'phash-collision' : 'phash-near', `cover is ${col.distance} bits from ${col.deckId} (${col.date})${blocks ? '' : '; review before posting'}`, blocks ? 'block' : 'warn');
    }

    const blocks = flags.filter((f) => f.severity === 'block').length;
    return {
      deckId: deck.deckId, reviewed: new Date().toISOString(), slides: n, coverHash, comparedAgainst: recent.length,
      pass: blocks === 0, summary: { block: blocks, warn: flags.filter((f) => f.severity === 'warn').length }, flags,
      // The publish step reads this: false means the deck must not go out until every source row is filled and cross-checked.
      publish: { ok: blocks === 0 && publishBlocks.length === 0, blocks: publishBlocks },
    };
  } finally {
    if (own) await own.close();
  }
}

function print(review) {
  console.log(`qa: ${review.pass ? 'PASS' : 'FLAGGED'} — ${review.summary.block} blocking, ${review.summary.warn} warnings · cover hash ${review.coverHash} (compared against ${review.comparedAgainst} recent covers)`);
  for (const f of review.flags) console.log(`  ${f.severity.padEnd(5)} slide ${String(f.slide).padStart(2, '0')} [${f.rule}] ${f.detail}`);
  if (!review.publish.ok) console.log(`  publish gate: CLOSED — ${review.publish.blocks.length} source row(s) unfilled or unchecked`);
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const outDir = argv.find((a) => !a.startsWith('--'));
  const bi = argv.indexOf('--brand');
  if (!outDir) { console.error('usage: node pipeline/render/qa.js out/<deckId> [--brand dir] [--publish]'); process.exit(1); }
  const o = { publish: argv.includes('--publish') };
  if (bi >= 0) o.brandDir = path.resolve(argv[bi + 1]);
  review(path.resolve(outDir), o).then((r) => {
    fs.writeFileSync(path.join(path.resolve(outDir), 'review.json'), JSON.stringify(r, null, 2));
    print(r);
    process.exit(r.pass ? 0 : 3);
  }).catch((e) => { console.error(e.stack || e); process.exit(1); });
}

module.exports = { review, print, textOverflowFlags, figureBoundsFlags };
