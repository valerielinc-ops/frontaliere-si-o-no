Generate the next Frontaliere Ticino social-copy pack and its measurable
weekly editorial-angle refresh, preserving experimental treatments across pack refreshes.

Read these files first:
- .agents/skills/social-content/SKILL.md
- .agents/skills/ig-plan/SKILL.md
- .agents/skills/ig-caption/SKILL.md
- .agents/skills/ig-carousel/SKILL.md
- .agents/skills/ig-reel/SKILL.md
- .agents/skills/ig-audit/SKILL.md
- .agents/skills/ig-human/SKILL.md
- docs/instagram-creative-study.md
- docs/social-ai-automation.md
- scripts/lib/social-copy-pack.mjs
- data/social-copy-packs/current.json (when present: preserve its active treatment contract)

Use natural Italian and adapt each channel's voice. These are reusable hooks
and calls to action; publishers add verified facts, figures, dates, locations,
URLs, labels, disclosures, and media. Never invent claims, events, salaries,
tax or legal advice, reach promises, or audience facts. Reddit copy must read
as a useful community contribution: no hashtags, engagement bait, or generic
cross-promotion language.

Apply the Instagram references as editorial checks, adapted to Italian and to
the publisher formats: put the useful hook first, make each carousel slide
advance one verified idea, give a Reel a clear opening and progression, and
make the caption's first visible lines useful without a generic preamble. Use
the audit and humanization references as review prompts only. Do not run their
English-biased lexical scores as pass/fail gates, rewrite factual copy with
synonym substitutions, invent spoken audio or subtitle text, or pad a short
source into a longer storyboard. The publisher may synthesize only its exact,
verified script; any visible captions must match that script and its timing.
The publisher remains the source of facts and the renderer remains the source
of final media.

Return one JSON object with exactly two top-level keys: `editorialPlan` and
`channels`. The plan contains three to five durable pillars. Each configured
channel/format gets exactly three distinct angles; each template points to one
of those angle IDs. The pack is editorial coverage, not proof that every
channel has a live publisher. TikTok and Reddit remain draft-preparation only
while their delivery paths are held; LinkedIn means the member profile, not
the held Company Page. Do not imply those held paths published or reached an
audience. Use `qualified-aggregate-performance` only when the
provided report marks the relevant metric eligible. Otherwise label the idea
`publisher-source-inventory` when it follows from the formats/data the site
actually publishes, or `editorial-hypothesis` when it is a testable idea with
no qualified evidence. Never describe a hypothesis as a finding. Do not invent
audience research, platform trends, or performance results.

The JSON shape is:

```json
{
  "editorialPlan": {
    "pillars": [
      {"id": "opportunita", "name": "Opportunità concrete", "audienceNeed": "Capire quali passi pratici si possono valutare"},
      {"id": "vita-oltreconfine", "name": "Vita oltreconfine", "audienceNeed": "Orientarsi tra lavoro e vita tra Italia e Svizzera"},
      {"id": "strumenti-utili", "name": "Strumenti utili", "audienceNeed": "Trovare risposte verificabili a domande ricorrenti"}
    ],
    "angles": {
      "instagram": {"article": [], "job": [], "border": [], "reel": []},
      "tiktok": {"article": [], "job": [], "border": [], "video": []},
      "facebook": {"article": [], "job": [], "event": [], "digest": []},
      "linkedin": {"article": [], "job": []},
      "telegram": {"job": [], "border": []},
      "reddit": {"article": [], "job": []}
    }
  },
  "channels": {
    "instagram": {"article": [], "job": [], "border": [], "reel": []},
    "tiktok": {"article": [], "job": [], "border": [], "video": []},
    "facebook": {"article": [], "job": [], "event": [], "digest": []},
    "linkedin": {"article": [], "job": []},
    "telegram": {"job": [], "border": []},
    "reddit": {"article": [], "job": []}
  }
}
```

Each array contains template objects with short unique lowercase kebab-case
`id`, an `angleId` declared under the same channel/format, `hook`, and `cta`.
Instagram templates also require `objective`. For `article`, `job`, and
`border`, use `share`, `save`, or `conversation` and provide exactly nine
templates, three per objective. `reel` uses only the `follow` objective and
exactly three templates, one for each editorial angle. Its CTA must start with
an explicit `Segui` action and make no promise about posting frequency. The
pack validator checks these action cues. Never ask for a keyword, DM, or
follow-up the worker cannot deliver. The publisher keeps the chosen CTA aligned
with the assigned Instagram creative objective. Reel follow variants are
evaluated only on Meta's exact-media `follows / reach` metric at 72 hours; if
that metric is absent, no winner can be registered or promoted. In performance
reports, show absolute Reel follows and sample/denominator coverage alongside
the registered rate so scale and efficiency stay visible together. Absolute
follows, follows per view, and account-level follower changes are diagnostics;
none can replace the preregistered exact-media follows-per-reach winner rule.

