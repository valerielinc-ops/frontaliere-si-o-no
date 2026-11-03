---
name: ig-caption
description: >-
  Write the Instagram caption - the line that survives the "... more" cut, the
  body, the single ask, search terms and optional hashtags - and review it
  before it goes out. Use when the user says "write the caption", "caption this",
  "what do I put in the description", has a reel or a carousel ready and needs
  the text, or asks about hashtags.
---

# ig-caption

One tool lives in this folder and it runs:

```bash
python3 caption.py caption.txt
python3 caption.py caption.txt --keywords "client proposals,agency pricing"
```

It prints the caption the way the feed prints it: the first 125 characters in a
box, everything else behind the tap. Read that box before you read anything
else you wrote.

## First, decide which job this caption has

This is the decision that ruins captions when it is skipped.

**Job A: the video already hooked them.** A Reel carries its own hook in the
first two seconds, spoken and on screen. The caption is not a second hook and
competing with the video is how you lose both. Its job is the ask, the context
that makes the ask make sense, and the words people search.

**Job B: the caption is the content.** A photo, a single image, a carousel
cover that opens a loop. Here line one is the hook and it works exactly like a
Reel hook: concrete, short, and cut off at a cliff rather than mid-clause.

Ask which one you are writing. If the user has a Reel with a strong hook,
write A and say why.

## The shape

```
Line 1      125 characters of visible space. Job A: the ask, plainly.
            Job B: the hook.
            Never a greeting, never a hashtag, never an emoji as the first
            character.
Body        short paragraphs, one line of white space between each. Two to six
            of them. This is where the search terms live.
The ask     one action: comment, save, or a DM only when the active publisher
            actually handles that request.
Hashtags    optional topic labels; confirm any numeric limit against current
            official guidance, or leave them out.
```

Limit is 2,200 characters and almost nothing needs 2,200. A caption that earns
the tap and then delivers 600 characters beats one that delivers 1,800.

## Hashtags, honestly

Treat hashtags as optional topic labels, not a promised reach lever. Do not
repeat or enforce limits copied from this upstream skill; check current
official platform guidance before relying on a numeric limit.

`#viral`, `#fyp`, `#explorepage`, `#foryou` describe nothing. Cut them.

## Search terms

Include relevant phrases naturally when they help a reader understand the
post. Do not keyword-stuff or claim a ranking benefit without current evidence.

Ask for two or three of those terms, then pass them to the linter:

```bash
python3 caption.py draft.txt --keywords "client proposals,agency pricing"
```

## Rules

- **No link in the caption.** Captions are not clickable. A URL in the body is
  dead text that says "I do not use this platform". Bio or DM.
- **One ask.** Two asks is the same as none. `caption.py` counts them.
- **Only request a keyword when the active integration has a keyword-specific
  handler.** Otherwise ask one open question and invite a comment; never imply
  that a comment will trigger a personalized reply or delivery.
- Include a first comment only if an existing, authorized publisher route
  supports it; otherwise use the configured bio/link flow and do not imply a
  comment will be posted.
- **Emoji as punctuation, not decoration.** The linter flags anything over
  4 per 100 characters.
- **Alt text is worth 20 seconds.** For carousels and photos, write it. It is
  read by screen readers and by Instagram.

## The loop

1. Decide Job A or Job B and say which.
2. Draft it.
3. Review natural Italian, verified facts, and whether the CTA is supported by
   the active integration.
4. Use `/ig-human` and `caption.py` only as advisory heuristics. Review every
   flag against the publisher contract; do not treat upstream estimates as
   automatic publishing gates.
5. Print the copy-ready block, then the receipt:

```
CAPTION READY
job:        A - the reel carries the hook
visible:    first line checked against the approximate feed preview
ask:        one, salva questa checklist
hashtags:   optional labels reviewed
search:     relevant Italian phrases included only when source-backed
linter:     advisory review
```

This skill drafts copy. The scheduled publisher posts only content admitted by
the validated copy pack and its existing source, readiness, and cadence
checks. A one-off draft is not sent to the publisher automatically.
