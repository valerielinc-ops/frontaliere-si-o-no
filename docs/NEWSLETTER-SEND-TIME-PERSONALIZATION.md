# Per-user scheduled send time (issue #3798)

Send each subscriber's newsletter / job-alert email at **their own** best
time of day instead of one fixed timestamp for everyone, derived from their
own open/click history. Falls back gracefully (site-wide average, then
immediate send) when there isn't enough personal signal yet.

## How it works

1. **Signal** — every open/click webhook event (all 5 ESP webhook cores:
   Resend, Mailjet, Mailgun, Mailtrap, Maileroo) calls
   `refreshPreferredSendHour` (`functions/src/lib/preferredSendHour.js`)
   after updating the engagement score. It re-reads the subscriber's
   `events` subcollection (last 300 events) and computes an **intent- and
   recency-weighted circular mean** of the hour-of-day (UTC) at which they
   open/click. Clicks have 2.5x the weight of opens, while event influence
   decays continuously with a 4-day half-life; the 90-day lookback window
   remains in place.
   (circular, not arithmetic: an hour-of-day wraps at midnight, so opens at
   23:00 and 01:00 average to ~00:00, not noon).
2. **Cold-start guard** — below `PREFERRED_SEND_MIN_EVENTS` (3) qualifying
   open/click events, no personal hour is trusted (`hourUtc: null`).
3. **Persisted fields** on `newsletter_subscribers/{email}` **and**
   `job_alert_subscribers/{email}` (both collections have the same `events`
   subcollection shape):
   - `preferred_send_hour_utc` — integer 0-23, or `null` below the threshold.
   - `preferred_send_sample_count` — how many qualifying events fed the mean.
   - `preferred_send_strength` — resultant vector length (0-1): close to 1 =
     opens/clicks cluster tightly around one hour, close to 0 = spread evenly
     across the day (no real preference even with enough samples).
   - `preferred_send_updated_at` — server timestamp of the last refresh.
4. **Daily run** (cron unchanged — still once/day per campaign type) resolves,
   for each recipient, the effective hour and schedules that subscriber's
   send for that hour (today if it hasn't passed yet + a safety margin, else
   tomorrow), instead of sending everyone at the cron's own fire time.
5. **Delivery** — the resolved timestamp is handed to the provider's native
   scheduled-send API (`scripts/lib/email-cascade.mjs`, `payload.scheduledAt`).
   Providers without scheduled-send support just send immediately for that
   subscriber that day — see the provider matrix below.

## End-to-end flow

```
open/click webhook (any of the 5 ESP cores)
        │
        ▼
refreshPreferredSendHour(subscriberRef, FieldValue)     [functions/src/lib/preferredSendHour.js]
        │  (circular mean over events subcollection, 3-event cold-start floor)
        ▼
newsletter_subscribers/{email} or job_alert_subscribers/{email}:
  preferred_send_hour_utc / preferred_send_sample_count /
  preferred_send_strength / preferred_send_updated_at
        │
        ▼  (next scheduled run — cron itself is UNCHANGED, once/day)
send-newsletter.mjs / send-job-alerts.mjs, per recipient:
  resolveEffectivePreferredHour({ subscriberDoc, fallbackDoc, globalHour })
    → { hourUtc, source: 'personal' | 'fallback-doc' | 'global' | null }
        │
        ▼
computeScheduledSendAt({ preferredHourUtc, email, now })   [scripts/lib/send-schedule.mjs]
    → ISO 8601 UTC timestamp (today's slot, or tomorrow's if today's already
      passed / falls inside the anti-race margin), with a per-email
      deterministic minute jitter (FNV-1a hash of the address) so subscribers
      sharing an hour don't all land on :00
        │
        ▼
payload.scheduledAt handed to sendEmailCascade()          [scripts/lib/email-cascade.mjs]
        │
        ▼
provider-native scheduled-send API (or immediate send — see matrix below)
        │
        ▼
campaign_deliveries/{campaignId}__{email}: scheduled_for + send_time_source persisted
```

