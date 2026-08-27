/**
 * corpus-wide-tests.mjs — il registro dei gate che iterano sull'INTERO corpus,
 * e la regola che decide quando restano bloccanti su una PR.
 *
 * ─── Il dato che ha motivato il file ──────────────────────────────────────
 *
 * Tempi per file estratti dal reporter json del run `tests.yml` 32172467043 su
 * main (1739 file di test, 1001s di tempo-file complessivo):
 *
 *     53.9s   7 test   tests/article-hero-image-integrity.test.ts
 *     53.2s   2 test   tests/generated-content-parses.test.ts
 *     24.7s   3 test   tests/render-article-pages-single-vs-full.test.ts
 *     20.1s   2 test   tests/render-article-hub-pages-narrow-vs-full.test.ts
 *     17.3s   4 test   tests/articles-archive-chronological.test.ts
 *     16.7s   2 test   tests/job-locale-consistency.test.ts
 *     15.5s   1 test   tests/blog-body-typescript-syntax.test.ts
 *     ─────
 *     201.4s  21 test  su 1739 file = 20,1% del tempo-file per l'1,2% dei test
 *
 * La forma è inequivocabile: pochissimi test, moltissimi secondi. NON sono
 * lenti per test — `tests/seo-completeness.test.ts` fa 65.750 test in 21s, la
 * quantità di asserzioni non è il problema. Sono lenti perché ciascuno di loro
 * ITERA SU TUTTO: ~14.748 file di corpus articoli, o un render completo di
 * sezione, o il dataset job assemblato. Il costo è O(corpus), quindi cresce da
 * solo a ogni articolo pubblicato — la pipeline ne pubblica decine al giorno.
 * Un gate che peggiora senza che nessuno lo tocchi è un gate che prima o poi
 * viene disattivato di fretta; questo file è l'alternativa a quel finale.
 *
 * ─── Cosa fa questo file, e cosa NON fa ───────────────────────────────────
 *
 * NON toglie un gate e non ne abbassa uno (Non-Negotiable #1). Ogni test qui
 * elencato continua a girare, con le stesse soglie e gli stessi assert. Cambia
 * SOLO dove gira:
 *
 *   - su una PR che NON tocca i dati che quel test scandisce → non gira nel job
 *     bloccante `vitest (unit + integration)`, perché su quella PR misurerebbe
 *     un corpus identico a quello già misurato su main;
 *   - su una PR che TOCCA quei dati (o il codice che li rende) → gira
 *     esattamente come oggi, bloccante, perché lì è il gate che serve;
 *   - su main, sempre, in `.github/workflows/corpus-wide-gates.yml`, che a
 *     rosso apre una issue con titolo stabile via `github-issue-creator.mjs`.
 *
 * ─── Perché la decisione è per-test e non un flag unico ───────────────────
 *
 * Un flag «la PR tocca il corpus» sì/no rimetterebbe in gioco i 201s interi per
 * un diff che tocca `data/jobs/`, dove l'unico gate pertinente è
 * `job-locale-consistency` (16,7s). Ogni voce porta quindi i propri `watch`:
 * le RADICI DATI che quel test legge dal filesystem. Il CODICE non si elenca a
 * mano — si deriva dalla chiusura degli import (vedi `blockingTestsFor`), così
 * un test che domani importa un modulo nuovo si porta dietro il trigger da
 * solo, senza che nessuno debba ricordarsi di aggiornare una lista.
 *
 * L'invariante che tiene in piedi tutto è verificata da
 * `tests/corpus-wide-test-partition.test.ts`: registro e complemento devono
 * essere disgiunti e coprire l'intera suite, e ogni `watch` deve corrispondere
 * a path realmente tracciati. Un registro che nomina un file rinominato non
 * escluderebbe niente e non proteggerebbe niente: fallirebbe in silenzio, che
 * è il modo peggiore di rompere un gate.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  listDatasetDependentTests,
  listDatasetIndependentTests,
  localImports,
} from "./dataset-dependent-tests.mjs";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/**
 * Il registro. `seconds` è MISURATO (run 32172467043), non stimato: serve a
 * rendere verificabile la claim «togliamo ~200s dal cammino bloccante» e a
 * rendere evidente, alla prossima rilettura, se una voce non vale più il
 * meccanismo.
 *
 * `watch` = radici DATI lette dal filesystem, path POSIX relativi alla root.
 * Un valore che finisce con `/` è un prefisso di directory, altrimenti è un
 * file esatto. Il codice importato NON va qui: lo deriva `blockingTestsFor`.
 *
 * ─── MAI un path che passa da un SYMLINK ──────────────────────────────────
 *
 * `services/locales/blog-body` e `blog-body-ch` sono symlink (git li traccia
 * come UN file, mode 120000) dentro `packages/articles/content/`. Un `watch`
 * che li nomina non matcha MAI un diff vero: `git diff --name-only` e l'API
 * della PR riportano il path reale, `packages/articles/content/blog-body…`,
 * mai l'alias. Una prima stesura di questo registro aveva esattamente quel
 * difetto su `blog-body-typescript-syntax.test.ts` — il gate nato per
 * l'apostrofo non escapato del 2026-07-29 non poteva restare bloccante sulla
 * PR che porta quell'apostrofo, e degradava a solo-post-merge in silenzio.
 * Sembrava coperto e non lo era, che è la forma di guasto peggiore.
 *
 * Ora è impossibile per costruzione: `tests/corpus-wide-test-partition.test.ts`
 * fallisce se un `watch` è un symlink. Il path da scrivere qui è quello reale.
 */
