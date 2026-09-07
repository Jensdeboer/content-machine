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

async function stagePick({ cfg, brain, state, runId, tg, summary, scanned }) {
  const recent = within(brain.posted, cfg.run.topicWindowDays);
  const recentSlugs = new Set(recent.map((r) => r.topic).filter(Boolean));
  const rejectedSlugs = new Set(brain.rejected.map((r) => r.slug).filter(Boolean));
  const seriesCounts = {};
  for (const r of within(brain.posted, 20 * 2)) seriesCounts[r.series] = (seriesCounts[r.series] || 0) + 1;

  const prompt = [
    'You are choosing what a running account posts next.',
    '',
    '--- positioning.md ---', brain.files.positioning, '--- end ---',
    '',
    '--- series.md ---', brain.files.series, '--- end ---',
    '',
    `Choose ${cfg.run.ideasPerRun} ideas.`,
    '- Weight the mix by the series weights in series.md, and respect its rotation rule.',
    '- Every idea gets a kebab-case topic slug that names the subject, not the headline.',
    '- An idea may come from a scanned item or from the evergreen reserve in series.md.',
    '- Evidence-source items may anchor a figure. Idea-source items (Reddit) tell you what people are confused about and may NEVER be cited as evidence.',
    '',
    `Already used in the last ${cfg.run.topicWindowDays} days (do not repeat): ${JSON.stringify([...recentSlugs])}`,
    `Rejected, never re-propose: ${JSON.stringify([...rejectedSlugs])}`,
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
      JSON.stringify(brain.rejected.map((r) => ({ topic: r.slug, idea: r.idea, reason: r.reason })), null, 1),
    ].join('\n');
    const dd = await callModel({ stage: 'pick', prompt: dedupePrompt, schema: DEDUPE_SHAPE, config: cfg, log });
    dupes = (dd.duplicates || []).filter((d) => d && d.topic);
    const dupSlugs = new Set(dupes.map((d) => String(d.topic).toLowerCase()));
    ideas = ideas.filter((i) => !dupSlugs.has(String(i.topic).toLowerCase()));
  }

  for (const d of [...exact, ...dupes]) log(`pick: dropped "${d.topic}" — ${d.reason || d.sameAs}`);

  // series.md keeps an evergreen reserve for exactly this: a night that comes up short.
  if (ideas.length < cfg.run.ideasPerRun && brain.evergreen.length) {
    summary.stages.pickToppedUp = cfg.run.ideasPerRun - ideas.length;
    log(`pick: only ${ideas.length} ideas survived; the evergreen reserve in series.md covers the rest`);
  }

  ideas = ideas.slice(0, cfg.run.ideasPerRun);
  summary.stages.pick = { proposed: (out.ideas || []).length, droppedExact: exact.length, droppedSameTopic: dupes.length, kept: ideas.length };
  log(`pick: ${ideas.length} ideas (${exact.length} dropped on slug, ${dupes.length} dropped as the same topic)`);
  return { ideas, exact, dupes };
}

// --------------------------------------------------------------------------
// 3. VERIFY — every figure that will appear on a slide gets a primary source.
//    No source means the idea is blocked: not softened, not carried to
//    tomorrow, not rewritten to avoid the number.
// --------------------------------------------------------------------------
const VERIFY_SHAPE = `{
  "blocked": false,
  "blockReason": null,
  "sources": [
    {
      "figure": "the number as it will appear on the slide",
      "quote": "the exact sentence or table cell from the source",
      "url": "https://...",
      "publisher": "journal or organisation",
      "retrieved": "YYYY-MM-DD",
      "crossChecked": true,
      "headline": true
    }
  ]
}`;

