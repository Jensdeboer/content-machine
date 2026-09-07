'use strict';
// Every threshold the renderer and QA use, in one place. `stated` values come
// from the brand files (path in the comment). `default` values are the
// renderer's own choice where the files give a rule but no number; change here.
module.exports = {
  // --- stated -------------------------------------------------------------
  glyphMaxCoverage: 0.40,   // 03-covers/cover-full-figure.dc.html: "occluded by no more than 40% of any glyph"
  floorPx: 24,              // tokens.json size.floor; qa flags anything below, covers included
  // The 24px token floor applies to covers too; the grammar's former 30px line was a drafting error (CHANGELOG v0.7.1).
  shoutWordsMax: 2,         // cover-grammar HEADLINE MODES
  sentenceWordsMin: 5,
  sentenceWordsMax: 9,
  kickerWordsMax: 6,        // cover-grammar KICKER
  stopTestPass: 4,          // cover-grammar STOP TEST / deck-rules
  maxScale: 1.0,            // cover-grammar: never scaled beyond native size
  slideCount: [5, 7],       // deck-rules STRUCTURE
  sameComponentRunMax: 2,   // deck-rules: "at most one of the same component twice in a row" read as no run of three

  // --- defaults (no number in the files) -----------------------------------
  edgeGlyphMaxCoverage: 0.02, // "never its first or last letters": tolerance for antialiasing at the glyph box edge
  finalWordMaxCoverage: 0.02, // "the final word is never occluded": same tolerance
  inkThreshold: 96,           // text pixel counts as ink at alpha >= this (0..255)
  figureThreshold: 128,       // figure pixel counts as opaque at alpha >= this
  slicedEdgeFrac: 0.03,       // an image edge with >= 3% opaque pixels is a sliced crop edge...
  slicedEdgeRun: 32,          // ...or a continuous opaque run of >= 32px along the edge
  scaleSteps: [1, 0.9, 0.8, 0.7],      // fix order allows scaling the figure down; below 0.7 the layout is abandoned (confirmed 7 Sep 2026)
  phashBlockDistance: 6,      // hamming distance (of 64 bits) at or under which two covers collide and the deck blocks
  phashWarnDistance: 10,      // 7..10 bits: warned in review.json, not blocked
  jpegQuality: 92,            // export quality
  layoutGridStep: 20,         // headline top candidates are tried on this grid (slide px)
  pixelChecksMax: 60,         // occlusion renders per cover before the search gives up
  // component-capacity.json (measured by capacity.js). Copy is grown from the
  // reference slide a field at a time, every field together, so the budgets
  // hold simultaneously rather than one at a time.
  copyBudgetMargin: 0.9,      // the write stage is told 90% of the growth that fit, so a long word or an accent phrase does not spend the whole margin
  copyBudgetMaxScale: 2,      // never offer more than 2x the reference copy: past that the constraint is editorial (voice.md, deck-rules.md), and a field allowed to balloon takes the space a hero number needs
  copyBudgetMinHeadroom: 8,   // ...but always offer at least 8 characters more, so a two-character stat value is not capped at six
};
