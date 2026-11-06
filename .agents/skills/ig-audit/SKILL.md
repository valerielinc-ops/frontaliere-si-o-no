---
name: ig-audit
description: >-
  Post-mortem on what the user has already posted - which reels actually
  worked, why, and what to stop making. Use when the user pastes their
  Instagram insights or past posts and asks "what's working", "why did this
  flop", "read my analytics", "audit my content", or wants to know what to do
  more of.
---

# ig-audit

The account's own evidence is the most relevant source for its performance.
Every rule in an Instagram guide, including this pack, is only a prior.

## Input

Ask for whichever the user has:

- Insights per post: views, reach, interactions, watch time, saves, shares,
  follows, and the non-follower share of reach. Screenshots are fine.
- Or the retention graph for their best and worst recent reels. This one
  screenshot is worth more than the rest combined.
- Or just the posts and their view counts, which is enough for a first pass.

In this repository, start with the latest output of
`node scripts/social-copy/native-performance-brief.mjs` when available. It
contains aggregates only and is the appropriate Codex input. Do not read raw
private post metrics, IDs, or user data into a Codex prompt. If the user wants
a per-post review, ask them for a sanitized table with no IDs, captions, or
private conversation data. The scheduled publisher does not currently record
first-hour reply status or 3-second retention, so treat those as unavailable
unless the user supplies a trustworthy source.

## What to actually measure

Use only metrics the source marks available. Missing metrics are unavailable,
not zero. Compute rates only when their numerator and denominator are both
available, and show the sample size and measurement window:

| metric | how | what it tells you |
| --- | --- | --- |
| **Outlier multiple** | views / the account's own median for a comparable format and window | relative performance within that comparison set |
| **Non-follower reach** | % of reach from people who do not follow | whether it travelled at all |
| **Hold at 3s** | viewers still there at 3s / viewers who started | hook-retention evidence, only when supplied by an actual Insights source |
| **Average watch time** | straight from insights | whether the middle worked |
| **Sends per reach** | shares / reach | a useful sharing rate when both values are available; interpret it against the post's objective |
| **Follows per reach** | follows / reach | whether the profile converted the attention |

Compare like formats and objectives. For example, 90 sends from 4,000 views is
a higher send rate than 11 from 60,000 views, but neither post is an overall
winner from that metric alone.

## Then find the pattern

With enough exact observations, compare stronger and weaker posts. Keep the
conclusion descriptive unless the repository's preregistered randomized
protocol qualifies a winner. Do not present a small sample or an angle
correlation as a causal result:

- **Hold at 3 seconds.** If measured, compare it with downstream outcomes; it
  is evidence about the opening, not proof that the hook alone caused results.
- **Hook formula.** Which ids from `ig-reel/hooks.json` are in the top five?
- **Format.** Reel, carousel, single image.
- **Length.** Group into under 15s, 15 to 30s, 30 to 60s, over 60s.
- **Theme.**
- **Whether the user replied to comments in the first hour.**
- **Day and time.** Check this **last** and only if the others show nothing.
  Treat timing as a hypothesis unless comparable account data supports it.

State the finding with its evidence and uncertainty. Thirty posts may support
descriptive screening, not causal claims or a winner; six posts rarely support
even a stable descriptive pattern.

## The distinction that saves people months

Separate distribution, viewing, and profile conversion when the relevant
metrics are available. Low views alone do not identify a hook problem, and
low follows do not prove a profile problem. This repository has no
`ig-profile` or `ig-viral` skill; do not route users to them.

## Output

```
ILLUSTRATIVE OUTPUT ONLY · use real rows and the source's available metrics

TOP 5 BY OUTLIER MULTIPLE
  18.2x  #3  Nobody Tells You   74,600 views  62% non-follower  hold@3s 71%  128 sends
   6.4x  #1  Cost Confession    26,300 views  48% non-follower  hold@3s 64%   71 sends
  ...

BOTTOM 5
   0.3x  #11 Numbered            1,200 views  9% non-follower   hold@3s 31%    2 sends
  ...

WHAT THE DATA SAYS
1. The first five have higher median 72-hour views in this sample. This is
   descriptive and does not show why the difference occurred.
2. Sends and follows are unavailable for some posts; do not infer their rates.
3. The sample is too small to rank themes or make a winner claim.

NEXT: collect more comparable observations under the existing protocol.
```

Use findings as descriptive input to `ig-plan` and the existing weekly Codex
copy-pack prompt. Do not silently change publishing cadence, copy assignment,
or experiment thresholds from an audit.
