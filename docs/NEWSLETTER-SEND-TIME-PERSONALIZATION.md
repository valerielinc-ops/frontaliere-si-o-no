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
   `events` subcollection (last 300 events) and computes a **recency-weighted
   circular mean** of the hour-of-day (UTC) at which they open/click —
   same 7/14/30/60/90-day recency windows and weights as `engagementScore.js`
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
node scripts/report-send-hour-impact.mjs --json
```

Groups with fewer than 100 deliveries are flagged inline as not statistically
meaningful yet (`n<100, not significant`) rather than silently included in
the headline comparison.

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

| Workflow | Cron (UTC) | Rationale |
|---|---|---|
| `send-newsletter.yml` | `33 3 * * *` (03:33) | Unchanged by this feature. Tuned via PostHog click data + owner request (2026-07-08); confirmed clear by the same concurrency audit below. |
| `send-job-alerts.yml` | `47 1 * * *` (01:47) | Moved from `0 5 * * *` (2026-07-11, issue #3798 rollout). See below. |

**Audit basis** (real GitHub Actions runs, 3.5-day window, July 2026):
01:00-04:00 UTC is the quietest concurrency window on the account (~4
concurrent jobs observed, vs a ~22-job peak around 12:00 UTC). The previous
05:00 UTC slot collided with real `translate-pending.yml` runs observed
spanning 04:51→07:01 UTC and 05:11→09:47 UTC — job-alerts was competing for
runner capacity with an active translation/housekeeping job on those days.
`:47` avoids the `:00`/`:15`/`:30`/`:45` minute marks GitHub Actions
deprioritizes under load (documented silent-skip risk). At its typical 3-10
minute runtime, `send-job-alerts` finishes with wide margin before
`send-newsletter` fires at 03:33 UTC.
