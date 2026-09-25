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
5. **Auto-promotion** — the next send biases toward the recent winner (below).

## Auto-promotion (on by default)

`send-newsletter.mjs` resolves a *promoted variant* before assembling a campaign:
it pools the open rates of the previous `NEWSLETTER_AB_LOOKBACK` campaigns
(default 2) and, **only** if every arm cleared the sample gate
(`DEFAULT_WINNER_GATES.minSendsPerArm`, default 200) **and** the best vs runner-up
is significant (z-test, p<0.05), declares a winner.

When a winner exists, assignment becomes **epsilon-greedy**: a `1-ε` share
(ε=`DEFAULT_EPSILON`, 0.2 → 90% for two arms) is sent the winner, the rest still
explores uniformly so the losing arm keeps getting traffic and the test stays
live (and can flip if the winner changes). With no significant winner it is a
pure even split — so "on by default" changes nothing until the data earns it.

Promotion is **per provider**, applied in two stages so it survives the fact
that the cascade only picks a provider at send time:

1. **Assembly time** — each subscriber is assigned the *global* winner (pooled
   across providers) as the default, baked into the email subject. We can't route
   a subscriber to a provider, so this is the best variant we can pre-commit.
2. **Send time** — once the cascade chooses the provider, a `finalizeForProvider`
   hook swaps the subject to **that provider's** winner (epsilon-greedy), falling
   back to the global winner when a provider has no significant winner yet. The
   body HTML is variant-independent, so only the subject + the `variant` tag
   change; the final variant is read back from the payload for the delivery
   record + PostHog event. The hook is opt-in and never throws — on any issue the
   assembly-time global variant is sent unchanged (job-alert sends pass no hook).

So `byProvider[p] ?? global` decides each email's variant, and the per-provider
report measures whether the per-provider split actually beats the global one.
(The legacy Resend-only fallback path keeps the assembly-time global variant.)

| Env | Default | Purpose |
|-----|---------|---------|
| `NEWSLETTER_AB_AUTOPROMOTE` | on | set `false` to force an even split (kill switch) |
| `NEWSLETTER_AB_LOOKBACK` | `2` | how many prior campaigns to pool for the winner |

The persisted `variant` on each send doc is authoritative — once promotion skews
the split, the variant is no longer a pure function of `(email, campaignId)`, so
the report and resolver both read the persisted value (recompute is a legacy
fallback only).

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
`email_opened` on open — also carrying `subject_variant` (non-Resend providers
don't have it in their webhook payload, so it's looked up from the send doc via
`lookupSentVariant`) so the breakdown works on either step. Both share
`distinct_id = email`, so in PostHog:

> **Excluded providers.** `mailtrap` (sandbox/testing ESP, reports ~0 real opens)
> is excluded from the experiment — see `EXPERIMENT_EXCLUDED_PROVIDERS`. Its sends
> emit no events and the Firestore report drops its data, so it can't deflate the
> open-rate comparison. (Note: if mailtrap is also a non-delivering sandbox in the
> live cascade, that's a separate deliverability concern, out of scope here.)

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

Config resolves **env first, then Remote Config** (RC is the single source for
both runtimes; the send CI hydrates env from RC via `load-rc-env.mjs`, the Cloud
Functions read RC directly). Both the flag and the key must resolve, else it's a
no-op.

| Param | RC key | env (send CI) | Purpose |
|-------|--------|---------------|---------|
| master switch | `SERVER_POSTHOG_EMAIL_EXPERIMENT` | `POSTHOG_EMAIL_EXPERIMENT` | `1` = on |
| capture key | `SERVER_POSTHOG_PROJECT_KEY` | `POSTHOG_PROJECT_KEY` | public `phc_…` project key |
| host | `SERVER_POSTHOG_HOST` | `POSTHOG_HOST` | default `https://eu.i.posthog.com` |

To turn it on:

```bash
# 1. publish the RC params (flag + capture key) — needs the Firebase SA
GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json \
  node scripts/set-posthog-rc.mjs

# 2. redeploy Cloud Functions so the webhooks pick up the RC-aware helper
#    (deploy-cloud-functions.yml runs on push to main touching functions/**)

# 3. create the funnel insights (idempotent)
eval "$(GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json \
  node scripts/load-rc-env.mjs | grep POSTHOG)" \
  && node scripts/setup-posthog-email-funnel.mjs
```

The next scheduled send then emits `email_sent`; opens emit `email_opened`.
Kill switch: set `SERVER_POSTHOG_EMAIL_EXPERIMENT=0` in RC (re-run step 1 after
editing the value, or flip it in the Firebase console).

⚠️ **Quota**: the PostHog free tier (1M events/mo) is already tight and has
caused outages. This emits only 2 events per subscriber per campaign, but it
still adds volume — watch the PostHog billing usage after enabling. The Firestore
report + auto-promotion decide the winner for free regardless.
