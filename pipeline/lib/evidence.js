'use strict';
// Europe PMC, read-only: the licence and figure checks that decide whether a
// claim is FIGURE-BACKED or merely SOURCED.
//
// The model classifies a claim and names its source; this module is what makes
// the FIGURE-BACKED half of that claim checkable rather than asserted. It
// answers two questions against the real record:
//
//   1. Is the paper open access, and under what licence? (search, resultType=core)
//   2. Does it contain a chart, plot or table? (fullTextXML <fig> blocks)
//
// WHAT DOES NOT WORK, and why the stored figure is a reference rather than a
// file. Downloading the image bytes is blocked on this box by every documented
// route, checked 10 Sep 2026:
//   - pmc.ncbi.nlm.nih.gov/articles/<id>/bin/<href>  -> reCAPTCHA interstitial
//   - www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi      -> 404
//   - pmc.ncbi.nlm.nih.gov/utils/oa/oa.fcgi          -> 403
//   - europepmc.org/articles/<id>/bin/<href>         -> 520
// The reCAPTCHA one is a deliberate anti-automation gate and is not something
// to work around. So a FIGURE-BACKED claim records everything needed to fetch
// and caption the figure later — pmcid, filename, label, caption, licence, and
// a URL a human can open — and `imagePath` stays null with the reason on the
// row. Nothing renders a figure yet, so nothing is lost today; the fetch has
// to be solved before the evidence-figure component ships.
const https = require('https');

const HOST = 'www.ebi.ac.uk';
const BASE = '/europepmc/webservices/rest';
const UA = 'content-machine/1.0 (+https://github.com/Jensdeboer/content-machine)';

// Licences that permit reproducing a figure with attribution. Anything else,
// including "no licence stated", is treated as not reusable: a figure we may
// not republish is not a figure this deck can carry.
//
// ND IS EXCLUDED. CC BY-NC-ND permits redistribution but forbids derivative
// works, and a figure placed on a slide is cropped, scaled and set on a brand
// ground — which is a derivative. The distinction matters because it is easy
// to miss: "cc by-nc-nd" starts with the same characters as the licences that
// do allow it, and a loose prefix match waves it straight through. A paper
// under ND is a perfectly good SOURCE; it is just not a figure this deck may
// redraw.
const REUSABLE = /^cc[ -]?(by|by-sa|by-nc|by-nc-sa|0)(\s|$)/i;

function get(pathname, { accept = 'application/json', timeout = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: HOST, path: pathname, method: 'GET', timeout, headers: { accept, 'user-agent': UA } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error(`europepmc timeout after ${timeout}ms`)));
    req.on('error', reject);
    req.end();
  });
}

const esc = (s) => encodeURIComponent(String(s));

// Find the paper. A DOI, PMID or PMCID is exact; a title is a best-effort
// match and is only accepted when the top hit's title is a close match, so a
// vaguely similar paper never gets attached to a claim as though it were the
// source.
async function lookup({ doi, pmid, pmcid, title }) {
  let query = null;
  if (pmcid) query = `PMCID:${String(pmcid).toUpperCase()}`;
  else if (doi) query = `DOI:"${doi}"`;
  else if (pmid) query = `EXT_ID:${pmid} AND SRC:MED`;
  else if (title) query = `TITLE:"${String(title).replace(/"/g, '')}"`;
  if (!query) return null;
  let res;
  try { res = await get(`${BASE}/search?query=${esc(query)}&resultType=core&format=json&pageSize=3`); }
  catch (e) { return { error: e.message }; }
  if (res.status !== 200) return { error: `search HTTP ${res.status}` };
  let hits;
  try { hits = ((JSON.parse(res.body).resultList || {}).result) || []; } catch (e) { return { error: 'search returned unparseable json' }; }
  if (!hits.length) return null;
  const r = hits[0];
  if (title && !doi && !pmid && !pmcid && !looksLikeSameTitle(title, r.title)) return null;
  return {
    pmcid: r.pmcid || null,
    pmid: r.pmid || null,
    doi: r.doi || null,
    title: r.title || null,
    firstAuthor: r.authorString ? String(r.authorString).split(',')[0].trim() : null,
    year: r.pubYear ? Number(r.pubYear) : null,
    journal: (r.journalInfo && r.journalInfo.journal && r.journalInfo.journal.title) || null,
    licence: r.license || null,
    isOpenAccess: r.isOpenAccess === 'Y',
    inEPMC: r.inEPMC === 'Y',
    reusableLicence: !!(r.license && REUSABLE.test(String(r.license).trim())),
  };
}

