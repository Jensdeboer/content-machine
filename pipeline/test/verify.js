#!/usr/bin/env node
'use strict';
// Verify as a classifier (config.md, Verify tiers).
//
// The property that matters: exactly one tier stops a deck. The others are
// descriptions of what a claim is, and a deck of nothing but common knowledge
// is as shippable as one resting on a paper. The second property: FIGURE-BACKED
// is checked, not taken on the model's word — a claim the model labels
// figure-backed but whose paper is paywalled, unlicensed or has no relevant
// figure comes back SOURCED, never blocks, and says why.
const assert = require('assert');
const { stageVerify, sourceLine, TIERS } = require('../run');

const cfg = { models: { verifyWebTools: false } };
const brain = { files: { sources: '# sources.md\nPrimary: peer-reviewed journals, ACSM position stands.' } };
const idea = { topic: 't', series: 'Science', angle: 'a', figures: ['80% of volume easy'] };
const quiet = () => {};
const src = (over = {}) => ({
  quote: 'the sentence', url: 'https://example.org/p', publisher: 'J', retrieved: '2026-09-10',
  firstAuthor: 'Matomäki P', year: 2023, n: 30, ...over,
});
const run = (claims, evidenceCheck) => stageVerify({
  cfg, brain, idea, evidence: [], log: quiet,
  call: async () => ({ claims }),
  evidenceCheck: evidenceCheck || (async () => ({ ok: false, why: 'not checked' })),
});

(async () => {
  assert.deepStrictEqual(TIERS, ['figure-backed', 'sourced', 'common-knowledge', 'fabricated']);

  // 1. Common knowledge passes with no source at all — the prescriptive case.
  {
    const v = await run([
      { text: 'keep 80% of volume easy', figure: '80%', tier: 'common-knowledge', why: 'prescriptive, not a finding' },
      { text: 'easy runs should feel easy', figure: null, tier: 'common-knowledge', why: 'qualitative' },
    ]);
    assert.strictEqual(v.counts['common-knowledge'], 2);
    assert.deepStrictEqual(v.sources, [], 'common knowledge contributes no source row');
    assert.strictEqual(sourceLine(v.sources), '', 'and no caption source line');
  }
  console.log('verify: prescriptive numbers and qualitative claims pass unsourced');

  // 2. One source is enough — the retired cross-check must not resurface.
  {
    const v = await run([{ text: 'drift was 7.7%', figure: '7.7%', tier: 'sourced', source: src() }]);
    assert.strictEqual(v.counts.sourced, 1);
    assert.strictEqual(v.sources.length, 1);
    assert.strictEqual(v.sources[0].crossChecked, true, 'nothing is "unchecked" once the two-source rule is gone');
  }
  console.log('verify: a single primary source is enough');

  // 3. Only FABRICATED blocks, and it names the claim.
  {
    await assert.rejects(
      run([
        { text: 'runners lose 12% VO2max in a week', figure: '12%', tier: 'fabricated', why: 'no source states it' },
        { text: 'easy is easy', figure: null, tier: 'common-knowledge' },
      ]),
      (e) => /fabricated claim/.test(e.message) && /12%/.test(e.message),
    );
  }
  console.log('verify: fabricated blocks, and says which claim');

  // 4. A claim that owes a source and lacks a usable one is fabricated
  //    whatever it was labelled: the label is the model's, the url is checkable.
  for (const [over, why] of [[{ url: null }, 'no url'], [{ url: 'notaurl' }, 'no url'], [{ quote: null }, 'no quote'], [{ retrieved: null }, 'no retrieval date']]) {
    await assert.rejects(
      run([{ text: 'x', figure: '9%', tier: 'sourced', source: src(over) }]),
      (e) => new RegExp(why.split(' ')[1]).test(e.message),
      `a sourced claim with ${why} must not pass`,
    );
  }
  await assert.rejects(run([{ text: 'x', figure: '9%', tier: 'sourced' }]), /fabricated/);
  console.log('verify: a sourced claim with no usable source is fabricated, not sourced');

  // 5. An unknown tier is treated as fabricated rather than waved through.
  await assert.rejects(run([{ text: 'x', figure: '9%', tier: 'probably-fine' }]), /fabricated/);
  console.log('verify: an unrecognised tier fails closed');

  // 6. FIGURE-BACKED is checked. When the check fails the claim is SOURCED,
  //    the deck still ships, and the reason is recorded on the claim.
  {
    const v = await run(
      [{ text: 'drift 7.7%', figure: '7.7%', tier: 'figure-backed', source: src({ pmcid: 'PMC9977827' }) }],
      async () => ({ ok: false, why: 'the paper is not open access' }),
    );
    assert.strictEqual(v.counts['figure-backed'], 0);
    assert.strictEqual(v.counts.sourced, 1, 'demoted, not blocked');
    assert.match(v.claims[0].why || '', /not figure-backed: the paper is not open access/);
  }
  console.log('verify: an unverifiable figure-backed claim demotes to sourced');

  // 7. When the check passes, the figure travels with the claim.
  {
    const v = await run(
      [{ text: 'drift 7.7%', figure: '7.7%', tier: 'figure-backed', source: src({ pmcid: 'PMC9977827' }) }],
      async () => ({
        ok: true,
        paper: { pmcid: 'PMC9977827', licence: 'cc by', journal: 'Frontiers in physiology', firstAuthor: 'Matomäki P', year: 2023 },
        figure: { label: 'FIGURE 3', caption: 'Mean (SD) heart rate...', href: 'g003.jpg', url: 'https://europepmc.org/x', score: 0.5 },
      }),
    );
    assert.strictEqual(v.counts['figure-backed'], 1);
    const e = v.claims[0].evidence;
    for (const k of ['pmcid', 'licence', 'journal', 'firstAuthor', 'year', 'n', 'figureLabel', 'figureCaption', 'figureFile', 'figureUrl']) {
      assert.ok(e[k] !== undefined && e[k] !== null, `figure evidence must carry ${k}`);
    }
    assert.strictEqual(e.imagePath, null, 'the image is a reference, not a file: see lib/evidence.js');
    assert.strictEqual(v.sources[0].tier, 'figure-backed');
  }
  console.log('verify: a checked figure-backed claim carries pmcid, licence, caption and figure');

  // 8. The caption source line: Instagram format, deduped, common knowledge excluded.
  assert.strictEqual(
    sourceLine([{ tier: 'figure-backed', firstAuthor: 'Matomäki P', year: 2023 }, { tier: 'sourced', firstAuthor: 'Wang', year: 2022 }]),
    'Source: Matomäki et al. 2023, Wang et al. 2022');
  assert.strictEqual(
    sourceLine([{ tier: 'sourced', firstAuthor: 'Wang', year: 2022 }, { tier: 'sourced', firstAuthor: 'Wang', year: 2022 }]),
    'Source: Wang et al. 2022', 'the same paper twice is one credit');
  assert.strictEqual(sourceLine([{ tier: 'sourced', year: 2022 }]), '', 'no author, no line');
  console.log('verify: caption source line formats, dedupes and skips unsourced decks');

  console.log('verify: ok');
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