`resolveEffectivePreferredHour` priority order (`scripts/lib/send-schedule.mjs`):

1. **`personal`** — the recipient's own `preferred_send_hour_utc`, if their
   `preferred_send_sample_count` clears the qualification threshold (matches
   `PREFERRED_SEND_MIN_EVENTS` = 3).
2. **`fallback-doc`** — job-alerts only: when the `job_alert_subscribers`
   doc has no qualifying personal signal of its own, fall back to the same
   address's `newsletter_subscribers` doc (a job-alert recipient who also
   gets the newsletter already has open/click history there). Newsletter
   sends have no such fallback doc (there's nothing "above" the newsletter
   subscriber doc to fall back to).
3. **`global`** — the site-wide aggregate hour (below), when neither of the
   above qualifies.
4. **`null`** (no source) — send immediately, no `scheduledAt` at all.

## Site-wide fallback aggregate

`computeGlobalPreferredHour()` (`scripts/lib/send-schedule.mjs`) pools every
qualified subscriber's personal `preferred_send_hour_utc` into an unweighted
circular mean — the same wrap-at-midnight math as the per-subscriber
computation, just without the recency weighting (it's a single site-wide
snapshot, not a per-user trend). Requires at least `MIN_GLOBAL_SAMPLE_USERS`
(5) qualified subscribers, else the global hour is `null` (too few users to
trust a site-wide default — falls through to immediate send instead of
guessing off a handful of early adopters). `send-newsletter.mjs` recomputes
this once per run and persists it to:

```
newsletter_subscribers/_meta_
  global_preferred_send_hour_utc     — integer 0-23, or null
  global_preferred_send_sample_users — how many subscribers fed the mean
  global_preferred_send_updated_at   — server timestamp
```

`send-job-alerts.mjs` reads this same `_meta_` doc as its own global fallback
(job-alert subscribers are a much smaller pool — not enough for their own
reliable site-wide aggregate — and newsletter/job-alert audiences overlap
heavily) rather than computing a separate one.

**Cross-run staleness (by design)** — with the cron slots below,
`send-job-alerts` fires at 00:33 UTC, *before* `send-newsletter` at 03:33 UTC.
So the `global_preferred_send_hour_utc` job-alerts reads on any given day is
the value `send-newsletter` wrote on the *previous* day's run, never today's.
This is intentionally harmless: the global aggregate is a slow-moving mean
over many users, and a ~1-day-old snapshot doesn't meaningfully differ from
a same-day one. If this ever needs tightening: (a) swap the two crons' fire
order, or (b) have `send-job-alerts` compute its own global hour from the
subscriber profiles it already loads into memory during the run.

## Provider matrix — scheduled-send support

| Provider | Param | Format | Max lookahead | Native scheduling? |
|---|---|---|---|---|
| Resend | `scheduled_at` | ISO 8601 UTC | 30 days | Yes |
| Mailgun | `o:deliverytime` | RFC 2822, explicit `+0000` offset | 3 days (conservative — default-plan cap) | Yes |
| Maileroo | `scheduled_at` | RFC 3339 (ISO 8601 is valid RFC 3339) | 3 days (conservative — undocumented real ceiling) | Yes |
| Mailjet | — | — | — | No |
| Mailtrap | — | — | — | No |
| Cloudflare | — | — | — | No |

**Fallback policy for the 3 non-scheduling providers**: `email-cascade.mjs`'s
`resolveScheduledAt()` returns `null` whenever the provider has no
`scheduledSend` capability entry (or the requested time is unparsable, in the
past, inside the 2-minute anti-race margin, or beyond the resolved provider's
lookahead) — the send just goes out **immediately**, the same day, through
whichever provider the cascade picks. This is a graceful per-message
degradation, not an error: `sendEmailCascade()`'s `sent[]` result carries
`scheduledFor: null` for that message, and the persisted delivery doc
reflects it the same way (`scheduled_for: null`). A subscriber whose
preferred hour lands them on Mailjet one day and Resend the next may get an
immediate send one week and a properly-scheduled one the next — this is
expected, not a bug: the cascade picks providers by live quota, not by
subscriber.

