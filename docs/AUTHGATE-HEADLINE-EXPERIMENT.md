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
