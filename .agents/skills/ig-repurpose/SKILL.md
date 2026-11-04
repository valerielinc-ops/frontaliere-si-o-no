---
name: ig-repurpose
description: >-
  Turn Frontaliere Ticino's own verified site material into distinct,
  format-native social angles. Use when planning how one article, job, event,
  or guide can serve Instagram and the existing social copy pack.
---

# ig-repurpose

Repurpose useful information, not wording. A source may support more than one
format only when each version gives readers a distinct use. The existing
publisher owns source facts, rendering, links, deduplication, cadence, and
delivery.

## Source boundary

- Use first-party content and structured source records already supplied to the
  workflow. For a one-off request, use text the owner supplied or a verified
  Frontaliere Ticino source; do not scrape social feeds or copy another
  creator's script, footage, or artwork.
- In the scheduled copy-pack job, Codex receives sanitized source categories
  and aggregate counts. Treat them as ideation context only. If a title, date,
  figure, quote, or source fact is absent, do not infer or invent it.
- Do not place private post IDs, social credentials, raw comments, DMs, or
  user-level analytics in copy or prompts.

## Find distinct uses

For each candidate source, list only the supported reader value:

- a verified update or change that merits a short post;
- a process readers need to understand or repeat;
- a checklist or comparison that readers may save;
- a specific question the source actually answers.

Reject a derivative if it only restates the same hook or repeats a previous
post without adding practical value. Do not force a source into four to six
posts; one strong format is better than several thin copies.

## Map to the existing pack

Use the formats configured in `scripts/lib/social-copy-pack.mjs` and the
channel rules in `social-content`:

- use a Reel angle for one concise, verified explanation that the existing
  compiler can render from publisher data;
- use a carousel angle when separate steps or distinctions are already
  available in the verified source fields;
- use a caption angle for context and one supported action;
- prepare other channels only through their configured pack slots.

Codex supplies short hooks and CTAs. It does not write unsupported facts,
spoken narration, subtitles, Story sticker prompts, or media-specific claims.
The publisher compiler can combine approved copy with its exact verified
source fields; do not trigger a second Codex invocation for each derivative.

## Output

Return a compact source-to-format map with the source category, distinct reader
value, configured channel/slot, and angle hypothesis. Mark unsupported details
as unavailable. Keep each angle useful on its own, then let the scheduled pack
schema and publisher validation decide whether it is eligible for delivery.

This skill plans copy. It does not publish directly or change assignment,
experiment, or cadence rules.
