#!/usr/bin/env node
'use strict';
// One nightly run for one brand folder.
//
//   node pipeline/run.js pacevector
//
// Six stages: scan, pick, verify, write, render, qa. State goes to SQLite as it
// goes. Nothing brand-specific lives in this file: the brand folder supplies the
// settings (config.md), the rules (positioning, series, banned, voice,
// deck-rules) and the feeds (sources.md), so a second brand is a folder.
//
// Failure policy: a stage failure parks that deck as needs_attention and sends
// Telegram; the run carries on with the other decks. One bad idea never costs
// the night. A rule violation is different from a failure — it parks the deck
// as blocked, which is a decision, not an accident.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { loadConfig } = require('./lib/config');
const { loadBrain, within } = require('./lib/brain');
const { State } = require('./lib/db');
const { Telegram } = require('./lib/telegram');
const feedsLib = require('./lib/feeds');
const { lintCopy, blocks: lintBlocks, flags: lintFlags } = require('./lib/lint');
const { callModel, ModelError } = require('./models');
const { validate } = require('./render/lib/schema-check');
const capacity = require('./render/capacity');
const renderHistory = require('./render/lib/history');
const evidenceLib = require('./lib/evidence');
const preview = require('./lib/preview');

const ROOT = path.resolve(__dirname, '..');
const BRIEF_SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, 'render', 'brief.schema.json'), 'utf8'));
// How much copy each component holds, measured by pipeline/render/capacity.js
// in the real font. Write is given the budgets so the copy fits by
// construction; without the file it writes blind and QA catches the overflow.
const CAPACITY = capacity.load();
const today = () => new Date().toISOString().slice(0, 10);

// A deck stopped by a rule, as opposed to a deck stopped by a failure.
class Blocked extends Error {
  constructor(reason, detail) { super(reason); this.name = 'Blocked'; this.detail = detail; }
}

const log = (...a) => console.log(...a);

