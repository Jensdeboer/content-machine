# PaceVector design source

Code-rendered source for the PaceVector visual identity. Every file here is derived from the finished brand system board (`PaceVector Brand System.dc.html`); no visual decision is made in this folder.

## Rules

1. Every colour, size, face and spacing value is defined once, by role name, in `01-tokens/tokens.json`. All other files reference roles. No hex codes anywhere except `tokens.json`.
2. One component per file, kebab-case, no numbers in file names. Folders are numbered; files are not.
3. Create only what a prompt asks for. Nothing else.
4. Every prompt ends with a checklist of exactly what was created, path by path, and what could not be done.

## Structure

- `00-assets/cutouts/` — black-and-white cutout figures used by the cover and figure-panel components.
- `00-assets/exports/` — rendered output. Empty in source control.
- `01-tokens/` — `tokens.json` (source of truth) and `tokens.css` (generated).
- `02-foundations/` — `palette.dc.html`, `type.dc.html`, `grid.dc.html`.
- `03-covers/` — cover grammar, four layout files, the 24-cover library and the board's example exports.
- `04-slides/` — one file per slide component. Each shows a short state, a long state, and one third state that makes sense for that component. Only `cover` and `figure-panel` carry images.
- `05-chrome/` — `footer.dc.html`, `logo.svg` (two-tone mark C: mute stem, solid arrow), `logo-variants.dc.html`.
- `06-decks/` — five seven-slide carousels, one per series, built only from `04-slides` components and `03-covers` library covers.
- `07-profile/` — `avatar.dc.html`, `grid.dc.html`.

## Status

`01-tokens`, `02-foundations`, `04-slides` and `05-chrome` are locked as of 5 September 2026. Changes to them need an explicit instruction.

## Export

Export via `/design-sync` to `brands/pacevector/design/`.