async function stageVerify({ cfg, brain, idea, evidence }) {
  const prompt = [
    'Find a primary source for every figure this deck will show.',
    '',
    '--- sources.md ---', brain.files.sources, '--- end ---',
    '',
    'Rules that decide the answer:',
    '- Every figure needs a row: exact quote or table cell, url, publisher, retrieval date, cross-checked yes/no.',
    '- A headline figure is always cross-checked, meaning a second primary source states the same figure.',
    '- Idea-sources (Reddit) are never evidence, whatever they say.',
    '- If a figure cannot be traced to a real url and a retrieval date, do not invent one. Set blocked true and say which figure failed.',
    '- A deck that shows no figures at all is not blocked: return an empty sources list.',
    '',
    `Today is ${today()}.`,
    '',
    'The idea:',
    JSON.stringify({ topic: idea.topic, series: idea.series, angle: idea.angle, figures: idea.figures || [] }, null, 1),
    '',
    'Evidence-source items already pulled tonight (use these first; they are real and dated):',
    JSON.stringify(evidence.slice(0, 40).map((e) => ({ title: e.title, url: e.url, published: e.published, feed: e.feed })), null, 1),
  ].join('\n');

  const out = await callModel({
    stage: 'verify', prompt, schema: VERIFY_SHAPE, config: cfg, log,
    allowedTools: cfg.models.verifyWebTools ? ['WebSearch', 'WebFetch'] : undefined,
  });

  if (out.blocked) throw new Blocked(out.blockReason || 'a figure could not be traced to a primary source');

  const sources = Array.isArray(out.sources) ? out.sources : [];
  for (const s of sources) {
    if (!s.url || !/^https?:\/\//.test(s.url)) throw new Blocked(`figure "${s.figure}" has no url; sources.md does not accept a figure that cannot be traced`);
    if (!s.retrieved) throw new Blocked(`figure "${s.figure}" has no retrieval date`);
    if (!s.quote) throw new Blocked(`figure "${s.figure}" has no exact quote or table cell`);
    if (s.headline && !s.crossChecked) throw new Blocked(`headline figure "${s.figure}" is not cross-checked; sources.md requires it`);
  }
  return sources;
}

// --------------------------------------------------------------------------
// 4. WRITE — headline, slide copy, both captions. Linted against banned.md,
//    which calls its list hard failures, so a block there blocks the deck.
// --------------------------------------------------------------------------
const WRITE_SHAPE = `{
  "brief": "a complete deck brief object matching pipeline/render/brief.schema.json, without deckId, date or topic (the runner fills those in)",
  "captions": {
    "instagram": "clean caption, hook line first, no hashtags",
    "tiktok": "same story, with two or three plain search phrases woven in"
  }
}`;

async function stageWrite({ cfg, brain, idea, sources, previousErrors, attempt = 1 }) {
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
    'The verified sources. Every figure you put on a slide must be one of these, and the slide carries its source row:',
    JSON.stringify(sources, null, 1),
    '',
    'Requirements:',
    '- series is the uppercase series label, e.g. "RUNNING 101".',
    '- Seven slides: a cover, five middle slides carrying point numbers 01-05 in order, and cta last.',
    '- The cta takes no input but its one line of source credit.',
    '- Copy obeys banned.md exactly. It is a hard list, not a preference.',
    ...budgets,
    previousErrors ? `\nYour previous attempt did not validate:\n${previousErrors}\nFix exactly these and return the whole object again.` : '',
  ].join('\n');

  const out = await callModel({ stage: 'write', prompt, schema: WRITE_SHAPE, config: cfg, log });
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
    return stageWrite({ cfg, brain, idea, sources, attempt: 2, previousErrors: `The copy does not fit the components:\n${detail}\nCut these to the budget. Everything else in the deck stays as it is.` });
  }
  return { brief: out.brief, captions: out.captions || {}, overBudget: over };
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
  const state = new State(path.join(ROOT, cfg.run.stateDb));
  const tg = new Telegram(cfg.telegram);
  const runId = state.startRun(brand);
  const summary = { brand, runId, backend, stages: {}, briefs: 0, decks: [], deadFeeds: [], drift: [] };
  log(`run ${runId}: ${brand}, models backend ${backend}${backend === 'stub' ? ` (state ${cfg.run.stateDb}, output ${cfg.run.outDir})` : ''}`);

  try {
    // 0. Drift.
    summary.drift = driftCheck(state, brain);
    for (const deckKey of summary.drift) {
      await tg.send(`drift: ${deckKey} is marked published in state.db but has no row in posted.jsonl.\nThe confirm step did not write it. Nothing was repaired automatically.`);
    }

    // 1-2. Run-level stages. A failure here is the night, not one deck.
    const scanned = await stageScan({ cfg, brain, state, runId, tg, summary });
    const { ideas } = await stagePick({ cfg, brain, state, runId, tg, summary, scanned });
    const evidence = scanned.filter((s) => s.tier === 'evidence-source');

    // 3-6, per idea, isolated.
    for (const idea of ideas) {
      const briefId = state.addBrief(runId, brand, { topic: idea.topic, series: idea.series, angle: idea.angle, score: idea.score, status: 'picked' });
      summary.briefs++;
      const deckKey = nextDeckKey(cfg.run.deckKeyPrefix, state, brain);
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
        const sources = await stageVerify({ cfg, brain, idea, evidence });
        for (const s of sources) state.addSource(briefId, s);
        state.updateBrief(briefId, { status: 'verified' });

        // 4. WRITE
        let { brief, captions, overBudget } = await stageWrite({ cfg, brain, idea, sources });
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
        ].filter((t) => t.text);
        const findings = lintCopy(texts, brain.files.banned, { quotedSources: sources.map((s) => s.quote) });
        const hard = lintBlocks(findings);
        const soft = lintFlags(findings);
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
        summary.decks.push({ deckKey, topic: idea.topic, status, reason });
        log(`${deckKey} (${idea.topic}): ${status} — ${reason}`);
        if (status === 'blocked') {
          await tg.send(`blocked by qa: ${deckKey} (${idea.topic})\n${reason}`);
        }
      } catch (e) {
        if (e instanceof Blocked) await park('blocked', e.message);
        else await park('needs_attention', `${e.name || 'error'}: ${e.message}`);
      }
    }

    const pending = summary.decks.filter((d) => d.status === 'pending');
    const blocked = summary.decks.filter((d) => d.status === 'blocked');
    const attention = summary.decks.filter((d) => d.status === 'needs_attention');
    state.finishRun(runId, 'ok', summary);

    const lines = [
      `${brand}: run ${runId} finished`,
      `${summary.briefs} briefs, ${pending.length} pending, ${blocked.length} blocked, ${attention.length} needs attention`,
      summary.deadFeeds.length ? `${summary.deadFeeds.length} dead feed(s): ${summary.deadFeeds.map((d) => d.feed).join(', ')}` : 'all feeds alive',
      summary.drift.length ? `drift: ${summary.drift.join(', ')} published without a posted.jsonl row` : '',
      '',
      ...summary.decks.map((d) => `${d.status === 'pending' ? 'ok' : d.status}  ${d.deckKey}  ${d.topic}`),
    ].filter(Boolean);
    await tg.send(lines.join('\n'));
    log('\n' + lines.join('\n'));
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

module.exports = { driftCheck, nextDeckKey };
