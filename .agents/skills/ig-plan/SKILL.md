---
name: ig-plan
description: >-
  Plan Instagram content using the repository's cadence, source inventory,
  and available performance evidence. Use when the user says "plan my week",
  "what should I post", "content calendar", or "I have nothing to post about".
---

# ig-plan

Use this skill for one-off planning requests. Scheduled production follows the
repository copy pack and publisher workflow.

## Input

Read `.agents/skills/social-content/SKILL.md` first. Use the repository's
published article inventory, current social copy pack, and available aggregate
performance brief as inputs; do not assume private voice, swipe-file, or post
history files exist. If a one-off plan needs missing audience or voice context,
ask for it instead of inventing it:

1. What the user sells, and to whom.
2. The three or four themes they want to be known for.
3. What actually happened this week: a client call, a number, a mistake, a
   thing they built, an argument they had. This is where posts come from.
4. Which approved brand voice or source material to follow, if that is not
   already available in the project.

## What to post

Follow the repository's active publishing cadence and supported formats. Do
not increase frequency or change an experiment schedule from this skill.
Format reach varies; treat Reels, carousels, and Stories as hypotheses to
measure with comparable, available metrics rather than guaranteed outcomes.

Choose from these editorial angles when supported by current source material;
they are not weekly frequency targets:

| type | share | job |
| --- | --- | --- |
| **Proof** | a verified result or case detail |
| **Teach** | a useful action grounded in source material |
| **Opinion** | a supported point of view, without rage bait |
| **Story** | a real event or user-approved example |
| **Offer** | a supported product or service description |

For each proposed slot give: the theme, the source-backed angle, the format,
and an optional hook pattern from `ig-reel/hooks.json`.
Not a topic, an angle. "AI" is not a plan. "The proposal we lost because the
draft had an em dash in it" is a Reel.

## When to post

Use an approved platform audience-activity report when available. Otherwise,
retain the existing workflow schedule; do not infer a best hour from generic
consumer or business defaults. Treat timing as a hypothesis and change it only
through the existing measurement design.

## Community handling

Do not create outreach lists or automate comments, likes, follows, or cold
messages to third-party accounts. The repository's community worker handles
only eligible inbound interactions under its documented policy. This is not a
publishing prerequisite.

## Output

```
ILLUSTRATIVE FORMAT ONLY — USE THE REPOSITORY'S ACTIVE CADENCE

WEEK OF SEP 15

TUE  scheduled slot   REEL      PROOF    - verified source angle
THU  scheduled slot   CAROUSEL  TEACH    Job B caption       - practical source-backed steps

Use only formats and interactive features supported by the active publisher.
Request a draft when a one-off version is needed.
```

For a one-off request, present the plan in the response. The scheduled Codex
workflow uses the validated copy pack and existing publisher cadence; this
skill does not create a parallel calendar or add a per-post approval step.
