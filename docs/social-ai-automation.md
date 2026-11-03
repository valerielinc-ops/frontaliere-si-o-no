# Social publishing with Codex

The social publishers use Codex for a scheduled weekly copy pack and a
structured editorial plan with three pillars and three angle IDs per active
channel/format. A push to `main` that changes scoped social inputs or an explicit
`workflow_dispatch` on `main` can also request a complete pack; dispatches from
other refs are skipped before they reserve quota. An atomic Firestore
reservation caps Codex generation at two invocations per rolling seven days
across scheduled runs, pushes, manual dispatches, and reruns. The reservation
fails closed when Firestore is unavailable; an exhausted run skips brief
collection, Codex, and promotion. Workflow concurrency serializes overlapping
runs, while the reservation enforces the durable quota. A generation-only
preview on `main` still counts as an invocation. The pack workflow also sends Codex a sanitized 30-day inventory
of published article topics and cluster counts when available, plus up to 12
historical topics from the prior 365 days with their publication dates, age,
and separate cluster counts. Historical topics are dated ideation candidates only, not current trends
or performance evidence. The brief may also include upcoming Ticino event
categories when fresh event snapshots exist. Availability is explicit: an
empty recent-article inventory is not evidence of current site coverage, and
angles without a qualified source basis remain editorial hypotheses. Source
metadata is context, not a factual source. Pillar and angle definitions remain
stable across weekly packs; each delivered template records its angle ID for
measurement.
The existing publishers continue to select the source posts, verify the
underlying facts, render media, apply canonical tracking links, deduplicate,
and deliver through the existing platform API or browser robot.

## Automated flow

1. A push to `main` that changes the social-content skill, copy prompt/schema,
   or source brief requests a pack; the Monday schedule refreshes it after the
   weekly insights snapshot. Production generation runs only on `main`; a
   dispatch from another ref is skipped before touching the durable quota.
   Each production request first atomically reserves one of two
   Codex invocations allowed in the rolling seven-day window. The same cap
   applies to `workflow_dispatch` and workflow reruns. A denied reservation
   skips brief collection, generation, and promotion; missing Firestore state
   fails closed. No bootstrap dispatch is required. Publishers
   retain their deterministic copy until a validated pack reaches `main`.
2. The Codex job receives editorial instructions, minimized Instagram,
   Facebook, TikTok, and LinkedIn performance briefs when exact IDs, grants,
   and measurement windows are eligible, angle-level outcomes when exact
   attribution exists, and a dated rolling 30-day benchmark,
   a 30-day GA4 attribution and site-action
   brief, an aggregate robot-delivery heartbeat, and CODEX_AUTH_JSON. The GA4 query uses the Firebase service account
   only in a separate read-only collection step. Raw Facebook, TikTok, and LinkedIn post metrics
   stay in private Firestore; client access is denied. Codex receives aggregate
   metrics and exact copy-arm/angle IDs, never credentials, post text, media IDs,
   destination URLs, or user-level data. GA4 session groups require ten
   sessions and site-action groups ten event occurrences before descriptive
   use; native metric groups require three posts. These are descriptive sample
   floors, not statistical significance or winner gates.
3. A separate job validates the exact v4 JSON schema, three-pillar plan, three
   angles per channel/format, even angle assignment, and rejects missing slots,
   duplicate hooks or CTAs, long copy, links, handles, markup, placeholders,
   numeric claims, CTAs without exactly one recognized imperative action, and
   Instagram CTAs that do not match their declared objective.
   Instagram article, job, and border posts have three copy variants for each
   `share`, `save`, and `conversation` objective. Matched-block experiments
   currently register article/job carousels and Reels; weekly border posts
   stay descriptive because their cadence cannot meet the fixed sample within
   the 365-day horizon without increasing frequency. Reels have three
   `follow` variants, one per angle, and use exact-media follows per reach as
   their outcome. Facebook jobs have twelve hooks/CTAs for the existing 24-post
   schedule. Only then does the workflow open a protected PR
   for `data/social-copy-packs/current.json`; required checks and Codex review
   must pass before GitHub's native auto-merge admits the pack to `main`.
4. Publishers ask Firebase Remote Config whether balanced copy assignment is
   enabled. When enabled, a Firestore transaction assigns the least-used
   editorial angle within the channel/slot/objective/treatment cohort; the
   current pack supplies the refreshed hook and CTA for that angle. Assignment
   IDs are hashed, counters persist across pack refreshes, and retries reuse
   the same arm. Matched blocks group by source class without fragmenting by
   weekday. TikTok releases reserved arms on any
   pre-delivery failure and releases the video arm before assigning carousel
   copy when video preparation fails, so unused slots do not skew the balance.
   Reddit waits for a live token before assigning and releases an arm if every
   submission fails. A Firebase outage falls back to the stable deterministic
   selection and records that mode. Dry runs always use deterministic preview
   selection and never write to Firestore.
5. Instagram applies the same generated hook and objective-matched CTA to its
   caption and rendered cover/closing card. Its publisher always retains a
   link-in-bio destination note. TikTok receives its hook on the cover and
   keeps the link-in-bio destination in the caption; generated answer-video
   CTAs also appear on the final card. Facebook, LinkedIn, and Telegram keep
   their canonical destinations in the existing publishers.
6. A missing, stale, malformed, or invalid pack falls back to each publisher's
   existing deterministic copy. Generation failures do not block posting.
7. Where a publisher has an existing ledger, it records copy mode, pack ID,
   copy slot, template ID, editorial angle/pillar IDs, prompt version, hook,
   CTA, and Instagram objective.
   Tagged destinations retain their existing campaign/creative `utm_content` and
   append the pack ID, selected copy slot, template ID, editorial angle ID,
   assignment mode, and a short hash of the experiment ID, so GA4 keeps cohorts separate
   and distinguishes balanced exposure from deterministic fallback. It also
   separates a TikTok video template from article-carousel copy even when both
   promote an article. Insights snapshots and reports carry copy attribution
   without changing sample thresholds or winner selection. Native metrics are
   joined only through exact Instagram media IDs, Facebook post IDs, TikTok
   video IDs, and LinkedIn post URNs. The Instagram Graph fallback may locate a media object by a
   unique nearby timestamp when its posted ledger lacks a media ID. It labels
   that row `copyAttributionStatus: inferred`; the native metric remains
   operationally visible but is excluded from creative reports, Codex
   performance briefs, and experiment readiness. Copy performance requires an
   exact native post ID or media ID, or the unique browser cover-fingerprint join.
   Instagram and TikTok bio-link destinations are not per-post clickable links;
   their UTM values only measure traffic when those destinations are actually
   exposed and clicked.

No per-post approval step is used for channels whose existing unattended route
is eligible. The scheduled workflow opens the promotion PR automatically;
the source-change push trigger also bootstraps the first pack without a manual
dispatch. Manual dispatch promotes a valid pack by default; `promote=false`
remains available for a generation-only preview.
TikTok delivery is held by a policy guard, while its content preview and
read-only measurement stay separate. Existing publisher controls,
deduplication, browser confirmation, and platform readiness checks remain in
force for the other channels.

Every dedicated social publishing workflow and readiness probe requests an
explicit `--only-env` allowlist from Remote Config. Each job receives only the
channel credentials it consumes, the shared copy-assignment configuration
where used, and `GITHUB_PAT` only where a ledger push needs it. Instagram also
loads its GA4 candidate-selection values, Gemini TTS key, and R2 values. The
readiness probe receives only the account fields needed to classify Instagram
and Reddit and to verify the linked Meta Page, Instagram publishing grant, and
publisher token identity; unrelated provider credentials are not exported. The Telegram broadcast loads its GitHub PAT only in the ledger-PR
step's shell, after delivery. The native-insights collector loads its
allowlisted values inside the consuming shell step. The mixed
`post-deploy-publish.yml` workflow retains its existing RC loader for its other
release tasks; its LinkedIn Company Page permission and Reddit approval checks
remain fail-closed.

## Channel coverage

| Channel | Integrated formats | Existing delivery path |
|---|---|---|
| Instagram | existing feed schedule: at most two feed posts/Reels per day; at most six follow-up Stories per day | Graph API and the existing Playwright robot share an atomic Firestore reservation gate; Reels use Graph API only and record the returned media ID |
| TikTok | daily article/job carousels and weekly border content | automated delivery is held pending an eligible, policy-compliant use case; read-only native measurement remains separate |
| Facebook | articles, events/digests, scheduled jobs | existing Graph API schedulers |
| LinkedIn | member-profile article/job posts and Company Page article path | member token and Posts API share an atomic 2/day member cap; Company Page permission currently denied |
| Telegram | daily jobs and weekly border digest | Bot API sends share an atomic 2-message/day channel cap |
| Reddit | article and job hooks/CTAs in the shared pack and existing template builders | classic Data API is `path-refused`; Devvit code is not present in this repository, and its review/CDN feed remain external |

