#!/usr/bin/env node
/**
 * Run only tests related to the current PR diff.
 *
 * Vitest's `related` command rebuilds an in-memory Vite graph for every CI
 * run and inspects every discovered spec. In this repository that discovery
 * costs minutes while the selected tests take seconds. This runner keeps a
 * small static import graph on disk, updates only changed files, walks it in
 * reverse from changed sources, and passes the resulting test files directly
 * to Vitest. It stays related-only for ordinary imports, with a conservative
 * full-test fallback only when the changed-path collector cannot prove a
 * complete diff. Runtime/configuration files are not treated as global Vitest
 * dependencies by default: the root `vitest.config.ts` is the explicit
 * exception because it configures every test project, while CI and TypeScript
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
import path from 'node:path';
import { listCorpusWideTests } from './corpus-wide-tests.mjs';
import { shouldAssembleForRelatedTests } from './dataset-dependent-tests.mjs';
import { shouldSkipFullSuiteFallback } from './lib/orphan-fallback.mjs';
import { selectMaxWorkers, vitestChildEnv } from './lib/select-max-workers.mjs';
import { missingFullCheckoutArtifacts } from './lib/typecheck-sparse.mjs';
import { GRAPH_IGNORED_RE, GRAPH_SOURCE_RE, isGraphSourceFile } from './lib/related-graph-scope.mjs';
import { CRAWLER_GENERATION_RUNTIME_PATHS } from '../lib/crawler-generation-runtime-paths.mjs';
import { isScanned as isSecretScanned } from './scan-site-hardcoded-secrets.mjs';
import { TRANSPORT_MANIFEST, transportManifestPaths } from './corpus-ahead-check.mjs';

const changedPathFile = process.env.CHANGED_PATHS_FILE || 'changed-paths.txt';
const changedStatusFile = process.env.CHANGED_PATHS_STATUS_FILE || 'changed-paths-status.txt';
const graphFile = process.env.VITEST_RELATED_GRAPH || '.cache/vitest-related/graph.json';
const selectionOnly = process.argv.includes('--select-only');
const sourceRe = GRAPH_SOURCE_RE;
const testRe = /^(?:tests|packages\/[^/]+\/tests)\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const runnerPath = 'scripts/ci/run-related-tests.mjs';
const globalVitestConfigPaths = new Set(['vitest.config.ts']);
// These tests exercise the runner through its real subprocess seam or pin its
// CI wiring. They are deliberately explicit: broadening every `scripts/` or
// `.github/` change into a full suite would undo the related-test bound.
const runnerRegressionTests = new Set([
  'tests/run-related-tests-github-assets.test.ts',
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
]);
// Perimetro del transport verso nanako: il manifest e i path che consegna.
// Letto alla prima domanda, non all'avvio: la maggior parte dei diff si ferma
// prima dei lint. Glob `dir/**` espansi contro l'albero reale, come nel guard.
let transportScope = null;
const isTransportScope = (file) => {
  transportScope ??= new Set([TRANSPORT_MANIFEST, ...transportManifestPaths(process.cwd())]);
  return transportScope.has(file);
};
// Lint dell'albero dei SORGENTI: scandiscono `.github`, `scripts` e `bin` per
// directory e non nominano i file che giudicano, quindi né il grafo inverso né
// l'indice dei letterali `.github/…` li collegano al diff. Girano quando il
// diff tocca un path nel loro perimetro. Sulla PR 9959 i due fixer contavano i
// commenti con `--paginate --slurp --jq`, che il gh reale rifiuta: il guard
// esisteva dal 25-09 (#9797) ma su 126 test scelti per quel diff lui mancava.
//
// Il perimetro è una RegExp oppure un predicato. Il gate dei segreti hardcoded
// usa il predicato dello scanner stesso (`isScanned`): riscrivere qui il suo
// perimetro in una regex creerebbe due definizioni libere di divergere. Sulla
// PR 10336 una chiave Google Maps di terzi è entrata in una fixture HTML di
// `tests/fixtures/`: il gate la riconosceva, ma un `.html` non è né sorgente né
// asset indicizzato, quindi il diff selezionava zero test e lui non girava.
// Nel perimetro anche il modulo che definisce l'elenco: cambiarlo cambia la
// closure dichiarata dal generatore.
const crawlerGenerationRuntimePaths = new Set([
  ...CRAWLER_GENERATION_RUNTIME_PATHS,
  'scripts/lib/crawler-generation-runtime-paths.mjs',
]);
const sourceTreeLintTests = new Map([
  ['tests/gh-slurp-jq-guard.test.ts', /^(?:\.github|scripts|bin)\//],
  ['tests/no-hardcoded-secrets.test.ts', isSecretScanned],
  // Chiusura per import del transport verso nanako: il test legge il manifest
  // e gli import dei file trasportati da disco, quindi non importa nessuno dei
  // file che giudica. La PR 10973 ha fatto importare a
  // `build-plugins/borderWaitData.ts` (trasportato) un modulo non consegnato:
  // il diff non lo selezionava e il rosso e' emerso giorni dopo sulla 11299.
  // Il perimetro e' il manifest stesso, parsato dalla funzione del guard.
  ['tests/mirror-transport-import-closure.test.ts', isTransportScope],
  // Elenchi di run per `branch` senza finestra `created`: l'API li restituisce
  // a tratti fermi a settimane prima (resolver dell'artifact Pages, 02-10).
  ['tests/run-listing-created-window.test.ts', /^(?:\.github|scripts|bin|functions)\//],
  // Il guard del nome del check vitest legge da disco ogni script sotto
  // `scripts/ci/`: un file NUOVO che scrive a mano il literal non importa
  // niente che il test conosca. La PR 11667 l'ha introdotto in
  // `scripts/ci/lib/followup-ci-suite-proof.mjs` e main e' rimasto rosso in
  // latenza finche' la 11705 non ha fatto selezionare il test.
  ['tests/ci-vitest-check-name.test.ts', /^scripts\/ci\//],
  // Lint del token App su TUTTI i workflow (issue 10114): un workflow nuovo
  // che pusha con `env.APP_TOKEN || ...` non importa niente, e uno script in
  // `scripts/` puo' cominciare a pushare o a leggere APP_TOKEN senza che il
  // workflow che lo lancia cambi. Il test legge entrambi da disco. Il runner
  // stesso e' escluso: non pusha, e la sua suite di regressione ha un budget.
  [
    'tests/workflow-app-token-capability.test.ts',
    (file) => /^(?:\.github\/workflows|scripts)\//.test(file) && file !== 'scripts/ci/run-related-tests.mjs',
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
  ['tests/crawler-generation-observer-workflow.test.ts', /^(?:scripts|functions)\//],
  // La lista sparse di housekeeping sta in un file, non nel YAML (il corpus
  // pinna il YAML, il codice e' quello di main): il test calcola la chiusura
  // degli import degli entrypoint, quindi nessun import lo collega al modulo
  // che ne aggiunge uno fuori lista. Deve girare proprio su quel diff.
  ['tests/housekeeping-sparse-paths.test.ts', /^(?:scripts|packages\/articles\/engine)\/|^\.github\/workflows\/housekeeping-jobs-logic\.yml$/],
  // Stessa forma per i gruppi crawler: il generatore dichiara la chiusura degli
  // import del finalizer con un elenco e il test la confronta con quella reale
  // letta da disco. Sulla PR 11262 un import nuovo in crawler-grace-policy.mjs
  // e' passato senza che il test girasse. Il perimetro e' l'elenco stesso, non
  // una regex che possa divergere da esso.
  ['tests/generate-crawler-group-workflows.test.ts', (file) => crawlerGenerationRuntimePaths.has(file)],
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
  // Questi scandiscono ricorsivamente tutto scripts/, ognuno con le proprie
  // estensioni; costano pochi secondi.
  ['tests/score-ledger-persistence.test.ts', /^scripts\/.+\.mjs$/],
  ['tests/undici-dispatcher-fetch-pairing.test.ts', /^scripts\/.+\.(?:mjs|js)$/],
  ['tests/is-invoked-directly.test.ts', /^scripts\/.+\.(?:mjs|cjs|js|ts)$/],
  ['tests/translation-protected-tokens.test.ts', /^scripts\/.+\.mjs$/],
  // Lo UA da browser dei dettagli MySwitzerland e' un'eccezione del
  // proprietario (D1, 2026-10-05) confinata a quel crawler: il guard legge da
  // disco ogni sorgente di scripts/, e un file nuovo che la copia non importa
  // niente che il test conosca. Il runner e' infrastruttura di selezione, non
  // codice crawler, ed e' gia' coperto dalla sua suite di regressione bounded:
  // escluderlo evita di far crescere quel budget senza restringere il guard per
  // nessun altro sorgente sotto scripts/.
  ['tests/myswitzerland-browser-ua-confinement.test.ts', (file) => /^scripts\//.test(file) && file !== runnerPath],
  ['tests/slug-write-encapsulation.test.ts', /^scripts\/.+\.(?:ts|mjs|js)$/],
  // Ratchet sulle chiusure per titolo: legge da disco ogni sorgente che usa
  // `resolveGithubIssue` e lo confronta con l'elenco dichiarato. Un closer
  // nuovo non importa il test, quindi senza questa voce entrerebbe senza
  // farlo partire (stessa lezione della PR 11308). Perimetro = quello dello scan.
  ['tests/resolve-issue-by-title-ratchet.test.ts', /^(?:scripts\/.+\.mjs|functions\/.+\.(?:js|mjs|ts))$/],
  // Stessa classe per le allow-list sparse di `bing-seo-loop.yml`: PR 10941
  // ha aggiunto un import a `scripts/lib/jobBoardSections.mjs`, verde, e la
  // run del crawler e' morta con ERR_MODULE_NOT_FOUND. Il perimetro e' un
  // path, non un import; il test verifica che la chiusura dei job ci stia.
  ['tests/seo/bing-seo-loop-sparse-closure.test.ts', /^(?:scripts|build-plugins\/shared|packages\/articles\/engine)\/|^\.github\/workflows\/bing-seo-loop\.yml$/],
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
    /^(?:vite\.config\.ts|constants\.ts|(?:build-plugins|services|scripts|components|data|functions|infra|packages\/articles)\/.+\.(?:[mc]?[jt]sx?))$/,
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
  // Metadati degli autori da un'unica fonte: il test confronta le pagine autore
  // di seo-pages.ts, il roster statico di /chi-siamo/ e llms.txt col registro.
  // `data/authors.ts` e `data/authorLocales.ts` sono fuori dal grafo e i due
  // sorgenti giudicati sono letti da disco: dopo la PR 11327 la bio corretta nel
  // registro e' rimasta vecchia nelle copie a mano senza che nulla fallisse.
  ['tests/author-metadata-single-source.test.ts', /^(?:data\/[^/]+\.(?:[cm]?[jt]sx?|json)|services\/seo\/seo-pages\.ts|build-plugins\/staticPagesPlugin\.ts|build-plugins\/shared\/authorEditorial\.ts|scripts\/lib\/llms-txt-generator\.mjs|services\/seo\/authorProfileMetadata\.ts)$/], // Scope producers: build-plugins/shared/authorEditorial.ts, scripts/lib/llms-txt-generator.mjs, services/seo/authorProfileMetadata.ts.
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
  ['tests/checkout-sparse-profiles.test.ts', /^(?:\.github\/(?:workflows|actions)\/|package\.json$|(?:scripts|functions|services|build-plugins|infra|server|packages\/articles)\/.+\.(?:[cm]?[jt]sx?|sh|json)$|[^/]+\.(?:[cm]?[jt]sx?)$)/],
]);
const inLintScope = (scope, file) => (typeof scope === 'function' ? scope(file) : scope.test(file));
// Calcolata sul diff GREZZO (`changed`), non sui candidati del grafo: un lint
// che enumera l'albero giudica anche i file che il grafo non conosce (HTML,
// shell, Markdown), e sono proprio quelli che non hanno altro gate.
const sourceTreeLintsFor = (files) => [...sourceTreeLintTests]
  .filter(([, scope]) => files.some((file) => inLintScope(scope, file)))
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
const relatedAssetFileScopes = new Map([
  ['build-plugins/crawlerRegistryPlugin.ts', crawlerAssetScope],
  // This module validates a remote Actions API binding. Its `.github/workflows/`
  // string is an API identity, not a local file read.
  ['scripts/lib/githubWorkflowDispatch.mjs', []],
  ['tests/generate-crawler-group-workflows.test.ts', crawlerAssetScope],
  ...crawlerAssetRelatedTests.map((file) => [file, crawlerAssetScope]),
]);
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
const assetLiteralRe = /(?:\.github|tests)\/[A-Za-z0-9._-][A-Za-z0-9._/-]*/g;
// La stessa dipendenza costruita a SEGMENTI: `path.join(ROOT, '.github',
// 'workflows')` o `path.resolve(__dirname, '..', '.github', 'workflows', 'x.yml')`.
// La sequenza di letterali consecutivi separati da virgola che inizia con
// `'.github'` vale come il path unito con `/`.
const segmentedAssetRe = /(['"])\.github\1(?:\s*,\s*(['"])[A-Za-z0-9._-][A-Za-z0-9._/-]*\2)+/g;
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
const isRelatedAsset = (file) => githubAssetRe.test(file) || testFixtureRe.test(file) || rootDocContractSet.has(file);
const skipCorpusWide = process.env.VITEST_SKIP_CORPUS_WIDE === 'true';
const corpusWideTests = skipCorpusWide ? new Set(listCorpusWideTests()) : new Set();
// A related-test verdict is only meaningful when the generated runtime data
// used by the selected tests is present. The CI checkout materializes these
// sentinels; a local sparse worktree does not. Keep `--select-only` and the
// local dry-run seam usable for inspecting the graph, but never let a real
// Vitest invocation turn missing artifacts into application regressions.
function requireFullCheckoutForVerdict() {
  const missing = missingFullCheckoutArtifacts();
  const localInspection = selectionOnly
    || (process.env.VITEST_RELATED_DRY_RUN === 'true' && process.env.GITHUB_ACTIONS !== 'true');
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

function stripComments(source) {
  let out = '';
  let quote = null;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (quote) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      out += char;
    } else if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      out += '\n';
    } else if (char === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n';
        i++;
      }
      i++;
    } else {
      out += char;
    }
  }
  return out;
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

