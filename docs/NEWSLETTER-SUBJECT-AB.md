# Newsletter subject-line A/B test (per provider)

Optimize newsletter **open rate per sending provider** by testing two
subject-line styles. Variant assignment is ours (deterministic); measurement has
two independent readouts: a **free Firestore report** and an optional
**PostHog funnel**.

## How it works

1. **Variants** — `services/newsletter-subject-variants.mjs` defines two styles:
   - `concreto` — number + location + concrete benefit
   - `curioso` — curiosity gap / question hook
2. **Assignment** — `assignSubjectVariant(email, campaignId)` hashes the email
   (sha256) into a variant. Deterministic: stable within a weekly campaign,
   rotates across campaigns. **Independent of the sending provider** (the cascade
   picks the provider by quota at send time), so every provider sees a ~50/50
   variant mix → the provider×variant comparison is unbiased.
3. **Send** — `scripts/send-newsletter.mjs` generates one AI subject per
   `(locale × variant)`, sends each subscriber their assigned variant, tags the
   email (`tags.variant`) and persists `provider`/`variant`/`subject` on the
   send doc.
4. **Measurement** — opens are recorded by the ESP webhooks. The winner is read
   two ways (below).

## Reading the result

### A. Firestore report (free, always on)

```bash
node scripts/newsletter-ab-report.mjs                       # latest weekly
node scripts/newsletter-ab-report.mjs --campaign weekly_2026-06-15
node scripts/newsletter-ab-report.mjs --json
```

Cross-tabs open rate by `provider × variant`, flags the per-provider winner and
runs a two-proportion z-test. Source of truth = Firestore send docs + open
events; immune to the per-provider webhook doc-id divergence.

### B. PostHog funnel (optional, richer UI)

Disabled by default. When enabled, the send path emits `email_sent` (exposure,
carries `subject_variant` + `email_provider`) and the webhooks emit
`email_opened` on open. Both share `distinct_id = email`, so in PostHog:

1. Build a **Funnel**: step 1 `email_sent` → step 2 `email_opened`.
2. **Filter the whole funnel to one `campaign_id`** (analyze one weekly campaign
   at a time). This is required for correct attribution — see the box below.
3. **Breakdown by** `subject_variant` (and/or `email_provider`).
4. PostHog reports conversion (= open rate) per arm with significance.

> **Attribution — must scope per campaign.** PostHog links step 1 → step 2 by
> *person* within the conversion window, not by matching `campaign_id`. With
> weekly campaigns, a conversion window longer than 7 days could let an
> `email_opened` from a *later* campaign convert an earlier `email_sent`, and the
> variant breakdown takes the value from step 1 → the open gets attributed to the
> wrong campaign's variant. Two guards (do both):
> - **Filter the funnel to a single `campaign_id`** (step 2 above) — both events
>   carry it, so only same-campaign sent+open pairs enter the funnel.
> - **Set the conversion window to ≤ 3 days** (well under the weekly cadence).
>
> Within one campaign a subscriber has exactly one variant (assignment is
> `hash(email, campaignId)`), so once scoped per campaign the per-arm open rate
> is exact.

The variant is **not** assigned by a PostHog feature flag — our hash owns
assignment, so the experiment keeps working even if PostHog is down/over-quota.

#### Enabling

Set on both runtimes (off → no events emitted, zero PostHog volume):

| Env | Where | Purpose |
|-----|-------|---------|
| `POSTHOG_EMAIL_EXPERIMENT=1` | send-newsletter CI env **and** Cloud Functions runtime | master switch |
| `POSTHOG_PROJECT_KEY` | both (**required to activate**) | PostHog project write key (`phc_…`); no hardcoded default |
| `POSTHOG_HOST` | both (optional) | defaults to `https://eu.i.posthog.com` |

Both `POSTHOG_EMAIL_EXPERIMENT=1` **and** `POSTHOG_PROJECT_KEY` must be set — if
either is missing the capture is a no-op.

⚠️ **Quota**: the PostHog free tier (1M events/mo) is already tight and has
caused outages. This emits only 2 events per subscriber per campaign, but keep
it off until you actually need the PostHog UI — the Firestore report covers the
decision for free.