## New Firestore fields

| Location | Field | Meaning |
|---|---|---|
| `newsletter_subscribers/{email}` | `preferred_send_hour_utc` | Personal preferred hour, UTC 0-23, or `null` |
| `newsletter_subscribers/{email}` | `preferred_send_sample_count` | Qualifying open/click events behind the mean |
| `newsletter_subscribers/{email}` | `preferred_send_strength` | Circular concentration, 0-1 |
| `newsletter_subscribers/{email}` | `preferred_send_updated_at` | Last refresh timestamp |
| `job_alert_subscribers/{email}` | (same 4 fields as above) | Same meaning, independent per-collection signal |
| `newsletter_subscribers/_meta_` | `global_preferred_send_hour_utc` | Site-wide fallback hour, UTC 0-23, or `null` |
| `newsletter_subscribers/_meta_` | `global_preferred_send_sample_users` | Qualified subscribers behind the global mean |
| `newsletter_subscribers/_meta_` | `global_preferred_send_updated_at` | Last global-aggregate refresh timestamp |
| `newsletter_subscribers/{email}/campaign_deliveries/{id}` | `scheduled_for` | ISO timestamp actually scheduled provider-side, or `null` (immediate/no-scheduling-provider) |
| `newsletter_subscribers/{email}/campaign_deliveries/{id}` | `send_time_source` | `'personal'` \| `'global'` \| absent (pre-feature or immediate, no preference resolved) |
| `job_alert_subscribers/{email}` | `last_scheduled_for` | ISO timestamp the cascade actually scheduled for the most recent job-alert send, or `null` (immediate/no-scheduling-provider/verification run) |
| `job_alert_subscribers/{email}` | `last_send_time_source` | `'personal'` \| `'fallback-doc'` \| `'global'` \| `null` for the most recent job-alert send |

## Rollback / kill switch

`PER_USER_SEND_TIME=off` (also accepts `0` / `false`, case-insensitive)
disables per-user scheduling entirely: `perUserSendTimeEnabled()`
(`scripts/lib/send-schedule.mjs`) is read live (not cached at module load) on
every send, so it can be flipped mid-rollout without a redeploy of the
scripts themselves. When off, every recipient is sent immediately, exactly
as before this feature — no `scheduledAt` is computed, `scheduled_for` is
never written non-null, `send_time_source` is never written.

**Where to set it** — this is a plain `process.env` read, resolved the same
way `NEWSLETTER_AB_AUTOPROMOTE` (the subject A/B kill switch, see
`docs/NEWSLETTER-SUBJECT-AB.md`) is: it is **not** currently wired into
`scripts/load-rc-env.mjs`'s `RC_TO_ENV` map, nor pre-set in either
`.github/workflows/send-newsletter.yml` or `.github/workflows/send-job-alerts.yml`.
To actually flip it in production, one of:

1. **Fastest** — add `PER_USER_SEND_TIME: 'off'` to the relevant step's
   `env:` block in the workflow YAML (the `Run newsletter job` step in
   `send-newsletter.yml`, the `Send job alert emails` step in
   `send-job-alerts.yml`), same mechanism as `NEWSLETTER_ENABLE_SEND` /
   `EMAIL_PROVIDER` there. Requires a commit + merge.
2. **No-redeploy** — add a `PER_USER_SEND_TIME: ['PER_USER_SEND_TIME']`
   entry to `RC_TO_ENV` in `scripts/load-rc-env.mjs` and publish the RC
   param (same pattern as `SERVER_POSTHOG_EMAIL_EXPERIMENT` →
   `POSTHOG_EMAIL_EXPERIMENT`, see `docs/NEWSLETTER-SUBJECT-AB.md` §
   Enabling) — flips from the Firebase console or a one-off RC-set script,
   no code change. Neither is wired yet as of this writing; option 2 is the
   better long-term switch if this needs flipping more than once.

