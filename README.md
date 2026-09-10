# content-machine

An automated pipeline for producing and publishing carousel posts for social media accounts.

## What it does

Each night the pipeline:

1. **Scans** a set of configured feeds for content ideas
2. **Picks** the strongest ideas, avoiding topics covered recently
3. **Verifies** factual claims against primary sources
4. **Writes** slide copy and captions according to the brand's voice rules
5. **Renders** the deck as images using the brand's design system
6. **Checks** every slide for layout and readability problems

Finished decks wait for approval. Approved decks are pushed to the publishing platform as drafts, and the operator gets a preview to review from their phone.

## How it's organised

- `brands/<name>/` — everything specific to one account: positioning, voice, banned terms, source policy, design tokens and components. Human-authored. The pipeline reads these and never writes to them.
- `pipeline/` — the deterministic Node.js pipeline. Brand-agnostic; takes a brand name as an argument.
- `brands/<name>/memory/` — the pipeline's own records: what has been posted, what was rejected, and operator notes.

The split is deliberate. The "brain" (brand files) is editable by a person, the pipeline is fixed code, and the pipeline's state lives separately from both.

## Operation

Runs on a schedule via cron. The operator interacts entirely through a messaging bot — approving, rejecting, or annotating decks — and does not need to touch the server day to day.

## Requirements

Node 22+, Playwright with Chromium, SQLite (built in). Model calls go through the Claude Code CLI.
