#!/usr/bin/env node
'use strict';
// The sourceability pre-check inside PICK (config.md sourceability_precheck).
//
// The property that matters is not "does it drop bad ideas" — verify would
// have dropped them anyway, later and more expensively. It is that the
// pre-check can ONLY remove candidates: it must never hand verify a source, a
// url, or a "checked already" flag, because anything it asserted would be an
// assertion verify did not make. These tests pin that shape.
const assert = require('assert');
const { stageSourceCheck } = require('../run');

const brain = { files: { sources: '# sources.md\nPrimary tier: peer-reviewed journals, ACSM position stands.' } };
const quiet = () => {};

// The slice of config the stage reads. Nothing else is needed.
function cfgWith() {
  return { run: { sourceabilityPrecheck: true }, models: { sourceCheckWebTools: false } };
}

// stageSourceCheck takes its model call as a parameter (defaulting to the real
// one), so these cases pin the stage's own logic with no network, no CLI and
// no fixture file in the way.

const IDEAS = [
  { topic: 'ten-percent-rule', series: 'Science', angle: 'a', figures: ['cap weekly mileage increases at ~10%'] },
  { topic: 'easy-pace-effort', series: 'Running 101', angle: 'b', figures: ['80% of weekly running at easy effort'] },
  { topic: 'show-up-on-flat-days', series: 'Mindset', angle: 'c', figures: [] },
];

(async () => {
  // 1. An explicit false drops that candidate and only that one.
  {
    const call = async () => ({
      verdicts: [
        { topic: 'ten-percent-rule', sourceable: false, reason: 'a coaching rule of thumb; no study states it' },
        { topic: 'easy-pace-effort', sourceable: true, reason: 'intensity-distribution literature covers it' },
      ],
    });
    const r = await stageSourceCheck({ cfg: cfgWith(), brain, ideas: IDEAS, evidence: [], log: quiet, call });
    assert.deepStrictEqual(r.kept.map((i) => i.topic), ['easy-pace-effort', 'show-up-on-flat-days']);
    assert.deepStrictEqual(r.dropped.map((d) => d.topic), ['ten-percent-rule']);
    // The survivors are the SAME objects, untouched: no source, no url, no flag.
    assert.strictEqual(r.kept[0], IDEAS[1], 'a kept idea is passed through by reference, not rebuilt');
    assert.deepStrictEqual(Object.keys(r.kept[0]).sort(), ['angle', 'figures', 'series', 'topic'],
      'the pre-check adds no field a later stage could mistake for a verification');
  }
  console.log('sourcecheck: drops only the explicit false, and adds nothing to survivors');

  // 2. Fails open: a thrown call keeps every candidate for verify to judge.
  {
    const call = async () => { throw new Error('transport'); };
    const r = await stageSourceCheck({ cfg: cfgWith(), brain, ideas: IDEAS, evidence: [], log: quiet, call });
    assert.deepStrictEqual(r.kept.map((i) => i.topic), IDEAS.map((i) => i.topic));
    assert.deepStrictEqual(r.dropped, []);
    assert.match(r.failed, /transport/);
  }
  console.log('sourcecheck: a failed call keeps everything (fails open)');

  // 3. Fails open on junk: missing verdicts, unknown topics, non-boolean values.
  {
    const call = async () => ({
      verdicts: [
        { topic: 'not-a-candidate', sourceable: false, reason: 'irrelevant' },
        { topic: 'ten-percent-rule', sourceable: 'no' },      // a string, not false
        { topic: 'easy-pace-effort' },                         // no verdict at all
        null,
      ],
    });
    const r = await stageSourceCheck({ cfg: cfgWith(), brain, ideas: IDEAS, evidence: [], log: quiet, call });
    assert.deepStrictEqual(r.kept.map((i) => i.topic), IDEAS.map((i) => i.topic),
      'only an explicit boolean false drops a candidate');
    assert.deepStrictEqual(r.dropped, []);
  }
  console.log('sourcecheck: junk verdicts keep everything');

  // 4. An idea with no figures is never sent for checking — there is nothing to source.
  {
    let sawPrompt = null;
    const call = async (args) => { sawPrompt = args.prompt; return { verdicts: [] }; };
    const r = await stageSourceCheck({ cfg: cfgWith(), brain, ideas: [IDEAS[2]], evidence: [], log: quiet, call });
    assert.strictEqual(sawPrompt, null, 'no candidates with figures means no model call at all');
    assert.strictEqual(r.checked, 0);
    assert.deepStrictEqual(r.kept, [IDEAS[2]]);
  }
  console.log('sourcecheck: figureless ideas skip the check entirely');

  // 5. Every candidate rejected still returns a well-formed empty keep list
  //    rather than throwing — the night comes up short and says so.
  {
    const call = async () => ({
      verdicts: [
        { topic: 'ten-percent-rule', sourceable: false, reason: 'x' },
        { topic: 'easy-pace-effort', sourceable: false, reason: 'y' },
      ],
    });
    const r = await stageSourceCheck({ cfg: cfgWith(), brain, ideas: IDEAS.slice(0, 2), evidence: [], log: quiet, call });
    assert.deepStrictEqual(r.kept, []);
    assert.strictEqual(r.dropped.length, 2);
  }
  console.log('sourcecheck: a total wipeout is empty, not an exception');

  console.log('sourcecheck: ok');
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
