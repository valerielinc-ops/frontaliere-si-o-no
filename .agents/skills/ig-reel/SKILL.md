---
name: ig-reel
description: >-
  Write an Instagram Reel from a raw idea - hook options off 26 formulas, the
  spoken script, the on-screen text, and a timed beat sheet - in the user's own
  voice and scored before they shoot it. Use whenever the user wants a Reel, a
  short-form video script, a hook, a voiceover, "make a reel about X", or
  "what should I say in this video".
---

# ig-reel

Turns a verified idea into a concise Reel concept. Its timing and hook tools
are creative heuristics, not performance predictors.

The upstream tools in this folder run locally but are English-oriented. Use
them only when they help; judge Italian copy and spoken timing directly.

```bash
python3 hookscore.py hooks.txt              # rank your hook options
python3 hookscore.py --hook "one line"      # score a single one
python3 beats.py script.txt --target 30     # timed beat sheet before you shoot
```

## Before you write

1. Follow `.agents/skills/social-content/SKILL.md` and the brand voice present
   in approved site copy. Do not infer a personal voice from unrelated users'
   content or save a voice profile outside the repository without a request.
2. Read `hooks.json` in this folder. 26 formulas, each with a template, a filled
   example, the on-screen version, what it is for, and how it gets ruined.
   Four of them are in there because they kept turning up in real hooks, not
   because they completed a pattern.
3. For a one-off request with a thin idea, ask what happened, to whom, and what
   it cost or changed. In scheduled generation, use verified source facts and
   fall back to existing deterministic copy if there is no supported angle.
4. Use the available account performance brief only as descriptive evidence;
   this repository has no `ig-viral` swipe-file skill. Do not claim a hook
   formula is a winner unless the frozen experiment protocol says so.

## The shape

Make the opening understandable quickly; the timing below is a creative guide,
not a platform ranking rule.

```
0:00 - 0:02   HOOK        the claim. Spoken line and on-screen line, written
                          separately. Motion in the first frame, not a static face.
0:02 - 0:07   THE STAKE   why this matters to the person watching. One line.
0:07 - ...    THE BODY    one idea per beat, and the frame changes every beat.
LAST 3s       THE PAYOFF  deliver what the hook promised, then the single ask.
LAST LINE     THE LOOP    echo one word from the hook so the replay lands clean.
```

Use the existing publisher's accepted duration and asset constraints. The
upstream 15-to-45-second range is a creative suggestion only; review current
platform behavior before treating a duration as a limit or performance rule.

## The loop

**1. Pick three hooks, not one.** Run the idea through `hooks.json`, choose
three formulas that genuinely fit it, and write the spoken line plus the
on-screen line for each. Different formulas, not three rewrites of one.

**2. Compare them.** `hookscore.py` is an English-oriented heuristic, not a
performance predictor or a production gate. Use it only when it helps; judge
Italian wording for clarity, factual grounding, and natural speech.

**3. Write the script** on the winning hook. Plain spoken language, the way the
user actually talks. Contractions. Short lines. No sentence they would have to
rehearse.

**4. Estimate timing.** `beats.py` can help estimate duration, but its flags
are not pass/fail rules for Italian copy. Read the script aloud and adjust for
the speaker, source facts, and current publisher duration limits.

**5. Review it.** Check natural Italian, verified facts, and readability aloud.
The upstream humanizer scores are advisory and must not replace factual review.

**6. Print the block.** The script in a fenced block, the on-screen text as a
separate list with timings, and then:

```
REEL READY
hook:       #3 Nobody Tells You, selected for clarity and source fit
length:     estimated; confirm by reading aloud
on-screen:  6 cards
review:     factual and editorial check complete
caption:    run /ig-caption next

For a one-off draft, offer a revision. Scheduled posts are produced through the
validated monthly copy pack and publisher; do not wait for a per-post approval
or call a second Codex run for every scheduled Reel.
```

**7. Do not publish directly from this skill.** The scheduled publisher handles
eligible delivery through its configured route. Do not write a separate local
post log; the existing ledger and private Insights store are the source of
publication and measurement records.

## On-screen text is a separate script

Write it separately, every time. It is read before it is heard.

- **Six words or fewer per card.** It is being read at arm's length by someone
  who is not listening yet.
- **The hook card is up at frame 1**, not after a beat of silence.
- **Keep text clear of interface controls.** Use the project renderer's safe
  area and preview the final crop; upstream pixel coordinates are not a
  permanent platform contract.
- Keep key text clear of the caption and action overlays shown in the current
  platform preview.
- **Keep speech accessible.** Use readable captions when the active renderer
  supports them; do not infer viewer behavior from this upstream guide.

## Rules that make the difference

- **One idea per Reel.** If the script has two, you have two Reels. Say so.
- **Numbers over adjectives.** "$4,200" beats "a lot". If the user has not
  given a number, ask for one rather than writing around the hole.
- **Cut the intro.** No greeting, no "in this video", no name, no logo sting.
  The video starts at the sentence you would normally reach at second six.
- **Use visual changes to aid comprehension.** Do not impose a fixed edit
  frequency or infer viewer drop-off from this heuristic.
- **One ask at the end.** Invite one open-question comment, ask for a save, or
  request a share. Use a keyword only when the active integration handles it;
  never imply a personalized reply or follow-up that is not configured.
- **Never fabricate.** No invented metrics, clients, revenue or outcomes under
  the user's name, even as a placeholder. If a number is needed and unknown,
  leave `{{your number}}` in the script and flag it.
- **Do not write a script around a trending audio the user cannot use.** If the
  idea needs the user's own voice, say so.

## Example

```
/ig-reel we cut proposal time from 5 hours to 20 minutes with one template
```

UPSTREAM HEURISTIC EXAMPLE ONLY — the numbers and outcomes below are not
account evidence and must not be reused as facts.

```
HOOKS  (heuristic score, not expected performance)
  86  STRONG  #5  Time Collapse   "Proposals used to take me five hours. Twenty minutes now."
                                  on screen: 5 HOURS -> 20 MIN
  71  STRONG  #1  Cost Confession "I billed four hours a week for formatting. For two years."
                                  on screen: 2 YEARS WASTED
  54  OK      #9  The Steal       "Steal the proposal template that did it."
                                  on screen: STEAL THIS

Choose wording for clarity and source fit. Verify every number against the
selected source before including it.
```
