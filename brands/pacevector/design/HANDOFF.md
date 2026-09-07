# HANDOFF — v0.6 → v0.7

For the renderer that reads `01-tokens/tokens.json` by role name and uses `04-slides` and `03-covers` as templates. Written 7 September 2026.

Scope of this version: chrome stripped from slides, CTA rebuilt, cover kicker made optional and re-placed, deck point numbering made sequential. **No token was added, removed, renamed or revalued.** Every breaking item below is a template or rule change, not a token change.

`../deck-rules.md` is outside this folder and was not readable from here. Rule impact is checked against `03-covers/cover-grammar.md` and against the rule list you gave; re-check the deck-rules side yourself where marked.

---

## BREAKING — renderer must change code

### Tokens
- Added: none.
- Removed: none.
- Renamed: none.
- `$meta.version` in `tokens.json`: `"0.5"` → `"0.7"`. If the renderer pins or asserts the version string, update it. (0.6 was never written into the file; the CHANGELOG went to 0.6 without bumping meta.)

### Size scale
- No step added or removed. Thirteen steps, `monument 640 … floor 24`, unchanged.

### Components (`04-slides`)
- Renamed: none. Removed: none. Added: none. Eleven files, same names.
- **Slot removed on every slide component (all 11):** the header row — `series-title` (top-left, mono label 26) and `page-counter` (top-right, `NN / 07`). The row's DOM node is gone, not hidden. The content block now starts at the safe-area top (`margin` 96) and vertically centres between it and the footer band. If the renderer's per-slide template writes `{{series}}` / `{{index}}/{{count}}`, remove both bindings and the row.
- **`cta` slots removed:** `ask` (one or two lines, body-lg, on-accent, bottom-left) and `handle` (`@PACEVECTOR`, label 26, bottom-right). The bottom flex row that held them is gone.
- **`cta` slot added:** `actions` — a fixed, non-templated row of three stroke icons (like, save, send) under the tagline, inside the centred stack. Spec: 24-unit viewBox, rendered 64 × 64 slide-px, `stroke-width 2.4`, `stroke-linecap round`, `stroke-linejoin round`, `fill none`, colour `on-accent`, row gap `space-40`. Paths (viewBox 0 0 24 24):
  - like: `M12 20.5s-7.5-4.6-7.5-10A4.2 4.2 0 0 1 12 8a4.2 4.2 0 0 1 7.5 2.5c0 5.4-7.5 10-7.5 10z`
  - save: `M6 3.5h12v17l-6-4-6 4z`
  - send: `M21 3 3 10.5l7.5 2.5L13 21z` and `M21 3 10.5 13`
- **`cta` is now constant across carousels.** Nothing on it takes deck input.

### Cover template (`03-covers`)
- **Kicker slot moved and made optional.** Old: mandatory, absolute at `(margin, margin)` top-left, mute or mute-inv type, or a signal chip. New: optional; when present it is *always* a signal chip (black type on `signal`, padding `space-12 space-24`, label 26, track-label) anchored at `left: margin` and a `top` chosen per cover so it sits directly above or below the headline block, never in a corner. The renderer needs a per-cover `kicker-top` value (or a rule: headline-top − chip-height − gap, or headline-bottom + gap) instead of a constant.
- Deck covers as placed: PV-01 none · PV-02 none · PV-03 chip at top 920 (under the 32) · PV-04 chip at top 860 (under DROP, left of the sole) · PV-05 none.

### Deck assembly (`06-decks`)
- **New step: sequential point numbering.** Slides 2–6 carry one point number each, `01`–`05` in slide order. The stat eyebrow (`NN · LABEL`) and the numeral-point figure (`NN`) draw from the *same* counter. Unlabelled components (explainer, progress-scale, takeaway states) may carry an eyebrow to keep the run complete (PV-01 does). Previously the eyebrow and the numeral each restarted at 01.
- **Rule relaxed: slide 2 is no longer always `stat`.** PV-02 and PV-04 open numeral-point → stat. Any `04-slides` component may sit at 2; the only fixed positions are 1 = cover, 7 = cta.
- Slide `data-*`/caption labels in the deck files (`02 · STAT`, `03 · NUMERAL-POINT` …) were re-sequenced to match.

### Canvas
- No change. 1080 × 1350, margin 96, safe 888 × 1158 at (96, 96), footer band 96.

---

## NON-BREAKING — same names, new values

### Tokens
- None. Every role in `color`, `type`, `size`, `space`, `canvas` has the same value as v0.6.

### Components, internal layout only
- `stat`, `numeral-point`, `explainer`, `checklist`, `compare`, `chart`, `metrics-table`, `progress-scale`, `pull-statement`, `figure-panel`: content block now centres on the full height between the safe-area top and the footer band (the removed header row had taken ~32 px). Visual shift of the content block ≈ 16 px upward. Footer band unchanged (mark 44 left, `SWIPE →` right).
- `cta`: centred stack is mark 240 → wordmark (s 96) → tagline (body 30, track-wide) → icon row, gaps `space-56` / `space-16` / `space-56`. Footer band now empty.
- PV-03 cover: pace-line tick at x 672 changed from `signal` to `on-accent` (the chip took the one signal slot).

