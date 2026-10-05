# Auth-gate headline experiment

A/B test of the headline shown on the job auth gate (`#job-auth-gate`, the
`<span>{gateHeadline}</span>` rendered in `JobBoard`, `JobOrphanView`,
`JobExpiredView`). Wired in `services/authGateExperiment.ts`, bucketed by
PostHog feature flag, tagged on every event via the `headline_variant` super
property.

- **Exposure metric:** `job_auth_funnel` with `action = 'gate_view'` and
  `headline_variant IS NOT NULL`.
- **Conversion metric:** `job_auth_funnel` with `action = 'auth_success'`,
  counted per person (`uniq(person_id)`).
- **Re-run the numbers anytime:** `node scripts/query-authgate-experiment.mjs`
  (needs PostHog server creds — see the script header).

---

## Round 1 — `authgate-headline-v1` — CLOSED ✅

Control (the original `jobBoard.gate.title` copy) vs `frictionless` (neutral
outcome-framed CTA).

Exact copy tested, all 4 locales:

| locale | control (LOST) | frictionless (WON) |
| ------ | -------------- | ------------------ |
| it | Leggi requisiti e come candidarti | Continua per vedere l'annuncio completo |
| en | Read requirements and how to apply | Continue to see the full listing |
| de | Anforderungen und Bewerbung lesen | Weiter zum vollständigen Stellenangebot |
| fr | Lire les exigences et comment postuler | Continuer pour voir l'annonce complète |

Window: 90 days ending 2026-05-30. Variant-attributed persons only.

| variant        | persons @ gate | auth_success persons | CR (per-person) |
| -------------- | -------------- | -------------------- | --------------- |
| control        | 2665           | 348                  | 13.06%          |
| **frictionless** | 1919         | 378                  | **19.70%**      |

- Absolute lift: **+6.64 pp** (95% CI ±2.19 pp, unpooled SE)
- Relative lift: **+50.8%**
- Two-proportion z-test: **z = 6.07, p = 1.25e-9** → decisive.

**Decision:** `frictionless` wins. Promoted to 100% by moving its copy into the
`jobBoard.gate.title` i18n key (it/en/de/fr). From round 2 onward the `control`
arm therefore *is* the round-1 winner (the frictionless copy in the table above).

---

## Round 2 — `authgate-headline-v2` — CLOSED ✅ (apply_now promoted 2026-06-25)

Goal: can we beat the round-1 winner? Control (= round-1 frictionless baseline)
vs two new challengers with different psychological framings.

Framing per variant:

| variant      | framing |
| ------------ | ------- |
| control      | round-1 winner (outcome-framed) |
| free_unlock  | cost-removal + immediacy |
| apply_now    | goal-proximity (toward applying) |

Exact copy tested, all 4 locales (source of truth: `CHALLENGER_HEADLINES` in
`services/authGateExperiment.ts`; `control` = the `jobBoard.gate.title` key):

| locale | control | free_unlock | apply_now |
| ------ | ------- | ----------- | --------- |
| it | Continua per vedere l'annuncio completo | Sblocca gratis l'annuncio completo | Scopri come candidarti a questo lavoro |
| en | Continue to see the full listing | Unlock the full listing for free | See how to apply for this job |
| de | Weiter zum vollständigen Stellenangebot | Vollständiges Stellenangebot gratis freischalten | So bewirbst du dich für diese Stelle |
| fr | Continuer pour voir l'annonce complète | Débloquez gratuitement l'annonce complète | Découvrez comment postuler à cette offre |

**PostHog setup — DONE, round launched 2026-06-01:**
1. ✅ Feature flag `authgate-headline-v2` created (PostHog flag id `196322`),
   three variant keys `control` / `free_unlock` / `apply_now`, split 34/33/33,
   rollout 100%.
2. ✅ Same audience as v1 (gate viewers — no property filter, bucketed in
   `services/authGateExperiment.ts`).
3. ✅ `authgate-headline-v1` deactivated (round 1 closed).

Bucketing is live from 2026-06-01; first attributed events accrue from then.