const REGISTRY = [
  {
    file: "tests/article-hero-image-integrity.test.ts",
    seconds: 53.9,
    // Rende davvero le pagine della sezione `svizzera` con `renderArticlePages`
    // e verifica src/width/height delle hero contro i file immagine reali.
    watch: ["packages/articles/content/", "public/images/blog/"],
  },
  {
    file: "tests/generated-content-parses.test.ts",
    seconds: 53.2,
    // `transformSync` di esbuild su ogni modulo generato dei due corpora.
    watch: ["packages/articles/content/", "services/locales/"],
  },
  {
    file: "tests/render-article-pages-single-vs-full.test.ts",
    seconds: 24.7,
    // Byte-equivalenza fra render narrow (fast-publish) e render pieno.
    watch: ["packages/articles/content/"],
  },
  {
    file: "tests/render-article-hub-pages-narrow-vs-full.test.ts",
    seconds: 20.1,
    watch: ["packages/articles/content/", "services/locales/"],
  },
  {
    file: "tests/articles-archive-chronological.test.ts",
    seconds: 17.3,
    // Ordine cronologico dell'archivio: legge i registri e rende gli hub.
    watch: ["packages/articles/content/", "services/locales/"],
  },
  {
    file: "tests/blog-body-typescript-syntax.test.ts",
    seconds: 15.5,
    // esbuild su ENTRAMBI i corpora body (l'apostrofo non escapato del
    // 2026-07-29 passò perché il guard ne copriva uno solo).
    watch: [
      "packages/articles/content/blog-body/",
      "packages/articles/content/blog-body-ch/",
    ],
  },
];

/** Path POSIX relativi alla root dei test corpus-wide, ordinati. */
export function listCorpusWideTests() {
  return REGISTRY.map((e) => e.file).sort();
}

/**
 * Tutti i file di test della suite. NON è un terzo elenco da tenere in sync:
 * è l'unione della partizione dataset, che `tests/dataset-test-partition.test.ts`
 * dimostra già essere disgiunta e completa. Riusarla qui significa che un test
 * nuovo entra nel complemento senza che nessuno tocchi niente.
 */
function listAllTests() {
  return [
    ...listDatasetDependentTests(),
    ...listDatasetIndependentTests(),
  ].sort();
}

/**
 * Il complemento del registro: tutto ciò che NON è corpus-wide. È ciò che
 * `VITEST_CORPUS_GROUP=only` esclude per lasciar girare i soli gate corpus.
 */
export function listNonCorpusWideTests() {
  const corpus = new Set(listCorpusWideTests());
  return listAllTests().filter((f) => !corpus.has(f));
}

/** Il registro completo (file + secondi misurati + radici dati). */
export function corpusWideRegistry() {
  return REGISTRY.map((e) => ({ ...e, watch: [...e.watch] }));
}

/** Somma dei secondi misurati: la cifra che lo split toglie dal cammino. */
export function corpusWideSeconds() {
  return Number(REGISTRY.reduce((a, e) => a + e.seconds, 0).toFixed(1));
}

const toPosixRel = (abs) => path.relative(ROOT, abs).split(path.sep).join("/");

/**
 * Chiusura degli import locali di un test, come insieme di path POSIX relativi.
 * Riusa il resolver di `dataset-dependent-tests.mjs` invece di riscriverlo:
 * due copie della stessa regola di risoluzione divergerebbero, e la divergenza
 * si presenterebbe come un gate che non scatta (AGENTS.md #6).
 */
function importClosure(relFile) {
  const start = path.join(ROOT, relFile);
  const seen = new Set();
  const stack = [start];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of localImports(cur)) stack.push(next);
  }
  seen.delete(start);
  return new Set([...seen].map(toPosixRel));
}