Provide exactly twelve distinct templates for `facebook.job`, because that
publisher schedules twenty-four jobs per day. Every other non-Instagram
channel/kind, including Reddit, has exactly three. Keep all hooks and CTAs distinct within each
slot. Instagram and TikTok hooks must be at most ninety characters and their
CTAs at most eighty. Facebook, LinkedIn, Telegram, and Reddit hooks and CTAs
must be at most one hundred fifty characters.

Every hook and CTA is one plain-text line. Each CTA must contain exactly one
clear imperative action; do not combine actions with "e", "poi", or punctuation.
Use a direct action such as leggi, approfondisci, apri, consulta, visita, vai,
scopri, candidati, condividi, salva, commenta, scrivi, racconta, or segui.
Use no digits, numeric claims,
URLs, email addresses, handles, placeholders, HTML, or hashtags. Each CTA
requests one action that the platform post can fulfill. For Instagram and
TikTok, mention the link in bio when the requested action is to read or apply;
their captions also retain a publisher-owned destination note. Facebook,
LinkedIn, Telegram, and Reddit attach the canonical destination themselves.

Editorial-plan constraints:
- Use exactly three angles per channel/format and distribute templates evenly.
- For Instagram article, job, and border formats, each angle appears exactly
  once under each objective (`share`, `save`, `conversation`). Reels contain
  exactly one `follow` template per angle, so their only registered outcome is
  exact-media follows per reach; reports also show absolute follows and metric
  coverage without using them to promote a winner.
- `facebook.job` has twelve templates, so each angle appears four times.
  Every other format has three templates, so each angle appears once.
- Angle IDs and their treatment definitions persist across weekly packs.
  When `data/social-copy-packs/current.json` has schemaVersion 3 or 4, preserve every
  existing pillar and angle's `id`, `pillarId`, `name`, `audienceNeed`, `angle`,
  and `intent` exactly. `evidenceBasis` may change when new qualified evidence
  becomes available. Refresh hooks and CTAs while keeping each angle a stable
  editorial lens. If a treatment genuinely needs a new meaning, give it a new
  angle ID; never silently redefine an ID already used in an experiment.
  Angle IDs are descriptive lowercase kebab-case and stable across packs.
  The allowed `intent` values are `searchable`, `shareable`, and `both`.
  The allowed `evidenceBasis` values are `qualified-aggregate-performance`,
  `publisher-source-inventory`, and `editorial-hypothesis`.
- Use qualified performance evidence only when the corresponding report marks
  it eligible. A scorecard target gap is a theme suggestion, never proof that
  a template or angle caused a result. If a source or sample is unavailable,
  use source inventory or label a hypothesis; never invent an audience need or
  call an unmeasured theme a winner.
- Angle descriptions name a repeatable editorial lens, not a post fact. Keep
  verified facts in publishers and keep angle descriptions free of numeric
  claims, URLs, personal data, handles, markup, and hashtags.