**Windowing precondition (round-2 verdict):** `headline_variant` is a persistent
PostHog super property (set via `ph.register()` in `services/authGateExperiment.ts`).
Returning users from round-1 carry a stale `headline_variant` value until the
round-2 flag fires and overwrites it. The default `--days 90` window includes
pre-round-2 events where those stale values would produce a spurious
`frictionless vs control` z-test output. **Always pass `--since 2026-06-01`
when querying round-2 results** to exclude all pre-launch events:

```
node scripts/query-authgate-experiment.mjs --since 2026-06-01
```

**Calling the round (when to stop):**
- Wait for ≥ ~1500–2000 attributed persons per arm (round 1 reached
  significance around that volume).
- A challenger wins if its per-person `auth_success` CR beats control with
  two-proportion z-test p < 0.01 and the 95% CI lower bound on the lift is > 0.
- If neither challenger clears the bar, keep control (the round-1 winner) and
  retire v2.

Record the round-2 outcome in this file under a new section, then promote the
winner the same way round 1 was promoted (move copy into `jobBoard.gate.title`,
bump the module to `authgate-headline-v3` for the next round).

### Round 2 — result (window `--since 2026-06-01`, per-person)

| variant | persons | auth_success | CR | vs control |
| ------- | ------- | ------------ | -- | ---------- |
| **apply_now** | 1677 | 390 | **23.26%** | +1.46pp (95% CI ±2.79pp) z=1.03 p=0.31 |
| control | 1780 | 388 | 21.80% | baseline (= round-1 winner) |
| free_unlock | 1712 | 371 | 21.67% | −0.13pp p=0.93 (flat) |

**Decision (owner, 2026-06-25): promote `apply_now` to 100%.** It is the only arm
ahead of control and `free_unlock` is flat. Note the lead is **not yet
statistically significant** (p=0.31, CI crosses 0) — this is a product call to
ship the leading framing, not a significance verdict. Applied by:
- moving the `apply_now` copy into the `jobBoard.gate.title` i18n key (it/en/de/fr);
- deactivating PostHog flag `authgate-headline-v2` (id `196322`) so 100% of
  viewers get the promoted headline via the `control` fall-back.

The `CHALLENGER_HEADLINES` map in `services/authGateExperiment.ts` is kept as the
last round's config; a round-3 would redefine the arms and reactivate the flag.

**Reporting caveat found while calling the round:** even with `--since 2026-06-01`
the query still prints a `frictionless` row (39 persons / 0 conv → spurious
"LOSES (sig.)"). That is round-1's persistent `headline_variant=frictionless`
super property surviving per-person; `--since` filters by event date, not by arm.
Ignore non-`v2` arms, or constrain the query with
`AND properties.headline_variant IN ('control','free_unlock','apply_now')`.

## Model experiment — `authgate-model-v1` — CLOSED ✅ (dropped 2026-06-25)

Orthogonal *structural* test (not copy): `value_first` revealed a much longer
description teaser (~1100 vs ~220 chars) before the gate — hypothesis: more
information scent + reciprocity lifts auth conversion. Tagged via the
`gate_model` super property; split with `query-authgate-experiment.mjs --prop gate_model`.

Result (window `--since 2026-06-01`, per-person):

| variant | persons | auth_success | CR | vs control |
| ------- | ------- | ------------ | -- | ---------- |
| control | 501 | 124 | **24.75%** | baseline |
| value_first | 471 | 111 | 23.57% | −1.18pp (95% CI ±5.38pp) z=−0.43 p=0.67 |

`value_first` did **not** beat control — the point estimate is negative and the
arm was badly under-powered (~500/arm vs ~1700/arm for the headline test,
because the model hook only fired on `JobBoard`, not on the orphan/expired
views). Owner decision: **drop it.** Applied by removing `useAuthGateModelVariant`
and the `value_first` branch from `JobBoard` (preview box reverts to the control
~220-char teaser) and deactivating PostHog flag `authgate-model-v1` (id `211373`).

---

## Round 3 — `jobgate-v3` — CLOSED ✖ for futility (2026-09-25 → 2026-10-05)

First *randomised* multi-arm round. Rounds 1-2 and the model test set the arm
globally (PostHog flag, later `AUTHGATE_HEADLINE_VARIANT`); v3 assigns each
visitor deterministically and stickily, so all arms run at the same time on
comparable traffic.

