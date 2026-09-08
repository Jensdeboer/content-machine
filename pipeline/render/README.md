# pipeline/render

Brief JSON in, `out/<deckId>/01.jpg … NN.jpg` at 2160x2700 out, then `review.json`.

    npm test                                   # renders examples/PV-01.json into out/test/PV-01
    npm run test:qa                            # QA alone on that fixture output
    node pipeline/render/index.js <brief.json> [--out out] [--brand brands/pacevector] [--no-qa]
    node pipeline/render/qa.js out/<deckId>    # QA alone on a real deck, exit 3 when flagged
    node pipeline/render/qa.js out/<deckId> --publish   # publish gate: unfilled or unchecked source rows block

Real decks live in `out/<deckId>/`, written by the nightly. Tests never touch
them: a brief from `examples/` always renders under `out/test/`, whatever
`--out` says, and the stub run writes to `out/stub/`.

Design at 1080x1350, screenshot at deviceScaleFactor 2. Margin, safe zone and
footer band come from `tokens.json`; template dimensions the locked `.dc.html`
files hard-code without a token are listed in `component-metrics.json`.

## Files

- `index.js` — validates the brief against `brief.schema.json`, runs the
  history rules from `posted.jsonl`, composes the cover, builds the body slides
  from the `04-slides` components, screenshots, writes `deck.json` (resolved
  layout + the `postedRow` the publish step appends) and runs QA.
- `qa.js` — re-measures the rendered DOM and writes `review.json`.
- `lib/rules.js` — every threshold, marked stated vs default.
- `lib/cover.js` — fit loop (real font, steps down the token scale), figure
  selection and placement search, zone checks against the manifest's 3x3 alpha
  grid, per-glyph occlusion against the figure's alpha.
- `lib/lines.js` — the one measurement of where a headline line is: the
  text's real-font rect from the page. The composer's search and `qa.js` both
  read it, so what passes the search passes QA. Every line is zone-tested,
  whether or not it overlaps the figure box.
- `test/pv07-dense-zone.js` — regression for the case that found the gap
  (PV-07, 8 Sep 2026); runs as part of `npm test`.
- `lib/slides.js` — one function per body component, ported from `04-slides`.
- `lib/history.js` — alternation, 14/3/2/1 mix, cutout and position rotation,
  mode rotation, 90-day hash window.
- `fonts/` — Sora 700/800, IBM Plex Sans 400 and 300 italic, IBM Plex Mono
  500, vendored from Google Fonts so measurement is deterministic offline.

## Sources

Every slide that shows a figure carries a source row (sources.md shape). A
missing row blocks the render. A row with `crossChecked: false` or no URL
warns at render time and closes the publish gate: `review.json` carries
`publish.ok` and `qa.js --publish` exits 3 until the row is filled.

## Exit codes

0 rendered (QA flags, if any, are in `review.json`); 1 bad brief or crash;
2 blocked by a rule before or during composition (nothing written).
