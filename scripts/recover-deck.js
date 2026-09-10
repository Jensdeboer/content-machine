#!/usr/bin/env node
'use strict';
// Re-run one blocked idea through the pipeline, outside the nightly.
//
//   node scripts/recover-deck.js <brand> <idea.json> [<idea.json> ...]
//   node scripts/recover-deck.js pacevector recover/pv-12.json --dry-run
//
// An idea file is what PICK would have produced for this topic:
//   { "topic": "...", "series": "...", "angle": "...", "figures": ["..."] }
//
// It drives pipeline/run.js's own processIdea, which is the same function the
// nightly loop calls. VERIFY, WRITE, RENDER and QA all run, in that order,
// with the same rules and the same state and Telegram writes. There is no
// path here that skips a stage: a recovered idea whose figure still cannot be
// sourced blocks again, exactly as it did on the night.
//
// It mints a fresh deck key rather than reusing the blocked one. The blocked
// row is the record of what happened and stays as it is; the recovered deck is
// a new attempt at the same topic, and the run summary that recorded the block
// is never rewritten.
//
// Not part of the nightly: nothing imports it and cron never calls it.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { loadConfig } = require(path.join(ROOT, 'pipeline/lib/config'));
const { loadBrain } = require(path.join(ROOT, 'pipeline/lib/brain'));
const { State } = require(path.join(ROOT, 'pipeline/lib/db'));
const { Telegram } = require(path.join(ROOT, 'pipeline/lib/telegram'));
const { processIdea } = require(path.join(ROOT, 'pipeline/run'));

function loadEnvFile() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file) || typeof process.loadEnvFile !== 'function') return;
  try { process.loadEnvFile(file); } catch (e) { console.error(`could not read .env: ${e.message}`); }
}

const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

function readIdea(file) {
  const idea = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const k of ['topic', 'series', 'angle']) {
    if (!idea[k] || typeof idea[k] !== 'string') throw new Error(`${file}: "${k}" is required and must be a string`);
  }
  if (idea.figures !== undefined && !Array.isArray(idea.figures)) throw new Error(`${file}: "figures" must be an array when present`);
  return idea;
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const rest = argv.filter((a) => !a.startsWith('--'));
  const brand = rest[0];
  const ideaFiles = rest.slice(1);
  if (!brand || !ideaFiles.length) {
    console.error('usage: node scripts/recover-deck.js <brand> <idea.json> [<idea.json> ...] [--dry-run]');
    process.exit(1);
  }

  loadEnvFile();
  const cfg = loadConfig(ROOT, brand);
  const brain = loadBrain(cfg.dir);
  const ideas = ideaFiles.map(readIdea);

  // A topic the reviewer rejected outright is not recoverable by re-running
  // it; that decision is the brain's, not this script's. A figure-scoped
  // rejection leaves the topic open, which is exactly the recoverable case.
  const blockedByBrain = ideas
    .map((i) => brain.rejected.find((r) => r.scope !== 'figure' && r.slug === String(i.topic).toLowerCase()))
    .filter(Boolean);
  if (blockedByBrain.length) {
    console.error(`refusing: ${blockedByBrain.map((r) => r.slug).join(', ')} is in memory/rejected.md with scope=topic.`);
    console.error('Clear the row by hand first if the topic really is back on the table.');
    process.exit(2);
  }

  const state = new State(path.join(ROOT, cfg.run.stateDb));
  const tg = new Telegram(cfg.telegram);

  if (dryRun) {
    log(`dry run: ${ideas.length} idea(s) would be recovered, nothing written`);
    for (const i of ideas) log(`  ${i.topic} (${i.series}) — figures: ${JSON.stringify(i.figures || [])}`);
    state.close();
    return;
  }

  // Its own run row, so the recovery is visible in the history as its own
  // event rather than being folded into last night's numbers.
  const runId = state.startRun(brand);
  const summary = { brand, runId, backend: process.env.MODELS_BACKEND || 'cli', kind: 'recovery', stages: {}, briefs: 0, decks: [], deadFeeds: [], drift: [], stale: [], queue: null };
  log(`recovery run ${runId}: ${ideas.length} idea(s)`);

  try {
    for (const idea of ideas) {
      log(`--- ${idea.topic} ---`);
      // No scan ran, so there is no fresh evidence pull to hand verify. It
      // searches the primary tier itself, which is what it does for any figure
      // the night's feeds did not happen to cover.
      await processIdea({ cfg, brand, brain, state, runId, tg, summary, idea, evidence: [] });
    }
    state.finishRun(runId, 'ok', summary);
  } catch (e) {
    state.finishRun(runId, 'failed', { ...summary, error: e.message });
    throw e;
  }

  const line = (d) => `  ${d.status.padEnd(15)} ${d.deckKey}  ${d.topic}  — ${String(d.reason || '').replace(/\s+/g, ' ').slice(0, 120)}`;
  log('');
  log('recovered:');
  for (const d of summary.decks) log(line(d));
  const pending = summary.decks.filter((d) => d.status === 'pending').length;
  log(`${pending} of ${summary.decks.length} landed as pending`);
  state.close();
  process.exitCode = pending === summary.decks.length ? 0 : 3;
}

main().catch((e) => { console.error(e.stack || e); process.exit(1); });
