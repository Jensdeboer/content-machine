'use strict';
// Upload-Post, the publishing provider config.md documents under "## Provider".
// One job here: push a deck's slides into the TikTok drafts, so posting is
// opening the app, picking the sound and tapping post.
//
// It never calls a direct-post endpoint. A photo post needs a sound, and a
// direct post gets whatever TikTok assigns, which is never a trending one —
// see "## Publishing" in config.md.
//
// Every brand-specific string (profile name, endpoint, key env name) is read
// from config.md by lib/config.js and passed in. Nothing is hardcoded here.
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { build, contentTypeFor } = require('./multipart');

function post(url, { headers, body, timeout }) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: target.hostname,
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      timeout,
      headers: { ...headers, 'content-length': body.length },
    }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: out }));
    });
    req.on('timeout', () => req.destroy(new Error(`upload-post timeout after ${timeout}ms`)));
    req.on('error', reject);
    req.end(body);
  });
}

// TikTok post mode. MEDIA_UPLOAD sends the photos to the TikTok inbox as a
// draft finished in-app, which is where the sound gets added and the whole
// reason the packet exists. DIRECT_POST publishes at once, with whatever
// sound TikTok assigns, and it is the provider's DEFAULT when the field is
// omitted: on 8 Sep 2026 a push without it went live. So the mode is a
// constant here, not a parameter and not a setting. There is no situation in
// which this pipeline publishes directly; a build that carries anything else
// throws before the HTTP call.
const POST_MODE = 'MEDIA_UPLOAD';

// The request as it will be sent, minus the photo bytes: what the dry run
// prints and what pushPhotos sends. One builder, so they cannot differ.
function pushFields({ user, title, description, files, platform }) {
  return [
    { name: 'user', value: user },
    { name: 'title', value: title },
    { name: 'description', value: description },
    { name: 'platform[]', value: platform },
    { name: 'post_mode', value: POST_MODE },
    ...files.map((f) => ({ name: 'photos[]', filename: path.basename(f), file: f, contentType: contentTypeFor(f), bytes: fs.existsSync(f) ? fs.statSync(f).size : null })),
  ];
}

function assertSafeMode(fields) {
  const modes = fields.filter((f) => f.name === 'post_mode');
  if (modes.length !== 1 || modes[0].value !== POST_MODE) {
    throw new Error(`refusing to push: post_mode must be exactly ${POST_MODE} once, got ${JSON.stringify(modes.map((m) => m.value))}`);
  }
}

// Pixel size of a JPEG from its SOF marker, without decoding it. Null for
// anything that is not a baseline or progressive JPEG.
function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

