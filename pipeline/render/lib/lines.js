'use strict';
// Where is this headline line? One answer, used by the composer's search and
// by qa.js alike: the rect of the line's text as Chromium lays it out in the
// real font, ascent to descent, which pads the glyph ink by the font's own
// metrics. Nothing else in the renderer models a line's height; the synthetic
// line-height box was 37px shorter than this for Sora at 140px, and a line
// that cleared the figure by one pixel in that model crossed it in this one.
//
// The composer measures once per probe (headline at top 0) and shifts: the
// text's offset inside its absolutely positioned element does not change
// when the element moves, so a candidate top gives the rect exactly.
const cut = require('./cutouts');

// [{ index, text, top, rect }] for every [data-role="headline-line"] in the
// page, rects in canvas space. `top` is the element's own top; `rect` is the
// union of the text's client rects.
async function measureHeadlineLines(page) {
  return page.evaluate(() => window.__pv.headlineLines());
}

// The measured line, with its element moved to `elementTop`.
function lineRectAt(measured, elementTop) {
  const r = measured.rect;
  return { x: r.x, y: r.y + (elementTop - measured.top), w: r.w, h: r.h };
}

// Zones a rect touches. `intersects` is strict on both axes: a line whose
// bottom edge equals a zone's top does not touch it, a fraction below does.
function zoneHits(rect, zones) {
  return zones.filter((z) => cut.intersects(rect, z.rect));
}

// The dense-zone rule for a set of laid-out lines: a line that sits behind
// the figure may not cross a zone the manifest calls dense. `lines` carry
// { index, text, rect, front }. Every line is tested, whether or not its rect
// overlaps the figure box; the box test is not a shortcut around this one.
function denseZoneProblems(lines, zones) {
  const problems = [];
  for (const l of lines) {
    if (l.front) continue;
    for (const z of zoneHits(l.rect, zones)) {
      if (z.kind === 'dense') problems.push({ line: l.index, text: l.text, zone: z.name, rule: 'headline-in-dense-zone', detail: `line "${l.text}" crosses dense zone ${z.name}` });
    }
  }
  return problems;
}

module.exports = { measureHeadlineLines, lineRectAt, zoneHits, denseZoneProblems };
