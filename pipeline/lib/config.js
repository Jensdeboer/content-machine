'use strict';
// brands/<brand>/config.md is the settings file. Nothing in the pipeline holds
// a brand-specific value: every number, name and model id is read from here, so
// a second brand is a folder rather than a code change.
//
// Two shapes are read out of the markdown:
//   - "- key: value" bullets under a "## Section"
//   - "| a | b |" table rows under a "## Section" (header and rule skipped)
const fs = require('fs');
const path = require('path');

const slug = (s) => String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

function parseMarkdownSettings(text) {
  const sections = new Map();
  let current = null;
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const head = line.match(/^##\s+(.*?)\s*$/);
    if (head) {
      current = { title: head[1], keys: new Map(), rows: [] };
      sections.set(slug(head[1]), current);
      continue;
    }
    if (!current) continue;
    const bullet = line.match(/^\s*-\s+(?:\*\*)?([^:*]+?)(?:\*\*)?\s*:\s+(.*?)\s*$/);
    if (bullet) {
      const value = bullet[2].replace(/^`|`$/g, '').trim();
      const key = slug(bullet[1]);
      if (key && !current.keys.has(key)) current.keys.set(key, value);
      continue;
    }
    const row = line.match(/^\s*\|(.+)\|\s*$/);
    if (row) {
      const cells = row[1].split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // rule
      current.rows.push(cells);
    }
  }
  return sections;
}

class Config {
  constructor(brand, brandDir, sections) {
    this.brand = brand;
    this.dir = brandDir;
    this.sections = sections;
  }

  section(name) {
    const s = this.sections.get(slug(name));
    if (!s) throw new Error(`config.md has no "## ${name}" section (${this.dir})`);
    return s;
  }

  // A "- key: value" bullet. Throws when missing: config is the source of
  // truth, and a silently defaulted setting is a setting nobody can change.
  value(sectionName, key, { fallback } = {}) {
    const s = this.section(sectionName);
    const v = s.keys.get(slug(key));
    if (v === undefined) {
      if (fallback !== undefined) return fallback;
      throw new Error(`config.md "## ${sectionName}" has no "${key}:" line`);
    }
    return v;
  }

  // The leading number of the value, so a setting may carry its own prose
  // ("300 seconds. One retry on timeout...") without a second place to edit.
  number(sectionName, key, opts) {
    const raw = this.value(sectionName, key, opts);
    const m = String(raw).match(/-?\d+(?:\.\d+)?/);
    if (!m) throw new Error(`config.md "${key}" is not a number: ${raw}`);
    return Number(m[0]);
  }

  // The first word of the value, so "yes. The verify stage runs with..." reads
  // as yes and still explains itself in the file.
  bool(sectionName, key, opts) {
    return /^(yes|true|on)\b/i.test(String(this.value(sectionName, key, opts)).trim());
  }

  // Table rows under a section, as [[a, b], ...] with the header row dropped
  // when it looks like a header.
  table(sectionName, { header }) {
    const rows = this.section(sectionName).rows;
    return rows.filter((r) => !(header && slug(r[0]) === slug(header)));
  }
}

