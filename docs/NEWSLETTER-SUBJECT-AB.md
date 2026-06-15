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
2. **Breakdown by** `subject_variant` (and/or `email_provider`).
3. PostHog reports conversion (= open rate) per arm with significance.

The variant is **not** assigned by a PostHog feature flag — our hash owns
assignment, so the experiment keeps working even if PostHog is down/over-quota.

#### Enabling

Set on both runtimes (off → no events emitted, zero PostHog volume):

| Env | Where | Purpose |
|-----|-------|---------|
| `POSTHOG_EMAIL_EXPERIMENT=1` | send-newsletter CI env **and** Cloud Functions runtime | master switch |
| `POSTHOG_PROJECT_KEY` | both (optional) | defaults to the public client key |
| `POSTHOG_HOST` | both (optional) | defaults to `https://eu.i.posthog.com` |

⚠️ **Quota**: the PostHog free tier (1M events/mo) is already tight and has
caused outages. This emits only 2 events per subscriber per campaign, but keep
it off until you actually need the PostHog UI — the Firestore report covers the
decision for free.