**Wiring.**

- Core (pure, shared with the publisher script): `services/jobGateExperimentCore.mjs`;
  typed facade + page-session state: `services/jobGateExperiment.ts`;
  Remote Config loader, hook and exposure: `hooks/useJobGateExperiment.ts`.
- Arm = `hash(browser id + "jobgate-v3")` over the integer weights, walked in
  the canonical arm order (re-ordering JSON keys never reshuffles visitors).
  Browser id = the non-PII `frontaliere_assisted_application_distinct_id`
  (localStorage); no id → not enrolled.
- Remote Config (all strings, allowlisted in `functions/src/publicConfigKeys.js`,
  safe defaults in `services/firebase.ts`):
  - `JOBGATE_EXPERIMENT_ENABLED` — kill switch; anything but `true` = today's gate
    for everybody, no v3 tags (default `false`);
  - `JOBGATE_EXPERIMENT_ARMS` — e.g. `{"control":25,"similar_alerts":25,"social_first":25,"email_first":25}`;
    invalid JSON/unknown arm/non-integer → `{"control":100}` (default);
  - `JOBGATE_EXPERIMENT_FORCE` — a valid arm forces it for everybody while
    ENABLED is `true` (QA/promotion); default empty.
- Remote Config slower than 3 s, or throwing → not enrolled for that page view
  (no late flip). Crawlers/bots are bypassed and never tagged.
- Publish: `node scripts/experiments/jobgate-rc.mjs` (dry-run: reads the
  template, validates, prints the diff of the three keys) then `--apply`
  (etag-guarded publish, no `force`). `--kill --apply` flips the kill switch.

**Telemetry contract** (shared with `scripts/analytics/job-gate-experiment-readout.mjs`):

- `experiment_assigned {experiment_id:'jobgate-v3', variant}` once per visitor,
  at the first gate shown while enrolled;
- every `job_auth_funnel` (`gate_view`, `auth_method_click`, `auth_success`,
  `auth_fail`) and the gate's `newsletter` `subscribe` carry
  `experiment_id='jobgate-v3'` + `variant` while enrolled;
- the subscriber written by the gate gets `newsletter_subscribers.variant =
  'jobgate-v3:<arm>'`.

The GA4 params `experiment_id`/`variant` on `job_auth_funnel` exist only from
#9662 (2026-09-24): earlier `job_auth_funnel` rows read `(not set)` on those
dimensions, so no v3 comparison can reach back before launch.

**Arms and hypotheses.** Baseline (GA4 + Firestore, 30 days to 2026-09-24):
49,308 persons saw the gate, 877 became new subscribers from it (1.8%): 478
via a provider (confirmed at once), 399 via email of which only ~32% confirm.
Only ~5% of gate viewers click any method, so the arms split between the
*value* problem (the 95% who never try) and the *method* problem.

| arm | change (inline gate only) | hypothesis |
| --- | --- | --- |
| `control` | none — byte-identical gate | baseline |
| `similar_alerts` | headline + first benefit promise email alerts for similar jobs; after an email unlock the pending notice says "confirm to get jobs similar to «title»" and offers "Open Gmail/Outlook…" for known providers | a concrete, recurring benefit (the job-alert backfill already derives alerts from `job_category`/`job_location`) beats the generic "free forever"; restating it at the confirmation step lifts the ~32% email confirmation |
| `social_first` | the email form starts collapsed (one tap to open) | fewer choices; shifts the mix toward provider sign-ins, which are confirmed immediately |
| `email_first` | the email form moves above the Google/LinkedIn buttons | the email path unlocks instantly without a popup/redirect or a third-party account choice — mostly mobile readers without a Google session (mobile is 30% of gate viewers but 65% of auth_success) |

Not re-tested: the longer teaser (`authgate-model-v1`/`value_first`, dropped
above); "unlock by email without waiting for confirmation" is already today's
behaviour (the email unlock is immediate).

**Metrics.** Primary: persons with a new gate subscription / persons with a
v3 `gate_view`, per arm. Secondary: `auth_success`/`gate_view` per person,
email confirmation rate (`newsletter_subscribers` with `variant` prefix
`jobgate-v3:`), `job_apply`.

