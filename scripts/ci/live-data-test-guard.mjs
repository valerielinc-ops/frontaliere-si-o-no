/**
 * Guard: un test del job bloccante non puo' leggere DATI VIVI.
 *
 * Il difetto che chiude, misurato il 2026-08-21. La stessa identica revisione
 * di `tests/pre-flight-headline-check.test.ts` era verde alle 15:47 e rossa
 * alle 18:38. Nel mezzo non era cambiata una riga di codice: la pipeline aveva
 * pubblicato un articolo il cui titolo collideva con una delle headline
 * «unrelated» hardcoded nel test, che leggeva `services/locales/blog-meta-it.ts`
 * — il registro VIVO, 3'457 titoli che crescono ogni giorno.
 *
 * Il costo non e' stato quel test: `vitest` e' il gate su cui `pr-review-loop`
 * si innesca, quindi il rosso ha fermato CINQUE PR non correlate insieme. Una
 * CI che legge dati vivi non e' una CI: non e' riproducibile, e il suo verde
 * non e' un'affermazione sul codice.
 *
 * Il file portava gia' la cicatrice di un giro precedente dello stesso problema
 * («Cathedral 2026-05-10: a new article about the exact Fornasette incident was
 * published... Replaced with a genuinely unrelated headline»): rattoppato
 * spostando la headline, cioe' il sintomo. Sarebbe tornato, e infatti e' tornato.
 *
 * Perche' un INVENTARIO e non un divieto secco. Alla scansione risultano 29
 * file che leggono radici dati vive ancorate alla root. Non sono tutti difetti:
 * per alcuni il corpus E' il soggetto del test (`i18n-completeness`,
 * `corpus-retention-discipline`), e li' un rosso da dato e' esattamente il
 * segnale voluto. Convertirli in blocco sarebbe un refactor da 29 file dentro
 * una PR che parla d'altro. Quindi la lista qui sotto congela lo stato di fatto
 * e il guard impedisce che CRESCA: nessun test nuovo puo' aggiungersi senza che
 * qualcuno lo scriva a mano qui e spieghi perche'.
 *
 * Come uscire dalla lista, non come entrarci: si pinna il dato in
 * `tests/__fixtures__/` e si cancella la riga. E' quello che ha fatto
 * `pre-flight-headline-check`, che infatti non c'e' piu'.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listCorpusWideTests } from './corpus-wide-tests.mjs';
import {
  listDatasetDependentTests,
  listDatasetIndependentTests,
} from './dataset-dependent-tests.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Radici che la pipeline riscrive da sola: corpus articoli e output dei crawler.
 * Non ci sono le baseline (`data/*-baseline.json`), che cambiano solo quando
 * qualcuno decide di cambiarle — quello e' un dato pinnato, non un dato vivo.
 */
export const LIVE_DATA_ROOTS = Object.freeze([
  'services/locales/',
  'packages/articles/content/',
  'data/jobs.json',
  'data/jobs/',
  'data/jobs-crawler-summaries/',
  'data/prospector/',
  // ─── Radici aggiunte il 2026-09-19, MISURATE, non elencate a intuito.
  //
  // Le prime sei coprivano corpus e crawler, cioe' i due difetti gia' visti.
  // Ma «dato vivo» non e' una categoria di percorso, e' un fatto sull'autore:
  // un file e' vivo se un workflow lo riscrive da solo su `main`. Quel fatto si
  // legge dalla storia, e la misura e' questa (30 giorni, commit diretti dei
  // bot, cioe' senza `(#NNNN)` in testa al messaggio):
  //
  //   git log origin/main --since=30.days --format='@@%an|%s' --name-only \
  //     | awk '/^@@/{bot=($0 ~ /bot|GitHub Actions/) && ($0 !~ /\(#[0-9]+\)$/); next} NF && bot'
  //
  // 2.478 file distinti, tutti sotto le radici qui sotto. Le baseline
  // (`data/*-baseline.json`) restano fuori per la ragione di sempre: cambiano
  // solo quando qualcuno decide di cambiarle.
  'data/all-known-job-slugs/',
  'data/article-embeddings',
  'data/article-performance.json',
  'data/border-wait',
  'data/employer-profiles.json',
  'data/events.json',
  'data/events/',
  'data/exchange-rate-snapshot.json',
  'data/fuel-prices',
  'data/gsc-orphan-queries',
  'data/health-premiums/',
  'data/job-popularity',
  'data/orphan-enriched-data/',
  'data/pharmac',
  'data/search-cluster-301-map.json',
  'data/seo-404-compat/',
  'data/slug-registry.json',
  'data/translation-cache/',
  'data/weather-snapshot.json',
  'public/data/',
  'public/news-ticker-live.json',
]);

/**
 * Le stesse radici, scritte a SEGMENTI.
 *
 * Un path costruito pezzo per pezzo — `resolve(ROOT, 'packages', 'articles')` —
 * non contiene da nessuna parte il letterale `packages/articles/`, quindi la
 * ricerca testuale non lo vede. Esiste gia' nel repo
 * (`tests/news-ticker-data.test.ts`), gira nel job bloccante, e si ancora al
 * corpus vivo: esattamente il caso che il guard esiste per prendere, e che alla
 * prima stesura non prendeva.
 *
 * E' il gemello speculare del difetto dei commenti: li' c'era testo che non era
 * lettura, qui lettura che non e' testo. Senza questo, il guard e' aggirabile
 * per caso — basta scrivere il percorso in due pezzi.
 *
 * Prefissi, non percorsi completi: il test sopra si ferma a `packages/articles`
 * e passa quella radice a una funzione che ci appende `content/`. Un guard che
 * pretendesse la sequenza intera lo mancherebbe di nuovo.
 */
export const LIVE_DATA_SEGMENTS = Object.freeze([
  ['services', 'locales'],
  ['packages', 'articles'],
  ['data', 'jobs'],
  ['data', 'jobs-crawler-summaries'],
  ['data', 'prospector'],
]);

/**
 * Cerca una sequenza di segmenti quotati adiacenti, con la virgola in mezzo:
 * `'packages', 'articles'` in qualunque forma di quote e con spazi liberi.
 *
 * @param {string[]} segments
 * @returns {RegExp}
 */
export function segmentSequenceRegex(segments) {
  const quoted = (seg) => `['\`"]${seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['\`"]`;
  return new RegExp(segments.map(quoted).join('\\s*,\\s*'));
}

/**
 * Un percorso letterale conta solo se il test lo risolve contro la ROOT del
 * repo. Moltissimi test costruiscono `data/jobs/by-crawler/a.json` DENTRO una
 * cartella temporanea: stesso letterale, dato non vivo, e segnalarli
 * renderebbe il guard rumoroso al punto da farlo ignorare.
 */
