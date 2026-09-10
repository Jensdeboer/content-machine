# Banned

Hard failures. The build blocks the deck; nothing on this list is a
judgement call.

## Copy

- No hashtags, no emoji, no exclamation marks, no em dashes
- No jargon without a shown explanation: VO2max, lactate threshold, RPE,
  mitochondrial density, supercompensation
- No hype vocabulary: "insane", "game-changer", "secret", "hack", "unlock",
  "ultimate guide"
- No absolute promises: "will make you faster", "guaranteed", "never get
  injured again"
- No shaming: the reader is never lazy, slow or doing it embarrassingly wrong

## Language — the non-native reader test

A large share of the audience reads English as a second language, scrolling.
Every line must survive one fast read. A sentence that needs a second read has
failed, however good it sounds. Concrete beats clever, every time.

- No metaphor where a plain instruction works: "rehearsing", "holds your
  place", "nudge", "dial in", "dial back", "banking", "the engine", "the well",
  "the tank", "unlock", "lay the foundation", "build the base", "chase the
  clock", "leave it on the road"
- No setup-then-negation: a claim followed by a bare denial of itself. "It
  feels like progress. It is not." and "specific is not the same as stacked"
  both say a thing only to withdraw it, and commit to nothing. Say what is
  true instead.
- No telegraphic body copy: a sentence that joins phrases with commas and
  carries no verb at all. "Same distance, same effort, later finish" makes the
  reader assemble the grammar before they reach the advice. Write the sentence
  out: "The distance and the effort are the same. The finish is later."
  Body copy only. A headline, a label, a chip, a compare column heading and an
  aside are not sentences and are exempt: "A gap in the week" is a column
  heading doing its job, and forcing a verb into it would make the slide worse.
  Labels, chips and asides are exempt from the bare-referent rule too: "05 ·
  THIS WEEK" points at the slide it sits on, not at a noun.
- No bare referent. "it", "them", "this", "that" must point at a noun already
  named in the same field, and a vague adjective must say what it is measured
  against. "Established plans keep it small" names neither the thing nor the
  size; "Most training plans add less than 10% per week" names both.
- No sentence over 22 words.
- American spelling: "kilometer" not "kilometre", "meter" not "metre", "liter",
  "fiber", "color", "center", "program", "gray", "practice", "analyze",
  "organize", "recognize", "behavior", "favor"

The first bullet is a list, so a metaphor caught in review is added there and
the build catches it next time. The rest are patterns, implemented in
`pipeline/lib/lint.js`.

What blocks and what flags, and why. Metaphors, setup-then-negation, sentence
length and British spelling BLOCK: each is decidable from the text alone.
Telegraphic body copy and bare referents FLAG: both are heuristics, and a
heuristic that stops a deck had better be one we have watched for a while. The
telegraphic rule was measured over five real decks before it went in — two
flags, both genuine, no false positives — but two is not enough evidence to
block on, so it reports to a human until the record is longer.

Asides are exempt from the telegraphic rule by design, not by oversight.
voice.md's own illustration of sanctioned dryness, "Yes, that slow.", is a
verbless fragment: a rule that flagged the brand file's own example of correct
voice would be wrong about the voice, not about the line.

## Medical — the line that matters in this niche

- No diagnosis, no treatment advice, no injury rehab protocols
- No claims that training prevents or cures any condition
- No supplement, medication or weight-loss content of any kind
- Pain is always "see a physio" — one line, then out. Fatigue and soreness
  as normal training topics are fine.
- General, well-established guidance (easy pace, sleep, gradual mileage) is
  fine; anything framed as advice for a medical situation is not

## Numbers

- No figure on a slide without a row in the sources table
- No cherry-picked single small study presented as settled fact; say
  "one study" when it is one study
- Paces always in min/km (audience is metric); miles may appear only in a
  quoted source. Written "kilometer", American spelling, per Language above.

## Visual (enforced by QA against the design system)

- Nothing from the cover grammar negative list
- No colour photography, no stock-smile poses,
