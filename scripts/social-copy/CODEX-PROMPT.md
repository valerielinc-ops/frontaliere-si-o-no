Generate the next Frontaliere Ticino social-copy pack.

Read these files first:
- .agents/skills/social-content/SKILL.md
- docs/instagram-creative-study.md
- docs/social-ai-automation.md
- scripts/lib/social-copy-pack.mjs

Use natural Italian and adapt each channel's voice. These are reusable hooks
and calls to action; publishers add verified facts, figures, dates, locations,
URLs, labels, disclosures, and media. Never invent claims, events, salaries,
tax or legal advice, reach promises, or audience facts.

Return one JSON object with this exact channel/kind hierarchy:

```json
{
  "channels": {
    "instagram": {"article": [], "job": [], "border": [], "reel": []},
    "tiktok": {"article": [], "job": [], "border": [], "video": []},
    "facebook": {"article": [], "job": [], "event": [], "digest": []},
    "linkedin": {"article": [], "job": []},
    "telegram": {"job": [], "border": []}
  }
}
```

Each array contains template objects with short unique lowercase kebab-case
`id`, `hook`, and `cta`. Instagram templates also require `objective`, whose
value is `share`, `save`, or `conversation`. For every Instagram kind, provide
exactly nine templates: exactly three per objective. Make the CTA fulfill its
declared objective: share CTAs begin with an explicit `Condividi` action;
save CTAs begin with `Salva`, `Conserva`, `Metti da parte`, or `Aggiungi ai
preferiti`; conversation CTAs contain exactly one open question followed by a
positive request to comment or write in the comments. The pack validator
checks these action cues. Never ask for a keyword, DM, or follow-up the worker
cannot deliver. The publisher keeps the chosen CTA aligned with the assigned
Instagram creative objective.

Provide exactly twelve distinct templates for `facebook.job`, because that
publisher schedules twenty-four jobs per day. Every other non-Instagram
channel/kind has exactly three. Keep all hooks and CTAs distinct within each
slot. Instagram and TikTok hooks must be at most ninety characters and their
CTAs at most eighty. Facebook, LinkedIn, and Telegram hooks and CTAs must be
at most one hundred fifty characters.

Every hook and CTA is one plain-text line. Each CTA must contain exactly one
clear imperative action; do not combine actions with "e", "poi", or punctuation.
Use a direct action such as leggi, approfondisci, apri, consulta, visita, vai,
scopri, candidati, condividi, salva, commenta, scrivi, racconta, or segui.
Use no digits, numeric claims,
URLs, email addresses, handles, placeholders, HTML, or hashtags. Each CTA
requests one action that the platform post can fulfill. For Instagram and
TikTok, mention the link in bio when the requested action is to read or apply;
their captions also retain a publisher-owned destination note. Facebook,
LinkedIn, and Telegram attach the canonical destination themselves.

If a recent Instagram copy-performance brief is supplied after this prompt,
use only template groups with at least three observations as descriptive style
signals. If a GA4 social-link attribution brief is supplied, use only groups
marked eligibleForDescription (at least ten attributed sessions); sessions are
not impressions. Read `copySlot` separately from the source content `kind` so
video copy is not treated as article-carousel copy. Both inputs are descriptive. Do not declare a winner, infer
causality, change objective balance, or optimize for a rate from insufficient
observations. An unavailable source or empty variant list means there is no
usable evidence, not that the template received zero traffic or performed
poorly. Preserve verified facts outside the copy pack.

Write the JSON only to `/tmp/social-copy-response.json`. Do not edit, commit,
or publish any repository file.