**Power.** Two-sided, 80% power, Bonferroni over 3 comparisons (α=0.0167),
baseline 1.78%, 4 arms at 25%:

| detectable relative lift | persons/arm | days @1,600/day | days @1,000/day |
| --- | --- | --- | --- |
| +30% | 14,730 | 39 | 62 |
| +40% | 8,636 | 23 | 37 |
| +50% | 5,750 | 16 | 25 |

Daily gate persons: 1,675 mean over 28 days, but ~1,000/day over 2026-09-13…23.
**Minimum duration: 28 days** (four whole weeks; +40% at 1,600/day), **42 days**
if traffic stays at ~1,000/day. No early stop on a peek: decide once, at the
planned end. Round 1 moved auth_success by +50.8%, so +40% on structural
levers is an ambitious but not unprecedented target.

**Re-plan without robots (2026-09-25).** The table above used a baseline
diluted by an automation fleet (Windows + Chrome, 1280x1200 screen, from
Singapore: ~1,650 "persons"/day on the gate on 1-12/09, back in bursts from
24/09). It now never enters the experiment (`matchesAutomationScreenSignature`
in `services/botPatterns.ts`, part of `isLikelyBot()`) and the readout drops it
from every GA4 count (`GA4_EXCLUDED_TRAFFIC` in `scripts/lib/experiment-stats.mjs`,
printed per signature and arm). Without it, 16-24/09: 7,226 gate persons, 208
new gate subscribers (after the 2026-09-25 `created_at` backfill), **baseline
2.88%** (2.24% with the robots in the denominator); ~700 unique gate
persons/day over 21-42-day windows. The plan in
`scripts/experiments/jobgate-plan.mjs`: +30% relative, 80% power, α 0.05/3
→ **8,981 persons per arm**, **56 days** (analysis from 2026-09-26: the launch
day had a CDN outage 04:55-06:30 UTC), decisions on whole weeks only, maximum
70 days.

**Monitor and automatic promotion.** `.github/workflows/jobgate-experiment-monitor.yml`
runs `scripts/experiments/jobgate-monitor.mjs` daily: it rewrites one status
issue (`[jobgate-v3] Monitor esperimento: stato giornaliero`), opens/closes
alarm issues (SRM p < 0.001, an arm significantly worse than control by ≥10%
after Holm, gate subscribers missing the arm tag) and never changes anything
for an alarm. It publishes `JOBGATE_EXPERIMENT_FORCE=<winner>` (etag, no
`force`) only when the whole-week window has ≥ the planned days and persons per
arm, no SRM, a challenger beating control on the primary metric with Holm
p < 0.05, the winner not significantly worse on auth/gate or confirmation, and
≥80% of gate subscribers carrying their arm. Past 70 days without that it asks
the owner. Once FORCE is set the monitor pauses (idempotent). The decision
rules are pinned in `tests/experiment-monitor.test.ts`.

### Round 3 — result and closure (owner decision, 2026-10-05)

