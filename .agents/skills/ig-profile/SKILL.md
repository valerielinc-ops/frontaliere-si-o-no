---
name: ig-profile
description: >-
  Audit and rewrite the Instagram profile for Frontaliere Ticino from an
  owner-provided profile brief or screenshots. Use when reviewing the account
  name, bio, link destination, highlights, pinned posts, or cover consistency.
---

# ig-profile

Treat the profile as a short decision path for someone who found one useful
post: who the account serves, what practical value it offers, and where to go
next. Use current evidence from the profile and the site's verified content;
do not promise follower growth or infer search ranking from a field.

## Input

Use only the profile material the owner supplied: name, handle, bio, link
destination, highlight labels, pinned-post descriptions, and visible cover
images. A redacted screenshot or short text brief is enough. Never request a
password, browser session, private messages, or account token, and do not open
or scrape other people's profiles.

If a field is not visible, mark it `non valutabile`; do not score missing
evidence as zero. Report the score only for observed criteria and state the
observed maximum. Do not compare the score with an influencer benchmark.

## Review

Read `rubric.json` and evaluate the twelve criteria against the evidence. For
each row, give the points, one specific reason, and the next useful edit. Keep
recommendations relevant to people who live or work between Ticino and Italy:
job search, cross-border work, practical local information, and verified
services from the site. A profile is not an offer page, so do not add a sales
claim or a service the site does not provide.

Check the link against the current canonical destination and active social
publisher contract. Recommend only one primary next action at a time. Treat
name-field keywords, highlights, pins, and cover layouts as editorial choices;
do not claim that they cause reach or conversion without qualified account
data.

## Output

Return:

1. An evidence table with criterion, points, observed maximum, and reason.
2. The three highest-value edits, with copy-ready alternatives where useful.
3. Any items that need an owner-side profile change or current platform check.

This skill drafts and audits only. It does not edit Instagram settings, publish
posts, or bypass the existing publisher's validation and cadence controls.
