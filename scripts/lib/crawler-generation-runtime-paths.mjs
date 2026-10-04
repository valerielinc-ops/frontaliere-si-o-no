// Path del sito che i gruppi crawler eseguono nel corpus attraverso il
// finalizer: la chiusura degli import di
// scripts/crawler-group-generation-finalizer.mjs, piu' i path che il workflow
// generato usa senza importarli (git-commit-data.sh serializza con
// global-data-pipeline-lease.mjs). Il generatore li dichiara e li hash-binda in
// ogni artifact di gruppo (scripts/generate-crawler-group-workflows.mjs) e
// tests/generate-crawler-group-workflows.test.ts confronta l'elenco con la
// chiusura reale letta da disco.
//
// Un import nuovo in uno di questi moduli cambia la chiusura senza che nessun
// import statico colleghi il test al modulo: per questo
// scripts/ci/run-related-tests.mjs seleziona quel test quando il diff tocca uno
// di questi path. La PR 11262 aveva aggiunto detail-failure-reuse-policy.mjs
// (importato da crawler-grace-policy.mjs) senza che il test girasse, e main e'
// rimasto rosso in latenza.
export const CRAWLER_GENERATION_RUNTIME_PATHS = Object.freeze([
  'functions/src/githubApiHeaders.js',
  'scripts/crawler-group-generation-finalizer.mjs',
  'scripts/lib/accumulator-byte-floor-guard.mjs',
  'scripts/lib/atomic-write-json.mjs',
  'scripts/lib/canonical-json-digest.mjs',
  'scripts/lib/crawler-generation-contract.mjs',
  'scripts/lib/crawler-generation-group-ids.mjs',
  'scripts/lib/crawler-generation-receipt.mjs',
  'scripts/lib/crawler-generation-token.mjs',
  'scripts/lib/crawler-grace-policy.mjs',
  'scripts/lib/crawler-location-config.mjs',
  'scripts/lib/crawler-slice-integrity.mjs',
  'scripts/lib/detail-failure-reuse-policy.mjs',
  'scripts/lib/global-data-pipeline-lease.mjs',
  'scripts/lib/job-match-key.mjs',
  'scripts/lib/job-url-key.mjs',
  'scripts/lib/locale-map-diff.mjs',
  'scripts/lib/prospector/country-inventory.mjs',
  'scripts/lib/slug-history-journal.mjs',
  'scripts/lib/slug-preservation-guard.mjs',
  'scripts/lib/target-swiss-locations.mjs',
]);
