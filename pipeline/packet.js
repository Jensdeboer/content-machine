#!/usr/bin/env node
'use strict';
// The 14:00 packet for one brand.
//
//   node pipeline/packet.js pacevector
//   node pipeline/packet.js pacevector --dry-run
//
// --dry-run does everything but the provider push and the Telegram sends,
// and prints exactly what each would have carried. Nothing is recorded in
// state.db or deck.json. Run it before every change to this file.
//
// One deck a day, turned into a Telegram thread you can post from in a few
// taps: the slides as documents, each caption alone in its own message, the
// sound last. The TikTok drafts are filled by the provider first, so the phone
// only has to open the app, pick the sound and post.
//
// This script only ever SENDS. Nothing here reads replies, and nothing here
// ever should: two pollers on one bot token silently steal each other's
// updates, so whatever reads them one day must be the only thing that does.
//
// Exit code is the interface with cron: pipeline/cron.sh alerts on a non-zero
// exit. 0 for a packet sent and 0 for a deliberate no-op (kill switch off,
// nothing approved); non-zero for anything else, always with a Telegram message
// naming the deck.
//
// Only an APPROVED deck is posted. The nightly writes decks as pending and
// stops there; "ok PV-07" in the Telegram inbox (pipeline/inbox.js) is what
// makes one eligible. A day with nothing approved is a day off, not a
// failure: nothing is pushed, one message says so, and the exit is 0.
const fs = require('fs');
const path = require('path');

const { loadConfig } = require('./lib/config');
const { State } = require('./lib/db');
const { Telegram } = require('./lib/telegram');
const provider = require('./lib/provider');
const { readPosted } = require('./lib/brain');
const sounds = require('./lib/sounds');

const ROOT = path.resolve(__dirname, '..');
const log = (...a) => console.log(...a);

// .env on the box holds the bot token and the provider key (config.md says so,
// and says they are never in the repo). Node reads it natively; the pipeline
// takes no dependency for a key=value file.
function loadEnvFile() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file) || typeof process.loadEnvFile !== 'function') return;
  try { process.loadEnvFile(file); } catch (e) { console.error(`could not read .env: ${e.message}`); }
}

// --------------------------------------------------------------------------
// The deck on disk.
// --------------------------------------------------------------------------

// out_dir is what the run recorded; the configured output directory is where it
// would be if the folder moved between boxes. Either, or the packet fails.
function deckDir(cfg, deck) {
  const tried = [deck.out_dir, path.join(ROOT, cfg.run.outDir, deck.deck_key)].filter(Boolean);
  for (const dir of tried) if (fs.existsSync(dir)) return dir;
  throw new Error(`no output folder (looked in ${tried.join(', ')})`);
}

