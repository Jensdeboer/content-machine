# Sources

Numbers on slides come from this list, or the deck blocks. When a claim rests
on one study, the copy says so.

## Primary — preferred

- Peer-reviewed journals via PubMed: Medicine & Science in Sports & Exercise,
  Journal of Applied Physiology, Sports Medicine, British Journal of Sports
  Medicine, European Journal of Applied Physiology
- World Athletics (records, championship results, rules)
- ACSM position stands and guidelines
- WHO physical activity guidelines
- Race organisers' official results (Abbott majors, local races)

## Established training literature — allowed with attribution

- Daniels' Running Formula (VDOT, training intensities)
- Lydiard, Canova and similar documented elite training programmes —
  described as "how X's programme trains", not as settled science

## Secondary — allowed for colour, never as the sole source of a figure

- Runner's World, Outside/PodiumRunner — only when they cite a primary
  source, which is then checked and cited instead
- Strava and Garmin published data reports — clearly labelled as platform
  data ("among Strava users...")

## Not acceptable

- Random coaching blogs, YouTube gurus, supplement-adjacent sites
- Screenshots of other accounts' claims
- AI-generated "facts" without a checked primary source
- Any figure that cannot be traced to a URL and retrieval date

## Record per figure

figure - exact quote or table cell - url - publisher - retrieved date -
cross-checked (yes/no; headline figures always yes)

## Feeds — what scan pulls

The tiers above say what evidence is acceptable. This section says where scan
looks, grouped by those tiers.

Two kinds of feed, and they never mix:

- **evidence-source** — a figure may cite what it returns, subject to the
  tiers above and the per-figure record.
- **idea-source** — tells you what people are asking about, nothing more. A
  figure may NEVER cite an idea-source. Reddit tells you what people are
  confused about; the answer still has to come from a journal.

Every feed entry records: url, what it is for, tier, last verified.

scan logs a dead feed to Telegram and continues. A feed that 404s, times out,
rate-limits or returns nothing never fails the run: the run goes ahead with
what came back, and the dead feed is named in the log so it gets fixed or
dropped at the next brain pass.

### Evidence-sources — Primary tier

Search APIs. Both run the same queries, so one is a check on the other.

- **Europe PMC REST search**
  - url: `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=(running OR marathon OR "endurance training" OR "running economy") AND (TITLE_ABS:"training" OR TITLE_ABS:"performance" OR TITLE_ABS:"injury") AND FIRST_PDATE:[{from} TO {to}]&format=json&pageSize=25`
  - for: everything indexed in the last 30 days on running, endurance training,
    performance and injury. `{from}`/`{to}` are a rolling 30-day window.
  - tier: evidence-source
  - last verified: 2026-09-07 (162 hits over the trailing 30 days, no key)
- **PubMed E-utilities esearch** — second opinion on the same window
  - url: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=(running[tiab] OR marathon[tiab] OR "endurance training"[tiab]) AND (training[tiab] OR performance[tiab] OR injury[tiab])&datetype=pdat&reldate=30&retmode=json&retmax=25`
  - for: the same sweep against a second index; ids resolve via efetch.
  - tier: evidence-source
  - last verified: 2026-09-07 (155 hits, no key; `reldate=30` does the window)
- **PubMed E-utilities esearch, scoped to MSSE**
  - url: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term="Med Sci Sports Exerc"[jour]&datetype=pdat&reldate=30&retmode=json&retmax=25`
  - for: Medicine & Science in Sports & Exercise, which publishes no working
    feed of its own (see Dropped). Swap the `[jour]` term for any other
    Primary-tier journal that loses its feed.
  - tier: evidence-source
  - last verified: 2026-09-07 (56 records in the trailing 30 days)

Journal feeds. Narrower than the search APIs and slower to update, but they
carry editorials and ahead-of-print that the date-windowed queries miss.

- **British Journal of Sports Medicine — ahead of print**
  - url: `https://bjsm.bmj.com/rss/ahead.xml`
  - for: BJSM papers before issue assignment; the richest of the three BJSM
    feeds.
  - tier: evidence-source
  - last verified: 2026-09-07 (84 items)