function loadConfig(root, brand) {
  const brandDir = path.join(root, 'brands', brand);
  const file = path.join(brandDir, 'config.md');
  if (!fs.existsSync(file)) throw new Error(`no config.md for brand "${brand}" (looked in ${brandDir})`);
  const cfg = new Config(brand, brandDir, parseMarkdownSettings(fs.readFileSync(file, 'utf8')));

  // --- Models -------------------------------------------------------------
  const aliasRows = cfg.table('Models', { header: 'Alias' }).filter((r) => r.length >= 2 && /^[a-z0-9-]+$/i.test(r[0]));
  const stageRows = cfg.table('Models', { header: 'Stage' }).filter((r) => r.length >= 2);
  const aliases = new Map();
  for (const [alias, id] of aliasRows) if (/^claude-/.test(id)) aliases.set(slug(alias), id);
  const stages = new Map();
  for (const [stage, alias] of stageRows) {
    const a = slug(alias);
    if (a === 'none') { stages.set(slug(stage), null); continue; }
    if (aliases.has(a)) stages.set(slug(stage), aliases.get(a));
  }
  cfg.models = {
    aliases: Object.fromEntries(aliases),
    stages: Object.fromEntries(stages),
    // null means the stage is pure code; undefined means config never named it.
    forStage(stage) {
      const key = slug(stage);
      if (!stages.has(key)) throw new Error(`config.md "## Models" has no row for the "${stage}" stage`);
      return stages.get(key);
    },
    timeoutMs: cfg.number('Models', 'Timeout per call', { fallback: '300' }) * 1000,
    verifyWebTools: cfg.bool('Models', 'Verify may use web search', { fallback: 'no' }),
  };

  // --- Run settings -------------------------------------------------------
  cfg.run = {
    deckKeyPrefix: cfg.value('Run settings', 'Deck key prefix'),
    ideasPerRun: cfg.number('Run settings', 'Ideas per run'),
    scanScoreThreshold: cfg.number('Run settings', 'Scan score threshold'),
    scanSeenWindowDays: cfg.number('Run settings', 'Scan seen window (days)'),
    topicWindowDays: cfg.number('Run settings', 'Topic window (days)'),
    feedTimeoutMs: cfg.number('Run settings', 'Feed timeout (seconds)') * 1000,
    feedPauseMs: cfg.number('Run settings', 'Feed pause (seconds)') * 1000,
    feedRetryPauseMs: cfg.number('Run settings', 'Feed retry pause (seconds)') * 1000,
    feedUserAgent: cfg.value('Run settings', 'Feed user agent'),
    maxItemsPerScanCall: cfg.number('Run settings', 'Max items per scan call'),
    stateDb: cfg.value('Run settings', 'State database'),
    outDir: cfg.value('Run settings', 'Output directory'),
  };

  // --- Captions -----------------------------------------------------------
  // The hashtag block is an experiment (growth.md), off unless config.md says
  // yes. With the key missing it is off: a default the other way would change
  // every caption on a brand that never asked.
  cfg.captions = { hashtags: cfg.bool('Captions', 'hashtags_enabled', { fallback: 'no' }) };

  // --- Kill switch --------------------------------------------------------
  // Read by packet.js before anything else. Off means no packet and no push.
  cfg.publishing = { enabled: cfg.bool('Kill switch', 'publishing_enabled') };

  // --- Provider -----------------------------------------------------------
  // The three provider strings are documented in "## Provider" and read from
  // there, profile name included: it is case sensitive, it is not the handle,
  // and a copy of it in code is a second place to get it wrong.
  const bare = (v) => String(v).replace(/`/g, '').trim();
  const providerRows = cfg.table('Provider', { header: 'Where' });
  const userRow = providerRows.find((r) => r.length >= 2 && /provider/.test(slug(r[0])) && /user/.test(slug(r[0])));
  if (!userRow) throw new Error('config.md "## Provider" has no "Provider `user` parameter" row');
  const endpoint = bare(cfg.value('Provider', 'Photo endpoint')).split(/\s+/);
  const keyEnv = (bare(cfg.value('Provider', 'Auth header')).match(/<([A-Z0-9_]+)>/) || [])[1];
  if (!keyEnv) throw new Error('config.md "## Provider" auth header names no <ENV_VAR> for the key');
  // The provider's documented limits live in the same section, so a change in
  // the provider's docs is an edit there, and the pre-flight in provider.js
  // reads them from here.
  const mentions = (bare(cfg.value('Provider', 'TikTok description limit')).match(/(\d+)\s*mentions/i) || [])[1];
  const resolution = bare(cfg.value('Provider', 'Photo resolution'));
  cfg.provider = {
    user: bare(userRow[1]),
    photoUrl: endpoint[endpoint.length - 1],
    keyEnv,
    limits: {
      titleChars: cfg.number('Provider', 'TikTok title limit'),
      descriptionChars: cfg.number('Provider', 'TikTok description limit'),
      descriptionMentions: mentions ? Number(mentions) : null,
      photosMax: cfg.number('Provider', 'Photos per post'),
      photoBytesMax: cfg.number('Provider', 'Photo size limit') * 1024 * 1024,
      photoFormats: bare(cfg.value('Provider', 'Photo formats')).split(/[,\s]+/).filter(Boolean).map((f) => f.toLowerCase()),
      photoShortSideMax: Number((resolution.match(/(\d+)\s*px\s*short/i) || [])[1]) || null,
      photoLongSideMax: Number((resolution.match(/(\d+)\s*px\s*long/i) || [])[1]) || null,
    },
  };

  // --- Telegram -----------------------------------------------------------
  const envName = (v) => v.replace(/`/g, '').split(/\s+/)[0].replace(/[^A-Z0-9_]+$/i, '');
  cfg.telegram = {
    tokenEnv: envName(cfg.value('Telegram', 'Bot token')),
    chatEnv: envName(cfg.value('Telegram', 'Chat id')),
  };

  return cfg;
}

module.exports = { loadConfig, parseMarkdownSettings, slug };