// Loose title comparison: punctuation and case dropped, most words shared.
function looksLikeSameTitle(a, b) {
  const words = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 3));
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return false;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / A.size >= 0.6;
}

// The figures the paper actually contains, from the full-text XML. Returns
// [] when the paper is not in Europe PMC's full text (which is most non-OA
// papers) — that is a SOURCED claim, not a failure.
async function figures(pmcid) {
  if (!pmcid) return [];
  let res;
  try { res = await get(`${BASE}/${esc(String(pmcid).toUpperCase())}/fullTextXML`, { accept: 'application/xml' }); }
  catch (e) { return []; }
  if (res.status !== 200 || !/<fig\b/.test(res.body)) return [];
  const out = [];
  for (const block of res.body.match(/<fig\b[\s\S]*?<\/fig>/g) || []) {
    const href = (block.match(/xlink:href="([^"]+)"/) || [])[1] || null;
    if (!href) continue;
    const strip = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    out.push({
      label: strip((block.match(/<label>([\s\S]*?)<\/label>/) || [])[1]) || null,
      caption: strip((block.match(/<caption>([\s\S]*?)<\/caption>/) || [])[1]) || null,
      href,
      url: `https://europepmc.org/article/PMC/${String(pmcid).toUpperCase()}#${href.replace(/\.[a-z]+$/i, '')}`,
    });
  }
  return out;
}

// Which of a paper's figures speaks to this claim. Word overlap between the
// claim and the caption, with a floor so a figure is attached because it is
// about the thing, not because it was first in the list. A flow chart or a
// study-design diagram is not evidence for a number, so those are skipped.
const NOT_EVIDENCE = /\b(flow ?chart|study design|consort|schematic|protocol|timeline)\b/i;

function pickFigure(claimText, figs) {
  const words = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 3));
  const claim = words(claimText);
  if (!claim.size) return null;
  let best = null;
  for (const f of figs) {
    if (!f.caption || NOT_EVIDENCE.test(f.caption)) continue;
    const cap = words(f.caption);
    let shared = 0;
    for (const w of claim) if (cap.has(w)) shared++;
    const score = shared / claim.size;
    if (score >= 0.15 && (!best || score > best.score)) best = { ...f, score: +score.toFixed(3) };
  }
  return best;
}

// Everything the FIGURE-BACKED tier needs, checked rather than asserted.
// Returns { ok, why, paper, figure } — ok false means the claim is at most
// SOURCED, and `why` says which of the three conditions failed.
async function figureEvidence(claimText, ref) {
  const paper = await lookup(ref || {});
  if (!paper) return { ok: false, why: 'no Europe PMC record for the cited source', paper: null, figure: null };
  if (paper.error) return { ok: false, why: `Europe PMC lookup failed (${paper.error})`, paper: null, figure: null };
  if (!paper.isOpenAccess) return { ok: false, why: 'the paper is not open access', paper, figure: null };
  if (!paper.reusableLicence) return { ok: false, why: `licence "${paper.licence || 'none stated'}" does not permit reuse`, paper, figure: null };
  const figs = await figures(paper.pmcid);
  if (!figs.length) return { ok: false, why: 'no figures in the Europe PMC full text', paper, figure: null };
  const figure = pickFigure(claimText, figs);
  if (!figure) return { ok: false, why: `none of the ${figs.length} figures is about this claim`, paper, figure: null };
  return { ok: true, why: null, paper, figure };
}

module.exports = { lookup, figures, pickFigure, figureEvidence, looksLikeSameTitle, REUSABLE };
