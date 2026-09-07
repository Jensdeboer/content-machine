v0.7 slide chrome stripped, CTA icon row, optional cover kicker — 7 September 2026

- Slides: the header row (series title top-left, `NN / 07` counter top-right) is removed from every `04-slides` component and every deck slide. The slide now runs safe-area top → content → footer band (mark left, SWIPE right). Sanctioned unlock of `04-slides` for this change only; the folder is locked again.
- CTA: ask line and `@PACEVECTOR` handle removed. A like / save / send icon row (three 24-grid stroke icons at 64, stroke 2.4, on-accent, gap 40) sits under MOVE WITH PURPOSE inside the centred stack. The footer band on this slide is now empty; the stack centres on the full safe height. Nothing on the CTA changes between carousels.
- Covers: the corner kicker is gone. The kicker is now optional and, when used, is a signal chip placed on the headline's left edge directly above or below the headline block. It counts as the cover's one signal element. Deck covers PV-03 (under the 32; the pace-line tick goes on-accent) and PV-04 (under DROP) carry it; PV-01, PV-02, PV-05 carry none.
- Decks: slides 2–6 carry one sequential point number each (01–05). The stat eyebrow and the numeral-point figure share the one counter. PV-01 gained eyebrows on its explainer and progress-scale slides so the run is complete. Slides 2 and 3 swapped in PV-02 and PV-04 so not every deck opens stat → numeral.
- Tokens: no value, name or step changed. `$meta.version` corrected from 0.5 to 0.7 (it had not been bumped at 0.6); `tokens.css` regenerated, byte-identical apart from the header comment.
- Handoff notes for the renderer in `design/HANDOFF.md`.

v0.6 mark C, true cutout set — 7 September 2026