function runNode(args, { cwd = ROOT } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

// --------------------------------------------------------------------------
// 0. Drift: state.db says published, posted.jsonl does not have the row.
// run.js never writes posted.jsonl — the confirm step owns that file, because
// it is the only stage that observes whether a post actually exists. A missing
// row means the confirm step failed silently, which is worth a message. Never
// auto-repaired: a silent repair would hide exactly the failure worth knowing.
// --------------------------------------------------------------------------
function driftCheck(state, brain) {
  const posted = new Set(brain.posted.map((r) => r.deckId));
  return state.publishedDecks().filter((d) => !posted.has(d.deck_key)).map((d) => d.deck_key);
}

// --------------------------------------------------------------------------
// 1. SCAN — pull the feeds sources.md lists, skip anything seen in the window,
//    score the rest against positioning.md. The screenshot test is a gate: a no
//    is out whatever it scored. Score and one-line reason are recorded for every
//    item, kept and dropped alike.
// --------------------------------------------------------------------------
const SCAN_SHAPE = `{
  "items": [
    {
      "index": 0,
      "screenshot": true,
      "score": 4,
      "reason": "one line, why this scores what it scores"
    }
  ]
}`;

async function stageScan({ cfg, brain, state, runId, tg, summary }) {
  const feeds = feedsLib.parseFeeds(brain.files.sources);
  if (!feeds.length) throw new Error('sources.md lists no feeds under "## Feeds"');

  const results = await feedsLib.fetchAll(feeds, {
    timeoutMs: cfg.run.feedTimeoutMs,
    userAgent: cfg.run.feedUserAgent,
    windowDays: cfg.run.scanSeenWindowDays,
    pauseMs: cfg.run.feedPauseMs,
    retryPauseMs: cfg.run.feedRetryPauseMs,
  });

  const dead = results.filter((r) => !r.ok);
  for (const d of dead) {
    summary.deadFeeds.push({ feed: d.feed.name, error: d.error });
    await tg.send(`dead feed: ${d.feed.name}\n${d.error}\n${d.url}\nThe run continued.`);
  }

  const seen = state.seenUrls(cfg.run.scanSeenWindowDays);
  const fresh = [], skipped = [];
  for (const r of results) {
    for (const item of r.items) {
      if (item.url && seen.has(item.url)) { skipped.push(item); continue; }
      fresh.push(item);
    }
  }
  for (const item of skipped) {
    state.addScanItem(runId, { ...item, screenshot: null, score: null, kept: false, seenBefore: true, reason: `seen within the last ${cfg.run.scanSeenWindowDays} days` });
  }

  // Score in chunks so one call never carries the whole night's feed volume.
  const chunkSize = cfg.run.maxItemsPerScanCall;
  const scored = [];
  for (let i = 0; i < fresh.length; i += chunkSize) {
    const chunk = fresh.slice(i, i + chunkSize);
    const prompt = [
      'You are scoring feed items for a running account, for topic selection only.',
      '',
      '--- positioning.md ---', brain.files.positioning, '--- end ---',
      '',
      'Score every item below.',
      '1. screenshot: the audience test from positioning.md — would a runner screenshot a post built on this to reread before Sunday\'s long run? true or false. This is a gate: false is out whatever it would score.',
      `2. score: 1-5 for how well a post built on this fits positioning.md. ${cfg.run.scanScoreThreshold} or more is kept.`,
      '3. reason: one line, plain, why it scores that.',
      '',
      'Items (score every index, kept and dropped alike):',
      JSON.stringify(chunk.map((it, n) => ({
        index: n,
        tier: it.tier,
        feed: it.feed,
        title: it.title,
        summary: it.summary || null,
      })), null, 1),
    ].join('\n');

    const out = await callModel({ stage: 'scan', prompt, schema: SCAN_SHAPE, config: cfg, log });
    const byIndex = new Map((out.items || []).map((s) => [Number(s.index), s]));
    chunk.forEach((item, n) => {
      const s = byIndex.get(n);
      const screenshot = s ? !!s.screenshot : null;
      const score = s && Number.isFinite(Number(s.score)) ? Number(s.score) : null;
      const reason = (s && s.reason) || 'no score returned for this item';
      const kept = !!(screenshot && score !== null && score >= cfg.run.scanScoreThreshold);
      state.addScanItem(runId, { ...item, screenshot, score, reason, kept, seenBefore: false });
      if (kept) scored.push({ ...item, score, reason });
    });
  }

  summary.stages.scan = {
    feeds: feeds.length, dead: dead.length, fetched: fresh.length + skipped.length,
    skippedSeen: skipped.length, scored: fresh.length, kept: scored.length,
  };
  log(`scan: ${feeds.length} feeds, ${dead.length} dead, ${fresh.length} fresh items, ${scored.length} kept at >=${cfg.run.scanScoreThreshold}`);
  return scored;
}

// --------------------------------------------------------------------------
// 2. PICK — ideas weighted by series.md, excluding recent topics and anything
//    ever rejected. Two exclusion passes: an exact slug match (cheap) and then
//    a model check for the same topic wearing a different slug.
// --------------------------------------------------------------------------
const PICK_SHAPE = `{
  "ideas": [
    {
      "topic": "kebab-case-slug",
      "series": "Running 101",
      "angle": "one sentence: the specific claim this deck makes",
      "figures": ["the numbers this deck will show, or [] if none"],
      "score": 4,
      "why": "one line, why this idea now"
    }
  ]
}`;

const DEDUPE_SHAPE = `{
  "duplicates": [
    { "topic": "kebab-case-slug", "sameAs": "the slug or headline it repeats", "reason": "one line" }
  ]
}`;

// The floor under the survival rate. A run of decks that all blocked gives a
// block rate of 1, and 1/(1-1) is not a number of ideas; capping the divisor
// at this says "assume at worst three in four are lost" rather than dividing
// by zero, and pick_max catches the result either way.
const MIN_SURVIVAL = 0.25;

// How many ideas tonight. The queue is kept at queue_target: at or above it,
// the queue is full and the night stops after pick.
//
// Below it, picking the bare shortfall systematically under-fills, because
// some of what is picked does not survive: a figure that cannot be sourced is
// blocked at verify, and a deck that fails a rule is blocked at QA. Picking 3
// against a deficit of 3 while half of them block leaves the queue 1.5 short
// every night, and the shortfall compounds. So the shortfall is divided by the
// recent survival rate — 1 minus the observed block rate over the last
// block_rate_runs finished runs (State.blockStats) — and rounded up.
//
// `blockRate` null means there is no history to measure yet; the night falls
// back to the old behaviour of picking the shortfall, capped at ideasPerRun,
// rather than inventing a rate. Returns { count, full, need, ... }.
function queuePlan({ pending, target, perRun, blockRate = null, maxPerRun = perRun }) {
  const need = target - pending;
  if (need <= 0) return { count: perRun, full: true, need, blockRate, survival: null, wanted: null, capped: false };
  if (blockRate === null || !Number.isFinite(blockRate)) {
    return { count: Math.max(1, Math.min(perRun, need)), full: false, need, blockRate: null, survival: null, wanted: null, capped: false };
  }
  const survival = Math.max(MIN_SURVIVAL, 1 - Math.min(Math.max(blockRate, 0), 1));
  const wanted = Math.ceil(need / survival);
  const count = Math.max(1, Math.min(maxPerRun, wanted));
  return { count, full: false, need, blockRate, survival, wanted, capped: wanted > maxPerRun };
}

// Pending decks older than deck_max_age, oldest first.
function staleDecks(pendingRows, maxAgeDays, now = new Date()) {
  const cutoff = now.getTime() - maxAgeDays * 86400000;
  return pendingRows.filter((d) => d.created_at && Date.parse(d.created_at) < cutoff);
}

// The cover headline off a deck row's brief, for a caption or a log line.
function headlineOf(row) {
  try { const b = JSON.parse(row.brief_json || 'null'); return b && b.cover ? b.cover.headline : null; } catch (e) { return null; }
}

function staleRow({ date, deck, headline, days }) {
  const cell = (v) => String(v || '').replace(/\s*\|\s*/g, ' / ').replace(/\s+/g, ' ').trim();
  return `| ${date} | ${cell(deck.topic)} | ${cell(headline)} | ${cell(`stale: ${deck.deck_key} sat pending for ${days} days without a packet and was dropped by the nightly. The deck, not the topic, is out; the angle may come back.`)} | figure |\n`;
}

const SOURCECHECK_SHAPE = `{
  "verdicts": [
    { "topic": "kebab-case-slug", "sourceable": true, "reason": "one line: what the source would be, or why there is none" }
  ]
}`;

// A cheap look at whether each candidate's central figure could be sourced at
// all, run inside PICK before an idea is committed to a brief.
//
// Why it exists: sourcing is the largest single loss, and it is discovered at
// VERIFY, which runs AFTER write. A figure that no primary source states costs
// a verify call, a write call and a render before anything notices. The same
// question asked here costs one call for the whole candidate list.
//
// What it is NOT: a second verify. It returns a boolean and a sentence, never
// a source row, and nothing it says reaches stageVerify — no url, no quote, no
// "already checked" flag. Verify re-asks every question from scratch against
// the full sources.md rules. The only thing this stage can do to a candidate
// is remove it, so it cannot widen what gets through: an idea it passes is an
// idea verify judges exactly as it would have judged it anyway.
//
// It fails OPEN by design. An unparseable answer, a missing verdict, a thrown
// call: the candidate is kept and verify decides, because a filter that
// silently eats good ideas when the model hiccups is worse than one that
// occasionally lets a doomed idea through to the stage that was always going
// to catch it.
async function stageSourceCheck({ cfg, brain, ideas, evidence, log: logFn = log, call = callModel }) {
  const withFigures = ideas.filter((i) => Array.isArray(i.figures) && i.figures.filter(Boolean).length);
  if (!withFigures.length) return { kept: ideas, dropped: [], checked: 0, skipped: ideas.length };

  const prompt = [
    'For each candidate below, decide one thing only: could its central figure plausibly be traced to a primary-tier source?',
    'This is a quick look, not a full verification. Do not collect quotes, urls or retrieval dates.',
    '',
    '--- sources.md (what counts as primary) ---', brain.files.sources, '--- end ---',
    '',
    'Answer sourceable=false only when you are reasonably confident no primary-tier source states the figure:',
    'it is a coaching rule of thumb, a number that circulates without a study behind it, or a claim the literature',
    'contradicts. When a plausible primary source exists, or you are unsure, answer sourceable=true and let the',
    'verify stage do the real work. Being unsure is a true, not a false.',
    '',
    `Today is ${today()}.`,
    '',
    'Candidates:',
    JSON.stringify(withFigures.map((i) => ({ topic: i.topic, angle: i.angle, figures: i.figures })), null, 1),
    '',
    'Evidence-source items already pulled tonight, which are real and dated:',
    JSON.stringify((evidence || []).slice(0, 30).map((e) => ({ title: e.title, url: e.url, published: e.published })), null, 1),
  ].join('\n');

  let verdicts = [];
  try {
    const out = await call({
      stage: 'sourcecheck', prompt, schema: SOURCECHECK_SHAPE, config: cfg, log: logFn,
      allowedTools: cfg.models.sourceCheckWebTools ? ['WebSearch', 'WebFetch'] : undefined,
    });
    verdicts = Array.isArray(out.verdicts) ? out.verdicts : [];
  } catch (e) {
    logFn(`pick: sourceability pre-check failed (${e.message}); keeping every candidate and letting verify decide`);
    return { kept: ideas, dropped: [], checked: 0, skipped: ideas.length, failed: e.message };
  }

  const bad = new Map();
  for (const v of verdicts) {
    if (!v || !v.topic || v.sourceable !== false) continue;   // anything but an explicit false is a keep
    bad.set(String(v.topic).toLowerCase(), String(v.reason || 'no primary-tier source found'));
  }
  const dropped = [];
  const kept = ideas.filter((i) => {
    const reason = bad.get(String(i.topic).toLowerCase());
    if (!reason) return true;
    dropped.push({ topic: i.topic, reason });
    return false;
  });
  return { kept, dropped, checked: withFigures.length, skipped: ideas.length - withFigures.length };
}

// What kind of claim each series wants (config.md, Angle preference). PICK
// used to reach for a number on every idea, which is how a Mindset deck ended
// up resting on a coaching rule of thumb that verify then could not source.
// Some series are not about numbers at all; one is, and should get the ideas
// where tonight's scan already turned up a paper with a chart in it.
const CHART_WORDS = /\b(figure|fig\.|table|chart|plot|graph|data|trial|randomi[sz]ed|cohort|meta-analysis)\b/i;

function anglePreferenceLines(cfg, scanned) {
  const prefs = (cfg.run && cfg.run.anglePreference) || {};
  const qualitative = Object.entries(prefs).filter(([, v]) => v === 'qualitative').map(([k]) => k);
  const figureBacked = Object.entries(prefs).filter(([, v]) => v === 'figure-backed').map(([k]) => k);
  if (!qualitative.length && !figureBacked.length) return [];
  const out = ['', '--- what kind of claim each series wants (config.md) ---'];
  if (qualitative.length) {
    out.push(`- ${qualitative.join(' and ')}: QUALITATIVE. Do not reach for a number. These teach a way of running,`,
      '  and an idea is not stronger for carrying a figure. Prescriptive advice ("keep most of it easy") is',
      '  welcome and needs no source; leave `figures` empty unless the number IS the idea.');
  }
  if (figureBacked.length) {
    const withCharts = (scanned || [])
      .filter((x) => x.tier === 'evidence-source' && CHART_WORDS.test(`${x.title || ''} ${x.reason || ''}`))
      .slice(0, 12).map((x) => ({ title: x.title, url: x.url, feed: x.feed }));
    out.push(`- ${figureBacked.join(' and ')}: FIGURE-BACKED. Prefer an idea resting on a real finding from a paper,`,
      '  and put the number in `figures` so verify can trace it.');
    if (withCharts.length) {
      out.push('  Items from tonight\'s evidence pull that look like they carry a chart or table:',
        `  ${JSON.stringify(withCharts, null, 1).replace(/\n/g, '\n  ')}`);
    } else {
      out.push('  Tonight\'s evidence pull turned up nothing that obviously carries a chart, so do not force one.');
    }
  }
  out.push('- Every other series: no preference, judge the idea on its merits.', '--- end ---');
  return out;
}

async function stagePick({ cfg, brain, state, runId, tg, summary, scanned, evidence = [], count = cfg.run.ideasPerRun, need = count }) {
  const recent = within(brain.posted, cfg.run.topicWindowDays);
  const recentSlugs = new Set(recent.map((r) => r.topic).filter(Boolean));
  // A topic-scoped rejection excludes the slug. A figure-scoped one does not:
  // the topic stays open, and the picker is told which figure died and what
  // survived so it proposes the surviving angle rather than the dead figure.
  const rejectedTopics = brain.rejected.filter((r) => r.scope !== 'figure');
  const rejectedFigures = brain.rejected.filter((r) => r.scope === 'figure');
  const rejectedSlugs = new Set(rejectedTopics.map((r) => r.slug).filter(Boolean));
  const seriesCounts = {};
  for (const r of within(brain.posted, 20 * 2)) seriesCounts[r.series] = (seriesCounts[r.series] || 0) + 1;

  const prompt = [
    'You are choosing what a running account posts next.',
    '',
    '--- positioning.md ---', brain.files.positioning, '--- end ---',
    '',
    '--- series.md ---', brain.files.series, '--- end ---',
    '',
    `Choose ${count} ideas.`,
    '- Weight the mix by the series weights in series.md, and respect its rotation rule.',
    ...anglePreferenceLines(cfg, scanned),
    '- Every idea gets a kebab-case topic slug that names the subject, not the headline.',
    '- An idea may come from a scanned item or from the evergreen reserve in series.md.',
    '- Evidence-source items may anchor a figure. Idea-source items (Reddit) tell you what people are confused about and may NEVER be cited as evidence.',
    '',
    `Already used in the last ${cfg.run.topicWindowDays} days (do not repeat): ${JSON.stringify([...recentSlugs])}`,
    `Rejected, never re-propose: ${JSON.stringify([...rejectedSlugs])}`,
    ...(rejectedFigures.length ? [
      'Figures rejected on topics that stay open. The figure named is dead; the topic may be proposed again on the surviving angle in the reason:',
      JSON.stringify(rejectedFigures.map((r) => ({ topic: r.slug, idea: r.idea, reason: r.reason })), null, 1),
    ] : []),
    `Series counts in recent history: ${JSON.stringify(seriesCounts)}`,
    '',
    'Scanned items, best first:',
    JSON.stringify(scanned.slice(0, 60).map((s) => ({ tier: s.tier, feed: s.feed, title: s.title, url: s.url, score: s.score, reason: s.reason })), null, 1),
  ].join('\n');

  const out = await callModel({ stage: 'pick', prompt, schema: PICK_SHAPE, config: cfg, log });
  let ideas = (out.ideas || []).filter((i) => i && i.topic && i.series);

  // Pass 1: exact slug, the cheap check.
  const exact = [];
  ideas = ideas.filter((i) => {
    const slug = String(i.topic).toLowerCase();
    if (recentSlugs.has(slug)) { exact.push({ topic: slug, reason: `slug used within ${cfg.run.topicWindowDays} days` }); return false; }
    if (rejectedSlugs.has(slug)) { exact.push({ topic: slug, reason: 'slug is in rejected.md' }); return false; }
    return true;
  });

  // Pass 2: same topic wearing a different slug. Model check, survivors only.
  let dupes = [];
  if (ideas.length) {
    const dedupePrompt = [
      'Decide whether any candidate topic repeats something already covered or already rejected.',
      'Two different slugs can be the same topic ("easy-pace-too-fast" and "running-easy-days-too-hard" are the same topic).',
      'Answer only for candidates that genuinely repeat one of the existing entries.',
      '',
      'Candidates:',
      JSON.stringify(ideas.map((i) => ({ topic: i.topic, angle: i.angle })), null, 1),
      '',
      `Posted in the last ${cfg.run.topicWindowDays} days (slug + cover headline):`,
      JSON.stringify(recent.map((r) => ({ topic: r.topic || null, headline: r.headline || null, series: r.series })), null, 1),
      '',
      'Rejected (slug + idea + reason):',
      JSON.stringify(rejectedTopics.map((r) => ({ topic: r.slug, idea: r.idea, reason: r.reason })), null, 1),
      ...(rejectedFigures.length ? [
        '',
        'These topics are NOT rejected. Only the figure named was, and a candidate on the same topic is allowed as long as it does not rest on that figure:',
        JSON.stringify(rejectedFigures.map((r) => ({ topic: r.slug, rejectedFigure: r.idea, reason: r.reason })), null, 1),
      ] : []),
    ].join('\n');
    const dd = await callModel({ stage: 'pick', prompt: dedupePrompt, schema: DEDUPE_SHAPE, config: cfg, log });
    dupes = (dd.duplicates || []).filter((d) => d && d.topic);
    const dupSlugs = new Set(dupes.map((d) => String(d.topic).toLowerCase()));
    ideas = ideas.filter((i) => !dupSlugs.has(String(i.topic).toLowerCase()));
  }

  for (const d of [...exact, ...dupes]) log(`pick: dropped "${d.topic}" — ${d.reason || d.sameAs}`);

  // Pass 3: sourceability. Cheap, and it moves the commonest loss off the
  // expensive path. Only ever removes candidates; see stageSourceCheck.
  let unsourceable = [];
  let sourceCheck = null;
  if (cfg.run.sourceabilityPrecheck) {
    sourceCheck = await stageSourceCheck({ cfg, brain, ideas, evidence });
    unsourceable = sourceCheck.dropped;
    ideas = sourceCheck.kept;
    for (const d of unsourceable) log(`pick: dropped "${d.topic}" — no primary source in sight: ${d.reason}`);
  }

  // Replacements, one round only. The pre-check just removed candidates the
  // night was counting on, so ask once more for the shortfall, excluding
  // everything already proposed or dropped, and put the newcomers through the
  // same pre-check. One round, never a loop: a night where nothing is
  // sourceable should come up short and say so, not keep paying for calls.
  let toppedUp = [];
  if (unsourceable.length && ideas.length < need) {
    const spent = new Set([...ideas, ...unsourceable, ...exact, ...dupes].map((i) => String(i.topic).toLowerCase()));
    const replacePrompt = [
      prompt,
      '',
      `A first pass already ran. Propose ${need - ideas.length} DIFFERENT idea(s).`,
      `Do not propose any of these again: ${JSON.stringify([...spent])}`,
      'These were dropped because their central figure has no primary-tier source. Do not propose the same figures:',
      JSON.stringify(unsourceable.map((d) => ({ topic: d.topic, why: d.reason })), null, 1),
    ].join('\n');
    try {
      const more = await callModel({ stage: 'pick', prompt: replacePrompt, schema: PICK_SHAPE, config: cfg, log });
      let fresh = (more.ideas || []).filter((i) => i && i.topic && i.series
        && !spent.has(String(i.topic).toLowerCase())
        && !recentSlugs.has(String(i.topic).toLowerCase())
        && !rejectedSlugs.has(String(i.topic).toLowerCase()));
      if (fresh.length && cfg.run.sourceabilityPrecheck) {
        const second = await stageSourceCheck({ cfg, brain, ideas: fresh, evidence });
        for (const d of second.dropped) log(`pick: replacement "${d.topic}" also unsourceable — ${d.reason}`);
        fresh = second.kept;
      }
      toppedUp = fresh;
      ideas = ideas.concat(fresh);
      log(`pick: ${fresh.length} replacement idea(s) for ${unsourceable.length} dropped on sourceability`);
    } catch (e) {
      log(`pick: replacement round failed (${e.message}); continuing with ${ideas.length} idea(s)`);
    }
  }

  // series.md keeps an evergreen reserve for exactly this: a night that comes up short.
  if (ideas.length < count && brain.evergreen.length) {
    summary.stages.pickToppedUp = count - ideas.length;
    log(`pick: only ${ideas.length} ideas survived; the evergreen reserve in series.md covers the rest`);
  }

  ideas = ideas.slice(0, count);
  summary.stages.pick = {
    proposed: (out.ideas || []).length, droppedExact: exact.length, droppedSameTopic: dupes.length,
    droppedUnsourceable: unsourceable.length, replacements: toppedUp.length,
    sourceChecked: sourceCheck ? sourceCheck.checked : 0,
    sourceCheckFailed: sourceCheck && sourceCheck.failed ? sourceCheck.failed : undefined,
    kept: ideas.length,
  };
  log(`pick: ${ideas.length} ideas (${exact.length} dropped on slug, ${dupes.length} dropped as the same topic, ${unsourceable.length} dropped as unsourceable)`);
  return { ideas, exact, dupes, unsourceable };
}

// --------------------------------------------------------------------------
// 3. VERIFY — a CLASSIFIER, not a gate.
//
// It used to block any deck whose figures could not each be traced to a
// primary source with a second source agreeing. That refused a great many
// true decks: a prescriptive number ("keep 80% of volume easy") has no study
// behind it because it is advice, not a measurement, and a real finding from
// one good paper was refused for want of a second paper repeating it.
//
// Every claim now lands in one of four tiers, and only one of them blocks:
//
//   FIGURE-BACKED   a specific empirical number, a primary source that is open
//                   access under a reusable licence, and a chart, plot or
//                   table in that paper that is about this claim. The figure
//                   is recorded against the claim; nothing renders it yet.
//   SOURCED         a specific empirical number with one primary source. No
//                   usable figure, or not open access. Allowed.
//   COMMON KNOWLEDGE  no specific empirical number. Qualitative claims, and
//                   prescriptive numbers that are coaching convention rather
//                   than a finding. Allowed with no source.
//   FABRICATED      a specific empirical number with no source, or one that
//                   contradicts the source it cites. THE ONLY BLOCKING TIER.
//
// The model classifies and names its source. lib/evidence.js then CHECKS the
// figure-backed half against Europe PMC — licence, open access, and whether
// the paper really contains a figure about this claim — and demotes to
// SOURCED when any of that does not hold, so the tier is verified rather
// than asserted.
// --------------------------------------------------------------------------
const TIERS = ['figure-backed', 'sourced', 'common-knowledge', 'fabricated'];

const VERIFY_SHAPE = `{
  "claims": [
    {
      "text": "the claim as the deck will state it",
      "figure": "the number as it will appear on the slide, or null if the claim carries no number",
      "tier": "figure-backed | sourced | common-knowledge | fabricated",
      "why": "one line: why this tier and not the next one up",
      "source": {
        "quote": "the exact sentence or table cell that states the figure",
        "url": "https://...",
        "publisher": "journal or organisation",
        "firstAuthor": "surname only, e.g. Matomäki",
        "year": 2023,
        "n": "participants, as a number, or null",
        "doi": "10.xxxx/... if known, else null",
        "pmcid": "PMCxxxxxxx if known, else null",
        "retrieved": "YYYY-MM-DD"
      }
    }
  ]
}`;

async function stageVerify({ cfg, brain, idea, evidence, log: logFn = log, call = callModel, evidenceCheck = evidenceLib.figureEvidence }) {
  const prompt = [
    'Classify every claim this deck will make. You are not deciding whether the deck may run.',
    'You are deciding what kind of claim each one is, and finding a source where a source is owed.',
    '',
    '--- sources.md ---', brain.files.sources, '--- end ---',
    '',
    'The four tiers:',
    '',
    'FIGURE-BACKED — a specific empirical number, traced to a primary source that is open access,',
    '  where that paper also contains a chart, plot or table about this claim. Give the doi or pmcid',
    '  whenever you can: it is checked against Europe PMC, and a claim that cannot be checked is',
    '  recorded as SOURCED instead. Never guess an identifier.',
    '',
    'SOURCED — a specific empirical number with one primary source. One good source is enough;',
    '  a second source stating the same number is NOT required. Use this tier when the source is',
    '  paywalled, has no usable figure, or is an organisation rather than a paper.',
    '',
    'COMMON KNOWLEDGE — no specific empirical number, so nothing to source. Two kinds:',
    '  - qualitative claims: "easy runs should feel easy", "consistency beats intensity".',
    '  - PRESCRIPTIVE numbers: advice about what to do, which is coaching convention rather than a',
    '    research finding. "Run 5-6 days a week", "keep 80% of volume easy", "no new shoes on race',
    '    day", "two rest days" are all common knowledge.',
    '  The test is what the number is DOING. Is it describing the world, which is empirical and owes',
    '  a source ("runners drifted 7.7% over three hours")? Or is it telling the reader what to do,',
    '  which is prescription and owes none ("keep 80% of it easy")? A number being present does not',
    '  make a claim empirical.',
    '',
    'FABRICATED — a specific empirical number with no source you could find, OR a number that',
    '  contradicts what its own cited source actually says. Read the source before you agree with it:',
    '  a paper reporting averaged multi-variable drift in sedentary cyclists does not support a claim',
    '  about heart-rate drift in trained runners, and calling that SOURCED would be the error this',
    '  tier exists to catch. This is the only tier that stops a deck.',
    '',
    'Rules:',
    '- Idea-sources (Reddit) are never evidence, whatever they say.',
    '- Never invent a url, a doi, a quote or a retrieval date. A claim you cannot source is FABRICATED,',
    '  or COMMON KNOWLEDGE if it never needed a source in the first place.',
    '- A deck making no empirical claims at all is perfectly fine: return only common-knowledge claims.',
    '',
    `Today is ${today()}.`,
    '',
    'The idea:',
    JSON.stringify({ topic: idea.topic, series: idea.series, angle: idea.angle, figures: idea.figures || [] }, null, 1),
    '',
    'Evidence-source items already pulled tonight (real and dated; use these first):',
    JSON.stringify((evidence || []).slice(0, 40).map((e) => ({ title: e.title, url: e.url, published: e.published, feed: e.feed })), null, 1),
  ].join('\n');

  const out = await call({
    stage: 'verify', prompt, schema: VERIFY_SHAPE, config: cfg, log: logFn,
    allowedTools: cfg.models.verifyWebTools ? ['WebSearch', 'WebFetch'] : undefined,
  });

  const raw = Array.isArray(out.claims) ? out.claims : [];
  const claims = [];
  for (const c of raw) {
    if (!c || !c.text) continue;
    const tier = TIERS.includes(String(c.tier || '').toLowerCase()) ? String(c.tier).toLowerCase() : 'fabricated';
    const src = c.source && typeof c.source === 'object' ? c.source : null;
    const claim = { text: String(c.text), figure: c.figure || null, tier, why: c.why || null, source: src, evidence: null };

    // A claim that owes a source and has not got a usable one is fabricated,
    // whatever it was labelled: the label is the model's, the url is checkable.
    if ((tier === 'sourced' || tier === 'figure-backed')) {
      const bad = !src ? 'no source object'
        : !src.url || !/^https?:\/\//.test(src.url) ? 'no url'
          : !src.quote ? 'no quote from the source'
            : !src.retrieved ? 'no retrieval date' : null;
      if (bad) {
        claim.tier = 'fabricated';
        claim.why = `${claim.why || ''} [demoted: ${bad}]`.trim();
        claims.push(claim);
        continue;
      }
    }

    // The figure-backed half, checked against Europe PMC rather than believed.
    if (claim.tier === 'figure-backed') {
      const ref = { doi: src.doi || null, pmcid: src.pmcid || null, title: src.title || null };
      let ev;
      try { ev = await evidenceCheck(claim.text, ref); }
      catch (e) { ev = { ok: false, why: `Europe PMC check failed (${e.message})` }; }
      if (ev.ok) {
        claim.evidence = {
          pmcid: ev.paper.pmcid, licence: ev.paper.licence, journal: ev.paper.journal,
          firstAuthor: ev.paper.firstAuthor || src.firstAuthor || null,
          year: ev.paper.year || src.year || null,
          n: src.n === undefined ? null : src.n,
          figureLabel: ev.figure.label, figureCaption: ev.figure.caption,
          figureFile: ev.figure.href, figureUrl: ev.figure.url, relevance: ev.figure.score,
          // Not fetched: every documented image route is gated or dead from
          // this host (see lib/evidence.js). Nothing renders a figure yet, so
          // the reference is enough until the component exists.
          imagePath: null, imagePathWhy: 'image bytes are not fetchable from this host; see lib/evidence.js',
        };
      } else {
        claim.tier = 'sourced';
        claim.why = `${claim.why || ''} [not figure-backed: ${ev.why}]`.trim();
      }
    }
    claims.push(claim);
  }

  const fabricated = claims.filter((c) => c.tier === 'fabricated');
  if (fabricated.length) {
    throw new Blocked(`fabricated claim(s): ${fabricated.map((c) => `"${c.figure || c.text}" — ${c.why || 'no source found'}`).join(' | ')}`);
  }

  const counts = TIERS.reduce((a, t) => ({ ...a, [t]: claims.filter((c) => c.tier === t).length }), {});
  logFn(`  verify: ${claims.length} claim(s) — ${TIERS.filter((t) => counts[t]).map((t) => `${counts[t]} ${t}`).join(', ') || 'none'}`);

  // The shape the render path still expects. On-slide source credit is
  // unchanged for now; cross-check is gone, so nothing claims one.
  const sources = claims.filter((c) => c.source && c.tier !== 'common-knowledge').map((c) => ({
    figure: c.figure || c.text,
    quote: c.source.quote,
    url: c.source.url,
    publisher: c.source.publisher || (c.evidence && c.evidence.journal) || '',
    retrieved: c.source.retrieved,
    crossChecked: true,   // the two-source rule is retired; nothing is "unchecked" any more
    headline: false,
    tier: c.tier,
    firstAuthor: (c.evidence && c.evidence.firstAuthor) || c.source.firstAuthor || null,
    year: (c.evidence && c.evidence.year) || c.source.year || null,
    evidence: c.evidence,
  }));
  return { claims, sources, counts };
}

// "Source: Matomäki et al. 2023" — one line at the end of the Instagram
// caption for a deck carrying sourced or figure-backed claims. TikTok is
// untouched: its caption carries search phrases and nothing else.
function sourceLine(sources) {
  const seen = new Set();
  const names = [];
  for (const s of sources || []) {
    if (!s || s.tier === 'common-knowledge') continue;
    const author = s.firstAuthor && String(s.firstAuthor).trim();
    if (!author) continue;
    const surname = author.split(/\s+/)[0].replace(/,$/, '');
    const label = s.year ? `${surname} et al. ${s.year}` : `${surname} et al.`;
    if (seen.has(label)) continue;
    seen.add(label);
    names.push(label);
  }
  return names.length ? `Source: ${names.join(', ')}` : '';
}

// --------------------------------------------------------------------------
// 4. WRITE — headline, slide copy, both captions. Linted against banned.md,
//    which calls its list hard failures, so a block there blocks the deck.
// --------------------------------------------------------------------------
function writeShape(cfg) {
  const sendLine = cfg.captions.sendLine
    ? ',\n    "sendLine": "one sentence, in voice, asking the reader to send this post to someone they run with; no exclamation mark; this field only, not in the caption text"'
    : '';
  const hashtags = cfg.captions.hashtags
    ? ',\n    "hashtags": ["#tag", "..."]  // 3 to 5 topical Instagram hashtags, this field only, never in the caption text'
    : '';
  return `{
  "brief": "a complete deck brief object matching pipeline/render/brief.schema.json, without deckId, date or topic (the runner fills those in)",
  "captions": {
    "instagram": "clean caption, hook line first, no hashtags in the text",
    "tiktok": "same story, with two or three plain search phrases woven in, no hashtags"${sendLine}${hashtags}
  }
}`;
}

// The send line, when config.md turns it on: one sentence asking the reader
// to send the post to someone they run with, appended under the Instagram
// caption after a blank line, before the hashtag block. Normalised here to
// one sentence with no exclamation mark; an empty result is no line.
function normaliseSendLine(text) {
  let t = String(text || '').replace(/\s+/g, ' ').trim().replace(/!/g, '.');
  if (!t) return '';
  const m = t.match(/^[^.?]*[.?]/);
  if (m) t = m[0].trim();
  else t = `${t}.`;
  return t.length > 1 ? t : '';
}

function withClosingLine(caption, line) {
  return `${String(caption).trimEnd()}\n\n${line}`;
}

// The hashtag block, when config.md turns it on: 3 to 5 tags, one final line
// under the Instagram caption after a blank line, never in the caption text.
// The model's list is normalised here (leading #, lowercase, letters, digits
// and underscores only, no duplicates, at most five); fewer than three left is
// no block at all rather than a thin one.
const HASHTAG_MIN = 3;
const HASHTAG_MAX = 5;
function normaliseHashtags(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const tag = '#' + String(raw).trim().replace(/^#+/, '').toLowerCase();
    if (!/^#[\p{L}\p{N}_]+$/u.test(tag) || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length === HASHTAG_MAX) break;
  }
  return out;
}

function withHashtagBlock(caption, hashtags) {
  return `${String(caption).trimEnd()}\n\n${hashtags.join(' ')}`;
}


// What the last decks looked like, in the renderer's own words. Without this
// the write stage is handed voice, rules and a schema and nothing else, so it
// produces the same shape every night: eight decks running, every cover came
// back white, full-figure and sentence-mode, and the body slides settled into
// one component order. These are the same rules lib/history.js enforces at
// render time — telling the model about them beforehand is the difference
// between a deck that varies and a deck the renderer blocks.
function varietyLines(rows) {
  if (!rows.length) return ['', 'No decks yet: any cover ground, subject, mode and slide order is open.', ''];
  const last = rows.slice(-6);
  const groundNext = renderHistory.checkGround(rows, 'white').required;
  const recentModes = rows.slice(-(renderHistory.MODE_RUN - 1)).map((r) => r.mode).filter(Boolean);
  const modeRun = recentModes.length === renderHistory.MODE_RUN - 1 && recentModes.every((m) => m === recentModes[0]) ? recentModes[0] : null;
  const mixWindow = rows.slice(-(renderHistory.MIX_WINDOW - 1));
  const mixCounts = {};
  for (const r of mixWindow) if (r.subject) mixCounts[r.subject] = (mixCounts[r.subject] || 0) + 1;
  const mixLeft = Object.entries(renderHistory.MIX_QUOTA)
    .map(([k, q]) => `${k} ${Math.max(0, q - (mixCounts[k] || 0))} left of ${q}`).join(', ');
  const shapes = last.map((r) => r.shape).filter(Boolean);
  return [
    '',
    '--- what the last decks already did (the renderer enforces all of this) ---',
    'The most recent decks, oldest first:',
    ...last.map((r) => `  ${r.deckId}: ground ${r.ground}, ${r.subject}, ${r.mode} mode, cutout ${r.cutout || 'none'}` +
      `${r.shape ? `, shape ${r.shape}` : ''}${r.components ? `, slides ${r.components.join(' > ')}` : ''}`),
    '',
    `- cover.ground MUST be ${groundNext}: the ground strictly alternates white/navy and the last deck was ${renderHistory.groundFamily(rows[rows.length - 1].ground)}.`,
    `- cover.subject: the mix is ${renderHistory.MIX_WINDOW} posts to 14 full-figure / 3 detail / 2 type-led / 1 conceptual. Remaining in this window: ${mixLeft}. Pick something other than full-figure when the quota allows it.`,
    modeRun
      ? `- cover.mode must NOT be "${modeRun}": the last ${renderHistory.MODE_RUN - 1} covers were both ${modeRun}, and three running is refused.`
      : '- cover.mode: shout, sentence or number, and never the same mode three posts running.',
    `- Slide components: eleven exist (stat, explainer, numeral-point, checklist, pull-statement, compare, progress-scale, chart, metrics-table, figure-panel, cta). chart and figure-panel have never been used once. Do not reuse the component order above; open on a different component and end on something other than checklist where the content allows.`,
    shapes.length ? `- Recent deck shapes: ${shapes.join(', ')}. Pick a different one.` : '- Deck shape: pick one and name it in the brief as `shape`.',
    '- shape is one of: stat-led, myth-bust, comparison, checklist, story, mechanism.',
    '--- end ---',
  ];
}

async function stageWrite({ cfg, brain, idea, sources, claims = [], history = [], previousErrors, attempt = 1 }) {
  const budgets = CAPACITY ? [
    '',
    '--- how much copy each component holds ---',
    'Measured in the real font at the real size on the real canvas, and they hold',
    'together: a slide carrying every field at its budget was rendered and fits.',
    'Write to them. Going over does not make a better slide, it makes a slide the',
    'renderer has to break.',
    ...capacity.promptLines(CAPACITY),
    '--- end ---',
  ] : [];
  const prompt = [
    'Write one deck.',
    '',
    '--- voice.md ---', brain.files.voice, '--- end ---',
    '',
    '--- banned.md ---', brain.files.banned, '--- end ---',
    '',
    '--- deck-rules.md ---', brain.files.deckRules, '--- end ---',
    '',
    '--- the brief schema the renderer validates against ---',
    JSON.stringify(BRIEF_SCHEMA, null, 1),
    '--- end ---',
    '',
    'The idea:',
    JSON.stringify({ topic: idea.topic, series: idea.series, angle: idea.angle }, null, 1),
    '',
    'The verified sources. A figure on a slide that carries a source row must be one of these:',
    JSON.stringify(sources.map((s) => ({ figure: s.figure, quote: s.quote, url: s.url, publisher: s.publisher, retrieved: s.retrieved, tier: s.tier })), null, 1),
    ...(claims.filter((c) => c.tier === 'common-knowledge').length ? [
      '',
      'These claims are COMMON KNOWLEDGE: qualitative, or a prescriptive number that is coaching',
      'convention rather than a measured finding. They have no source and need none:',
      JSON.stringify(claims.filter((c) => c.tier === 'common-knowledge').map((c) => ({ claim: c.text, figure: c.figure })), null, 1),
      '',
      'A common-knowledge number must NOT go on a component that renders a source row — stat, chart,',
      'metrics-table, progress-scale, or a compare column carrying a value. Those components promise the',
      'reader a traceable figure and the renderer refuses one without a source. Say it in prose instead:',
      'an explainer, a pull-statement or a checklist line carries "keep most of the week easy" perfectly',
      'well. Only the sourced figures above may sit on a component with a source row.',
    ] : []),
    '',
    'Requirements:',
    '- series is the uppercase series label, e.g. "RUNNING 101".',
    '- Seven slides: a cover, five middle slides carrying point numbers 01-05 in order, and cta last.',
    '- The cta takes no input but its one line of source credit.',
    '- Copy obeys banned.md exactly. It is a hard list, not a preference.',
    ...(cfg.captions.sendLine ? [
      '- captions.sendLine: one sentence, in voice, asking the reader to send this post to someone they run with.',
      '  No exclamation mark, no hashtag, no emoji. Not in the caption text: the runner appends it as the closing line',
      '  under the Instagram caption. The TikTok caption gets nothing.',
    ] : []),
    ...(cfg.captions.hashtags ? [
      '- captions.hashtags: 3 to 5 Instagram hashtags specific to this deck\'s topic, lowercase, each starting with #.',
      '  This field is the only place a hashtag goes. banned.md\'s no-hashtags rule still holds for every slide',
      '  and for both caption texts; the runner appends this list under the Instagram caption itself.',
      '  The TikTok caption keeps its plain search phrases and gets no hashtags.',
    ] : []),
    ...varietyLines(history),
    ...budgets,
    previousErrors ? `\nYour previous attempt did not validate:\n${previousErrors}\nFix exactly these and return the whole object again.` : '',
  ].join('\n');

  const out = await callModel({ stage: 'write', prompt, schema: writeShape(cfg), config: cfg, log });
  if (!out.brief || typeof out.brief !== 'object') throw new Error('write returned no brief object');

  // One rewrite for copy that will not fit its component. Cheaper than a
  // blocked deck, and the second attempt is told which field and by how much.
  // What is still over after it is a warning rather than a block: the budget is
  // 90% of what fitted, so over-budget copy often still renders, and QA is the
  // gate that decides.
  const over = capacity.budgetFindings(out.brief, CAPACITY);
  if (over.length && attempt === 1) {
    log(`  write: ${over.length} field(s) over budget, rewriting once`);
    const detail = over.map((o) => `${o.where} (${o.component}.${o.field}) is ${o.chars} characters; the budget is ${o.budget}`).join('\n');
    return stageWrite({ cfg, brain, idea, sources, claims, history, attempt: 2, previousErrors: `The copy does not fit the components:\n${detail}\nCut these to the budget. Everything else in the deck stays as it is.` });
  }
  const captions = { ...(out.captions || {}) };
  captions.hashtags = cfg.captions.hashtags ? normaliseHashtags(captions.hashtags) : [];
  captions.sendLine = cfg.captions.sendLine ? normaliseSendLine(captions.sendLine) : '';
  return { brief: out.brief, captions, overBudget: over };
}

// --------------------------------------------------------------------------
// 5. RENDER and 6. QA — pure code, no model. Both are the existing CLIs, so the
//    renderer stays the single implementation of the design system.
// --------------------------------------------------------------------------
async function stageRender({ cfg, briefFile, outDir }) {
  const r = await runNode([path.join(__dirname, 'render', 'index.js'), briefFile, '--out', outDir, '--brand', cfg.dir, '--no-qa']);
  if (r.code === 2) throw new Blocked(`renderer blocked the deck:\n${r.err.trim().slice(0, 800)}`);
  if (r.code !== 0) throw new Error(`renderer exited ${r.code}: ${(r.err || r.out).trim().slice(0, 800)}`);
  return r.out.trim();
}

async function stageQa({ cfg, deckDir }) {
  const r = await runNode([path.join(__dirname, 'render', 'qa.js'), deckDir, '--brand', cfg.dir]);
  const reviewFile = path.join(deckDir, 'review.json');
  if (!fs.existsSync(reviewFile)) throw new Error(`qa produced no review.json (exit ${r.code}): ${(r.err || r.out).trim().slice(0, 500)}`);
  const review = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
  if (r.code !== 0 && r.code !== 3) throw new Error(`qa exited ${r.code}: ${(r.err || r.out).trim().slice(0, 500)}`);
  return review;
}

// --------------------------------------------------------------------------
function nextDeckKey(prefix, state, brain) {
  const nums = [...state.deckKeys(), ...brain.posted.map((r) => r.deckId)]
    .filter(Boolean)
    .map((k) => Number(String(k).replace(/^.*?-/, '')))
    .filter((n) => Number.isFinite(n));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `${prefix}-${String(next).padStart(2, '0')}`;
}

// --------------------------------------------------------------------------
// One idea, all the way through: VERIFY, WRITE, RENDER, QA, and the state and
// Telegram writes that go with each outcome. The nightly loops over it, and
// scripts/recover-deck.js drives it for a single hand-authored idea — one
// implementation, so a recovered deck is held to exactly the checks a nightly
// deck is, with no path that skips verify or qa. `deckKeyOverride` lets a
// caller pin the key; otherwise the next free one is minted as usual.
// --------------------------------------------------------------------------
async function processIdea({ cfg, brand, brain, state, runId, tg, summary, idea, evidence, deckKeyOverride = null }) {
  const briefId = state.addBrief(runId, brand, { topic: idea.topic, series: idea.series, angle: idea.angle, score: idea.score, status: 'picked' });
  summary.briefs++;
  const deckKey = deckKeyOverride || nextDeckKey(cfg.run.deckKeyPrefix, state, brain);
  const outDir = path.join(ROOT, cfg.run.outDir);
  const deckDir = path.join(outDir, deckKey);

  const park = async (status, reason) => {
    state.updateBrief(briefId, { status, reason });
    state.addDeck(runId, briefId, { deckKey, topic: idea.topic, status, reason, outDir: deckDir });
    summary.decks.push({ deckKey, topic: idea.topic, status, reason });
    await tg.send(`${status === 'blocked' ? 'blocked' : 'needs attention'}: ${deckKey} (${idea.topic})\n${reason}\nThe run continued with the other decks.`);
  };

  try {
    // 3. VERIFY
    const verified = await stageVerify({ cfg, brain, idea, evidence });
    const sources = verified.sources;
    for (const s of sources) state.addSource(briefId, s);
    state.updateBrief(briefId, { status: 'verified' });

    // 4. WRITE
    const deckHistory = renderHistory.readHistory(cfg.dir, { outDir: path.join(ROOT, cfg.run.outDir) });
    let { brief, captions, overBudget } = await stageWrite({ cfg, brain, idea, sources, claims: verified.claims, history: deckHistory });
    brief = { ...brief, deckId: deckKey, date: today(), topic: idea.topic };

    const texts = [
      { where: 'cover.headline', text: brief.cover && brief.cover.headline },
      { where: 'cover.kicker', text: brief.cover && brief.cover.kicker },
      { where: 'cover.aside', text: brief.cover && brief.cover.aside },
      ...(brief.slides || []).flatMap((s, i) => [
        { where: `slides[${i}].headline`, text: s.headline },
        { where: `slides[${i}].body`, text: s.body },
        { where: `slides[${i}].label`, text: s.label },
        ...(s.items || []).map((it, n) => ({ where: `slides[${i}].items[${n}]`, text: it })),
      ]),
      { where: 'captions.instagram', text: captions.instagram },
      { where: 'captions.tiktok', text: captions.tiktok },
      { where: 'captions.sendLine', text: captions.sendLine },
      // The words inside the tags face the ban list too; the # itself is
      // the one thing banned.md allows here, so it is stripped for lint.
      { where: 'captions.hashtags', text: captions.hashtags.map((h) => h.slice(1)).join(' ') },
    ].filter((t) => t.text);
    const findings = lintCopy(texts, brain.files.banned, { quotedSources: sources.map((s) => s.quote) });
    const hard = lintBlocks(findings);
    const soft = lintFlags(findings);
    // Closing lines go on after lint, in this order: source, send line, then
    // hashtags last. The source line is Instagram only — TikTok's caption
    // carries plain search phrases and nothing else.
    const credit = sourceLine(sources);
    if (credit) captions.instagram = withClosingLine(captions.instagram, credit);
    if (cfg.captions.sendLine) {
      if (captions.sendLine) {
        captions.instagram = withClosingLine(captions.instagram, captions.sendLine);
      } else {
        soft.push({ where: 'captions.sendLine', detail: 'send_line_enabled is on but write returned no usable sentence, so the caption went out without a send line' });
      }
    }
    if (cfg.captions.hashtags) {
      if (captions.hashtags.length >= HASHTAG_MIN) {
        captions.instagram = withHashtagBlock(captions.instagram, captions.hashtags);
      } else {
        soft.push({ where: 'captions.hashtags', detail: `hashtags_enabled is on but write returned ${captions.hashtags.length} usable tag(s); the minimum is ${HASHTAG_MIN}, so the caption went out without a block` });
      }
    }
    if (hard.length) {
      throw new Blocked(`banned.md: ${hard.map((f) => `${f.where} ${f.rule} ${f.detail}`).join('; ')}`);
    }
    // Soft findings and copy still over budget after the rewrite: both are
    // things to look at before posting, neither stops the deck.
    const softLines = [
      ...soft.map((f) => `${f.where}: ${f.detail}`),
      ...(overBudget || []).map((o) => `${o.where}: ${o.chars} characters in ${o.component}.${o.field}, budget ${o.budget}`),
    ];
    if (softLines.length) {
      await tg.send(`check before posting: ${deckKey} (${idea.topic})\n${softLines.join('\n')}`);
    }

    const schemaErrors = validate(BRIEF_SCHEMA, brief);
    if (schemaErrors.length) throw new Error(`the written brief does not match brief.schema.json:\n  ${schemaErrors.slice(0, 8).join('\n  ')}`);
    state.updateBrief(briefId, { status: 'written', brief_json: JSON.stringify(brief), captions: JSON.stringify(captions) });

    // 5. RENDER
    fs.mkdirSync(deckDir, { recursive: true });
    const briefFile = path.join(deckDir, 'brief.json');
    fs.writeFileSync(briefFile, JSON.stringify(brief, null, 2));
    fs.writeFileSync(path.join(deckDir, 'captions.json'), JSON.stringify(captions, null, 2));
    await stageRender({ cfg, briefFile, outDir });
    state.updateBrief(briefId, { status: 'rendered' });

    // 6. QA
    const review = await stageQa({ cfg, deckDir });
    const status = review.pass ? 'pending' : 'blocked';
    const reason = review.pass
      ? `${review.summary.warn} warning(s)`
      : review.flags.filter((f) => f.severity === 'block').map((f) => `slide ${f.slide} ${f.rule}: ${f.detail}`).join('; ');
    state.addDeck(runId, briefId, { deckKey, topic: idea.topic, status, reason, outDir: deckDir, review });
    summary.decks.push({ deckKey, topic: idea.topic, status, reason, series: brief.series, headline: brief.cover.headline, cover: path.join(deckDir, '01.jpg'), tiers: verified.counts });
    log(`${deckKey} (${idea.topic}): ${status} — ${reason}`);
    if (status === 'blocked') {
      await tg.send(`blocked by qa: ${deckKey} (${idea.topic})\n${reason}`);
    }
  } catch (e) {
    if (e instanceof Blocked) await park('blocked', e.message);
    else await park('needs_attention', `${e.name || 'error'}: ${e.message}`);
  }
}

async function main() {
  const brand = process.argv[2];
  if (!brand) {
    console.error('usage: node pipeline/run.js <brand>   e.g. node pipeline/run.js pacevector');
    process.exit(1);
  }

  const cfg = loadConfig(ROOT, brand);
  const brain = loadBrain(cfg.dir);
  const backend = process.env.MODELS_BACKEND || 'cli';
  // A stub run is a rehearsal. It gets its own state database and output
  // directory so the fixture items never count as "seen" for a real scan,
  // never consume a deck key, and never overwrite a real deck.
  if (backend === 'stub') {
    cfg.run.stateDb = cfg.run.stateDb.replace(/\.db$/, '.stub.db');
    cfg.run.outDir = path.join(cfg.run.outDir, 'stub');
  }
  // The one brain file the nightly writes: stale decks go to rejected.md. A
  // stub run writes its rows next to its own output instead.
  const rejectedFile = backend === 'stub' ? path.join(ROOT, cfg.run.outDir, 'rejected.stub.md') : path.join(cfg.dir, 'memory', 'rejected.md');
  const state = new State(path.join(ROOT, cfg.run.stateDb));
  const tg = new Telegram(cfg.telegram);
  const runId = state.startRun(brand);
  const summary = { brand, runId, backend, stages: {}, briefs: 0, decks: [], deadFeeds: [], drift: [], stale: [], queue: null };
  log(`run ${runId}: ${brand}, models backend ${backend}${backend === 'stub' ? ` (state ${cfg.run.stateDb}, output ${cfg.run.outDir})` : ''}`);

  try {
    // 0. Drift.
    summary.drift = driftCheck(state, brain);
    for (const deckKey of summary.drift) {
      await tg.send(`drift: ${deckKey} is marked published in state.db but has no row in posted.jsonl.\nThe confirm step did not write it. Nothing was repaired automatically.`);
    }

    // 0b. Stale: a pending deck older than deck_max_age is dropped before the
    //     queue is counted. The topic stays open (rejected.md scope=figure).
    const today_ = today();
    for (const d of staleDecks(state.pendingDecks(brand), cfg.run.deckMaxAgeDays)) {
      const days = Math.floor((Date.now() - Date.parse(d.created_at)) / 86400000);
      const headline = headlineOf(d);
      const reason = `stale: pending for ${days} days, over deck_max_age ${cfg.run.deckMaxAgeDays}; dropped ${today_}`;
      state.markStale(d.deck_key, reason);
      fs.mkdirSync(path.dirname(rejectedFile), { recursive: true });
      fs.appendFileSync(rejectedFile, staleRow({ date: today_, deck: d, headline, days }));
      summary.stale.push({ deckKey: d.deck_key, topic: d.topic, days });
      log(`stale: ${d.deck_key} (${d.topic}) pending ${days} days; dropped, topic left open in ${path.relative(ROOT, rejectedFile)}`);
    }

    // 1-2. Run-level stages. A failure here is the night, not one deck.
    const scanned = await stageScan({ cfg, brain, state, runId, tg, summary });
    // Decks in hand, which is pending plus approved: an approved deck has not
    // posted yet, so counting only pending would top the queue up past the
    // target every night the packet has a backlog to work through.
    const inHand = state.queueDecks(brand).length;
    // How many of the last runs' decks were lost to a block, so pick can size
    // itself to the deficit AND the expected losses. This run is excluded: its
    // own decks are still being written.
    const blocks = state.blockStats(brand, { runLimit: cfg.run.blockRateRuns, excludeRunId: runId });
    const plan = queuePlan({
      pending: inHand, target: cfg.run.queueTarget, perRun: cfg.run.ideasPerRun,
      blockRate: blocks.rate, maxPerRun: cfg.run.pickMax,
    });
    summary.queue = { pending: inHand, target: cfg.run.queueTarget, ...plan };
    summary.blocks = { runs: blocks.runs, total: blocks.total, blocked: blocks.blocked, rate: blocks.rate, byReason: blocks.byReason };
    const sizing = plan.full ? 'full; scan and pick run, then the night stops'
      : plan.blockRate === null ? `picking ${plan.count} (no block history yet)`
        : `picking ${plan.count} for a deficit of ${plan.need} at a ${Math.round(plan.blockRate * 100)}% block rate over ${blocks.runs} run(s)${plan.capped ? `, capped from ${plan.wanted} by pick_max ${cfg.run.pickMax}` : ''}`;
    log(`queue: ${inHand} deck(s) in hand (pending + approved), target ${cfg.run.queueTarget}: ${sizing}`);
    const evidence = scanned.filter((s) => s.tier === 'evidence-source');
    const { ideas: picked } = await stagePick({ cfg, brain, state, runId, tg, summary, scanned, evidence, count: plan.count, need: plan.need });
    const ideas = plan.full ? [] : picked;
    if (plan.full) log(`queue full: pick found ${picked.length} idea(s), none taken forward`);

    // 3-6, per idea, isolated.
    for (const idea of ideas) {
      await processIdea({ cfg, brand, brain, state, runId, tg, summary, idea, evidence });
    }

    const pending = summary.decks.filter((d) => d.status === 'pending');
    const blocked = summary.decks.filter((d) => d.status === 'blocked');
    const attention = summary.decks.filter((d) => d.status === 'needs_attention');
    state.finishRun(runId, 'ok', summary);

    const q = summary.queue;
    const lines = [
      `${brand}: run ${runId} finished`,
      `${summary.briefs} briefs, ${pending.length} pending, ${blocked.length} blocked, ${attention.length} needs attention`,
      q.full
        ? `queue full: ${q.pending} in hand, target ${q.target}. Scan and pick ran (${summary.stages.pick ? summary.stages.pick.kept : 0} idea(s) found); nothing verified, written or rendered tonight.`
        : `queue: ${q.pending} in hand before tonight, target ${q.target}; picked ${q.count}`,
      summary.stale.length ? `stale, dropped after ${cfg.run.deckMaxAgeDays} days: ${summary.stale.map((s) => `${s.deckKey} (${s.topic}, ${s.days}d)`).join(', ')}; topics left open in rejected.md` : '',
      summary.deadFeeds.length ? `${summary.deadFeeds.length} dead feed(s): ${summary.deadFeeds.map((d) => d.feed).join(', ')}` : 'all feeds alive',
      summary.drift.length ? `drift: ${summary.drift.join(', ')} published without a posted.jsonl row` : '',
      '',
      ...summary.decks.map((d) => `${d.status === 'pending' ? 'ok' : d.status}  ${d.deckKey}  ${d.topic}`),
    ].filter(Boolean);
    await tg.send(lines.join('\n'));
    log('\n' + lines.join('\n'));

    // One photo per deck that is pending RIGHT NOW — tonight's and every older
    // one still waiting — because the approval gate is answered from these
    // pictures, and a deck nobody was shown is a deck nobody approves.
    //
    // A preview, so sendPhoto and not sendDocument: the posting copy goes out
    // at 14:00 in the packet, as a document, uncompressed. The cover is
    // downsized first (lib/preview.js) rather than uploading 2160x2700 for
    // Telegram to re-compress anyway.
    const waiting = state.pendingDecks(brand);
    const shrink = await preview.open({ log });
    try {
      for (const d of waiting) {
        const caption = [d.deck_key, d.series, headlineOf(d), d.topic].filter(Boolean).join('\n');
        const cover = path.join(d.out_dir || path.join(ROOT, cfg.run.outDir, d.deck_key), '01.jpg');
        if (!fs.existsSync(cover)) { await tg.send(`${caption}\n(no cover image at ${cover})`); continue; }
        const small = await shrink.cover(cover);
        await tg.sendPhoto(small || cover, { caption });
      }
    } finally {
      await shrink.close();
    }

    // The last message of the night: what is in hand, and the one line that
    // says how to answer. pipeline/inbox.js reads the reply.
    const counts = state.deckCounts(brand);
    const closing = [
      waiting.length ? `${waiting.length} deck(s) above are waiting for a decision.` : 'Nothing is pending: no deck is waiting for a decision.',
      `pending ${counts.pending || 0} · approved ${counts.approved || 0} · blocked ${counts.blocked || 0}`,
      "Reply 'ok <deck>' to approve, 'no <deck> <reason>' to reject, or 'queue' to see everything pending.",
    ].join('\n');
    await tg.send(closing);
    log('\n' + closing);
    state.close();
    process.exit(0);
  } catch (e) {
    state.finishRun(runId, 'failed', { ...summary, error: e.message });
    await tg.send(`${brand}: run ${runId} FAILED before the decks\n${e.name || 'error'}: ${e.message}`);
    console.error(e.stack || e);
    state.close();
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { driftCheck, nextDeckKey, normaliseHashtags, withHashtagBlock, normaliseSendLine, withClosingLine, queuePlan, staleDecks, staleRow, headlineOf, stageSourceCheck, stageVerify, sourceLine, processIdea, TIERS, MIN_SURVIVAL };
