# Roadmap

Nothing here is "someday". Every item has an unlock condition — a thing that
must be true before building it is worth the cost. Build in order; skipping
ahead is how a working system becomes an unfinished one.

The ambition is borrowed from a fuller "media OS" architecture (media brain →
orchestrator → specialist tools → output → analytics → brain). That shape is
right. Most of its parts simply have preconditions that do not exist yet.

## Now — v1

PaceVector only. One carousel a day, cross-posted to Instagram and TikTok.
Brain in `brands/pacevector/`, fixed pipeline, review queue, in-app posting,
nightly metrics, weekly brain PR.

Done when: seven consecutive days posted with no needs-attention state.

## Next

**Tool capability matrix** — `docs/tools.md`
For every tool: what it can read, create, modify, export, trigger; whether it
runs unattended; API vs MCP; what actually requires a human. Three surprises
already cost us a rebuild (Claude Design is interactive-only; no API attaches
a trending sound; Higgsfield video is async).
*Unlock: before the build guide is written.* ← next up

**MoneyTerms as second brand** — `brands/moneyterms/`
Fresh start, same pipeline, its own folder. The test of whether the
brand/pipeline split actually holds.
*Unlock: PaceVector has run two weeks unattended without intervention.*

**`comments.md` in each brain**
Reply voice and rules. First-hour replies are a real Instagram growth lever,
and reply tone is a brand surface like any other.
*Unlock: a post gets more than ten comments.*

## Later

**Reels from approved carousels** — the biggest untapped Instagram reach
lever. A Remotion template animating a deck that already exists; not new
content.
*Unlock: carousels run themselves AND non-follower reach has plateaued.*

**Video pipeline** (Higgsfield video, sound, subtitles)
*Unlock: Reels prove out and video is worth its own budget line.*

**3D / motion (Blender, After Effects)**
*Unlock: video is routine AND a specific planned post genuinely needs it.
Not before. Probably not at all.*

**DM strategy**
*Unlock: DM volume exceeds what can be answered by hand.*

**Multi-model orchestration**
*Unlock: Claude alone demonstrably fails a task that another model passes.
Until then it is a second bill and a second failure mode.*

## Deliberately not planned

**Dynamic tool selection by an orchestrator.** A pipeline that chooses its own
steps cannot be debugged or reproduced. Fixed pipeline, smart brain — that is
a design decision, not a limitation.

**Level 3 full autonomy.** Blocked by the platforms, not by ambition: no API
can attach a trending sound, and sound is part of the format. The last tap
stays human.

**A database for the brain.** Markdown in git is diffable, reviewable, and
forces brain changes through a merge. That property is worth more than query
speed at this scale.
