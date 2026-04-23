# SEO Sprint 1 Tech Fixes — Extension 3

Data: 2026-04-23
Stato: **CHIUSO** — tutti e quattro i follow-up completati (commit
`b5daf94b0` — `refactor: Sprint 1 Extension 3 tech debt cleanup`).

Summary:
- §1 SemRush wiring — aggiunto `SEMRUSH_LANDINGS` in
  `services/router.ts` con `staticOverlay: true` (stesso pattern di
  fuel-daily / weekly-employers). Le 5 URL non subiscono più phantom-entry
  al boot SPA.
- §2 Locale-mismatch pipeline — aggiunto step
  `scripts/mark-locale-mismatched-jobs.mjs` in
  `.github/workflows/translate-pending.yml` prima del passo di traduzione
  (con `continue-on-error: true`).
- §3 `dist/` namespace cleanup — nuovo helper
  `build-plugins/shared/distNamespaceCleanup.ts` + wired in fuel-daily /
  weekly-employers / job-market-snapshot / health-premiums / border-wait.
  Skippati orphan-query (collisione `/ricerca/` con editorial jobs) e
  nursing (leaf pages singole).
- §4 Vitest 4 migration — `poolOptions.threads.isolate` portato al top
  level di `InlineConfig`; TypeScript check pulito.

## Contesto

Extension 2 ha chiuso i 9 carryover di test rossi. Nel farlo sono emersi
tre fronti che non bloccano il prepush ma lasciano debito residuo.

## Follow-up

### 1. Workstream C SemRush landing pages — wiring SPA

Le 5 pagine (`tassa-salute-frontalieri`, `lamal-frontalieri`,
`outlet-fox-town-mendrisio`, `ponti-2026-ticino`,
`vacanze-scolastiche-ticino-2026`) sono generate come HTML statico via
`canonicalPath` ma il `router.ts` non mappa le URL corrispondenti. Un
utente che arriva via link esterno vede il contenuto statico, poi al
boot della SPA viene reindirizzato a un sub-tab casuale (comportamento
oggi non documentato né coperto da test).

Azione:
- Aggiungere entry a `SLUG_TABLES[locale].subSlugs` o definire nuovo
  schema `seoLanding` dedicato per questa classe di pagine.
- Aggiornare `getSeoSection` in `services/router.ts` in modo che le URL
  non generino phantom-entry; rimuovere poi i 5 slug da
  `INTERNAL_KEYS` in `tests/seo-completeness.test.ts`.
- Test E2E Playwright: soft-nav + deep-link devono restare sulla URL.

### 2. Pipeline retraduction automatica (job-locale-consistency)

Il nuovo script `scripts/mark-locale-mismatched-jobs.mjs` va eseguito
manualmente. Al prossimo giro di crawler flaggeremo di nuovo i mismatch
e la soglia di 10 potrebbe saltare.

Azione:
- Integrare lo script come step nel workflow
  `.github/workflows/translate-pending.yml` (o equivalente), subito
  prima di avviare il batch AI di retraduction.
- Allargare la detection al campo `title` oltre che a `description`
  (oggi solo le description ≥120 char vengono valutate).
- Eventualmente abbassare la soglia a 5 quando la pipeline gira
  settimanale (attualmente il test tollera ≤10).

### 3. `dist/` cleanup prima del build

Durante il debug della breadcrumb coverage abbiamo trovato tre file
company×city HTML vuoti (0 byte) di due build precedenti che non erano
stati rimossi perché il plugin attuale correttamente salta il thin
content. Questi residui ingannano il test per via delle directory
rimaste.

Azione:
- Aggiungere a `build-plugins/weeklyEmployersPlugin.ts` una passata di
  cleanup all'inizio del `closeBundle`: rimuovere cartelle
  company×city obsolete non più generate in questa build.
- In alternativa, promuovere `rm -rf dist/` al preBuild (script npm
  `prebuild`) per evitare intermediate caching.

### 4. vitest 4 config migration

`vitest.config.ts` ancora usa `test.poolOptions`, rimosso in vitest 4.
`npx tsc --noEmit` lancia un solo errore su questa riga.

Azione:
- Portare la config alla nuova forma top-level
  (`maxWorkers`/`singleThread`/ecc. diretti in `InlineConfig`).
- Rimuovere l'error suppress nel pre-push hook una volta verde.