Disabling per-user timing does **not** disable the underlying signal
collection — `preferred_send_hour_utc` etc. keep accumulating from webhook
events regardless, so re-enabling later resumes with warm data instead of a
cold start.

## Monitoring

`scripts/report-send-hour-impact.mjs` — read-only report (no writes, no
sends, always exits 0). Groups recent `campaign_deliveries` by
`send_time_source` (`personal` / `global` / immediate-or-pre-feature) and
compares open rate + click rate per group, cross-checking opens/clicks
against the `events` subcollection the same way
`scripts/lib/newsletter-ab-data.mjs` (the subject A/B report's loader) does —
necessary because only Resend's webhook merges `opened_at`/`clicked_at` onto
the *same* delivery doc; the other 4 tracked providers write a second doc
with a different id, so reading only the canonical doc's own fields would
under-count their opens/clicks.

```bash
node scripts/report-send-hour-impact.mjs                    # last 30 days
node scripts/report-send-hour-impact.mjs --days 60
node scripts/report-send-hour-impact.mjs --since 2026-07-01  # pre/post split at rollout date
node scripts/report-send-hour-impact.mjs --maturity-hours 72 # stricter maturation
node scripts/report-send-hour-impact.mjs --maturity-hours 0  # reproduce the old, confounded numbers
node scripts/report-send-hour-impact.mjs --json
```

Every comparison is a real two-proportion z-test against the paired baseline
(`services/newsletter-ab-stats.mjs`), reported inline as
`[significant, p=...]` / `[not significant, p=...]`.

### The instrument correction (#3798 Fase 4, 2026-08-05)

The report used to window, split and count on `sent_at`. `sent_at` is when we
called the provider's API; the entire point of this feature is that the
provider delivers **later**. That made `personal` the only cohort
systematically delayed relative to its own timestamp, so it was measured
against a shorter effective window in which to be opened than `global` and
`immediate` — a confound with exactly the sign of the negative result that was
first observed. Three corrections, all in
`scripts/report-send-hour-impact.mjs`:

1. **Delivery anchoring** — window floor, pre/post split and maturity all key
   off `scheduled_for ?? sent_at`. Because the Firestore query can only filter
   on the indexed `sent_at`, the fetch floor is widened by
   `MAX_SCHEDULE_LOOKAHEAD_MS` (3d) and the surplus trimmed in `aggregate()`;
   without that, a message sent just before the floor but delivered inside it
   is never fetched — a silent left-edge truncation hitting only the scheduled
   cohort.
2. **Maturation** (`--maturity-hours`, default 48) — drops deliveries released
   less than N hours ago from **every** group alike, so each cohort has had the
   same opportunity to be opened.
3. **Coverage** (`sched%` column + a treated-only comparison) — the share of
   each group carrying a real `scheduled_for`. A `personal` delivery whose
   cascade fell through to a provider with no native scheduled-send went out
   immediately and never received the treatment; without this number the test
   measures a treatment of unknown intensity.

Measured effect of the correction on the same production data (20-day window,
split at 2026-07-12, `personal` vs `global` open rate):

| Instrument | personal vs global | verdict |
|---|---|---|
| `sent_at`, no maturation (old) | **−8.7 pp** | feature looks harmful (p=0.000) |
| delivery-anchored, no maturation | −2.6 pp | still negative (p=0.000) |
| delivery-anchored + 24h maturation | **+5.0 pp** | positive (p=0.000) |
| delivery-anchored + 48h maturation | **+12.1 pp** | positive (p=0.000) |
| delivery-anchored + 72h maturation | **+5.9 pp** | positive (p=0.000) |

The sign is positive and significant at every maturity window tested and
negative only with maturation off, so the earlier negative verdict was an
artifact of the instrument, not a property of the feature. Treated-only
(`scheduled_for` present on both sides) at 48h: **+15.1 pp** (36.3% vs 21.2%),
on 87.3% coverage of the `personal` cohort. The pre-committed rollback
(`PER_USER_SEND_TIME=off`) was therefore **not** exercised.

**What to watch**, beyond the report's own open/click-rate delta:

- **Delivery delay** — for scheduled sends, the gap between `scheduled_for`
  and the webhook's actual `delivered_at`/`sent_at`: a growing gap means a
  provider's scheduled-send queue is backing up, not that personalization
  itself is failing.
- **`global` group size trend** — `global_preferred_send_sample_users` on
  `_meta_` growing over time is the expected trajectory as more subscribers
  cross the cold-start threshold and graduate from `global` to `personal`.
- **Provider mix inside each group** — a `send_time_source=personal` group
  dominated by non-scheduling providers (Mailjet/Mailtrap/Cloudflare) means
  most "personalized" sends are actually going out immediately anyway
  (`scheduled_for: null`) — the open-rate delta in that case measures little
  beyond normal day-to-day noise.

## Timezone note

The subscriber base is assumed to skew CET/CEST (the site's primary market),
but every persisted hour (`preferred_send_hour_utc`,
`global_preferred_send_hour_utc`, the resolved `scheduledAt`) is **absolute
UTC**, computed directly from each event's UTC timestamp with no timezone
inference or DST adjustment. This is a known, documented risk from issue
#3798: a subscriber's *true* local-time preference silently shifts by one
hour across the March/October CET↔CEST transition (their UTC-hour habit
doesn't move, but what "8am for them" means in UTC does) — the circular mean
absorbs this as ordinary noise rather than an explicit correction, and a
subscriber traveling outside the assumed timezone gets no different
treatment. Left unaddressed pending real usage data on whether the drift is
large enough to matter in practice.

## Cron slots

Both sends stay at **once per day** — this feature changes *when within
the day* each subscriber's email goes out, not how often the workflow runs.

| Workflow | Cron (UTC) | Effective start (median) | Rationale |
|---|---|---|---|
| `send-newsletter.yml` | `33 3 * * *` (03:33) | ~06:13 | Unchanged by this feature. Tuned via PostHog click data + owner request (2026-07-08). |
| `send-job-alerts.yml` | `33 0 * * *` (00:33) | ~04:33 | Moved from `0 5 * * *` (2026-07-11, #3798 rollout), then 01:47→00:33 (2026-07-21). Kept at 00:33 after the 2026-08-05 re-audit — see below. |

### Audit basis — corrected 2026-08-05 (#3798 Fase 1)

The July 2026 audit that produced these slots measured **concurrent jobs per
wall-clock hour**. That is the wrong metric twice over, and its conclusion
("01:00-04:00 UTC is the quietest window") was right by accident. Re-audited
over 30 days of scheduled runs across every crontabbed workflow in the repo:

- **The concurrency pool is no longer the constraint.** Post-dispatch job queue
  wait (`job.started_at − job.created_at`) is a median of **2s**, p90 8-9s, for
  runs created anywhere in 00:00-06:00 UTC (n=414 jobs over 7 days). The
  ~20-job free-tier ceiling behind incident #2882 stopped biting when the 581
  per-crawler workflows were consolidated into 23 groups
  (`docs/CI-CD-PIPELINE.md`). Choosing a slot to dodge our own concurrent jobs
  optimises something that costs ~2 seconds.
- **What costs hours is GitHub's scheduled-dispatch backlog** — the gap between
  the nominal cron minute and `run.created_at`. Median by nominal hour: 00h
  **240m**, 02h 199m, 03h 159m, 05h 147m, 10h 109m, 15h 65m, 21h 62m, 22h
  **51m**. `send-job-alerts` at 00:33 is the worst-placed workflow measured
  (median 240m, p90 471m, max 590m).
- **It is a property of the slot, not of the workflow.**
  `orchestrate-crawlers.yml` is scheduled at both 09:00 (median 133m) and 21:00
  (median 62m) — same workflow, same repo, 2.1× apart. `translate-pending.yml`
  (07:00→157m vs 13:00→130m) and `audit-parser-quality.yml` (10:30→114m vs
  15:15→99m) agree.
- **A "runs created per hour" histogram cannot see this**, because it counts
  runs at their delayed time. 00h-02h show 11-22 runs/h vs 68-75 at 10h-11h —
  the night looks quiet precisely because its own scheduled work is being
  deferred into the morning. Dispatch delay is in fact *anti*-correlated with
  our own run volume (22h is the 5th busiest hour and has the lowest delay).
- **The minute is not load-bearing.** Median delay is 150m at `:00`, 149m at
  `:15`/`:30`/`:45`, 158m at off-minutes (n=1462). The `:47`/`:33`
  "avoids GitHub's deprioritised minute marks" rationale is unsupported here.

**Why the slots stay early anyway.** The low-drift band is 15:00-22:00 UTC, but
moving there would be a net loss: `computeScheduledSendAt` schedules each
subscriber for the *next* occurrence of their preferred hour, so the later in
the UTC day the run fires, the more subscribers have already passed their hour
and get pushed to tomorrow's slot — receiving ~24h-old content. Firing early
beats firing punctually. 00:33 + 240m lands ~04:33, the earliest effective
start of any sampled slot, and even its p90 (~08:24) clears the morning crawler
batch (dispatched ~11:20; longest group `crawler-group-01` runs ~3-4h, not the
5h40m its `timeout-minutes` allows).

**The previously-claimed 3h gap between the two sends does not exist** and is
not needed: effective starts are ~04:33 and ~06:13 (~1h40m apart), and on p90
days job-alerts starts *after* the newsletter. The two workflows have no data
dependency and separate `concurrency` groups.

### The 23:00 slot is being measured, not argued about

The audit above could not evaluate one candidate: **no workflow in the repo is
scheduled at 23:00 UTC**, so there was nothing to measure. The 21:00 (62m) and
22:00 (51m) neighbours suggest a 23:xx cron would start around 00:15 UTC —
earlier *and* with a far tighter tail than 00:33's ~04:33 median / 471m p90.
That is a conjecture, and it is not a good enough reason to move a production
send.

`.github/workflows/cron-dispatch-canary.yml` now collects the data on its own:

| Piece | What it does |
|---|---|
| `.github/workflows/cron-dispatch-canary.yml` | Two crons — `17 23 * * *` (candidate) and `33 0 * * *` (control, byte-identical to send-job-alerts' slot). Sends nothing. |
| `scripts/ci/probe-cron-dispatch-delay.mjs` | Reads its own run's `created_at`, computes the delay against its nominal slot, appends one line to `data/cron-dispatch-history.jsonl`. |
| `scripts/ci/audit-cron-dispatch-delay.mjs` | `--from-history` ranks the slots; `--scan` re-runs the repo-wide audit live, so the methodology never has to be rebuilt from scratch again. |

Three design points worth keeping:

- **It ranks on effective start, not on delay.** A slot that drifts 75 min but
  starts at 00:15 beats one that drifts 20 min but starts at 04:30, because
  `computeScheduledSendAt` defers every subscriber whose hour has already
  passed. The report prints an estimated *share of the base deferred*
  (uniform preferred-hour assumption by default; pass `--hour-histogram` to
  score against the real distribution) so the ranking cannot be read backwards.
- **Both slots are sampled the same night**, which makes the comparison paired:
  a night when GitHub's global backlog is unusually bad cancels out instead of
  being mistaken for a slot effect.
- **It sends nothing.** Dispatch delay is a property of GitHub Actions, not of
  email, so it is measurable without touching a subscriber — no provider call,
  no Firestore read or write, and no send path in the workflow to get wrong.

```bash
node scripts/ci/audit-cron-dispatch-delay.mjs                      # current standing
node scripts/ci/audit-cron-dispatch-delay.mjs --compare 23:17 00:33
node scripts/ci/audit-cron-dispatch-delay.mjs --scan               # repo-wide, live
```

**The decision rule, pre-committed so nobody has to re-litigate it:** once
there are ≥14 paired nights, if `23:17` shows the earlier median effective
start, move `send-job-alerts.yml` onto it. Nothing else changes — the send
logic is untouched either way. If it does not win, delete the canary and the
question is closed with an answer instead of a hunch.