If a recent Instagram copy-performance brief is supplied after this prompt,
use only template groups with at least three observations as descriptive style
signals. If a GA4 social-link attribution brief is supplied, use only groups
marked eligibleForDescription (at least ten attributed sessions); sessions are
not impressions. Read `copySlot` separately from the source content `kind` so
video copy is not treated as article-carousel copy. Keep `assignmentMode` and
the experiment ID/hash groups separate: Firebase-balanced, deterministic,
fallback, legacy, and separate experiment cohorts are not interchangeable
evidence. If a native social performance brief is supplied, use only metrics
marked `descriptive-sample`; it uses exact post IDs for the join, fixed 72-hour
views/reach windows on Instagram and TikTok, Facebook's first 72 hours from
Meta's exact `created_time`, and LinkedIn's first seven UTC calendar days. Its
values are separate by channel, kind, copy slot, angle, template,
assignment mode, and experiment hash. The dated rolling 30-day benchmark
describes observed outcomes and source coverage only. The default operating
objective is net audience growth per channel, with qualified social-attributed
sessions as a separate secondary outcome. Compare each channel only with its
own baseline; never combine or rank platform rates. The scorecard separately
reports rolling descriptive benchmarks and any qualified frozen 30-day
baseline with its roughly day-90 follow-up. Use a follow-up only when its
status is available; it remains descriptive and never proves lift. If a
channel has `growthTarget90d.status` of `available`, treat it as that channel's
automatic stretch goal, not a forecast, causal estimate, or proof that a
template caused growth. Do not combine channel targets into a global total.
Use a qualified target gap to suggest useful content themes, while preserving
the existing limits on winner claims and posting volume.
Keep experiment winner classes distinct: `engagement` means only the registered
share/save/comment outcome; `post-attributed-follower-growth` requires an exact
native follows metric. A positive channel-level audience trend is only a
promotion guard for engagement experiments, not proof that their copy caused
follower growth.
If the scorecard includes `siteOutcomeGrowth`, use a channel/event result only
when its status is `available`. This is a rolling 30-day session key-event rate
from exact social UTM sources, requiring at least 25 daily observations across
25 days and 100 sessions. It is channel-level evidence; do not map it to a
specific post, placement, or copy arm unless the destination itself carried a
post-specific clickable tag. A frozen baseline and its roughly day-90
comparison are descriptive only, not a forecast, causal effect, or promotion
signal. Missing coverage, an unregistered GA4 key event, or an unavailable
report is not zero performance.
The scorecard businessOutcomeTarget is a provisional operating assumption: at
the roughly day-90 follow-up, seek 25% more qualified tagged sessions per
channel and registered event, with at least 100 sessions in the frozen baseline
and retention of at least 90% of a positive baseline event rate. Read
targetStatus only from an available frozen comparison. A zero-rate baseline
cannot qualify the rate guardrail; an unavailable comparison is not a miss.
Treat any target gap as a content-theme prompt only, never as evidence of
causality, a winner, revenue, or permission to change publishing cadence.
The businessOutcomeTargetCoverage distinguishes all registered UTM channel/event
pairs from active-pilot pairs with a publication recorded in the trailing 30-day
ledger. Read the target status against the active-pilot denominator; unconfigured
or non-publishing channels are outside that comparison, not zero-performance
failures. The wider UTM mapping count reports tracking coverage only.
Read `channelPilots[*].deliveryState` as the source of truth for operational
coverage: `live` has an existing publisher; `draft-only` prepares content while
delivery is held; `blocked` has a configured route that lacks a required grant;
`not-inventoried` has no verified account or integration. Editorial coverage in
the pack never upgrades a channel's delivery state. Keep analytics readiness,
audience coverage, and content-pilot status separate from publication capability.
If a sanitized published-article topic inventory is supplied, use its recent
topic labels and cluster counts to make this week’s editorial angles more
specific to material the site actually publishes. It contains topics and dates
only: it is not a source for facts, audience interest, search demand, or
performance. Keep hooks and CTAs reusable; the publisher must read the current
article or job record and verify all facts, figures, dates, locations, and
destination URLs before publication. An empty inventory means there is no
recent topic input, not that the site had no audience or content.
If the inventory includes `historicalTopics`, use their dated labels and
clusters as older published-topic candidates for ideation only. `ageDays`
marks how old each topic is: do not present historical topics as current
trends, audience demand, or performance evidence, and never reuse their facts
without checking the current publisher source.
If `topicDiscovery.searchDemand.available` is true, use only its closed
categories and thresholded keyword-count bands to help prioritize reusable
angles. The report contains no raw GSC/Suggest query, and its keyword counts
are not people, search volume, or market size. If
`topicDiscovery.recentPublisherNews.available` is true, use its categories only
as a dated ideation hint: the local adapter accepts source items no older than
14 days from at least two HTTPS publisher domains, and emits no headline, URL,
publisher name, or raw item text. Neither signal proves a current social trend
or supplies a factual claim; verify every claim against a current authoritative
publisher source before publication. An unavailable or suppressed category is
unknown, not zero interest.
The inventory may also contain `upcomingTicinoEvents`, an aggregate count by
category from fresh public event sources in Ticino. Use those categories only
to suggest a local programming angle for `facebook.event`; never include an
event title, URL, organizer, person, or invented date, and never treat event
counts as article claims, audience evidence, or performance evidence. The
publisher must verify every event and its date against the live source.
If `faqSearchDemand` is supplied, use only categories whose status is
`available` to prioritize answer-oriented topics. The report is a 30-day
aggregate of closed categories with small groups suppressed. Categories below
the search threshold share the same status whether they had zero or a few
events, and each search, no-result, and answer-open count below ten is omitted.
These are event counts, not unique people, satisfaction, or proof an answer
resolved a need.
Treat repeated no-result counts as candidates to verify against current site
sources; answer-open counts show interaction only. Do not derive success rates
or claim that a category causes social engagement.
The report contains no search text. Suppressed, empty, or unavailable
categories are unknown, not zero.
If `instagramCommunityQuestionDemand.status` is `available`, use only its
closed categories to prioritize a future explainer. The 30-day bands count
distinct public comments classified locally; they are not unique people,
audience size, market demand, social-trend evidence, or content performance.
No comment text, username, identifier, or DM is provided. Suppressed or
not-collected demand is unknown, not zero. Verify every factual claim against
a current authoritative source before publication.
The scorecard marks account-level net follower growth as incomplete until a
dated channel baseline qualifies. Private daily follower snapshots are enabled
for Instagram and Facebook, but a missing or insufficient baseline is not
evidence of zero growth. Use each channel's current scorecard status and
coverage as the source of truth; do not infer values from missing snapshots.
TikTok remains policy-gated unless its exact approval flag is enabled. LinkedIn
has three distinct signals: lifetime audience totals, daily channel-level
followers gained from `memberFollowersCount?q=dateRange`, and exact-post
`follower_gained_from_content`. The daily series is not net account growth or
post attribution; the exact-post metric does not replace the account-level
objective. Telegram's member history is account-level without per-post
attribution. Do not use views, reach, interactions, or either LinkedIn gain
metric as a substitute for account-level net growth, and never treat
account-level deltas as evidence that a specific template caused growth. Use
content-response metrics only as diagnostics.
GA4 `siteActions`, when available, are event counts from sessions that arrived
through tagged links. They are not unique people; `job_apply_handoff` is an
outbound click, not a completed job application. Each action row carries a
versioned event contract, the observed action, the live-property verification
status, and the strongest supported claim; use that contract and do not
overstate an event as a completed outcome. Use only action rows marked
`eligibleForDescription`. An empty list or missing count means no usable
evidence, not zero actions. Treat `actionReportStatus` values other than
`available` as missing evidence, not zero actions.
If `siteActionRates` is present, use only rows marked `eligibleForDescription`.
Those rows use the live GA4-registered per-event session key-event rate and at
least ten sessions for the exact tagged copy cohort. They describe an
attributed session rate, not causal lift, unique people, or a completed outcome
beyond the event contract. An absent or unverified rate stays unavailable;
never substitute `eventCount` for its denominator.
The native brief may contain `instagramStories`. Its exact-ID observations are
already reduced to category/format aggregates from the recent 30-day baseline;
the first-hour and near-24h windows are separate, and metrics below the
three-observation floor are hidden. Interaction/follow/profile rates are
medians per 1,000 Story reach and are unavailable without a positive reach
denominator. `sourceFeedAngleId` and `sourceFeedCopyRevisionId` are linked-feed-
post proxies; they describe the post that seeded the Story follow-up, not text
rendered into the Story image. Treat these as descriptive Story diagnostics
only. Do not interpret them as Story-copy or angle cohorts. Missing Story metrics are
not zero, and Story rows cannot qualify winners or prove that a format caused
follower growth. Do not treat Story metrics as website traffic:
the current static Story format has no verified tagged destination or live
v26 link-click observation.
Use exact `angleId` cohorts from the native and GA4 briefs as descriptive
signals. `copyRevisionId` is a one-way fingerprint of the exact hook/CTA pair;
it does not reveal the copy and is not a randomized arm or winner signal. Keep
channel, kind, format, pack, objective, assignment mode, angle, revision, and
experiment hash separate; do not map a channel-wide result to a specific angle
or copy revision.
Do not declare a winner, infer causality, change objective balance, increase
posting volume, or optimize a rate from insufficient observations. An
unavailable source, missing metric, or empty variant list means there is no
usable evidence, not that the template received zero traffic or performed
poorly. Preserve verified facts outside the copy pack.

Write the JSON only to `/tmp/social-copy-response.json`. Do not edit, commit,
or publish any repository file.
