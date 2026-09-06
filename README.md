# content-machine

The content operation: two faceless carousel accounts, one pipeline, one brain
per brand. Fresh start — supersedes the old MoneyMedia repo.

## Structure

- `brands/pacevector/` — PaceVector (@pacevector): running. Brain files + `design/` (synced from Claude Design).
- `brands/moneyterms/` — MoneyTerms (@themoneyterms): money/economics. Fresh start, to be added.
- `pipeline/` — the shared machinery (to be built): content engine, renderer, QA, publishing glue. One codebase, parameterised by brand folder — adding an account means adding a folder, never touching pipeline code.

## Principles

1. The brain is plain files in git. Readable, diffable, reviewable.
2. Every number a post shows traces to a source, or the deck blocks.
3. Nothing publishes without approval; the machine proposes, a human posts.
