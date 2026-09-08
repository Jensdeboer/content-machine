#!/usr/bin/env node
'use strict';
// The Telegram inbox against the fixture, on a throwaway state.db and copies
// of config.md and rejected.md: every command, the stranger's message, the
// unknown deck, the non-pending deck, the help reply, and the offset.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { State } = require('../lib/db');
const { loadConfig } = require('../lib/config');
const inbox = require('../inbox');

const ROOT = path.resolve(__dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-'));
const brandDir = path.join(tmp, 'brands', 'pacevector');
fs.mkdirSync(path.join(brandDir, 'memory'), { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, 'brands', 'pacevector'))) {
  const src = path.join(ROOT, 'brands', 'pacevector', f);
  if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(brandDir, f));
}
fs.copyFileSync(path.join(ROOT, 'brands', 'pacevector', 'memory', 'rejected.md'), path.join(brandDir, 'memory', 'rejected.md'));
const cfg = loadConfig(tmp, 'pacevector');
const files = { config: path.join(brandDir, 'config.md'), rejected: path.join(brandDir, 'memory', 'rejected.md') };

// A state with the decks the fixture names. PV-03 blocked, the rest pending.
const state = new State(path.join(tmp, 'state.db'));
const run = state.startRun('pacevector');
const mk = (key, topic, status, headline) => {
  const b = state.addBrief(run, 'pacevector', { topic, series: 'Running 101', status: 'rendered' });
  state.updateBrief(b, { brief_json: JSON.stringify({ cover: { headline } }) });
  state.addDeck(run, b, { deckKey: key, topic, status, outDir: path.join(tmp, 'out', key), review: status === 'pending' ? { pass: true, publish: { ok: true } } : null });
};
mk('PV-03', 'advanced-footwear-individual-response', 'blocked', 'One test.');
mk('PV-07', 'systems-over-motivation', 'pending', 'Motivation is not a plan');
mk('PV-08', 'footwear-plantar-flexor-fatigue', 'pending', 'A bouncy shoe still leaves your calves working');
mk('PV-10', 'tibial-load-rehab-exercises', 'pending', 'Calf raises are not a running stride');

// --- parse ---------------------------------------------------------------------
assert.deepStrictEqual(inbox.parse('ok PV-07'), { action: 'ok', deckKey: 'PV-07', reason: '' });
assert.deepStrictEqual(inbox.parse('No pv-08 the calves claim rests on one small study'), { action: 'no', deckKey: 'PV-08', reason: 'the calves claim rests on one small study' });
assert.deepStrictEqual(inbox.parse('  SKIP pv-10 '), { action: 'skip', deckKey: 'PV-10', reason: '' });
assert.deepStrictEqual(inbox.parse('STATUS'), { action: 'status' });
assert.deepStrictEqual(inbox.parse('stop'), { action: 'stop' });
assert.deepStrictEqual(inbox.parse('go now'), { action: 'help' });
assert.deepStrictEqual(inbox.parse('ok'), { action: 'help' });
assert.deepStrictEqual(inbox.parse(''), { action: 'help' });
console.log('parse ok');

