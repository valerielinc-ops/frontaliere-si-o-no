---
name: social-content
description: >-
  Generate and review Frontaliere Ticino social copy for Instagram, TikTok,
  Facebook, LinkedIn member posts, and Telegram. Use when editing the shared
  Codex social-copy workflow, its copy pack, or platform-specific publishing
  scripts.
---

# Frontaliere Ticino social content

Use the upstream Instagram-agent-skill as a source of creative patterns, then
adapt every idea to the site's data, audience, publishing code, and platform
access. The upstream revision and license are recorded in
docs/third-party/instagram-agent-skill/UPSTREAM.md.

## Editorial contract

- Write in natural Italian for people who live or work between Italy and
  Switzerland. Keep each platform's format and audience distinct.
- Start with a useful question, concrete situation, or verified data point.
  One post has one clear promise and one primary action.
- Prefer practical information people can save or share with a colleague.
  Avoid rage bait, fake urgency, engagement bait, and guaranteed reach claims.
- For Instagram and TikTok, keep read/apply CTAs compatible with the existing
  link-in-bio destination. Facebook, LinkedIn, Telegram, and Reddit publishers
  attach the canonical destination to the CTA.
- Never invent salary, tax, legal, employment, border, performance, or company
  facts. The publisher supplies verified titles, figures, dates, locations,
  and links. AI-generated copy may only provide a short hook and CTA.
- Do not promise a DM, Story sticker, follow-up, or personal response unless
  the existing workflow can fulfill it.
- Do not include URLs, credentials, personal data, names from private
  conversations, numeric claims, or HTML in a generated hook or CTA.
- Preserve canonical links and platform-specific disclosure, formatting,
  deduplication, cadence, and publication limits from the existing publisher.
- Reuse the existing visual system and creative experiments. Do not change
  their measurement windows, minimum observations, lift thresholds, or
  Firebase assignment rules while editing copy.

## Automation contract

The monthly Codex workflow generates a validated JSON copy pack. Publishers
consume a fresh pack automatically and record its pack/template ID and copy
objective metadata in their ledgers. Instagram creates three copy variants
for each existing creative objective and only selects a CTA that matches the
publisher's selected objective. Its rendered cover/closing card and
caption use the same generated hook/CTA. Facebook job hooks have twelve
variants for the existing daily schedule. Missing, stale, malformed, or
invalid output uses the existing deterministic copy. The content-generation
job receives no social publishing credentials; platform tokens and browser
sessions stay in the publisher or robot process.

Do not give Codex browser cookies or social API tokens. The publishing
workflow and the existing social robot perform delivery without per-post
approval. Keep external platform permissions and existing readiness checks
intact.

## Community and platform boundaries

- Reuse the existing Instagram community worker for inbound replies.
- Respond only to user-started conversations within the existing API windows;
  never cold-message, scrape, follow, like, or comment on unrelated accounts.
- Do not simulate interactive Story stickers where the current publishing API
  cannot create them.
- Keep Reddit's refused classic Data API publisher disabled; the copy pack may
  prepare Reddit copy for the in-repository templates, but Devvit remains the
  supported publishing path until its app and CDN domain pass review. Keep the
  LinkedIn Company Page out of automated delivery while its current access
  check reports that the required platform permission is unavailable.
- Treat the upstream numeric limits and trend claims as unverified. Confirm
  current platform behavior from official documentation before changing a
  publisher contract.

## Measurement

Preserve creativeId, copyPackId, copyTemplateId, prompt version, hook,
objective, and CTA in the ledger and Instagram Insights report. Compare
like-for-like formats and windows. Existing 24/72-hour windows, minimum sample
sizes, and decision thresholds remain unchanged. The monthly brief can include
aggregate Instagram rates and GA4 social-link sessions by copy variant. Require
the stated minimum samples, describe both sources only, and never use them to
select a winner or change publishing assignments. GA4 session counts are not
social impressions. Do not claim per-post link performance for Instagram or
TikTok unless the link is exposed on a clickable destination.