- **British Journal of Sports Medicine — recent issues**
  - url: `https://bjsm.bmj.com/rss/recent.xml`
  - for: BJSM as published, issue by issue. `current.xml` is the same shape
    for the current issue only (verified, 16 items).
  - tier: evidence-source
  - last verified: 2026-09-07 (16 items)
- **Journal of Applied Physiology — eTOC**
  - url: `https://journals.physiology.org/action/showFeed?type=etoc&feed=rss&jc=jappl`
  - for: physiology of endurance performance.
  - tier: evidence-source
  - last verified: 2026-09-07 (38 items)
- **Sports Medicine (Springer)**
  - url: `https://link.springer.com/search.rss?facet-journal-id=40279&channel-name=Sports+Medicine`
  - for: reviews and meta-analyses, the best per-item source of settled
    numbers.
  - tier: evidence-source
  - last verified: 2026-09-07 (20 items)
- **European Journal of Applied Physiology (Springer)**
  - url: `https://link.springer.com/search.rss?facet-journal-id=421&channel-name=European+Journal+of+Applied+Physiology`
  - for: mechanism papers behind training-intensity claims.
  - tier: evidence-source
  - last verified: 2026-09-07 (20 items)
- **Scandinavian Journal of Medicine & Science in Sports (Wiley)**
  - url: `https://onlinelibrary.wiley.com/feed/16000838/most-recent`
  - for: training load, injury and recreational-runner cohorts.
  - tier: evidence-source
  - last verified: 2026-09-07 (8 items)

### Idea-sources — never cited

Not in any evidence tier above: as evidence these are "Not acceptable". They
exist to tell scan what beginners and club runners are actually arguing about
this week, which is a topic input, never a figure input.

All three need a real browser User-Agent — a short custom agent returns an
empty body — and Reddit rate-limits hard: one request at a time, spaced, or
it answers 429. A 429 is a dead feed for that run; log it and move on.

- **r/running — top of week**
  - url: `https://www.reddit.com/r/running/top/.rss?t=week`
  - for: beginner confusion and recurring questions, the gap a cover headline
    opens.
  - tier: idea-source
  - last verified: 2026-09-07 (25 entries)
- **r/AdvancedRunning — top of week**
  - url: `https://www.reddit.com/r/AdvancedRunning/top/.rss?t=week`
  - for: what experienced runners dispute; useful for the "everyone says X"
    angle a deck can correct.
  - tier: idea-source
  - last verified: 2026-09-07 (16 entries)
- **r/Marathon_Training — top of week**
  - url: `https://www.reddit.com/r/Marathon_Training/top/.rss?t=week`
  - for: block-specific worries (taper, long-run pace, fuelling), seasonal by
    nature.
  - tier: idea-source
  - last verified: 2026-09-07 (25 entries)

### Seasonal timing

- **RunSignup race search**
  - url: `https://runsignup.com/rest/races?format=json&results_per_page=50&start_date={from}&end_date={to}`
  - for: how many races sit in the weeks ahead, so a deck lands in taper
    season rather than after it. Volume and clustering only.
  - tier: idea-source. A race date that appears on a slide comes from the
    organiser's official page (Primary tier), never from the aggregator.
  - last verified: 2026-09-07 (no key; date range works. The distance filter
    does not — `distance_min`/`distance_max` are ignored and 5Ks come back
    for a marathon query, so do not filter on distance.)

### Dropped, and why

Checked on 2026-09-07 and not included:

- **Medicine & Science in Sports & Exercise RSS** — the LWW feed endpoint
  (`journals.lww.com/acsm-msse/_layouts/15/OAKS.Journals/feed.aspx`) 301s to
  an HTML journal page. It returns 200, so a naive check calls it alive;
  there is no feed behind it. Covered by the journal-scoped PubMed query
  above instead.
- **World Athletics competition calendar** — no public feed or documented
  API; the calendar page could not be fetched at all from here.
- **AIMS race calendar** (`aims-worldrunning.org/calendar.html`) — returns
  200 HTML but the listing is rendered client-side: no dates and no table
  rows in the markup, so there is nothing to parse.
