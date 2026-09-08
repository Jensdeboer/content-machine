'use strict';
// pipeline/state.db — the run's own state. The brain stays in git (README
// principle 1); this file holds only what a run produces and observes, so it
// can be deleted and rebuilt without losing a brand's memory.
//
// node:sqlite is built in; the pipeline takes no dependency for state.
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  brand        TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL,              -- running | ok | failed
  summary      TEXT                        -- json
);

-- Every scanned item, kept and dropped alike, with its score and one-line
-- reason: when the account underperforms, this is how we find out whether
-- scan was too strict or too generous.
CREATE TABLE IF NOT EXISTS scan_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       INTEGER NOT NULL REFERENCES runs(id),
  feed         TEXT NOT NULL,
  tier         TEXT NOT NULL,              -- evidence-source | idea-source
  url          TEXT,
  title        TEXT,
  published    TEXT,
  screenshot   INTEGER,                    -- positioning.md binary gate, 1/0
  score        INTEGER,                    -- 1-5, null when the gate said no
  reason       TEXT NOT NULL,
  kept         INTEGER NOT NULL,
  seen_before  INTEGER NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS scan_items_url ON scan_items (url);

CREATE TABLE IF NOT EXISTS briefs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       INTEGER NOT NULL REFERENCES runs(id),
  brand        TEXT NOT NULL,
  topic        TEXT NOT NULL,              -- slug, minted by pick
  series       TEXT NOT NULL,
  angle        TEXT,
  score        INTEGER,
  status       TEXT NOT NULL,              -- picked | verified | written | rendered | blocked | needs_attention
  reason       TEXT,
  brief_json   TEXT,
  captions     TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  brief_id      INTEGER NOT NULL REFERENCES briefs(id),
  figure        TEXT NOT NULL,
  quote         TEXT NOT NULL,
  url           TEXT NOT NULL,
  publisher     TEXT NOT NULL,
  retrieved     TEXT NOT NULL,
  cross_checked INTEGER NOT NULL,
  headline      INTEGER NOT NULL,          -- headline figures are always cross-checked
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       INTEGER NOT NULL REFERENCES runs(id),
  brief_id     INTEGER REFERENCES briefs(id),
  deck_key     TEXT NOT NULL UNIQUE,
  topic        TEXT,
  status       TEXT NOT NULL,              -- pending | packet_sent | blocked | needs_attention | published
  reason       TEXT,
  out_dir      TEXT,
  review       TEXT,                       -- qa review.json
  draft_id     TEXT,                       -- the provider's id for the pushed TikTok draft
  draft_pushed_at TEXT,                    -- set once the push succeeded; the push is not repeated
  packet_sent_at TEXT,                     -- when packet.js sent the deck to Telegram
  sound        TEXT,                       -- the sound the packet suggested; the rotation rule reads it back
  approved_at  TEXT,                       -- "ok PV-07" from the Telegram inbox; a log, the deck was pending anyway
  skipped_on   TEXT,                       -- "skip PV-07": the packet steps over it on this date only
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- The Telegram inbox (pipeline/inbox.js, the only reader of the bot's
-- updates). The offset is the next update the reader asks Telegram for; every update
-- seen is recorded before it is acted on, so a reply that fails to send can
-- never make the action run twice.
CREATE TABLE IF NOT EXISTS inbox_state (
  key          TEXT PRIMARY KEY,
  value        TEXT
);
CREATE TABLE IF NOT EXISTS inbox_messages (
  update_id    INTEGER PRIMARY KEY,
  chat_id      TEXT,
  sender       TEXT,
  text         TEXT,
  honoured     INTEGER NOT NULL,           -- 0 when the chat id was not ours
  action       TEXT,                       -- ok | no | skip | stop | go | status | help | ignored
  deck_key     TEXT,
  reply        TEXT,
  created_at   TEXT NOT NULL
);