function importsOf(file, fileSet, assets) {
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
    return [];
  }
  const deps = new Set();
  const code = stripComments(source);
  for (const match of code.matchAll(importRe)) {
    const dep = resolveImport(file, match[2], fileSet);
    if (dep) deps.add(dep);
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
    literals.push([...sequence.matchAll(segmentLiteralRe)].map((m) => m[1]).join('/'));
  }
  for (const rawLiteral of literals) {
    // La barra finale va tolta: un riferimento costruito per template —
    // `` `.github/workflows/${name}` `` o `'.github/corpus-workflows/' + file` —
    // lascia il letterale con lo slash e senza normalizzazione non matcha.
    const literal = rawLiteral.replace(/\/+$/, '');
    for (const asset of assets) {
      if (asset === literal || asset.startsWith(`${literal}/`)) deps.add(asset);
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
      if (assets.includes(literal)) deps.add(literal);
    }
  }
  const scope = relatedAssetFileScopes.get(file);
  return [...deps]
    .filter((asset) => !scope || scope.some((pattern) => pattern.test(asset)))
    .sort();
}

function loadGraph(files, assets) {
  let previous = {};
  let previousVersion = 0;
  let previousAssets = null;
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
  // 'workflows')`): una entry della versione 7 non li ha.
  const assetsDigest = createHash('sha1').update([...assets].sort().join('\n')).digest('hex');
  try {
    const cached = JSON.parse(readFileSync(graphFile, 'utf8'));
    previous = cached.files || {};
    previousVersion = cached.version || 0;
    previousAssets = cached.assets || null;
  } catch {}
  const reusable = previousVersion === 8 && previousAssets === assetsDigest;
  const fileSet = new Set(files);
  // Keep old entries for deleted files: a deleted module can still be a
  // changed root, and its cached reverse edges identify the tests that used
  // to import it. Stale entries are harmless because only existing tests are
  // passed to Vitest below.
  const graph = { ...previous };
  for (const file of files) {
    const sig = signature(file);
    const old = previous[file];
    graph[file] = reusable && old?.signature === sig
      ? old
      : { signature: sig, deps: importsOf(file, fileSet, assets) };
  }
  mkdirSync(path.dirname(graphFile), { recursive: true });
  writeFileSync(graphFile, JSON.stringify({ version: 8, assets: assetsDigest, files: graph }));
  return graph;
}

