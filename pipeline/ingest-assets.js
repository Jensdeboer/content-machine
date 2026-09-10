#!/usr/bin/env node
'use strict';
// Turn raw source photographs into manifest-backed assets.
//
//   node pipeline/ingest-assets.js pacevector --dry-run   list what would happen
//   node pipeline/ingest-assets.js pacevector             do it
//   options: --raw <dir>  --only <substring>  --keep-temp
//
// Reads brands/<brand>/raw/ and writes two manifests:
//
//   raw/humans/**          -> design/00-assets/cutouts/<stem>.png
//                             rembg, then greyscale, then autocontrast.
//                             Entry appended to cutouts.json.
//   raw/objects/<cat>/**   -> design/00-assets/objects/<cat>/<stem>.png
//                             rembg, then autocontrast. NO greyscale: objects
//                             keep their colour. Entry appended to objects.json,
//                             which is cutouts.json's shape plus `category`
//                             and `subject`.
//
// IDEMPOTENT. A file whose stem already appears in the relevant manifest is
// skipped, so this is safe to re-run every time more photographs land. Nothing
// is ever overwritten and no entry is ever rewritten.
//
// The geometry (trimmed size, coverage, 3x3 density, type-space, dense) comes
// from lib/asset-geometry.js, whose thresholds were fitted to the sixteen
// hand-made cutouts: width/height and type-space/dense reproduce those
// entries exactly (pipeline/test/asset-geometry.js).
//
// The descriptive fields (pose, faces, energy, crop, ground, subject) come
// from a vision pass on the `tag` stage through models.js, which is the only
// way any stage reaches a model.
//
// NOT IMPLEMENTED ON PURPOSE: any selective-colour treatment. Not specced.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { loadConfig } = require('./lib/config');
const { callModel } = require('./models');
const geom = require('./lib/asset-geometry');

const ROOT = path.resolve(__dirname, '..');
const MIN_LONG_SIDE = 1500;
const SOURCE_EXT = /\.(jpe?g|png|webp|tiff?)$/i;
const log = (...a) => console.log(...a);

// --------------------------------------------------------------------------
// External tools. rembg is a model, not something to reimplement; greyscale
// and autocontrast are done in Chromium, which the renderer already ships.
// --------------------------------------------------------------------------
function toolCheck() {
  const missing = [];
  const rembg = spawnSync('rembg', ['--help'], { encoding: 'utf8' });
  if (rembg.error) missing.push({
    tool: 'rembg',
    why: 'background removal',
    install: 'python3 -m venv ~/.venvs/rembg && ~/.venvs/rembg/bin/pip install "rembg[cli]" && ln -s ~/.venvs/rembg/bin/rembg ~/.local/bin/rembg',
  });
  return missing;
}