---

## RULE IMPACT

- **24 px floor** — untouched. Smallest new element is the 26 px chip type; icons are 64.
- **26 px kicker** — size unchanged (`size.label` 26). Where it appears changed: the *slide* kicker (series title) is removed entirely; the *cover* kicker is optional and chip-only, positioned against the headline. The slide eyebrow (`NN · LABEL`, label 26, mute) remains and is now the sequential point marker.
- **One accent per slide** — untouched. CTA icons are `on-accent` on the `accent` ground; no second accent introduced. Check deck-rules: if it forbids iconography on slides, the CTA icon row contradicts it (see CONTRADICTIONS).
- **Signal at most once** — enforced more tightly: when a kicker chip is present it *is* the signal element and nothing else on that cover may be signal (PV-03 tick re-coloured accordingly). Frequency guidance stays "about one cover in three". Signal still never appears on slides 2–7.
- **Cover carries no chrome** — the P mark remains top-right on every cover (grammar CHROME line allows it). No handle, progress bar, swipe cue or chevron. The corner kicker is gone, which brings the cover closer to this rule. If deck-rules defines "chrome" to include the mark, that is a pre-existing contradiction, not introduced here.
- **Ground alternation** — untouched. Deck covers still run navy / white / navy / white / navy (`ground-navy`, `ground`, `ground-navy`, `ground`, `ground-navy`). Roles unchanged.
- **888 × 1158 safe area** — untouched. Chips sit at `left: margin`; icon row is inside the centred stack.
- **Headline vs cutout** — occlusion rule, native-size rule, final-word rule all untouched. New constraint: the kicker chip may not sit on a cutout; on PV-04 it is placed left of the sole (chip ends well before x 480 where the figure starts).

---

## CONTRADICTIONS — not resolved, decide

1. **Library covers still carry corner kickers.**
   `03-covers/cover-grammar.md` (v0.7) KICKER: "It sits on the headline's left edge, directly above or below the headline block, never in a corner and never as a page title."
   `03-covers/library.dc.html`, `cover-full-figure.dc.html`, `cover-detail.dc.html`, `cover-type-led.dc.html`, `cover-concept.dc.html`: all 24 library covers and the four layout files still place the kicker `position:absolute; top:var(--pv-margin); left:var(--pv-margin)` as mute / mute-inv type, and library 23 still carries a signal tick *and* a signal-less kicker.
   The instruction to remove the corner title was given for the decks. The library was not touched to avoid re-placing 24 covers unasked. **I think the library is now the file that is wrong** and should be brought to the v0.7 grammar (kicker removed or re-placed as a chip, one cover in three) before the renderer treats it as template truth.

2. **Cover chrome.**
   Your rule list: "cover carries no chrome."
   `cover-grammar.md` CHROME: "The P mark, small, one corner. No handle, no progress bar, no swipe cue, no chevrons."
   Every cover carries the mark. Pre-existing; if deck-rules.md means "no chrome at all", **deck-rules.md and cover-grammar.md disagree and I think cover-grammar.md is right** (the mark is the only identifier left on the cover now that the kicker is optional).

3. **CTA icon row vs. any no-iconography rule.**
   New `cta` has three UI icons. `cover-grammar.md` NEGATIVE LIST bans emoji, chevrons and swipe cues on covers; nothing in this folder bans icons on slide 7. If deck-rules.md says slides carry no icons other than the mark, the new CTA contradicts it. **I think the CTA is right** (a wordless call to action was the brief) and deck-rules should gain an exception for slide 7.

4. **Kicker presence vs. signal frequency.**
   `cover-grammar.md` KICKER: "Optional … Always a signal chip … counts as the cover's one signal element."
   `cover-grammar.md` SIGNAL: "About one cover in three carries it; the rest carry none."
   These are consistent only if kickers appear on at most one cover in three. That is a rotation constraint the renderer/orchestrator must enforce, and it is not stated as such in the ROTATION section. Recommend adding "No kicker chip two posts running" to ROTATION.

5. **v0.5 CHANGELOG statement.**
   CHANGELOG v0.5: "Slide 1 reuses a library cover, slide 2 is a stand-alone stat, slide 7 is `cta`."
   v0.7 decks: PV-02 and PV-04 open with numeral-point.
   Historical entry, left as written; the v0.7 entry and README supersede it.

---

## Files touched in v0.7

- `01-tokens/tokens.json` (meta version only), `01-tokens/tokens.css` (header comment only)
- `03-covers/cover-grammar.md` (SIGNAL, KICKER, STOP TEST 4)
- `04-slides/*.dc.html` (all 11: header row removed; `cta` rebuilt)
- `06-decks/PV-01…PV-05.dc.html`
- `README.md`, `CHANGELOG.md`, `design/HANDOFF.md`

Not touched: `00-assets`, `02-foundations`, `03-covers/library.dc.html` and layout files, `05-chrome`, `07-profile`, `08-source-photos`.
