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

## P2 — "Mia rotta" profilo commute frontaliere + email/push alert
**What:** Profilo utente con rotta commute registrata (Como→Lugano via Chiasso, partenza 6:00). Cron mattina presto valuta condizioni (meteo + tempo attesa + chiusure) e invia email/push 30 min prima della partenza ipotetica se condizioni avverse.
**Why:** Chiusura del funnel SEO→newsletter→retention. Le pagine weather (city + alert + valico fusion) catturano il visitatore ma senza profilo la riattivazione resta passiva. Differenziante difendibile (nessun concorrente offre commute-meteo personalizzato per frontalieri).
**Effort:** L human / M CC+gstack — fase 1 email-only (~2gg/2h CC), fase 2 web push (~5gg/5h CC)
**Depends on:** Weather SSG plan shipped. Pre-requisiti tecnici (acquisitionSource, weatherService, weatherAlertEvaluator, cron meteo) introdotti nel piano weather.
**Plan reference:** `~/.gstack/projects/frontaliere-si-o-no/ceo-plans/2026-05-07-weather-ssg.md` (proposta 3, deferred)

## P2 — Deploy bottleneck resolution
**What:** Risolvere il bottleneck su deploy.yml che fa eseguire solo ~15-20 deploys/day a fronte di ~50 push/day.
**Why:** Bloccante per ogni feature data-refresh (incluso weather cron 6×/day del piano 2026-05-07). Aggiungere altri cron commit aggrava il problema.
**Effort:** M human / M CC+gstack (dipende dall'opzione scelta)
**Depends on:** Decisione utente sull'opzione architetturale (deferred dal May 6 brainstorm).
**Update 2026-05-22:** Sostituito dal piano architetturale B "Incremental persistent gh-pages" (CEO review 2026-05-22). Vedi P2 sotto e i 3 TODO collegati. Chiudi quando Phase 6 cutover completato.

## P2 — Incremental persistent gh-pages: daily full-rebuild canary
**What:** Workflow `.github/workflows/canary-full-rebuild.yml`, cron 1×/giorno. Esegue full vite build da clean checkout, diffa byte-per-byte (modulo timestamp) vs dist attuale su branch `gh-pages`. Se drift > 0: apre auto-issue con elenco file divergenti + setta flag che forza full rebuild al prossimo deploy.
**Why:** Safety net per il plugin contract opt-in (D4 decisione CEO review 2026-05-22). I 144 plugin legacy non-migrati restano opachi al change detection — solo il canary giornaliero rileva se la loro logica cambia silenziosamente e produce dist incrementale stale. Senza canary, regressioni invisibili in produzione.
**Effort:** S human / S CC+gstack (~3-4h: workflow definition + diff script + auto-issue logic)
**Depends on:** Phase 5 del rollout incremental deploy. Va shippato PRIMA di Phase 6 (cutover flag default-on).

## P3 — Migrazione plugin 6-20 a IncrementalPlugin contract
**What:** Dopo Phase 6 (cutover), batch progressivo di migrazione plugin medi al contract `IncrementalPlugin { declaredInputs, declaredOutputs, renderSingle }`. Lista candidati ordinata per volume HTML emesso: weather (city+alert+fusion), fuel-daily, health-premiums, profession-landings, salary-hub, weekly-employers, job-market-snapshot, orphan-query, related-search-clusters, comparisons-hub, career-landings, nursing-landings, cost-of-living, faq-hub, salaire-net-fr.
**Why:** Top 5 plugin coprono ~70% HTML output. Migrando 6-20 si arriva a ~90% coverage → daily canary noise scende a near-zero, drift events tracciati solo sul long-tail.
**Effort:** M human / M CC+gstack (1-2h per plugin × 15 plugin, parallelizzabile con subagent dispatcher)
**Depends on:** Phase 6 cutover stabile per 1+ settimana senza incidents.

## P3 — `docs/INCREMENTAL-DEPLOY.md` runbook
**What:** Documentazione architetturale incremental persistent gh-pages: diagramma ASCII full pipeline, invariants (manifest sempre consistente con dist, concurrency group obbligatorio, single-commit-per-deploy = atomic), schema `.manifest.json`, runbook recovery per ghpages corruption (git reset + force-push + flag full-rebuild), runbook drift escalation, lista plugin con/senza contract.
**Why:** Un engineer nuovo in 12 mesi non capirà che gh-pages è source-of-truth mutabile (Sec 10 long-term review). Senza doc, lock-in cognitivo + rischio onboarding bug. Anche per te: dopo 3 mesi senza toccarlo, runbook recovery in fretta.
**Effort:** S human / S CC+gstack (~2h: copia diagrammi dal CEO review + scrivi invariants + runbook)
**Depends on:** Phase 6 cutover completato (così la doc descrive lo stato reale, non un piano).

## P3 — GSC 90gg low-impression URL audit (Approach A originale, deferred)
**What:** Script `scripts/audit-gsc-low-impression.mjs`: pull dati GSC ultimi 90gg, identifica URL con <3 impressions, propone redirect 301 al parent. Output: report `data/gsc-low-impression-redirects-{date}.json` per review umana. Optional: applicazione automatica via build plugin nuovo `legacyRedirectsPlugin` esistente.
**Why:** Approccio A scartato in favore di B nel CEO review 2026-05-22, ma resta valido come ulteriore riduzione dist quando il daily canary mostra che le long-tail pages creano drift noise sproporzionato. Anche cleanup salutare per il manifest size.
**Effort:** M human / S CC+gstack (~1 gg: script + GSC API + parent-mapping logic)
**Depends on:** Phase 6 + 1 mese di dati canary. Se 0 drift events: deferred indefinitamente. Se >5 drift events/settimana sulle pagine low-impression: do this.
