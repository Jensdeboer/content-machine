# Cover grammar

The cover is the product. Everything else in this system exists so that the cover gets a chance.

## GROUND
Strict alternation. White #FFFFFF or Vector Navy #062B49, flipping every post, so the profile grid is a checkerboard. ground-deep is allowed on any navy-ground cover and counts as navy for the alternation.

## SUBJECT MIX
Per rolling twenty posts: 14 cutout runner full figure; 3 cutout detail (legs, hands, shoes) large and bleeding off an edge; 2 typography-led with no photograph; 1 conceptual, built from the pace-line and data language.

## PHOTOGRAPHY
Black and white cutout, no background, overlapping the headline — in front of some letters and behind others so type and figure read as one object. Motion, or a resting pose with tension. Never a face-forward portrait, never a group, never colour.
Cutouts composite normally. No blend modes on figure images, ever.
Cutouts are hard-edged: no mask, fade or opacity ramp on a figure image, ever. A figure meeting the canvas edge is clipped cleanly by the canvas — a deliberate bleed — never dissolved. Where the source crop slices a limb, that sliced edge sits on or beyond the canvas edge, never inside it. A cutout is never scaled beyond its native pixel size (width × height in 00-assets/cutouts/cutouts.json).

## OCCLUSION
A word may sit behind the figure only if it stays unambiguous at 120px. The final word of a headline is never occluded. A word may lose part of its middle, never its first or last letters. Fix order: re-break the headline lines around the figure; nudge or scale the figure within its declared type-space; move the occluded line fully in front of the figure.

## HEADLINE MODES
Every cover is exactly one of three.
- **Shout**: one or two words, uppercase, Sora 800, tracking -0.12em, one or two lines. Size is the largest step at which the longest word fits the 888px type box; shout type never bleeds the box. Measured fit governs. Character counts are approximate only: roughly 4 characters or fewer → hero 400; 5–7 → xl 300; 8+ → two lines at xl 300. Precedent, measured in the browser in Sora 800 at −0.12em: wide capitals (W, O, D, G, Z) push SHOW (1163), DROP (1028), LAND (1016), GREY (937) and ZONE (994) past 888 at hero, so they take xl; HARDER measures 1115 at xl, so it takes l 200. Never rewrite copy to fit a size — resize to fit the copy.
- **Sentence**: five to nine words, sentence case, Sora 700 at m.
- **Number**: a single figure, Sora 800, tracking -0.08em, with a mono kicker. 1–2 digits → monument 640; 3 digits → hero 400; 4+ → xl 300.

## ASIDE
Any headline mode may carry one optional aside line under the headline: IBM Plex Sans 300 italic at lead 44, one line only.

## SIGNAL
#D8FF47, at most one element per cover, covers only. On navy it may be type, a chip or a mark on the pace-line. On white it may ONLY be a fill block with black type on it — never signal-coloured type on white. About one cover in three carries it; the rest carry none.

## KICKER
Optional. Use it when the headline needs a frame (a bare number, a shout word) or the cover would otherwise read empty; leave it off when the sentence stands alone. IBM Plex Mono 500, uppercase, 0.1em tracking, six words maximum. Separator is · never an em dash. Always a signal chip (black type on #D8FF47, 12/24 padding) and it counts as the cover's one signal element. It sits on the headline's left edge, directly above or below the headline block, never in a corner and never as a page title.

## CHROME
The P mark, small, one corner. No handle, no progress bar, no swipe cue, no chevrons.

## ROTATION
No headline mode three posts running. No cutout position repeated within five posts.

## NEGATIVE LIST
No colour photography. No gradients except ground-deep. No second signal element. No smiling stock poses. No recognisable professional athletes. No emoji. No exclamation marks. No em dash in a kicker. Nothing under the 24px token floor (`size.floor` in tokens.json); the kicker at the 26px label step is legal.

Visible apparel logos are permitted. Cutouts carry a `logos` flag in cutouts.json so a cover can avoid one where it would distract, but a logo is never a reason to reject a figure.

## STOP TEST
One point each, pass at 4.
1. Readable as a 120px thumbnail.
2. One idea only.
3. The figure has motion or tension, or on type-led covers the type does.
4. Signal used exactly once or deliberately not at all.
5. The headline opens a gap the deck closes.