// --- the fixture, dry run: nothing written -------------------------------------
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'pipeline', 'fixtures', 'inbox.json'), 'utf8')).result;
const before = { config: fs.readFileSync(files.config, 'utf8'), rejected: fs.readFileSync(files.rejected, 'utf8') };
(async () => {
  const replies = [];
  const opts = { cfg, state, brand: 'pacevector', chatId: '1000', date: '2026-09-08', files, reply: async (t) => { replies.push(t); } };
  const dry = await inbox.processUpdates({ ...opts, updates: fixture, dryRun: true });
  assert.strictEqual(fs.readFileSync(files.config, 'utf8'), before.config, 'dry run must not touch config.md');
  assert.strictEqual(fs.readFileSync(files.rejected, 'utf8'), before.rejected, 'dry run must not touch rejected.md');
  assert.strictEqual(state.deckByKey('PV-08').status, 'pending', 'dry run must not reject');
  assert.strictEqual(state.deckByKey('PV-10').skipped_on, null, 'dry run must not skip');
  assert.strictEqual(state.inboxSeen(501), false, 'dry run records nothing');
  assert.strictEqual(dry.nextOffset, 512);
  const byId = Object.fromEntries(dry.results.map((r) => [r.updateId, r]));
  assert.strictEqual(byId[505].action, 'ignored', 'the stranger is ignored');
  assert.match(byId[505].why, /chat 2000 is not ours/);
  assert.strictEqual(byId[511].action, 'ignored', 'a photo is not a command');
  assert.strictEqual(replies.length, 9, 'one reply per honoured text message, none for the stranger or the photo');
  console.log('dry run: nothing written, stranger and photo ignored, 9 replies');

  // --- the fixture, for real, on the throwaway state ------------------------------
  replies.length = 0;
  const real = await inbox.processUpdates({ ...opts, updates: fixture, dryRun: false });
  const r = Object.fromEntries(real.results.map((x) => [x.updateId, x]));
  assert.ok(state.deckByKey('PV-07').approved_at, 'ok logs the approval');
  assert.strictEqual(state.deckByKey('PV-07').status, 'pending', 'ok keeps it pending');
  assert.match(r[501].reply, /ok: PV-07 \(systems-over-motivation\) stays in the queue/);
  assert.strictEqual(state.deckByKey('PV-08').status, 'rejected');
  assert.strictEqual(state.deckByKey('PV-08').brief_status, 'rejected');
  const rejected = fs.readFileSync(files.rejected, 'utf8');
  assert.match(rejected, /\| 2026-09-08 \| footwear-plantar-flexor-fatigue \| A bouncy shoe still leaves your calves working \| the calves claim rests on one small study \| topic \|\n$/, 'rejected.md row with slug, headline, reason, scope topic');
  assert.match(r[502].reply, /no: PV-08 \(footwear-plantar-flexor-fatigue\) rejected/);
  assert.strictEqual(state.deckByKey('PV-10').skipped_on, '2026-09-08');
  assert.match(r[503].reply, /skip: PV-10 .* steps out of today's packet/);
  // status ran after "no PV-08" in the same batch, so it already counts the rejection.
  assert.match(r[504].reply, /publishing on\npending 2 · packet_sent 0 · blocked 1 · needs_attention 0 · rejected 1/);
  assert.match(r[504].reply, /next in the queue: PV-07 · Running 101 · Motivation is not a plan/);
  assert.strictEqual(r[505].action, 'ignored');
  assert.match(r[506].reply, /publishing_enabled: no/);
  assert.deepStrictEqual(r[506].writes, ['config.md publishing_enabled -> no'], 'stop flips the kill switch');
  assert.match(r[507].reply, /publishing_enabled: yes/);
  assert.deepStrictEqual(r[507].writes, ['config.md publishing_enabled -> yes'], 'go flips it back');
  assert.strictEqual(fs.readFileSync(files.config, 'utf8'), before.config, 'stop then go leaves config.md byte-identical');
  // stop alone, on its own, really lands in the file.
  const stopOnly = inbox.handle({ cfg, state, brand: 'pacevector', cmd: inbox.parse('stop'), date: '2026-09-08', dryRun: false, files });
  assert.match(fs.readFileSync(files.config, 'utf8'), /^- `publishing_enabled`: no\./m, 'stop writes no into config.md');
  assert.deepStrictEqual(stopOnly.writes, ['config.md publishing_enabled -> no']);
  inbox.handle({ cfg, state, brand: 'pacevector', cmd: inbox.parse('go'), date: '2026-09-08', dryRun: false, files });
  assert.strictEqual(fs.readFileSync(files.config, 'utf8'), before.config);
  assert.match(r[508].reply, /PV-03 .* is blocked, not pending; nothing to approve/);
  assert.match(r[509].reply, /PV-99: no such deck/);
  assert.match(r[510].reply, /I understand these/);
  assert.strictEqual(r[511].action, 'ignored');
  assert.strictEqual(state.inboxSeen(501), true);
  assert.strictEqual(state.inboxSeen(505), true, 'the stranger is recorded too');
  assert.strictEqual(state.db.prepare('SELECT honoured FROM inbox_messages WHERE update_id = 505').get().honoured, 0);
  assert.strictEqual(state.db.prepare('SELECT reply FROM inbox_messages WHERE update_id = 501').get().reply, r[501].reply);
  console.log('real run on throwaway state: ok, no, skip, status, stop, go, blocked, unknown, help, stranger, photo, audit rows ok');

  // --- the same batch again: already processed, nothing repeats ------------------
  replies.length = 0;
  const again = await inbox.processUpdates({ ...opts, updates: fixture, dryRun: false });
  assert.ok(again.results.every((x) => x.action === 'ignored' && /already processed|not a text message/.test(x.why || '')), `a re-delivered batch is a no-op: ${JSON.stringify(again.results.map((x) => [x.updateId, x.action, x.why]))}`);
  assert.strictEqual(again.results.filter((x) => /already processed/.test(x.why || '')).length, 10, 'every recorded update, the stranger included, is recognised');
  assert.strictEqual(replies.length, 0);
  assert.strictEqual((fs.readFileSync(files.rejected, 'utf8').match(/footwear-plantar-flexor-fatigue/g) || []).length, 1, 'no duplicate rejected.md row');
  console.log('re-delivery: idempotent');

  // --- the packet steps over a skipped deck today -----------------------------------
  const pending = state.pendingDecks('pacevector');
  assert.deepStrictEqual(pending.map((d) => [d.deck_key, d.skipped_on]), [['PV-07', null], ['PV-10', '2026-09-08']]);
  console.log('queue: PV-08 gone (rejected), PV-10 carries skipped_on for the packet');

  // --- one reader -------------------------------------------------------------------
  assert.deepStrictEqual(inbox.otherReadersOf(path.join(ROOT, 'pipeline'), path.join(ROOT, 'pipeline', 'inbox.js')), [], 'inbox.js must be the only reader of Telegram updates');
  console.log('one reader: asserted');

  state.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('inbox: ok');
})().catch((e) => { console.error(e); process.exit(1); });
