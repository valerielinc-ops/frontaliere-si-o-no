---
name: ig-carousel
description: >-
  Plan Instagram carousel copy and assets through the repository renderer.
  Use when the user says "carousel",
  "slides", "swipe post", "turn this into a carousel", or has a list-shaped or
  step-shaped idea that would die as a single image.
---

# ig-carousel

Use a carousel when the idea benefits from sequence or re-reading. Treat
format-performance claims as hypotheses and compare only like-for-like,
available measurements; do not promise reach or dwell-time gains.

The format can present one idea in steps. Keep the copy concise, then use the
account's own comparable results to learn whether that format helps.

## When to use it instead of a Reel

Use a carousel when the idea has **sequence and benefits from re-reading**:
steps, a framework with parts, a before and after, or a useful checklist. Use a
Reel when the idea depends on motion or a payoff that needs to be seen.

If one claim does not need a sequence, choose the simplest format supported by
the active publisher rather than forcing it into a carousel.

## Structure

Use only the slide count accepted by the active publisher and keep each slide
focused. This source skill's suggested counts are editorial heuristics, not
platform limits or performance guarantees.

```
1         COVER     the hook. 6 words or fewer, at a size that is legible in
                    the grid at thumbnail. One line of promise under it.
2         THE STAKE why this matters, in one sentence. This slide is also a
                    second cover, so it cannot be setup.
3 to N    ONE IDEA PER SLIDE. A headline of 3 to 7 words, at most 25 words
                    under it. If a slide needs a paragraph, it is two slides.
N+1       RECAP     the whole thing as a list. This is the screenshot slide.
LAST      CTA       one action. Save or invite one open-question comment;
                    use a keyword only when the active integration handles it.
```

## Slide copy rules

- **Make the cover easy to scan.** A short, concrete headline helps readers
  understand the topic; it does not guarantee swipes.
- **Design for the grid crop.** Follow the current project renderer's image
  dimensions and safe area. Verify current Instagram display behavior before
  treating upstream crop dimensions as a platform contract.
- **Number the slides** (3/8) when that helps readers follow the sequence.
- **No slide is a paragraph.** If it cannot be said in 25 words, split it.
- **Make the recap useful on its own.** It may be easier to save or share when
  it is readable without the rest of the deck.
- Add the brand mark only where the approved design system places it; preserve
  legibility and avoid claiming that it will increase distribution.
- **Alt text on the cover at minimum.** It is read by screen readers and by
  Instagram.

## Building the files

Use the existing Instagram creative renderer and its project-defined canvas,
safe area, branding, and accepted slide count. Do not add an HTML/Chrome
rendering path alongside it. The scheduled publisher compiles validated copy
and verified source fields into the bounded renderer input.

## Output

The slide-by-slide copy first, as a numbered list the user can read in ten
seconds and edit before anything is rendered. Then the **caption**, which for a
carousel is Job B in `/ig-caption`: the caption is doing work here, because the
cover has already used its six words.

Use `/ig-human` only as an advisory editorial pass. In the scheduled flow, the
publisher compiles a bounded render kit from validated copy and verified
source fields; do not add a per-post approval gate or invent facts. For a
one-off request, show the copy before creating an asset.

```
CAROUSEL  ·  8 slides

1  COVER   {{source-backed promise}}
           One concise line that accurately previews the selected source.
2  STAKE   {{verified situation and why it matters}}
3          {{specific heading}}
           {{verified detail from the source}}
...
7  RECAP   All four lines, in order.
8  CTA     Salva la checklist per quando ti serve.

Caption: Job B, hook in line 1, one supported action. Template only; not approved facts.
```

This skill does not upload assets. The existing scheduled publisher delivers
only through its configured API or approved robot route and records its
result in the existing ledger.