-- Written by the confirm step (step 06), not by run.js: posted.jsonl and this
-- table are both statements about reality, and only the confirm step observes it.
CREATE TABLE IF NOT EXISTS posts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  deck_key     TEXT NOT NULL,
  platform     TEXT NOT NULL,
  status       TEXT NOT NULL,              -- queued | published | failed
  published_at TEXT,
  permalink    TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metrics (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  deck_key     TEXT NOT NULL,
  platform     TEXT NOT NULL,
  captured_at  TEXT NOT NULL,
  reach        INTEGER,
  saves        INTEGER,
  follows      INTEGER,
  likes        INTEGER,
  comments     INTEGER,
  raw          TEXT
);
`;

const now = () => new Date().toISOString();

class State {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  // CREATE TABLE IF NOT EXISTS leaves an existing state.db on its old shape, so
  // columns added after a table first shipped are added here. Additive only:
  // this file may never drop what a previous run recorded.
  migrate() {
    const columns = this.db.prepare('PRAGMA table_info(decks)').all().map((c) => c.name);
    for (const col of ['draft_id', 'draft_pushed_at', 'packet_sent_at', 'sound', 'approved_at', 'skipped_on']) {
      if (!columns.includes(col)) this.db.exec(`ALTER TABLE decks ADD COLUMN ${col} TEXT`);
    }
  }

  close() { this.db.close(); }

  startRun(brand) {
    const r = this.db.prepare('INSERT INTO runs (brand, started_at, status) VALUES (?, ?, ?)').run(brand, now(), 'running');
    return Number(r.lastInsertRowid);
  }

  finishRun(runId, status, summary) {
    this.db.prepare('UPDATE runs SET finished_at = ?, status = ?, summary = ? WHERE id = ?')
      .run(now(), status, JSON.stringify(summary), runId);
  }

  // The deadman asks whether a run happened at all, newest first.
  recentRuns(brand, limit = 20) {
    return this.db.prepare('SELECT id, started_at, finished_at, status FROM runs WHERE brand = ? ORDER BY id DESC LIMIT ?')
      .all(brand, limit);
  }

  addScanItem(runId, it) {
    this.db.prepare(`INSERT INTO scan_items
      (run_id, feed, tier, url, title, published, screenshot, score, reason, kept, seen_before, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(runId, it.feed, it.tier, it.url || null, it.title || null, it.published || null,
        it.screenshot === null || it.screenshot === undefined ? null : (it.screenshot ? 1 : 0),
        it.score === null || it.score === undefined ? null : it.score,
        it.reason, it.kept ? 1 : 0, it.seenBefore ? 1 : 0, now());
  }

  // Scan skips anything already seen inside the window.
  seenUrls(days) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const rows = this.db.prepare('SELECT DISTINCT url FROM scan_items WHERE url IS NOT NULL AND created_at >= ?').all(cutoff);
    return new Set(rows.map((r) => r.url));
  }

  addBrief(runId, brand, b) {
    const t = now();
    const r = this.db.prepare(`INSERT INTO briefs
      (run_id, brand, topic, series, angle, score, status, reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(runId, brand, b.topic, b.series, b.angle || null, b.score ?? null, b.status || 'picked', b.reason || null, t, t);
    return Number(r.lastInsertRowid);
  }

  updateBrief(id, fields) {
    const cols = [], vals = [];
    for (const [k, v] of Object.entries(fields)) { cols.push(`${k} = ?`); vals.push(v); }
    cols.push('updated_at = ?'); vals.push(now());
    vals.push(id);
    this.db.prepare(`UPDATE briefs SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
  }

  addSource(briefId, s) {
    this.db.prepare(`INSERT INTO sources
      (brief_id, figure, quote, url, publisher, retrieved, cross_checked, headline, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(briefId, s.figure, s.quote, s.url, s.publisher, s.retrieved, s.crossChecked ? 1 : 0, s.headline ? 1 : 0, now());
  }

  addDeck(runId, briefId, d) {
    const t = now();
    this.db.prepare(`INSERT INTO decks
      (run_id, brief_id, deck_key, topic, status, reason, out_dir, review, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(runId, briefId, d.deckKey, d.topic || null, d.status, d.reason || null, d.outDir || null,
        d.review ? JSON.stringify(d.review) : null, t, t);
  }

  updateDeck(deckKey, fields) {
    const cols = [], vals = [];
    for (const [k, v] of Object.entries(fields)) { cols.push(`${k} = ?`); vals.push(v); }
    cols.push('updated_at = ?'); vals.push(now());
    vals.push(deckKey);
    this.db.prepare(`UPDATE decks SET ${cols.join(', ')} WHERE deck_key = ?`).run(...vals);
  }

  deckKeys() {
    return this.db.prepare('SELECT deck_key FROM decks').all().map((r) => r.deck_key);
  }

  // Every deck still waiting for a packet, oldest first. The packet takes the
  // first that passes the publish gate, so it needs the queue rather than the
  // head of it. Brand lives on the run and series on the brief, so the header
  // line costs one join each.
  pendingDecks(brand) {
    return this.db.prepare(`SELECT d.deck_key, d.topic, d.out_dir, d.reason, d.created_at,
                                   d.draft_id, d.draft_pushed_at, d.review, d.skipped_on, d.approved_at,
                                   b.series, b.captions, b.brief_json
                            FROM decks d
                            JOIN runs r ON r.id = d.run_id
                            LEFT JOIN briefs b ON b.id = d.brief_id
                            WHERE d.status = 'pending' AND r.brand = ?
                            ORDER BY d.created_at, d.id`).all(brand);
  }

  // The push happened, and it happens once. Written the moment the provider
  // accepts, so a failure anywhere after it cannot cost us the knowledge that
  // the draft already exists: a re-run reads this and skips the push.
  markDraftPushed(deckKey, draftId) {
    const t = now();
    this.db.prepare('UPDATE decks SET draft_id = ?, draft_pushed_at = ?, updated_at = ? WHERE deck_key = ?')
      .run(draftId || null, t, t, deckKey);
    return t;
  }

  // Sent, not posted: the deck is out of the queue and in the phone. The
  // confirm step is what later marks it published. The suggested sound is
  // recorded here, on the deck, because that is what the rotation rule reads.
  markPacketSent(deckKey, { sound = null } = {}) {
    const t = now();
    this.db.prepare("UPDATE decks SET status = 'packet_sent', packet_sent_at = ?, sound = ?, updated_at = ? WHERE deck_key = ?")
      .run(t, sound, t, deckKey);
    return t;
  }

  // Every deck a packet went out for, oldest first, with the sound suggested
  // (null when the shortlist was empty). The sound rule merges this with
  // posted.jsonl.
  soundHistory(brand) {
    return this.db.prepare(`SELECT d.deck_key, d.sound, d.packet_sent_at
                            FROM decks d JOIN runs r ON r.id = d.run_id
                            WHERE d.packet_sent_at IS NOT NULL AND r.brand = ?
                            ORDER BY d.packet_sent_at, d.id`).all(brand);
  }

  // --- the Telegram inbox ---------------------------------------------------
  deckByKey(deckKey) {
    return this.db.prepare(`SELECT d.*, b.series, b.brief_json, b.status AS brief_status, r.brand
                            FROM decks d LEFT JOIN briefs b ON b.id = d.brief_id JOIN runs r ON r.id = d.run_id
                            WHERE d.deck_key = ?`).get(deckKey) || null;
  }

  inboxOffset() {
    const r = this.db.prepare("SELECT value FROM inbox_state WHERE key = 'telegram_offset'").get();
    return r ? Number(r.value) : 0;
  }

  setInboxOffset(offset) {
    this.db.prepare("INSERT INTO inbox_state (key, value) VALUES ('telegram_offset', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(offset));
  }

  inboxSeen(updateId) {
    return !!this.db.prepare('SELECT 1 FROM inbox_messages WHERE update_id = ?').get(updateId);
  }

  recordInboxMessage(m) {
    this.db.prepare(`INSERT OR IGNORE INTO inbox_messages (update_id, chat_id, sender, text, honoured, action, deck_key, reply, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(m.updateId, m.chatId == null ? null : String(m.chatId), m.sender || null, m.text || null, m.honoured ? 1 : 0, m.action || null, m.deckKey || null, m.reply || null, now());
  }

  updateInboxMessage(updateId, fields) {
    const cols = [], vals = [];
    for (const [k, v] of Object.entries(fields)) { cols.push(`${k} = ?`); vals.push(v); }
    vals.push(updateId);
    this.db.prepare(`UPDATE inbox_messages SET ${cols.join(', ')} WHERE update_id = ?`).run(...vals);
  }

  approveDeck(deckKey) { const t = now(); this.updateDeck(deckKey, { approved_at: t }); return t; }

  skipDeck(deckKey, date) { this.updateDeck(deckKey, { skipped_on: date }); }

  rejectDeck(deckKey, reason) {
    const d = this.deckByKey(deckKey);
    this.updateDeck(deckKey, { status: 'rejected', reason });
    if (d && d.brief_id) this.updateBrief(d.brief_id, { status: 'rejected', reason });
  }

  deckCounts(brand) {
    const rows = this.db.prepare(`SELECT d.status, COUNT(*) n FROM decks d JOIN runs r ON r.id = d.run_id WHERE r.brand = ? GROUP BY d.status`).all(brand);
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  publishedDecks() {
    return this.db.prepare("SELECT deck_key, topic, updated_at FROM decks WHERE status = 'published'").all();
  }

  runDecks(runId) {
    return this.db.prepare('SELECT deck_key, status, reason FROM decks WHERE run_id = ? ORDER BY id').all(runId);
  }

  runBriefs(runId) {
    return this.db.prepare('SELECT id, topic, series, status, reason FROM briefs WHERE run_id = ? ORDER BY id').all(runId);
  }
}

module.exports = { State, SCHEMA };
