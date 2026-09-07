'use strict';
// Reads the "## Feeds — what scan pulls" section of sources.md and fetches it.
// The file is the feed list: adding or dropping a feed is an edit there, never
// a code change. Every entry carries url, what it is for, tier and last
// verified, and this module keeps the tier attached to every item it returns so
// the picker can never let an idea-source become evidence.
const https = require('https');
const { URL } = require('url');

// ---------------------------------------------------------------- parsing ---
// Entries look like:
//   - **Name**
//     - url: `https://...`
//     - for: ...
//     - tier: evidence-source
//     - last verified: 2026-09-07 (...)
function parseFeeds(sourcesMd) {
  const start = sourcesMd.search(/^##\s+Feeds\b/im);
  if (start < 0) return [];
  let body = sourcesMd.slice(start);
  // Stop before the "### Dropped, and why" list: those are deliberately not fetched.
  const dropped = body.search(/^###\s+Dropped\b/im);
  if (dropped > 0) body = body.slice(0, dropped);

  const feeds = [];
  let cur = null;
  for (const line of body.split(/\r?\n/)) {
    const name = line.match(/^\s*-\s+\*\*(.+?)\*\*/);
    if (name) {
      if (cur && cur.url) feeds.push(cur);
      cur = { name: name[1].trim(), url: null, purpose: null, tier: null, lastVerified: null };
      continue;
    }
    if (!cur) continue;
    const field = line.match(/^\s+-\s+(url|for|tier|last verified)\s*:\s*(.*)$/i);
    if (!field) continue;
    const key = field[1].toLowerCase();
    const value = field[2].trim().replace(/^`|`$/g, '');
    if (key === 'url') cur.url = value.replace(/`/g, '');
    else if (key === 'for') cur.purpose = value;
    else if (key === 'tier') cur.tier = value.split(/[.\s]/)[0].toLowerCase();
    else cur.lastVerified = (value.match(/\d{4}-\d{2}-\d{2}/) || [null])[0];
  }
  if (cur && cur.url) feeds.push(cur);
  return feeds.filter((f) => /^https?:\/\//.test(f.url));
}

const iso = (d) => d.toISOString().slice(0, 10);

// {from} / {to} are the rolling window the feed entry documents.
function fillWindow(url, days) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400000);
  return url.replace(/\{from\}/g, iso(from)).replace(/\{to\}/g, iso(to));
}

// ---------------------------------------------------------------- fetching ---
function get(url, { timeout, userAgent, redirects = 3 }) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': userAgent, accept: '*/*' }, timeout }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(get(next, { timeout, userAgent, redirects: redirects - 1 }));
      }
      if (code !== 200) { res.resume(); return reject(new Error(`HTTP ${code}`)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeout}ms`)));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- parsing ---
const strip = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/\s+/g, ' ').trim();

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? strip(m[1]) : null;
};

// RSS 2.0, RSS 1.0/RDF and Atom, which is every feed shape sources.md lists.
function parseXmlFeed(xml) {
  const items = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  for (const b of blocks) {
    let link = tag(b, 'link');
    if (!link) {
      const href = b.match(/<link[^>]*href=["']([^"']+)["']/i);
      link = href ? href[1] : null;
    }
    const about = b.match(/rdf:about=["']([^"']+)["']/i);
    items.push({
      title: tag(b, 'title'),
      url: link || (about ? about[1] : null),
      published: tag(b, 'pubDate') || tag(b, 'dc:date') || tag(b, 'updated') || tag(b, 'published'),
      summary: (tag(b, 'description') || tag(b, 'summary') || tag(b, 'content') || '').slice(0, 600) || null,
    });
  }
  return items;
}

// Europe PMC, RunSignup, and PubMed esearch (ids only; titles need esummary).
async function parseJsonFeed(body, url, opts) {
  const data = JSON.parse(body);
  if (data.resultList && Array.isArray(data.resultList.result)) {
    return data.resultList.result.map((r) => ({
      title: r.title || null,
      url: r.doi ? `https://doi.org/${r.doi}` : (r.pmid ? `https://europepmc.org/article/MED/${r.pmid}` : null),
      published: r.firstPublicationDate || r.pubYear || null,
      summary: [r.journalTitle, r.authorString].filter(Boolean).join(' — ').slice(0, 600) || null,
    }));
  }
  if (data.esearchresult && Array.isArray(data.esearchresult.idlist)) {
    const ids = data.esearchresult.idlist;
    if (!ids.length) return [];
    const sum = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi');
    sum.searchParams.set('db', 'pubmed');
    sum.searchParams.set('id', ids.join(','));
    sum.searchParams.set('retmode', 'json');
    const res = JSON.parse(await get(sum.toString(), opts));
    return ids.map((id) => {
      const r = (res.result || {})[id] || {};
      return {
        title: r.title || null,
        url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
        published: r.pubdate || null,
        summary: r.source || null,
      };
    }).filter((i) => i.title);
  }
  if (Array.isArray(data.races)) {
    return data.races.map(({ race }) => ({
      title: race.name || null,
      url: race.url || (race.race_id ? `https://runsignup.com/Race/${race.race_id}` : null),
      published: race.next_date || race.last_date || null,
      summary: [race.next_date, (race.address || {}).state].filter(Boolean).join(' · ') || null,
    }));
  }
  return [];
}

// Fetch one feed. Never throws: a dead feed is reported, not fatal — the run
// goes ahead with what came back (sources.md).
async function fetchFeed(feed, { timeoutMs, userAgent, windowDays }) {
  const url = fillWindow(feed.url, windowDays);
  const opts = { timeout: timeoutMs, userAgent };
  try {
    const body = await get(url, opts);
    const isJson = /format=json|retmode=json/.test(url) || /^\s*[{[]/.test(body);
    const items = isJson ? await parseJsonFeed(body, url, opts) : parseXmlFeed(body);
    const clean = items.filter((i) => i.title).map((i) => ({ ...i, feed: feed.name, tier: feed.tier }));
    if (!clean.length) return { feed, url, ok: false, error: 'returned no items', items: [] };
    return { feed, url, ok: true, items: clean };
  } catch (e) {
    return { feed, url, ok: false, error: e.message, items: [] };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sequentially and spaced: sources.md records that Reddit answers 429 to
// back-to-back requests, and BMJ and Springer throttle a burst the same way.
// A feed that fails once is retried after a longer pause before it is called
// dead, so a rate limit is not mistaken for a broken feed.
async function fetchAll(feeds, opts) {
  const { pauseMs = 2000, retryPauseMs = 8000 } = opts;
  const out = [];
  for (let i = 0; i < feeds.length; i++) {
    if (i) await sleep(pauseMs);
    let r = await fetchFeed(feeds[i], opts);
    if (!r.ok) {
      await sleep(retryPauseMs);
      const retry = await fetchFeed(feeds[i], opts);
      if (retry.ok) retry.recoveredAfterRetry = true;
      r = retry.ok ? retry : { ...r, error: `${r.error} (retried once after ${retryPauseMs}ms: ${retry.error})` };
    }
    out.push(r);
  }
  return out;
}

module.exports = { parseFeeds, fetchFeed, fetchAll, fillWindow, parseXmlFeed };
