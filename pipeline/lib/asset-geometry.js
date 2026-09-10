'use strict';
// The geometry every manifest entry carries, read off a cutout's alpha channel:
// trimmed size, how much of the box the subject fills, the 3x3 density grid,
// and which of the nine zones are type-space or dense.
//
// The thresholds are not invented. They were fitted to the sixteen cutouts
// that already exist: across all 144 zones, every zone the manifest calls
// type-space has density <= 0.14, every zone it calls dense has density
// >= 0.55, and nothing sits in between on the wrong side. Those two numbers
// reproduce all sixteen entries exactly, so a newly ingested asset is
// classified the same way a hand-made one was.
//
// Measured in Chromium, which the renderer already depends on (render/lib/
// browser.js). No image library is added for this.
const path = require('path');
const fs = require('fs');

const ROWS = ['upper', 'centre', 'lower'];
const COLS = ['left', 'centre', 'right'];
const TYPE_SPACE_MAX = 0.14;   // fitted; see above
const DENSE_MIN = 0.55;        // fitted; see above
// Two alpha cuts, both fitted to the existing sixteen, because the hand-made
// manifest used two. The BOX is the subject's real extent and counts any pixel
// that is not fully transparent, anti-aliased edge included: at >= 1 all
// sixteen widths and heights come back exactly. DENSITY is about solid mass,
// so it counts only substantially opaque pixels: at >= 110 all sixteen
// type-space/dense classifications come back exactly. Those two fields are
// what the composer reads; `coverage` and the raw grid land within rounding
// of the originals (14/16 and 5/16 identical) and are informational.
const ALPHA_BOX = 1;
const ALPHA_DENSE = 110;

function zoneName(r, c) {
  return ROWS[r] === 'centre' && COLS[c] === 'centre' ? 'centre' : `${ROWS[r]}-${COLS[c]}`;
}

// Runs inside the page. Returns the trimmed box and the nine densities.
function measureInPage(dataUri, boxT, densT) {
  const img = new Image();
  img.src = dataUri;
  return img.decode().then(() => {
    const W = img.naturalWidth, H = img.naturalHeight;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, W, H).data;
    const a = (x, y) => d[(y * W + x) * 4 + 3];

    // Trim to the subject: the manifest's width/height are the opaque bounds,
    // not the file's, so a cutout with transparent margin measures the figure.
    let x1 = W, y1 = H, x2 = -1, y2 = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (a(x, y) < boxT) continue;
        if (x < x1) x1 = x; if (x > x2) x2 = x;
        if (y < y1) y1 = y; if (y > y2) y2 = y;
      }
    }
    if (x2 < 0) return { empty: true, fileWidth: W, fileHeight: H };
    const bw = x2 - x1 + 1, bh = y2 - y1 + 1;

    let opaqueCount = 0;
    const grid = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const counts = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let y = y1; y <= y2; y++) {
      const r = Math.min(2, Math.floor(((y - y1) * 3) / bh));
      for (let x = x1; x <= x2; x++) {
        const c = Math.min(2, Math.floor(((x - x1) * 3) / bw));
        counts[r][c]++;
        if (a(x, y) >= densT) { grid[r][c]++; opaqueCount++; }
      }
    }
    const density = grid.map((row, r) => row.map((n, c) => (counts[r][c] ? n / counts[r][c] : 0)));
    return {
      empty: false, fileWidth: W, fileHeight: H,
      box: { x: x1, y: y1, width: bw, height: bh },
      coverage: opaqueCount / (bw * bh),
      density,
    };
  });
}

// Round the way the manifest does: two decimals, so a re-ingest of an existing
// asset produces the same numbers rather than a longer tail of them.
const r2 = (n) => Math.round(n * 100) / 100;

function classify(density) {
  const typeSpace = [], dense = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const v = density[r][c];
      if (v <= TYPE_SPACE_MAX) typeSpace.push(zoneName(r, c));
      else if (v >= DENSE_MIN) dense.push(zoneName(r, c));
    }
  }
  return { typeSpace, dense };
}

// `page` is a Playwright page (render/lib/browser.js). Returns the manifest
// geometry for one PNG, or { empty: true } when nothing is opaque.
async function analyse(page, file) {
  const uri = `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
  const m = await page.evaluate(({ u, b, d }) => window.__pvMeasure(u, b, d), { u: uri, b: ALPHA_BOX, d: ALPHA_DENSE });
  if (m.empty) return { empty: true, file: path.basename(file), fileWidth: m.fileWidth, fileHeight: m.fileHeight };
  const density = m.density.map((row) => row.map(r2));
  const { typeSpace, dense } = classify(density);
  return {
    empty: false,
    file: path.basename(file),
    width: m.box.width,
    height: m.box.height,
    fileWidth: m.fileWidth,
    fileHeight: m.fileHeight,
    box: m.box,
    coverage: r2(m.coverage),
    density,
    'type-space': typeSpace,
    dense,
  };
}

// Injected into the page once, so analyse() is a single evaluate per file.
const INPAGE = `window.__pvMeasure = ${measureInPage.toString()};`;

module.exports = { analyse, classify, zoneName, INPAGE, TYPE_SPACE_MAX, DENSE_MIN, ALPHA_BOX, ALPHA_DENSE, ROWS, COLS };
