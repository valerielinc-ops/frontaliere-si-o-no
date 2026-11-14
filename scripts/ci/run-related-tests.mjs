#!/usr/bin/env node
/**
 * Run only tests related to the current PR diff.
 *
 * Vitest's `related` command rebuilds an in-memory Vite graph for every CI
 * run and inspects every discovered spec. In this repository that discovery
 * costs minutes while the selected tests take seconds. This runner keeps a
 * small static import graph on disk, updates only changed files, and passes
 * symbol-owned test files directly to Vitest. Asset roots retain their
 * bounded reader closure. It stays related-only for ordinary imports, with a conservative
 * full-test run only when the changed file is the global Vitest config.
 * An incomplete diff or an unmodelled source edge fails fast instead of
 * turning uncertainty into a full suite. Runtime/configuration files are not
 * treated as global Vitest dependencies by default: the root
 * `vitest.config.ts` is the explicit exception because it configures every
 * test project, while CI and TypeScript
 * configuration stay outside this policy. `scripts/ci/run-related-tests.mjs`
 * has an explicit, bounded regression-test allow-list because its consumers
 * read it by path instead of importing it. Test-tree lints (tests that scan
 * every test file instead of importing one) join the selection whenever the
 * diff touches a test file; source-tree lints (tests that scan `.github`,
 * `scripts` and `bin` by directory, the whole tracked tree for
 * credential-shaped literals, or data files that no import connects to them,
 * such as the loop-fleet ledger replay) join it whenever the diff touches
 * their scope.
 * `--select-only`
 * computes the same selection without invoking Vitest and emits the
 * pre-assembly dataset decision for tests.yml.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { listCorpusWideTests } from './corpus-wide-tests.mjs';
import { shouldAssembleForRelatedTests } from './dataset-dependent-tests.mjs';
import { selectMaxWorkers, vitestChildEnv } from './lib/select-max-workers.mjs';
import { missingFullCheckoutArtifacts } from './lib/typecheck-sparse.mjs';
import { GRAPH_IGNORED_RE, GRAPH_SOURCE_RE, isGraphSourceFile } from './lib/related-graph-scope.mjs';
import { CRAWLER_GENERATION_RUNTIME_PATHS } from '../lib/crawler-generation-runtime-paths.mjs';
import { isArticlePublisherCodePath } from '../lib/article-chunk-publish-freshness.mjs';
import { isScanned as isSecretScanned, scanText } from './scan-site-hardcoded-secrets.mjs';
import { TRANSPORT_MANIFEST, transportManifestPaths } from './corpus-ahead-check.mjs';
import { stripSourceComments } from '../lib/source-comments.mjs';

const changedPathFile = process.env.CHANGED_PATHS_FILE || 'changed-paths.txt';
const changedStatusFile = process.env.CHANGED_PATHS_STATUS_FILE || 'changed-paths-status.txt';
const graphFile = process.env.VITEST_RELATED_GRAPH || '.cache/vitest-related/graph.json';
const graphVersion = 20;
const require = createRequire(import.meta.url);
let typescript;
const selectionOnly = process.argv.includes('--select-only');
const sourceRe = GRAPH_SOURCE_RE;
const testRe = /^(?:tests|packages\/[^/]+\/tests)\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const runnerPath = 'scripts/ci/run-related-tests.mjs';
const globalVitestConfigPaths = new Set(['vitest.config.ts']);
// Questo selettore non esclude nessun test per il suo costo. Dal 06
// all'08-10-2026 un elenco fisso teneva fuori da ogni esecuzione automatica i
// due file che ricostruiscono artefatti generati
// (`tests/generate-crawler-group-workflows.test.ts`, 145 casi, e
// `tests/translation-state-drainer-v2.test.ts`, 31): il percorso dedicato che
// doveva sostituire il gate non e' mai stato costruito, e 17 ore dopo la PR
// 12158 ha aggiunto un quarto consumatore del broker Codex al workflow di
// traduzione senza che il caso che ne fissa l'elenco girasse. Il costo si
// limita con la precisione della selezione, non togliendo il test: in sette
// giorni le PR che toccano la chiusura del primo file sono state 37 su 1263,
// quelle che toccano la chiusura del secondo nessuna.
// These tests exercise the runner through its real subprocess seam or pin its
// CI wiring. They are deliberately explicit: broadening every `scripts/` or
// `.github/` change into a full suite would undo the related-test bound.
const runnerRegressionTests = new Set([
  'tests/run-related-tests-selection.test.ts',
  'tests/run-related-tests-doc-contracts.test.ts',
  'tests/run-related-tests-sparse.test.ts',
  'tests/ci-vitest-check-name.test.ts',
  'tests/agents-related-tests-recipe.test.ts',
]);
// Lint dell'ALBERO dei test: scandiscono ogni file di test per directory e non
// ne importano nessuno, quindi il grafo inverso non li sceglie mai proprio
// quando servono, cioe' quando una PR aggiunge o modifica un test. Girano
// ogni volta che il diff tocca un file di test (#9743: un test nuovo che
// fissa un conteggio letterale su un file riscritto da un cron).
const testTreeLintTests = new Set([
  'tests/check-cron-count-literals.test.ts',
  // Il guard «un test del gate non legge dati vivi» scandisce ogni file di
  // test e li confronta con un inventario: deve girare sulla PR che aggiunge il
  // test, ed e' l'unico momento in cui serve. Girava solo quando cambiavano i
  // suoi import: `tests/license-audit.test.ts` (PR 12232) e' entrato senza una
  // voce nell'inventario e il guard e' rimasto rosso su main in latenza.
  'tests/live-data-test-guard.test.ts',
]);
// Perimetro del transport verso nanako: il manifest e i path che consegna.
// Letto alla prima domanda, non all'avvio: la maggior parte dei diff si ferma
// prima dei lint. Glob `dir/**` espansi contro l'albero reale, come nel guard.
let transportScope = null;
const isTransportScope = (file) => {
  transportScope ??= new Set([TRANSPORT_MANIFEST, ...transportManifestPaths(process.cwd())]);
  return transportScope.has(file);
};
// Lint dell'albero dei SORGENTI: scandiscono directory e file di workflow e non
// nominano tutti i file che giudicano, quindi né il grafo inverso né l'indice
// dei letterali li collegano al diff. Il loro predicato deve però essere
// specifico anche qui: il fatto che un file stia sotto `scripts/` non basta.
// Sulla PR 9959 i due fixer contavano i commenti con
// `--paginate --slurp --jq`, che il gh reale rifiuta; il guard esisteva dal
// 25-09 (#9797) ma su 126 test scelti per quel diff lui mancava.
//
// Il perimetro può essere una RegExp oppure un predicato path+contenuto. I
// predicati leggono il file cambiato e riconoscono la forma che il test guarda;
// un file cancellato o non materializzato fa scattare il guard fail-closed.
const crawlerGenerationRuntimePaths = new Set([
  ...CRAWLER_GENERATION_RUNTIME_PATHS,
  'scripts/lib/crawler-generation-runtime-paths.mjs',
]);
// `tests/social-robot.test.ts` walks the launchd snapshot closure from disk,
// so the reverse import graph cannot select it when one of those files changes.
// Keep the non-directory leaves in step with the closure test; the whole robot
// directory is covered by construction because launchd snapshots it as a unit.
const socialRobotClosurePaths = new Set([
  'scripts/lib/github-issue-creator.mjs',
  'scripts/lib/google-service-account-token.mjs',
  'scripts/lib/social-carousel-video.mjs',
  'scripts/lib/social-publish-queue.mjs',
  'scripts/load-rc-env.mjs',
]);

// A directory is not a dependency. The old selector treated every file under
// `scripts/` as an input to a dozen source-tree census tests, so changing an
// unrelated script (for example the portal replay) launched all of them. A
// source-tree lint still scans the whole tree once it is selected, but the
// selector admits it only when the changed file can contain the construct that
// the lint guards. This keeps the invariant while keeping the PR run local.
const textMatches = (text, patterns) => patterns.every((pattern) => {
  pattern.lastIndex = 0;
  return pattern.test(text);
});

const sourceTextMatches = (file, patterns) => {
  try {
    const raw = readFileSync(file, 'utf8');
    const text = /\.(?:mjs|cjs|js|mts|cts|ts|tsx|jsx?)$/i.test(file)
      ? stripSourceComments(raw)
      : raw;
    return textMatches(text, patterns);
  } catch {
    // A deleted or sparse-only file is still a meaningful input to a tree
    // census. Fail closed for that file instead of silently dropping its guard.
    return true;
  }
};

const pathAndSourceMatch = (pathPattern, ...patterns) => (file) =>
  file !== runnerPath && pathPattern.test(file) && sourceTextMatches(file, patterns);

const runListingWithoutCreatedWindow = (file) => {
  if (!/^(?:\.github|scripts|bin|functions)\//.test(file)) return false;
  try {
    const raw = readFileSync(file, 'utf8');
    const text = /\.(?:mjs|cjs|js|mts|cts|ts|tsx|jsx?)$/i.test(file)
      ? stripSourceComments(raw)
      : raw;
    const listing = /\brun\s+list\b|['"]run['"]\s*,\s*['"]list['"]|actions\/(?:workflows\/[^/\s'"`]+\/)?runs\?/;
    const branch = /--branch\b|\s-b\s|['"]-b['"]|[?&]branch=/;
    const created = /--created\b|[?&]created=|createdSince(?:Filter|Query)?\(/;
    return listing.test(text) && branch.test(text) && !created.test(text);
  } catch {
    return true;
  }
};

const secretSourceChange = (file) => {
  if (!isSecretScanned(file)) return false;
  try {
    return scanText(readFileSync(file, 'utf8'), file).length > 0;
  } catch {
    return true;
  }
};

const housekeepingRuntimePaths = new Set([
  'scripts/cleanup-jobs.mjs',
  'scripts/load-rc-env.mjs',
  'scripts/lib/git-commit-data.sh',
  'scripts/lib/crawler-generation-receipt.mjs',
  'scripts/ci/canonicalize-expired-archive-slice.mjs',
  'scripts/lib/run-bounded-command.mjs',
  'scripts/lib/pipeline-phase-timing.mjs',
]);
const housekeepingScope = (file) => file === '.github/workflows/housekeeping-jobs-logic.yml'
  || file === 'scripts/ci/housekeeping-sparse-paths.txt'
  || housekeepingRuntimePaths.has(file)
  || file.startsWith('packages/articles/engine/shared/')
  || pathAndSourceMatch(/^scripts\/lib\//, /(?:crawler|housekeeping|expired|published|slug|translation|job)/i)(file);

// The Bing workflow has an explicit code allow-list in YAML. Keep the
// selector aligned with the named modules rather than with its broad sparse
// checkout (`/scripts/`), which is an I/O optimisation and not a test scope.
let bingWorkflowScope;
const bingSeoScope = (file) => {
  if (file === '.github/workflows/bing-seo-loop.yml') return true;
  bingWorkflowScope ??= (() => {
    try {
      const workflow = readFileSync('.github/workflows/bing-seo-loop.yml', 'utf8');
      return new Set([...workflow.matchAll(/\/(?:scripts|build-plugins|packages\/articles\/engine)\/[A-Za-z0-9_./-]+/g)]
        .map(([match]) => match.slice(1)));
    } catch {
      return new Set();
    }
  })();
  if (bingWorkflowScope.has(file)) return true;
  return pathAndSourceMatch(
    /^(?:scripts|build-plugins\/shared|packages\/articles\/engine)\//,
    /(?:jobBoard|plateAuction|professionLandings|salaryProfession|articleSections|eventsSections|healthFacilitiesSections|pharmacySections|borderWaitSections|healthPremiumSections|weeklyJobMarketSections|canonicalExemptions|meta-description)/i,
  )(file);
};

const viteConfigScope = (file) => file === 'vite.config.ts'
  || /^build-plugins\//.test(file)
  || pathAndSourceMatch(/^(?:services|components|data|functions|infra|scripts|packages\/articles)\//,
    /(?:from|import\s*\()\s*['"]@\//)(file);

const checkoutProfileScope = (file) => /^(?:\.github\/(?:workflows|actions)\/|package(?:-lock)?\.json$)/.test(file)
  || /^(?:scripts\/ci\/(?:apply-checkout-profiles|checkout-profile-analyzer|checkout-profile-contracts|verify-checkout-profiles|check-dependency-free-import-closure)|tests\/checkout-sparse-profiles\.test\.ts)$/.test(file)
  || pathAndSourceMatch(/^(?:scripts|functions|services|build-plugins|infra|server|packages\/articles)\//,
    /(?:sparse-checkout|sparseIncludesPath|GLOBAL_TESTS_REQUIRED_SPARSE_PATHS|TYPECHECK_REQUIRED_SPARSE_PATHS|checkout-profile|checkoutEntryPoints|verifyCheckoutProfiles)/i)(file);

const coreLocaleSource = /^services\/locales\/[^/]+-core\.ts$/;
const sourceTreeLintTests = new Map([
  // This completeness guard discovers translation keys by scanning all of
  // `services/` and `components/`, so no import edge ties a locale dictionary
  // edit to the check that proves every used key still exists in all locales.
  ['tests/i18n-completeness.test.ts', /^services\/locales\//],
  // These cross-locale contracts read locale shards through computed paths, so
  // the import graph cannot connect a core locale edit to their assertions.
  ...[
    'tests/application-concierge-contract.test.ts',
    'tests/assisted-application-decided-answers-review.test.ts',
    'tests/application-intent-consent-ui.test.ts',
    'tests/company-alert.test.ts',
    'tests/employer-insights-surface.test.ts',
    'tests/jobgate-experiment.test.ts',
    'tests/newsletter-title-neutrality.test.ts',
    'tests/signup-prompt-funnel.test.ts',
    'tests/telegram-channel-cta.test.tsx',
  ].map((test) => [test, coreLocaleSource]),
  // The mid-plugin equivalence suite imports its variants dynamically and is
  // the trusted oracle for the module-load flag contract. The shared facade
  // is otherwise only consumed by build plugins, so a facade-only change can
  // otherwise miss the suite in the reverse graph. Keep this edge explicit and
  // let the normal full-checkout guard protect the verdict.
  ['tests/mid-plugins-equivalence.test.ts', /^(?:build-plugins\/shared\/midPluginFlags\.ts|scripts\/lib\/mid-plugins-flag\.mjs)$/],
  // The pruner is executed in a disposable subprocess, never imported into
  // Vitest (importing it would execute cleanup). These are real runtime/read
  // dependencies that the static import graph cannot infer from path.join.
  ...[
    'tests/pruner-isolation.test.ts',
    'tests/worktree-prune-signals.test.ts',
    'tests/prune-merged-worktrees-e2e.test.ts',
    'tests/prune-merged-worktrees-proofs-e2e.test.ts',
    'tests/prune-merged-worktrees-corpus-e2e.test.ts',
    'tests/prune-merged-worktrees-expiry-e2e.test.ts',
    'tests/prune-merged-worktrees-reclaim-e2e.test.ts',
  ].map((test) => [test, /^scripts\/prune-merged-worktrees\.mjs$/]),
  ['tests/gh-slurp-jq-guard.test.ts', pathAndSourceMatch(/^(?:\.github|scripts|bin)\//, /--slurp\b/, /(?:--jq\b|--template\b|\s-[qt]\s)/)],
  ['tests/no-hardcoded-secrets.test.ts', secretSourceChange],
  // `consent-shown-at-signup` discovers signup writers by reading every file
  // under these roots. Those `read()` calls are the contract, but they are
  // invisible to the static import graph; keep the observer adjacent to the
  // scan so a new writer cannot leave its verdict stale on main.
  [
    'tests/consent-shown-at-signup.test.tsx',
    (file) => file === 'App.tsx' || /^(?:components|hooks|services)\//.test(file),
  ],
  // Chiusura per import del transport verso nanako: il test legge il manifest
  // e gli import dei file trasportati da disco, quindi non importa nessuno dei
  // file che giudica. La PR 10973 ha fatto importare a
  // `build-plugins/borderWaitData.ts` (trasportato) un modulo non consegnato:
  // il diff non lo selezionava e il rosso e' emerso giorni dopo sulla 11299.
  // Il perimetro e' il manifest stesso, parsato dalla funzione del guard.
  ['tests/mirror-transport-import-closure.test.ts', isTransportScope],
  // Elenchi di run per `branch` senza finestra `created`: l'API li restituisce
  // a tratti fermi a settimane prima (resolver dell'artifact Pages, 02-10).
  ['tests/run-listing-created-window.test.ts', runListingWithoutCreatedWindow],
  // Il guard del nome del check vitest legge da disco ogni script sotto
  // `scripts/ci/`: un file NUOVO che scrive a mano il literal non importa
  // niente che il test conosca. La PR 11667 l'ha introdotto in
  // `scripts/ci/lib/followup-ci-suite-proof.mjs` e main e' rimasto rosso in
  // latenza finche' la 11705 non ha fatto selezionare il test.
  ['tests/ci-vitest-check-name.test.ts', pathAndSourceMatch(/^scripts\/ci\//, /VITEST_(?:CHECK_NAME|EXECUTION_JOB_NAME|SHARD_NAME_RE)|vitest|auto-merge-eval|pr-autorebase/)],
  // Lint del token App su TUTTI i workflow (issue 10114): un workflow nuovo
  // che pusha con `env.APP_TOKEN || ...` non importa niente, e uno script in
  // `scripts/` puo' cominciare a pushare o a leggere APP_TOKEN senza che il
  // workflow che lo lancia cambi. Il test legge entrambi da disco. Il runner
  // stesso e' escluso: non pusha, e la sua suite di regressione ha un budget.
  [
    'tests/workflow-app-token-capability.test.ts',
    pathAndSourceMatch(/^(?:\.github\/workflows|scripts)\//, /\bAPP_TOKEN\b/),
  ],
  // La lista sparse dell'observer delle generazioni crawler sta nel YAML: il
  // test la confronta con la chiusura degli import di
  // `scripts/crawler-generation-observer.mjs`, ma nessun import lo lega ai
  // moduli della chiusura. Sulla PR 11262 un import nuovo in
  // `crawler-grace-policy.mjs` e' uscito dalla lista e main e' rimasto rosso
  // in latenza. I moduli JS della chiusura vivono in `scripts/` e
  // `functions/` (githubApiHeaders.js); l'unico file fuori
  // (`data/canton-municipalities.json`) e' un JSON foglia e non puo'
  // aggiungere import. Il test costa meno di un secondo.
  ['tests/crawler-generation-observer-workflow.test.ts', (file) => crawlerGenerationRuntimePaths.has(file) || file === 'scripts/crawler-generation-observer.mjs'],
  // La lista sparse di housekeeping sta in un file, non nel YAML (il corpus
  // pinna il YAML, il codice e' quello di main): il test calcola la chiusura
  // degli import degli entrypoint, quindi nessun import lo collega al modulo
  // che ne aggiunge uno fuori lista. Deve girare proprio su quel diff.
  ['tests/housekeeping-sparse-paths.test.ts', housekeepingScope],
  // Stessa forma per i gruppi crawler: il generatore dichiara la chiusura degli
  // import del finalizer con un elenco e il test la confronta con quella reale
  // letta da disco. Sulla PR 11262 un import nuovo in crawler-grace-policy.mjs
  // e' passato senza che il test girasse. Il perimetro e' l'elenco stesso, non
  // una regex che possa divergere da esso.
  ['tests/generate-crawler-group-workflows.test.ts', (file) => crawlerGenerationRuntimePaths.has(file)],
  // Stessa forma per il codice che pubblica gli articoli: il test parte dagli
  // script che il replay invoca e ne segue da disco import e processi figli,
  // ma ne importa solo due. Un import nuovo in uno degli altri allarga la
  // chiusura senza che il grafo scelga il test. Il perimetro e' l'elenco che
  // il classificatore stesso usa.
  ['tests/scripts/article-chunk-publish-freshness.test.ts', isArticlePublisherCodePath],
  // Il ledger durevole dei loop e' riletto a runtime contro il registry
  // corrente: un cambio di sourceRefs senza historicalSourceRefs lo rende
  // illeggibile. Registry e ledger sono dati, nessun import li collega al test
  // che li rilegge. Sulla PR 11001 un diff del solo registry e' passato verde e
  // l'observer del lifecycle e' caduto al cron dopo (issue 11178).
  ['tests/loop-fleet-registry-ledger-replay.test.ts', /^(?:data\/loop-fleet\/|scripts\/lib\/loop-fleet-contract\.mjs$)/],
  // Il gate di famiglia j2w scopre i parser leggendo da disco ogni `.mjs` sotto
  // `scripts/lib/`, ricorsivo: un modulo nuovo non e' importato dal test e il
  // grafo inverso non lo collega. La PR 11308 ha aggiunto un registro che
  // il predicato eleggeva ed e' passata verde; il rosso e' emerso sulla 11346,
  // che toccava per caso un import del test. Il perimetro e' quello dello scan.
  ['tests/successfactors-parser-quality.test.ts', /^scripts\/lib\/.+\.mjs$/],
  // Stessa forma, altri gate che eleggono la loro popolazione leggendo
  // `scripts/lib/` da disco: ognuno col perimetro del proprio scan.
  ['tests/successfactors-jobs2web-widget-guard.test.ts', /^scripts\/lib\/[^/]+\.mjs$/],
  ['tests/prospective-ch-shared-parser-contract.test.ts', /^scripts\/lib\/[^/]+-job-parser\.mjs$/],
  ['tests/crawler-brand-domain-pairing.test.ts', /^scripts\/lib\/[^/]+-job-parser\.mjs$/],
  ['tests/listing-url-fallback-audit.test.ts', /^scripts\/lib\/[^/]+-job-parser\.mjs$/],
  // Legge sia i parser sia gli `update-*-jobs.mjs` al primo livello di scripts/.
  ['tests/bespoke-crawler-slug-boundary.test.ts', /^scripts\/(?:update-[^/]*-jobs\.mjs|lib\/[^/]+-job-parser\.mjs)$/],
  // Il ratchet a due lati dei runner senza contatori conta gli
  // `update-*-jobs.mjs` leggendoli da disco (piu' il template, letto per
  // testo): il diff che strumenta, aggiunge o toglie un runner non tocca nessun
  // import del test. Senza questa voce il budget restava stantio sulla PR che
  // cambia il conteggio e il rosso `RATCHET STALE` cadeva sulla PR successiva.
  ['tests/crawler-zero-path-contract.test.ts', /^scripts\/(?:update-[^/]*-jobs\.mjs|lib\/crawler-template\.mjs)$/],
  // Contratto statico dei parser (issue 11674): il lint legge da disco ogni
  // parser e runner e li confronta con la baseline a ratchet; nessun import
  // lega il test al parser che giudica, e un parser senza test proprio non
  // selezionava niente. La baseline e' letta da disco anche lei.
  ['tests/parser-diff-contract.test.ts', /^scripts\/(?:lib\/.*-job-parser|update-.*-jobs)\.mjs$|^scripts\/ci\/parser-contract-baseline\.json$/],
  // Lo scan copre scripts/lib/** piu' un file nominato fuori da lib.
  ['tests/sanitize-control-chars.test.ts', /^scripts\/(?:lib\/.+\.(?:mjs|cjs|js)|publish-article-fast\.mjs)$/],
  ['tests/bounded-parallel.test.ts', /^scripts\/lib\/[^/]+\.sh$/],
  // Il guard dei limiti/lifecycle R2 legge da disco gli script del percorso
  // deploy e il loro helper condiviso, senza importarli. Senza questa voce una
  // modifica all'helper potrebbe saltare il guard fino a una PR non correlata.
  ['tests/r2-calls-bounded.test.ts', /^scripts\/(?:lib\/(?:deploy-it-pages-prep|upload-cdn-file|r2-image-lease-process)\.sh|ci\/check-house-ad-images\.mjs)$/],
  // These guards read workflow and R2-manifest files from disk rather than
  // importing them, so keep their runtime dependencies in the related graph.
  ['tests/deploy-cdn-ordering-gate.test.ts', /^(?:\.github\/workflows\/deploy\.yml|scripts\/lib\/deploy-it-pages-prep\.sh)$/],
  ['tests/job-og-cache-prewarm.test.ts', /^(?:\.github\/workflows\/(?:deploy|og-jobs-cache-prewarm|deploy-publish)\.yml|scripts\/ci\/prepare-r2-og-delta\.mjs|scripts\/lib\/push-section-shard\.sh)$/],
  ['tests/r2-og-manifest-carry.test.ts', /^\.github\/workflows\/deploy\.yml$/],
  ['tests/house-ad-image-publish.test.ts', /^(?:services\/(?:cdnImageBase|houseAdCreative)\.ts|scripts\/(?:lib\/deploy-it-pages-prep\.sh|ci\/check-house-ad-images\.mjs|offload-generated-images-cdn\.mjs|ensure-image-cdn-redirect\.mjs)|docs\/house-ad-creatives\.json|public\/images\/job-search-campaign\/.*)$/],
  // Questi scandiscono ricorsivamente tutto scripts/, ma solo i file che
  // possono partecipare al contratto entrano nella selezione.
  ['tests/score-ledger-persistence.test.ts', pathAndSourceMatch(/^scripts\/.+\.mjs$/, /ai-models\.mjs/, /\b(?:callLLM|callSingleModel|flushScores(?:BeforeExit)?)\b/)],
  ['tests/undici-dispatcher-fetch-pairing.test.ts', pathAndSourceMatch(/^scripts\/.+\.(?:mjs|js)$/, /\bundici\b/, /\bnew\s+(?:Agent|Pool|Client|ProxyAgent|EnvHttpProxyAgent|RetryAgent)\s*\(/)],
  ['tests/is-invoked-directly.test.ts', pathAndSourceMatch(/^scripts\/.+\.(?:mjs|cjs|js|ts)$/, /\bisInvokedDirectly\s*\(|process\.argv\s*\[\s*1\s*\]/, /import\.meta\.(?:url|filename)|fileURLToPath\s*\(|pathToFileURL\s*\(|endsWith\s*\(|basename\s*\(/)],
  // Il censimento dei guard di entrypoint legge da disco ogni file di codice
  // sotto le sue radici: uno script NUOVO con un guard non canonico non importa
  // niente che il test conosca. Dopo la PR 12043 tre script sono entrati cosi'
  // in tre ore (PR 12223, 12232, 12266) e main e' rimasto rosso in latenza.
  // Il perimetro e' quello dello scan (CENSUS_ROOTS e CODE_FILE_RE del test);
  // il file intero gira in sei secondi.
  [
    'tests/entrypoint-guard-identity.test.ts',
    /^(?:scripts|build-plugins|packages\/articles\/engine|functions|infra)\/.+\.(?:mjs|js|ts|tsx)$/,
  ],
  ['tests/translation-protected-tokens.test.ts', pathAndSourceMatch(/^scripts\/.+\.mjs$/, /translation-glossary\.mjs|maskProtectedTokens|finalizeTranslatedText|applyGlossaryCorrections/)],
  // Lo UA da browser dei dettagli MySwitzerland e' un'eccezione del
  // proprietario (D1, 2026-10-05) confinata a quel crawler: il guard legge da
  // disco ogni sorgente di scripts/, e un file nuovo che la copia non importa
  // niente che il test conosca. Il runner e' infrastruttura di selezione, non
  // codice crawler, ed e' gia' coperto dalla sua suite di regressione bounded:
  // escluderlo evita di far crescere quel budget senza restringere il guard per
  // nessun altro sorgente sotto scripts/.
  ['tests/myswitzerland-browser-ua-confinement.test.ts', pathAndSourceMatch(/^scripts\//, /MYSWITZERLAND_DETAIL_BROWSER_UA|myswitzerland-detail-transport|MySwitzerland/)],
  ['tests/slug-write-encapsulation.test.ts', pathAndSourceMatch(/^scripts\/.+\.(?:ts|mjs|js)$/, /\b(?:slug|slugByLocale|previousSlugs|previousSlugsByLocale|addPreviousSlugForLocale|captureLostSlugs)\b/)],
  ['tests/social-robot.test.ts', (file) => /^scripts\/social-robot\//.test(file) || socialRobotClosurePaths.has(file)],
  // Ratchet sulle chiusure per titolo: legge da disco ogni sorgente che usa
  // `resolveGithubIssue` e lo confronta con l'elenco dichiarato. Un closer
  // nuovo non importa il test, quindi senza questa voce entrerebbe senza
  // farlo partire (stessa lezione della PR 11308). Perimetro = quello dello scan.
  ['tests/resolve-issue-by-title-ratchet.test.ts', pathAndSourceMatch(/^(?:scripts\/.+\.mjs|functions\/.+\.(?:js|mjs|ts))$/, /\bresolveGithubIssue\b/)],
  // Letture sincrone di `gh` senza `maxBuffer`: oltre 1 MiB finiscono in
  // ENOBUFS. La PR 12277 ne ha aggiunta una nella coda del deploy, che da
  // allora non ha piu' letto l'elenco delle run (issue 12308). Il censimento
  // legge da disco ogni modulo sotto `scripts/` e non ne importa nessuno:
  // deve girare sul diff che aggiunge la chiamata.
  ['tests/gh-exec-buffer-census.test.ts', pathAndSourceMatch(/^scripts\/.+\.mjs$/, /\b(?:execFileSync|spawnSync|execSync)\s*\(\s*['"]gh['"]/)],
  // Le immagini pubblicate possono cambiare solo nell'albero pubblico senza
  // che un import leghi il test che ne controlla la generazione. I riferimenti
  // a `data/` sono invece indicizzati come normali dipendenze asset, sia nei
  // test sia nei moduli che essi importano.
  [
    'tests/generated-site-images.test.ts',
    /^public\/images\/(?:authors|places)\//,
  ],
  // Stessa classe per le allow-list sparse di `bing-seo-loop.yml`: PR 10941
  // ha aggiunto un import a `scripts/lib/jobBoardSections.mjs`, verde, e la
  // run del crawler e' morta con ERR_MODULE_NOT_FOUND. Il perimetro e' un
  // path, non un import; il test verifica che la chiusura dei job ci stia.
  ['tests/seo/bing-seo-loop-sparse-closure.test.ts', bingSeoScope],
  // Grafo di `vite.config.ts`: i due test lo percorrono da disco (walker AST
  // ed esbuild come lo usa Vite) e non importano i moduli che giudicano. La
  // PR 11327 ha fatto importare a `build-plugins/shared/authorEditorial.ts`
  // `services/seo/seo-authors.ts`, che usava `@/data/authors`: il walker
  // esisteva e falliva, ma il diff non lo selezionava, e la CI delle PR non
  // carica mai il config. Il deploy e' rimasto fermo dal 03-10 16:59Z. Il
  // perimetro copre le cartelle da cui il grafo prende moduli oggi (esbuild ~0,4 s).
  // `tsconfig.json` resta fuori: un alias nuovo diventa un rischio solo quando
  // un sorgente lo usa, e quel sorgente e' gia' nel perimetro.
  ...['tests/vite-config-import-graph.test.ts', 'tests/vite-config-graph-no-alias.test.ts'].map((test) => [
    test,
    viteConfigScope,
  ]),
  // I due pin del SiteShellContract (golden delle funzioni e digest degli
  // scalari) confrontano il bootstrap con file letti da disco che il corpus
  // asserisce identici. `services/` e `build-plugins/` li raggiungono gia' col
  // grafo; `data/` invece e' fuori dal grafo (GRAPH_IGNORED_RE), e la chiusura
  // del bootstrap ne importa moduli: `data/authors.ts` (getAuthorBySlug) e i
  // JSON dei cantoni e delle professioni. La PR 11327 ha cambiato la bio di
  // marco-ferrari in `data/authors.ts`, il diff ha selezionato zero test e il
  // golden e' diventato rosso su main e sulle PR successive (11381).
  // Perimetro: i file di primo livello di `data/` che un modulo puo'
  // importare; il test costa meno di un secondo.
  ['tests/articles-shell-contract-functions.test.ts', /^data\/[^/]+\.(?:[cm]?[jt]sx?|json)$/],
  ['tests/articles-shell-contract-fingerprint.test.ts', /^data\/[^/]+\.(?:[cm]?[jt]sx?|json)$/],
  // Deploy runs the SEO source suite once per build, but the PR related graph
  // cannot see these readFileSync edges. Keep the source readers that inspect
  // jobsSeoPagesPlugin in the PR selection whenever any build plugin changes;
  // PR #18099 changed this file and its source-only guards were skipped.
  ['tests/seo/cathedral-expired-tracking-canton.test.ts', /^build-plugins\//],
  ['tests/seo/historical-archive-heading.test.ts', /^build-plugins\//],
  ['tests/seo/historical-pages-full-content-policy.test.ts', /^build-plugins\//],
  ['tests/seo/jobs-seo-self-heal-tracking-retention.test.ts', /^build-plugins\//],
  ['tests/seo/one-static-main-landmark.test.ts', /^build-plugins\//],
  ['tests/seo/static-job-page-spa-alignment.test.ts', /^build-plugins\//],
  // Metadati degli autori da un'unica fonte: il test confronta le pagine autore
  // di seo-pages.ts, il roster statico di /chi-siamo/ e llms.txt col registro.
  // `data/authors.ts` e `data/authorLocales.ts` sono fuori dal grafo e i due
  // sorgenti giudicati sono letti da disco: dopo la PR 11327 la bio corretta nel
  // registro e' rimasta vecchia nelle copie a mano senza che nulla fallisse.
  ['tests/author-metadata-single-source.test.ts', /^(?:data\/[^/]+\.(?:[cm]?[jt]sx?|json)|services\/seo\/seo-pages\.ts|build-plugins\/staticPagesPlugin\.ts|build-plugins\/shared\/authorEditorial\.ts|scripts\/lib\/llms-txt-generator\.mjs|services\/seo\/authorProfileMetadata\.ts)$/], // Scope producers: build-plugins/shared/authorEditorial.ts, scripts/lib/llms-txt-generator.mjs, services/seo/authorProfileMetadata.ts.
  // I letterali delle immagini in seo-pages.ts sono giudicati da due test che
  // leggono il file da disco: i campi dei diritti tutti o nessuno
  // (static-pages-image-credit) e l'identificatore del sito sui creator
  // (imageObjectLd). La PR 12329 ha aggiunto un creator del sito a 36 letterali
  // con credito di terzi: toccava seo-pages.ts, il primo test non e' stato
  // selezionato e main e' rimasto rosso per ogni PR che lo ereditava (issue
  // 12353).
  ['tests/static-pages-image-credit.test.ts', /^services\/seo\/seo-pages\.ts$/],
  ['tests/seo/imageObjectLd.test.ts', /^services\/seo\/seo-pages\.ts$/],
  // Profili sparse dei workflow contro il codice che i job caricano. Il test
  // legge da disco i YAML, le action locali, gli script npm di package.json e
  // la chiusura degli import di ogni job: nessun import lo lega a quei file.
  // Era in `alwaysExcludedTests`, quindi non girava MAI, ne' sulle PR ne'
  // nella suite piena: il 2026-10-04 su main 6 job escludevano bucket che il
  // loro codice nomina (34 problemi) e 12 workflow erano in ritardo sul
  // generatore. Solo uno era nato da un YAML: gli altri da codice della
  // chiusura (`portal.mjs`, `ai-models.mjs`, `cf-5xx-issue-sync.mjs`,
  // `decompose-route-check.mjs`), quindi il perimetro e' il codice che un job
  // puo' caricare, non solo `.github/`. Il test costa ~35 s.
  ['tests/checkout-sparse-profiles.test.ts', checkoutProfileScope],
]);
const inLintScope = (scope, file) => (typeof scope === 'function' ? scope(file) : scope.test(file));
const sourceTreeLintContentScopes = new Map([
  ['tests/entrypoint-guard-identity.test.ts', [
    /process\.argv\s*\[\s*1\s*\]/,
    /import\.meta\.(?:url|filename)|fileURLToPath\s*\(|pathToFileURL\s*\(|endsWith\s*\(|basename\s*\(/,
  ]],
]);
const sourceTreeLintAdmission = (test, scope, file) => {
  if (!inLintScope(scope, file)) return false;
  const patterns = sourceTreeLintContentScopes.get(test);
  return !patterns || sourceTextMatches(file, patterns);
};
// Calcolata sul diff GREZZO (`changed`), non sui candidati del grafo: un lint
// che enumera l'albero giudica anche i file che il grafo non conosce (HTML,
// shell, Markdown), e sono proprio quelli che non hanno altro gate.
const sourceTreeLintsFor = (files) => [...sourceTreeLintTests]
  .filter(([test, scope]) => files.some((file) => sourceTreeLintAdmission(test, scope, file)))
  .map(([test]) => test);
// Most workflow readers intentionally depend on every asset in the directory:
// permissions, timeout and scope guards are repository-wide contracts. A few
// readers do a broad `readdirSync()` only to select one generated family,
// though. Keep those bounds explicit so adding an unrelated workflow does not
// drag an expensive crawler-generator suite into every PR. The root asset is
// carried through the reverse graph below; a source module may still be
// traversed, but the final test admission is checked against this scope.
const crawlerAssetScope = [
  /^\.github\/workflows\/(?:crawler-group-\d+(?:-logic)?|crawler-generation-[^/]+|orchestrate-crawlers|translate-pending(?:-logic)?|generate-article)\.ya?ml$/i,
  /^\.github\/corpus-workflows\/(?:crawler-group-\d+|translate-pending)\.ya?ml$/i,
  /^\.github\/corpus-workflows\/contract\.json$/i,
  /^\.github\/corpus-workflows\/observers\/workflows\/crawler-generation-[^/]+\.ya?ml$/i,
];
const crawlerGroupWorkflowScope = [
  /^\.github\/workflows\/crawler-group-\d+\.ya?ml$/i,
];
const crawlerDataAssetScope = [
  /^data\/crawler-(?:manifest|group-assignments|companies-auto)\.json$/i,
];
const crawlerRelatedAssetScope = [...crawlerAssetScope, ...crawlerDataAssetScope];
const companyLogoAssetScope = [/^data\/company-logos-manifest\.json$/i];
const rootDocAssetRe = /^(?:AGENTS|DECISIONS|FOLLOWUP|ISSUES|REVIEW|VISION)\.md$/i;
const workflowAssetRe = /^\.github\/(?:workflows|corpus-workflows)\/.+\.ya?ml$/i;
const allWorkflowAssetScope = [workflowAssetRe];
const portalReplayWorkflowScope = [
  /^\.github\/workflows\/assisted-application-portal-replay\.ya?ml$/i,
];
const deployWorkflowScope = [
  /^\.github\/workflows\/(?:deploy(?:-[^/]+)?|post-deploy-[^/]+|post-build-matrix-test|audit-(?:dist-from-run|published-dist(?:-full)?))\.ya?ml$/i,
];
const socialWorkflowScope = [
  /^\.github\/workflows\/social-[^/]+\.ya?ml$/i,
];
const workflowAssetGlobalTests = [
  'tests/cancel-superseded-reporter-contract.test.ts',
  'tests/technical-operations-audit.test.ts',
  'tests/validate-modified-workflows.test.ts',
  'tests/workflow-background-wait-schema.test.ts',
  'tests/workflow-concurrency-group-not-per-run.test.ts',
  'tests/workflow-input-injection.test.ts',
  'tests/workflow-npx-and-reflog-invariants.test.ts',
  'tests/workflow-permissions-parity.test.ts',
  'tests/workflow-push-main-path-filter.test.ts',
  'tests/workflow-reserved-env-override.test.ts',
  'tests/workflow-risk-inventory.test.ts',
  'tests/workflow-run-target-resolves.test.ts',
  'tests/workflow-timeout-contract.test.ts',
];
const crawlerAssetRelatedTests = [
  'tests/crawler-generation-barrier-shadow.test.ts',
  'tests/crawler-generation-barrier-workflows.test.ts',
  'tests/crawler-generation-contract.test.ts',
  'tests/crawler-generation-dispatch-workflow.test.ts',
  'tests/crawler-generation-dispatch.test.ts',
  'tests/crawler-generation-observer-contract.test.ts',
  'tests/crawler-generation-observer-runtime.test.ts',
  'tests/crawler-generation-observer-selector.test.ts',
  'tests/crawler-generation-observer-workflow.test.ts',
  'tests/crawler-group-generation-finalizer.test.ts',
  'tests/workflows/crawler-workflows-corpus-sync.test.ts',
];
const expiredArchiveAuditWorkflowScope = [
  (asset) => {
    if (!/^\.github\/workflows\/.+\.ya?ml$/i.test(asset)) return false;
    try {
      return readFileSync(asset, 'utf8').split(/\r?\n/).some((line) => (
        !line.trimStart().startsWith('#')
        && /audit:expired-at-parsable|scripts\/audit-expired-at-parsable\.mjs/.test(line)
      ));
    } catch {
      // A deleted workflow is still a meaningful input to the caller audit.
      return true;
    }
  },
];
const assetScopeMatches = (scope, asset) => scope.some((matcher) => (
  typeof matcher === 'function' ? matcher(asset) : matcher.test(asset)
));
const relatedAssetFileScopes = new Map([
  ['build-plugins/crawlerRegistryPlugin.ts', crawlerAssetScope],
  // This module validates a remote Actions API binding. Its `.github/workflows/`
  // string is an API identity, not a local file read.
  ['scripts/lib/githubWorkflowDispatch.mjs', []],
  ['tests/generate-crawler-group-workflows.test.ts', crawlerRelatedAssetScope],
  ...crawlerAssetRelatedTests.map((file) => [file, crawlerRelatedAssetScope]),
  ...workflowAssetGlobalTests.map((file) => [file, allWorkflowAssetScope]),
  ['tests/assisted-application-portal-replay.test.ts', portalReplayWorkflowScope],
  ['tests/social-robot.test.ts', socialWorkflowScope],
  ...[
    'tests/deploy-workflow.test.ts',
    'tests/deploy-matrix-experiment-workflow.test.ts',
    'tests/deploy-no-human-approval-gate.test.ts',
    'tests/deploy-in-run-alarm.test.ts',
    'tests/deploy-skew-signal.test.ts',
    'tests/r2-og-manifest-carry.test.ts',
    'tests/job-og-cache-prewarm.test.ts',
  ].map((file) => [file, deployWorkflowScope]),
  // This suite writes selector fixtures containing workflow paths. Those
  // strings are not reads from the repository's workflow tree; it is selected
  // explicitly when the runner itself changes.
  ['tests/run-related-tests-selection.test.ts', []],
  // This test scans only generated crawler-group workflows; an unrelated
  // workflow edit must not pull it into the graph.
  ['tests/nord-anglia-crawler.test.ts', crawlerGroupWorkflowScope],
  // The caller contract filters workflow contents for the expired-archive
  // audit. Scope the directory scan to workflows that actually invoke it.
  ['tests/expired-at-parsable.test.ts', expiredArchiveAuditWorkflowScope],
]);
// Some root assets are read by shared source modules imported by hundreds of
// tests. For these roots, reaching an unscoped test through a shared module is
// not proof that the test exercises the changed asset (many tests inject their
// own data). Admit direct readers and the explicitly scoped crawler contracts;
// leave the rest of the asset graph intact for other data domains.
const boundedRootAssetScopes = [
  /^data\/jobs\/expired\/by-crawler\/[^/]+\.json$/i,
  ...crawlerRelatedAssetScope,
  ...companyLogoAssetScope,
  rootDocAssetRe,
];
const hasBoundedRootAssetScope = (asset) =>
  boundedRootAssetScopes.some((pattern) => pattern.test(asset));
// A few source files are intentionally shared at runtime but are not shared
// test contracts. Following their reverse import graph through the app shell
// makes a feature-local edit select nearly every UI test: locale chunks flow
// through `services/i18n.ts`, while the concierge client is reachable from the
// profile, JobBoard and router graph. Keep those roots scoped to their owning
// tests. Direct tests of a scoped root are always retained below.
const relatedSourceTestScopes = [
  {
    matches: (file) => /^services\/locales\/[^/]+\.ts$/.test(file),
    tests: [
      /^tests\/i18n(?:-[^/]+)?\.test\.[cm]?[jt]sx?$/,
      /^tests\/application-concierge-[^/]+\.test\.[cm]?[jt]sx?$/,
    ],
  },
  {
    matches: (file) => file === 'services/applicationConciergeService.ts',
    tests: [
      /^tests\/(?:application-concierge|concierge|use-concierge)-[^/]+\.test\.[cm]?[jt]sx?$/,
      /^tests\/admin-candidature-revamp\.test\.[cm]?[jt]sx?$/,
      /^tests\/userProfile\.test\.[cm]?[jt]sx?$/,
      /^tests\/assisted-application-(?:employer-response|no-refund-after-start|review)\.test\.[cm]?[jt]sx?$/,
    ],
  },
  {
    // The landing builders are shared by the SSG plugins, the router and the
    // hydrated JobBoard. A reverse walk through the latter two reaches the
    // app shell and makes a landing-builder change look like a UI-wide change.
    // Keep the owning landing/route contracts, while preventing that runtime
    // fan-out from admitting every app test.
    matches: (file) => file === 'build-plugins/jobEditorialLanding.ts'
      || file === 'build-plugins/jobIntentLanding.ts',
    tests: [
      /^tests\/build-plugins\/job-sitemap-generator-contract\.test\.[cm]?[jt]sx?$/,
      /^tests\/(?:job-editorial-enrichment|job-editorial-landing|job-intent-landing|job-landing-publication-provenance|job-recency-landing|multi-canton-seo)\.test\.[cm]?[jt]sx?$/,
      /^tests\/seo\/(?:cathedral-editorial-slug-tables|cathedral-phase8d-ti-invariance|search-pages-head-contract)\.test\.[cm]?[jt]sx?$/,
      /^tests\/regression\/recency-router-guards\.test\.[cm]?[jt]sx?$/,
      /^tests\/router\/job-intent-routing\.test\.[cm]?[jt]sx?$/,
    ],
  },
];
const sourceTestScopeFor = (file) => relatedSourceTestScopes.find((scope) => scope.matches(file)) || null;
// faq-readability-gate misura il ratchet sulle FAQ dell'INTERO corpus articoli
// e si difende dal falso verde con `expect(total).toBeGreaterThan(1000)`. Il job
// PR non materializza `packages/articles/content`, quindi quel guard scatta
// sempre: misurato il 2026-09-06 sulla PR #7617, `expected 4 to be greater than
// 1000` — quattro campi FAQ visibili invece di 22.012. Non stava trovando un
// difetto, stava dicendo (come progettato) di non avere il dato; sul corpus vero
// passa, 23 illeggibili contro un RATCHET_BASELINE di 26.
// Stessa ragione del vicino qui sotto: un test che richiede un ambiente che
// QUESTO job non ha non e' un gate, e' un rosso fisso. Resta bloccante nella
// suite piena, che il corpus ce l'ha. Ci finiva dentro solo da quando un cambio
// a `blog-body-io.mjs` lo tira nel grafo related, cioe' su ogni PR che tocca
// quel modulo condiviso.
// firestore-rules-consent-write needs a running Firestore emulator (Java 21+,
// wired via `npm run test:firestore-rules`) — plain `vitest run` fails fast
// with ECONNREFUSED, so it stays out of the blocking related-tests gate (#6377).
// `tests/checkout-sparse-profiles.test.ts` non sta piu' qui: il profilo del job
// `vitest` di tests.yml materializza ogni file che `verifyCheckoutProfiles()`
// apre (misurato il 2026-10-04: 3136 file tracciati letti, 3136 dentro le
// regole sparse, `git sparse-checkout check-rules`), quindi in CI il verdetto
// e' quello di un checkout pieno. E' fra i lint dell'albero dei sorgenti sopra.
const alwaysExcludedTests = new Set([
  'tests/faq-readability-gate.test.ts',
  'tests/firestore-rules-consent-write.test.ts',
]);
const ignoredRe = GRAPH_IGNORED_RE;
// Workflow e artefatti portabili sotto `.github/`. Non sono sorgenti e non
// hanno nessun edge di import, ma i test che ne congelano il contenuto li
// aprono per path LETTERALE (`fs.readFileSync('.github/…')`,
// `git show origin/main:.github/…`). Senza questo indice un diff di soli
// workflow non seleziona NIENTE: e' la strada da cui #7355 ha spezzato
// l'adiacenza della terna shadow in
// `.github/corpus-workflows/translate-pending.yml` senza far girare
// `tests/crawler-generation-dispatch-workflow.test.ts`, e siccome `tests.yml`
// gira solo su `pull_request` il rosso e' rimasto invisibile su `main`
// finche' non l'ha ereditato una PR estranea (#7514, #7580).
const githubAssetRe = /^\.github\/.+\.(?:ya?ml|json)$/i;
const testFixtureRe = /^tests\/.+\.json$/i;
// Asset paths are only dependencies when the path starts a quoted/template
// literal.  Matching `.github/workflows` in the middle of an explanatory
// string (for example a live-data guard message) expands that one phrase to
// every workflow asset and turns a one-file workflow diff into hundreds of
// unrelated tests.
const assetLiteralRe = /(?<=['"`])(?:(?:\.\.?\/)+)?(?:\.github|tests|data)\/[A-Za-z0-9._-][A-Za-z0-9._/-]*/g;
// La stessa dipendenza costruita a SEGMENTI: `path.join(ROOT, '.github',
// 'workflows')`, `path.join(__dirname, '..', 'data', 'x.json')` o
// `path.resolve(__dirname, '..', '.github', 'workflows', 'x.yml')`.
// La sequenza di letterali consecutivi separati da virgola che inizia con
// `'.github'`, `'data'`, `'.'` o `'..'` vale come il path unito con `/`.
const segmentedAssetRe = /(['"])(?:\.github|data|\.\.?)\1(?:\s*,\s*(['"])[A-Za-z0-9._-][A-Za-z0-9._/-]*\2)+/g;
const segmentLiteralRe = /['"]([^'"]+)['"]/g;
// Contratti di processo in prosa alla radice del repo. Come gli asset sotto
// `.github/` non si importano: i test che ne congelano le frasi li aprono per
// path letterale (`readFileSync(join(ROOT, 'AGENTS.md'))`,
// `new URL('../REVIEW.md', import.meta.url)`). Senza questo indice una PR che
// tocca soltanto uno di questi file seleziona ZERO test, e un contratto rotto
// arriva su `main` senza nessun gate: `tests.yml` su `main` esegue la stessa
// selezione related, quindi il rosso resta latente finché una PR estranea non
// lo eredita (la classe dei 25 rossi latenti riparati da #9329). L'elenco è
// esplicito e non «ogni `*.md` di radice»: `README.md` è il nome di fixture più
// comune nei test che costruiscono un repo temporaneo, e indicizzarlo
// trascinerebbe test estranei a ogni modifica del README.
const rootDocContracts = ['AGENTS.md', 'DECISIONS.md', 'FOLLOWUP.md', 'ISSUES.md', 'REVIEW.md', 'VISION.md'];
const rootDocContractSet = new Set(rootDocContracts);
// Il nome intero, anche dietro `../` o `/` (path costruiti dalla radice o da
// `tests/`), mai come pezzo di un nome più lungo: `docs/AGENTS-HISTORY.md` non
// è `AGENTS.md`.
const rootDocLiteralRe = new RegExp(
  `(?<![A-Za-z0-9_.-])(?:${rootDocContracts.map((file) => file.replaceAll('.', '\\.')).join('|')})(?![A-Za-z0-9_-])`,
  'g',
);
const testTreeRe = /^(?:tests|packages\/[^/]+\/tests)\//;
// `data/` stays out of the source graph, but tracked data files enter through
// the related-asset graph so a data-only diff can select its exact readers.
const dataAssetRe = /^data\/[A-Za-z0-9._/-]+$/;
// `assemble-jobs-dataset.mjs` includes this registry only in its conservative
// cache-key inventory; it does not consume it to produce outputs. Treating that
// fingerprint entry as a Vitest import edge follows the crawler-template cycle
// and selects almost every parser test. Direct runtime readers remain in graph.
const testIrrelevantAssetEdges = new Map([
  ['scripts/assemble-jobs-dataset.mjs', new Set(['data/crawler-companies-auto.json'])],
]);
const isRelatedAsset = (file) => githubAssetRe.test(file)
  || testFixtureRe.test(file)
  || dataAssetRe.test(file)
  || rootDocContractSet.has(file);
const skipCorpusWide = process.env.VITEST_SKIP_CORPUS_WIDE === 'true';
const corpusWideTests = skipCorpusWide ? new Set(listCorpusWideTests()) : new Set();
// A related-test verdict is only meaningful when the generated runtime data
// used by the selected tests is present. The CI checkout materializes these
// sentinels; a local sparse worktree does not. Keep `--select-only` and the
// local dry-run seam usable for inspecting the graph, but never let a real
// Vitest invocation turn missing artifacts into application regressions.
function requireFullCheckoutForVerdict() {
  const missing = missingFullCheckoutArtifacts();
  // --select-only is the CI scheduling probe as well as a useful local
  // inspection seam. In Actions it is part of the blocking verdict, so it
  // must not turn an incomplete checkout into a successful selection.
  const localInspection = process.env.GITHUB_ACTIONS !== 'true'
    && (selectionOnly || process.env.VITEST_RELATED_DRY_RUN === 'true');
  if (missing.length === 0 || localInspection) return;
  console.error('BLOCKED: related-test verdict requires a full checkout; generated runtime artifacts are missing.');
  console.error(`  Artefacts mancanti: ${missing.join(', ')}`);
  console.error('  È un problema di ambiente, non di codice: esegui il comando in CI o da un checkout PIENO con data/ e public/ materializzati.');
  process.exit(2);
}

function rejectDryRunInCi() {
  if (process.env.VITEST_RELATED_DRY_RUN !== 'true' || process.env.GITHUB_ACTIONS !== 'true') return;
  console.error('VITEST_RELATED_DRY_RUN non è consentito in GitHub Actions: esecuzione bloccante annullata.');
  process.exit(1);
}
// These dependencies are wired by Vitest/configuration or executed through a
// path string, so no static import edge can reliably reach their consumers.
const importRe = /(?:import\s+(?:[^'";]*?\s+from\s+)?|export\s+[^'";]*?\s+from\s+|import\s*\(|require\s*\()(['"])([^'"]+)\1/g;
const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'];

const normalize = (file) => file.replaceAll('\\', '/').replace(/^\.\//, '');
const NAME_STATUS_RE = /^[ACDMRTUXB](?:\d+)?$/;

function importedBindings(clause) {
  const value = clause.trim().replace(/^type\s+/u, '').trim();
  if (!value) return [{ imported: '*', local: '*' }];
  if (value.startsWith('*')) {
    const local = value.match(/\bas\s+([A-Za-z_$][\w$]*)/u)?.[1] || '*';
    return [{ imported: '*', local }];
  }
  const bindings = [];
  const named = value.match(/\{([\s\S]*)\}/u)?.[1];
  if (named !== undefined) {
    for (const part of named.split(',')) {
      const pieces = part.trim().replace(/^type\s+/u, '').split(/\s+as\s+/u).map((item) => item.trim());
      const imported = pieces[0];
      if (imported) bindings.push({ imported, local: pieces[1] || imported });
    }
    const beforeNamed = value.slice(0, value.indexOf('{')).replace(/,$/u, '').trim();
    if (beforeNamed) bindings.push({ imported: 'default', local: beforeNamed });
  } else {
    bindings.push({ imported: 'default', local: value.split(/\s*,\s*/u)[0].trim() });
  }
  return bindings.length > 0 ? bindings : [{ imported: '*', local: '*' }];
}

function addImportBindings(imports, dep, bindings) {
  const current = imports.get(dep) || [];
  for (const binding of bindings) {
    if (!current.some((existing) => existing.imported === binding.imported && existing.local === binding.local)) {
      current.push(binding);
    }
  }
  imports.set(dep, current);
}

function resolveAssetLiteral(from, rawLiteral) {
  const literal = rawLiteral.replace(/\/+$/, '');
  const isRelative = literal.startsWith('./') || literal.startsWith('../');
  return normalize(isRelative
    ? path.posix.normalize(path.posix.join(path.posix.dirname(from), literal))
    : literal);
}

function assetLiteralsIn(code, from) {
  const literals = new Set([...code.matchAll(assetLiteralRe)]
    .map((match) => resolveAssetLiteral(from, match[0])));
  for (const [sequence] of code.matchAll(segmentedAssetRe)) {
    const segments = [...sequence.matchAll(segmentLiteralRe)].map((match) => match[1]);
    if (segments.length >= 2) literals.add(resolveAssetLiteral(from, segments.join('/')));
  }
  return literals;
}

function scannedAssetDirectories(code, from) {
  const variables = new Map();
  for (const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/gu)) {
    variables.set(match[1], match[2]);
  }
  const directories = new Set();
  for (const match of code.matchAll(/\b(?:readdirSync|readdir|globSync|glob)\s*\(([^)]*)\)/gu)) {
    const argument = match[1];
    for (const literal of assetLiteralsIn(argument, from)) directories.add(literal);
    for (const [variable, expression] of variables) {
      if (!new RegExp(`\\b${variable}\\b`, 'u').test(argument)) continue;
      for (const literal of assetLiteralsIn(expression, from)) directories.add(literal);
    }
  }
  return directories;
}

/**
 * Parse the NUL-delimited `git diff --name-status -z` stream defensively.
 * A rename/copy normally carries two paths, but a pathspec can leave only one
 * side visible. If the next field is itself a status token, do not consume it
 * as the second path or every following entry shifts by one field.
 */
function parseNameStatusZ(fields) {
  const entries = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    const firstPath = fields[i++];
    if (firstPath === undefined) break;
    const paths = [firstPath];
    if (/^[RC]/.test(status)
      && fields[i] !== undefined
      && !NAME_STATUS_RE.test(fields[i])) {
      paths.push(fields[i++]);
    }
    entries.push(paths);
  }
  return entries;
}
const changed = readFileSync(changedPathFile, 'utf8').split(/\r?\n/).map((p) => normalize(p.trim())).filter(Boolean);
let changedStatus = 'complete';
try { changedStatus = readFileSync(changedStatusFile, 'utf8').trim() || 'error'; } catch {}

function stopWithoutFullSuite(reason) {
  console.error(`BLOCKED: related-test selection is not provable: ${reason}`);
  console.error('The conservative full-suite fallback is disabled; add/update an impacted test or repair the changed-path input.');
  if (selectionOnly) {
    // The workflow's scheduling probe must not turn a selection error into an
    // expensive Assemble + migrate. The real Vitest invocation repeats the
    // same decision and exits non-zero immediately.
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, 'required=false\nselection_failed=true\n');
    }
    process.exit(0);
  }
  process.exit(2);
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(Boolean).map(normalize).filter(isGraphSourceFile);
}

function trackedAssets() {
  return execFileSync('git', ['ls-files', '-z', '--', '.github'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(Boolean).map(normalize).filter((file) => githubAssetRe.test(file))
    .concat(
      execFileSync('git', ['ls-files', '-z', '--', 'tests'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        .split('\0').filter(Boolean).map(normalize).filter((file) => testFixtureRe.test(file)),
    )
    .concat(
      execFileSync('git', ['ls-files', '-z', '--', ...rootDocContracts], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        .split('\0').filter(Boolean).map(normalize).filter((file) => rootDocContractSet.has(file)),
    )
    .concat(
      execFileSync('git', ['ls-files', '-z', '--', 'data'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        .split('\0').filter(Boolean).map(normalize).filter((file) => file.startsWith('data/')),
    );
}

function signature(file) {
  try { return createHash('sha1').update(readFileSync(file)).digest('hex'); } catch { return null; }
}

function resolveImport(from, specifier, fileSet) {
  if (!specifier.startsWith('.') && !specifier.startsWith('@/')) return null;
  const base = specifier.startsWith('@/')
    ? path.resolve('.', specifier.slice(2))
    : path.resolve(path.dirname(from), specifier);
  for (const candidate of [base, ...extensions.map((ext) => `${base}${ext}`), ...extensions.map((ext) => path.join(base, `index${ext}`))]) {
    const relative = normalize(path.relative('.', candidate));
    if (fileSet.has(relative)) return relative;
  }
  return null;
}

// Tracked files this process could not read while building the graph. Empty on
// a full checkout; see importsOf() for the only case that fills it.
const unreadable = [];

function writeAssembleDecision(selectedTests) {
  let decision;
  try {
    decision = shouldAssembleForRelatedTests({
      eventName: process.env.GITHUB_EVENT_NAME,
      changedPaths: changed,
      changedStatus,
      selectedTests,
      unreadableCount: unreadable.length,
    });
  } catch (error) {
    decision = {
      required: true,
      degraded: true,
      reason: `assemble decision failed: ${error?.message || String(error)}`,
    };
  }
  console.log(`Assemble + migrate: ${decision.required ? 'required' : 'not required'} (${decision.reason})`);
  if (decision.degraded) {
    // Un `required: true` degradato non e' la feature che lavora: e' lo skip
    // spento perche' il predicato non ha potuto misurare. Senza annotazione
    // resta identico a una decisione legittima nel log, e l'ottimizzazione
    // puo' restare un no-op per mesi senza che nessuno se ne accorga.
    console.log(`::warning::Assemble + migrate non e' saltabile: ${decision.reason}. Lo skip del dataset e' disattivato finche' la causa resta.`);
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `required=${decision.required}\n`);
  }
}

function importsOf(file, fileSet, assets, assetSet) {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // A file that git tracks but the working tree cannot open. In a SPARSE
    // worktree this is routine and not a broken repository: `services/` is
    // checked out, but `services/blogArticleIds.ts` is a symlink into
    // `packages/articles/content/`, which the sparse profile excludes — the
    // link resolves to nothing, so `ls` shows it and `readFileSync` throws.
    //
    // Crashing here made this runner unusable outside CI, which is exactly
    // where an agent needs it: without it the only pre-PR option is the full
    // suite, which in a sparse worktree is 156 inherited reds and no verdict.
    // The file is dropped from the graph, never silently: the count is
    // reported below so an under-selection is visible instead of assumed.
    unreadable.push(file);
    return { deps: [], imports: {} };
  }
  const deps = new Set();
  const imports = new Map();
  const code = stripSourceComments(source);
  // A directory literal is a dependency only when that exact path reaches a
  // directory scan. `path.join(ROOT, '.github', 'workflows', WORKFLOW_FILE)`
  // is a file reader, while `readdirSync(WORKFLOWS_DIR)` is a directory reader.
  // The distinction prevents a path variable in an otherwise unrelated test
  // from expanding one workflow edit into the whole repository.
  const directoryLiterals = scannedAssetDirectories(code, file);
  for (const match of code.matchAll(importRe)) {
    const dep = resolveImport(file, match[2], fileSet);
    if (!dep) continue;
    deps.add(dep);
    const raw = match[0];
    const fromIndex = raw.lastIndexOf(' from ');
    if (fromIndex < 0 || /\b(?:import|require)\s*\(/u.test(raw)) {
      addImportBindings(imports, dep, [{ imported: '*', local: '*' }]);
    } else {
      const keyword = raw.startsWith('export') ? 'export' : 'import';
      addImportBindings(imports, dep, importedBindings(raw.slice(keyword.length, fromIndex)));
    }
  }
  // Il letterale vale come dipendenza quando nomina un asset o la directory
  // che lo contiene (`'.github/workflows'` e `tests/fixtures`, usati dai test
  // che scandiscono una cartella). Solo dentro il CODICE: un path citato in un
  // commento non e' una dipendenza. Niente prefissi parziali — un template
  // letterale come `` `.github/…/crawler-group-${g}.yml` `` non produce arco, e
  // non serve: quei file non cambiano mai senza `contract.json`, che ne porta
  // gli sha256 ed e' nominato per esteso.
  const literals = [...code.matchAll(assetLiteralRe)].map((m) => m[0]);
  for (const [sequence] of code.matchAll(segmentedAssetRe)) {
    const segments = [...sequence.matchAll(segmentLiteralRe)].map((m) => m[1]);
    const literal = segments.join('/');
    if (segments.length >= 2) literals.push(literal);
  }
  for (const rawLiteral of literals) {
    // La barra finale va tolta: un riferimento costruito per template —
    // `` `.github/workflows/${name}` `` o `'.github/corpus-workflows/' + file` —
    // lascia il letterale con lo slash e senza normalizzazione non matcha.
    const literal = resolveAssetLiteral(file, rawLiteral);
    const directoryLiteral = directoryLiterals.has(literal);
    if (assetSet.has(literal) && !testIrrelevantAssetEdges.get(file)?.has(literal)) {
      deps.add(literal);
      addImportBindings(imports, literal, [{ imported: '*', local: '*' }]);
    }
    if (directoryLiteral) {
      for (const asset of assets) {
        if (asset.startsWith(`${literal}/`)) {
          deps.add(asset);
          addImportBindings(imports, asset, [{ imported: '*', local: '*' }]);
        }
      }
    }
  }
  // I contratti di radice si nominano per esteso: niente directory da
  // espandere, l'arco esiste solo se il nome è fra gli asset indicizzati.
  // Solo dal codice dei TEST: decine di moduli sorgente citano `AGENTS.md` o
  // `REVIEW.md` dentro un prompt o un messaggio d'errore, e un arco da loro
  // trascinerebbe nel grafo inverso tutti i loro importatori — misurato su
  // main al 2026-10-02: 344 file di test per una modifica a `AGENTS.md`
  // contro i ~20 che lo leggono davvero.
  if (testTreeRe.test(file)) {
    for (const [literal] of code.matchAll(rootDocLiteralRe)) {
      if (assetSet.has(literal)) {
        deps.add(literal);
        addImportBindings(imports, literal, [{ imported: '*', local: '*' }]);
      }
    }
  }
  const scope = relatedAssetFileScopes.get(file);
  const filtered = [...deps]
    .filter((dep) => !isRelatedAsset(dep) || !scope || assetScopeMatches(scope, dep))
    .sort();
  return {
    deps: filtered,
    imports: Object.fromEntries(filtered.map((dep) => [dep, imports.get(dep) || [{ imported: '*', local: '*' }]])),
  };
}

function loadGraph(files, assets) {
  let previous = {};
  let previousVersion = 0;
  let previousAssets = null;
  let previousRevision = '';
  let currentRevision = '';
  try {
    currentRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {}
  // Gli archi verso gli asset `.github/**` vivono nella entry del file
  // SORGENTE che li nomina, e la validità di quella entry dipendeva solo dalla
  // firma del sorgente. Un workflow AGGIUNTO (o rinominato) non cambia la
  // firma di chi lo nomina per directory — `'.github/workflows'`, il caso
  // reale di scripts/generate-crawler-group-workflows.mjs — quindi la entry
  // vecchia veniva riusata senza l'arco verso il file nuovo. La cache
  // sopravvive fra le run (tests.yml la salva e la ripristina, con
  // restore-keys di prefisso), quindi da lì in poi una PR che tocca SOLO quel
  // workflow tornava a selezionare zero test: il blind spot di #7355/#7514
  // riaperto per ogni workflow nato dopo l'ultima invalidazione. Il bump di
  // `version` lo copriva una volta sola. Ora l'insieme degli asset entra nella
  // chiave di validità: se cambia, il grafo si ricalcola. La versione 7 segna
  // gli archi verso i contratti di radice (`rootDocContracts`): una entry
  // della versione 6 non li ha anche quando la firma del sorgente è invariata. La
  // versione 8 segna gli archi costruiti a segmenti (`path.join(ROOT, '.github',
  // 'workflows')`: una entry della versione 7 non li ha. La versione 9 lega
  // inoltre la cache alla revisione del checkout: senza questo confine una
  // cache ripristinata da un'altra PR potrebbe riusare archi di sorgenti che
  // non erano nel suo `changed-paths.txt`. La versione 10 invalida le entry
  // costruite dal vecchio scanner di asset, che poteva scambiare testo
  // descrittivo per una lettura di directory. La versione 11 conserva wildcard
  // solo per i file che dimostrano una scansione directory reale. La versione
  // 12 aggiunge gli asset `data/` e consente agli import di risolvere anche
  // verso gli asset esclusi dal grafo dei sorgenti. La versione 13 registra
  // anche i literal `../data/...` e i loro equivalenti costruiti a segmenti.
  // La versione 14 rimuove l'arco cache-only del registro crawler: le entry v13
  // ripristinate devono essere ricostruite. La versione 15 estende gli scope
  // crawler agli asset dati e richiede di ricostruire gli archi dei loro test.
  // La versione 16 aggiunge scope per i reader che enumerano workflow e
  // consente matcher predicativi basati sul contenuto dell'asset. La versione
  // 17 registra i binding degli import per la selezione symbol-aware; la 18
  // restringe i wildcard ai path che raggiungono davvero una directory scan;
  // la 19 limita gli asset workflow ai contratti globali o a scope espliciti;
  // la 20 conserva i reader che nominano il file workflow esatto.
  const assetsDigest = createHash('sha1').update([...assets].sort().join('\n')).digest('hex');
  try {
    const cached = JSON.parse(readFileSync(graphFile, 'utf8'));
    previous = cached.files || {};
    previousVersion = cached.version || 0;
    previousAssets = cached.assets || null;
    previousRevision = cached.revision || '';
  } catch {}
  let changedSinceCache = null;
  let sourceTopologyChanged = false;
  if (previousVersion === graphVersion && previousAssets === assetsDigest
    && previousRevision !== '' && currentRevision !== '') {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', previousRevision, currentRevision], {
        stdio: 'ignore',
      });
      const output = previousRevision === currentRevision
        ? ''
        : execFileSync('git', [
          'diff', '--name-status', '--no-renames', previousRevision, currentRevision,
        ], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      changedSinceCache = new Set();
      for (const line of output.split(/\r?\n/).filter(Boolean)) {
        const [status, ...paths] = line.split('\t');
        for (const file of paths) {
          changedSinceCache.add(file);
          if ((status.startsWith('A') || status.startsWith('D')) && sourceRe.test(file)) {
            sourceTopologyChanged = true;
          }
        }
      }
    } catch {
      // A cache from a divergent checkout is not a safe graph baseline. Keep
      // the conservative full rebuild when ancestry or the intervening diff
      // cannot be established from this checkout.
    }
  }
  const changedPaths = new Set([...changed, ...(changedSinceCache || [])]);
  // Source additions and deletions can change import resolution for otherwise
  // untouched files, so rebuild when the source path set changed. Existing
  // source files are re-indexed below; asset-path changes already invalidate
  // the cache through assetsDigest.
  const reusable = changedSinceCache !== null
    && !sourceTopologyChanged;
  const fileSet = new Set([...files, ...assets]);
  const assetSet = new Set(assets);
  // Keep old entries for deleted files: a deleted module can still be a
  // changed root, and its cached reverse edges identify the tests that used
  // to import it. Stale entries are harmless because only existing tests are
  // passed to Vitest below.
  const graph = { ...previous };
  const changedFiles = changedPaths;
  let reusedEntries = 0;
  let rebuiltEntries = 0;
  for (const file of files) {
    const old = previous[file];
    // `changed-paths.txt` is the completeness boundary for the PR diff; the
    // cached revision diff covers commits added since that graph snapshot.
    // Existing source edits are re-indexed and data/asset edits leave import
    // topology unchanged; additions or deletions force the full rebuild above.
    // A graph cache may have been produced by a full checkout and restored in
    // a sparse one.  Do not let the fast path hide a tracked source that is no
    // longer materialized: force it through `importsOf`, whose ENOENT branch
    // records the incomplete checkout and makes a real verdict fail closed.
    if (reusable && !changedFiles.has(file) && old?.signature && existsSync(file)) {
      graph[file] = old;
      reusedEntries += 1;
      continue;
    }
    const sig = signature(file);
    if (reusable && sig !== null && old?.signature === sig) {
      graph[file] = old;
      reusedEntries += 1;
    } else {
      graph[file] = { signature: sig, ...importsOf(file, fileSet, assets, assetSet) };
      rebuiltEntries += 1;
    }
  }
  mkdirSync(path.dirname(graphFile), { recursive: true });
  writeFileSync(graphFile, JSON.stringify({
    version: graphVersion,
    revision: currentRevision,
    assets: assetsDigest,
    files: graph,
  }));
  console.log(`Related graph: reused ${reusedEntries} entries, rebuilt ${rebuiltEntries}.`);
  return graph;
}

function scriptKindFor(file) {
  const ts = loadTypeScript();
  if (/\.tsx$/i.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(file)) return ts.ScriptKind.JSX;
  if (/\.json$/i.test(file)) return ts.ScriptKind.JSON;
  if (/\.ts$/i.test(file)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function loadTypeScript() {
  if (!typescript) typescript = require('typescript');
  return typescript;
}

function declarationName(node) {
  const ts = loadTypeScript();
  return node.name && ts.isIdentifier(node.name) ? node.name.text : null;
}

function modifierSet(node) {
  const ts = loadTypeScript();
  return new Set((ts.getModifiers(node) || []).map((modifier) => modifier.kind));
}

function sourceDeclarations(file, source) {
  const ts = loadTypeScript();
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(file),
  );
  const declarations = [];
  const add = (node, localNames, exportNames = []) => {
    declarations.push({
      start: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      end: sourceFile.getLineAndCharacterOfPosition(node.end).line + 1,
      localNames: [...new Set(localNames.filter(Boolean))],
      exportNames: [...new Set(exportNames.filter(Boolean))],
      body: source.slice(node.getStart(sourceFile), node.end),
    });
  };

  for (const statement of sourceFile.statements) {
    const modifiers = modifierSet(statement);
    const isExported = modifiers.has(ts.SyntaxKind.ExportKeyword);
    const isDefault = modifiers.has(ts.SyntaxKind.DefaultKeyword);
    if (ts.isFunctionDeclaration(statement)
      || ts.isClassDeclaration(statement)
      || ts.isInterfaceDeclaration(statement)
      || ts.isTypeAliasDeclaration(statement)
      || ts.isEnumDeclaration(statement)) {
      const local = declarationName(statement);
      const exports = isDefault ? ['default'] : (isExported && local ? [local] : []);
      add(statement, [local], exports);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      const locals = statement.declarationList.declarations
        .map((declaration) => declarationName(declaration));
      add(statement, locals, isExported ? (isDefault ? ['default'] : locals) : []);
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
      for (const element of statement.exportClause.elements) {
        const local = element.propertyName?.text || element.name.text;
        add(element, [local], [element.name.text]);
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      const expression = ts.isIdentifier(statement.expression) ? statement.expression.text : null;
      add(statement, [expression], ['default']);
    }
  }
  return declarations;
}

let sourceDiffBase;
function relatedDiffBase() {
  if (sourceDiffBase !== undefined) return sourceDiffBase;
  sourceDiffBase = null;
  const refs = [...new Set([
    process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : null,
    'origin/main',
  ].filter(Boolean))];
  for (const ref of refs) {
    try {
      sourceDiffBase = execFileSync('git', ['merge-base', ref, 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (sourceDiffBase) break;
    } catch {}
  }
  return sourceDiffBase;
}

function changedLineRanges(diff) {
  const ranges = [];
  let hasDeletion = false;
  for (const match of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(match[1]);
    const count = Number(match[2] || 1);
    if (count === 0) hasDeletion = true;
    else ranges.push([start, start + count - 1]);
  }
  return { ranges, hasDeletion };
}

const sourceImpactCache = new Map();
const identifierPattern = (name) => new RegExp(
  `\\b${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`,
  'u',
);
function changedExportSymbols(file) {
  if (sourceImpactCache.has(file)) return sourceImpactCache.get(file);
  let result = null;
  const base = relatedDiffBase();
  let source;
  let diff;
  try {
    source = readFileSync(file, 'utf8');
    if (!base) throw new Error('no merge base');
    diff = execFileSync('git', ['diff', '--unified=0', base, '--', file], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    sourceImpactCache.set(file, null);
    return null;
  }
  const { ranges, hasDeletion } = changedLineRanges(diff);
  if (ranges.length === 0 || hasDeletion) {
    sourceImpactCache.set(file, null);
    return null;
  }
  const declarations = sourceDeclarations(file, source);
  const executableLines = stripSourceComments(source).split(/\r?\n/u);
  const exportedNames = new Set(declarations.flatMap(({ exportNames }) => exportNames));
  if (exportedNames.size === 0) {
    sourceImpactCache.set(file, null);
    return null;
  }
  const impactedLocals = new Set();
  let unmappedChange = false;
  for (const [start, end] of ranges) {
    for (let line = start; line <= end; line += 1) {
      if (!executableLines[line - 1]?.trim()) continue;
      const matching = declarations.filter((declaration) => declaration.start <= line && declaration.end >= line);
      if (matching.length === 0) unmappedChange = true;
      for (const declaration of matching) {
        for (const local of declaration.localNames) impactedLocals.add(local);
      }
    }
  }
  if (unmappedChange || impactedLocals.size === 0) {
    sourceImpactCache.set(file, null);
    return null;
  }

  // A private helper can carry the changed behavior into an exported
  // function. Propagate only through declarations in this file; this is the
  // bounded replacement for traversing the entire reverse application graph.
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (declaration.localNames.some((name) => impactedLocals.has(name))) continue;
      if ([...impactedLocals].some((name) => identifierPattern(name).test(declaration.body))) {
        for (const local of declaration.localNames) impactedLocals.add(local);
        changed = true;
      }
    }
  }
  result = new Set(declarations
    .filter((declaration) => declaration.localNames.some((name) => impactedLocals.has(name)))
    .flatMap(({ exportNames }) => exportNames));
  if (result.size === 0) result = null;
  sourceImpactCache.set(file, result);
  return result;
}

function sourceEdgeIsImpacted(edgeBindings, changedSymbols) {
  if (!changedSymbols || edgeBindings.some(({ imported }) => imported === '*')) return true;
  return edgeBindings.some(({ imported }) => changedSymbols.has(imported));
}

const sourcePropagationCache = new Map();
function impactedExportsThroughSource(file, bindings, incomingSymbols) {
  const cacheKey = `${file}\0${incomingSymbols ? [...incomingSymbols].sort().join(',') : '*'}`;
  if (sourcePropagationCache.has(cacheKey)) return sourcePropagationCache.get(cacheKey);
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    sourcePropagationCache.set(cacheKey, null);
    return null;
  }
  const declarations = sourceDeclarations(file, source);
  const exportedNames = new Set(declarations.flatMap(({ exportNames }) => exportNames));
  const wildcard = bindings.some(({ imported }) => imported === '*');
  if (wildcard && exportedNames.size === 0) {
    sourcePropagationCache.set(cacheKey, null);
    return null;
  }
  const impactedLocals = new Set();
  for (const binding of bindings) {
    if (incomingSymbols && binding.imported !== '*' && !incomingSymbols.has(binding.imported)) continue;
    if (binding.local === '*') {
      for (const name of exportedNames) impactedLocals.add(name);
    } else {
      impactedLocals.add(binding.local);
    }
  }
  if (impactedLocals.size === 0 && !wildcard) {
    const empty = new Set();
    sourcePropagationCache.set(cacheKey, empty);
    return empty;
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (declaration.localNames.some((name) => impactedLocals.has(name))) continue;
      if ([...impactedLocals].some((name) => identifierPattern(name).test(declaration.body))) {
        for (const local of declaration.localNames) impactedLocals.add(local);
        changed = true;
      }
    }
  }
  const result = new Set(declarations
    .filter((declaration) => declaration.localNames.some((name) => impactedLocals.has(name)))
    .flatMap(({ exportNames: names }) => names));
  if (result.size === 0 && wildcard) {
    sourcePropagationCache.set(cacheKey, null);
    return null;
  }
  sourcePropagationCache.set(cacheKey, result);
  return result;
}

const candidates = [...new Set(changed.filter((file) =>
  file !== 'scripts/ci/run-related-tests.mjs'
    && (!ignoredRe.test(file) || dataAssetRe.test(file))
    && (sourceRe.test(file) || isRelatedAsset(file))
    && !alwaysExcludedTests.has(file)))];
const runnerChanged = changed.includes(runnerPath);
const globalVitestConfigChanged = changed.some((file) => globalVitestConfigPaths.has(file));
const fullSuiteRequired = globalVitestConfigChanged;
rejectDryRunInCi();
if (changedStatus !== 'complete') {
  stopWithoutFullSuite(`changed-paths status is ${changedStatus}`);
}
requireFullCheckoutForVerdict();
const triggeredSourceTreeLints = sourceTreeLintsFor(changed);
// Un diff senza candidati per il grafo esce qui solo se non rientra nemmeno nel
// perimetro di un lint dell'albero dei sorgenti: altrimenti l'uscita anticipata
// scavalcherebbe il lint proprio sui file che nessun altro test può vedere.
if (candidates.length === 0 && !fullSuiteRequired && !runnerChanged && triggeredSourceTreeLints.length === 0) {
  console.log('No existing source/test files in the diff → related-only run has no tests.');
  if (selectionOnly) writeAssembleDecision([]);
  process.exit(0);
}

function changedAssetsFromDiff() {
  const refs = [...new Set([
    process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : null,
    'origin/main',
  ].filter(Boolean))];
  let lastError = null;
  for (const ref of refs) {
    let base;
    try {
      base = execFileSync('git', ['merge-base', ref, 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch (error) {
      lastError = error;
      continue;
    }
    try {
      const fields = execFileSync('git', [
        // This consumer needs only the set of asset paths. `R old new` and
        // `D old` + `A new` therefore produce the same entries; rename
        // detection would otherwise lazy-fetch base blobs under `blob:none`.
        'diff', '--name-status', '--no-renames', '-z', base, '--', '.github', 'tests', ...rootDocContracts,
      ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
      const assets = [];
      for (const paths of parseNameStatusZ(fields)) {
        for (const filePath of paths) {
          const file = normalize(filePath);
          if (isRelatedAsset(file)) assets.push(file);
        }
      }
      return assets;
    } catch (error) {
      lastError = error;
      continue;
    }
  }
  if (lastError) {
    console.warn(`Unable to inspect changed related-test assets from any base ref: ${lastError.message || lastError}`);
  }
  return [];
}

const tracked = trackedFiles();
const assets = [...new Set([
  ...trackedAssets(),
  ...candidates.filter(isRelatedAsset),
  ...changedAssetsFromDiff(),
])];
const graph = loadGraph(tracked, assets);
if (unreadable.length > 0) {
  // Loud, and above the selection, because it is the one thing that can make
  // the list below shorter than it should be. Zero on a full checkout.
  console.log(`⚠️ ${unreadable.length} tracked file(s) unreadable in this working tree (sparse checkout?) — dropped from the import graph, so the selection may be incomplete:`);
  for (const file of unreadable.slice(0, 10)) console.log(`   ${file}`);
  if (unreadable.length > 10) console.log(`   … and ${unreadable.length - 10} more`);
  // A sparse checkout is useful for inspecting a selection, but it cannot
  // produce a trustworthy related-test verdict. Keep the explicit local
  // dry-run seam for that inspection and fail closed for every real run.
  const sparseInspection = process.env.VITEST_RELATED_DRY_RUN === 'true'
    && process.env.GITHUB_ACTIONS !== 'true';
  if (!sparseInspection && process.env.VITEST_RELATED_DRY_RUN !== 'true') {
    console.error('BLOCKED: related-test verdict requires a full checkout; missing tracked imports make the static graph incomplete.');
    console.error('Run this command in CI or from a full checkout with data/ and public/ materialized.');
    process.exit(2);
  }
}
const isRunnableTest = (file) => testRe.test(file)
  && !corpusWideTests.has(file)
  && !alwaysExcludedTests.has(file);
const allTests = tracked.filter(isRunnableTest);
const reverse = new Map();
for (const [file, entry] of Object.entries(graph)) {
  for (const dep of entry.deps) {
    if (!reverse.has(dep)) reverse.set(dep, []);
    reverse.get(dep).push({
      file,
      bindings: entry.imports?.[dep] || [{ imported: '*', local: '*' }],
    });
  }
}
const sourceCandidates = candidates.filter((file) => sourceRe.test(file));
const related = new Set(fullSuiteRequired ? allTests : candidates.filter(isRunnableTest));
if (globalVitestConfigChanged) {
  console.log('vitest.config.ts changed → running all tracked tests because it configures the complete Vitest suite.');
}
if (runnerChanged && !fullSuiteRequired) {
  for (const test of runnerRegressionTests) {
    if (isRunnableTest(test)) related.add(test);
  }
  console.log('related-test runner changed → running its explicit regression-test suite.');
}
if (!fullSuiteRequired && candidates.some((file) => isRunnableTest(file))) {
  for (const test of testTreeLintTests) {
    if (isRunnableTest(test)) related.add(test);
  }
  console.log('test file(s) changed → running the test-tree lints.');
}
if (!fullSuiteRequired && candidates.some((file) => workflowAssetRe.test(file))) {
  for (const test of workflowAssetGlobalTests) {
    if (isRunnableTest(test)) related.add(test);
  }
  console.log('workflow asset changed → running the bounded global workflow contracts.');
}
// `selectMaxWorkers` keeps the historical argument name for compatibility;
// after this fix it is true only for the explicit global-config run, never for
// an unmodelled dependency.
const usedFullFallback = fullSuiteRequired;
const assetCandidate = isRelatedAsset;
const testReadsExactAsset = (test, asset) => {
  try {
    return assetLiteralsIn(stripSourceComments(readFileSync(test, 'utf8')), test).has(asset);
  } catch {
    return true;
  }
};
const assetScopeAllows = (test, asset) => {
  const scope = relatedAssetFileScopes.get(test);
  if (scope) return assetScopeMatches(scope, asset);
  if (workflowAssetRe.test(asset)) return testReadsExactAsset(test, asset);
  if (hasBoundedRootAssetScope(asset)) return graph[test]?.deps.includes(asset) === true;
  return true;
};

// A source file is a test owner through symbol-aware imports. Propagation
// across a source wrapper is allowed only when the imported symbol is carried
// into one of that wrapper's exports; this keeps a private helper change from
// becoming every test that happens to share the app shell. Shared roots with
// path/dynamic contracts opt into a bounded scope above.
if (!fullSuiteRequired) {
  const sourceQueue = [];
  for (const file of sourceCandidates.filter((candidate) => !isRunnableTest(candidate))) {
    const scope = sourceTestScopeFor(file);
    if (scope) {
      for (const test of allTests) {
        if (scope.tests.some((pattern) => pattern.test(test))) related.add(test);
      }
      continue;
    }
    sourceQueue.push({ file, symbols: changedExportSymbols(file) });
  }
  const sourceVisited = new Set();
  while (sourceQueue.length) {
    const current = sourceQueue.shift();
    const symbolKey = current.symbols ? [...current.symbols].sort().join(',') : '*';
    const visitKey = `${current.file}\0${symbolKey}`;
    if (sourceVisited.has(visitKey)) continue;
    sourceVisited.add(visitKey);
    for (const edge of reverse.get(current.file) || []) {
      if (!sourceEdgeIsImpacted(edge.bindings, current.symbols)) continue;
      if (isRunnableTest(edge.file)) {
        related.add(edge.file);
        continue;
      }
      if (!sourceRe.test(edge.file) || sourceTestScopeFor(edge.file)) continue;
      const nextSymbols = impactedExportsThroughSource(edge.file, edge.bindings, current.symbols);
      if (nextSymbols === null || nextSymbols.size > 0) {
        sourceQueue.push({ file: edge.file, symbols: nextSymbols });
      }
    }
  }
}

// Asset readers still need their bounded closure: a workflow/data path is
// often consumed by a helper that the test imports indirectly. This queue is
// deliberately asset-rooted; source candidates never enter it.
const queue = candidates.filter(assetCandidate).map((file) => ({
  file,
  rootAsset: file,
}));
const queued = new Set(queue.map(({ file, rootAsset }) => `${rootAsset}\0${file}`));
const visited = new Set();
while (queue.length) {
  const current = queue.shift();
  const { file, rootAsset } = current;
  const visitKey = `${rootAsset}\0${file}`;
  if (visited.has(visitKey)) continue;
  visited.add(visitKey);
  for (const edge of reverse.get(file) || []) {
    const importer = edge.file;
    const importerIsTest = isRunnableTest(importer);
    const admitted = !importerIsTest || assetScopeAllows(importer, rootAsset);
    if (admitted && importerIsTest) related.add(importer);
    if (!admitted) continue;
    const queueKey = `${rootAsset}\0${importer}`;
    if (!queued.has(queueKey)) {
      queued.add(queueKey);
      queue.push({ file: importer, rootAsset });
    }
  }
}
// Source-tree lints are real, bounded coverage for changes whose dependency is
// discovered by scanning a directory rather than importing a file. Admit them
// before deciding whether the graph is empty; they are not a license to add
// the full suite.
if (!fullSuiteRequired) {
  for (const test of triggeredSourceTreeLints) {
    if (isRunnableTest(test) && tracked.includes(test)) related.add(test);
  }
}
// Never report success with zero tests for a source change. The old
// conservative full-suite fallback made an unmodelled dependency safe only by
// launching thousands of unrelated files; the incident that motivated this
// runner showed that this turns one missing edge into a 40-minute PR gate.
// A complete diff with no statically related runnable test is now a fast,
// actionable selection failure. The author must add/update the impacted test
// or declare a scoped tree-lint dependency; CI never silently pays the full
// suite for an unknown edge.
if (!fullSuiteRequired
  && related.size === 0
  && sourceCandidates.length > 0) {
  stopWithoutFullSuite(
    `no statically related runnable test for ${sourceCandidates.join(', ')}`,
  );
}
const tests = [...related].filter((file) => existsSync(file)).sort();
const githubCandidateCount = candidates.filter((file) => githubAssetRe.test(file)).length;
const fixtureCandidateCount = candidates.filter((file) => testFixtureRe.test(file)).length;
const docContractCandidateCount = candidates.filter((file) => rootDocContractSet.has(file)).length;
const changedSourceCount = sourceCandidates.length + (runnerChanged ? 1 : 0);
console.log(`Running Vitest related to ${changedSourceCount} changed source/test file(s)`
  + (githubCandidateCount ? ` + ${githubCandidateCount} .github asset(s)` : '')
  + (fixtureCandidateCount ? ` + ${fixtureCandidateCount} tests fixture(s)` : '')
  + (docContractCandidateCount ? ` + ${docContractCandidateCount} root doc contract(s)` : '')
  + `: ${tests.length} test file(s)`);
console.log(tests.join('\n'));
if (selectionOnly) {
  writeAssembleDecision([...related]);
  process.exit(0);
}
if (tests.length === 0) process.exit(0);
// Seam per ispezionare la SELEZIONE senza pagare la corsa: stampa l'elenco qui
// sopra ed esce. Usato da tests/run-related-tests-selection.test.ts e utile
// a mano per capire perche' un file seleziona (o non seleziona) un test.
//
// Il seam serve in locale e nel sottoprocesso dell'osservatore, mai nel gate.
// Se trapelasse nel job bloccante, fallire esplicitamente e' piu' sicuro che
// uscire 0 senza eseguire un solo test, indistinguibile da una selezione vuota.
if (process.env.VITEST_RELATED_DRY_RUN === 'true') {
  process.exit(0);
}

const args = ['node_modules/vitest/vitest.mjs', 'run', '--passWithNoTests'];
const maxWorkers = selectMaxWorkers({
  usedFullFallback,
  maxWorkers: process.env.VITEST_MAX_WORKERS,
  maxWorkersFallback: process.env.VITEST_MAX_WORKERS_FALLBACK,
  relatedTestCount: tests.length,
});
if (maxWorkers) args.push(`--maxWorkers=${maxWorkers}`);
if (process.env.VITEST_POOL) args.push(`--pool=${process.env.VITEST_POOL}`);
args.push(...tests, ...process.argv.slice(2));
// L'env del figlio porta VITEST_MAX_WORKERS allineato al valore scelto:
// Vitest la legge e la applica sopra `--maxWorkers` (vedi vitestChildEnv).
const result = spawnSync(process.execPath, args, {
  stdio: 'inherit',
  env: vitestChildEnv(process.env, maxWorkers),
});
if (result.error) {
  console.error(`Unable to start Vitest related run: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
