#!/usr/bin/env node
'use strict';
// Queue management in the nightly (config.md queue_target, deck_max_age).
const assert = require('assert');
const { queuePlan, staleDecks, staleRow } = require('../run');

// Below the target: only the shortfall, capped at ideasPerRun, never under one.
assert.deepStrictEqual(queuePlan({ pending: 0, target: 6, perRun: 5 }), { count: 5, full: false, need: 6 });
assert.deepStrictEqual(queuePlan({ pending: 3, target: 6, perRun: 5 }), { count: 3, full: false, need: 3 });
assert.deepStrictEqual(queuePlan({ pending: 5, target: 6, perRun: 5 }), { count: 1, full: false, need: 1 });
// At or above the target: full. Pick still runs (count is the normal number, for the log); the night stops after it.
assert.deepStrictEqual(queuePlan({ pending: 6, target: 6, perRun: 5 }), { count: 5, full: true, need: 0 });
assert.deepStrictEqual(queuePlan({ pending: 9, target: 6, perRun: 5 }), { count: 5, full: true, need: -3 });
console.log('queuePlan ok');

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