const ROOT_ANCHOR_RE = /(resolve|join)\s*\(\s*(ROOT|__dirname\s*,\s*['`]\.\.)/;

/**
 * Toglie commenti e stringhe di documentazione prima di cercare i letterali.
 *
 * Senza questo il guard si autoaccusa: il commento che SPIEGA il difetto cita
 * `services/locales/blog-meta-it.ts` fra backtick, e un match testuale lo legge
 * come una lettura di dato vivo. Misurato — il primo giro segnalava proprio il
 * test appena riparato.
 *
 * @param {string} src
 * @returns {string}
 */
export function stripComments(src = '') {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/**
 * Inventario congelato: test che leggono dati vivi e che erano gia' cosi'
 * quando il guard e' nato. Non e' un'assoluzione, e' un registro del debito.
 */
export const KNOWN_LIVE_DATA_TESTS = Object.freeze([
  { file: 'tests/article-body-wordcount.test.ts', roots: ['services/locales/'] },
  { file: 'tests/article-fabrication-guard.test.ts', roots: ['services/locales/'] },
  { file: 'tests/article-frontaliere-density.test.ts', roots: ['services/locales/'] },
  // Misura il peso del writer usando il record Lugano dello snapshot pubblicato
  // e verifica che il parser conservi i campi aggiunti dal giro meteo. Il dato
  // vivo e` quindi parte intenzionale dell'asserzione: il test va nel monitor,
  // non nel gate riproducibile delle PR.
  { file: 'tests/weather-canton-capitals.test.ts', roots: ['data/weather-snapshot.json'], since: '2026-10-05', evidence: 'review', runtime: true },
  // `runtime`: il percorso vivo e' costruito su `rootDir`, un alias della root
  // del checkout, e il file crea anche cartelle temporanee: a solo testo ha la
  // forma di una fixture. Traccia del 2026-10-03: sonda
  // `services/locales/blog-meta-it.ts` e `blog-meta-ch-it.ts` e sul corpus
  // esegue i casi che senza corpus salta.
  { file: 'tests/article-hub-topics-nav.test.ts', roots: ['services/locales/'], runtime: true },
  // Reaches the live article corpus transitively through create-article.mjs.
  // The source scanner intentionally does not execute imported modules while
  // building the inventory, so this dependency stays explicit.
  { file: 'tests/evergreen-pool-consumption.test.ts', roots: ['packages/articles/content/'], transitive: true },
  { file: 'tests/corpus-wide-test-partition.test.ts', roots: ['data/jobs/', 'packages/articles/content/'] },
  // Corpus genuinely the subject: this negative production invariant verifies
  // that the three poisoned learned specs retired by #7001 stay absent from
  // the live prospector registry. A fixture would not catch their resurrection.
  { file: 'tests/albergo-gardenia-live-regression.test.ts', roots: ['data/prospector/'] },
  // Corpus genuinely the subject: the retirement observer verifies the live
  // active/summary/prospector owners stay absent and every historical route
  // remains in the checked-in expired archive.
  {
    file: 'tests/de-crawler-retirement.test.ts',
    roots: ['data/jobs-crawler-summaries/', 'data/jobs/', 'data/prospector/'],
  },
  // Corpus genuinely the subject: #6784 is a ratchet over the six repaired
  // production slices. New cross-job ownership or empty-bucket regrowth is the
  // data event this test is intentionally meant to surface.
  { file: 'tests/decontaminate-prev-slugs-live-regression.test.ts', roots: ['data/jobs/'] },
  { file: 'tests/edge-retired-paths.test.ts', roots: ['packages/articles/content/'] },
  { file: 'tests/google-news-compliance.test.ts', roots: ['services/locales/'] },
  // Reads the assembled live jobs corpus; its rate changes with crawler
  // output, so it is not a deterministic PR gate.
  { file: 'tests/job-locale-consistency.test.ts', roots: ['data/jobs/'], transitive: true },
  { file: 'tests/news-ticker-data.test.ts', roots: ['packages/articles/'] },
  { file: 'tests/packages-articles-confinement.test.ts', roots: ['packages/articles/'] },
  // Corpus genuinely the subject: the rejection CLI guard asserts that its
  // terminal transition never mutates the committed candidate registry.
  { file: 'tests/prospector-reject.test.ts', roots: ['data/prospector/'] },
  // Corpus genuinely the subject: the turnover-safe #7045 observer compares
  // the live iPersonal active and expired slices so every known route keeps one
  // recoverable owner as jobs move between lifecycle states.
  { file: 'tests/ipersonal-route-recovery-7045-live.test.ts', roots: ['data/jobs/'] },
  { file: 'tests/sitemap-slug-integrity.test.ts', roots: ['data/jobs.json'] },
  // La radice dichiarata era `services/locales/`, ma i quattro chunk
  // `*-weekly-employers.ts` che il file nomina sono codice. Il dato vivo arriva
  // da un import: `build-plugins/shared/companyHubFrontalierContext.ts` carica
  // `public/data/fuel-prices.json` (traccia del 2026-10-03: senza quel file il
  // modulo non si importa nemmeno).
  { file: 'tests/weekly-employers.test.ts', roots: ['public/data/'], transitive: true },

  // ══════════════════════════════════════════════════════════════════════
  // CENSIMENTO 2026-09-19 — misurato, non dedotto.
  //
  // L'inventario sopra era stato compilato con uno scanner TESTUALE su sei
  // radici. Due limiti, entrambi misurati: lo scanner leggeva solo
  // `tests/*.test.ts` (non le sottocartelle `tests/seo/`, `tests/scripts/`,
  // `tests/build-plugins/`) e vedeva solo i percorsi scritti nel file di test —
  // non la lettura che avviene dentro un modulo importato o in un processo
  // figlio.
  //
  // Questo blocco nasce da due misure indipendenti sull'intera suite (2.409
  // file):
  //   1) TRACCIA A RUNTIME: hook su `fs` (sync, promises), sui moduli caricati
  //      e sui processi figli, per attribuire a ogni file di test i file del
  //      checkout che legge davvero. 242 file di test toccano almeno un dato
  //      vivo.
  //   2) REPLAY: stessa revisione di codice, dati vivi riportati a 7, 14 e 30
  //      giorni prima. 26 file CAMBIANO ESITO senza che una riga di codice
  //      cambi — è la prova diretta, non un indizio.
  // `evidence: "replay"` marca quei 26. `evidence: "review"` marca i file in
  // cui la lettura viva è stata letta e giudicata parte dell'asserzione.
  // I falsi positivi della traccia (dataset CURATI a mano — `municipalities`,
  // `fiscal-municipalities`, `profession-salary-medians`, il registro dei
  // valichi) restano nel gate: nessun bot li riscrive.
  // ══════════════════════════════════════════════════════════════════════
  { file: "tests/apleona-schweiz-ag-crawler.test.ts", roots: ["data/prospector/"], since: "2026-09-19", evidence: "replay", runtime: true },
  { file: "tests/article-author-source-parity.test.ts", roots: ["packages/articles/content/"], since: "2026-09-19", evidence: "review", runtime: true },
  // The organization-entity regression also inspects generated static blog
  // SEO modules. Its corpus reads are intentional, but the runtime/source
  // inventory must keep it out of the blocking PR partition.
  { file: "tests/organization-entity-consolidation.test.ts", roots: ["packages/articles/content/"], since: "2026-10-01", evidence: "review", runtime: true },
  { file: "tests/article-hero-image-integrity.test.ts", roots: ["packages/articles/content/"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/articles-archive-chronological.test.ts", roots: ["data/all-known-job-slugs/", "data/jobs-snapshots-history/"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/blog-slugs-sitemap-sync.test.ts", roots: ["packages/articles/content/"], since: "2026-09-19", evidence: "replay", runtime: true },
  { file: "tests/blog/assistente-ai-frontalieri.test.ts", roots: ["packages/articles/content/"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/build-article-embeddings-meta-carryforward.test.ts", roots: ["data/article-embeddings-meta.json"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/build-plugins/borderWaitComparison.test.ts", roots: ["data/border-wait-averages.json"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/build-plugins/companyHubFrontalierContext.test.ts", roots: ["public/data/"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/build-plugins/pharmacyDirectoryPagesPlugin.test.ts", roots: ["data/pharmacies-italy-border.json", "data/pharmacies-ticino-complete.json", "data/pharmacy-duties-italy-status.json", "data/pharmacy-duties-italy.json", "data/pharmacy-duties-ticino.json"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/build-plugins/seoHubsPlugin-hub-locale-reciprocity.test.ts", roots: ["data/all-known-job-slugs/", "data/jobs-snapshots-history/"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/canton-empty-canton-guard.test.ts", roots: ["data/jobs.json"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/canton-ti-misclassification-guard.test.ts", roots: ["data/jobs.json"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/crawler-authoritative-empty-zero.test.ts", roots: ["data/prospector/"], since: "2026-09-19", evidence: "replay", runtime: true },
  { file: "tests/diesel-pages-seo.test.ts", roots: ["packages/articles/content/"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/ete-crawler.test.ts", roots: ["data/prospector/"], since: "2026-09-19", evidence: "replay", runtime: true },
  { file: "tests/extract-articles-package.test.ts", roots: ["packages/articles/content/"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/frontaliere-article-canonical-overrides.test.ts", roots: ["packages/articles/content/"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/generated-content-parses.test.ts", roots: ["packages/articles/content/"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/healthInsurance.test.ts", roots: ["data/health-premiums/"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/information-gain-families-floor.test.ts", roots: ["data/border-wait-averages.json", "data/health-premiums/", "public/data/"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/ipersonal-source-locale-brand-slug.test.ts", roots: ["data/jobs/"], since: "2026-09-19", evidence: "replay", runtime: true },
  { file: "tests/job-locale-completeness.test.ts", roots: ["data/jobs.json"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/job-popularity-incremental.test.ts", roots: ["data/job-popularity.meta.json"], since: "2026-09-19", evidence: "replay", runtime: true },
  { file: "tests/naturalizzazione-san-gallo-de-content.test.ts", roots: ["packages/articles/content/"], since: "2026-09-19", evidence: "replay", runtime: true },
  { file: "tests/pharmacies-border-dataset.test.ts", roots: ["data/pharmacies-italy-border.json", "data/pharmacies-ticino-complete.json", "data/pharmacy-duties-ticino-status.json", "data/pharmacy-duties-ticino.json"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/pharmacy-directory-pages.test.ts", roots: ["data/pharmacies-italy-border.json", "data/pharmacies-ticino-complete.json", "data/pharmacy-duties-italy-status.json", "data/pharmacy-duties-italy.json", "data/pharmacy-duties-ticino.json"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/pharmacy-italy-import.test.ts", roots: ["data/pharmacies-italy-border.json"], since: "2026-09-19", evidence: "replay", runtime: true },
  { file: "tests/pharmacy-italy-release.test.ts", roots: ["data/pharmacies-italy-border.json", "data/pharmacy-duties-italy-status.json", "data/pharmacy-duties-italy.json"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/pharmacy-locarnese-parser.test.ts", roots: ["data/pharmacies-ticino-complete.json"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/prospector-location-contract.test.ts", roots: ["data/prospector/"], since: "2026-09-19", evidence: "replay", runtime: true },
  { file: "tests/recruitingapp-1123-crawler.test.ts", roots: ["data/prospector/"], since: "2026-09-19", evidence: "replay", runtime: true },
  { file: "tests/recruitingapp-2649-crawler.test.ts", roots: ["data/prospector/"], since: "2026-09-19", evidence: "replay", runtime: true },
  { file: "tests/recruitingapp-2677-crawler.test.ts", roots: ["data/prospector/"], since: "2026-09-19", evidence: "replay", runtime: true },
  { file: "tests/related-articles.test.ts", roots: ["packages/articles/content/"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/render-article-hub-pages-narrow-vs-full.test.ts", roots: ["data/all-known-job-slugs/", "data/jobs-snapshots-history/"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/render-article-pages-single-vs-full.test.ts", roots: ["packages/articles/content/"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/scripts/lib/scoring/embeddingStoreBinary.test.ts", roots: ["data/article-embeddings-meta.json", "data/article-embeddings.bin"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/scripts/publish-article-chunks.test.ts", roots: ["packages/articles/content/"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/search-console-compat.test.ts", roots: ["data/employer-profiles.json", "data/search-cluster-301-map.json"], since: "2026-09-19", evidence: "replay", runtime: true },
  { file: "tests/seo-completeness.test.ts", roots: ["data/exchange-rate-snapshot.json", "packages/articles/content/"], since: "2026-09-19", evidence: "replay", runtime: true },
  { file: "tests/seo-description-length.test.ts", roots: ["data/exchange-rate-snapshot.json", "packages/articles/content/"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/seo/cathedral-expired-tracking-canton.test.ts", roots: ["data/all-known-job-slugs/", "data/jobs.json"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/seo/cathedral-slug-registry-canton-backfill.test.ts", roots: ["data/slug-registry.json"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/seo/rate-baseline-internal-consistency.test.ts", roots: ["data/active-jobs-baseline.json"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/sitemap-hreflang-reciprocity.test.ts", roots: ["public/sitemap-guides.xml"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/sitemap-retired-paths-absent.test.ts", roots: ["public/sitemap-guides.xml"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/tassi-interesse-svizzera-bassi-de.test.ts", roots: ["packages/articles/content/"], since: "2026-09-19", evidence: "replay", runtime: true },
  { file: "tests/ti-market-snapshot-sector-canton-scope.test.ts", roots: ["data/jobs.json"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/ti-sector-hub-canton-scope.test.ts", roots: ["data/jobs.json"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/ti-weekly-employers-canton-scope.test.ts", roots: ["data/border-wait-averages.json", "data/jobs.json", "public/data/"], since: "2026-09-19", evidence: "review", runtime: true },
  // ─── Replay del 2026-09-30. Scandisce tutto il corpus degli articoli per
  // verificare le cifre della simulazione fiscale contro il calcolatore: il
  // corpus lo riscrive la sincronizzazione automatica (commit «Sync article …»
  // senza (#N)), e la PR #10308 del 29-09 ha dovuto ripristinare quelle cifre.
  // Stessa natura di irpef-brackets-2026 sopra: il corpus è il soggetto.
  { file: "tests/article-tax-content-guard.test.ts", roots: ["packages/articles/content/", "services/locales/"], since: "2026-09-30", evidence: "replay", runtime: true },
]);

/**
 * Scanner false positives that must remain in the blocking PR suite.
 *
 * These tests resolve other repository inputs against ROOT and also contain a
 * live-root-looking path as synthetic workflow/receipt text or underneath a
 * temporary repository. They do not read those paths from this checkout, so
 * classifying them as live-data tests would silently remove useful code gates.
 */
export const LIVE_DATA_SCAN_EXEMPTIONS = Object.freeze([
  // ─── 2026-09-19: falsi positivi emersi quando la scansione e' diventata
  // ricorsiva. Ognuno nomina una radice viva nel sorgente, e la traccia a
  // runtime dell'intera suite (hook su fs + moduli + processi figli) non ha
  // registrato NESSUNA lettura viva mentre giravano: il letterale e' un path
  // costruito sotto `os.tmpdir()`, una stringa attesa in un'asserzione o un
  // argomento passato a una funzione pura.
  {
    file: 'tests/tests-push-main-data-filter.test.ts',
    roots: ['data/pharmac', 'data/slug-registry.json'],
    reason: 'i nomi dei dataset sono i valori ATTESI del rilevatore che il test verifica (`expect(read).toContain(...)`); le uniche letture da disco sono i .yml di .github/workflows',
  },
  {
    file: 'tests/data-refresh-pr-wiring.test.ts',
    roots: ['packages/articles/content/'],
    reason: 'il test legge solo i workflow sotto .github/workflows/; packages/articles/content/** è il pattern YAML verificato e l’unico subprocess usa fixture sotto tests/__fixtures__/, non il corpus del checkout',
  },
  {
    file: 'tests/check-border-data-health.test.ts',
    roots: ['data/border-wait-averages.json'],
    reason: 'le medie vive entrano da data/borderCrossings.ts e sovrascrivono solo avgWaitMorning/avgWaitEvening, che nessun test asserisce: i casi guardano webcam e minBytes, campi curati a mano',
    // La lettura non e' nel testo del file (arriva da un import), quindi lo
    // scanner testuale non la vede e senza questo la voce risulterebbe morta.
    runtime: true,
  },
  ...[
    'tests/build-plugins/articleSectionCore.test.ts',
    'tests/calculator/salary-alert-capture.test.ts',
    'tests/job-popularity-lazy.test.ts',
    'tests/resolve-output-path.test.ts',
    'tests/scripts/assemble-jobs-cache-key-coverage.test.ts',
    'tests/scripts/assemble-jobs-cache.test.ts',
    'tests/scripts/check-orphan-article-meta.test.ts',
    'tests/scripts/create-article-prompt-leak-slug.test.ts',
    'tests/seo/blog-pagination-bfs.test.ts',
    'tests/seo/discover-robots-directive.test.ts',
    'tests/workflows/git-add-symlinked-corpus.test.ts',
  ].map((file) => ({
    file,
    roots: [],
    reason: 'nessuna lettura viva misurata a runtime (traccia fs + moduli + processi figli, suite intera, 2026-09-19)',
  })),
  // ─── 2026-10-03: usciti dall'inventario, tornano nel gate delle PR.
  //
  // Stavano in KNOWN_LIVE_DATA_TESTS dal 2026-08-21 perche' lo scanner testuale
  // li segnala, e nessuno di loro legge un dato vivo. Il costo l'ha mostrato
  // `live-data-gates.yml`: rosso per giorni su difetti di CODICE che il merge
  // non aveva fermato, perche' questi file non giravano sulle PR (issue #9453).
  //
  // Prova, per ognuno: traccia a runtime (hook su `fs` sync e promises
  // precaricato con `--require` nel processo vitest, nei worker e nei processi
  // figli) in un worktree sparse dove `data/jobs/`, `data/jobs.json`,
  // `data/prospector/`, `public/data/` e `packages/articles/content/` NON sono
  // sul disco. Tutti verdi, zero accessi (nemmeno `existsSync`) a una radice
  // viva: un test che passa senza il dato e non lo cerca non puo' dipenderne.
  ...[
    ['tests/articles-sync-pin.test.ts', ['packages/articles/content/'], 'packages/articles/content e` creato dentro due cartelle mkdtemp (il finto mirror e il finto checkout del sito); dal checkout si leggono i due script di pull e il workflow sync-articles-sitemaps.yml'],
    ['tests/dist-hash-manifest-deploy-perimeter.test.ts', ['data/jobs.json'], 'data/jobs.json e` un file sintetico scritto in una cartella mkdtemp e un nome atteso nel perimetro; nessuna lettura dal checkout'],
    ['tests/git-commit-data-append-only-sets.test.ts', ['data/jobs/', 'data/seo-404-compat/'], 'ogni slice vive in repository git creati sotto os.tmpdir(); dal checkout si legge solo lo script sotto test'],
    ['tests/git-commit-data-grouped-isolation.test.ts', ['data/jobs/'], 'ogni slice vive in repository git creati sotto os.tmpdir(); dal checkout si legge solo lo script sotto test'],
    ['tests/git-commit-data-skip-identical.test.ts', ['data/jobs/'], 'ogni slice vive in repository git creati sotto os.tmpdir(); dal checkout si legge solo lo script sotto test'],
    ['tests/git-commit-data-slice-scoping.test.ts', ['data/jobs-crawler-summaries/', 'data/jobs/'], 'ogni slice vive in repository git creati sotto os.tmpdir(); dal checkout si legge solo lo script sotto test'],
    ['tests/job-locale-mark-persistence.test.ts', ['data/jobs/'], 'la variabile root e` una cartella temporanea: le slice by-crawler sono fixture scritte dal test stesso'],
    ['tests/slug-active-loss-regression-5229.test.ts', ['data/jobs/'], 'data/jobs/by-crawler/banca-cler.json e` il path relativo di una slice scritta in un repository temporaneo'],
    // Sorgenti del package, non corpus: `packages/articles/engine/` cambia solo
    // con una PR. Lo scanner generalizza la sequenza `'packages','articles'` alla
    // radice `packages/articles/`, che copre anche questo sottoalbero.
    ['tests/article-hub-archive-assets.test.ts', ['packages/articles/'], 'legge il sorgente packages/articles/engine/articleHubPagesPlugin.ts, codice del package e non corpus'],
    ['tests/build-emit-skip-gate.test.ts', ['packages/articles/'], 'legge il sorgente packages/articles/engine/ogPagesPlugin.ts, codice del package e non corpus'],
    // Chunk di interfaccia `services/locales/{it,en,de,fr}-<chunk>.ts`: sono
    // sotto la radice `services/locales/` ma non sono dato vivo. Misura del
    // 2026-10-03 sulla storia di `origin/main`, 120 giorni: zero commit diretti
    // di un bot su quei file (l'unico commit senza PR e' umano, del 2026-07-01);
    // a essere riscritti da soli sono `blog-meta-*` e `blog-body*`, symlink
    // verso `packages/articles/content/`. Una chiave mancante in un chunk e' un
    // difetto della PR che la introduce, ed e' li' che va fermata.
    ['tests/company-alert.test.ts', ['services/locales/'], 'legge i quattro chunk {locale}-core.ts (traccia: 4 letture, tutte chunk di interfaccia), mai blog-meta o blog-body'],
    ['tests/irpef-brackets-2026.test.ts', ['services/locales/'], 'legge i chunk {locale}-core.ts e {locale}-stats.ts (traccia: 8 letture, tutte chunk di interfaccia), mai blog-meta o blog-body'],
    ['tests/jobgate-experiment.test.ts', ['services/locales/'], 'legge i quattro chunk {locale}-core.ts (traccia: 4 letture, tutte chunk di interfaccia), mai blog-meta o blog-body'],
    ['tests/newsletter-title-neutrality.test.ts', ['services/locales/'], 'legge i quattro chunk {locale}-core.ts (traccia: 4 letture, tutte chunk di interfaccia), mai blog-meta o blog-body'],
    ['tests/signup-prompt-funnel.test.ts', ['services/locales/'], 'legge i quattro chunk {locale}-core.ts (traccia: 4 letture, tutte chunk di interfaccia), mai blog-meta o blog-body'],
  ].map(([file, roots, reason]) => ({ file, roots, reason, since: '2026-10-03', evidence: 'trace' })),
  {
    file: 'tests/ci-vitest-check-name.test.ts',
    roots: ['data/jobs/'],
    reason: 'the path is a synthetic assemble-input argument to a pure predicate; the test reads CI/workflow source files only and opens nothing under data/jobs/',
  },
  {
    file: 'tests/crawler-generation-barrier-workflows.test.ts',
    roots: ['data/jobs-crawler-summaries/', 'data/jobs/'],
    reason: 'job slice paths are synthetic receipt payload fields; filesystem reads target workflow SSOT files',
  },
  {
    file: 'tests/crawler-generation-receipt.test.ts',
    roots: ['data/jobs/'],
    reason: 'every job slice is created inside a mkdtemp git fixture, never read from the checkout',
  },
  {
    file: 'tests/crawler-generation-token-fallback.test.ts',
    roots: ['data/jobs/'],
    reason: 'data/jobs paths are created inside a mkdtemp git fixture; only the source module is read from the checkout',
  },
  {
    file: 'tests/git-commit-data-retry-reuse.test.ts',
    roots: ['data/jobs/'],
    reason: 'all data/jobs paths belong to temporary bare repositories created under os.tmpdir(); the checkout read is limited to the script under test',
  },
  {
    file: 'tests/git-commit-data-skip-identical.test.ts',
    roots: ['data/jobs/'],
    reason: 'every data/jobs/by-crawler slice is written and committed inside bare and cloned repositories created with mkdtemp under os.tmpdir(); the checkout read is limited to the script under test (PR 11758)',
  },
  {
    file: 'tests/git-commit-data-legacy-staging.test.ts',
    roots: ['data/jobs-crawler-summaries/', 'data/jobs/'],
    reason: 'every data/jobs path is created or asserted inside mkdtemp git repositories under os.tmpdir(); the checkout read is limited to the script under test',
  },
  {
    file: 'tests/generate-crawler-group-workflows.test.ts',
    roots: ['data/jobs/'],
    reason: 'job slice paths are asserted YAML/env strings, not checkout filesystem reads',
  },
  {
    file: 'tests/nord-anglia-crawler.test.ts',
    roots: ['data/jobs/'],
    reason: 'the path is an expected workflow env string; ROOT reads target workflow/parser sources',
  },
  {
    file: 'tests/check-cron-count-literals.test.ts',
    roots: ['data/border-wait', 'data/jobs/', 'data/pharmac'],
    reason: 'i path sono SORGENTI SINTETICI passati allo scanner (`scanTestSource`) e nomi interrogati sul matcher; il repo sintetico vive in os.tmpdir(). La scansione del repo legge test, moduli e workflow, mai un file sotto data/ (#9743)',
  },
  {
    file: 'tests/merge-open-data-refresh.test.ts',
    roots: ['data/events.json', 'packages/articles/content/', 'services/locales/'],
    reason: 'every data/, packages/articles/content/ and services/locales/ path is written, symlinked and read inside a mkdtemp git repository under os.tmpdir(); the checkout read is limited to the script under test',
  },
  {
    file: 'tests/open-data-refresh-checkout.test.ts',
    roots: ['packages/articles/content/'],
    reason: 'the same fixture as merge-open-data-refresh: packages/articles/content/body.ts is written and symlinked inside a mkdtemp git repository under os.tmpdir(); the checkout read is limited to the five refresh scripts under test (#10754)',
  },
  {
    file: 'tests/scripts/verified-shrink-with-additions.test.ts',
    roots: ['data/jobs/'],
    reason: 'data/jobs/by-crawler is only the anchor of a crawler key relative to the real slice directory: the slice, the housekeeping proofs and every write live in a mkdtemp directory under os.tmpdir(), and the test aborts if the resolved path escapes it',
  },
  {
    file: 'tests/translation-stats-honest-reporting.test.ts',
    roots: ['data/jobs/'],
    reason: 'data/jobs/by-crawler e` creato dentro un mkdtemp sotto os.tmpdir() e passato a log-translation-stats.mjs con TRANSLATION_STATS_ROOT; la storia e il sidecar della coorte nascono nella stessa cartella temporanea. Dal checkout si legge solo lo script sotto test (#11286)',
  },
  {
    file: 'tests/job-board-seo-titles.test.ts',
    roots: ['data/jobs.json'],
    reason: 'data/jobs.json is written and read only under fs.mkdtempSync; the separate checkout read is the staticPagesPlugin.ts source used to verify the static landing call',
    runtime: true,
  },
  {
    file: 'tests/scripts/assemble-translation-hold.test.ts',
    roots: ['data/jobs.json', 'data/jobs/', 'public/data/'],
    reason: 'the assembler runs as a child process with cwd in an fs.mkdtempSync sandbox: every slice, data/jobs.json and public/data/jobs.json is written and read there. From the checkout it copies only the assembler code closure and ASSEMBLE_AUX_DATA_INPUTS under 1 MB, none of them under a live root',
  },
  {
    file: 'tests/scripts/crawler-summary-partition.test.ts',
    roots: ['data/jobs-crawler-summaries/', 'data/jobs/'],
    reason: 'same sandbox as assemble-translation-hold: the slice and summary writers run as child processes with cwd in an fs.mkdtempSync directory, and writeJson/readJson resolve every data/jobs and data/jobs-crawler-summaries path under it. From the checkout it copies only the assembler code closure and ASSEMBLE_AUX_DATA_INPUTS, none of them under a live root (PR 11517)',
  },
  {
    file: 'tests/crawler-retranslation-baseline.test.ts',
    roots: ['data/jobs/'],
    reason: 'data/jobs/by-crawler is written and read under an fs.mkdtempSync root, and seedCrawlerSlicesFromDataJobs resolves every slice under the root it is given. From the checkout the test reads only the pinned pairs in tests/fixtures/crawler-retranslation-flag/ and the source of three scripts/ files (PR 11540)',
  },
  {
    file: 'tests/build-plugins/cantonArticleSectionCore.test.ts',
    roots: ['packages/articles/content/'],
    reason: 'packages/articles/content/cantons/<section>/registry.ts and slugs.ts are the EXPECTED values of the generated canton entries (`registryFile`/`slugDataFile`), compared as strings; the files do not exist and nothing opens them. From the checkout the test reads only data/canton-url-slugs.json (curated, not rewritten by the pipeline), the generated module, the generator, services/router.ts and the Worker source (PR 11623)',
  },
  {
    file: 'tests/seo/blog-meta-it-shard-coverage.test.ts',
    roots: ['packages/articles/'],
    reason: 'the test verifies the synchronized live article metadata and SEO shards; those files are rewritten by the corpus sync pipeline and are intentionally the subject of the assertion',
  },
]);


/**
 * File MISTI: il file contiene sia test deterministici sia test su dati vivi.
 *
 * Escluderli interi costerebbe la copertura deterministica che portano (in
 * `tests/generate-crawler-group-workflows.test.ts`, per dire, i test vivi sono
 * una manciata su 87). Qui il taglio è PER TEST: il singolo `it`/`describe` che
 * legge il dato vivo è marcato nel file con `skipIf(SKIP_LIVE_DATA)`
 * (`tests/helpers/live-data.ts`), quindi non gira nel job bloccante delle PR e
 * gira ovunque altro. Il file resta nella suite del gate.
 *
 * Lo scanner li conosce e non li segnala come debito nuovo; `listLiveDataTestsForCi`
 * NON li esclude, perché a spegnere i loro test vivi è la env, non la config.
 */
export const LIVE_DATA_PARTIAL_TESTS = Object.freeze([
  // ─── Erano nell'inventario del 2026-08-21 come esclusioni INTERE. Il
  // censimento ha letto il contenuto: in ognuno di questi il test vivo e' uno
  // o pochi, e tutto il resto e' deterministico — 73 test di sola copertura di
  // codice stavano fuori dal gate per colpa di una manciata di vicini. Ora il
  // taglio e' per test, e il file torna nella suite bloccante.
  { file: "tests/article-review-overrides.test.ts", roots: [], since: "2026-09-19", movedFromFullExclusion: true },
  { file: "tests/article-slug-prompt-leak-guard.test.ts", roots: [], since: "2026-09-19", movedFromFullExclusion: true },
  { file: "tests/blog-headline-validation.test.ts", roots: [], since: "2026-09-19", movedFromFullExclusion: true },
  { file: "tests/bridge-canton-aware.test.ts", roots: [], since: "2026-09-19", movedFromFullExclusion: true },
  { file: "tests/crawler-regression-quality-guards.test.ts", roots: [], since: "2026-09-19", movedFromFullExclusion: true },
  { file: "tests/expired-at-parsable.test.ts", roots: [], since: "2026-09-19", movedFromFullExclusion: true },
  { file: "tests/it-microcopy-guard.test.ts", roots: [], since: "2026-09-19", movedFromFullExclusion: true },
  { file: "tests/refline-detail-title.test.ts", roots: [], since: "2026-09-19", movedFromFullExclusion: true },
  { file: "tests/slug-leak-allowlist-liveness.test.ts", roots: [], since: "2026-09-19", movedFromFullExclusion: true },
  { file: "tests/static-pages-blog-skip.test.ts", roots: [], since: "2026-09-19", movedFromFullExclusion: true },
  { file: "tests/successfactors-jobs2web-widget-guard.test.ts", roots: [], since: "2026-09-19", movedFromFullExclusion: true },
  { file: "tests/topic-cluster-hubs.test.ts", roots: [], since: "2026-09-19", movedFromFullExclusion: true },
  { file: "tests/whats-new-localization-guard.test.ts", roots: [], since: "2026-09-19", movedFromFullExclusion: true },
  { file: "tests/all-known-job-slugs-store.test.ts", roots: ["data/all-known-job-slugs/"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/blog/svizzera-section-routing.test.ts", roots: ["packages/articles/content/"], since: "2026-09-19", evidence: "review", runtime: true },
  // #10686: il caso sui creator ImageObject legge i template SEO statici del
  // corpus pubblicato; gli altri verificano codice del sito e restano nel gate.
  { file: "tests/organization-entity-consolidation.test.ts", roots: ["packages/articles/content/"], since: "2026-10-01", evidence: "review", runtime: true },
  { file: "tests/cf-hot-404-bridge.test.ts", roots: ["data/employer-profiles.json", "data/search-cluster-301-map.json"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/cippatrasporti-crawler.test.ts", roots: ["data/jobs/"], since: "2026-09-19", evidence: "replay", runtime: true },
  { file: "tests/crawler-brand-domain-pairing.test.ts", roots: ["data/prospector/"], since: "2026-09-19", evidence: "replay", runtime: true },
  { file: "tests/employer-profile-pages.test.ts", roots: ["data/employer-profiles.json", "data/search-cluster-301-map.json"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/events-pipeline.test.ts", roots: ["data/events.json"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/exchange-ssg-pages.test.ts", roots: ["data/employer-profiles.json", "data/exchange-rate-snapshot.json", "data/search-cluster-301-map.json"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/ga4-engagement-reliability.test.ts", roots: ["data/ai-channel-history.jsonl"], since: "2026-09-19", evidence: "replay", runtime: true },
  { file: "tests/job-cross-locale-guard.test.ts", roots: ["data/jobs.json"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/jobs-sitemap-filters.test.ts", roots: ["data/jobs.json"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/loop-l2-demand-utility.test.ts", roots: ["data/gsc-orphan-queries-clusters.json"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/migrate-prospected-slugs.test.ts", roots: ["data/jobs/"], since: "2026-09-19", evidence: "replay", runtime: true },
  { file: "tests/newsletter-dynamic-metrics.test.ts", roots: ["data/health-premiums/", "public/data/"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/orphan-enriched-store.test.ts", roots: ["data/orphan-enriched-data/"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/orphan-query-landings.test.ts", roots: ["data/all-known-job-slugs/", "data/gsc-orphan-queries-clusters.json", "data/gsc-orphan-queries.json"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/pharmacy-data-health.test.ts", roots: ["data/pharmacies-italy-border.json", "data/pharmacies-ticino-complete.json", "data/pharmacy-duties-ticino.json"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/pharmacy-italy-duty-parser.test.ts", roots: ["data/pharmacies-italy-border.json"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/pharmacy-italy-duty.test.ts", roots: ["data/pharmacies-italy-border.json", "data/pharmacies-ticino-complete.json", "data/pharmacy-duties-italy-status.json", "data/pharmacy-duties-italy.json", "data/pharmacy-duties-ticino.json"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/pharmacy-paths.test.ts", roots: ["data/pharmacies-italy-border.json", "data/pharmacies-ticino-complete.json"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/pharmacy-release-contract.test.ts", roots: ["data/pharmacies-italy-border.json", "data/pharmacies-ticino-complete.json", "data/pharmacy-duties-italy-status.json", "data/pharmacy-duties-italy.json", "data/pharmacy-duties-ticino.json"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/prune-search-cluster-301-map.test.ts", roots: ["data/search-cluster-301-map.json"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/readingTime.test.ts", roots: ["packages/articles/content/"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/reconcile-crawler-company-ownership.test.ts", roots: ["data/jobs/"], since: "2026-09-19", evidence: "replay", runtime: true },
  { file: "tests/retired-runaway-articles-redirects.test.ts", roots: ["packages/articles/content/"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/scripts/adsense-format-ab-report.test.ts", roots: ["data/adsense-format-ab-history.jsonl"], since: "2026-09-19", evidence: "replay", runtime: true },
  { file: "tests/scripts/prompt-placeholder-guard.test.ts", roots: ["packages/articles/content/"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/scripts/publish-article-chunks-companions.test.ts", roots: ["packages/articles/content/"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/submit-indexnow-batch.test.ts", roots: ["public/sitemap-guides.xml"], since: "2026-09-19", evidence: "review", runtime: true },
  { file: "tests/translation-shadow-preflight-v2.test.ts", roots: ["data/job-popularity.json"], since: "2026-09-19", evidence: "review", runtime: true },
  // ─── Censimento e replay del 2026-09-30 (hook su fs nei worker e nei processi
  // figli, dati vivi riportati a 7 e 14 giorni fa). Questi file leggevano un
  // dato vivo fuori da ogni elenco; in ognuno cambia esito un solo caso, o due,
  // e solo quello è marcato `skipIf(SKIP_LIVE_DATA)`. Le spec in
  // data/prospector/crawlers/ le riscrive il bot prospector (commit senza (#N)
  // su apply, brefispersonal, yellowshark e gmo nella finestra misurata); il
  // rilascio di Ginevra lo riscrive il workflow delle farmacie (34 commit su 36).
  { file: "tests/apply-crawler.test.ts", roots: ["data/prospector/"], since: "2026-09-30", evidence: "replay", runtime: true },
  { file: "tests/brefispersonal-crawler.test.ts", roots: ["data/prospector/"], since: "2026-09-30", evidence: "replay", runtime: true },
  { file: "tests/schweizerhof-flims-crawler.test.ts", roots: ["data/prospector/"], since: "2026-09-30", evidence: "replay", runtime: true },
  { file: "tests/prospector-spec-pagination.test.ts", roots: ["data/prospector/"], since: "2026-09-30", evidence: "replay", runtime: true },
  { file: "tests/pharmacy-geneva-release.test.ts", roots: ["data/pharmacy-duties-geneva.json", "data/pharmacy-duties-geneva-status.json"], since: "2026-09-30", evidence: "replay", runtime: true },
  // ─── 2026-10-03. Era un'esclusione INTERA dal 2026-08-21, e conteneva due
  // soggetti diversi. La parte di CODICE (le chiamate `t()` contro i chunk di
  // interfaccia `{locale}-<chunk>.ts`) torna nel gate delle PR: una chiave usata
  // e non tradotta deve fermare la PR che la introduce. La parte di CORPUS
  // (`blog-meta-*`, `blog-body*` e gli altri symlink verso
  // `packages/articles/content/`) si legge solo dove `SKIP_LIVE_DATA` e' falso.
  // Traccia del 2026-10-03 con `VITEST_SKIP_LIVE_DATA=true`: zero accessi a
  // `services/locales/blog-*` e a `packages/articles/content/`.
  { file: "tests/i18n-completeness.test.ts", roots: ["services/locales/"], since: "2026-10-03", evidence: "trace", runtime: true, movedFromFullExclusion: true },
  // ─── 2026-10-04. Il produttore dei verdetti L6 legge l'elenco articoli con
  // una regex: il corpus E' il soggetto del solo caso vivo (la regex legge
  // tante voci quante un conteggio indipendente di `blog-articles-data.ts`,
  // nessun conteggio letterale). Tutti gli altri casi usano fixture e restano
  // nel gate delle PR.
  { file: "tests/loop-l6-source-verdict-producer.test.ts", roots: ["packages/articles/content/"], since: "2026-10-04", evidence: "review", runtime: true },
  // ─── 2026-10-05. Solo il blocco `live registry coverage` legge i due
  // registri riscritti dalla pipeline; le altre prove del file usano una
  // sorgente sintetica e devono restare nel gate delle PR.
  { file: "tests/article-registry-entries.test.ts", roots: ["packages/articles/content/"], since: "2026-10-05", evidence: "review", runtime: true },
]);

/**
 * Il test di partizionamento è un controllo meta della configurazione, non un
 * gate sulla qualità del corpus: resta nel gate PR e viene lanciato anche
 * esplicitamente nel workflow post-merge.
 */
const CI_LIVE_DATA_META_TESTS = new Set([
  'tests/corpus-wide-test-partition.test.ts',
]);

/** I test dell'inventario live, esclusi i controlli meta della CI, non sono gate PR. */
export function listLiveDataTestsForCi() {
  return KNOWN_LIVE_DATA_TESTS
    .map(({ file }) => file)
    .filter((file) => !CI_LIVE_DATA_META_TESTS.has(file))
    .sort();
}

/**
 * Il COMPLEMENTO: tutto cio' che resta nel gate PR.
 *
 * Serve a `VITEST_LIVE_DATA_GROUP=only`, cioe' al giro post-merge che esegue i
 * soli test su dati vivi. Toglierli dalle PR non significa cancellarli: e'
 * proprio su dato fresco che dicono qualcosa (il 2026-09-19 il gate sull'articolo
 * DE di San Gallo ha trovato il corpo in ITALIANO, una localizzazione persa da un
 * sync del corpus). Cambia DOVE girano: fuori dal gate che governa l'auto-merge
 * altrui, dentro un workflow che a rosso apre una issue.
 *
 * Come per il gruppo corpus-wide, si agisce solo su `exclude` — mai su `include`,
 * che e' cio' che assegna ogni file al project giusto (node vs jsdom).
 */
/**
 * Cosa gira nel monitor post-merge: l'inventario MENO i gate corpus-wide.
 *
 * I sei corpus-wide hanno gia' un indirizzo (`corpus-wide-gates.yml`) e quel
 * workflow e' `workflow_dispatch` per una decisione del proprietario scritta
 * nel suo header — «il corpus è di proprietà di
 * nanakokyobashi-rgb/frontaliere-articles […] non deve più consumare CI su main
 * di questo repository». Ripescarli qui dentro un cron li rimetterebbe su main
 * dalla porta di servizio, quindi restano fuori: il monitor sorveglia i dati di
 * QUESTO repo (slice dei crawler, farmacie, valichi, registri slug, sitemap
 * pubblicate), non il corpus altrui.
 */
export function listLiveDataMonitorTests() {
  const corpus = new Set(listCorpusWideTests());
  // I file MISTI vanno inclusi, e non e' un dettaglio: nel gate delle PR i
  // loro casi vivi non girano perche' `SKIP_LIVE_DATA` li salta, e se non
  // girassero nemmeno qui non girerebbero in NESSUN posto — il taglio per test
  // diventerebbe una cancellazione silenziosa, che e' esattamente cio' che
  // questa partizione esiste per evitare. Qui `VITEST_SKIP_LIVE_DATA` non e'
  // impostata, quindi il file gira intero.
  const files = new Set([
    ...listLiveDataTestsForCi(),
    ...LIVE_DATA_PARTIAL_TESTS.map((e) => e.file),
  ]);
  return [...files].filter((file) => !corpus.has(file)).sort();
}

/** Il complemento del gruppo monitor: tutto cio' che quel giro NON esegue. */
export function listNonLiveDataTestsForCi() {
  const monitor = new Set(listLiveDataMonitorTests());
  return [...listDatasetDependentTests(), ...listDatasetIndependentTests()]
    .filter((file) => !monitor.has(file))
    .sort();
}

/**
 * `node scripts/ci/live-data-test-guard.mjs --monitor-files` stampa l'elenco del
 * gruppo monitor, uno per riga, da passare a `vitest run`.
 *
 * Perche' un CLI e non una env letta da `vitest.config.ts`. Il runner related
 * (`scripts/ci/run-related-tests.mjs`) tratta `vitest.config.ts` come config
 * GLOBALE: una PR che lo tocca perde la selezione per diff e ricade sulla suite
 * intera, che con `VITEST_MAX_WORKERS=1` sfonda il limite di 360 minuti del job
 * — misurato il 2026-09-20, run 35481674287 cancellata a 6 ore sulla PR che
 * introduceva questa partizione. (Il fallback a suite intera doveva girare con
 * 3 worker, ma Vitest applicava la variabile ereditata sopra `--maxWorkers`:
 * corretto il 2026-09-30 con `vitestChildEnv`, vedi select-max-workers.mjs.
 * La suite intera resta comunque un costo da non imporre a ogni PR.)
 * Passare i file sulla riga di comando ottiene
 * la stessa selezione senza toccare la config, quindi senza tassare ogni PR
 * futura che sfiori questo meccanismo.
 */
if (process.argv[1] && process.argv.includes('--monitor-files')) {
  const self = path.resolve(process.argv[1]);
  if (self === fileURLToPath(import.meta.url)) {
    process.stdout.write(`${listLiveDataMonitorTests().join('\n')}\n`);
  }
}

/**
 * @param {string} [root]
 * @returns {{ file: string, roots: string[] }[]}
 */
/**
 * L'unico file esente: il test del guard stesso.
 *
 * Deve contenere sia i nomi delle radici sorvegliate sia esempi letterali della
 * forma che rileva (`"np.resolve(ROOT, 'packages', 'articles')"` come stringa
 * di prova), altrimenti non potrebbe verificare il proprio rilevatore. Quei
 * letterali sono la SPECIFICA, non una lettura: senza l'esenzione il guard si
 * accusa da solo — terza istanza della stessa classe, dopo i commenti e la
 * costruzione a segmenti.
 */
const SELF_EXEMPT = new Set(['tests/live-data-test-guard.test.ts']);

/**
 * Tutti i `*.test.ts` sotto `tests/`, RICORSIVO.
 *
 * Prima era un `readdirSync` piatto, e quella piattezza era un buco: i test
 * sotto `tests/seo/`, `tests/scripts/`, `tests/build-plugins/` e
 * `tests/regression/` non venivano nemmeno guardati. Misurato il 2026-09-19:
 * fra quelli c'erano `tests/scripts/prompt-placeholder-guard.test.ts`, che
 * scandisce 70.000 campi del corpus pubblicato, e
 * `tests/seo/cathedral-expired-tracking-canton.test.ts`, che campiona
 * `data/jobs.json`. Il guard diceva verde perche' non guardava.
 */
function listTestFilesRecursive(dir, base, acc = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '__snapshots__' || e.name === '__fixtures__') continue;
    const full = path.join(dir, e.name);
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) listTestFilesRecursive(full, rel, acc);
    else if (e.name.endsWith('.test.ts')) acc.push(rel);
  }
  return acc;
}

export function scanLiveDataTests(root = ROOT) {
  const dir = path.join(root, 'tests');
  const registered = new Set(listCorpusWideTests());
  const partial = new Set(LIVE_DATA_PARTIAL_TESTS.map((e) => e.file));
  const out = [];
  const files = listTestFilesRecursive(dir, '');
  for (const f of files.sort()) {
    const rel = `tests/${f}`;
    if (partial.has(rel)) continue; // taglio PER TEST gia' applicato nel file
    if (registered.has(rel)) continue; // gia' fuori dal job bloccante
    if (SELF_EXEMPT.has(rel)) continue;
    let src = '';
    try { src = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    const code = stripComments(src);
    if (!ROOT_ANCHOR_RE.test(code)) continue;
    const roots = liveRootsInCode(code);
    if (roots.length) out.push({ file: rel, roots });
  }
  return out;
}

/**
 * Le radici vive di un sorgente di test, con la stessa regola dello scanner.
 *
 * @param {string} code sorgente gia' passato da `stripComments`
 * @returns {string[]}
 */
function liveRootsInCode(code) {
  const roots = LIVE_DATA_ROOTS.filter((r) => code.includes(`'${r}`) || code.includes(`\`${r}`) || code.includes(`"${r}`));
  for (const segs of LIVE_DATA_SEGMENTS) {
    if (!segmentSequenceRegex(segs).test(code)) continue;
    const asRoot = `${segs.join('/')}/`;
    if (!roots.some((r) => r.startsWith(asRoot) || asRoot.startsWith(r))) roots.push(asRoot);
  }
  return roots.sort();
}

/** Un riferimento alla root del checkout: `ROOT`, `PROJECT_ROOT`, `__dirname`… */
const CHECKOUT_ANCHOR_RE = /\b[A-Z_]*ROOT\b|__dirname|import\.meta|process\.cwd\(\)/;

/**
 * Il verso OPPOSTO del guard: un test che NON legge dati vivi non puo' stare
 * nell'inventario.
 *
 * Il guard nasce per impedire che un test su dati vivi entri nel gate delle
 * PR. L'errore speculare costa uguale e non lo guardava nessuno: un test di
 * CODICE finito nell'inventario esce dal gate, la regressione passa il merge e
 * ricompare solo nel monitor giornaliero, dentro un'unica issue che nessun
 * fixer possiede. Misurato il 2026-10-03 (issue #9453): `live-data-gates.yml`
 * rosso da giorni su un parser di chiavi i18n rotto e su un'asserzione sul
 * testo di un workflow superata da una modifica al workflow — nessuno dei due
 * era un difetto di dato. Quattordici file dell'inventario del 2026-08-21 non
 * leggevano alcun dato vivo: c'erano perche' lo scanner testuale li segnala.
 *
 * Tre forme, tutte ricavate da quei quattordici e decidibili dal solo testo:
 *
 * - `ui-locale-chunks`: l'unica radice e' `services/locales/` e il file non
 *   nomina mai `blog-meta`/`blog-body`. I chunk `{locale}-<chunk>.ts` cambiano
 *   solo con una PR; il dato vivo sotto quella radice sono i symlink `blog-*`.
 * - `package-engine-source`: l'unica radice e' `packages/articles/` e ogni
 *   sequenza `'packages','articles'` prosegue con `'engine'`, cioe' col codice
 *   del package e non col corpus in `content/`.
 * - `temp-fixture`: il file crea una cartella temporanea e nessuna riga che
 *   nomina una radice viva tocca la root del checkout (ne' direttamente ne'
 *   con una costante assegnata da essa): il percorso «vivo» e' una fixture
 *   scritta dal test.
 *
 * Valgono solo per le voci giustificate dal TESTO. Una voce `runtime` o
 * `transitive` dichiara una lettura che il testo non mostra (un import, un
 * processo figlio) ed e' quella la via d'uscita quando una di queste forme
 * inganna: la si marca, scrivendo accanto cosa ha misurato la traccia.
 *
 * @param {string} [root]
 * @param {ReadonlyArray<{ file: string, runtime?: boolean, transitive?: boolean }>} [inventory]
 * @returns {{ file: string, shape: string }[]}
 */
export function findInventoryEntriesWithoutLiveRead(root = ROOT, inventory = KNOWN_LIVE_DATA_TESTS) {
  const out = [];
  const seen = new Set();
  for (const entry of inventory) {
    if (entry.runtime || entry.transitive || seen.has(entry.file)) continue;
    seen.add(entry.file);
    let src = '';
    try { src = fs.readFileSync(path.join(root, entry.file), 'utf8'); } catch { continue; }
    const shape = codeOnlyShape(stripComments(src));
    if (shape) out.push({ file: entry.file, shape });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * @param {string} code sorgente gia' passato da `stripComments`
 * @returns {'ui-locale-chunks' | 'package-engine-source' | 'temp-fixture' | null}
 */
export function codeOnlyShape(code) {
  const roots = liveRootsInCode(code);
  if (roots.length === 0) return null;

  if (roots.every((r) => r === 'services/locales/') && !/blog-(?:meta|body)/.test(code)) {
    return 'ui-locale-chunks';
  }

  if (roots.every((r) => r === 'packages/articles/')) {
    const pkg = segmentSequenceRegex(['packages', 'articles']);
    const everySequence = new RegExp(pkg.source, 'g');
    const toEngine = new RegExp(`${pkg.source}\\s*,\\s*['\`"]engine['\`"]`, 'g');
    const all = code.match(everySequence) || [];
    const engine = code.match(toEngine) || [];
    if (all.length > 0 && all.length === engine.length) return 'package-engine-source';
  }

  if (/\bmkdtemp(?:Sync)?\s*\(|\btmpdir\s*\(/.test(code)) {
    const lines = code.split('\n');
    // Una costante assegnata dalla root del checkout la porta con se':
    // `const rootDir = resolve(__dirname, '..')` rende `rootDir` un'ancora.
    const aliases = [];
    for (const line of lines) {
      const m = line.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(.*)$/);
      if (m && CHECKOUT_ANCHOR_RE.test(m[2])) aliases.push(m[1]);
    }
    const aliasRe = aliases.length
      ? new RegExp(`\\b(?:${aliases.map((a) => a.replace(/[$]/g, '\\$&')).join('|')})\\b`)
      : null;
    const mentionLines = lines.filter((line) => liveRootsInCode(line).length > 0);
    const anchored = mentionLines.some((line) => CHECKOUT_ANCHOR_RE.test(line) || (aliasRe && aliasRe.test(line)));
    if (mentionLines.length > 0 && !anchored) return 'temp-fixture';
  }

  return null;
}

/**
 * @param {string} [root]
 * @returns {{ added: { file: string, roots: string[] }[], removed: string[] }}
 */
export function diffAgainstInventory(root = ROOT) {
  const found = scanLiveDataTests(root);
  const inventoried = [...KNOWN_LIVE_DATA_TESTS, ...LIVE_DATA_SCAN_EXEMPTIONS];
  const known = new Set(inventoried.map((e) => e.file));
  const foundFiles = new Set(found.map((e) => e.file));
  // Una voce e' «sparita» solo se il FILE non c'e' piu'. Le voci misurate a
  // runtime (`runtime: true`) e quelle transitive per costruzione non sono
  // visibili allo scanner testuale — cercarle li' e poi dichiararle morte
  // significherebbe cancellare, a ogni giro, proprio le voci che la traccia ha
  // aggiunto perche' il testo non bastava.
  const explicitlyTransitive = new Set(
    inventoried
      .filter((e) => (e.transitive || e.runtime) && fs.existsSync(path.join(root, e.file)))
      .map((e) => e.file),
  );
  return {
    added: found.filter((e) => !known.has(e.file)),
    removed: [...known].filter((f) => !foundFiles.has(f) && !explicitlyTransitive.has(f)).sort(),
  };
}
