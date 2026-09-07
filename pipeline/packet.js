#!/usr/bin/env node
'use strict';
// The 14:00 packet for one brand.
//
//   node pipeline/packet.js pacevector
//
// One deck a day, turned into a Telegram thread you can post from in a few
// taps: the slides as documents, each caption alone in its own message, the
// sound last. The TikTok drafts are filled by the provider first, so the phone
// only has to open the app, pick the sound and post.
//
// This script only ever SENDS. Reading replies belongs to n8n: two pollers on
// one bot token silently steal each other's updates, so there is no getUpdates
// here and there must never be one.
//
// Exit code is the interface with n8n. 0 for a packet sent and 0 for a
// deliberate no-op (kill switch off, nothing approved); non-zero for anything
// else, always with a Telegram message naming the deck.
const fs = require('fs');
const path = require('path');

const { loadConfig } = require('./lib/config');
const { State } = require('./lib/db');
const { Telegram } = require('./lib/telegram');
const provider = require('./lib/provider');

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

// --------------------------------------------------------------------------
// The sound. sounds.md is the week's shortlist, rewritten every Sunday:
//   | # | Sound | Platform | Why it fits | Used on |
// A suggestion only: the sound is picked in the app at the last tap, and this
// script never writes the file back.
// --------------------------------------------------------------------------
function suggestSound(brandDir) {
  const file = path.join(brandDir, 'sounds.md');
  if (!fs.existsSync(file)) return null;
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*\|(.+)\|\s*$/);
    if (!m) continue;
    const c = m[1].split('|').map((s) => s.trim());
    if (c.every((x) => /^:?-{2,}:?$/.test(x))) continue;   // rule
    if (/^sound$/i.test(c[1] || '')) continue;             // header
    if (!c[1]) continue;                                   // an unfilled template row
    rows.push({ sound: c[1], platform: c[2] || '', why: c[3] || '', usedOn: c[4] || '' });
  }
  if (!rows.length) return null;
  // Never the same sound two days running: an unused one first, in shortlist
  // order, and otherwise the one used longest ago.
  const unused = rows.find((r) => !r.usedOn);
  return unused || rows.slice().sort((a, b) => a.usedOn.localeCompare(b.usedOn))[0];
}

function soundLine(sound) {
  if (!sound) return 'Sound: sounds.md has no shortlist this week — pick one in the app.';
  const head = [sound.sound, sound.platform && `(${sound.platform})`].filter(Boolean).join(' ');
  return `Sound: ${head}${sound.why ? `\n${sound.why}` : ''}`;
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

async function main() {
  const brand = process.argv[2];
  if (!brand) {
    console.error('usage: node pipeline/packet.js <brand>   e.g. node pipeline/packet.js pacevector');
    process.exit(1);
  }

  loadEnvFile();
  const cfg = loadConfig(ROOT, brand);
  const tg = new Telegram(cfg.telegram);
  const state = new State(path.join(ROOT, cfg.run.stateDb));

  const finish = (code) => { state.close(); process.exit(code); };
  let deck = null;

  try {
    // 1. The kill switch, before anything else happens.
    if (!cfg.publishing.enabled) {
      await mustSend(tg, 'kill switch notice', () => tg.send(`${brand}: publishing_enabled is off in config.md. No packet today.`));
      log('publishing_enabled is off; nothing sent.');
      return finish(0);
    }

    // 2. The oldest deck that passed qa and has not been sent.
    deck = state.oldestPendingDeck(brand);
    if (!deck) {
      await mustSend(tg, 'empty queue notice', () => tg.send(`${brand}: no approved deck for today.`));
      log('no pending deck.');
      return finish(0);
    }

    const dir = deckDir(cfg, deck);
    const slides = readSlides(dir);
    const captions = readCaptions(deck, dir);
    const sound = suggestSound(cfg.dir);
    log(`${deck.deck_key} (${deck.topic}): ${slides.length} slides from ${dir}`);

    // 3. The TikTok drafts, before the packet: the phone should find them
    //    already there. Pushed at most once per deck ever — the draft id and
    //    the time are written the moment the provider accepts, so every later
    //    run for this deck reuses them. That is what makes a failed send
    //    below safe to retry as often as it takes.
    if (deck.draft_pushed_at) {
      log(`upload-post: draft ${deck.draft_id || 'id unknown'} pushed at ${deck.draft_pushed_at}; not pushing again`);
    } else {
      const push = await provider.pushPhotos({
        url: cfg.provider.photoUrl,
        user: cfg.provider.user,
        apiKey: process.env[cfg.provider.keyEnv],
        title: captions.tiktok,
        files: slides,
        platform: 'tiktok',
      });
      const id = provider.draftId(push.response);
      const at = state.markDraftPushed(deck.deck_key, id);
      log(`upload-post: HTTP ${push.status}, ${slides.length} photos into the ${cfg.provider.user} drafts`);
      log(`upload-post: draft ${id || 'id unknown'} recorded at ${at}`);
    }

    // 4. The packet, in posting order. An empty shortlist is said twice: once
    //    at the top, where it cannot be missed at 14:00, and once at the end
    //    where the sound belongs.
    const header = [
      sound ? null : 'NO SOUND SHORTLIST',
      [deck.deck_key, deck.series, deck.topic].filter(Boolean).join(' · '),
    ].filter(Boolean).join('\n');
    await mustSend(tg, 'header', () => tg.send(header));

    // Documents, never photos: sendPhoto re-compresses, and the cover is
    // already a jpg, so a photo message posts a twice-compressed cover.
    for (const slide of slides) {
      await mustSend(tg, `slide ${path.basename(slide)}`, () => tg.sendDocument(slide));
    }

    // Each caption alone in its own message, nothing else in it, so it copies
    // in one tap.
    await mustSend(tg, 'instagram caption', () => tg.send(captions.instagram));
    await mustSend(tg, 'tiktok caption', () => tg.send(captions.tiktok));
    await mustSend(tg, 'sound', () => tg.send(soundLine(sound)));

    // 5. Out of the queue.
    const at = state.markPacketSent(deck.deck_key);
    log(`${deck.deck_key}: packet_sent at ${at}`);
    return finish(0);
  } catch (e) {
    const named = deck ? `${deck.deck_key}${deck.topic ? ` (${deck.topic})` : ''}` : 'no deck selected';
    await tg.send([
      `${brand}: packet FAILED — ${named}`,
      `${e.name || 'error'}: ${e.message}`,
      deck ? 'The deck is still pending; nothing was marked packet_sent. Re-running is safe: a draft the provider already accepted is never pushed twice.' : '',
    ].filter(Boolean).join('\n'));
    console.error(e.stack || e);
    return finish(1);
  }
}

if (require.main === module) main();
