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
// Commands, case-insensitive, one per message, only from TELEGRAM_CHAT:
//   ok PV-07             the deck stays pending; approval logged on the row
//   no PV-07 <reason>    deck rejected; a topic-scoped row goes to rejected.md
//   skip PV-07           the packet steps over it today; still pending tomorrow
//   stop                 publishing_enabled: no in config.md
//   go                   publishing_enabled: yes
//   status               pending/blocked counts and the next deck in the queue
// Anything else gets one polite reply listing these. Every action is
// confirmed with a reply naming the deck. A message from any other chat id is
// recorded, ignored and never answered.
const fs = require('fs');
const path = require('path');
const https = require('https');

const { loadConfig } = require('./lib/config');
const { State } = require('./lib/db');
const { Telegram } = require('./lib/telegram');
const { publishGate } = require('./packet');

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
  '  ok PV-07             keep it in the queue',
  '  no PV-07 <reason>    reject it; the reason goes to rejected.md',
  '  skip PV-07           step over it today only',
  '  stop                 publishing off',
  '  go                   publishing on',
  '  status               the queue',
].join('\n');

function parse(text) {
  const t = String(text || '').trim();
  let m = t.match(/^(ok|no|skip)\s+([a-z]{1,4}-\d{1,4})\b\s*(.*)$/is);
  if (m) return { action: m[1].toLowerCase(), deckKey: m[2].toUpperCase(), reason: m[3].trim() };
  m = t.match(/^(stop|go|status)\s*$/i);
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

// --------------------------------------------------------------------------
// Acting. Pure over its inputs so the fixture test can drive it: returns the
// replies and the writes it made (or would have made, on a dry run).
// --------------------------------------------------------------------------
function headlineOf(deck) {
  try { const b = JSON.parse(deck.brief_json || 'null'); return b && b.cover && b.cover.headline ? b.cover.headline : null; } catch (e) { return null; }
}

function nextInQueue(cfg, state, brand, date) {
  for (const d of state.pendingDecks(brand)) {
    if (d.skipped_on === date) continue;
    if (publishGate(cfg, d).ok) return d;
  }
  return null;
}

function handle({ cfg, state, brand, cmd, date, dryRun, files }) {
  const w = (fn) => { if (!dryRun) fn(); };
  if (cmd.action === 'help') return { reply: HELP, writes: [] };

  if (cmd.action === 'status') {
    const counts = state.deckCounts(brand);
    const next = nextInQueue(cfg, state, brand, date);
    const pub = cfg.publishing.enabled ? 'on' : 'off';
    const lines = [
      `${brand}: publishing ${pub}`,
      `pending ${counts.pending || 0} · packet_sent ${counts.packet_sent || 0} · blocked ${counts.blocked || 0} · needs_attention ${counts.needs_attention || 0} · rejected ${counts.rejected || 0} · published ${counts.published || 0}`,
      next ? `next in the queue: ${next.deck_key} · ${next.series || ''} · ${headlineOf(next) || next.topic || ''}`.replace(/ · $/, '') : 'next in the queue: nothing passes the gate today',
    ];
    return { reply: lines.join('\n'), writes: [] };
  }

  if (cmd.action === 'stop' || cmd.action === 'go') {
    const on = cmd.action === 'go';
    const { changed, text } = setPublishing(files.config, on);
    w(() => fs.writeFileSync(files.config, text));
    return {
      reply: `publishing_enabled: ${on ? 'yes' : 'no'}${changed ? '' : ' (it already was)'}. ${on ? 'The 14:00 packet runs.' : 'No packets and no pushes until "go".'}`,
      writes: changed ? [`config.md publishing_enabled -> ${on ? 'yes' : 'no'}`] : [],
    };
  }

  // ok / no / skip: the deck must exist and, for ok and skip, be pending.
  const deck = state.deckByKey(cmd.deckKey);
  if (!deck || deck.brand !== brand) return { reply: `${cmd.deckKey}: no such deck. "status" lists the queue.`, writes: [] };
  const name = `${deck.deck_key} (${deck.topic || 'no topic'})`;

  if (cmd.action === 'ok') {
    if (deck.status !== 'pending') return { reply: `${name} is ${deck.status}, not pending; nothing to approve.`, writes: [] };
    w(() => state.approveDeck(deck.deck_key));
    return { reply: `ok: ${name} stays in the queue${deck.skipped_on === date ? ' (it is still skipped for today)' : ''}.`, writes: [`${deck.deck_key} approved_at`] };
  }
  if (cmd.action === 'skip') {
    if (deck.status !== 'pending') return { reply: `${name} is ${deck.status}, not pending; nothing to skip.`, writes: [] };
    w(() => state.skipDeck(deck.deck_key, date));
    return { reply: `skip: ${name} steps out of today's packet and is back in the queue tomorrow.`, writes: [`${deck.deck_key} skipped_on ${date}`] };
  }
  if (cmd.action === 'no') {
    if (deck.status === 'rejected') return { reply: `${name} is already rejected.`, writes: [] };
    if (deck.status === 'published' || deck.status === 'packet_sent') return { reply: `${name} is ${deck.status}; a rejection here would not recall it. Nothing changed.`, writes: [] };
    const reason = cmd.reason || 'rejected from Telegram, no reason given';
    const row = rejectedRow({ date, slug: deck.topic, idea: headlineOf(deck), reason });
    w(() => { state.rejectDeck(deck.deck_key, reason); fs.appendFileSync(files.rejected, row); });
    return {
      reply: `no: ${name} rejected. rejected.md gets "${deck.topic}" (scope topic): ${reason}`,
      writes: [`${deck.deck_key} status rejected`, `rejected.md += ${row.trim()}`],
    };
  }
  return { reply: HELP, writes: [] };
}

// One pass over a batch of updates. Records each before acting; skips any
// already recorded; only chatId is honoured. Returns what happened per update.
async function processUpdates({ updates, cfg, state, brand, chatId, date, dryRun, files, reply }) {
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
    if (!dryRun) state.updateInboxMessage(id, { reply: r.reply });
    results.push({ updateId: id, action: cmd.action, deckKey: cmd.deckKey, reply: r.reply, writes: r.writes, text: msg.text });
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
  const files = { config: cfg.file || path.join(cfg.dir, 'config.md'), rejected: path.join(cfg.dir, 'memory', 'rejected.md') };
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
    const { nextOffset } = await processUpdates({ updates, cfg, state, brand, chatId: ourChat, date: today(), dryRun, files, reply });
    if (nextOffset !== null && !fixture && !dryRun) { state.setInboxOffset(nextOffset); log(`inbox: offset -> ${nextOffset}`); }
    return finish(0);
  } catch (e) {
    console.error(e.stack || e);
    return finish(1);
  }
}

if (require.main === module) main();

module.exports = { parse, handle, processUpdates, setPublishing, rejectedRow, otherReadersOf, assertOnlyReader, HELP };