Instagram feed posts and Reels share a two-per-day cap across Graph API,
manual workflow dispatches, and the Mac robot. Story follow-ups use a separate
six-per-day cap, matching the existing maximum of three Stories per run across
the robot's two daily windows. Facebook jobs, articles, events/digests, and the
manual article publisher share a 144-per-day Page cap. LinkedIn Member article
and job posts share a two-per-day account cap; Telegram jobs, border, and
announcement messages share a two-message-per-day channel cap. These are hard
safety ceilings; they do not raise any schedule or authorize additional
volume. Telegram resolves usernames and numeric aliases to the same canonical
chat ID before reserving. An ambiguous daily jobs digest holds its jobs-digest
identity across Zurich midnight until an exact ledger row reconciles it.
Reservations use Firestore transactions, hash account and post identities, seed
active publish-day buckets from existing ledgers, and fail closed if the
ledger, Firestore, or account identity is unavailable. LinkedIn's persistent
post identity follows its existing 30-day content dedup window, so an evergreen
item can return after that window. The weekly scorecard counts ledger sends by
Europe/Zurich day and reports any over-cap
days; it reports ledger coverage only, so a post sent directly in a native app
is not included unless an exact reconciliation path exists. A reservation
remains held after an accepted or ambiguous publication. A transport failure, HTTP 408
or 5xx, or a successful response without the platform post ID remains
ambiguous; non-idempotent Graph publish POSTs are sent once. Only a known
pre-publish failure or explicit non-ambiguous rejection releases the slot.
Facebook schedulers surface an ambiguous outcome as a failed workflow run
while retaining its reservation; they do not retry the POST automatically.
Immediate confirmed posts are charged to the actual Zurich publish day,
including when acceptance crosses midnight. A reservation made within the last
Zurich hour also holds a slot in the following day; confirmation moves it to
the actual day, while an uncertain result keeps both possible days occupied
until reconciliation. This prevents an unresolved immediate request at
midnight from letting the next day's publisher exceed its cap. Facebook
scheduled jobs reserve both their requested `scheduled_publish_time` day and
the following day, then stay held until the daily scheduler reads the exact
Meta post ID and confirms `is_published` with a valid `created_time`. The
ledger, shared cap, and scorecard use that actual timestamp. A still-pending
schedule moves its hold to the current and following Zurich days; read errors
keep the hold and fail the workflow for investigation.
Unresolved identities persist across day rollover until a retained ledger row
confirms publication or a definite failure releases the reservation. Confirmed
publication also writes a separate Firestore identity marker containing only
the platform, hashed account/key, and publication timestamp. This keeps stable
post identities deduplicated after the three-day cap buckets expire, including
the manual Facebook article publisher, without growing one Firestore document.
Ledger reconciliation checks every retained row, not only the daily-cap
window. The unresolved map is bounded and fails closed before Firestore
document limits are approached. If a process dies after a platform accepts a
post but before the ledger/identity marker is written, the reservation remains
safe from replay. `node scripts/social-publish-reservations.mjs --report
--platform=<facebook|instagram|linkedinMember|telegram>` lists only entries
past their planned publish time by at least 30 minutes (configurable, 1 minute
to 7 days), scoped to the configured exact account and cap group. The report
returns hashed reservation identities, timestamps, age, and the safe pending
group plus whether a native-content fingerprint exists; it does not return
account IDs, source keys, native post IDs, or content. New Facebook,
Instagram, and LinkedIn Member reservations store a SHA-256 fingerprint of
their public payload fields before posting. Reconciliation requires the exact
native API read to match that fingerprint, the configured account/author, and
a publish timestamp between 10 minutes before and 24 hours after the reserved
time. Older reservations without a fingerprint remain report-only.
For Facebook, Instagram, and LinkedIn Member, `--resolve-published
--platform=<...> --key-hash=<reported-hash> --native-post-id=<exact-id>` performs
a read-only exact-ID API check before the Firestore transaction can settle the
reservation. It checks the returned ID and published state/timestamp (plus
configured author/account identity and exact payload fingerprint), stores only
hashes of the native ID and payload, and writes a hashed reconciliation audit
record. A missing item,
permission error, timeout, mismatched ID, or non-published state never releases
the reservation. Telegram Bot API has no exact channel-history lookup for a
message ID, so it is report-only. There is deliberately no generic
“not-found means unpublished” path: a negative read cannot distinguish absence
from expired access, deletion, moderation, or a visibility restriction.
Browser clients cannot read or write the reservation collection.

