#!/usr/bin/env node
'use strict';
// The packet failed on 8 Sep 2026 with a provider 400: the full TikTok
// caption (582 characters) had been sent as the draft title, which TikTok
// caps at 90. The title now comes from the headline, cut at a word boundary,
// and every field is checked against config.md's documented limits before
// any HTTP call, with the field and both numbers in the message.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { draftTitle } = require('../packet');
const { preflight, jpegSize, pushFields, assertSafeMode, POST_MODE, pushPhotos } = require('../lib/provider');
const { loadConfig } = require('../lib/config');

const ROOT = path.resolve(__dirname, '..', '..');
const limits = loadConfig(ROOT, 'pacevector').provider.limits;
assert.strictEqual(limits.titleChars, 90);

// --- draftTitle -------------------------------------------------------------
assert.strictEqual(draftTitle('More steps, same pace, less knee load.', 90), 'More steps, same pace, less knee load.');
const long = 'Motivation is not a plan and neither is a new pair of shoes bought on a Sunday evening after a bad week';
const t = draftTitle(long, 90);
assert.ok(t.length <= 90, `title ${t.length} > 90`);
assert.ok(long.startsWith(t), 'cut must be a prefix');
assert.ok(!t.endsWith(' ') && long[t.length] === ' ', 'cut must land on a word boundary');
assert.strictEqual(draftTitle('  spaced   out   headline  ', 90), 'spaced out headline');
assert.strictEqual(draftTitle('', 90, 'PV-01 topic'), 'PV-01 topic');
assert.strictEqual(draftTitle('x'.repeat(200), 90).length, 90, 'no boundary: hard cut');
const caption = 'a'.repeat(582);
assert.ok(draftTitle(caption, 90).length <= 90, 'a caption-sized string can never come out over the limit');
// Short headlines get the topic slug so the drafts list says something.
assert.strictEqual(draftTitle('2.7M', 90, 'PV-02', { topic: 'air-pollution-marathon-performance' }), '2.7M · air-pollution-marathon-performance');
assert.strictEqual(draftTitle('Run slower.', 90, 'x', { topic: 'easy-pace' }), 'Run slower. · easy-pace', '11 characters is short');
assert.strictEqual(draftTitle('Run slower!!', 90, 'x', { topic: 'easy-pace' }), 'Run slower!!', '12 characters is not');
assert.strictEqual(draftTitle('2.7M', 90, 'PV-02'), '2.7M', 'no topic known: the headline alone');
const shortLong = draftTitle('2.7M', 20, 'x', { topic: 'a-very-long-topic-slug-that-will-not-fit' });
assert.ok(shortLong.length <= 20 && shortLong.startsWith('2.7M'), `short headline plus slug still cut to the limit: ${JSON.stringify(shortLong)}`);
console.log('draftTitle: prefix, word boundary, limit, fallback, short-headline slug ok');

// --- preflight --------------------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
const jpg = path.join(dir, '01.jpg');
fs.copyFileSync(path.join(ROOT, 'pipeline', 'render', 'examples', 'PV-01.json'), path.join(dir, 'brief.json')); // any file, for the exists check
// A 2x3 baseline JPEG header is enough for jpegSize; write SOI + SOF0 with height 3, width 2.
fs.writeFileSync(jpg, Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x03, 0x00, 0x02, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]));
assert.deepStrictEqual(jpegSize(fs.readFileSync(jpg)), { height: 3, width: 2 });
const base = { user: 'Pacevector', title: 'ok', description: 'the tiktok caption', files: [jpg], platform: 'tiktok', limits };
assert.deepStrictEqual(preflight(base), { warnings: [] });

// --- post mode: the only one possible -----------------------------------------
assert.strictEqual(POST_MODE, 'MEDIA_UPLOAD');
const fields = pushFields(base);
const byName = Object.fromEntries(fields.filter((f) => !f.file).map((f) => [f.name, f.value]));
assert.strictEqual(byName.post_mode, 'MEDIA_UPLOAD', 'every request carries post_mode MEDIA_UPLOAD');
assert.strictEqual(byName.description, 'the tiktok caption', 'description is the tiktok caption');
assert.strictEqual(fields.filter((f) => f.name === 'post_mode').length, 1);
assert.throws(() => assertSafeMode(fields.filter((f) => f.name !== 'post_mode')), /post_mode must be exactly MEDIA_UPLOAD/);
assert.throws(() => assertSafeMode([...fields.filter((f) => f.name !== 'post_mode'), { name: 'post_mode', value: 'DIRECT_POST' }]), /post_mode must be exactly MEDIA_UPLOAD/);
assert.throws(() => assertSafeMode([...fields, { name: 'post_mode', value: 'DIRECT_POST' }]), /post_mode must be exactly MEDIA_UPLOAD/);
// A caller cannot pass a mode: the option is ignored, the constant is sent.
(async () => {
  const dry = await pushPhotos({ ...base, url: 'https://example.invalid', apiKey: null, post_mode: 'DIRECT_POST', postMode: 'DIRECT_POST', dryRun: true });
  assert.strictEqual(dry.status, 'dry-run');
  assert.strictEqual(dry.fields.find((f) => f.name === 'post_mode').value, 'MEDIA_UPLOAD');
  console.log('post_mode: MEDIA_UPLOAD hardcoded, DIRECT_POST impossible, dry run sends nothing');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('provider-preflight: ok');
})().catch((e) => { console.error(e); process.exit(1); });

const fails = (over, re) => {
  let err = null;
  try { preflight({ ...base, ...over }); } catch (e) { err = e; }
  assert.ok(err, `expected a pre-flight failure for ${JSON.stringify(Object.keys(over))}`);
  assert.match(err.message, /pre-flight failed, nothing was sent/);
  assert.match(err.message, re);
};
fails({ title: 'a'.repeat(582) }, /title is 582 characters, the tiktok limit is 90/);
fails({ description: '' }, /description is empty; the provider would reuse the title/);
fails({ description: undefined }, /description is empty/);
fails({ title: '' }, /title is empty/);
fails({ user: '' }, /user is empty/);
fails({ files: [] }, /photos\[\] is empty/);
fails({ files: Array(36).fill(jpg) }, /photos\[\] has 36 files, the tiktok limit is 35/);
fails({ files: [path.join(dir, 'missing.jpg')] }, /missing\.jpg does not exist/);
fails({ files: [path.join(dir, 'brief.json')] }, /is \.json, the tiktok formats are jpg, jpeg, webp/);
fails({ description: 'b'.repeat(4001) }, /description is 4001 characters, the tiktok limit is 4000/);
fails({ description: Array(31).fill('@x').join(' ') }, /31 mentions, the tiktok limit is 30/);
// Oversize bytes.
const big = path.join(dir, 'big.jpg');
fs.writeFileSync(big, Buffer.concat([fs.readFileSync(jpg), Buffer.alloc(limits.photoBytesMax + 1)]));
fails({ files: [big] }, /big\.jpg is 20\.0 MB, the tiktok limit is 20 MB/);
// Resolution: a warning, never a block (config.md says why).
const real = path.join(ROOT, 'out', 'test', 'PV-01', '01.jpg');
if (fs.existsSync(real)) {
  const r = preflight({ ...base, files: [real] });
  assert.strictEqual(r.warnings.length, 1);
  assert.match(r.warnings[0], /1 of 1 over the documented tiktok maximum of 1080 px short side, 1920 px long side: 01\.jpg 2160x2700/);
  console.log('preflight: resolution over the documented maximum warns, does not block');
}
console.log('preflight: title, user, count, existence, format, bytes, description, mentions ok');