First whole week (2026-09-26 → 2026-10-02, robots excluded, monitor run of
2026-10-04, status issue #9874):

| arm | gate persons | new subscribers | primary CR [95% CI] | vs control | Holm p |
| --- | ---: | ---: | --- | ---: | ---: |
| control | 1528 | 152 | 9.95% [8.55 – 11.55] | — | — |
| social_first | 1556 | 148 | 9.51% [8.15 – 11.07] | −4.4% | 0.68 |
| similar_alerts | 1500 | 130 | 8.67% [7.35 – 10.20] | −12.9% | 0.45 |
| email_first | 1483 | 123 | 8.29% [7.00 – 9.81] | −16.6% | 0.35 |

SRM p = 0.69, 94% of gate subscribers carried their arm. A guardrail alarm on
auth/gate (`email_first` −21.7%, `social_first` −22.7%, Holm p ≈ 0.04) fired
on 2026-10-01 and cleared the next day on the whole-week window.

**Why it was stopped before the planned 56 days — futility, not a peek for a
winner.** The round was powered for +30% relative on the primary metric. The
upper bound of the 95% CI of the risk ratio vs control was already below that
for every challenger: `social_first` ≤ +18.6%, `similar_alerts` ≤ +8.9%,
`email_first` ≤ +4.6% (≤ +24.3% / +14.4% / +9.9% at the Bonferroni level
α/3). No arm could still reach the effect the test was sized for, while 75% of
gate traffic sat on arms whose point estimates were 4–17% worse (~50 gate
subscribers/week at the observed rates). Stopping for futility declares no
winner, so it does not inflate the false-positive rate.

Applied: `node scripts/experiments/jobgate-rc.mjs --kill --apply` →
Remote Config version 149, `JOBGATE_EXPERIMENT_ENABLED=false` (everybody back
on control). The round-3 arms, their render knobs and their copy keys
(`jobBoard.gate.v3.*`) were removed in the PR that introduced round 4.

Open question carried over: the v3 control converted at 9.95%, more than three
times the 2.88% pre-launch baseline the round was planned on. The cause was not
investigated; round 4 is planned on the v3 control because it is the same
metric from the same pipeline.

---

## Round 4 — `jobgate-v4` — visual treatment of the gate, 25/25/25/25

Same copy, same controls, same tracking and consent notice in every arm; only
colour, elevation and block order change. Arms are rendered from
`components/community/jobGateSkin.ts` (control = the exact pre-round classes);
the experiment id salts the hash, so v4 reshuffles every visitor and
`experiment_assigned` uses a new storage key (`frontaliere_jobgate_v4_assigned`).
Designed with the Impeccable design pass against `DESIGN.md` (Stripe tokens,
semantic colours, no `dark:` classes, white text ≥ 7:1 on the fixed panels).

Diagnosis of the incumbent gate (390px and 1280px screenshots, 2026-10-05):
the lavender box has the same colour as the employer card right above it, so
the decision point reads as one more info card; the strongest colour on it is
LinkedIn's brand blue, not the primary path; the email CTA sits faded
(`disabled:opacity-60`) until an address is typed; on a phone the buttons start
~1,400px below the top of the card.

| arm | change | hypothesis |
| --- | --- | --- |
| `control` | none | baseline |
| `navy_panel` | the gate becomes a deep navy panel (`navy-900`, the footer colour), white/white-tinted text, purple email CTA | figure/ground: the gate stops blending with the lavender card above and reads as the place to act |
| `spotlight` | white card lifted off the page (2px accent border + `shadow-stripe-lg`); the public preview fades into it; LinkedIn goes neutral like Google; the email CTA is the only saturated control and is never shown disabled (an empty submit is stopped by the input's native `required`) | one action, one colour: a clear "start here" instead of three competing fills |
| `actions_first` | solid brand band (`stripe-700`) with the title; sign-in buttons right under it, the registration notice directly below the buttons, explanation and benefits after | distance to action, mostly on mobile (65% of auth_success) |

**Same height in every arm.** A gate painted while Remote Config is still
loading starts as control and switches to its arm when the assignment
resolves. If the arms had different heights that switch would move the AdSense
slot below the gate (CLS, RPM). So every arm renders the gate exactly as tall
as control: arms recolour, re-order and add shadows/rings, but never change
border width, control sizes or the sum of vertical paddings and gaps
(`jobGateSkin.ts`, pinned in `tests/jobgate-experiment.test.ts`). A settled
assignment is also served synchronously by the hook, so a gate rendered after
Remote Config answered never starts as pending.

**Plan** (`scripts/experiments/jobgate-plan.mjs`): baseline 9.95% (v3 control,
2026-09-26..10-02), minimum effect +20% relative, 80% power, α 0.05 over 3
comparisons, 700 unique gate persons/day → **5,153 persons per arm, 35 days**
(five whole weeks), analysis from **2026-10-07** (Remote Config publish on
2026-10-06), maximum 70 days. Same metrics, monitor, guardrails and automatic
promotion rules as round 3.

Launch: `node scripts/experiments/jobgate-rc.mjs` (dry-run) then `--apply`,
only after the bundle with the v4 arms is live (the browser falls back to
control for an unknown arm name, so publishing early would put everyone in
control rather than break the page).

