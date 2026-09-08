#!/usr/bin/env node
'use strict';
// The Telegram inbox against the fixture, on a throwaway state.db and copies
// of config.md and rejected.md: every command, the approval gate, the
// stranger's message, the unknown deck, the blocked deck, the help reply, and
// the offset. Nothing here touches the real state.db, the real brain files or
// the real Telegram — the sender is injected.
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
  state.addDeck(run, b, { deckKey: key, topic, status, reason: status === 'blocked' ? 'slide 4 figure-without-source' : null, outDir: path.join(tmp, 'out', key), review: status === 'pending' ? { pass: true, publish: { ok: true } } : null });
};
fs.mkdirSync(path.join(tmp, 'out', 'PV-07'), { recursive: true });
for (let i = 1; i <= 7; i++) fs.writeFileSync(path.join(tmp, 'out', 'PV-07', `${String(i).padStart(2, '0')}.jpg`), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
mk('PV-03', 'advanced-footwear-individual-response', 'blocked', 'One test.');
mk('PV-07', 'systems-over-motivation', 'pending', 'Motivation is not a plan');
mk('PV-08', 'footwear-plantar-flexor-fatigue', 'pending', 'A bouncy shoe still leaves your calves working');
mk('PV-10', 'tibial-load-rehab-exercises', 'pending', 'Calf raises are not a running stride');

// --- parse ---------------------------------------------------------------------
assert.deepStrictEqual(inbox.parse('ok PV-07'), { action: 'ok', deckKey: 'PV-07', reason: '' });
assert.deepStrictEqual(inbox.parse('No pv-08 the calves claim rests on one small study'), { action: 'no', deckKey: 'PV-08', reason: 'the calves claim rests on one small study' });
assert.deepStrictEqual(inbox.parse('  SKIP pv-10 '), { action: 'skip', deckKey: 'PV-10', reason: '' });
assert.deepStrictEqual(inbox.parse('STATUS'), { action: 'status' });
assert.deepStrictEqual(inbox.parse(' Queue '), { action: 'queue' });
assert.deepStrictEqual(inbox.parse('stop'), { action: 'stop' });
assert.deepStrictEqual(inbox.parse('Show pv-07'), { action: 'show', deckKey: 'PV-07', reason: '' });
assert.deepStrictEqual(inbox.parse('go now'), { action: 'help' });
assert.deepStrictEqual(inbox.parse('ok'), { action: 'help' });
assert.deepStrictEqual(inbox.parse(''), { action: 'help' });
console.log('parse ok');

// --- ageDays ---------------------------------------------------------------------
assert.strictEqual(inbox.ageDays('2026-09-01T02:00:00Z', '2026-09-08'), 7);
assert.strictEqual(inbox.ageDays('2026-09-08T23:59:00Z', '2026-09-08'), 0);
assert.strictEqual(inbox.ageDays(null, '2026-09-08'), null);
console.log('ageDays ok');

// --- the fixture, dry run: nothing written -------------------------------------
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'pipeline', 'fixtures', 'inbox.json'), 'utf8')).result;
const before = { config: fs.readFileSync(files.config, 'utf8'), rejected: fs.readFileSync(files.rejected, 'utf8') };
(async () => {
  const replies = [];
  const documents = [];
  const opts = { cfg, state, brand: 'pacevector', chatId: '1000', date: '2026-09-08', files, reply: async (t) => { replies.push(t); }, replyDocument: async (f) => { documents.push(f); } };
  const dry = await inbox.processUpdates({ ...opts, updates: fixture, dryRun: true });
  assert.strictEqual(fs.readFileSync(files.config, 'utf8'), before.config, 'dry run must not touch config.md');
  assert.strictEqual(fs.readFileSync(files.rejected, 'utf8'), before.rejected, 'dry run must not touch rejected.md');
  assert.strictEqual(state.deckByKey('PV-07').status, 'pending', 'dry run must not approve');
  assert.strictEqual(state.deckByKey('PV-08').status, 'pending', 'dry run must not reject');
  assert.strictEqual(state.inboxSeen(501), false, 'dry run records nothing');
  assert.strictEqual(dry.nextOffset, 519);
  const byId = Object.fromEntries(dry.results.map((r) => [r.updateId, r]));
  assert.strictEqual(byId[505].action, 'ignored', 'the stranger is ignored');
  assert.match(byId[505].why, /chat 2000 is not ours/);
  assert.strictEqual(byId[511].action, 'ignored', 'a photo is not a command');
  assert.strictEqual(replies.length, 16, 'one reply per honoured text message, none for the stranger or the photo');
  assert.strictEqual(documents.length, 7, 'show PV-07 sends the seven slides, on a dry run too (nothing changes)');
  assert.match(byId[512].reply, /^PV-07 · Running 101 · Motivation is not a plan\npending · 7 slides follow$/);
  assert.match(byId[513].reply, /^No such deck: PV-99$/);
  // Nothing moved, so the queue is still all three pending decks.
  assert.match(byId[514].reply, /^pacevector: 3 deck\(s\) waiting, oldest first\nPV-07 · systems-over-motivation · pending · \d+d\nPV-08 · footwear-plantar-flexor-fatigue · pending · \d+d\nPV-10 · tibial-load-rehab-exercises · pending · \d+d$/);
  console.log('dry run: nothing written, stranger and photo ignored, 16 replies, show sent 7 documents, queue read-only');

  // --- the fixture, for real, on the throwaway state ------------------------------
  replies.length = 0; documents.length = 0;
  const real = await inbox.processUpdates({ ...opts, updates: fixture, dryRun: false });
  const r = Object.fromEntries(real.results.map((x) => [x.updateId, x]));

  // ok: pending -> approved, and that is what makes a deck postable.
  assert.strictEqual(r[501].reply, 'Approved PV-07 (Motivation is not a plan) — will post at the next packet run.');
  assert.ok(state.deckByKey('PV-07').approved_at, 'ok stamps approved_at');

  // no: rejected.md first, then the deck row, scope topic.
  assert.strictEqual(state.deckByKey('PV-08').status, 'rejected');
  assert.strictEqual(state.deckByKey('PV-08').brief_status, 'rejected');
  const rejected = fs.readFileSync(files.rejected, 'utf8');
  assert.match(rejected, /\| 2026-09-08 \| footwear-plantar-flexor-fatigue \| A bouncy shoe still leaves your calves working \| the calves claim rests on one small study \| topic \|\n$/, 'rejected.md row with slug, headline, reason, scope topic');
  assert.match(r[502].reply, /^Rejected PV-08 \(footwear-plantar-flexor-fatigue\)\. rejected\.md now excludes the topic "footwear-plantar-flexor-fatigue" permanently \(scope topic\): the calves claim rests on one small study$/);
  assert.deepStrictEqual(r[502].writes.map((w) => w.split(' ')[0]), ['rejected.md', 'PV-08'], 'rejected.md is written before the deck row');

  // skip on a pending deck: it stays pending, nothing goes to rejected.md.
  assert.strictEqual(state.deckByKey('PV-10').status, 'pending');
  assert.match(r[503].reply, /^Skipped PV-10 \(tibial-load-rehab-exercises\) — it stays pending\./);

  // status, taken mid-batch: PV-07 approved, PV-10 pending, PV-03 blocked.
  assert.strictEqual(r[504].reply, 'pacevector: publishing on\npending 1 · approved 1 · blocked 1\nnext to post: PV-07 · Motivation is not a plan');
  assert.strictEqual(r[505].action, 'ignored');

  // the kill switch
  assert.strictEqual(r[506].reply, "Publishing paused. No packet will post until you send 'go'.");
  assert.deepStrictEqual(r[506].writes, ['config.md publishing_enabled -> no'], 'stop flips the kill switch');
  assert.strictEqual(r[507].reply, 'Publishing resumed.');
  assert.deepStrictEqual(r[507].writes, ['config.md publishing_enabled -> yes'], 'go flips it back');
  assert.strictEqual(fs.readFileSync(files.config, 'utf8'), before.config, 'stop then go leaves config.md byte-identical');
  const stopOnly = inbox.handle({ cfg, state, brand: 'pacevector', cmd: inbox.parse('stop'), date: '2026-09-08', dryRun: false, files });
  assert.match(fs.readFileSync(files.config, 'utf8'), /^- `publishing_enabled`: no\./m, 'stop writes no into config.md');
  assert.deepStrictEqual(stopOnly.writes, ['config.md publishing_enabled -> no']);
  inbox.handle({ cfg, state, brand: 'pacevector', cmd: inbox.parse('go'), date: '2026-09-08', dryRun: false, files });
  assert.strictEqual(fs.readFileSync(files.config, 'utf8'), before.config);

  // a blocked deck is never approved by "ok", and the reason is given back.
  assert.match(r[508].reply, /^PV-03 \(advanced-footwear-individual-response\) is blocked and will not be approved: slide 4 figure-without-source\./);
  assert.strictEqual(state.deckByKey('PV-03').status, 'blocked', 'the blocked deck did not move');

  assert.strictEqual(r[509].reply, 'No such deck: PV-99');
  assert.match(r[510].reply, /I understand these/);
  assert.strictEqual(r[511].action, 'ignored');

  // show: read-only, and it works whatever the status is (PV-07 is approved now).
  assert.strictEqual(r[512].documents.length, 7);
  assert.ok(r[512].documents.every((f) => /PV-07[\\/]0[1-7]\.jpg$/.test(f)), 'the seven slides, in order');
  assert.match(r[512].reply, /\napproved · 7 slides follow$/, 'show reads the status, it does not change it');
  assert.strictEqual(state.deckByKey('PV-07').status, 'approved', 'show changes nothing');
  assert.match(state.db.prepare('SELECT reply FROM inbox_messages WHERE update_id = 512').get().reply, /\[7 documents\]$/);
  assert.strictEqual(r[513].reply, 'No such deck: PV-99');

  // queue: pending and approved, oldest first, in the order the packet reaches them.
  assert.match(r[514].reply, /^pacevector: 2 deck\(s\) waiting, oldest first\nPV-07 · systems-over-motivation · approved · \d+d\nPV-10 · tibial-load-rehab-exercises · pending · \d+d$/);

  // no without a reason: nothing happens, and it says why.
  assert.match(r[515].reply, /a rejection needs a reason/);
  assert.deepStrictEqual(r[515].writes, []);
  assert.strictEqual(state.deckByKey('PV-10').status, 'pending', 'a reasonless "no" rejects nothing');
  assert.strictEqual((fs.readFileSync(files.rejected, 'utf8').match(/tibial-load-rehab-exercises/g) || []).length, 0, 'and writes no rejected.md row');

  // skip on an approved deck withdraws the approval. The batch has run past
  // this point already, so the reply is what says what happened here; the
  // skip date it left behind is still on the row.
  assert.match(r[516].reply, /^Skipped PV-07 \(systems-over-motivation\) — the approval is withdrawn and it is pending again\./);
  assert.deepStrictEqual(r[516].writes, ['PV-07 status pending']);
  assert.strictEqual(state.deckByKey('PV-07').skipped_on, '2026-09-08', 'the day it was set aside is kept');

  // and it can be approved again, any day.
  assert.strictEqual(r[517].reply, 'Approved PV-07 (Motivation is not a plan) — will post at the next packet run.');
  assert.strictEqual(state.deckByKey('PV-07').status, 'approved');
  // approving what is already approved is a no-op, not an error.
  assert.strictEqual(r[518].reply, 'PV-07 is already approved — it posts at the next packet run.');
  assert.deepStrictEqual(r[518].writes, []);

  assert.strictEqual(state.inboxSeen(501), true);
  assert.strictEqual(state.inboxSeen(505), true, 'the stranger is recorded too');
  assert.strictEqual(state.db.prepare('SELECT honoured FROM inbox_messages WHERE update_id = 505').get().honoured, 0);
  assert.strictEqual(state.db.prepare('SELECT reply FROM inbox_messages WHERE update_id = 501').get().reply, r[501].reply);
  console.log('real run: ok, no, skip, status, queue, stop, go, blocked, unknown, help, stranger, photo, show, re-approve, audit rows ok');

  // --- the same batch again: already processed, nothing repeats ------------------
  replies.length = 0;
  const again = await inbox.processUpdates({ ...opts, updates: fixture, dryRun: false });
  assert.ok(again.results.every((x) => x.action === 'ignored' && /already processed|not a text message/.test(x.why || '')), `a re-delivered batch is a no-op: ${JSON.stringify(again.results.map((x) => [x.updateId, x.action, x.why]))}`);
  assert.strictEqual(again.results.filter((x) => /already processed/.test(x.why || '')).length, 17, 'every recorded update, the stranger included, is recognised');
  assert.strictEqual(replies.length, 0);
  assert.strictEqual((fs.readFileSync(files.rejected, 'utf8').match(/footwear-plantar-flexor-fatigue/g) || []).length, 1, 'no duplicate rejected.md row');
  console.log('re-delivery: idempotent');

  // --- acting on the same command twice, offset or no offset ----------------------
  // The offset save is what normally stops this; if it failed, the action
  // itself still has to be safe to repeat.
  const twice = () => inbox.handle({ cfg, state, brand: 'pacevector', cmd: inbox.parse('ok PV-07'), date: '2026-09-08', dryRun: false, files });
  const first = twice(), second = twice();
  assert.match(first.reply, /already approved/);
  assert.strictEqual(second.reply, first.reply, '"ok PV-07" twice is a no-op the second time, not an error');
  const noTwice = { cfg, state, brand: 'pacevector', cmd: inbox.parse('no PV-10 the exercises are physio territory'), date: '2026-09-08', dryRun: false, files };
  inbox.handle(noTwice);
  inbox.handle(noTwice);
  assert.strictEqual((fs.readFileSync(files.rejected, 'utf8').match(/tibial-load-rehab-exercises/g) || []).length, 1, '"no" replayed writes one rejected.md row, not two');
  assert.strictEqual(state.deckByKey('PV-10').status, 'rejected');
  console.log('replay: ok and no are both safe to run twice');

  // --- the queue the packet consumes ---------------------------------------------
  assert.deepStrictEqual(state.approvedDecks('pacevector').map((d) => d.deck_key), ['PV-07'], 'only an approved deck is in the packet queue');
  assert.deepStrictEqual(state.pendingDecks('pacevector').map((d) => d.deck_key), [], 'PV-08 and PV-10 rejected, PV-07 approved');
  assert.strictEqual(state.oldestApprovedDeck('pacevector').deck_key, 'PV-07');
  assert.deepStrictEqual(state.queueDecks('pacevector').map((d) => d.deck_key), ['PV-07']);
  console.log('queue: packet.js sees PV-07 and nothing else');

  // --- one reader -------------------------------------------------------------------
  assert.deepStrictEqual(inbox.otherReadersOf(path.join(ROOT, 'pipeline'), path.join(ROOT, 'pipeline', 'inbox.js')), [], 'inbox.js must be the only reader of Telegram updates');
  console.log('one reader: asserted');

  state.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('inbox: ok');
})().catch((e) => { console.error(e); process.exit(1); });