// Every field against the provider's documented limits (config.md "## Provider"),
// before any HTTP. A limit we can state ourselves beats a 400 from the provider:
// the message names the field and both numbers. Returns { warnings } or throws.
// Resolution is a warning, not a block, until a push shows whether the
// provider transcodes oversize images or rejects them (config.md says why).
function preflight({ user, title, description, files, platform, limits }) {
  const problems = [];
  const warnings = [];
  const oversize = [];
  const L = limits || {};
  if (!user || !String(user).trim()) problems.push('user is empty; config.md "## Provider" names the profile');
  if (!platform) problems.push('platform is empty');
  if (title === undefined || title === null || !String(title).trim()) problems.push('title is empty; the draft needs a label');
  else if (L.titleChars && title.length > L.titleChars) problems.push(`title is ${title.length} characters, the ${platform} limit is ${L.titleChars}`);
  // The provider fills an omitted description from the title, which doubles
  // the headline on the post. The description is always sent, and it is the
  // platform's own caption: never empty, never the other platform's.
  if (description === undefined || description === null || !String(description).trim()) problems.push('description is empty; the provider would reuse the title and the post would carry it twice');
  else {
    if (L.descriptionChars && description.length > L.descriptionChars) problems.push(`description is ${description.length} characters, the ${platform} limit is ${L.descriptionChars}`);
    const mentions = (String(description).match(/(^|\s)@\w/g) || []).length;
    if (L.descriptionMentions && mentions > L.descriptionMentions) problems.push(`description carries ${mentions} mentions, the ${platform} limit is ${L.descriptionMentions}`);
  }
  if (!files || !files.length) problems.push('photos[] is empty; no slides to push');
  else if (L.photosMax && files.length > L.photosMax) problems.push(`photos[] has ${files.length} files, the ${platform} limit is ${L.photosMax}`);
  for (const f of files || []) {
    const name = path.basename(f);
    if (!fs.existsSync(f)) { problems.push(`photos[] ${name} does not exist`); continue; }
    const ext = path.extname(f).slice(1).toLowerCase();
    if (L.photoFormats && L.photoFormats.length && !L.photoFormats.includes(ext)) problems.push(`photos[] ${name} is .${ext}, the ${platform} formats are ${L.photoFormats.join(', ')}`);
    const bytes = fs.statSync(f).size;
    if (L.photoBytesMax && bytes > L.photoBytesMax) problems.push(`photos[] ${name} is ${(bytes / 1048576).toFixed(1)} MB, the ${platform} limit is ${(L.photoBytesMax / 1048576).toFixed(0)} MB`);
    if (ext === 'jpg' || ext === 'jpeg') {
      const size = jpegSize(fs.readFileSync(f));
      if (size && (L.photoShortSideMax || L.photoLongSideMax)) {
        const short = Math.min(size.width, size.height), long = Math.max(size.width, size.height);
        if ((L.photoShortSideMax && short > L.photoShortSideMax) || (L.photoLongSideMax && long > L.photoLongSideMax)) oversize.push(`${name} ${size.width}x${size.height}`);
      }
    }
  }
  if (oversize.length) {
    warnings.push(`photos[] ${oversize.length} of ${files.length} over the documented ${platform} maximum of ${L.photoShortSideMax} px short side, ${L.photoLongSideMax} px long side: ${oversize.join(', ')} (the provider may transcode; see config.md)`);
  }
  if (problems.length) throw new Error(`upload-post pre-flight failed, nothing was sent:\n  ${problems.join('\n  ')}`);
  return { warnings };
}

// Throws on anything that is not a clean accept: a draft the packet claims to
// have pushed and did not is worse than a failed run, because the packet is
// what says the day is ready.
//
// dryRun: pre-flight, build and return the fields, send nothing.
async function pushPhotos({ url, user, apiKey, title, description, files, platform = 'tiktok', limits, timeoutMs = 180000, log = () => {}, dryRun = false }) {
  if (!dryRun && !apiKey) throw new Error('the provider api key is unset in the environment');
  const { warnings } = preflight({ user, title, description, files, platform, limits });
  for (const w of warnings) log(`upload-post pre-flight warning: ${w}`);

  const fields = pushFields({ user, title, description, files, platform });
  assertSafeMode(fields);
  if (dryRun) return { status: 'dry-run', response: null, raw: '', fields, warnings };

  const { contentType, body } = build(fields.map((f) => (f.file
    ? { name: f.name, filename: f.filename, contentType: f.contentType, data: fs.readFileSync(f.file) }
    : { name: f.name, value: f.value })));
  assertSafeMode(fields);

  const res = await post(url, {
    headers: { authorization: `Apikey ${apiKey}`, 'content-type': contentType },
    body,
    timeout: timeoutMs,
  });

  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch { /* not json; the status decides */ }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`upload-post HTTP ${res.status}: ${res.body.slice(0, 300)}`);
  }
  if (parsed && (parsed.success === false || parsed.error)) {
    throw new Error(`upload-post rejected the push: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  return { status: res.status, response: parsed, raw: res.body.slice(0, 500) };
}

// The id of the draft that was just created. The response nests it under a
// per-platform result and has changed shape before, so this looks for the
// first id-shaped field anywhere in it rather than a fixed path. A push whose
// id we cannot find is still a push: packet.js records the push either way and
// never repeats it, and the id is what we hand a human chasing a draft.
const ID_KEYS = /^(publish_id|draft_id|post_id|share_id|media_id|id)$/i;

function draftId(response) {
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);
    for (const [k, v] of Object.entries(node)) {
      if (ID_KEYS.test(k) && (typeof v === 'string' || typeof v === 'number') && String(v).trim()) return String(v).trim();
    }
    for (const v of Object.values(node)) {
      const found = walk(v);
      if (found) return found;
    }
    return null;
  };
  return walk(response);
}

module.exports = { pushPhotos, draftId, preflight, jpegSize, pushFields, assertSafeMode, POST_MODE };
