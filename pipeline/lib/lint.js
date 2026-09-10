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
    // banned.md "Language": a list, so a metaphor caught in review is an edit
    // there and the build catches it next time, never a change to this file.
    metaphors: quotedTerms(bannedMd, 'metaphor where a plain instruction works'),
  };
}

// --------------------------------------------------------------------------
// banned.md "Language — the non-native reader test". The patterns, as opposed
// to the word lists above. See that section for which of these block and why.
// --------------------------------------------------------------------------

// Line breaks end sentences here: slide copy uses them without punctuation.
const sentences = (t) => String(t || '').split(/\n+|(?<=[.?])\s+/).map((x) => x.trim()).filter(Boolean);
const wordsOf = (s) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);

// Setup-then-negation: a claim, then a bare denial of itself.
const BARE_NEGATION = /^(it|that|this|they|these|those|there)\s+(is|are|was|were|does|do|did|will|can|has|have)\s*(not|n't)\s*\.?$/i;
const FEELS_LIKE = /\b(feels?|looks?|sounds?|seems?)\s+like\b/i;
const NOT_THE_SAME = /\b(is|are) not the same as\b/i;

// Telegraphic body copy: phrases joined by commas with no verb anywhere.
// Words as often nouns as verbs in running copy are not counted as evidence of
// a verb — they are exactly what a telegraphic line leans on.
const VERB_BASES = ('be have do go get make take come see know want look use find give tell work call try ask need feel '
+ 'become leave put mean keep let begin seem help talk turn start show hear play move like live believe hold bring '
+ 'happen write provide sit stand lose pay meet include continue learn understand follow stop create speak read allow '
+ 'add spend grow open offer remember love consider appear buy wait serve die send expect build stay fall reach remain '
+ 'suggest raise pass sell require report decide sleep eat drink jog stride taper recover repeat skip replace swap '
+ 'rotate lace wear tie breathe descend hydrate note aim hit miss lower increase reduce ease hurt ache swell heal '
+ 'treat shorten lengthen rise sink drift settle carry earn '
+ 'run walk climb push pull count lift stretch swim cycle bike train test check measure weigh gain save spend '
+ 'watch call lead change set start end repeat hold drop raise sit rise').split(' ');
const VERB_IRREGULAR = ('is are was were been am has had did does gone went got made took came saw knew felt kept let '
+ "began seemed held brought wrote sat stood lost paid met led understood spoke read grew bought sent built fell "
+ 'sold slept ate drank wore tied rose sank carried can could will would shall should may might must sounds sound '
+ 'sounded falls cannot').split(' ');
// Kept deliberately SHORT. Every word here stops being evidence of a verb, so
// an over-long list turns ordinary sentences into false positives: with "run"
// on it, "You run hard on Tuesday, Thursday and Sunday" reads as verbless.
// Only words that actually head a noun phrase in this register belong here.
const AMBIGUOUS = new Set(('pace race rest log track mark plan schedule fuel cover strike land warm cool finish split').split(' '));

const VERBS = new Set();
for (const b of VERB_BASES) {
  VERBS.add(b); VERBS.add(b + 's'); VERBS.add(b + 'ed'); VERBS.add(b + 'ing');
  if (/e$/.test(b)) { VERBS.add(b.slice(0, -1) + 'ed'); VERBS.add(b.slice(0, -1) + 'ing'); }
}
for (const w of VERB_IRREGULAR) VERBS.add(w);
for (const w of AMBIGUOUS) { VERBS.delete(w); VERBS.delete(w + 's'); }

// Bare referent: a pronoun in the first sentence with nothing named before it,
// or a vague adjective with nothing to measure it against.
const REFERENTS = ['it', 'them', 'they', 'this', 'that', 'these', 'those'];
const VAGUE = ['small', 'stacked', 'specific', 'big', 'hard', 'easy', 'light', 'heavy'];

const BRITISH = [['kilometre', 'kilometer'], ['metre', 'meter'], ['litre', 'liter'], ['fibre', 'fiber'],
  ['colour', 'color'], ['favour', 'favor'], ['behaviour', 'behavior'], ['practise', 'practice'],
  ['analyse', 'analyze'], ['centre', 'center'], ['grey', 'gray'], ['travelling', 'traveling'],
  ['programme', 'program'], ['organise', 'organize'], ['recognise', 'recognize']];

const MAX_SENTENCE_WORDS = 22;

// Which fields are prose. The telegraphic rule applies here and nowhere else:
// a headline, a label, a chip and a compare column heading are not sentences.
const isProse = (where) => /\.body$/.test(String(where));

// An aside is exempt from BOTH heuristics. voice.md's own illustration of
// sanctioned dryness is "Yes, that slow." — verbless, and its "that" points at
// the sentence before it rather than at a noun on the slide. A rule that
// flagged the brand file's own example of correct voice would be wrong about
// the voice, not about the line. Blocking rules still apply to asides.
const isAside = (where) => /\.aside$/.test(String(where));

// A label and a cover kicker are mono chips — "05 · THIS WEEK" — not prose.
// They are exempt from the heuristics for the same reason asides are: the
// bare-referent rule reads their "this" as pointing at nothing, when the chip
// is a section marker and points at the slide it sits on.
const isChip = (where) => /\.(label|kicker)$/.test(String(where));


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

    // --- banned.md "Language" ------------------------------------------------
    for (const term of lists.metaphors) {
      if (lower.includes(term)) add('block', 'metaphor-for-an-instruction', where, `"${term}" — say the instruction instead`);
    }
    for (const [uk, us] of BRITISH) {
      if (new RegExp(`\\b${uk}s?\\b`).test(lower)) add('block', 'british-spelling', where, `"${uk}" — the house style is "${us}"`);
    }
    const ss = sentences(text);
    ss.forEach((s, i) => {
      if (BARE_NEGATION.test(s)) add('block', 'setup-then-negation', where, `"${s}" denies the sentence before it and says nothing`);
      if (NOT_THE_SAME.test(s)) add('block', 'setup-then-negation', where, `"${s}" contrasts two abstractions without saying what either is`);
      if (FEELS_LIKE.test(s) && ss[i + 1] && /\bnot\b|n't/i.test(ss[i + 1]) && wordsOf(ss[i + 1]).length <= 6) {
        add('block', 'setup-then-negation', where, `"${s}" followed by "${ss[i + 1]}"`);
      }
      if (wordsOf(s).length > MAX_SENTENCE_WORDS) add('block', 'sentence-too-long', where, `${wordsOf(s).length} words, the limit is ${MAX_SENTENCE_WORDS}`);
      // Bare referent, first sentence only: later ones can point backwards.
      if (i === 0 && !isAside(where) && !isChip(where)) {
        const w = wordsOf(s);
        for (const r of REFERENTS) {
          const at = w.indexOf(r);
          if (at <= 0) continue;
          const named = w.slice(0, at).some((x) => !VERBS.has(x) && x.length > 3 && !REFERENTS.includes(x));
          if (!named) add('flag', 'bare-referent', where, `"${r}" in "${s}" points at nothing named yet`);
        }
      }
      for (const a of (isAside(where) || isChip(where) ? [] : VAGUE)) {
        if (new RegExp(`\\b(keep|keeps|kept|make|makes|made|stay|stays)\\s+(it|them|this|that)\\s+${a}\\b`, 'i').test(s)) {
          add('flag', 'bare-referent', where, `"${s}" says ${a} without saying ${a} compared to what`);
        }
      }
      // Telegraphic: prose fields only.
      if (isProse(where) && /,/.test(s)) {
        const w = wordsOf(s);
        if (w.length >= 3 && !w.some((x) => VERBS.has(x))) {
          add('flag', 'telegraphic-body-copy', where, `"${s}" joins phrases with commas and carries no verb`);
        }
      }
    });

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

module.exports = { lintCopy, parseBanned, blocks, flags, sentences, MAX_SENTENCE_WORDS, BRITISH, isProse, isAside, isChip };
