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
- **Nothing posts unless it is approved.** The nightly renders decks and
  leaves them `pending`; `pipeline/packet.js` takes the oldest `approved` deck
  and nothing else. Approval is one word to the Telegram bot - `ok PV-07`,
  see Telegram below. A day with nothing approved is a quiet day, not a
  failure: the packet sends one line saying so and exits clean.
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
- Fields: `user`, `title`, `description`, `platform[]`, `post_mode`,
  `photos[]` (one per slide, in order).
- `post_mode` is **`MEDIA_UPLOAD`**, hardcoded in `pipeline/lib/provider.js`:
  the photos land in the TikTok inbox as a draft finished in-app, where the
  sound is added. The provider's default when the field is omitted is
  `DIRECT_POST`, which publishes at once; on 8 Sep 2026 a push without the
  field went live. It is not a setting and it is not read from this file:
  there is no situation in which the pipeline publishes directly, and the
  provider module refuses to build a request that says anything else.
- `description` is always sent and is the TikTok caption only. The provider
  reuses `title` for an omitted description, which put the headline on the
  post twice.

Example, as observed:

    curl -H 'Authorization: Apikey $UPLOADPOST_KEY' \
      -F 'user="Pacevector"' \
      -F 'title="..."' \
      -F 'platform[]=tiktok' \
      -F 'photos[]=@out/PV-014/01.jpg' \
      -X POST https://api.upload-post.com/api/upload_photos

The pipeline calls this for TikTok drafts only. It never calls a direct-post
endpoint - see Publishing above.

`title` is the draft's label in TikTok's draft list, nothing more; the packet
derives it from the deck's cover headline, cut to the limit at a word
boundary. `description` carries the TikTok caption into the draft. The
Instagram caption never goes through the provider.

Limits, as the provider documents them (docs.upload-post.com/api/upload-photo
and /api/photo-requirements, read 8 Sep 2026). `pipeline/lib/provider.js`
checks every field against these before the HTTP call, so a field over its
limit fails here with both numbers in the message, never as a 400 from the
provider.

- TikTok title limit: 90 characters
- TikTok description limit: 4000 characters, 30 mentions
- Photos per post: 35
- Photo size limit: 20 MB each
- Photo formats: jpg, jpeg, webp
- Photo resolution: 1080 px short side, 1920 px long side. Documented as a
  requirement, but the provider also documents auto-transcoding and no push
  has yet shown which applies to a 2160x2700 slide, so the packet warns on
  this one rather than blocks. Flip it to a block once a push proves the
  provider rejects oversize images.

## Captions

- Instagram: clean. Hook line first, no hashtags in the caption text, no
  search padding.
- `hashtags_enabled`: no. Off by default; flipped by hand for the growth.md
  experiment. When yes, the write stage produces 3-5 topical Instagram
  hashtags as a separate field and the run appends them as one final line
  under the caption, after a blank line. They are never woven into the
  caption, and TikTok stays plain search phrases either way.
- `send_line_enabled`: no. Off by default; flipped by hand for the growth.md
  experiment. When yes, the write stage produces one sentence in voice asking
  the reader to send the post to someone they run with, as a separate field,
  and the run appends it as a closing line under the Instagram caption after
  a blank line, before the hashtag block if that is on. One sentence, no
  exclamation mark, never woven into the caption. TikTok is untouched.
- TikTok: **2-3 plain search phrases allowed** in the first line, woven in
  naturally - "easy run pace", "marathon taper", "how to start running".
  Not hashtags; phrases people actually type into search.
- Both: the ban list in banned.md applies without exception to the caption
  text and to the words inside any hashtag.

## Disclaimer

- **Bio only.** One plain line covering the account; captions stay clean.
- Suggested wording: "Training information, not medical advice. Pain means
  see a physio."
- If a deck ever needs its own line, that is a signal the deck is too close to
  the medical line in banned.md - rewrite the deck, don't add a disclaimer.

## Verify tiers

Verify classifies every claim rather than gating on sources. Only FABRICATED
stops a deck.

| Tier | What it is | Source needed |
|---|---|---|
| figure-backed | a specific empirical number, primary source open access under a reusable licence, and a chart/plot/table in that paper about this claim | yes, plus the figure |
| sourced | a specific empirical number, one primary source, no usable figure or not open access | yes |
| common knowledge | no specific empirical number: qualitative claims, and prescriptive numbers that are coaching convention | no |
| fabricated | a specific empirical number with no source, or one that contradicts its cited source | blocks the deck |

