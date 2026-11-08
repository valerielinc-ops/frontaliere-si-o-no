---
name: ig-reply
description: >-
  Draft a reply to a public Instagram comment supplied in sanitized form, or
  explain when it should be escalated instead of answered.
---

# Replies to Instagram comments

Use only a sanitized comment supplied by the user. Do not access the account,
scrape comment threads, or request raw private messages. The existing Graph
worker handles only low-risk, allowlisted replies on the account's own media;
Codex never receives the underlying comment text and does not send replies.

For a draft, answer the actual question in plain Italian and keep the reply
short. Use current, verified site sources for facts. Escalate personal cases,
legal or medical questions, employment decisions, contact details, unclear
claims, complaints requiring account access, and anything outside the
allowlist. Never reveal private information or turn a reply into unsolicited
promotion.
