'use strict';
// posted.jsonl: one JSON object per line, appended by the publish step after a
// post goes out. The renderer only reads it. Row shape is documented in
// brief.schema.json under $defs.postedRow.
const fs = require('fs');
const path = require('path');

const MIX_WINDOW = 20;
const MIX_QUOTA = { 'full-figure': 14, detail: 3, 'type-led': 2, conceptual: 1 }; // cover-grammar SUBJECT MIX
const CUTOUT_WINDOW = 5;   // deck-rules: no cutout repeated within 5 posts
const POSITION_WINDOW = 5; // cover-grammar ROTATION: no cutout position repeated within five posts
const MODE_RUN = 3;        // cover-grammar ROTATION: no headline mode three posts running
const HASH_DAYS = 90;      // deck-rules quality gate: perceptual-hash check, last 90 days

function readHistory(brandDir) {
  const file = path.join(brandDir, 'memory', 'posted.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => {
      try { return JSON.parse(l); } catch (e) { throw new Error(`posted.jsonl line ${i + 1} is not JSON`); }
    });
}

// ground-deep counts as navy for the alternation (cover-grammar GROUND).
function groundFamily(ground) {
  if (ground === 'white') return 'white';
  if (ground === 'navy' || ground === 'deep') return 'navy';
  throw new Error(`unknown ground "${ground}"`);
}

// Every rule returns { ok, rule, detail }.
function checkGround(rows, ground) {
  const fam = groundFamily(ground);
  if (rows.length === 0) return { ok: true, rule: 'ground-alternation', detail: 'no history; any ground' };
  const last = groundFamily(rows[rows.length - 1].ground);
  const required = last === 'white' ? 'navy' : 'white';
  return {
    ok: fam === required,
    rule: 'ground-alternation',
    detail: `last post was ${last}, this post must be ${required}, brief has ${ground}`,
    required,
  };
}

function checkMix(rows, subject) {
  const window = rows.slice(-(MIX_WINDOW - 1));
  const counts = {};
  for (const r of window) counts[r.subject] = (counts[r.subject] || 0) + 1;
  counts[subject] = (counts[subject] || 0) + 1;
  const quota = MIX_QUOTA[subject];
  if (quota === undefined) return { ok: false, rule: 'subject-mix', detail: `unknown subject "${subject}"` };
  return {
    ok: counts[subject] <= quota,
    rule: 'subject-mix',
    detail: `${subject} would be ${counts[subject]} of the last ${Math.min(rows.length + 1, MIX_WINDOW)} posts; quota is ${quota} per ${MIX_WINDOW}`,
    counts,
  };
}

function checkCutout(rows, cutoutId) {
  if (!cutoutId) return { ok: true, rule: 'cutout-rotation', detail: 'no cutout on this cover' };
  const recent = rows.slice(-CUTOUT_WINDOW).map((r) => r.cutout).filter(Boolean);
  return {
    ok: !recent.includes(cutoutId),
    rule: 'cutout-rotation',
    detail: recent.includes(cutoutId)
      ? `${cutoutId} was used within the last ${CUTOUT_WINDOW} posts`
      : `${cutoutId} not used in the last ${CUTOUT_WINDOW} posts`,
  };
}

function checkPosition(rows, position) {
  if (!position) return { ok: true, rule: 'position-rotation', detail: 'no figure position on this cover' };
  const recent = rows.slice(-POSITION_WINDOW).map((r) => r.position).filter(Boolean);
  return {
    ok: !recent.includes(position),
    rule: 'position-rotation',
    detail: recent.includes(position)
      ? `figure position "${position}" was used within the last ${POSITION_WINDOW} posts`
      : `position "${position}" is fresh`,
  };
}

function checkMode(rows, mode) {
  const recent = rows.slice(-(MODE_RUN - 1)).map((r) => r.mode);
  const sameRun = recent.length === MODE_RUN - 1 && recent.every((m) => m === mode);
  return {
    ok: !sameRun,
    rule: 'mode-rotation',
    detail: sameRun ? `"${mode}" would be the ${MODE_RUN}rd ${mode} cover in a row` : `mode "${mode}" ok after [${recent.join(', ')}]`,
  };
}

function recentHashes(rows, dateIso, days = HASH_DAYS) {
  const t = Date.parse(dateIso);
  return rows
    .filter((r) => r.coverHash && r.date && t - Date.parse(r.date) <= days * 86400000 && t - Date.parse(r.date) >= 0)
    .map((r) => ({ deckId: r.deckId, date: r.date, hash: r.coverHash }));
}

// The row the publish step should append once the post is live.
function toPostedRow(brief, resolved) {
  return {
    deckId: brief.deckId,
    date: brief.date,
    series: brief.series,
    ground: brief.cover.ground,
    subject: brief.cover.subject,
    mode: brief.cover.mode,
    cutout: resolved.cutout ? resolved.cutout.id : null,
    position: resolved.position || null,
    signal: brief.cover.signal || null,
    coverHash: resolved.coverHash || null,
  };
}

module.exports = {
  readHistory, groundFamily, checkGround, checkMix, checkCutout, checkPosition, checkMode, recentHashes, toPostedRow,
  MIX_WINDOW, MIX_QUOTA, CUTOUT_WINDOW, POSITION_WINDOW, MODE_RUN, HASH_DAYS,
};
