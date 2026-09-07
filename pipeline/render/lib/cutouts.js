'use strict';
// The cutout manifest (00-assets/cutouts/cutouts.json) and the geometry that
// maps its 3x3 alpha grid onto the canvas after a figure is placed.
const fs = require('fs');
const path = require('path');

const ROWS = ['upper', 'centre', 'lower'];
const COLS = ['left', 'centre', 'right'];
const EDGES = ['top', 'right', 'bottom', 'left'];

// How the manifest's `crop` prose names a sliced edge. Derived from the wording
// actually used in cutouts.json v0.7; the alpha channel is checked as well.
const CROP_EDGE_WORDS = [
  [/bleeds all four edges/i, ['top', 'right', 'bottom', 'left']],
  [/cropped left and right/i, ['left', 'right']],
  [/cropped at the hair/i, ['top']],
  [/cropped (at|below) the (shoes?|shins?|foot|feet|standing shin|waist|hips)/i, ['bottom']],
];

function zoneName(r, c) {
  return ROWS[r] === 'centre' && COLS[c] === 'centre' ? 'centre' : `${ROWS[r]}-${COLS[c]}`;
}

function loadManifest(brandDir) {
  const dir = path.join(brandDir, 'design', '00-assets', 'cutouts');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'cutouts.json'), 'utf8'));
  const byId = new Map(manifest.cutouts.map((c) => [c.id, c]));
  return { dir, manifest, cutouts: manifest.cutouts, byId };
}

function fileDataUri(lib, cutout) {
  const buf = fs.readFileSync(path.join(lib.dir, cutout.file));
  return `data:image/png;base64,${buf.toString('base64')}`;
}

// A cutout lists the grounds it may sit on; everything else is excluded.
// ground-deep counts as navy.
function allowedOnGround(cutout, ground) {
  const fam = ground === 'white' ? 'white' : 'navy';
  return cutout.ground === 'both' || cutout.ground === fam;
}

function cropEdgesFromManifest(cutout) {
  const out = new Set();
  for (const [re, edges] of CROP_EDGE_WORDS) if (re.test(cutout.crop || '')) edges.forEach((e) => out.add(e));
  return [...out];
}

// Placement: { x, y, scale, mirror }. Returns the figure box on the canvas.
function figureBox(cutout, p) {
  return { x: p.x, y: p.y, w: cutout.width * p.scale, h: cutout.height * p.scale };
}

// The nine zones on the canvas for a placement, with the manifest's density
// and whether the zone is type-space, dense or neither. Mirroring swaps the
// left and right columns.
function zoneRects(cutout, p) {
  const b = figureBox(cutout, p);
  const cw = b.w / 3, rh = b.h / 3;
  const zones = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const name = zoneName(r, c);
      const cc = p.mirror ? 2 - c : c; // canvas column
      zones.push({
        name,
        density: cutout.density[r][c],
        kind: cutout['type-space'].includes(name) ? 'type-space' : cutout.dense.includes(name) ? 'dense' : 'mid',
        rect: { x: b.x + cc * cw, y: b.y + r * rh, w: cw, h: rh },
      });
    }
  }
  return zones;
}

function intersects(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
function intersection(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x || y2 <= y) return null;
  return { x, y, w: x2 - x, h: y2 - y };
}
function area(r) { return r ? r.w * r.h : 0; }

// Candidate cutouts for a cover, deterministic order. `hints` may carry
// energy and faces from the brief; `exclude` are ids used in the rotation window.
function selectCandidates(lib, { subject, ground, hints = {}, exclude = [] }) {
  const type = subject === 'detail' ? 'detail' : 'full-figure';
  const scored = [];
  lib.cutouts.forEach((c, index) => {
    const reasons = [];
    if (c.type !== type) reasons.push(`type ${c.type} != ${type}`);
    if (!allowedOnGround(c, ground)) reasons.push(`excluded on ${ground} (ground: ${c.ground})`);
    if (exclude.includes(c.id)) reasons.push('used within the rotation window');
    // Auto-selection skips these; a brief may still name them and QA warns.
    const autoSkip = [];
    if (/slide use only/i.test(c.note || '')) reasons.push('manifest note: slide use only');
    if (/recognisable athlete/i.test(c.note || '')) reasons.push('manifest note: recognisable athlete (grammar negative list; a likeness question, never rendered)');
    if ((c.faces || '').startsWith('camera')) autoSkip.push('faces the camera; the manifest approves it only with the face cropped or covered, which needs an explicit placement');
    let score = 0;
    if (hints.energy && c.energy === hints.energy) score += 4;
    if (hints.faces && (c.faces || '').split(',')[0].trim() === hints.faces) score += 2;
    if (c['type-space'].length > 0) score += 1;
    scored.push({ cutout: c, index, score, eligible: reasons.length === 0, reasons, autoSkip });
  });
  return scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
}

module.exports = {
  ROWS, COLS, EDGES, zoneName, loadManifest, fileDataUri, allowedOnGround, cropEdgesFromManifest,
  figureBox, zoneRects, intersects, intersection, area, selectCandidates,
};
