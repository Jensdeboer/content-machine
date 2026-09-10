#!/usr/bin/env node
'use strict';
// The Telegram inbox: the ONE AND ONLY reader of the bot's updates.
//
//   node pipeline/inbox.js pacevector                 read new messages, act, reply
//   node pipeline/inbox.js pacevector --dry-run       act on nothing, print what would happen
//   node pipeline/inbox.js pacevector --fixture pipeline/fixtures/inbox.json [--dry-run]
//                                                     read the fixture instead of Telegram
//
// Runs every five minutes through pipeline/cron.sh (own lock, see crontab).
// Reads with getUpdates from a stored offset (state.db inbox_state), records
// every update before acting on it, acts, replies, then advances the offset.
//
// Two pollers on one bot token silently steal each other's updates, so this
// file is the only one that may call getUpdates. It asserts that at startup
// by scanning pipeline/ for the method name in code, and refuses to run if
// another file carries it. lib/telegram.js only ever sends.
//
// This is the approval gate. The nightly writes every deck as pending and
// stops; nothing posts until "ok" is sent here, and packet.js consumes the
// approved queue and nothing else.
//
// Notes (memory/notes.md) are WRITE-ONLY from the pipeline's side: this file
// appends to them and nothing in the pipeline reads them back. A single
// remark is an observation, not a rule. They accumulate for the Sunday
// review, where a human decides whether anything there becomes doctrine.
// test/inbox.js asserts that no other file in pipeline/ reads notes.md.
//
// Commands, case-insensitive, one per message, only from TELEGRAM_CHAT:
//   ok PV-07             pending -> approved; the next packet may post it
//   ok PV-07 <text>      the same, and the text is kept as a note
//   note PV-07 <text>    free-text feedback on any deck, in any state
//   no PV-07 <reason>    deck rejected; a topic-scoped row goes to rejected.md
//   skip PV-07           approved -> pending; decide again another day
//   stop                 publishing_enabled: no in config.md
//   go                   publishing_enabled: yes
//   status               publishing, the counts, and what posts next
//   queue                the whole backlog, in the order the packet reaches it
//   show PV-07           any deck's slides as documents; reading only
// Anything else gets one polite reply listing these. Every action is
// confirmed with a reply naming the deck. A message from any other chat id is
// recorded, ignored and never answered.
const fs = require('fs');
const path = require('path');
const https = require('https');

const { loadConfig } = require('./lib/config');
const { State } = require('./lib/db');
const { Telegram } = require('./lib/telegram');
const { publishGate, deckDir, readSlides } = require('./packet');

const ROOT = path.resolve(__dirname, '..');
const log = (...a) => console.log(...a);
const today = () => new Date().toISOString().slice(0, 10);

// --------------------------------------------------------------------------
// The one-reader assertion. Code lines only: a comment may name the method.
// --------------------------------------------------------------------------
function otherReadersOf(dir, self) {
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'fixtures') walk(f); continue; }
      if (!/\.(js|mjs|cjs|sh)$/.test(e.name) || path.resolve(f) === path.resolve(self)) continue;
      const code = fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|#)/.test(l)).join('\n');
      if (/getUpdates/.test(code)) hits.push(path.relative(ROOT, f));
    }
  };
  walk(dir);
  return hits;
}

function assertOnlyReader() {
  const others = otherReadersOf(path.join(ROOT, 'pipeline'), __filename);
  if (others.length) throw new Error(`inbox.js must be the only reader of Telegram updates, but getUpdates also appears in: ${others.join(', ')}`);
}

// --------------------------------------------------------------------------
// Telegram, the reading half. Lives here and nowhere else.
// --------------------------------------------------------------------------
function loadEnvFile() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file) || typeof process.loadEnvFile !== 'function') return;
  try { process.loadEnvFile(file); } catch (e) { console.error(`could not read .env: ${e.message}`); }
}

