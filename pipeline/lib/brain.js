'use strict';
// The brain is plain files in git (README principle 1). This module reads them
// and pulls out the few structured bits the stages need. Everything else is
// handed to the model as the text it already is: the files are the prompt.
const fs = require('fs');
const path = require('path');

const read = (dir, name) => {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) throw new Error(`brain file missing: ${file}`);
  return fs.readFileSync(file, 'utf8');
};

// "## Running 101 — weight 5/20" -> { name, label, weight, body }
function parseSeries(text) {
  const out = [];
  const re = /^##\s+(.+?)\s+[—-]\s+weight\s+(\d+)\s*\/\s*(\d+)\s*$/gim;
  const heads = [];
  let m;
  while ((m = re.exec(text))) heads.push({ name: m[1].trim(), weight: Number(m[2]), per: Number(m[3]), at: m.index });
  heads.forEach((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].at : text.length;
    out.push({
      name: h.name,
      label: h.name.toUpperCase(),
      weight: h.weight,
      per: h.per,
      body: text.slice(text.indexOf('\n', h.at) + 1, end).trim(),
    });
  });
  return out;
}

// "## Evergreen reserve" prose lists the fallbacks after a colon.
function parseEvergreen(text) {
  const sec = text.split(/^##\s+Evergreen reserve\s*$/im)[1];
  if (!sec) return [];
  const colon = sec.indexOf(':');
  if (colon < 0) return [];
  // Split on commas that are not inside parentheses: "long-run fuelling (food,
  // not supplements)" is one item, not two.
  const body = sec.slice(colon + 1).split(/^##/m)[0].replace(/\s*\n\s*/g, ' ');
  const items = [];
  let depth = 0, cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { items.push(cur); cur = ''; continue; }
    cur += ch;
  }
  items.push(cur);
  return items.map((s) => s.trim().replace(/\.$/, '')).filter(Boolean);
}

// rejected.md table: | Date | Slug | Idea | Reason |
function parseRejected(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*\|(.+)\|\s*$/);
    if (!m) continue;
    const cells = m[1].split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    if (/^date$/i.test(cells[0])) continue;
    if (cells.every((c) => !c)) continue;
    // Scope (fifth column, optional). Only the exact word "figure" narrows a
    // rejection to one figure or angle and leaves the topic eligible. Anything
    // else, a missing cell, an empty cell, a typo, an older four-column row,
    // is "topic": the permanent exclusion. A rejection whose scope cannot be
    // read excludes more, never less.
    const scope = String(cells[4] || '').trim().toLowerCase() === 'figure' ? 'figure' : 'topic';
    out.push({ date: cells[0] || '', slug: (cells[1] || '').toLowerCase(), idea: cells[2] || '', reason: cells[3] || '', scope });
  }
  return out;
}

function readPosted(brandDir) {
  const file = path.join(brandDir, 'memory', 'posted.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l, i) => {
      try { return JSON.parse(l); } catch (e) { throw new Error(`posted.jsonl line ${i + 1} is not JSON`); }
    });
}

function loadBrain(brandDir) {
  const files = {
    positioning: read(brandDir, 'positioning.md'),
    voice: read(brandDir, 'voice.md'),
    banned: read(brandDir, 'banned.md'),
    series: read(brandDir, 'series.md'),
    sources: read(brandDir, 'sources.md'),
    deckRules: read(brandDir, 'deck-rules.md'),
    rejected: read(brandDir, path.join('memory', 'rejected.md')),
  };
  return {
    dir: brandDir,
    files,
    series: parseSeries(files.series),
    evergreen: parseEvergreen(files.series),
    rejected: parseRejected(files.rejected),
    posted: readPosted(brandDir),
  };
}

// Rows from posted.jsonl inside a day window, newest last.
function within(rows, days, today = new Date()) {
  const cutoff = today.getTime() - days * 86400000;
  return rows.filter((r) => r.date && Date.parse(r.date) >= cutoff);
}

module.exports = { loadBrain, parseSeries, parseEvergreen, parseRejected, readPosted, within };
