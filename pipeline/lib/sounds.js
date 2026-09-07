'use strict';
// sounds.md and the sound rotation.
//
// sounds.md is a shortlist a human edits weekly, nothing more. Columns are
// found by header name, so the table can gain, lose or reorder columns without
// touching this file. "Sound" is the only column that must exist.
//
// Which sound was suggested for which deck is history, and history lives where
// all other history lives: state.db (the packet writes the deck row) and the
// postedRow that the confirm step appends to posted.jsonl. The rule reads from
// there, never from the table. It has the same shape as the cover rotation
// rules in render/lib/history.js: never the same sound two posts running, and
// otherwise the one used longest ago, unused ones first, in shortlist order.
const fs = require('fs');
const path = require('path');

const SOUND_RUN = 2; // no sound two posts running

// Header cells map onto these keys; anything else is carried under its own
// lowercased header name and otherwise ignored.
const COLUMNS = {
  sound: 'sound',
  artist: 'artist',
  platform: 'platform',
  notes: 'notes',
  note: 'notes',
  why: 'notes',
  'why it fits': 'notes',
};

const norm = (s) => String(s || '').trim().toLowerCase();

function cells(line) {
  const m = line.match(/^\s*\|(.+)\|\s*$/);
  if (!m) return null;
  return m[1].split('|').map((s) => s.trim());
}

// The shortlist: every row under the first table whose header has a Sound
// column. Rows without a sound are template rows and are skipped.
function readShortlist(brandDir) {
  const file = path.join(brandDir, 'sounds.md');
  if (!fs.existsSync(file)) return [];
  let keys = null;
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const c = cells(line);
    if (!c) continue;
    if (c.every((x) => /^:?-{2,}:?$/.test(x) || x === '')) continue;   // the rule under the header
    if (!keys) {
      const lower = c.map(norm);
      if (!lower.includes('sound')) continue;                          // not the shortlist table
      keys = lower.map((h) => COLUMNS[h] || h);
      continue;
    }
    const row = {};
    keys.forEach((k, i) => { if (k && k !== '#') row[k] = c[i] || ''; });
    if (!row.sound) continue;
    rows.push({ sound: row.sound, artist: row.artist || '', platform: row.platform || '', notes: row.notes || '', ...row });
  }
  return rows;
}

// history: every post or packet so far, oldest first, each { deckId, when, sound }
// with sound null when none was suggested. Same shape as the other rules:
// { ok, rule, detail }.
function checkSound(history, sound) {
  const last = history[history.length - 1];
  if (!last || !last.sound) return { ok: true, rule: 'sound-rotation', detail: last ? 'last post had no sound' : 'no history; any sound' };
  const same = norm(last.sound) === norm(sound);
  return {
    ok: !same,
    rule: 'sound-rotation',
    detail: same ? `"${sound}" was the sound last post (${last.deckId}); no sound ${SOUND_RUN} posts running` : `"${sound}" ok after "${last.sound}" (${last.deckId})`,
  };
}

// Unused first in shortlist order, then the one used longest ago; never the
// one used last post. Returns { row, check, lastUsed } or null with a reason.
function pickSound(shortlist, history) {
  if (!shortlist.length) return { row: null, reason: 'sounds.md has no shortlist' };
  const lastUsed = new Map();
  for (const h of history) if (h.sound) lastUsed.set(norm(h.sound), h.when || '');
  const allowed = shortlist.filter((r) => checkSound(history, r.sound).ok);
  if (!allowed.length) return { row: null, reason: `the only sound on the shortlist ("${shortlist[0].sound}") was the sound last post` };
  const ranked = allowed
    .map((r, i) => ({ r, i, used: lastUsed.get(norm(r.sound)) || '' }))
    .sort((a, b) => (a.used === b.used ? a.i - b.i : (a.used === '' ? -1 : b.used === '' ? 1 : a.used.localeCompare(b.used))));
  const best = ranked[0];
  return { row: best.r, check: checkSound(history, best.r.sound), lastUsed: best.used || null };
}

// One history from the two places it lives. posted.jsonl rows are the record
// of what went out and win for a deck that appears in both; state.db decks
// that were sent as a packet but not yet confirmed fill in the rest.
function soundHistory(postedRows, stateRows) {
  const seen = new Set();
  const out = [];
  for (const r of postedRows) {
    if (!r.deckId) continue;
    seen.add(r.deckId);
    out.push({ deckId: r.deckId, when: r.date || '', sound: r.sound || null });
  }
  for (const d of stateRows) {
    if (seen.has(d.deck_key)) continue;
    out.push({ deckId: d.deck_key, when: d.packet_sent_at || '', sound: d.sound || null });
  }
  return out.sort((a, b) => a.when.localeCompare(b.when));
}

module.exports = { readShortlist, checkSound, pickSound, soundHistory, SOUND_RUN };
