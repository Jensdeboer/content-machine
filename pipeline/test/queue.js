#!/usr/bin/env node
'use strict';
// Queue management in the nightly (config.md queue_target, deck_max_age).
const assert = require('assert');
const { queuePlan, staleDecks, staleRow, stageSourceCheck, MIN_SURVIVAL } = require('../run');

const plan = (a) => { const r = queuePlan(a); return { count: r.count, full: r.full, need: r.need }; };

// No block history: the old behaviour, the shortfall capped at ideasPerRun.
assert.deepStrictEqual(plan({ pending: 0, target: 6, perRun: 5 }), { count: 5, full: false, need: 6 });
assert.deepStrictEqual(plan({ pending: 3, target: 6, perRun: 5 }), { count: 3, full: false, need: 3 });
assert.deepStrictEqual(plan({ pending: 5, target: 6, perRun: 5 }), { count: 1, full: false, need: 1 });
// At or above the target: full. Pick still runs (count is the normal number, for the log); the night stops after it.
assert.deepStrictEqual(plan({ pending: 6, target: 6, perRun: 5 }), { count: 5, full: true, need: 0 });
assert.deepStrictEqual(plan({ pending: 9, target: 6, perRun: 5 }), { count: 5, full: true, need: -3 });
console.log('queuePlan ok (no history)');

// With a block rate, the shortfall is divided by the survival rate: picking
// the bare deficit while half of it blocks never closes the gap.
const sized = (a) => queuePlan({ perRun: 5, maxPerRun: 8, ...a });
assert.strictEqual(sized({ pending: 3, target: 6, blockRate: 0 }).count, 3, 'nothing blocks: pick the deficit');
assert.strictEqual(sized({ pending: 3, target: 6, blockRate: 0.5 }).count, 6, 'half block: pick twice the deficit');
assert.strictEqual(sized({ pending: 5, target: 6, blockRate: 0.5 }).count, 2, 'deficit of one at 50% is two');
assert.strictEqual(sized({ pending: 3, target: 6, blockRate: 0.538 }).count, 7, 'the observed rate, deficit 3');
// The cap holds whatever the arithmetic asks for, and a total-loss night cannot divide by zero.
const worst = sized({ pending: 0, target: 6, blockRate: 1 });
assert.strictEqual(worst.count, 8, 'pick_max caps a bad night');
assert.strictEqual(worst.capped, true, 'and says it was capped');
assert.strictEqual(worst.survival, MIN_SURVIVAL, 'survival is floored, never zero');
assert.ok(Number.isFinite(worst.wanted), 'no division by zero');
// A rate outside 0..1 (a corrupt row, a future counting change) is clamped, not trusted.
assert.strictEqual(sized({ pending: 3, target: 6, blockRate: 2 }).count, 8, 'a rate over 1 clamps to the floor and the cap');
assert.strictEqual(sized({ pending: 3, target: 6, blockRate: -1 }).count, 3, 'a negative rate clamps to zero loss');
// The cap never starves a real deficit down to nothing.
assert.ok(sized({ pending: 5, target: 6, blockRate: 0.99 }).count >= 1, 'always at least one');
// Queue full ignores the block rate entirely.
assert.strictEqual(sized({ pending: 6, target: 6, blockRate: 0.9 }).full, true);
console.log('queuePlan ok (block-rate sizing)');

const now = new Date('2026-09-22T02:00:00Z');
const rows = [
  { deck_key: 'PV-01', topic: 'a', created_at: '2026-09-07T02:00:00Z' },   // 15 days: stale
  { deck_key: 'PV-02', topic: 'b', created_at: '2026-09-08T02:00:01Z' },   // just under 14 days: kept
  { deck_key: 'PV-03', topic: 'c', created_at: '2026-09-20T02:00:00Z' },
  { deck_key: 'PV-04', topic: 'd', created_at: null },
];
assert.deepStrictEqual(staleDecks(rows, 14, now).map((r) => r.deck_key), ['PV-01'], 'older than 14 days, not at 14 days; no date is never stale');
const row = staleRow({ date: '2026-09-22', deck: rows[0], headline: 'A | headline', days: 15 });
assert.match(row, /^\| 2026-09-22 \| a \| A \/ headline \| stale: PV-01 sat pending for 15 days .* \| figure \|\n$/, 'scope figure, pipes escaped');
console.log('staleDecks and staleRow ok');
console.log('queue: ok');
