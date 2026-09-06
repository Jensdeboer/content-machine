# brands/pacevector/

The brain for PaceVector (@pacevector). Every pipeline stage reads these files;
nothing about the brand is hard-coded anywhere else. The visual half lives in
design/ (synced from the Claude Design project) — this folder is the editorial
half.

## Rules for this folder

1. Plain markdown and JSON only. Readable, diffable, reviewable.
2. Nothing writes here unattended except memory/posted.jsonl and
   memory/rejected.md. Everything else changes by hand or by a PR you merge.
3. The weekly rewrite may propose changes to memory/winners.md, series.md
   weights and growth.md — never to voice.md, banned.md or positioning.md.
   Those are yours.

## posted.jsonl format

One line per post, appended by the verify step:

{"deck":"PV-012","date":"2026-09-20","series":"science","cover_type":"full-figure","cover_ground":"navy","cutout":"cut-007","headline_mode":"number","signal":true,"ig_url":"...","tt_url":"..."}

The nightly run reads this for: ground alternation (last post's ground),
series rotation, the rolling-20 cover mix, cutout rotation, and 60-day
topic dedup.