function getUpdates(token, offset) {
  const body = JSON.stringify({ offset, timeout: 0, allowed_updates: ['message'] });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org', path: `/bot${token}/getUpdates`, method: 'POST', timeout: 20000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { out += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(out); } catch (e) { return reject(new Error(`getUpdates returned non-JSON (HTTP ${res.statusCode}): ${out.slice(0, 200)}`)); }
        if (!parsed.ok) return reject(new Error(`getUpdates failed: ${JSON.stringify(parsed).slice(0, 200)}`));
        resolve(parsed.result || []);
      });
    });
    req.on('timeout', () => req.destroy(new Error('getUpdates timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

// --------------------------------------------------------------------------
// Parsing. One command per message; the deck key is normalised to upper case.
// --------------------------------------------------------------------------
const HELP = [
  'I understand these, one per message:',
  '  ok PV-07             approve it; the next packet may post it',
  '  ok PV-07 <text>      approve it and keep the text as a note',
  '  note PV-07 <text>    feedback on any deck, whatever state it is in',
  '  no PV-07 <reason>    reject it; the reason goes to rejected.md',
  '  skip PV-07           back to pending, decide again another day',
  '  stop                 publishing off',
  '  go                   publishing on',
  '  status               publishing, the counts, and what posts next',
  '  queue                everything still waiting, oldest first',
  '  show PV-07           the deck\'s slides, to look before deciding',
].join('\n');

function parse(text) {
  const t = String(text || '').trim();
  let m = t.match(/^(ok|no|skip|show|note)\s+([a-z]{1,4}-\d{1,4})\b\s*(.*)$/is);
  if (m) return { action: m[1].toLowerCase(), deckKey: m[2].toUpperCase(), reason: m[3].trim() };
  m = t.match(/^(stop|go|status|queue)\s*$/i);
  if (m) return { action: m[1].toLowerCase() };
  return { action: 'help' };
}

// --------------------------------------------------------------------------
// The brain files the inbox writes: the kill switch and rejected.md.
// --------------------------------------------------------------------------
function setPublishing(configFile, on) {
  const s = fs.readFileSync(configFile, 'utf8');
  const re = /^(-\s*`?publishing_enabled`?\s*:\s*)(yes|no|true|false|on|off)\b/im;
  if (!re.test(s)) throw new Error(`config.md has no publishing_enabled line to flip`);
  const next = s.replace(re, `$1${on ? 'yes' : 'no'}`);
  return { changed: next !== s, text: next };
}

function rejectedRow({ date, slug, idea, reason }) {
  const cell = (v) => String(v || '').replace(/\s*\|\s*/g, ' / ').replace(/\s+/g, ' ').trim();
  return `| ${date} | ${cell(slug)} | ${cell(idea)} | ${cell(reason)} | topic |\n`;
}

// Is this slug already excluded on this date? The row goes in before the deck
// row is flipped, so an action replayed after a crash would otherwise append a
// second identical row. The pair (date, slug) is what identifies it.
function hasRejectedRow(file, date, slug) {
  if (!fs.existsSync(file)) return false;
  return fs.readFileSync(file, 'utf8').split('\n').some((line) => {
    const cells = line.split('|').map((c) => c.trim());
    return cells.length >= 6 && cells[1] === date && cells[2] === String(slug || '');
  });
}

// notes.md. Minute precision, not just a date: several notes on one deck in a
// day are normal, and the order they were made in is part of the record.
function noteRow({ when, deck, topic, text }) {
  const cell = (v) => String(v || '').replace(/\s*\|\s*/g, ' / ').replace(/\s+/g, ' ').trim();
  return `| ${when} | ${cell(deck)} | ${cell(topic) || '-'} | ${cell(text)} |\n`;
}

// The row goes in before the update is recorded as seen, so a crash between
// the two would replay it. The same text on the same deck in the same minute
// is that replay, not a second thought.
function hasNoteRow(file, when, deck, text) {
  if (!fs.existsSync(file)) return false;
  const wanted = noteRow({ when, deck, topic: null, text }).split('|');
  return fs.readFileSync(file, 'utf8').split('\n').some((line) => {
    const cells = line.split('|').map((c) => c.trim());
    return cells.length >= 6 && cells[1] === when && cells[2] === String(deck || '') && cells[4] === wanted[4].trim();
  });
}

// --------------------------------------------------------------------------
// Acting. Pure over its inputs so the fixture test can drive it: returns the
// replies and the writes it made (or would have made, on a dry run).
// --------------------------------------------------------------------------
function headlineOf(deck) {
  try { const b = JSON.parse(deck.brief_json || 'null'); return b && b.cover && b.cover.headline ? b.cover.headline : null; } catch (e) { return null; }
}

// The deck packet.js would pick right now: the oldest approved one that
// passes the publish gate, chosen exactly as the packet chooses it.
function nextInQueue(cfg, state, brand) {
  for (const d of state.approvedDecks(brand)) if (publishGate(cfg, d).ok) return d;
  return null;
}

// Whole days between the deck's creation and today, by calendar date.
function ageDays(createdAt, date) {
  if (!createdAt) return null;
  const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${String(createdAt).slice(0, 10)}T00:00:00Z`)) / 86400000);
  return Number.isFinite(days) ? Math.max(0, days) : null;
}

function handle({ cfg, state, brand, cmd, date, dryRun, files, now = new Date() }) {
  const w = (fn) => { if (!dryRun) fn(); };
  // One place that writes a note, so `note` and `ok <text>` record identically.
  // Returns what to say and what was written, or null when there is no text.
  const recordNote = (deck, text) => {
    if (!text) return null;
    const when = `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 16)}`;
    const row = noteRow({ when, deck: deck.deck_key, topic: deck.topic, text });
    w(() => {
      fs.mkdirSync(path.dirname(files.notes), { recursive: true });
      if (!hasNoteRow(files.notes, when, deck.deck_key, text)) fs.appendFileSync(files.notes, row);
    });
    return { when, row, write: `notes.md += ${row.trim()}` };
  };
  if (cmd.action === 'help') return { reply: HELP, writes: [] };

  if (cmd.action === 'status') {
    const counts = state.deckCounts(brand);
    const next = nextInQueue(cfg, state, brand);
    const pub = cfg.publishing.enabled ? 'on' : 'off';
    const lines = [
      `${brand}: publishing ${pub}`,
      `pending ${counts.pending || 0} · approved ${counts.approved || 0} · blocked ${counts.blocked || 0}`,
      next ? `next to post: ${next.deck_key} · ${headlineOf(next) || next.topic || 'no headline'}` : 'next to post: none approved',
    ];
    return { reply: lines.join('\n'), writes: [] };
  }

  // The whole backlog, in the order the packet reaches it: approved decks are
  // what it takes, pending ones are what a single "ok" would add.
  if (cmd.action === 'queue') {
    const rows = state.queueDecks(brand);
    if (!rows.length) return { reply: 'Queue is empty.', writes: [] };
    const lines = rows.map((d) => {
      const age = ageDays(d.created_at, date);
      return [d.deck_key, d.topic || 'no topic', d.status, age === null ? 'age unknown' : `${age}d`].join(' · ');
    });
    return { reply: [`${brand}: ${rows.length} deck(s) waiting, oldest first`, ...lines].join('\n'), writes: [] };
  }

  if (cmd.action === 'stop' || cmd.action === 'go') {
    const on = cmd.action === 'go';
    const { changed, text } = setPublishing(files.config, on);
    w(() => fs.writeFileSync(files.config, text));
    return {
      reply: on ? 'Publishing resumed.' : "Publishing paused. No packet will post until you send 'go'.",
      writes: changed ? [`config.md publishing_enabled -> ${on ? 'yes' : 'no'}`] : [],
    };
  }

  // ok / no / skip / show. show works on any deck whatever its status; the
  // three that mutate check the status they need first.
  const deck = state.deckByKey(cmd.deckKey);
  if (!deck || deck.brand !== brand) return { reply: `No such deck: ${cmd.deckKey}`, writes: [] };
  const name = `${deck.deck_key} (${deck.topic || 'no topic'})`;

  if (cmd.action === 'show') {
    // Reading only: the rendered slides as documents, the same files the
    // packet sends, so what is inspected is what would post.
    let slides;
    try { slides = readSlides(deckDir(cfg, deck)); } catch (e) { return { reply: `${name} is ${deck.status} and has no rendered slides to show (${e.message}).`, writes: [] }; }
    const head = [deck.deck_key, deck.series, headlineOf(deck)].filter(Boolean).join(' · ');
    return { reply: `${head}\n${deck.status} · ${slides.length} slides follow`, documents: slides, writes: [] };
  }

  if (cmd.action === 'note') {
    // Deliberately ungated on status. Most feedback arrives after a deck is
    // live or after the metrics land, which is exactly when its state is no
    // longer pending — refusing those would throw away the useful half.
    if (!cmd.reason) return { reply: `${name}: a note needs something to say. Send "note ${deck.deck_key} <text>".`, writes: [] };
    const noted = recordNote(deck, cmd.reason);
    return {
      reply: `Noted on ${deck.deck_key} (${deck.topic || 'no topic'}), which is ${deck.status}: "${cmd.reason}"\nKept in notes.md for the Sunday review. Nothing about tonight's run changes.`,
      writes: [noted.write],
    };
  }

  if (cmd.action === 'ok') {
    // Trailing text is feedback, and it is kept whatever the approval does.
    // Approving something you still have a criticism of is the common case,
    // and a criticism attached to a deck that turns out to be blocked is
    // still the criticism: dropping it because the state was wrong would
    // throw away the half of the message that keeps its value.
    const noted = recordNote(deck, cmd.reason);
    const withNote = (r) => (noted
      ? { ...r, reply: `${r.reply}\nNoted: "${cmd.reason}" — kept in notes.md for the Sunday review.`, writes: [...r.writes, noted.write] }
      : r);
    // Approving what is already approved is the same state again: a message
    // delivered twice must be a no-op, not an error.
    if (deck.status === 'approved') return withNote({ reply: `${deck.deck_key} is already approved — it posts at the next packet run.`, writes: [] });
    // A blocked deck failed verification or qa. Approving it would put a deck
    // that did not trace in front of the packet, so it is refused with the
    // reason rather than silently let through.
    if (deck.status === 'blocked') {
      return withNote({ reply: `${name} is blocked and will not be approved: ${deck.reason || 'it failed verification or qa'}. Fix the deck or reject it with "no ${deck.deck_key} <reason>".`, writes: [] });
    }
    if (deck.status !== 'pending') return withNote({ reply: `${name} is ${deck.status}, not pending; nothing to approve.`, writes: [] });
    w(() => state.approveDeck(deck.deck_key));
    return withNote({
      reply: `Approved ${deck.deck_key} (${headlineOf(deck) || deck.topic || 'no headline'}) — will post at the next packet run.`,
      writes: [`${deck.deck_key} status approved`],
    });
  }
  if (cmd.action === 'skip') {
    if (deck.status !== 'pending' && deck.status !== 'approved') return { reply: `${name} is ${deck.status}, not pending or approved; nothing to skip.`, writes: [] };
    const was = deck.status;
    w(() => state.skipDeck(deck.deck_key, date));
    return {
      reply: `Skipped ${name} — ${was === 'approved' ? 'the approval is withdrawn and it is pending again' : 'it stays pending'}. Nothing goes to rejected.md; approve it any other day.`,
      writes: [`${deck.deck_key} status pending`],
    };
  }
  if (cmd.action === 'no') {
    // The reason is the whole point: it is what rejected.md carries forward
    // and what stops the picker proposing the topic again. Without one,
    // nothing happens.
    if (!cmd.reason) return { reply: `${name}: a rejection needs a reason — it is what keeps the topic from coming back. Send "no ${deck.deck_key} <reason>".`, writes: [] };
    if (deck.status === 'rejected') return { reply: `${name} is already rejected.`, writes: [] };
    if (deck.status === 'published' || deck.status === 'packet_sent') return { reply: `${name} is ${deck.status}; a rejection here would not recall it. Nothing changed.`, writes: [] };
    // rejected.md first, then the deck row. rejected.md is the brain and lives
    // in git; state.db is rebuildable from it and the output folders. A row
    // with no status flip is visible and harmless; a flip with no row loses
    // the memory for good. The row is skipped when the same date and slug are
    // already there, so acting on the same message twice cannot double it.
    const row = rejectedRow({ date, slug: deck.topic, idea: headlineOf(deck), reason: cmd.reason });
    w(() => {
      if (!hasRejectedRow(files.rejected, date, deck.topic)) fs.appendFileSync(files.rejected, row);
      state.rejectDeck(deck.deck_key, cmd.reason);
    });
    return {
      reply: `Rejected ${deck.deck_key} (${deck.topic || 'no topic'}). rejected.md now excludes the topic "${deck.topic}" permanently (scope topic): ${cmd.reason}`,
      writes: [`rejected.md += ${row.trim()}`, `${deck.deck_key} status rejected`],
    };
  }
  return { reply: HELP, writes: [] };
}