- **One source is enough.** The two-source cross-check is retired.
- The test for common knowledge is what the number is DOING. Describing the
  world is empirical and owes a source ("runners drifted 7.7% over three
  hours"). Telling the reader what to do is prescription and owes none ("keep
  80% of it easy", "run 5-6 days a week", "no new shoes on race day").
- FIGURE-BACKED is checked, not asserted: `pipeline/lib/evidence.js` confirms
  open access, a reusable licence and a relevant figure against Europe PMC,
  and demotes to SOURCED when any of that fails.
- **The figure image is not fetched.** Every documented route is gated or dead
  from this box (reCAPTCHA on the NCBI bin path, 403/404 on the OA service,
  520 on europepmc.org). The claim records the pmcid, filename, label,
  caption, licence and a human-openable url; `imagePath` stays null. Nothing
  renders a figure yet, so nothing is lost — but the fetch has to be solved
  before the evidence-figure component ships.
- Instagram captions carry one closing line, "Source: Matomäki et al. 2023",
  for decks with sourced or figure-backed claims. TikTok is untouched.

## Notes

- `memory/notes.md` collects the free-text feedback sent with `note` and with
  `ok <text>`. One row per note: timestamp to the minute, deck key, topic slug,
  text.
- **The pipeline never reads it.** The nightly does not load it and does not
  behave differently because of anything in it. A single remark is an
  observation, not a rule, and a system that re-tunes on every comment chases
  noise. `pipeline/test/inbox.js` asserts structurally that no file in
  `pipeline/` outside the inbox references the file.
- It is an input to the weekly review (see ROADMAP), where notes are read
  against the metrics and a repeated observation may become doctrine — by
  editing voice.md, deck-rules.md, config.md or the design files by hand. A
  change to how decks are made comes from that review, never from a row
  landing in notes.md.

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
- Sixteen is the file count, not the pool a cover picks from. After the type,
  ground, note and face-forward filters the auto-selection pool is **8** for a
  full-figure cover and **2** for a detail cover. Eight is comfortable against
  the no-repeat-within-5 window; two is thin.
- **The 3-per-20 detail quota stays as it is.** With a pool of 2 and a 5-post
  no-repeat window, the same cutout may return every 6 posts, so alternating
  two of them supports a detail cover as often as every 3 posts — a ceiling of
  6 per 20. Three is well inside that; the quota is achievable and is not the
  thing to change. What two cutouts cannot give is *variety*: every detail
  cover will be one of the same two images. Raise the quota above 6 per 20
  only once more detail crops exist, and get 2-3 more cut for variety's sake
  well before then. Logged 9 Sep 2026.
- New cutouts are an occasional batch job - stock photography through the
  house recipe (rembg, greyscale, autocontrast) - not part of the nightly run.
- Image generation is out of the daily loop entirely. It returns only if the
  library runs dry on a specific pose, or when video starts.

## Budget

- No per-run image credits, because no images are generated per run.
- Running cost is the VPS, the publishing provider, and nothing else.
  Claude and Claude Design are covered by the Max plan.

## Kill switch

- `publishing_enabled`: yes. The switch is this key, flipped by hand. Off
  means no packets and no inbox pushes until it is flipped back;
  `pipeline/packet.js` reads it before it does anything else.

## Models

Read by `pipeline/models.js`. Change a value here, not in code. Stages resolve
an alias, so swapping a model for every stage that uses it is one word.

| Stage | Model |
|---|---|
| scan | sonnet |
| pick | sonnet |
| sourcecheck | sonnet |
| verify | strong |
| write | strong |
| tag | sonnet |
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
  WebFetch allowed so a figure can be traced to a real url.
- Tag may use web search: no. The `tag` stage in `pipeline/ingest-assets.js`
  describes an image it is given the path to and reads nothing else; it gets
  the Read tool and no network.
- Sourceability pre-check may use web search: yes. The pre-check inside PICK
  gets the same two tools for the same reason, and nothing else does.
- Every other stage runs with no tools.

The `sourcecheck` stage is the pre-check PICK runs before an idea is committed
(see Run settings, `sourceability_precheck`). It is a cheap look, one call for
all candidates, on the same alias as pick. It is not a second verify and its
answers are never carried into verify: it may only drop a candidate, never
mark one as sourced, so nothing it says can let a figure past verify that
verify would otherwise block.

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
- `queue_target`: 6. Decks to keep in hand, counting both `pending` and
  `approved` - an approved deck has not posted yet either. At the start of
  PICK the nightly counts them: below the target it picks only enough to top
  it back up (at most "Ideas per run"); at or above it, scan and pick run and
  the night stops there, and the summary says so.
- **Angle preference by series.** What kind of claim a series wants, so PICK
  stops reaching for a number where a number was never the point. Verify
  classifies claims either way (see Verify tiers below); this only steers what
  gets proposed.

  | Series | Angle preference |
  |---|---|
  | Running 101 | qualitative |
  | Mindset | qualitative |
  | Science | figure-backed |
  | Gear | none |
  | Mistakes | none |

  - `qualitative` — do not prefer ideas carrying numbers. These series teach a
    way of running, and a made-up-looking figure buys nothing: most of what
    they say is common knowledge in the tier sense and needs no source.
  - `figure-backed` — actively prefer ideas where tonight's scan already found
    a paper with a chart or table, so the deck can carry real evidence.
  - `none` — no steer either way; judge the idea on its own merits.

- `sourceability_precheck`: yes. Before an idea is committed to a brief, PICK
  asks once, for all candidates together, whether a primary-tier source
  plausibly exists for each central figure, and drops the ones that plainly
  have none. Sourcing was the largest single loss at verify, and verify runs
  after write, so a figure that dies there has already paid for a whole deck.
  This is a filter and only a filter: it drops candidates, it never supplies a
  source, and verify stays exactly as strict. An idea carrying no figures skips
  it entirely. Off means the night behaves as it did before.
- `pick_max`: 8. The most ideas one night may pick, whatever the arithmetic
  below asks for. A night where everything blocked would otherwise ask for a
  very large number off a single bad sample.
- `block_rate_runs`: 7. How many finished runs the block rate is measured over.
- Ideas per run is the number PICK asks for when the queue is already full.
  When the queue is short, the number is computed instead: the deficit divided
  by the recent survival rate (1 minus the block rate over `block_rate_runs`
  runs, read from state.db), rounded up and capped at `pick_max`. At a deficit
  of 3 and a 50% block rate that is 6 ideas, not 3, because half of them are
  expected not to survive verify and QA. The survival rate is floored so a
  night where everything blocked cannot divide by zero.
- `deck_max_age`: 14. Days. A pending deck older than this is marked stale
  and dropped before PICK, with a scope=figure row in memory/rejected.md so
  the topic itself can come back later. The summary names each one.
- State database: pipeline/state.db
- Output directory: out

The scan threshold is the 1-5 score from `positioning.md`, on the same scale as
the cover stop test. Drop it to 3 for a looser night; that is a config change,
not a deploy. The screenshot test in `positioning.md` runs first and is a gate:
a no is out whatever it scored.

## Telegram

- Bot token: `TELEGRAM_TOKEN` in `.env` on the box, never in this repo.
- Chat id: `TELEGRAM_CHAT`.
- Stage failures, dead feeds, drift between state.db and posted.jsonl, and the
  run summary all go here. With the variables unset the run still completes:
  messages go to stdout and are recorded on the run row.
- The morning summary carries one photo per pending deck: the cover, captioned
  with the deck key, series, headline and topic, then one line with the counts
  and how to answer. The cover goes as a downsized preview (`sendPhoto`), not
  as the posting copy — the packet sends that at 14:00 as a document. Approve
  or reject from those pictures.
- Replies are read by `pipeline/inbox.js` every five minutes, the only process
  that ever reads the bot's updates. **It is the approval gate: a deck posts
  only after `ok`.** Only messages from this chat id count; anything else is
  logged and ignored. Commands, case-insensitive, one per message, each
  confirmed with a reply naming the deck:
  - `ok PV-07` — pending becomes approved; the next packet may post it. A
    blocked deck is refused with its reason rather than approved
  - `ok PV-07 <text>` — the same, and the trailing text is kept as a note.
    Approving something you still have a criticism of is the usual case. The
    note is kept even when the approval is refused: the criticism does not
    stop being true because the deck turned out to be blocked
  - `note PV-07 <text>` — feedback on any deck in any state, including ones
    already posted or rejected, since most of what is worth saying is only
    visible once a deck is live or once the metrics land. Goes to
    memory/notes.md, changes nothing else
  - `no PV-07 <reason>` — rejected; the reason goes to memory/rejected.md
    under the topic slug, scope topic. The reason is required
  - `skip PV-07` — back to pending, approval withdrawn; no rejected.md row,
    so it can be approved again any other day
  - `stop` / `go` — flips `publishing_enabled` below
  - `status` — publishing, the pending/approved/blocked counts, and which deck
    posts next
  - `queue` — every pending and approved deck, oldest first, with its age
  - `show PV-07` — any deck's slides as documents, to look before deciding;
    reading only, changes nothing