const closureCache = new Map();
function cachedClosure(relFile) {
  if (!closureCache.has(relFile))
    closureCache.set(relFile, importClosure(relFile));
  return closureCache.get(relFile);
}

function matchesWatch(changedPath, watch) {
  return watch.some((w) =>
    w.endsWith("/") ? changedPath.startsWith(w) : changedPath === w,
  );
}

/**
 * Dato l'elenco dei path toccati da una PR, i test corpus-wide che DEVONO
 * restare bloccanti su quella PR.
 *
 * Due ragioni, entrambe sufficienti:
 *   1. il diff tocca una radice dati che il test scandisce → il corpus misurato
 *      su main non è più quello della PR;
 *   2. il diff tocca un file nella chiusura degli import del test → il RENDERER
 *      è cambiato, e il gate esiste proprio per quello.
 *
 * Il test stesso è nella lista se il diff lo modifica: chi cambia un gate deve
 * vederlo girare prima del merge, non dopo.
 */
export function blockingTestsFor(changedPaths) {
  const changed = [
    ...new Set(changedPaths.map((p) => p.trim()).filter(Boolean)),
  ];
  if (changed.length === 0) return [];
  const out = [];
  for (const entry of REGISTRY) {
    const closure = cachedClosure(entry.file);
    const hit = changed.some(
      (p) => p === entry.file || matchesWatch(p, entry.watch) || closure.has(p),
    );
    if (hit) out.push(entry.file);
  }
  return out.sort();
}

/**
 * I test corpus-wide che NON devono girare nel job bloccante, dato il diff.
 * È il complemento esatto di `blockingTestsFor` sul registro: nessun file può
 * cadere fuori da entrambi (verificato in tests/corpus-wide-test-partition).
 */
export function skippableTestsFor(changedPaths) {
  const blocking = new Set(blockingTestsFor(changedPaths));
  return listCorpusWideTests().filter((f) => !blocking.has(f));
}

/**
 * Interpreta il valore di `VITEST_CORPUS_SKIP` (lista separata da spazi o
 * newline) filtrandolo CONTRO IL REGISTRO.
 *
 * Il filtro non è pedanteria: senza, quella env sarebbe una leva generica per
 * spegnere QUALUNQUE test dalla riga di comando di un workflow — cioè
 * esattamente il modo in cui un gate scomodo finisce disattivato «per un giro»
 * e non torna più (Non-Negotiable #1). Filtrata sul registro, può solo
 * ricollocare i 7 file che questo file dichiara e motiva.
 */
export function parseCorpusSkipList(raw) {
  const allowed = new Set(listCorpusWideTests());
  return [
    ...new Set(
      String(raw ?? "")
        .split(/[\s,]+/)
        .filter(Boolean),
    ),
  ]
    .filter((f) => allowed.has(f))
    .sort();
}

function readChangedPathsFromStdin() {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf-8");
  } catch {
    raw = "";
  }
  return raw.split("\n");
}

// ─── CLI ──────────────────────────────────────────────────────────────────
// `--list`           i file del registro, uno per riga
// `--seconds`        i secondi misurati totali
// `--blocking`       legge i path cambiati da stdin, stampa i test che restano
//                    bloccanti (uno per riga; vuoto = nessuno)
// `--gha-output`     come sopra ma in forma `key=value` per $GITHUB_OUTPUT
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const argv = process.argv.slice(2);
  if (argv.includes("--seconds")) {
    console.log(String(corpusWideSeconds()));
  } else if (argv.includes("--blocking") || argv.includes("--gha-output")) {
    const changed = readChangedPathsFromStdin();
    const blocking = blockingTestsFor(changed);
    if (argv.includes("--gha-output")) {
      // `skip` = i corpus-wide che questo diff NON rende pertinenti, quindi
      // esclusi dal job bloccante. `blocking` = quelli che restano gate della
      // PR, identici a oggi. La decisione è per-test: un diff su
      // `data/jobs/by-crawler/**` — il caso più frequente del repo, i crawler
      // committano decine di volte al giorno — tiene bloccante il solo
      // `job-locale-consistency` (16,7s) e ricolloca gli altri 184,7s.
      //
      // Se questo script fallisce, lo step chiamante lascia `skip` VUOTO e la
      // suite gira intera: un errore qui non può mai tradursi in gate saltato.
      console.log(`skip=${skippableTestsFor(changed).join(" ")}`);
      console.log(`blocking=${blocking.join(" ")}`);
    } else {
      console.log(blocking.join("\n"));
    }
  } else {
    console.log(listCorpusWideTests().join("\n"));
  }
}