The first read-only Meta check (2026-11-03) used the configured Page token and
returned the Page without `instagram_business_account`; that did not establish
whether the Instagram account is linked. Meta's official Instagram API
collection uses a User Access Token for this Page field, and Remote Config
currently has no `FB_USER_ACCESS_TOKEN` or `INSTAGRAM_ACCESS_TOKEN`. Readiness
now uses the user token to inspect the Page link and its content-creation task
(`CREATE_CONTENT` or `PROFILE_PLUS_CREATE_CONTENT`),
and granted permissions. It compares the configured publisher token with the
Page token returned for that same Page/user token, then verifies the publisher
token resolves to the exact configured Instagram account. `ready` requires all
checks, including the
`instagram_content_publish` grant; missing or ambiguous results remain
`action-required` and keep a deduplicated follow-up open. It does not describe
configured IDs or token presence as proof of publishing capability. See
[Meta's Instagram API collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-3fe78620-2258-44b6-893f-42d76c7200d7).

The Instagram workflow also has an active community loop: the explicitly
selected Graph API path acknowledges allowlisted low-risk comments, redirects
simple link requests to the verified post/site URL, and can publish static
Story follow-ups. Questions needing a source, personal/sensitive content, and
unclear interactions are left for a person. Graph DM replies require a known
timestamp inside the 24-hour window. The Business Suite browser adapter is
read-only because its visible UI cannot reliably establish sender direction or
message age. The worker records hashed local deduplication keys and sends only
weekly aggregate counts, latency buckets, and escalation classes to the private
Firestore insights document. Raw comments, message text, usernames, object IDs,
and private conversation data never enter Codex prompts or the aggregate store.

The native-insights workflow runs every six hours. Its TikTok Display API
collector makes no TikTok API call unless the repository variable
`TIKTOK_DISPLAY_ANALYTICS_APPROVED=true` is set after external use-case review.
Until then its source status is `policy-review-required` and no TikTok metrics
reach Codex. Each collector step loads only the Remote Config keys it needs:
TikTok credentials only when its policy flag is enabled, LinkedIn credentials
only for the daily member run, and the GA4 property only for the weekly site
outcome run. These values stay in the consuming step's shell rather than being
written job-wide to `GITHUB_ENV`; unrelated provider and GitHub credentials are
not exported. The workflow runs LinkedIn Member Analytics once per day. If
TikTok collection is enabled, the native-insights workflow serializes its own
collection runs to protect the rotating user token; any replacement refresh
token is persisted to Remote Config before the access token is returned. The
manual TikTok workflow is a content preview only: it loads GA4 read-only
credentials and does not load TikTok tokens, Remote Config, or a browser
profile, and it does not share the collector's concurrency group. TikTok uses
the separate `video.list` read scope and records public video views, likes,
comments, and shares at a fixed 72-hour age. The collector reads at most ten
20-video pages; when a later page fails or more pages exist, it keeps matched
observations from the returned prefix and marks coverage partial. TikTok
documents Display API for showing creator profiles and videos inside a
product; the current internal analytics collector is not that documented
display flow. Keep collection disabled until TikTok confirms the use case is eligible
([Display API overview](https://developers.tiktok.com/docs/en/display-api-overview)).
LinkedIn uses `r_member_postAnalytics` to read impressions,
member reach, reactions, comments, reshares, link clicks, saves, followers
gained, profile views, and sends for the first seven UTC calendar days. Its
read scope is separate from the existing `w_member_social` posting grant. Both
collectors join only on the published ID or URN already stored in the posting
ledger; no caption/time matching or historical ID fabrication is allowed
([TikTok List Videos](https://developers.tiktok.com/docs/en/tiktok-api-v2-video-list),
[TikTok Video Object](https://developers.tiktok.com/docs/en/tiktok-api-v2-video-object),
[LinkedIn Member Post Statistics](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/members/post-statistics?view=li-lms-2026-10)).
The native collector writes post-level Instagram, Facebook, TikTok, and LinkedIn
rows to the server-only `social_native_insights/current` Firestore document. It prints
only collection counts and source status; post IDs, URNs, and raw metrics are
not written to the public repository or workflow output. Instagram browser
snapshots are uploaded to Firestore from the Mac host; CI exports them to
`$RUNNER_TEMP` only when a report or decision job needs them. The public
`data/instagram-posted.json` remains a minimal post/dedup ledger, with no
Insights measurements.

The first TikTok snapshots remain unavailable until a post carries the exact
`tiktokPostId` in its ledger and the token has the `video.list` scope. TikTok
`publish_id` identifies the publishing operation; a native `post_id` is only
returned for public posts after moderation. The ledger keeps these IDs distinct
and does not treat a private post's operation ID as a native metric join key
([Direct Post](https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post),
[Get Post Status](https://developers.tiktok.com/docs/en/content-posting-api-reference-get-video-status)).
TikTok profile growth also requires `user.info.stats`; verify the analytics purpose
separately from the technical grant. LinkedIn
snapshots remain unavailable until a member token carries the analytics scope.
A permission failure stays visible in the source status; it does not create
zero-valued metrics. Facebook's `followers_count` is now collected daily and
stored only in the private audience history. The first Facebook baseline is
not qualified until at least 25 dated observations span 25 days. The live
probe found the Page below 100 likes and no post-Insights rows; an empty API
response remains unavailable data, never a measured zero. Telegram's existing
Bot API member-count history measures audience change only; it does not
attribute growth to individual posts.

Reddit now has article and job copy slots, used by the existing template
builders for previews and ledger attribution. The classic Data API publisher
is fail-closed even if stale credentials exist: only explicit written Reddit
approval plus `REDDIT_DATA_API_APPROVED=true` can enable it. The Devvit
application is not tracked in this repository, so Reddit still has no live
automated delivery path here. Devvit submission and the job-index integration
remain external follow-up work.

The generator does not enable new posting routes. The LinkedIn Company Page
path consumes the shared LinkedIn article copy when its existing publisher is
invoked, but its permission is currently denied. Reddit copy coverage is in
place; live delivery still requires the Devvit app, its review, and the CDN
feed integration. The first Devvit release should cover articles; job delivery
needs a small per-locale index instead of polling the large build dataset.

Telegram's Bot API member-count history is not the ceiling of available
measurement. Telegram's official MTProto API exposes channel-level audience
statistics and recent per-post views, shares, and reactions to administrators
of channels whose server-reported `can_view_stats` flag is true. Add a
readiness probe and a collector only when that capability and authorized
administrator session are available; otherwise retain an explicit unavailable
status rather than substituting audience counts for post performance
([Telegram channel statistics](https://core.telegram.org/api/stats)).

TikTok's current Content Sharing Guidelines (updated August 4, 2026) explicitly
reject an API utility that uploads to accounts managed by the developer or
team. They also prohibit superimposed brand names, logos, links, and promotional
text in API-shared content. The current scheduled publisher is an internal
team workflow, uses company-branded carousel assets, and does not provide the
required creator-facing preview, express consent, privacy/interactions choices,
or commercial-content disclosures. An unaudited API client is restricted to
private posts. Therefore this workflow is not eligible for unattended public
posting in its current form; an API audit alone does not resolve the internal
utility restriction. Keep native metrics and content preparation separate from
delivery. Do not use browser automation as a workaround. Re-enable delivery
only for a use case and creator-facing product TikTok confirms as eligible,
with brand-free API assets and all required user controls and consent. Any
approved flow must also respect the current creator-specific cap
([TikTok Content Sharing Guidelines](https://developers.tiktok.com/docs/en/content-sharing-guidelines)).
LinkedIn Company Page delivery requires the approved organization-social
permission and an eligible Page role; the current grant remains denied
([LinkedIn permissions](https://learn.microsoft.com/en-us/linkedin/marketing/getting-started?view=li-lms-2026-01),
[LinkedIn app review](https://learn.microsoft.com/en-us/linkedin/marketing/community-management-app-review?view=li-lms-2026-07)).
Instagram API permissions remain governed by Meta App Review and the
current readiness probe, which verifies the Page link and content-creation
task (`CREATE_CONTENT` or `PROFILE_PLUS_CREATE_CONTENT`), the
`instagram_content_publish` grant, that the publisher token matches
the Page token returned for the same user token, and the target account ID; a
missing field or unavailable permission check remains unverified. The
existing `SOCIAL_ROBOT_MODE` and publisher
credentials stay in their existing publisher/robot processes; this change
neither exposes them to Codex nor changes the mode. The upstream skill itself
warns that browser-based posting may violate Instagram's Terms, so its
copy-only design is not treated as authorization for a new browser route. No
post-volume increase is part of this change. The scheduled Facebook jobs
workflow requests 24 posts per day; manual dispatch still offers 1, 24, 72, or
144 jobs, but all Facebook formats now share the 144/day hard Page ceiling.

After this PR is merged, the main-branch source-change trigger generates the
initial pack and opens a separate protected data PR automatically. Until that
PR passes the required checks and merges, deterministic copy remains active.

## Editorial and measurement rules

- Keep factual claims in publisher-rendered content sourced from the site's
  verified dataset. AI contributes only short hooks and CTAs; a publisher-side
  compiler may combine those with verified source facts to produce a
  format-native script, storyboard, on-card transcript, caption, and renderer input.
  The compiler does not invent or rewrite source facts. It skips a post when a
  verified fact cannot fit the renderer's text contract without truncation.
- Instagram's current production kit is compiled from the weekly Codex hook
  and CTA plus publisher-verified facts. Reels use Gemini TTS to read the exact
  publisher-built script; the three visible cards are the matching on-screen
  transcript and their durations follow the audio. The renderer fails closed
  if synthesis or audio rendering fails. No model invents or rewrites factual
  speech, and no separate SRT is claimed. Active Facebook,
  LinkedIn, Telegram, and Reddit formats are text-first and use their own
  publisher composers, so they do not need duplicate visual kits. TikTok
  publishing stays held; Shorts and Threads have no verified account or
  publishing grant. Add a channel-specific asset renderer only after an
  eligible account and supported format are verified.
- Conversation CTAs may ask one substantive open question in comments. Do not
  ask for a keyword DM or promise a follow-up the active worker cannot deliver.
- Keep Instagram's current 24-hour diagnostic and 72-hour decision windows,
  minimum observations, exploration share, and lift thresholds. The cross-social
  scorecard also uses a fixed 72-hour TikTok window and LinkedIn's first seven UTC
  calendar days. Three native posts and ten GA4 sessions/events are descriptive
  sample floors, not statistical significance. Copy metadata is added to reports
  without lowering existing gates or treating insufficient data as a winner.
- Firebase Remote Config controls the balanced-copy assignment, while Firestore
  keeps stable, hashed assignment records and per-cohort counts. Publishers
  release reservations on confirmed pre-delivery skips and explicit non-ambiguous API
  rejection; they retain assignments after accepted API/enqueue delivery and
  when transport failures, HTTP 408/5xx, or missing publish IDs leave delivery
  uncertain. Instagram Graph mutation POSTs are not retried without an
  idempotency key. The audited Facebook,
  TikTok, Reddit, Instagram, LinkedIn, and Telegram paths report release errors;
  multi-post schedulers continue cleanup for other independent reservations.
  TikTok also switches to carousel copy only after releasing the unused video
  arm. The Reddit classic Data API requires both a token and explicit approval;
  an uncertain submission keeps its reservation.
  `.github/workflows/social-copy-experiment-config.yml` reconciles
  the enabled experiment config weekly and on script changes or manual dispatch,
  then prunes hashed assignment records beyond the 450-day experiment retention.
  GA4, Instagram, TikTok, and
  LinkedIn reports keep `firebase-balanced`, deterministic, fallback, legacy,
  and separate experiment IDs/hashes in distinct groups; none declares a winning
  copy arm. The scorecard reports a dated rolling 30-day per-channel benchmark
  and source coverage. Once an audience baseline qualifies, it starts a
  recurring 90-day operating target for that channel using the 25% audience
  floor or the 150% pace stretch, whichever is higher. The first baseline is
  immutable; each later cycle uses a fresh qualified trailing 30-day baseline.
  Accepted endpoints within ±2 days use a proportional threshold shown in the
  scorecard. A separate default GA4 operating target is +25% qualified tagged
  sessions per channel and registered event at the roughly 90-day follow-up,
  with at least 100 sessions in the frozen baseline and a guardrail that retains
  90% of a positive baseline session key-event rate. This is an explicit
  operating assumption, not a business-approved revenue or conversion forecast;
  zero-rate baselines cannot qualify the rate guardrail. Targets are never
  aggregated across channels or treated as causal evidence or permission to
  increase posting volume.
- Native post-level data now enters the feedback loop from Instagram Insights,
  TikTok Display, LinkedIn Member Analytics, and exact-ID Facebook Page Insights
  when IDs, scopes, permissions, and valid measurement windows are available.
  The Codex brief consumes Facebook rows only after exact copy attribution and
  a valid 72-hour snapshot; the current live probe still returns no rows.
  Facebook collection remains gated: Meta documents Page Insights
  as available only for Pages with at least 100 likes, and the current live Page
  probe is below that threshold. The collector verifies Meta's exact
  `created_time` and only accepts a 72-hour snapshot within ±6 hours; ledger
  schedule timestamps are used only to find candidates. The scorecard therefore
  keeps Facebook post metrics unavailable and scheduled-job volume descriptive
  until exact-ID metrics qualify ([Meta Page Insights](https://developers.facebook.com/docs/graph-api/reference/insights/),
  [Meta Post fields](https://developers.facebook.com/docs/graph-api/reference/post/)).
  Telegram's Bot API member-count history measures audience change,
  not individual posts. GA4 describes sessions and allowlisted site actions after
  tagged, clickable destinations; `job_apply_handoff` is an outbound click, not
  a completed application. Instagram and TikTok bio links still do not attribute
  discovery to a specific post unless the matching destination is actually
  exposed and clicked. This is a measurement foundation, not yet a complete
  cross-network growth optimizer.
- The owner has authorized automatic publishing through existing publisher
  credentials, subject to each platform's access grants and posting rules. Reddit
  remains disabled until Reddit grants Data API access and the approval marker
  is set; credentials alone cannot open that path. Codex does not read token
  values or persistent browser state to generate copy. If Codex later needs to
  trigger a platform action, expose the existing publisher as a host-side
  capability rather than adding credentials to the model prompt.
- GA4 feedback covers only sessions that arrive through a tagged, clickable
  destination. The initial live query returned no copy-attributed rows; later
  briefs must treat unavailable or absent rows as missing evidence, not
  as zero traffic or poor performance. The current action report uses GA4
  `eventCount`, an occurrence count rather than the number or percentage of
  sessions that performed an action. `job_qualified_session` now joins that
  descriptive action list as an intermediate job-detail signal; sessionStorage
  deduplicates it when available, while the memory fallback only deduplicates
  during the active page lifetime. Keep the count descriptive and do not call
  it unique people or completed applications. The
  GA4 report now reads Data API metadata and requests
  `sessionKeyEventRate:<event_name>` only for allowlisted actions whose metric
  is registered on the live property; it groups by tagged copy cohort without
  an `eventName` filter so non-converting sessions remain in the denominator.
  Missing registration, metric, or ten-session floor leaves the rate absent;
  never infer a session rate from event counts. Sampling, thresholding,
  truncation, restricted metrics, or `(other)` row loss makes the affected GA4
  report unavailable for attribution; `actionReportStatus` and
  `actionRateReportStatus` preserve the reason for Codex rather than suggesting
  a zero-action result
  ([GA4 Data API schema](https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema)).
- Every business action used in a report or experiment needs a versioned event
  contract: event name, funnel stage, user action actually observed, GA4
  key-event status, attribution grain, eligible destination tags, and the
  strongest claim the event supports. `job_qualified_session` means the
  job-detail qualification event fired for a tagged cohort; it does not prove a
  unique person or application. `job_apply_handoff` means a click from a job
  page to an employer; it does not mean an application was started or completed.
  Do not call a site visit, outbound click, or newsletter
  open a lead or completed application. If a destination or key-event
  denominator is unavailable, keep its counts descriptive and disqualify it
  from automatic promotion.
- The GA4 social-copy brief and site-outcome ledger share event-contract
  version 1. The brief labels `job_apply_handoff` as a repository key-event
  contract while explicitly verifying the live key-event registration from GA4
  metadata; the other event rows retain their observed action and evidence
  limits. The weekly scorecard reports site outcomes only at tagged-channel
  session grain. Its target-coverage line separates the full registered UTM
  mapping from active pilot channel/event pairs with a publication in the
  trailing 30-day ledger, so unconfigured channels do not dilute the active
  pilot denominator. Profile/bio traffic cannot identify the discovery post,
  and a channel-level rate must never be presented as a post or copy-arm result.

## Growth plan after critical review

The current system is a copy, distribution, and measurement foundation. It is
not yet a complete growth optimizer: Codex selects reusable hooks and CTAs,
while the Instagram publisher compiles source-specific carousel and Reel kits
from those lines plus verified facts. That compiler does not make a new Codex
call or generate factual claims. Active text-first channels already use native
publisher composers; candidate video channels stay unconfigured until account
and grant probes pass. The weekly v4 Codex batch returns a structured editorial
plan by pillar, channel, format, audience need, and stable angle ID, refreshed
from sanitized rolling 30-day performance and source briefs. Publishers record
only the IDs; native and tagged GA4 briefs expose those cohorts only when their
joins are exact. The weekly scorecard now reports per-channel pilot
readiness, cadence configuration, publication-ledger coverage, exact-ID metric
joins, and stop criteria. These checks measure operational readiness, not lift.
Some audience-growth metrics remain unavailable. The default operational
audience-growth and GA4 session targets are reported separately; the GA4 target
is a provisional operating assumption, not an owner-supplied business forecast.
Keep three outcome groups separate:

- **Audience growth:** net followers or subscribers and profile-to-follow
  conversion, when the platform exposes them under an approved scope.
- **Content response:** reach or views at fixed platform-specific ages, video
  retention where available, and saves, shares, or comments per reached account
  or view. Never compare these rates across different platforms.
- **Useful site outcomes:** social-attributed sessions and session-based rates
  for configured GA4 key events. Keep event counts descriptive;
  `job_apply_handoff` remains an outbound click, not a completed application.

Default operating objective, with no per-post or per-experiment owner approval:
grow net followers per channel, with qualified social-attributed sessions as a
separate secondary outcome. This primary metric is not yet measurable for
Instagram or Facebook until their private daily snapshots qualify a baseline;
TikTok remains held for its use-case eligibility and has no approved follower
history. The LinkedIn collector now requests
`memberFollowersCount?q=dateRange` for daily channel-level follower gains when
the profile-analytics grant works; this is distinct from the lifetime audience
snapshot and from `follower_gained_from_content`, which is attributed to an
exact post URN. LinkedIn member-post metrics remain uncollected by default and
cannot enter winner evaluation until the storage rule is clarified in writing.
Telegram has member-count history without per-post attribution.
Do not use reach, views, interactions, LinkedIn's aggregate daily gains, or
post-attributed follower gains as a proxy for net audience growth. The scorecard
keeps each definition separate and exposes incomplete coverage.
The weekly native-insights workflow now queries a 30-day GA4 window in the
property's time zone, ending after the shared two-day processing lag. It keeps
daily session counts and registered key-event session rates by exact UTM source
and event in private Firestore. Only the allowlisted GA4 key-event metrics are
queried; campaign names, content tags, URLs, user identifiers, and event-level
counts are not persisted in this outcome ledger. An incomplete, sampled,
thresholded, restricted, truncated, or time-zone-unknown report cannot create
observations or zeros. A missing exact UTM source in a complete report is a
zero-session day, not a per-post attribution or a content-quality judgment.
The scorecard still needs at least 25 daily observations spanning 25 days and
100 sessions per channel/event before it freezes that first eligible 30-day
baseline. A qualified audience baseline unlocks an automatic per-channel
90-day operating target: net audience growth of at least 25% of the audience
at the start of the cycle, or 150% of the prior 30-day pace projected across
90 days when that is higher, with a one-member minimum. The accepted 88–92-day
endpoint is compared against a proportional threshold. After that endpoint and
a fresh trailing 30-day baseline with at least 25 observations spanning 25
days qualify, the next cycle starts automatically. The first baseline remains
immutable; if a next-cycle baseline is unavailable, the prior result and
waiting status remain visible. This audience-growth stretch goal is neither a
forecast nor an owner-approved business-outcome target, and the scorecard does
not combine channels into one number. It does not authorize a volume increase
from descriptive reports alone. Facebook's scheduled jobs are 24/day and a
manual dispatch can still choose 1, 24, 72, or 144; the shared Page ceiling is
144/day across publishers. The scheduled volume remains unoptimized until exact
post metrics become available.

### Attribution eligibility by channel

The evaluator must consume this channel contract, rather than assume that
every platform can answer the same growth question. A missing source or grant
keeps the channel in measurement-only mode; profile-level changes never get
credited to a particular post by timing or similarity.

| Channel | Account audience evidence | Exact post evidence | Experiment eligibility |
|---|---|---|---|
| Instagram | Private daily follower snapshots are collected when the existing account grant is valid; the first account-level baseline still needs 25 dated observations over at least 25 days. | Carousels and Graph API Reels join by the exact returned media ID. Reels probe `views`, per-media `follows`, watch-time, and skip-rate independently; missing optional metrics remain unavailable, never zero. | Reels use one `follow` objective and test exact-media follows/reach at 72 hours. The 25-post baseline may span up to 120 days; registration remains closed unless the exact `follows` metric is available and the observed cadence projects the fixed sample to finish within 365 days. Account net-follower growth stays a separate channel-level outcome. A site-action experiment still requires a clickable, post-specific tagged destination and configured GA4 key-event rate. |
| TikTok | `user.info.stats` is the documented scope for follower counts; require a granted user token and confirmed eligible use case. | `video.list` scope, exact published video ID, and the fixed 72h window; keep all TikTok rows out of AI briefs unless the policy-review flag is enabled. | Account follower deltas cannot identify a winning post. No follower-arm promotion until TikTok exposes approved post-attributed follows; otherwise only a separately attributed site-action outcome may qualify. |
| Facebook Page | Private daily `followers_count` snapshots are collected; a baseline still needs 25 dated observations over at least 25 days. | The latest live probe found the Page below 100 likes and returned no post-Insights rows; the collector rechecks `fan_count` and does not treat an empty result as zero. | Account follower change is descriptive; no post-level promotion until an exact-ID probe returns supported metrics and an observation window. |
| LinkedIn member | Daily lifetime follower count through `memberFollowersCount?q=me`; requires `r_member_profileAnalytics`. The same API's `q=dateRange` reports daily channel-level gains; missing dates remain unknown. Both series are private and distinct. The access-token helper refreshes on publisher/collector runs and persists a changed refresh token to Remote Config with ETag protection. | Exact member post URNs and analytics are collected only when the repository variable `LINKEDIN_MEMBER_POST_ANALYTICS_STORAGE_APPROVED` is exactly `true`; otherwise collection stops and existing per-post metric rows are pruned. | Daily gains are channel-level, not net and not post-attributed. Exact post attribution remains the separate `follower_gained_from_content` metric on exact URNs under `r_member_postAnalytics`, but winner evaluation stays closed until LinkedIn's applicable storage duration is confirmed in writing. The public rules set 48 hours for Members' Social Activity Data and apply the shortest limit when categories overlap; the app review also checks data-storage compliance. [Member Follower Statistics](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/members/follower-statistics?view=li-lms-2026-10), [data storage requirements](https://learn.microsoft.com/en-us/linkedin/marketing/data-storage-requirements?view=li-lms-2026-05), [app review](https://learn.microsoft.com/en-us/linkedin/marketing/community-management-app-review?view=li-lms-2026-07) |
| Telegram | Bot API member history is an account-level series, not post attribution. | MTProto post statistics require an eligible channel and admin `can_view_stats`. | No post-level follower promotion from member deltas; post response stays diagnostic until exact per-post stats are available. |
| YouTube Shorts | Candidate only; verify account ownership, OAuth, and the current subscriber metrics. | Candidate only; use exact video IDs and a fixed native observation window. Freeze the metric definition/version before the pilot. | No experiment until the account, scopes, subscriber attribution, and per-video data contract pass the probe. |
| Threads | Candidate only; verify real account, publish/read grants, and supported metrics. | Candidate only; require exact post IDs and a documented observation window. | No experiment until the same account, scope, attribution, and data-quality gates pass. |
| X | Candidate only; no X account, API access tier, or publisher connector is verified in this repository. | Candidate only; require exact post IDs and supported post metrics under confirmed API access. | No experiment until account, API access and cost, attribution, rate limits, retention, and policy checks pass a read-only probe. |
| WhatsApp Channels | Candidate only; no channel publisher or analytics connector is configured in this repository. | Candidate only; confirm a supported official publishing and measurement path plus exact message identity. | No experiment until account, official API capability, permissions, privacy, attribution, cost, and policy checks pass a read-only probe. |
| Reddit | No live delivery or native analytics path in this repository. | Devvit delivery identity and the supported analytics contract remain external. | No experiment or automated publishing until review, domain access, an explicit app-owned posting identity, and measured post IDs are available. |

Keep a visible `not-probed`, `permission-missing`, `policy-review-required`,
`partial`, or `available` status per source. A channel can continue its
already-authorized publishing path while remaining ineligible for optimization.
TikTok profile counts are available in its User Info API only with the
`user.info.stats` grant; that technical scope does not itself establish that
the internal analytics use case is approved ([TikTok scopes](https://developers.tiktok.com/docs/en/tiktok-api-scopes),
[Get User Info](https://developers.tiktok.com/docs/en/tiktok-api-v2-get-user-info)).

### Learning cadence and data freshness

Keep collection and AI generation on separate clocks to limit quota use:

- Run existing source collectors at their supported cadence and persist each
  observation's `snapshotAt`, metric window, coverage, and source status.
- A channel's first frozen 30-day audience baseline requires at least 25 dated
  observations across at least 25 UTC days and a latest observation no older
  than 48 hours. Freeze each channel independently and never replace that
  initial baseline. Retain 130 days; after each qualified target endpoint the
  collector freezes the trailing 30-day window as the next cycle's pace
  baseline while retaining the initial baseline and last completed cycle.
  Compare only the same metric/source; each 90-day endpoint must have an
  observation within ±2 days and no older than 48 hours when the next cycle is
  advanced. Missing endpoint or baseline evidence keeps the current cycle
  visible and prevents an automatic reset.
- Build the descriptive scorecard once per week without invoking Codex. A
  Monday UTC run of the existing native-insights workflow emits it. Each source stores its last successful collection; a source
  is stale after two expected collection intervals. Stale or partial data is
  deduplicated by source/status in a private Firestore weekly snapshot and
  cannot update a winner. The workflow does not create one issue or model call
  per signal.
- Keep one batched Codex content-pack generation per week. Its GA4 and native
  performance briefs are rolling 30-day snapshots and can overlap between
  weekly packs; use each run only as a current descriptive input, never sum
  observations across packs or treat repeated rows as independent. Do not
  spend an extra model call for every collector run or post; a weekly pack
  refresh is the sole recurring Codex call in the publishing loop.
- Evaluate an experiment only once after its preregistered sample and fixed
  observation window have closed. Do not repeatedly peek at a live arm. If its
  window, ID coverage, or source freshness is incomplete, keep the incumbent
  and record `inconclusive`.
- The weekly report records audience snapshots and website outcomes separately
  from post-level response. It can trigger a status/health action, but cannot
  change publication volume or a winner from descriptive data alone.

### Robot delivery observability

The Mac-hosted Instagram robot records a private heartbeat after each completed
run. It includes the run mode and outcome, queue depth, expired-entry count,
oldest pending age against that content kind's TTL, UI-confirmed publishes, and
confirmation-workflow dispatch failures that need retry. It excludes queue
entries already matched to the confirmed ledger or successfully published
during that run. It stores no post IDs, captions, URLs, browser state, or
account data. The weekly scorecard labels the heartbeat stale after 36 hours
(three expected 12-hour windows) and separates queued content from UI-confirmed
publishes; a missing heartbeat means the Mac host has not completed a reportable
run, not that the queue is empty. This telemetry
is operational health only: queued items and confirmation dispatches are not
evidence of audience exposure, content quality, or a visible post. It does not
increase cadence or override TikTok's delivery hold.

An explicit single-channel robot run retries confirmation dispatches only for
that channel. Its heartbeat is marked partial and does not refresh the
full-channel success timestamp. A failed retry is counted and returns a failing
host exit status so the scheduler can surface it. A TikTok-only run still
records the held channel and can reconcile its idempotent internal
ledger-confirmation workflow without opening the browser or attempting a post.
Full-channel runs reconcile confirmation retries for both requested channels,
including a held delivery channel; the policy hold blocks publishing but not
the internal ledger-confirmation workflow.

Firebase now assigns copy arms with cryptographically random tie-breaking
inside a frozen block for each channel, format, objective, and source class.
The scheduled weekday is retained as context but does not split a block. The
experimental unit is one delivered post. A block cycle contains one delivery
per registered editorial angle; publisher reservations are persisted before
delivery and closed only after an exact native post ID is accepted. Weekly
packs refresh hooks and CTAs while preserving angle treatment definitions, so
the experiment compares the same treatment across pack refreshes.
Instagram Reels now publish through the Graph API and record Meta's exact media
ID. Their optional views, per-media follows, watch-time, and skip-rate metrics
are probed independently; a failed or unsupported metric does not erase the
base reach/saves/shares/comments observation. The v4 copy pack gives Reels one
follow objective with three stable editorial-angle arms. The protocol can
register only when exact-media `follows` and reach are both available for at
least 25 baseline posts across 25 distinct days within the 120-day Reel window.
Registration still stays closed
when the observed rate, planned sample, and number of arms project completion beyond 365 days; no
statistical threshold is relaxed to force activation. Article/job
carousels and LinkedIn member article/job posts continue through their own
qualified exact-ID cohorts. No cohort activates until its source permission is
healthy and its private, exact-ID baseline qualifies.
Scheduled Reel credential, rendering, upload, or Graph API failures now fail
the workflow visibly and trigger the existing failure report; source-data
absence and duplicate-slot skips remain non-fatal.

Each immutable registration freezes the post-level metric and native window,
the baseline mean/variance, minimum detectable effect, fixed sample size, power,
and a 5% pack-level error budget. The budget is Bonferroni-divided across the
pack's candidate cohorts; Holm then adjusts pairwise arm comparisons within a
cohort. Instagram article/job carousel tests use 72-hour shares/reach,
saves/reach, or comments/reach matched to the registered CTA. Weekly border
carousels are not registered as experiments: their current cadence cannot
complete the fixed sample within 365 days. The Reel follow
cohort uses exact-media follows/reach at 72 hours. LinkedIn tests use exact-post
`follower_gained_from_content` per impression in the first seven UTC days.
Account follower changes, views, sessions, and engagement totals do not stand
in for a post-attributed follower outcome. The historical baseline needs at
least 25 exact post observations across 25 distinct days, ending within seven
days of registration. Its maximum span is 45 days for other slots and 120 days
for Reels. It powers a fixed sample of at least 25 matched block cycles; the
observed cadence must project the full sample and metric window to finish within
365 days. The existing three-post and ten-session/event floors remain
descriptive only.
For Instagram article and job carousels, the baseline population uses
exact Codex posts from the same slot across the supported share, save, and
conversation objectives; each cohort still uses its own preregistered metric.
This population estimates that metric's baseline mean and variance for MDE and
power planning. It does not enter the randomized outcome sample, whose rows
still have to match the frozen registration hash, objective, arm, block, exact
post ID, and measurement window. Reels and LinkedIn retain their cohort-specific
baseline population.

The evaluator uses a paired sign-flip randomization test on block-level rates,
with a family-wise confidence bound and a fixed stopping rule. It runs a
reproducible synthetic A/A simulation before enabling assignments, caches the
certificate by protocol fingerprint, and requires its 95% Wilson upper bound
on false-winner rate to stay at or below 8%. There are no interim significance
looks. Missing or expired blocks, less than 95% exact metric coverage, duplicate
post IDs, an open reservation, a stale or unhealthy source, or a failed A/A
certificate all hold the cohort. Exact native post rows can reconcile an
accepted assignment whose publisher marker failed; an ambiguous delivery with
no exact row stays open and blocks promotion.

For the net-follower objective, require a platform metric that attributes new
followers to the exact post or copy arm. Account-level follower deltas alone
cannot identify a winning post when several posts ran in the same window.
LinkedIn's `follower_gained_from_content` can support that outcome when its
grant and exact URN are available. Instagram Reels can use exact-media `follows`
when the API returns it for the post; views, reach, interactions, Telegram member
change, and unlinked bio traffic cannot substitute for post-attributed follows.
Where the platform does not provide a valid follower attribution metric, do not
promote an arm as a follower-growth winner. A separate, explicitly predeclared
qualified-session objective may be evaluated only when click attribution is
specific to the post or arm.

The existing daily `instagram-insights-decision` command uses minimum-count and
lift thresholds to show descriptive candidates, but those thresholds are not a
significance test. Its Remote Config write path now remains closed. Publishers
also quarantine any legacy winner map until a qualified protocol version is
present, while the stored Remote Config value itself remains untouched.

The scheduled native-insights workflow now freezes registrations and evidence
privately, evaluates the exact fixed sample, and reconciles a schema-v4 Firebase
Remote Config winner map keyed by stable editorial angle. Publishers resolve a
verified winning angle to that angle's current-pack hook and CTA. A winner is
promoted only when one arm clears every Holm-adjusted comparison and the
predeclared MDE. Carousel winners are engagement winners for their registered
share/save/comment rate; they are never labeled follower-growth winners.
Promotion requires a fresh, qualified 30-day account-level audience series
(at least 25 distinct days spanning 25 days, newest snapshot within 48 hours)
with non-negative net follower change. A negative or unqualified series holds
the engagement winner. This is a conservative channel safety signal, not causal
attribution to the tested copy, and posting cadence stays capped.
A later
guardrail or source-policy failure removes that winner and disables the cohort;
the next healthy run may re-enable the frozen registration. Insufficient sample
or missing attribution leaves the copy deterministic. The scorecard and Codex
brief remain descriptive and make no causal claim from aggregate account data.
Registrations span pack refreshes through a stable semantic treatment
fingerprint, so the experiment tests editorial angles, not frozen hook wording;
the current pack supplies each selected angle's hook and CTA. A claim about a
specific hook or CTA needs its own frozen text-level treatment.
The v4 configuration carries each registration's fixed deadline. An unfinished
cohort expires at 365 days, publishers stop opening assignments after that
deadline, and a fixed sample with no winner closes assignment. A qualified
winner remains selected while policy and measurement guardrails stay healthy.
Publishers reject schema-v3 configurations, including deadline-free maps.
LinkedIn member-post experiments additionally require the explicit retention
approval variable and matching approval state in the private source document;
the default is closed because the public 48-hour rule's applicability to
authenticated-member post counters is unresolved.

### Community response and channel pilots

The Instagram community worker now exposes its 24-hour response promise as an
aggregate service contract: it persists eligible/replied/skipped/error counts,
latency buckets, and escalation reasons, without comments, DMs, usernames,
account IDs, or private conversation text going to Codex. It replies only to
eligible comments and user-started conversations. Verified factual or
site-navigation questions may get a source-grounded reply; legal, tax,
immigration, employment-advice, personal-data, harassment, threats, or ambiguous
cases get a safe redirect or remain unanswered. The report excludes skipped
sensitive interactions from the 24-hour response denominator and keeps
Business Suite counts separate when direction or age cannot be proven.

Shorts and Threads probes must record account readiness, granted scopes,
account-audience baseline, exact post-ID availability, supported metrics,
measurement delay, production time, and link attribution before any pilot.
Use a four-week organic pilot with a predeclared per-channel cadence cap and no
paid spend; keep the weekly Codex batch and reuse approved assets.
Continue only when required data arrives on time, attribution is intact, and
the preregistered sample/power plan is feasible. Stop the pilot if the grant or
policy changes, the metric contract fails, coverage remains partial for two
collection intervals, or the production cap is exceeded. A pilot that cannot
reach the required sample is descriptive and cannot justify scale. For Shorts,
freeze the exact YouTube Analytics metric definition used in the pilot rather
than mixing `views` and `engagedViews` ([YouTube Analytics metrics](https://developers.google.com/youtube/analytics/metrics)).
For Reddit, the Devvit plan must name the app-owned posting identity and prove
that it does not automate posting on behalf of an end user before submission;
review and domain access remain external ([Devvit rules](https://developers.reddit.com/docs/devvit_rules)).
The current distribution plan still focuses on owned accounts. Partner or
creator referrals need a named partner, an agreed offer and destination, and a
measured referral goal; prepare tracking materials only when those inputs exist,
and do not send outreach by inferring recipients from public profile data.

Instagram metric snapshots now live in private Firestore. The tracked snapshot
was migrated and removed from the current branch; its old Git history remains
public. The minimal posted ledger stays tracked for publisher deduplication and
browser confirmation, but does not contain Insights metrics.

The current implementation keeps TikTok held and Instagram Insights private;
collects audience, post, and GA4 outcome snapshots; reports community response
and Instagram carousel-robot delivery; compiles native Instagram carousels and
Graph API Reels from the weekly Codex pack; and emits weekly source-freshness
and per-channel pilot-readiness reports. Reels store Meta's exact media ID and
private post metrics. Active text-first publishers retain their native
composers. These steps use no extra per-post Codex calls.

Reservation paths release on confirmed skips, explicit rejections, and
payload/render failures before submission. Ambiguous network outcomes retain
their assignments to avoid biasing retry selection or duplicating accepted
posts. Release errors are reported, and exact native rows can reconcile an
accepted delivery whose immediate marker failed. The qualified protocol is
implemented for exact-ID API-backed Instagram carousels and LinkedIn member
posts. Other formats remain descriptive or policy-held until they provide exact
post identity, an approved native metric, a fixed window, and a healthy grant.
Instagram and Facebook follower snapshots measure account-level change; they
cannot attribute new followers to an individual post. No live winner is claimed
until scheduled production data reaches its preregistered sample and passes the
same guardrails.

| Priority | Work remaining | State and next step |
|---|---|---|
| 0 | Keep TikTok Direct Post API and browser-robot publishing held. Keep API-prohibited branding off any future TikTok API asset. | **in questa PR. Motivo:** TikTok rejects an internal uploader for team-managed accounts and requires an interactive creator flow. **Prossimo passo:** keep delivery held until TikTok confirms an eligible use case and the reviewed product meets its requirements. |
| 1 | Move Instagram Insights out of tracked files and keep the public post ledger minimal. | **in questa PR. Motivo:** the current snapshot is private in Firestore and the Mac/CI readers use that store. **Prossimo passo:** keep future snapshots private; earlier public Git objects still contain the old snapshot and need a separate coordinated history-cleanup decision if removal is required. |
| 2 | Set the default operating objective and expose follower-metric coverage honestly without per-post approval. | **in questa PR. Motivo:** the objective is explicit and private daily follower collection is implemented for Instagram, Facebook, and the LinkedIn member endpoint; LinkedIn requires `r_member_profileAnalytics`, and no history is deployed or long enough to qualify a baseline, while TikTok's use case is held. Telegram's member history is not net follower history. **Prossimo passo:** let the scheduled collectors accumulate dated observations and keep content metrics diagnostic until a channel baseline qualifies. |
| 3 | Persist the first complete 30-day baseline for channel-specific audience and useful-site outcomes. | **blocked: live scheduled data after merge. Motivo:** the collectors and baseline logic are present, but no merged live run has confirmed event registration or sufficient traffic. **Prossimo passo:** after merge, let the schedules run, verify the registered event list and exact UTM coverage, and freeze only channel/event baselines with 25 daily observations across 25 days and, for GA4, 100 sessions.** |
| 4 | Measure aggregate response and outcomes from the existing Instagram community worker, including its 24-hour response promise and safe escalation classes. | **in questa PR. Motivo:** the Graph path classifies low-risk acknowledgements and simple redirects, escalates sensitive/unsupported requests, enforces known DM age, and persists hashed-event-derived weekly counts, latency buckets, and escalation reasons privately; Business Suite is read-only because it cannot prove message direction or age. **Prossimo passo:** use the weekly scorecard to observe real coverage and SLA outcomes; browser counts remain thread-list-only and Graph totals remain bounded by platform pagination. |
| 5 | Use the weekly Codex pack in the native formats of currently eligible channels. | **by construction. Motivo:** Instagram carousels and Reels compile the selected Codex hook/CTA with verified source facts; text-first Facebook, LinkedIn, Telegram, and Reddit use their existing native composers. TikTok is policy-held, while X, WhatsApp Channels, Shorts, and Threads have no verified account or grant, so a cross-channel video-asset schema would produce unused outputs. **Prossimo passo:** add a channel-specific asset renderer only after an eligible account and supported format are verified; retain one weekly batch and avoid redundant per-post calls. |
| 6 | Qualify exact-ID Instagram per-media Reels metrics; finish TikTok/LinkedIn metrics; qualify Facebook post metrics; probe Telegram MTProto and TikTok Display API use-case eligibility. | **blocked: live account probe, baseline, and external grants. Motivo:** the Codex brief now accepts Facebook exact-ID rows with validated Meta publication time and the fixed 72-hour window, but the current Page is below 100 likes and the live probe returned no rows. Reels probe follows, views, watch time, and skip rate, but no live response has verified optional metric coverage or whether the fixed sample fits the 365-day horizon. TikTok's internal analytics use case needs platform confirmation plus `video.list`; LinkedIn post metrics need `r_member_postAnalytics`, and its member follower endpoint needs a fresh member consent for `r_member_profileAnalytics`; Telegram statistics require an eligible channel and admin `can_view_stats`. **Prossimo passo:** let the private collector probe exact published Reel IDs and activate the follower cohort only if `follows` and reach qualify; retain unqualified metrics as descriptive, and re-probe Facebook, TikTok, LinkedIn, and Telegram only when their eligibility changes.** |
| 7 | Implement and then qualify randomized-block experiments and automatic promotion/rollback. | **blocked: live scheduled qualification and external metric grants. Motivo:** protocol v3 estimates article/job carousel baseline variance from exact same-slot metric rows across rotating objectives, while preserving 25 observations over 25 distinct days, the 45-day recency span, power/MDE, 5% family error, A/A calibration, and exact metric coverage. Weekly border content stays descriptive because its current cadence cannot meet the fixed sample within 365 days. Pack-refresh crossing is supported by the stable angle fingerprint and tests; winner selection is angle-level, not a frozen hook/CTA test. Remote Config v4 carries registration deadlines, stops new assignments after 365 days, closes a fixed sample with no winner, and keeps a qualified winner only while guardrails remain healthy. Promotion now also requires a fresh qualified non-negative 30-day audience trend; this account-level signal is not attributed to an individual post. No merged live run has qualified a baseline or fixed sample; Reels and LinkedIn also need exact metrics, grants, and policy clearance. **Prossimo passo:** after merge, verify scheduled registration/deadline reconciliation, then qualify each cohort from private exact-ID reports; do not increase cadence or promote a winner until its fixed sample and audience safety gate pass.** |
| 8 | Add a branded social landing hub with stable redirect keys and UTMs for actual clickable destinations. | **in questa PR. Motivo:** `/social/`, the stable `/social/r/<hash>/` redirect registry, and sitemap discovery are implemented; Instagram's supported publishing API does not expose a bio-edit operation, so profile URL changes cannot be completed through this Graph integration. **Prossimo passo:** set the hub URL once in each account's profile editor, then preserve channel/placement UTMs; do not claim per-post attribution unless a clickable destination carries a post-specific tag. |
| 9 | Compare X, WhatsApp Channels, YouTube Shorts, and Threads as next channels after a real account, audience, analytics, and posting-grant probe. | **blocked: account and platform grants unavailable. Motivo:** the repository has no verified account, audience history, publisher/analytics connector, or confirmed API scopes for these networks; the weekly scorecard now shows X and WhatsApp explicitly as unconfigured, alongside Shorts and Threads. **Prossimo passo:** verify accounts and official API use cases, access and cost, exact post/message IDs, supported metrics, freshness, attribution, and production caps before any four-week organic pilot with preregistered stop criteria and no paid spend.** |
| 10 | Connect Reddit copy to a Devvit app and published CDN feeds after supported domain access and review. | **blocked: external Reddit review and domain access. Motivo:** the repository has no approved Devvit app or supported domain grant for the proposed app-owned publishing identity. **Prossimo passo:** create the app, document its app-owned identity and non-user-acting flow, request domain access, and submit it for review before implementing delivery.** |
| 11 | Build the weekly freshness/coverage loop and connect its evidence to the weekly Codex refresh. | **in questa PR. Motivo:** Monday's collector emits a deterministic scorecard, measures freshness after two source-specific intervals, and persists one private deduplicated health snapshot per UTC week; the following bounded Codex batch receives only sanitized aggregate briefs. **Prossimo passo:** keep the weekly schedule as the normal refresh, recognize that eligible source pushes and manual dispatches can trigger additional pack generations, and never add a call per collector run or post.** |
| 12 | Add channel-pilot observability without increasing Codex quota. | **in questa PR. Motivo:** the weekly scorecard now reports each channel's delivery path, configured cadence cap, ledger-based cap overruns by Europe/Zurich day, 30-day publication count, exact-ID coverage, eligible measurement-window count, metric joins, held/unconfigured state, and stop criteria; it includes separate held rows for the LinkedIn Company Page, X, and WhatsApp Channels identities. It reports aggregates only and makes no Codex call. Telegram counts one Bot API message per jobs digest, not one post per included job; legacy rows are grouped by near-identical send times. Instagram cadence includes the Monday/Friday reserved Reel slots, while Story-ledger overrun coverage remains unavailable. **Prossimo passo:** after merge, verify the first weekly scorecard against live ledgers and keep cadence increases disabled until each channel's experiment is independently qualified. |
| 13 | Track unattended Instagram robot delivery and queue freshness separately from prepared content. | **in questa PR. Motivo:** each completed Mac-host run now writes a private aggregate heartbeat; the weekly scorecard distinguishes live, dry-run, policy-held, queued, expired, overdue, partial-channel coverage, and confirmation-pending states without storing post identifiers or content. Retry failures for prior UI-confirmed posts are included in the aggregate and fail the host run, while their queue rows are not misreported as awaiting publication; missing or invalid expiries match the publisher's expired-row behavior. **Prossimo passo:** after merge, confirm the first heartbeat and weekly summary; a stale or missing report must remain visible as a host/telemetry failure, never as a successful publish. |
| 14 | Add distribution and referrals beyond the owned accounts. | **blocked: no partner campaign or approved recipient list exists. Motivo:** owned-account publishing and tracked links cannot create partner reach by themselves, and outreach needs a real recipient, approved offer, and channel-specific terms. **Prossimo passo:** prepare a tracked partner campaign with a named partner, agreed destination, and measured referral goal before building or sending outreach; do not infer a partner or contact from public profile data.** |
| 15 | Extend the weekly Codex batch from reusable copy into a measurable editorial-angle plan for each eligible channel and format. | **in questa PR. Motivo:** schema v4 requires three pillars and three angles per channel/format, distributes templates evenly across angles, carries angle/pillar IDs through publishing ledgers and exact native joins, and supplies an availability-marked source inventory; on 2026-11-03 it contained no recent article topics (`available:false`, `sourceCount:0`) but did contain 156 upcoming Ticino events from 8 fresh snapshots, the weekly brief now also supplies up to 12 topics published in the prior 365 days, with publication date and ageDays in a separate historical section. Codex may use these only as dated ideation candidates, never as current trends or performance evidence. The 30-day recent-article window remains empty and no article angle has qualified performance evidence. **Prossimo passo:** after merge verify that the weekly brief carries both windows, keep every fact anchored in current publisher sources, and leave unsupported angles labeled as hypotheses until recent coverage or qualified live evidence becomes available; require exact follows/reach evidence before Reel promotion.** |
| 16 | Clear LinkedIn member-post analytics storage terms before retaining exact post metrics or enabling winner evaluation. | **blocked: external platform policy clarification. Motivo:** LinkedIn's public storage table allows 48 hours for Members' Social Activity Data and requires the shortest limit when categories overlap; it does not clearly state whether counters for the authenticated member's own posts are exempt. Collection and per-post retention now fail closed unless `LINKEDIN_MEMBER_POST_ANALYTICS_STORAGE_APPROVED` is exactly `true`, and the runner also requires that variable before admitting a LinkedIn experiment. **Prossimo passo:** obtain written LinkedIn confirmation or an approved retention basis; set the repository variable only if that basis permits the configured retention, otherwise keep post-level storage and experiments disabled or redesign them around a confirmed compliant path.** |
| 17 | Keep Instagram readiness honest about the Page link, publisher token identity, and Meta publishing grant. | **in questa PR. Motivo:** the probe checks the exact Page-to-Instagram link, either Page content-creation task (`CREATE_CONTENT` or `PROFILE_PLUS_CREATE_CONTENT`), `instagram_content_publish` grant, exact publisher-token match to the Page token returned for the same user token, and publisher account identity; unavailable checks and missing permissions stay actionable and cannot report `ready`. Neither `FB_USER_ACCESS_TOKEN` nor `INSTAGRAM_ACCESS_TOKEN` is currently in RC. **Prossimo passo:** configure the scoped user token and publisher token after Meta grants the permission, verify the intended professional account and Page connection, then rerun the read-only probe until every check matches.** |
| 18 | Set the social landing hub as the website link on the active Instagram and TikTok profiles and verify each profile exposes it. | **blocked: profile-edit access unavailable. Motivo:** the landing page and redirect routes are implemented, but this environment has no connected profile editor or authenticated browser session, and the publisher APIs do not edit profile links. **Prossimo passo:** apply `/social/` in each account's profile settings through an authorized account session, then verify the public profile and a tagged click before treating bio traffic as measurable.** |
| 19 | Extend owned-account publishing into paid acquisition with measurable conversion guardrails. | **blocked: advertising account and spend cap unavailable. Motivo:** no verified ad account, billing scope, campaign objective, or spend limit is configured; content-publishing authorization does not establish a safe paid-media budget. **Prossimo passo:** connect an eligible ad account and set an explicit daily/monthly cap plus a qualified conversion contract before adding an official Ads API campaign path.** |
| 20 | Enforce the configured daily cadence across every enabled publisher and manual dispatch. | **in questa PR. Motivo:** Firestore account/day reservations now cover all in-repository Facebook, Instagram, LinkedIn Member, and Telegram publisher entry points; LinkedIn articles and jobs share a two-post cap, Telegram Bot API messages share a two-message cap, and the scorecard flags over-cap ledger days. Reddit remains delivery-held and has no enabled publisher. **Prossimo passo:** after merge, confirm the first live ledger and scorecard cycle before considering any cadence change.** |
| 21 | Recover stale uncertain publish reservations when the platform accepted a post but no ledger row was written. | **blocked: Telegram exact-history lookup and authoritative absence proof unavailable. Motivo:** this PR adds a scoped operator report plus an aggregate report on every social-native-insights run (at most every six hours), covering Facebook, Instagram feed/Stories, LinkedIn Member, and Telegram without exposing account IDs, post IDs, hashes, or content. Exact-positive reconciliation for new Facebook, Instagram, and LinkedIn Member reservations matches the stored public-payload fingerprint, exact native ID, author/account, and bounded publish time; it stores hashed IDs/evidence. API errors and negative reads remain held. Older reservations have no fingerprint and remain report-only; Telegram Bot API cannot retrieve channel history by message ID. LinkedIn's Posts API exact read requires [`r_member_social`](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-10), documented as restricted to approved users. **Prossimo passo:** after merge, verify the aggregate report in a scheduled run; request/confirm that LinkedIn read grant before relying on its verifier; keep Telegram and pre-fingerprint reservations held until an official exact proof becomes available, and never release from a 404 or permission error.** |
| 22 | Include the manual Facebook article CLI in native-ID and scorecard coverage. | **in questa PR. Motivo:** after Meta confirms the post and returns its ID, the CLI writes `id`, canonical URL, publish time, and `fbPostId` into the same article ledger used by the scheduled publisher and scorecard; ledger-write failures retain the Firestore reservation and fail the run for reconciliation. **Prossimo passo:** after merge, verify one manual post appears in the first private native-insights join and scorecard without exposing its ID in report output.** |
| 23 | Reconcile the actual publish day for Facebook posts accepted as future schedules. | **in questa PR. Motivo:** each scheduled job keeps a planned-day and next-day reservation until the daily scheduler confirms `is_published` and `created_time` from Meta by exact post ID; unresolved schedules roll their hold forward, and the ledger, cap seeding, and scorecard use the confirmed actual Zurich day. **Prossimo passo:** after merge, verify one live schedule across its exact-ID readback and the first scorecard row; keep unresolved reads fail-closed.** |
| 24 | Reconcile posts sent directly from native social apps with automated account/day caps. | **blocked: native-app history is unavailable to the current publisher grants. Motivo:** the current code-owned ledgers cannot observe posts created outside these publishers, and a Bot API send token or LinkedIn member-post permission does not establish a supported exact account-history read. **Prossimo passo:** route manual publishing through the gated publishers or add a least-privilege exact-ID history collector only after the platform grants and official API contract support it; until then, scorecard overrun signals describe app-managed ledger sends only.** |
| 25 | Include qualified job-detail sessions in the social-copy action contract as an intermediate outcome. | **in questa PR. Motivo:** the existing `job_qualified_session` event is now allowlisted in the copy-attributed GA4 event-count report with its sessionStorage and memory-fallback limits; it remains descriptive and is never a completed application or session key-event-rate guardrail. **Prossimo passo:** after merge, verify the first exact-UTM GA4 event-count rows; keep this event excluded from rate-based baselines even if the live property marks it as a key event.** |

No platform's external review, audience setting, or rate limit is overridden by
the owner's authorization or by Codex.

The generation input and pack contain no comments, DMs, usernames, private
conversation text, or credentials. For source attribution and the upstream
skill's pinned revision, see docs/third-party/instagram-agent-skill/UPSTREAM.md.