function runRembg(input, output) {
  const r = spawnSync('rembg', ['i', input, output], { encoding: 'utf8', timeout: 180000 });
  if (r.error) throw new Error(`rembg failed to start: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`rembg exited ${r.status}: ${(r.stderr || '').trim().slice(0, 300)}`);
  if (!fs.existsSync(output)) throw new Error(`rembg produced no output for ${path.basename(input)}`);
}

// --------------------------------------------------------------------------
// Greyscale and autocontrast, in the page. Alpha is never touched: rembg
// decided what is subject, and stretching or desaturating must not move that
// edge. Autocontrast stretches the luminance of the OPAQUE pixels only, so a
// large transparent margin cannot flatten the subject's range.
// --------------------------------------------------------------------------
const TREAT_INPAGE = `window.__pvTreat = async (uri, greyscale) => {
  const img = new Image(); img.src = uri; await img.decode();
  const W = img.naturalWidth, H = img.naturalHeight;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(img, 0, 0);
  const d = cx.getImageData(0, 0, W, H);
  const p = d.data;
  const lum = (i) => 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];
  let lo = 255, hi = 0;
  for (let i = 0; i < p.length; i += 4) {
    if (p[i + 3] < 110) continue;
    const l = lum(i);
    if (l < lo) lo = l;
    if (l > hi) hi = l;
  }
  const span = hi - lo;
  const stretch = span > 1 && span < 254 ? (v) => Math.max(0, Math.min(255, ((v - lo) * 255) / span)) : (v) => v;
  for (let i = 0; i < p.length; i += 4) {
    if (p[i + 3] === 0) continue;
    if (greyscale) {
      const g = stretch(lum(i));
      p[i] = p[i + 1] = p[i + 2] = g;
    } else {
      const l = lum(i);
      const s = stretch(l);
      const k = l > 0.5 ? s / l : 1;   // scale colour toward the stretched luminance, keeping hue
      p[i] = Math.max(0, Math.min(255, p[i] * k));
      p[i + 1] = Math.max(0, Math.min(255, p[i + 1] * k));
      p[i + 2] = Math.max(0, Math.min(255, p[i + 2] * k));
    }
  }
  cx.putImageData(d, 0, 0);
  return cv.toDataURL('image/png');
};`;

async function treat(page, inputPng, outputPng, { greyscale }) {
  const uri = `data:image/png;base64,${fs.readFileSync(inputPng).toString('base64')}`;
  const out = await page.evaluate(({ u, g }) => window.__pvTreat(u, g), { u: uri, g: greyscale });
  fs.mkdirSync(path.dirname(outputPng), { recursive: true });
  fs.writeFileSync(outputPng, Buffer.from(String(out).split(',')[1], 'base64'));
}

// --------------------------------------------------------------------------
// Manifests. Same integrity contract as lib/cutouts.js: every entry has a
// file, every file has an entry, and a mismatch names every offender rather
// than failing on the first.
// --------------------------------------------------------------------------
const MANIFESTS = {
  humans: {
    file: (brandDir) => path.join(brandDir, 'design', '00-assets', 'cutouts', 'cutouts.json'),
    dir: (brandDir) => path.join(brandDir, 'design', '00-assets', 'cutouts'),
    key: 'cutouts',
    fileOf: (e) => e.file,
  },
  objects: {
    file: (brandDir) => path.join(brandDir, 'design', '00-assets', 'objects.json'),
    dir: (brandDir) => path.join(brandDir, 'design', '00-assets', 'objects'),
    key: 'objects',
    fileOf: (e) => path.join(e.category, e.file),
  },
};

function readManifest(kind, brandDir) {
  const file = MANIFESTS[kind].file(brandDir);
  if (!fs.existsSync(file)) return { $meta: defaultMeta(kind), [MANIFESTS[kind].key]: [] };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function defaultMeta(kind) {
  return kind === 'humans'
    ? { note: 'Cutout figures. rembg, greyscale, autocontrast. Written by pipeline/ingest-assets.js.' }
    : {
      note: 'Object cutouts, full colour. rembg then autocontrast, never greyscale. Written by pipeline/ingest-assets.js. Same shape as cutouts.json plus `category` and `subject`. Nothing renders these yet: no slide component requests an object, and lib/history.js keeps their rotation rules inert until one does.',
      version: '0.1',
    };
}

function writeManifest(kind, brandDir, manifest) {
  const file = MANIFESTS[kind].file(brandDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

// Every entry's file exists, every file on disk has an entry. Named, not counted.
function validateManifest(kind, brandDir, manifest) {
  const spec = MANIFESTS[kind];
  const dir = spec.dir(brandDir);
  const problems = [];
  const entries = manifest[spec.key] || [];
  const expected = new Set();
  for (const e of entries) {
    const rel = spec.fileOf(e);
    expected.add(rel);
    if (!fs.existsSync(path.join(dir, rel))) problems.push(`${path.basename(spec.file(brandDir))} lists "${e.id}" -> ${rel}, which is not in ${path.relative(ROOT, dir)}`);
  }
  if (fs.existsSync(dir)) {
    for (const f of walk(dir)) {
      if (!f.toLowerCase().endsWith('.png')) continue;
      const rel = path.relative(dir, f);
      if (!expected.has(rel)) problems.push(`${rel} is in ${path.relative(ROOT, dir)} but has no entry in ${path.basename(spec.file(brandDir))}`);
    }
  }
  if (problems.length) throw new Error(`${kind} manifest integrity check failed:\n  ${problems.join('\n  ')}`);
}

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// --------------------------------------------------------------------------
// The vision pass. Same fields the hand-made manifest carries, so an ingested
// asset is indistinguishable from one written by hand.
// --------------------------------------------------------------------------
const TAG_SHAPE_HUMAN = `{
  "type": "full-figure | detail",
  "pose": "what the runner is doing, one clause",
  "faces": "left | right | up | down | camera | away, optionally with a qualifier after a comma",
  "energy": "low | mid | high",
  "crop": "what the frame includes, and any edge the source photo slices",
  "ground": "both | white | navy",
  "logos": true,
  "note": "anything that constrains use, or an empty string"
}`;

const TAG_SHAPE_OBJECT = `{
  "subject": "what the object is, two or three words",
  "type": "full-object | detail",
  "pose": "how it is arranged or oriented, one clause",
  "faces": "left | right | up | down | camera | away",
  "energy": "low | mid | high",
  "crop": "what the frame includes, and any edge the source photo slices",
  "ground": "both | white | navy",
  "logos": true,
  "note": "anything that constrains use, or an empty string"
}`;

async function tag({ cfg, file, kind, category }) {
  const human = kind === 'humans';
  const prompt = [
    human
      ? 'Describe this cutout of a runner for a design manifest. It has already had its background removed and been converted to greyscale.'
      : 'Describe this object cutout for a design manifest. Its background has been removed; it keeps its original colour.',
    '',
    `Read the image at: ${file}`,
    '',
    'Fields:',
    '- type: is the whole subject in frame, or is this a close detail of part of it?',
    '- pose: what it is doing or how it sits. One clause, no sentence.',
    '- faces: which way the subject points or looks. For an object, which way it is oriented.',
    '- energy: how much movement the image carries. low is still, high is mid-motion.',
    '- crop: what the frame includes, and name any edge where the source photo cuts through the subject',
    '  ("cropped at the shins", "bleeds all four edges"). This decides how it may be placed, so be exact.',
    '- ground: which slide grounds it survives on. "both" unless it would disappear or look wrong on one:',
    '  a very dark subject reads badly on navy, a very light one on white.',
    '- logos: is a brand mark visible anywhere.',
    '- note: anything that limits use — a recognisable person, a small source file, a distracting element.',
    '  Empty string when there is nothing to say. Do not invent a caveat.',
    ...(human ? [] : ['- subject: what the object actually is, two or three words ("carbon-plated race shoe").']),
    '',
    ...(category ? [`This object was filed under the "${category}" category.`] : []),
    'Answer only about what you can see. Never guess a brand, a person or a place.',
  ].join('\n');

  const out = await callModel({
    stage: 'tag', prompt, schema: human ? TAG_SHAPE_HUMAN : TAG_SHAPE_OBJECT,
    config: cfg, log, allowedTools: ['Read'],
  });
  return out;
}

// --------------------------------------------------------------------------
// Planning: what would happen, without doing any of it. --dry-run stops here.
// --------------------------------------------------------------------------
function plan({ brandDir, rawDir, only }) {
  const items = [];
  const humansDir = path.join(rawDir, 'humans');
  const objectsDir = path.join(rawDir, 'objects');

  const manifests = { humans: readManifest('humans', brandDir), objects: readManifest('objects', brandDir) };
  const stems = {
    humans: new Set((manifests.humans.cutouts || []).map((e) => path.basename(e.file, path.extname(e.file)))),
    objects: new Set((manifests.objects.objects || []).map((e) => path.basename(e.file, path.extname(e.file)))),
  };

  const add = (source, kind, category) => {
    const stem = path.basename(source, path.extname(source));
    const item = { source, rel: path.relative(rawDir, source), kind, category, stem };
    if (only && !item.rel.includes(only)) return;
    if (!SOURCE_EXT.test(source)) { items.push({ ...item, action: 'skip', why: 'not an image file' }); return; }
    if (stems[kind].has(stem)) { items.push({ ...item, action: 'skip', why: `already in ${kind === 'humans' ? 'cutouts.json' : 'objects.json'}` }); return; }
    items.push({ ...item, action: 'ingest' });
  };

  for (const f of walk(humansDir)) add(f, 'humans', null);
  for (const f of walk(objectsDir)) {
    const rel = path.relative(objectsDir, f);
    const category = rel.split(path.sep)[0];
    if (!category || category === path.basename(f)) { add(f, 'objects', null); continue; }
    add(f, 'objects', category);
  }
  return { items, manifests };
}

// --------------------------------------------------------------------------
async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const keepTemp = argv.includes('--keep-temp');
  const onlyAt = argv.indexOf('--only');
  const only = onlyAt >= 0 ? argv[onlyAt + 1] : null;
  const rawAt = argv.indexOf('--raw');
  const rest = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--only' && argv[i - 1] !== '--raw');
  const brand = rest[0];
  if (!brand) {
    console.error('usage: node pipeline/ingest-assets.js <brand> [--dry-run] [--only <substring>] [--raw <dir>]');
    process.exit(1);
  }

  const cfg = loadConfig(ROOT, brand);
  const brandDir = cfg.dir;
  const rawDir = rawAt >= 0 ? path.resolve(argv[rawAt + 1]) : path.join(brandDir, 'raw');

  // Startup validation, same contract as the renderer's: a manifest that does
  // not match the files on disk is a problem to fix before anything is added.
  for (const kind of ['humans', 'objects']) validateManifest(kind, brandDir, readManifest(kind, brandDir));

  if (!fs.existsSync(rawDir)) {
    console.error(`no raw directory at ${path.relative(ROOT, rawDir)}/ — nothing to ingest`);
    process.exit(1);
  }

  const { items, manifests } = plan({ brandDir, rawDir, only });
  const browser = await require('./render/lib/browser').launch();
  const page = await browser.browser.newPage();
  await page.addScriptTag({ content: geom.INPAGE });
  await page.addScriptTag({ content: TREAT_INPAGE });

  // Size is read from the source, so the dry run can report it too.
  for (const it of items) {
    if (it.action !== 'ingest') continue;
    try {
      const uri = `data:image/${path.extname(it.source).slice(1).replace('jpg', 'jpeg')};base64,${fs.readFileSync(it.source).toString('base64')}`;
      const size = await page.evaluate(async (u) => {
        const img = new Image(); img.src = u; await img.decode();
        return { w: img.naturalWidth, h: img.naturalHeight };
      }, uri);
      it.size = size;
      const long = Math.max(size.w, size.h);
      if (long < MIN_LONG_SIDE) {
        it.action = 'skip';
        it.why = `${size.w}x${size.h}: long side ${long}px is under the ${MIN_LONG_SIDE}px minimum`;
      }
    } catch (e) {
      it.action = 'skip';
      it.why = `unreadable image (${e.message.slice(0, 60)})`;
    }
  }

  report(items, rawDir);

  if (dryRun) {
    log('\ndry run: nothing was read from rembg, written, or added to a manifest.');
    await browser.close();
    return;
  }

  const todo = items.filter((i) => i.action === 'ingest');
  if (!todo.length) { log('\nnothing to ingest.'); await browser.close(); return; }

  const missing = toolCheck();
  if (missing.length) {
    await browser.close();
    console.error('\ncannot ingest: required tooling is not installed on this box.');
    for (const m of missing) console.error(`  ${m.tool} — ${m.why}\n    ${m.install}`);
    console.error('\n--dry-run works without it.');
    process.exit(2);
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-'));
  const added = { humans: 0, objects: 0 };
  try {
    for (const it of todo) {
      const spec = MANIFESTS[it.kind];
      const outDir = it.kind === 'objects' && it.category ? path.join(spec.dir(brandDir), it.category) : spec.dir(brandDir);
      const outFile = path.join(outDir, `${it.stem}.png`);
      log(`\n${it.rel}`);

      const cut = path.join(temp, `${it.stem}.rembg.png`);
      log('  rembg…');
      runRembg(it.source, cut);

      log(it.kind === 'humans' ? '  greyscale + autocontrast…' : '  autocontrast (colour kept)…');
      await treat(page, cut, outFile, { greyscale: it.kind === 'humans' });

      const g = await geom.analyse(page, outFile);
      if (g.empty) { fs.rmSync(outFile, { force: true }); log('  SKIPPED: rembg removed everything, no subject left'); continue; }

      log(`  geometry: ${g.width}x${g.height}, coverage ${g.coverage}, type-space [${g['type-space'].join(', ')}], dense [${g.dense.join(', ')}]`);
      const t = await tag({ cfg, file: outFile, kind: it.kind, category: it.category });

      const entry = {
        id: it.stem,
        file: `${it.stem}.png`,
        ...(it.kind === 'objects' ? { category: it.category || 'uncategorised', subject: t.subject || null } : {}),
        width: g.width,
        height: g.height,
        type: t.type,
        pose: t.pose,
        faces: t.faces,
        energy: t.energy,
        crop: t.crop,
        ground: t.ground,
        logos: !!t.logos,
        note: t.note || '',
        coverage: g.coverage,
        density: g.density,
        'type-space': g['type-space'],
        dense: g.dense,
      };
      manifests[it.kind][spec.key].push(entry);
      added[it.kind]++;
      log(`  tagged: ${t.type} · ${t.energy} energy · faces ${t.faces} · ground ${t.ground}`);
    }

    for (const kind of ['humans', 'objects']) {
      if (!added[kind]) continue;
      writeManifest(kind, brandDir, manifests[kind]);
      validateManifest(kind, brandDir, manifests[kind]);
      log(`\n${path.relative(ROOT, MANIFESTS[kind].file(brandDir))}: ${added[kind]} entr${added[kind] === 1 ? 'y' : 'ies'} added`);
    }
  } finally {
    await browser.close();
    if (!keepTemp) fs.rmSync(temp, { recursive: true, force: true });
    else log(`\ntemp kept at ${temp}`);
  }
}

function report(items, rawDir) {
  const ingest = items.filter((i) => i.action === 'ingest');
  const skip = items.filter((i) => i.action === 'skip');
  log(`raw: ${path.relative(ROOT, rawDir)}/`);
  log(`${items.length} file(s) found — ${ingest.length} to ingest, ${skip.length} skipped\n`);

  if (ingest.length) {
    log('WOULD INGEST');
    log(`  ${'file'.padEnd(44)}${'destination'.padEnd(22)}${'size'.padEnd(12)}treatment`);
    for (const i of ingest) {
      const treatment = i.kind === 'humans' ? 'rembg, greyscale, autocontrast' : 'rembg, autocontrast (colour kept)';
      const where = i.kind === 'humans' ? 'cutouts' : `objects/${i.category || 'uncategorised'}`;
      log(`  ${i.rel.padEnd(44)}${where.padEnd(22)}${(i.size ? `${i.size.w}x${i.size.h}` : '?').padEnd(12)}${treatment}`);
    }
    log('');
  }
  if (skip.length) {
    log('WOULD SKIP');
    const byWhy = {};
    for (const s of skip) (byWhy[s.why] = byWhy[s.why] || []).push(s.rel);
    for (const [why, files] of Object.entries(byWhy)) {
      log(`  ${why}`);
      for (const f of files) log(`    ${f}`);
    }
    log('');
  }
  const under = skip.filter((s) => /under the \d+px minimum/.test(s.why || ''));
  if (under.length) log(`WARNING: ${under.length} file(s) below ${MIN_LONG_SIDE}px on the long side were skipped and named above.`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e.stack || e); process.exit(1); });
}

module.exports = { plan, validateManifest, readManifest, MIN_LONG_SIDE, MANIFESTS };
