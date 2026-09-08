#!/usr/bin/env node
'use strict';
// Regression: PV-07, 8 Sep 2026. fig-stretch-seated at scale 0.8, headline
// "Motivation is / not a plan" at top 180, Sora at 140px, left aligned. The
// composer's synthetic line box ended one pixel above the figure box, so the
// line was never zone-tested; QA measured the real text rect 17px into the
// upper-centre dense zone and blocked the deck after the render.
//
// The rule now runs inside the search on the shared measurement, so this
// case must fail the search, never QA:
//   1. pinned figure, pinned top, no line allowed in front: the search has
//      nowhere to go and blocks before anything is rendered (exit 2).
//   2. pinned figure, pinned top, fix order allowed: the search moves the
//      offending line in front, the deck renders, QA raises no zone flag.
//   3. the shared measure itself sees the crossing at that geometry.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const cut = require('../lib/cutouts');
const lines = require('../lib/lines');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const RENDER = path.join(ROOT, 'pipeline', 'render', 'index.js');
const EXAMPLES = path.join(ROOT, 'pipeline', 'render', 'examples');
const OUT = path.join(ROOT, 'out', 'test');
const BRAND = path.join(ROOT, 'brands', 'pacevector');

function render(fixture) {
  const r = spawnSync(process.execPath, [RENDER, path.join(EXAMPLES, fixture), '--out', OUT, '--brand', BRAND], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// 1. Nowhere to go: blocked in the search, nothing written.
{
  const deckDir = path.join(OUT, 'PV-907');
  fs.rmSync(deckDir, { recursive: true, force: true });
  const r = render('regress-pv07-dense-zone-pinned.json');
  assert.strictEqual(r.code, 2, `expected the search to block (exit 2), got ${r.code}\n${r.err}\n${r.out}`);
  assert.match(r.err, /cover-layout/, `expected a cover-layout block, got:\n${r.err}`);
  assert.ok(!fs.existsSync(path.join(deckDir, '01.jpg')), 'a blocked search must not render');
  console.log('1. pinned layout with no line allowed in front: blocked by the search, nothing rendered');
}

// 2. Fix order: the search moves "not a plan" in front; QA finds nothing.
let deck;
{
  const deckDir = path.join(OUT, 'PV-908');
  fs.rmSync(deckDir, { recursive: true, force: true });
  const r = render('regress-pv07-dense-zone-fixorder.json');
  assert.strictEqual(r.code, 0, `expected a clean render, got exit ${r.code}\n${r.err}\n${r.out}`);
  deck = JSON.parse(fs.readFileSync(path.join(deckDir, 'deck.json'), 'utf8'));
  const review = JSON.parse(fs.readFileSync(path.join(deckDir, 'review.json'), 'utf8'));
  const f = deck.cover.figure;
  assert.deepStrictEqual([f.id, f.x, f.y, f.scale], ['fig-stretch-seated', 164, 461, 0.8], 'the pinned figure must hold');
  assert.strictEqual(deck.cover.headlineTop, 180, 'the pinned top must hold');
  assert.strictEqual(deck.cover.lines[1].text, 'not a plan');
  assert.strictEqual(deck.cover.lines[1].front, true, 'the search must have moved "not a plan" in front');
  const zoneFlags = review.flags.filter((x) => x.rule === 'headline-in-dense-zone');
  assert.deepStrictEqual(zoneFlags, [], `QA must not be the one to catch this:\n${JSON.stringify(zoneFlags)}`);
  console.log('2. fix order allowed: search moved "not a plan" in front, rendered, QA raised no zone flag');
}

// 3. The shared measure sees the crossing when the line is treated as behind.
{
  const lib = cut.loadManifest(BRAND);
  const c = lib.byId.get('fig-stretch-seated');
  const zones = cut.zoneRects(c, { x: 164, y: 461, scale: 0.8, mirror: false });
  const laid = deck.cover.lines.map((l, i) => ({ index: i, text: l.text, rect: l.rect, front: false }));
  assert.ok(laid.every((l) => l.rect && l.rect.h > 0), 'deck.json must carry the measured rect of every line');
  const problems = lines.denseZoneProblems(laid, zones);
  assert.ok(problems.some((p) => p.line === 1 && p.zone === 'upper-centre'), `expected line 1 in upper-centre, got ${JSON.stringify(problems)}`);
  assert.ok(laid[1].rect.y + laid[1].rect.h > 461, 'the measured rect must extend past the figure box top');
  console.log(`3. shared measure: "not a plan" rect ${Math.round(laid[1].rect.y)}..${Math.round(laid[1].rect.y + laid[1].rect.h)} crosses the box top at 461 into upper-centre (dense)`);
}
console.log('pv07-dense-zone: ok');
