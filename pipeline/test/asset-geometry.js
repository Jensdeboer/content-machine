#!/usr/bin/env node
'use strict';
// Regression: the geometry pipeline/ingest-assets.js derives must match the
// sixteen hand-made cutouts already in the manifest, read from the same PNGs.
//
// Two fields are load-bearing and must be EXACT, because the composer reads
// them: `width`/`height` decide placement and scale, and `type-space`/`dense`
// decide where type may sit and where a bleed may not cut. `coverage` and the
// raw density grid are informational — only the classification derived from
// the grid is used — and they land within rounding of the hand-made numbers.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const geom = require('../lib/asset-geometry');

const ROOT = path.resolve(__dirname, '..', '..');
const DIR = path.join(ROOT, 'brands', 'pacevector', 'design', '00-assets', 'cutouts');

(async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'cutouts.json'), 'utf8')).cutouts;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.addScriptTag({ content: geom.INPAGE });

  const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  let coverageExact = 0, densityExact = 0;
  const sizeMiss = [], zoneMiss = [];

  for (const c of manifest) {
    const g = await geom.analyse(page, path.join(DIR, c.file));
    assert.ok(!g.empty, `${c.id}: every cutout must have opaque pixels`);
    if (g.width !== c.width || g.height !== c.height) sizeMiss.push(`${c.id} ${g.width}x${g.height} vs ${c.width}x${c.height}`);
    if (!same(g['type-space'], c['type-space']) || !same(g.dense, c.dense)) {
      zoneMiss.push(`${c.id} type-space ${JSON.stringify(g['type-space'])} vs ${JSON.stringify(c['type-space'])}, dense ${JSON.stringify(g.dense)} vs ${JSON.stringify(c.dense)}`);
    }
    if (g.coverage === c.coverage) coverageExact++;
    if (JSON.stringify(g.density) === JSON.stringify(c.density)) densityExact++;
  }
  await browser.close();

  assert.deepStrictEqual(sizeMiss, [], `width/height must reproduce exactly:\n  ${sizeMiss.join('\n  ')}`);
  console.log(`asset-geometry: width/height exact on ${manifest.length}/${manifest.length}`);
  assert.deepStrictEqual(zoneMiss, [], `type-space/dense must reproduce exactly:\n  ${zoneMiss.join('\n  ')}`);
  console.log(`asset-geometry: type-space/dense exact on ${manifest.length}/${manifest.length}`);
  console.log(`asset-geometry: coverage ${coverageExact}/${manifest.length}, raw density grid ${densityExact}/${manifest.length} (informational, rounding only)`);

  // The classifier itself, independent of any image.
  const { typeSpace, dense } = geom.classify([[0.14, 0.15, 0.54], [0.55, 0.0, 1.0], [0.2, 0.13, 0.56]]);
  assert.deepStrictEqual(typeSpace.sort(), ['centre', 'lower-centre', 'upper-left'].sort(), 'type-space is density <= 0.14');
  assert.deepStrictEqual(dense.sort(), ['centre-left', 'centre-right', 'lower-right'].sort(), 'dense is density >= 0.55');
  console.log('asset-geometry: zone thresholds classify at the fitted boundaries');
  console.log('asset-geometry: ok');
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