// 01.jpg, 02.jpg, ... in slide order. The cover is first and stays first.
function readSlides(dir) {
  const slides = fs.readdirSync(dir)
    .filter((f) => /^\d+\.(jpe?g|png)$/i.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
    .map((f) => path.join(dir, f));
  if (!slides.length) throw new Error(`no rendered slides in ${dir}`);
  return slides;
}

// state.db holds the captions the write stage produced; captions.json next to
// the slides is the same text, and is the fallback when the row was rebuilt.
function readCaptions(deck, dir) {
  const file = path.join(dir, 'captions.json');
  const sources = [
    { what: 'state.db', text: deck.captions },
    { what: 'captions.json', text: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null },
  ];
  for (const s of sources) {
    if (!s.text) continue;
    let parsed;
    try { parsed = JSON.parse(s.text); } catch (e) { throw new Error(`captions in ${s.what} are not JSON: ${e.message}`); }
    const instagram = String(parsed.instagram || '').trim();
    const tiktok = String(parsed.tiktok || '').trim();
    if (instagram && tiktok) return { instagram, tiktok };
    throw new Error(`captions in ${s.what} are missing ${!instagram ? 'instagram' : 'tiktok'}`);
  }
  throw new Error('no captions in state.db or captions.json');
}

// The draft's title is a label in TikTok's draft list and nothing more; the
// caption never goes through the provider. It comes from the cover headline,
// cut to the provider's limit at a word boundary. state.db has the brief the
// write stage produced; brief.json next to the slides is the fallback.
function coverHeadline(deck, dir) {
  const sources = [
    { what: 'state.db', text: deck.brief_json },
    { what: 'brief.json', text: fs.existsSync(path.join(dir, 'brief.json')) ? fs.readFileSync(path.join(dir, 'brief.json'), 'utf8') : null },
  ];
  for (const s of sources) {
    if (!s.text) continue;
    try { const b = JSON.parse(s.text); if (b.cover && b.cover.headline) return String(b.cover.headline); } catch (e) { /* try the next */ }
  }
  return null;
}

// A shout or a bare number ("2.7M") is a correct title and a useless label
// in the drafts list, so a headline under SHORT_TITLE_CHARS gets the topic
// slug appended: "2.7M · air-pollution-marathon-performance". Still cut to
// the limit at a word boundary.
const SHORT_TITLE_CHARS = 12;
function draftTitle(headline, max, fallback, { topic } = {}) {
  let t = String(headline || fallback || '').replace(/\s+/g, ' ').trim();
  if (!t) return String(fallback || '').slice(0, max);
  if (t.length < SHORT_TITLE_CHARS && topic) t = `${t} · ${topic}`;
  if (t.length <= max) return t;
  const cut = t.lastIndexOf(' ', max);
  t = (cut > 0 ? t.slice(0, cut) : t.slice(0, max)).replace(/[\s,;:.!?\u2014-]+$/u, '');
  return t || String(fallback || '').slice(0, max);
}

// --------------------------------------------------------------------------
// The publish gate. README rule 2: every number a post shows traces to a
// source, or the deck blocks. qa.js decides that and records it as
// review.publish; a gate the renderer honours and the packet ignores is not a
// gate, so a deck that fails it never leaves this script. No review at all is a
// closed gate too: the rule is that the deck traces, not that nobody looked.
// --------------------------------------------------------------------------
function publishGate(cfg, deck) {
  let review = null;
  if (deck.review) {
    try { review = JSON.parse(deck.review); } catch (e) { return { ok: false, why: `its qa review in state.db is not JSON (${e.message})` }; }
  } else {
    // A deck whose row was rebuilt: the file the renderer wrote sits next to
    // the slides.
    for (const dir of [deck.out_dir, path.join(ROOT, cfg.run.outDir, deck.deck_key)]) {
      const file = dir && path.join(dir, 'review.json');
      if (file && fs.existsSync(file)) {
        try { review = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* no usable review */ }
        break;
      }
    }
  }
  if (!review || !review.publish) return { ok: false, why: 'it has no qa review' };
  if (review.publish.ok) return { ok: true };
  const blocks = (review.publish.blocks || []).map((b) => `slide ${b.slide} ${b.rule}${b.figure ? ` "${b.figure}"` : ''}`);
  return { ok: false, why: `the publish gate is closed: ${blocks.join('; ') || 'no reason recorded'}` };
}

// --------------------------------------------------------------------------
// The sound. sounds.md is the week's shortlist, edited by hand, columns by
// header name (pipeline/lib/sounds.js). Which sound went with which deck is
// history, not a column in that file: the packet records it on the deck row in
// state.db and in deck.json's postedRow, which the confirm step appends to
// posted.jsonl. The rotation rule reads from those two places. A suggestion
// only: the sound is picked in the app at the last tap.
// --------------------------------------------------------------------------
function suggestSound(cfg, state, brand) {
  const shortlist = sounds.readShortlist(cfg.dir);
  const history = sounds.soundHistory(readPosted(cfg.dir), state.soundHistory(brand));
  return sounds.pickSound(shortlist, history);
}

function soundLine(pick) {
  if (!pick.row) return `Sound: none suggested — ${pick.reason}. Pick one in the app.`;
  const r = pick.row;
  const head = [r.sound, r.artist && `— ${r.artist}`, r.platform && `(${r.platform})`].filter(Boolean).join(' ');
  return `Sound: ${head}${r.notes ? `\n${r.notes}` : ''}`;
}

// The postedRow the confirm step will append gets the sound, so posted.jsonl
// carries it alongside ground and cutout. A deck whose deck.json is gone is
// still packetable; state.db then holds the only record.
function recordSoundInDeckJson(dir, sound) {
  const file = path.join(dir, 'deck.json');
  if (!fs.existsSync(file)) return false;
  const deck = JSON.parse(fs.readFileSync(file, 'utf8'));
  deck.postedRow = { ...(deck.postedRow || {}), sound };
  fs.writeFileSync(file, JSON.stringify(deck, null, 2));
  return true;
}

// --------------------------------------------------------------------------
// Sending. A send that fails while the credentials are set fails the packet:
// half a packet is worse than none, because it looks like a day that is ready.
// With the credentials unset the messages go to stdout, exactly as config.md
// documents for every other Telegram message in the pipeline.
// --------------------------------------------------------------------------
async function mustSend(tg, what, send) {
  const res = await send();
  if (!res.ok && !res.offline) throw new Error(`telegram ${what} failed: ${res.reason}`);
  return res;
}

// The dry run's Telegram: prints each message in order, sends nothing.
class DryTelegram {
  constructor() { this.n = 0; }
  async send(text) { this.n++; log(`[dry-run] telegram message ${this.n}:\n${String(text).trim().split('\n').map((l) => '    ' + l).join('\n')}`); return { ok: true }; }
  async sendDocument(file) { this.n++; log(`[dry-run] telegram message ${this.n}: document ${path.relative(ROOT, file)} (${fs.statSync(file).size} bytes)`); return { ok: true }; }
}

function printPush(push) {
  log('[dry-run] upload-post request that would be sent:');
  for (const f of push.fields) {
    if (f.file) log(`    ${f.name} = ${path.relative(ROOT, f.file)} (${f.contentType}, ${f.bytes} bytes)`);
    else log(`    ${f.name} = ${JSON.stringify(f.value)}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const brand = args.find((a) => !a.startsWith('--'));
  if (!brand) {
    console.error('usage: node pipeline/packet.js <brand> [--dry-run]   e.g. node pipeline/packet.js pacevector');
    process.exit(1);
  }

  loadEnvFile();
  const cfg = loadConfig(ROOT, brand);
  const tg = dryRun ? new DryTelegram() : new Telegram(cfg.telegram);
  if (dryRun) log('DRY RUN: nothing is pushed, sent or recorded');
  const state = new State(path.join(ROOT, cfg.run.stateDb));

  const finish = (code) => { state.close(); process.exit(code); };
  let deck = null;
  const skipped = [];

  try {
    // 1. The kill switch, before anything else happens.
    if (!cfg.publishing.enabled) {
      await mustSend(tg, 'kill switch notice', () => tg.send(`${brand}: publishing_enabled is off in config.md. No packet today.`));
      log('publishing_enabled is off; nothing sent.');
      return finish(0);
    }

    // 2. The oldest APPROVED deck that has not been sent and passes the
    //    publish gate. Pending is not eligible: a deck nobody said "ok" to is
    //    a deck nobody looked at. One that fails the gate is stepped over
    //    rather than waited on: the next approved deck may be clean. Every
    //    skip is named in the message, because a deck silently held back is a
    //    deck nobody fixes.
    const queue = state.approvedDecks(brand);
    for (const candidate of queue) {
      const gate = publishGate(cfg, candidate);
      if (gate.ok) { deck = candidate; break; }
      skipped.push(`${candidate.deck_key}${candidate.topic ? ` (${candidate.topic})` : ''} — ${gate.why}`);
      log(`skipping ${candidate.deck_key}: ${gate.why}`);
    }
    // Nothing approved is the ordinary quiet day, not a failure: one message,
    // and the exit stays 0 so cron.sh raises no alert.
    if (!deck) {
      await mustSend(tg, 'empty queue notice', () => tg.send([
        "No approved deck ready — nothing posted today. Reply 'queue' to see what's pending.",
        ...(skipped.length ? ['', `${skipped.length} approved deck(s) stepped over:`, ...skipped] : []),
      ].join('\n')));
      log(`no packetable deck (${queue.length} approved, ${skipped.length} stepped over).`);
      return finish(0);
    }

    const dir = deckDir(cfg, deck);
    const slides = readSlides(dir);
    const captions = readCaptions(deck, dir);
    const pick = suggestSound(cfg, state, brand);
    const sound = pick.row ? pick.row.sound : null;
    log(`${deck.deck_key} (${deck.topic}): ${slides.length} slides from ${dir}`);
    log(pick.row ? `sound: "${sound}" (${pick.check.detail}${pick.lastUsed ? `; last used ${pick.lastUsed}` : '; unused'})` : `sound: none — ${pick.reason}`);

    // 3. The TikTok drafts, before the packet: the phone should find them
    //    already there. Pushed at most once per deck ever — the draft id and
    //    the time are written the moment the provider accepts, so every later
    //    run for this deck reuses them. That is what makes a failed send
    //    below safe to retry as often as it takes.
    if (deck.draft_pushed_at) {
      log(`upload-post: draft ${deck.draft_id || 'id unknown'} pushed at ${deck.draft_pushed_at}; not pushing again`);
    } else {
      // title: the headline, the draft's label. description: the TikTok
      // caption and nothing else, never the Instagram one, never both. The
      // mode is fixed inside provider.js: inbox draft, never a direct post.
      const title = draftTitle(coverHeadline(deck, dir), cfg.provider.limits.titleChars, `${deck.deck_key} ${deck.topic || ''}`, { topic: deck.topic });
      log(`upload-post: draft title "${title}" (${title.length} characters, limit ${cfg.provider.limits.titleChars}); description is the TikTok caption (${captions.tiktok.length} characters, limit ${cfg.provider.limits.descriptionChars}); post_mode ${provider.POST_MODE}`);
      const push = await provider.pushPhotos({
        url: cfg.provider.photoUrl,
        user: cfg.provider.user,
        apiKey: process.env[cfg.provider.keyEnv],
        title,
        description: captions.tiktok,
        files: slides,
        platform: 'tiktok',
        limits: cfg.provider.limits,
        log,
        dryRun,
      });
      if (dryRun) {
        printPush(push);
      } else {
        const id = provider.draftId(push.response);
        const at = state.markDraftPushed(deck.deck_key, id);
        log(`upload-post: HTTP ${push.status}, ${slides.length} photos to the ${cfg.provider.user} TikTok inbox as a draft`);
        log(`upload-post: draft ${id || 'id unknown'} recorded at ${at}${id ? '' : `; response: ${push.raw.slice(0, 300)}`}`);
      }
    }

    // 4. The packet, in posting order. An empty shortlist is said twice: once
    //    at the top, where it cannot be missed at 14:00, and once at the end
    //    where the sound belongs.
    const headerLines = [];
    if (!pick.row) headerLines.push('NO SOUND SUGGESTED');
    headerLines.push([deck.deck_key, deck.series, deck.topic].filter(Boolean).join(' · '));
    if (skipped.length) headerLines.push('', `${skipped.length} deck(s) skipped:`, ...skipped);
    await mustSend(tg, 'header', () => tg.send(headerLines.join('\n')));

    // Documents, never photos: sendPhoto re-compresses, and the cover is
    // already a jpg, so a photo message posts a twice-compressed cover.
    for (const slide of slides) {
      await mustSend(tg, `slide ${path.basename(slide)}`, () => tg.sendDocument(slide));
    }

    // Each caption alone in its own message, nothing else in it, so it copies
    // in one tap.
    await mustSend(tg, 'instagram caption', () => tg.send(captions.instagram));
    await mustSend(tg, 'tiktok caption', () => tg.send(captions.tiktok));
    await mustSend(tg, 'sound', () => tg.send(soundLine(pick)));

    // 5. Out of the queue, and the sound into history: the deck row and the
    //    postedRow, so the next packet's rotation reads it from either.
    if (dryRun) {
      log(`[dry-run] would mark ${deck.deck_key} packet_sent with sound ${JSON.stringify(sound)} in state.db and deck.json; not recorded`);
      return finish(0);
    }
    const at = state.markPacketSent(deck.deck_key, { sound });
    const inDeckJson = recordSoundInDeckJson(dir, sound);
    log(`${deck.deck_key}: packet_sent at ${at}; sound recorded in state.db${inDeckJson ? ' and deck.json postedRow' : ' (no deck.json to update)'}`);
    return finish(0);
  } catch (e) {
    const named = deck ? `${deck.deck_key}${deck.topic ? ` (${deck.topic})` : ''}` : 'no deck selected';
    await tg.send([
      `${brand}: packet FAILED — ${named}`,
      `${e.name || 'error'}: ${e.message}`,
      deck ? 'The deck is still approved; nothing was marked packet_sent. Re-running is safe: a draft the provider already accepted is never pushed twice.' : '',
    ].filter(Boolean).join('\n'));
    console.error(e.stack || e);
    return finish(1);
  }
}

if (require.main === module) main();

module.exports = { suggestSound, soundLine, recordSoundInDeckJson, publishGate, draftTitle, coverHeadline, deckDir, readSlides };
