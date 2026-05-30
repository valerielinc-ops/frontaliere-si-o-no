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

Control (`Leggi requisiti e come candidarti` / "Read requirements and how to
apply") vs `frictionless` (neutral outcome-framed CTA).

Window: 90 days ending 2026-05-30. Variant-attributed persons only.

| variant        | persons @ gate | auth_success persons | CR (per-person) |
| -------------- | -------------- | -------------------- | --------------- |
| control        | 2665           | 348                  | 13.06%          |
| **frictionless** | 1919         | 378                  | **19.70%**      |

- Absolute lift: **+6.64 pp** (95% CI ±2.14 pp)
- Relative lift: **+50.8%**
- Two-proportion z-test: **z = 6.07, p = 1.25e-9** → decisive.

**Decision:** `frictionless` wins. Promoted to 100% by moving its copy into the
`jobBoard.gate.title` i18n key (it/en/de/fr). From round 2 onward the `control`
arm therefore *is* the round-1 winner.

Frictionless copy (now the baseline):

| locale | headline |
| ------ | -------- |
| it | Continua per vedere l'annuncio completo |
| en | Continue to see the full listing |
| de | Weiter zum vollständigen Stellenangebot |
| fr | Continuer pour voir l'annonce complète |

---

## Round 2 — `authgate-headline-v2` — ACTIVE 🔬

Goal: can we beat the round-1 winner? Control (= round-1 frictionless baseline)
vs two new challengers with different psychological framings.

| variant      | framing | it copy |
| ------------ | ------- | ------- |
| control      | round-1 winner (outcome-framed) | Continua per vedere l'annuncio completo |
| free_unlock  | cost-removal + immediacy | Sblocca gratis l'annuncio completo |
| apply_now    | goal-proximity (toward applying) | Scopri come candidarti a questo lavoro |

Challenger copy per locale lives in `services/authGateExperiment.ts`
(`CHALLENGER_HEADLINES`).

**PostHog setup required to start the round:**
1. Create feature flag `authgate-headline-v2` with three variant keys:
   `control`, `free_unlock`, `apply_now` (even split, e.g. 34/33/33).
2. Roll out to the same audience as v1 (gate viewers).
3. Disable / archive `authgate-headline-v1` (round closed).

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
