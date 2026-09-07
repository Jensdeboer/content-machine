'use strict';
// banned.md is the rule file; this module is only the mechanism. Word lists are
// parsed out of the file so a new banned phrase is an edit there, never here.
//
// Two kinds of finding:
//   block — mechanically decidable, and banned.md calls the list hard failures
//   flag  — detectable, but the file's rule turns on something a regex cannot
//           see ("no jargon WITHOUT A SHOWN EXPLANATION"). Flags are recorded
//           on the deck and sent to Telegram for a human, never auto-blocked.

// One bullet, including the lines it wraps onto: banned.md wraps its lists at
// the margin, and a term split across two lines is still a term.
function bullet(text, afterLabel) {
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => new RegExp(afterLabel, 'i').test(l));
  if (i < 0) return null;
  let chunk = lines[i];
  for (let j = i + 1; j < lines.length && /^\s{2,}\S/.test(lines[j]) && !/^\s*-\s/.test(lines[j]); j++) chunk += ' ' + lines[j].trim();
  return chunk;
}

// Quoted terms in a bullet: - No hype vocabulary: "insane", "game-changer", ...
function quotedTerms(text, afterLabel) {
  const chunk = bullet(text, afterLabel);
  if (!chunk) return [];
  return [...chunk.matchAll(/"([^"]+)"/g)].map((m) => m[1].replace(/\s+/g, ' ').toLowerCase());
}

// Comma list after a colon: - No jargon without a shown explanation: VO2max, ...
function colonList(text, afterLabel) {
  const chunk = bullet(text, afterLabel);
  if (!chunk) return [];
  return chunk.slice(chunk.indexOf(':') + 1)
    .split(',').map((s) => s.trim().replace(/\.$/, '').toLowerCase()).filter(Boolean);
}

function parseBanned(bannedMd) {
  return {
    hype: quotedTerms(bannedMd, 'hype vocabulary'),
    promises: quotedTerms(bannedMd, 'absolute promises'),
    jargon: colonList(bannedMd, 'jargon without a shown explanation'),
  };
}

const EMOJI = /\p{Extended_Pictographic}/u;

// `texts` is [{ where, text }]. Source quotes are passed separately: banned.md
// allows miles inside a quoted source.
function lintCopy(texts, bannedMd, { quotedSources = [] } = {}) {
  const lists = parseBanned(bannedMd);
  const findings = [];
  const add = (severity, rule, where, detail) => findings.push({ severity, rule, where, detail });
  const inQuotedSource = (t) => quotedSources.some((q) => q && q.includes(t));

  for (const { where, text } of texts) {
    if (!text) continue;
    const lower = String(text).toLowerCase();

    // Characters banned outright (banned.md "## Copy").
    if (/(^|\s)#\w/.test(text)) add('block', 'no-hashtags', where, text.slice(0, 60));
    if (EMOJI.test(text)) add('block', 'no-emoji', where, text.slice(0, 60));
    if (/!/.test(text)) add('block', 'no-exclamation-marks', where, text.slice(0, 60));
    if (/—/.test(text)) add('block', 'no-em-dashes', where, text.slice(0, 60));

    for (const term of lists.hype) {
      if (lower.includes(term)) add('block', 'hype-vocabulary', where, `"${term}"`);
    }
    for (const term of lists.promises) {
      if (lower.includes(term)) add('block', 'absolute-promise', where, `"${term}"`);
    }

    // Paces always in min/km; miles only inside a quoted source.
    const mile = lower.match(/\b\d+(?:\.\d+)?\s*(?:mi|miles?)\b|\bper mile\b|\bmin\/mi\b/);
    if (mile && !inQuotedSource(text)) add('block', 'miles-outside-a-quoted-source', where, mile[0]);

    // Jargon: detectable, but "shown explanation" is not. Never auto-blocked.
    for (const term of lists.jargon) {
      if (lower.includes(term)) {
        add('flag', 'jargon-needs-a-shown-explanation', where, `"${term}" — banned.md allows it only with the explanation shown; check the deck shows one`);
      }
    }
  }
  return findings;
}

const blocks = (findings) => findings.filter((f) => f.severity === 'block');
const flags = (findings) => findings.filter((f) => f.severity === 'flag');

module.exports = { lintCopy, parseBanned, blocks, flags };