const candidates = [...new Set(changed.filter((file) =>
  file !== 'scripts/ci/run-related-tests.mjs' && !ignoredRe.test(file)
    && (sourceRe.test(file) || isRelatedAsset(file))
    && !alwaysExcludedTests.has(file)))];
const forceFull = changedStatus !== 'complete';
const runnerChanged = changed.includes(runnerPath);
const globalVitestConfigChanged = changed.some((file) => globalVitestConfigPaths.has(file));
const fullSuiteRequired = forceFull || globalVitestConfigChanged;
rejectDryRunInCi();
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
const isRunnableTest = (file) => testRe.test(file) && !corpusWideTests.has(file) && !alwaysExcludedTests.has(file);
const allTests = tracked.filter(isRunnableTest);
const reverse = new Map();
for (const [file, entry] of Object.entries(graph)) {
  for (const dep of entry.deps) {
    if (!reverse.has(dep)) reverse.set(dep, []);
    reverse.get(dep).push(file);
  }
}
const related = new Set(fullSuiteRequired ? allTests : candidates.filter(isRunnableTest));
if (forceFull) {
  console.log(`Changed-paths status is ${changedStatus} → running all tracked tests conservatively.`);
} else if (globalVitestConfigChanged) {
  console.log('vitest.config.ts changed → running all tracked tests because it configures the complete Vitest suite.');
}
if (runnerChanged && !fullSuiteRequired) {
  for (const test of runnerRegressionTests) {
    if (isRunnableTest(test)) related.add(test);
  }
  console.log('run-related-tests.mjs changed → running its explicit regression-test suite.');
}
if (!fullSuiteRequired && candidates.some((file) => isRunnableTest(file))) {
  for (const test of testTreeLintTests) {
    if (isRunnableTest(test)) related.add(test);
  }
  console.log('test file(s) changed → running the test-tree lints.');
}
let usedFullFallback = fullSuiteRequired;
const assetCandidate = isRelatedAsset;
const assetScopeAllows = (test, asset) => {
  const scope = relatedAssetFileScopes.get(test);
  return !scope || scope.some((pattern) => pattern.test(asset));
};
const queue = candidates.map((file) => ({
  file,
  rootAsset: assetCandidate(file) ? file : null,
}));
const queued = new Set(queue.map(({ file, rootAsset }) => `${rootAsset || ''}\0${file}`));
const visited = new Set();
while (queue.length) {
  const current = queue.shift();
  const { file, rootAsset } = current;
  const visitKey = `${rootAsset || ''}\0${file}`;
  if (visited.has(visitKey)) continue;
  visited.add(visitKey);
  for (const importer of reverse.get(file) || []) {
    const importerIsTest = isRunnableTest(importer);
    const admitted = !rootAsset || !importerIsTest || assetScopeAllows(importer, rootAsset);
    if (admitted && importerIsTest) related.add(importer);
    // Once a scoped test rejects this asset, do not use that test as a bridge
    // to admit more files through the same root. Other source modules remain
    // traversable, preserving the old conservative behavior for unscoped
    // consumers.
    if (!admitted) continue;
    const queueKey = `${rootAsset || ''}\0${importer}`;
    if (!queued.has(queueKey)) {
      queued.add(queueKey);
      queue.push({ file: importer, rootAsset });
    }
  }
}
// Never report success with zero tests for a source change: an unmodelled
// dependency is safer as a full run than as a silent no-op — UNLESS every
// changed file is a genuine leaf (zero importers anywhere in the repo, not
// just no test importer), in which case nothing could ever reach it through
// an import and the full run protects nothing (see lib/orphan-fallback.mjs).
// Il fallback si decide sui soli candidati SORGENTE. Un asset non-sorgente che
// nessun test nomina non ha blind spot da coprire — non e' importabile, quindi
// non esiste l'import mancato che il fallback esiste per proteggere — e farlo
// ricadere sulla suite intera farebbe pagare ~1900 file a ogni PR di soli
// workflow, che oggi ne paga zero. La politica related-only di `tests.yml`
// resta invariata.
const sourceCandidates = candidates.filter((file) => sourceRe.test(file));
if (!fullSuiteRequired && related.size === 0 && sourceCandidates.length > 0) {
  if (shouldSkipFullSuiteFallback(sourceCandidates, reverse)) {
    console.log('No static related edge found, and every changed file has zero importers anywhere in the repo (standalone CLI script) → nothing to run, as expected.');
  } else {
    for (const test of allTests) related.add(test);
    usedFullFallback = true;
    console.log('No static related edge found → running all tracked tests conservatively.');
  }
}
// I lint dell'albero dei sorgenti entrano DOPO la decisione sul fallback, mai
// prima: il perimetro del gate dei segreti copre quasi ogni sorgente, quindi
// aggiunti prima renderebbero `related.size` sempre almeno 1 e il fallback
// conservativo qui sopra non scatterebbe più per nessun sorgente senza test.
// Un lint che enumera l'albero non dice nulla su chi importa il file cambiato.
if (!fullSuiteRequired) {
  for (const test of triggeredSourceTreeLints) {
    if (isRunnableTest(test)) related.add(test);
  }
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
// sopra ed esce. Usato da tests/run-related-tests-github-assets.test.ts e utile
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
