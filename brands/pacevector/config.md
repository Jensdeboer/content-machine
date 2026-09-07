# brands/pacevector/config.md

Operating settings. The pipeline reads these; nothing here is a judgement call
at runtime. Changed by hand, never by the weekly rewrite.

## Cadence

- One post a day.
- Slot: **15:00 Europe/Amsterdam**. Chosen to catch the US morning and the
  European evening in one shot; revisit after four weeks of saves data.
- Cross-posted: Instagram first, TikTok a few minutes later. Never the same
  minute.

## Publishing

- Both platforms posted **in-app**, from the Telegram packet. Save the slides
  to the camera roll, upload, paste the caption, add the sound, post.
- The provider can also post to TikTok **directly**. Not used by default: a
  photo post requires a sound, and a direct post gets whatever TikTok assigns,
  which is never a trending one. Draft mode costs 90 seconds and buys the
  sound. Direct posting is the fallback for a day away, and becomes the
  default if the sound experiment shows music does not move saves.
- **Provider: Upload-Post, paid.** It pushes photos into the TikTok drafts,
  verifies both posts landed, and pulls metrics nightly. It is not there for
  convenience: manual metrics entry is the one daily chore with no immediate
  payoff, and if it gets skipped the Sunday rewrite has nothing to learn from.
  The provider removes that dependency on discipline.
- Instagram: **professional account, Creator type.** Both Creator and Business
  are "professional"; Business is restricted to the commercial music library
  and loses trending songs. Creator keeps them.
- TikTok: a normal account. Nothing to connect.

## Provider

Upload-Post. One profile covers both platforms; `platform[]` selects which.

Three strings, all similar, none interchangeable:

| Where | Exact value |
|---|---|
| Instagram handle | `@pacevector` |
| TikTok handle | `@pacevector` |
| Provider `user` parameter | `Pacevector` |

- The provider profile is **`Pacevector`** - capital P, lowercase v, case
  sensitive. It is not the handle and not the brand's own casing (PaceVector).
  Passing either of those fails.
- Auth header: `Authorization: Apikey <UPLOADPOST_KEY>` (key in `.env` on the
  box, never in this repo).
- Photo endpoint: `POST https://api.upload-post.com/api/upload_photos`
- Fields: `user`, `title`, `platform[]`, `photos[]` (one per slide, in order).

Example, as observed:

    curl -H 'Authorization: Apikey $UPLOADPOST_KEY' \
      -F 'user="Pacevector"' \
      -F 'title="..."' \
      -F 'platform[]=tiktok' \
      -F 'photos[]=@out/PV-014/01.jpg' \
      -X POST https://api.upload-post.com/api/upload_photos

The pipeline calls this for TikTok drafts only. It never calls a direct-post
endpoint - see Publishing above.

## Captions

- Instagram: clean. Hook line first, no hashtags, no search padding.
- TikTok: **2-3 plain search phrases allowed** in the first line, woven in
  naturally - "easy run pace", "marathon taper", "how to start running".
  Not hashtags; phrases people actually type into search.
- Both: the ban list in banned.md applies without exception.

## Disclaimer

- **Bio only.** One plain line covering the account; captions stay clean.
- Suggested wording: "Training information, not medical advice. Pain means
  see a physio."
- If a deck ever needs its own line, that is a signal the deck is too close to
  the medical line in banned.md - rewrite the deck, don't add a disclaimer.

## Comments

- No comment push, no drafted replies, nothing automated. Revisit when a post
  gets more than ten comments (see ROADMAP).
- Replying by hand in the first hour is still the single cheapest reach lever;
  the absence of tooling is not a reason to skip it.

## Cover production

- Covers are **rendered by the pipeline in code** - HTML and CSS from the
  tokens, screenshotted at 2160x2700. Deterministic: same brief in, same cover
  out. No image model is involved in a daily run.
- Figures come from the existing 16 cutouts in `design/00-assets/cutouts/`,
  chosen by the manifest (energy, direction, type-space) under the rotation
  rule. Sixteen sustains one post a day.
- New cutouts are an occasional batch job - stock photography through the
  house recipe (rembg, greyscale, autocontrast) - not part of the nightly run.
- Image generation is out of the daily loop entirely. It returns only if the
  library runs dry on a specific pose, or when video starts.

## Budget

- No per-run image credits, because no images are generated per run.
- Running cost is the VPS, the publishing provider, and nothing else.
  Claude and Claude Design are covered by the Max plan.

## Kill switch

- `publishing_enabled` - one row, flippable from the review page. Off means no
  packets and no inbox pushes until flipped back.

## Models

Read by `pipeline/models.js`. Change a value here, not in code. Stages resolve
an alias, so swapping a model for every stage that uses it is one word.

| Stage | Model |
|---|---|
| scan | sonnet |
| pick | sonnet |
| verify | strong |
| write | strong |
| render | none |
| qa | none |

| Alias | Model id |
|---|---|
| sonnet | claude-sonnet-5 |
| strong | claude-opus-5 |

- **Backend: the Claude Code CLI**, `claude -p --output-format json --model <id>`,
  run as a subprocess against the box's existing Max-plan login. No API key and
  no per-token bill: adding a brand costs a folder, not money.
- `MODELS_BACKEND=stub` in `.env` swaps in `pipeline/fixtures/` so a whole run
  can be exercised offline. Anything else, or unset, means the CLI.
- `callModel({stage, prompt, schema})` in `pipeline/models.js` is the only way
  a stage may reach a model. No stage shells out or imports an SDK itself.
- Timeout per call: 300 seconds. One retry on timeout or a non-zero exit; one
  retry on a JSON parse failure, with the parse error fed back to the model.
  Failing twice fails the stage, and the deck parks as needs_attention. Half
  parsed output is never returned to a caller.
- Verify may use web search: yes. The verify stage runs with WebSearch and
  WebFetch allowed so a figure can be traced to a real url; every other stage
  runs with no tools.

## Run settings

Read by `pipeline/run.js`.

- Deck key prefix: PV
- Ideas per run: 5
- Scan score threshold: 4
- Scan seen window (days): 30
- Topic window (days): 60
- Feed timeout (seconds): 20
- Feed pause (seconds): 5
- Feed retry pause (seconds): 60
- Feed user agent: Mozilla/5.0 (compatible; content-machine/1.0)
- Max items per scan call: 40
- State database: pipeline/state.db
- Output directory: out

The scan threshold is the 1-5 score from `positioning.md`, on the same scale as
the cover stop test. Drop it to 3 for a looser night; that is a config change,
not a deploy. The screenshot test in `positioning.md` runs first and is a gate:
a no is out whatever it scored.

## Telegram

- Bot token: `TELEGRAM_BOT_TOKEN` in `.env` on the box, never in this repo.
- Chat id: `TELEGRAM_CHAT_ID`.
- Stage failures, dead feeds, drift between state.db and posted.jsonl, and the
  run summary all go here. With the variables unset the run still completes:
  messages go to stdout and are recorded on the run row.