// One pass over a batch of updates. Records each before acting; skips any
// already recorded; only chatId is honoured. Returns what happened per update.
async function processUpdates({ updates, cfg, state, brand, chatId, date, dryRun, files, reply, replyDocument = async () => {} }) {
  const results = [];
  let maxId = null;
  for (const u of updates) {
    const id = u.update_id;
    if (typeof id === 'number') maxId = maxId === null ? id : Math.max(maxId, id);
    const msg = u.message;
    if (!msg || typeof msg.text !== 'string') { results.push({ updateId: id, action: 'ignored', why: 'not a text message' }); continue; }
    const from = msg.chat && msg.chat.id;
    const sender = msg.from ? [msg.from.first_name, msg.from.username && `@${msg.from.username}`].filter(Boolean).join(' ') : '';
    const honoured = String(from) === String(chatId);
    if (!dryRun && state.inboxSeen(id)) { results.push({ updateId: id, action: 'ignored', why: 'already processed' }); continue; }
    if (!honoured) {
      log(`inbox: ignored update ${id} from chat ${from} (${sender || 'unknown'}): not ${chatId}`);
      if (!dryRun) state.recordInboxMessage({ updateId: id, chatId: from, sender, text: msg.text, honoured: 0, action: 'ignored' });
      results.push({ updateId: id, action: 'ignored', why: `chat ${from} is not ours`, text: msg.text });
      continue;
    }
    const cmd = parse(msg.text);
    if (!dryRun) state.recordInboxMessage({ updateId: id, chatId: from, sender, text: msg.text, honoured: 1, action: cmd.action, deckKey: cmd.deckKey });
    const r = handle({ cfg, state, brand, cmd, date, dryRun, files });
    log(`inbox: ${JSON.stringify(msg.text)} -> ${cmd.action}${cmd.deckKey ? ' ' + cmd.deckKey : ''}${r.writes.length ? ' | ' + r.writes.join('; ') : ''}`);
    await reply(r.reply);
    for (const f of r.documents || []) await replyDocument(f);
    if (!dryRun) state.updateInboxMessage(id, { reply: r.documents ? `${r.reply}\n[${r.documents.length} documents]` : r.reply });
    results.push({ updateId: id, action: cmd.action, deckKey: cmd.deckKey, reply: r.reply, documents: r.documents || [], writes: r.writes, text: msg.text });
  }
  return { results, nextOffset: maxId === null ? null : maxId + 1 };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const fi = args.indexOf('--fixture');
  const fixture = fi >= 0 ? args[fi + 1] : null;
  const brand = args.find((a, i) => !a.startsWith('--') && (fi < 0 || i !== fi + 1));
  if (!brand) { console.error('usage: node pipeline/inbox.js <brand> [--dry-run] [--fixture file.json]'); process.exit(1); }

  assertOnlyReader();
  loadEnvFile();
  const cfg = loadConfig(ROOT, brand);
  const state = new State(path.join(ROOT, cfg.run.stateDb));
  const tg = new Telegram(cfg.telegram);
  const token = process.env[cfg.telegram.tokenEnv];
  const chatId = process.env[cfg.telegram.chatEnv];
  const files = {
    config: cfg.file || path.join(cfg.dir, 'config.md'),
    rejected: path.join(cfg.dir, 'memory', 'rejected.md'),
    notes: path.join(cfg.dir, 'memory', 'notes.md'),
  };
  const finish = (code) => { state.close(); process.exit(code); };
  if (dryRun) log('DRY RUN: nothing is written, replied or acknowledged');

  try {
    let updates;
    let ourChat = chatId;
    if (fixture) {
      const raw = JSON.parse(fs.readFileSync(path.resolve(fixture), 'utf8'));
      updates = Array.isArray(raw) ? raw : raw.result || raw.updates || [];
      // The fixture says which chat is ours, so the box's real chat id does
      // not turn every fixture message into a stranger.
      if (raw.our_chat_id !== undefined) ourChat = String(raw.our_chat_id);
      log(`inbox: ${updates.length} update(s) from fixture ${fixture}; our chat is ${ourChat}`);
    } else {
      if (!token || !chatId) { log(`inbox: ${cfg.telegram.tokenEnv}/${cfg.telegram.chatEnv} unset; nothing to read`); return finish(0); }
      const offset = state.inboxOffset();
      updates = await getUpdates(token, offset);
      log(`inbox: ${updates.length} update(s) from offset ${offset}`);
    }
    const reply = async (text) => {
      if (dryRun || fixture) { log(`[${dryRun ? 'dry-run' : 'fixture'}] reply:\n${String(text).split('\n').map((l) => '    ' + l).join('\n')}`); return { ok: true }; }
      const r = await tg.send(text);
      if (!r.ok && !r.offline) throw new Error(`reply failed: ${r.reason}`);
      return r;
    };
    const replyDocument = async (file) => {
      if (dryRun || fixture) { log(`[${dryRun ? 'dry-run' : 'fixture'}] reply document: ${path.relative(ROOT, file)} (${fs.statSync(file).size} bytes)`); return { ok: true }; }
      const r = await tg.sendDocument(file);
      if (!r.ok && !r.offline) throw new Error(`reply document ${path.basename(file)} failed: ${r.reason}`);
      return r;
    };
    const { nextOffset } = await processUpdates({ updates, cfg, state, brand, chatId: ourChat, date: today(), dryRun, files, reply, replyDocument });
    if (nextOffset !== null && !fixture && !dryRun) { state.setInboxOffset(nextOffset); log(`inbox: offset -> ${nextOffset}`); }
    return finish(0);
  } catch (e) {
    console.error(e.stack || e);
    return finish(1);
  }
}

if (require.main === module) main();

module.exports = { parse, handle, processUpdates, setPublishing, rejectedRow, hasRejectedRow, noteRow, hasNoteRow, ageDays, otherReadersOf, assertOnlyReader, HELP };
