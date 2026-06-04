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

## Round 2 — `authgate-headline-v2` — ACTIVE 🔬

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
