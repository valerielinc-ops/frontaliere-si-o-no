# TODOS

## P2 — Performance Budget in CI
**What:** Add Lighthouse CI step to GitHub Actions that blocks deploys when Core Web Vitals exceed thresholds (LCP > 2.5s, CLS > 0.1, TBT > 200ms).
**Why:** Protects SEO growth channel from silent performance regressions. 170+ automated crawler workflows push commits daily — any could degrade CWV.
**Effort:** S human / S CC+gstack
**Depends on:** Quality push completing (establishes clean baseline to gate against).

## P2 — JobBoard.tsx Decomposition
**What:** Extract domain hooks from JobBoard.tsx (6,835 lines) — job search, filtering, detail view, auth gate.
**Why:** Same god-component pattern as App.tsx. Currently the second-largest file in the codebase at 275KB.
**Effort:** L human / M CC+gstack
**Depends on:** App.tsx hook wiring completing successfully (proves the pattern works).

## P3 — Motion/Animation System
**What:** Define enter/exit transitions for key UI elements: Callout component fade-in, calculator results opacity transition (useDeferredValue stale indicator), skeleton-to-content swap, toast slide-up/fade-out. Standardize duration (150-300ms), easing (ease-out), and respect existing prefers-reduced-motion.
**Why:** The quality push changes spacing, fonts, and components across every page without addressing how state transitions look. Motion is what makes "polished" feel polished vs. "things just appearing."
**Effort:** S human / S CC+gstack
**Depends on:** Quality push completing (provides the components to animate).

## P3 — Correct Technical Audit Document
**What:** Fix stale/inaccurate claims in docs/technical-audit-2026-04-14.md: (1) `<main>` landmark already exists, (2) Inter + Space Grotesk already loaded, (3) calculationService already dynamic in App.tsx, (4) 5 hooks already extracted in hooks/ directory. Add a scoring rubric for each dimension.
**Why:** Anyone reading the audit gets misleading data. The 63-issue count is inflated and the 10/20 score is based on at least 3 stale claims.
**Effort:** S human / S CC+gstack
**Depends on:** Nothing. Can be done anytime.
