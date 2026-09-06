# Deck rules

Canvas and components come from design/ (tokens, 11 slide components).
These rules are what the pipeline enforces when assembling a deck.

## Structure

- 5 or 7 slides, exported 2160x2700 JPEG
- Slide 1: a cover from the library, chosen by the cover rules below
- Slide 2: second-cover duty — a stat or a question that stands alone,
  because Instagram re-serves slide 2 to people who did not swipe.
  Never a continuation of a sentence from slide 1.
- Middle: components from design/04-slides/, at most one of the same
  component twice in a row
- Last slide: cta component — one line of source credit, follow prompt
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
  on slides. On white only as a fill block with black type.
- Cutout: chosen from design/00-assets/cutouts/cutouts.json by matching
  energy and direction to the copy, headline placed in the declared
  type-space, no cutout repeated within 5 posts, never on an excluded ground
- Stop test >=4/5 or regenerate, max 3 tries, then blocked

## Quality gate

Every on-slide figure has a source row. Caption lint per banned.md.
Perceptual-hash check against the last 90 days of covers.
