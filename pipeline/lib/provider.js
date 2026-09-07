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

// Throws on anything that is not a clean accept: a draft the packet claims to
// have pushed and did not is worse than a failed run, because the packet is
// what says the day is ready.
async function pushPhotos({ url, user, apiKey, title, files, platform = 'tiktok', timeoutMs = 180000 }) {
  if (!apiKey) throw new Error('the provider api key is unset in the environment');
  if (!files.length) throw new Error('no slides to push');

  const { contentType, body } = build([
    { name: 'user', value: user },
    { name: 'title', value: title },
    { name: 'platform[]', value: platform },
    ...files.map((f) => ({ name: 'photos[]', filename: path.basename(f), contentType: contentTypeFor(f), data: fs.readFileSync(f) })),
  ]);

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

module.exports = { pushPhotos, draftId };
