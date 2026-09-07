# Deck rules

Canvas and components come from design/ (tokens, 11 slide components).
These rules are what the pipeline enforces when assembling a deck.

## Structure

- 5 or 7 slides, exported 2160x2700 JPEG
- Slide 1: a cover from the library, chosen by the cover rules below
- Middle: components from design/04-slides/, at most one of the same
  component twice in a row. Any component may open at slide 2; only
  slide 1 (cover) and the last slide (cta) are fixed positions.
- Last slide: cta component — one line of source credit in the footer
  band; the three fixed CTA icons, no ask or handle
- Chrome: on the cover, the P mark only, small, one corner — no handle,
  no progress bar, no swipe cue, no chevrons. Icons are otherwise banned
  everywhere in the deck; the three CTA icons on the last slide are the
  sole exception.
- Footer on every slide except the cover

## Cover rules (enforced from posted.jsonl)

- Ground: strict alternation, white/navy; ground-deep counts as navy
- Mix per rolling 20 posts: 14 full-figure / 3 detail / 2 type-led /
  1 conceptual
- Headline mode: shout, sentence or number — never the same mode three
  posts running
- Sizing steps down to fit the copy, measured against the real font;
  the 888px type box governs. Copy is never rewritten to fit a size.
- Occlusion: a word may sit behind the figure only if it stays unambiguous
  at 120px; the final word of a headline is never occluded; a word may lose
  part of its middle, never its first or last letters
- No masks, fades or opacity ramps on cutouts — hard edges; a figure meeting
  the canvas edge is clipped by the canvas, never dissolved
- Signal (#D8FF47): at most one element, roughly one cover in three, never
  on slides. On white only as a fill block with black type. A cover kicker
  is always a signal chip and, when present, is that one element — no
  other signal on the same cover. No kicker chip two posts running, and
  at most 7 chips per rolling 20.
- Cutout: chosen from design/00-assets/cutouts/cutouts.json by matching
  energy and direction to the copy, headline placed in the declared
  type-space, no cutout repeated within 5 posts, never on an excluded ground
- Stop test >=4/5 or regenerate, max 3 tries, then blocked

## Quality gate

Every on-slide figure has a source row. Caption lint per banned.md.
Perceptual-hash check against the last 90 days of covers.