- Mark: two-tone variant C adopted. Stem in mute (#5C6670 on white and accent grounds, mute-inv #9AA7B4 on navy), arrow in the mark's solid colour. Applied to `logo.svg`, footer, avatar, every cover in `03-covers`, all deck slides, the profile grid and the brand board (167 instances). Exploration kept at `05-chrome/logo-variants.dc.html`.
- Cutouts: the flattened keyed set is gone. Eighteen true alpha cutouts installed from removebg exports, black and white baked in with the house recipe, cropped to the alpha box; CSS filters removed from every figure image. fig-runner-side and fig-runner-bottle removed without replacement (figure-panel and brand board now use fig-runner-low). Manifest rewritten with real sizes and grammar flags: medal-bite and runner-smiling excluded; sole-forward, portrait-visor, towel, cap-bottle and vintage-runner recorded as user-approved with their caveats.
- Covers re-placed at native size and checked against the occlusion rule: full-figure 01 (sprinter mirrored, running into UP.), 02 (headline dropped to sit above the small seated figure), 04 (tying figure lowered so NOW. is clear), 06 (bent-over at 0.73×, below the 42); detail 01 (LAND SOFT raised, kick bottom right), 02 (headline top, plate bottom right), 04 (HEEL DROP top, sole below), 05 (headline top, runner-low bottom right), 06 (seated-reach at 0.8×, below the 180). Library, deck covers and profile grid follow. All 29 covers now pass: no final word occluded, no first or last letter lost.
- Housekeeping: old flattened renders removed from `uploads/`; only the alpha exports remain.

v0.5.3 true cutouts, first batch — 6 September 2026

- Cutouts: fig-medal-bite (1200×1307), fig-shoe-shoulder (625×658) and fig-stretch-seated (1145×1389) replaced with real alpha PNGs, black and white baked in. Full-figure 05 and detail 02 re-placed at native size, both bottom-anchored so the source crop edges sit on the canvas edge; detail 03 (500) re-placed with the head clear of the numeral. fig-sprint-start alpha file received but the figure is 481×521, too small for the SHOW UP. cover at 1000 px — old keyed file kept, needs a larger export.
- Cutouts: fig-quad-stretch replaced with a real alpha PNG (645×828, up from 608×706), black and white baked in with the house recipe so it carries no CSS filter. Full-figure 03 (80) re-placed at native size, bottom-anchored. The brand board still shows the old placement (own file, unlocked reference only). Remaining 8 on the retouch list unchanged.

v0.5.2 artboard and compositing audit — 6 September 2026

- Artboards: DOM audit of all 24 library covers, the 5 deck covers and the profile grid — every cover canvas is `position:relative; overflow:hidden` inside an `overflow:hidden` frame, every absolutely positioned child resolves to its own canvas, no two artboards overlap, and every neighbour is separated by a flex or grid gap. No cover was contaminated in the DOM; the letters seen bleeding into the 80 cover came from the screenshot capture, not the markup. Deck slide canvases (slides 2–7) lacked `position:relative; overflow:hidden` and now have it.
- Compositing: no blend mode exists on any figure image in the project (covers, decks, figure-panel, brand board). All 14 cutouts are true transparent PNGs. Grammar line added: cutouts composite normally, no blend modes ever.

v0.5.1 cover QA — 6 September 2026

- Cutouts: no CSS mask or fade existed in any cover; the dissolve was in the assets. The source key had eaten white apparel (shoes, socks, shirts) into ragged holes and left stray fragments, which read as a fade on navy. All 14 cutouts rebuilt from `uploads/` with hard alpha (see `cutouts.json` processing note). Four still need manual retouch: fig-bent-over, fig-shoe-shoulder, fig-seated-reach, fig-sole-stretch.
- Grammar: occlusion rule added (final word never occluded; first and last letters never lost; fix order re-break → nudge/scale → move line in front). Hard-edge, slice-on-canvas-edge and no-upscaling rules added to PHOTOGRAPHY. Kicker separator is ·, em dash banned.
- Covers fixed at native scale: full-figure 01 (SHOW UP., sprinter dropped below SHOW, W no longer occluded), 02 (Your easy pace…, figure 1.42× → 1.0×, bottom-anchored, head under the middle of "enough."), 03 (80, figure 1.35× → 1.0×, numeral raised clear), 04 (GO NOW., figure 1.28× → 1.0×, NOW. lowered to sit in front of the cap). Deck cover PV-01 and the profile grid follow.
- Kickers: em dash → · on 17 library covers and on all deck slide kickers. `04-slides` component samples still show the em dash (locked; needs a sanctioned unlock).
- Held, not fixed: full-figure 05 and all six detail covers use cutouts scaled 1.4–3.5× above native, or whose sliced crop edges cannot reach the canvas edge at 1.0× (fig-sole-stretch needs 1.06×, fig-seated-reach 1.36×). None of the 14 cutouts is large enough for a detail cover at native size.

v0.5 cover grammar amendments — 6 September 2026

- Colour: added `mute-inv` (#9AA7B4) for kickers on navy grounds. Every plain navy kicker in `03-covers` moves from `on-accent` to `mute-inv`; chips and signal-type kickers are unchanged. Sanctioned unlock of `02-foundations/palette.dc.html` to add the thirteenth swatch; the folder is locked again.
- Grammar: the character-count sizing guide is approximate; measured fit governs and shout type never bleeds the 888px box.
- Grammar: shout sizing by fit (guide 4 or fewer → hero, 5–7 → xl, 8+ → two lines at xl; measured fit governs), number sizing by digit count (1–2 → monument, 3 → hero, 4+ → xl), ground-deep allowed on any navy cover and counted as navy, optional one-line aside in any mode, kicker colour per ground.
- Covers: REST MORE. restored to REST HARDER (l 200, HARDER measures 1115 at xl); THE FADE and RUN EASY resized to hero; detail 03 restored to 500 and detail 06 to 180, both at hero. Library tiles updated to match.

- Decks: `06-decks/` added, five seven-slide carousels (PV-01 to PV-05). Slide 1 reuses a library cover, slide 2 is a stand-alone stat, slide 7 is `cta`. No component was invented; every slide is an instance of `04-slides` or a `03-covers` library cover. No compromise was needed: the alternation held with library covers 09, 16, 23, 02, 15, and every component stayed within its shown caps (three checklist items, two compare or metrics cells, one aside).
- Profile: `07-profile/` added, `avatar.dc.html` (mark at 320 and 40) and `grid.dc.html` (nine posts, checkerboard holding).

v0.4 xl 250 to 300 — 5 September 2026

- Size: the `xl` step changes from 250 to 300. Its job is shout-mode cover headlines and the stat hero number. 250 is retired; everything on it is remapped to 300.
- Locked as of 5 September 2026: `01-tokens`, `02-foundations`, `04-slides`, `05-chrome`. Changes to these folders need an explicit instruction.

v0.3 corrections applied

- Colour: added `signal` (#D8FF47, covers only, at most one element per cover, never on a slide). Added `ground-navy` (flat) and `ground-deep` (two-stop navy radial, stored with both stop values and stop positions). Kept `accent`, `accent-ink` and `on-accent` as separate roles.
- Canvas: safe zone corrected to the board's 96 margin on all four sides, giving 888 x 1158 at 96,96, with a note that the safe zone governs type only and that cutouts and full-bleed photography may cross it.
- Footer: zone set to 96, aligned to the margin, mark centred on it. The 120 value is removed.
- Spacing: unit changed from 8 to 4 and the scale rebuilt as 4 to 120. On the board, 14 became 16, 18 became 20 and 22 became 24; every other board spacing value is unchanged.
- Size: the 35-step scale is replaced by thirteen named steps (monument, hero, xl, l, m, s, title, subtitle, lead, body-lg, body, label, floor). Retired values are remapped to the nearest step.
- Slides: the invented figure-panel frames are removed from `explainer`, `numeral-point`, `pull-statement`, `checklist`, `compare`, `stat`, `chart`, `metrics-table`, `progress-scale` and `cta`. Each now shows a short state, a long state and one third state that suits the component. Only `cover` and `figure-panel` carry images.
- Assets: `assets/` moved to `00-assets/cutouts/`, and `00-assets/exports/` added. Recorded in README.md.

v0.2 restructured from brand system board

- Extracted colour, type, size, spacing and canvas values into `01-tokens/tokens.json` with a `source` field carrying the board's original colour names.
- Generated `01-tokens/tokens.css` from the json.
- Rebuilt the colour, typography and anatomy pages as `02-foundations/palette.dc.html`, `type.dc.html`, `grid.dc.html`, referencing tokens only.
- Split the slide components from the anatomy and the five example carousels into `04-slides/`, twelve files, each in three states.
- Extracted the mark and the slide footer into `05-chrome/logo.svg` and `05-chrome/footer.dc.html`.
- No visual decision changed. Ambiguities were recorded as questions in the handover checklist rather than resolved.
