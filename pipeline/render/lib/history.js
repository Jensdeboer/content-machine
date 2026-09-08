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
const KICKER_RUN = 2;      // deck-rules: no kicker chip two posts running
const CHIP_WINDOW = 20;    // deck-rules: at most 7 chips per rolling 20 (alongside the 14/3/2/1 mix)
const CHIP_QUOTA = 7;
const HASH_DAYS = 90;      // deck-rules quality gate: perceptual-hash check, last 90 days
const TREATMENT_WINDOW = 3; // caption-treatments: no caption treatment repeated within 3 decks
const SHAPE_WINDOW = 3;     // brief.shape: no deck shape repeated within 3 decks

function readPosted(brandDir) {
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

// Decks that have been rendered but not yet published. Every render writes its
// own postedRow into out/<deckId>/deck.json, so this reconstructs the same row
// shape without the renderer needing state.db.
//
// Why this exists: every rotation rule below reads posted.jsonl, which the
// confirm step only appends to AFTER a post goes live. Until the first post
// lands that file is empty, so ground alternation, the subject mix, cutout and
// position no-repeat, mode and kicker runs and the phash check all evaluated
// against zero rows and silently passed anything — which is how eight decks in
// a row came out white, full-figure and drawn from two cutouts. A deck that has
// been rendered is history for rotation purposes whether or not it has posted.
function readRendered(outDir) {
  if (!outDir || !fs.existsSync(outDir)) return [];
  const rows = [];
  for (const name of fs.readdirSync(outDir)) {
    const file = path.join(outDir, name, 'deck.json');
    if (!fs.existsSync(file)) continue;
    let deck;
    try { deck = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { continue; } // a half-written deck.json is not history
    if (deck && deck.postedRow && deck.postedRow.deckId) rows.push({ ...deck.postedRow, rendered: deck.rendered || null });
  }
  return rows;
}

const deckNumber = (id) => { const n = Number(String(id).replace(/^.*?-/, '')); return Number.isFinite(n) ? n : 0; };

// Published rows first (they are the record), then rendered-only decks, the
// whole thing in deck order so `slice(-N)` means "the last N decks".
function readHistory(brandDir, { outDir } = {}) {
  const published = readPosted(brandDir);
  const seen = new Set(published.map((r) => r.deckId));
  const merged = published.concat(readRendered(outDir).filter((r) => !seen.has(r.deckId)));
  return merged.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || deckNumber(a.deckId) - deckNumber(b.deckId));
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

// caption-treatments.json: no caption treatment repeated within 3 decks. Same
// shape as checkCutout, reading the same merged history.
function checkTreatment(rows, treatmentId) {
  if (!treatmentId) return { ok: true, rule: 'treatment-rotation', detail: 'no caption treatment on this deck' };
  const recent = rows.slice(-TREATMENT_WINDOW).map((r) => r.treatment).filter(Boolean);
  return {
    ok: !recent.includes(treatmentId),
    rule: 'treatment-rotation',
    detail: recent.includes(treatmentId)
      ? `caption treatment "${treatmentId}" was used within the last ${TREATMENT_WINDOW} decks`
      : `caption treatment "${treatmentId}" not used in the last ${TREATMENT_WINDOW} decks`,
    recent,
  };
}

// brief.shape: no deck shape repeated within 3 decks. Same shape as
// checkTreatment; a brief written before the field existed carries no shape
// and is simply not counted.
function checkShape(rows, shape) {
  if (!shape) return { ok: true, rule: 'shape-rotation', detail: 'this brief names no deck shape' };
  const recent = rows.slice(-SHAPE_WINDOW).map((r) => r.shape).filter(Boolean);
  return {
    ok: !recent.includes(shape),
    rule: 'shape-rotation',
    detail: recent.includes(shape)
      ? `deck shape "${shape}" was used within the last ${SHAPE_WINDOW} decks`
      : `deck shape "${shape}" not used in the last ${SHAPE_WINDOW} decks`,
    recent,
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

// A cover kicker is always a signal chip: no chip two posts running, and at
// most 7 per rolling 20 (deck-rules, alongside the 14/3/2/1 subject mix).
function checkKicker(rows, hasKicker) {
  if (!hasKicker) return { ok: true, rule: 'kicker-rotation', detail: 'no kicker chip on this cover' };
  const last = rows[rows.length - 1];
  if (last && last.kicker) {
    return { ok: false, rule: 'kicker-rotation', detail: `a kicker chip was used last post (${last.deckId}); no chip ${KICKER_RUN} posts running` };
  }
  const window = rows.slice(-(CHIP_WINDOW - 1));
  const count = window.filter((r) => r.kicker).length + 1;
  return {
    ok: count <= CHIP_QUOTA,
    rule: 'kicker-rotation',
    detail: `a chip would be ${count} of the last ${Math.min(rows.length + 1, CHIP_WINDOW)} posts; quota is ${CHIP_QUOTA} per ${CHIP_WINDOW}`,
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
    topic: brief.topic || null,
    ground: brief.cover.ground,
    subject: brief.cover.subject,
    mode: brief.cover.mode,
    cutout: resolved.cutout ? resolved.cutout.id : null,
    position: resolved.position || null,
    signal: brief.cover.signal || null,
    kicker: resolved.kicker ? resolved.kicker.text : null,
    treatment: resolved.treatment || null,
    shape: brief.shape || null,
    components: brief.slides.map((x) => x.type),
    coverHash: resolved.coverHash || null,
    sound: null, // filled in by the packet when it suggests one (pipeline/lib/sounds.js)
  };
}

module.exports = {
  readHistory, readPosted, readRendered, groundFamily, checkGround, checkMix, checkCutout, checkPosition, checkMode, checkKicker, checkTreatment, checkShape, recentHashes, toPostedRow,
  MIX_WINDOW, MIX_QUOTA, CUTOUT_WINDOW, POSITION_WINDOW, MODE_RUN, KICKER_RUN, CHIP_WINDOW, CHIP_QUOTA, HASH_DAYS, TREATMENT_WINDOW, SHAPE_WINDOW,
};
