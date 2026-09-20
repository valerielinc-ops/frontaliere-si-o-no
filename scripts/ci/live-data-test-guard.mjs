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
  { file: 'tests/article-hub-archive-assets.test.ts', roots: ['packages/articles/'] },
  { file: 'tests/article-hub-topics-nav.test.ts', roots: ['services/locales/'] },
  // Not pipeline-live: `article-reviewed-by.json` is a hand-edited map that
  // no script/crawler ever writes (verified: `rg -n "article-reviewed-by"`
  // outside this test hits only the loader's own doc comment and
  // `ogPagesPlugin.ts`'s `readFileSync` call — no writer anywhere). The
  // segment heuristic still fires because it generalizes any
  // `'packages','articles',...` sequence to the `packages/articles/` root
  // (see LIVE_DATA_SEGMENTS comment), which also covers this unrelated
  // subtree. The file's first test asserts the REAL checked-in map starts at
  // `{}` (issue #6337: no article may claim a fabricated review signal) —
  // that guarantee is about the shipped file itself, so pinning to
  // `tests/__fixtures__/` would test a copy instead of the guarantee.
  { file: 'tests/articles-sync-pin.test.ts', roots: ['packages/articles/content/'] },
  // Reaches the live article corpus transitively through create-article.mjs.
  // The source scanner intentionally does not execute imported modules while
  // building the inventory, so this dependency stays explicit.
  { file: 'tests/evergreen-pool-consumption.test.ts', roots: ['packages/articles/content/'], transitive: true },
  { file: 'tests/build-emit-skip-gate.test.ts', roots: ['packages/articles/'] },
  { file: 'tests/company-alert.test.ts', roots: ['services/locales/'] },
  // Corpus genuinely the subject: this funnel contract checks that the
  // shipped locale bundles expose the follow-specific copy in all four
  // supported locales. A fixture would only prove the fixture, not that the
  // production translations still carry the keys used by the modal.
  { file: 'tests/signup-prompt-funnel.test.ts', roots: ['services/locales/'] },
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
  { file: 'tests/dist-hash-manifest-deploy-perimeter.test.ts', roots: ['data/jobs.json'] },
  { file: 'tests/edge-retired-paths.test.ts', roots: ['packages/articles/content/'] },
  // Corpus genuinely the subject: the archive observer verifies that every
  // committed expired entry remains sortable before the cap is applied.
  { file: 'tests/git-commit-data-append-only-sets.test.ts', roots: ['data/jobs/'] },
  { file: 'tests/git-commit-data-grouped-isolation.test.ts', roots: ['data/jobs/'] },
  { file: 'tests/git-commit-data-slice-scoping.test.ts', roots: ['data/jobs-crawler-summaries/', 'data/jobs/'] },
  { file: 'tests/google-news-compliance.test.ts', roots: ['services/locales/'] },
  { file: 'tests/i18n-completeness.test.ts', roots: ['services/locales/'] },
  // Reads the assembled live jobs corpus; its rate changes with crawler
  // output, so it is not a deterministic PR gate.
  { file: 'tests/job-locale-consistency.test.ts', roots: ['data/jobs/'], transitive: true },
  { file: 'tests/job-locale-mark-persistence.test.ts', roots: ['data/jobs/'] },
  { file: 'tests/news-ticker-data.test.ts', roots: ['packages/articles/'] },
  // Corpus genuinely the subject: #8205's regression guard reads the checked-in
  // locale source to verify every audience-facing newsletter title stays neutral.
  { file: 'tests/newsletter-title-neutrality.test.ts', roots: ['services/locales/'] },
  { file: 'tests/packages-articles-confinement.test.ts', roots: ['packages/articles/'] },
  // Corpus genuinely the subject: the rejection CLI guard asserts that its
  // terminal transition never mutates the committed candidate registry.
  { file: 'tests/prospector-reject.test.ts', roots: ['data/prospector/'] },
  // Corpus genuinely the subject: the turnover-safe #7045 observer compares
  // the live iPersonal active and expired slices so every known route keeps one
  // recoverable owner as jobs move between lifecycle states.
  { file: 'tests/ipersonal-route-recovery-7045-live.test.ts', roots: ['data/jobs/'] },
  { file: 'tests/sitemap-slug-integrity.test.ts', roots: ['data/jobs.json'] },
  { file: 'tests/slug-active-loss-regression-5229.test.ts', roots: ['data/jobs/'] },
  // Corpus genuinely the subject, not a lazy read: the 'description-field
  // corpus sweep (issue #6393)' describe block (read in full — the two `it`s
  // at the file's tail) iterates `data/jobs/by-crawler/*.json` to assert
  // `sanitizeSuccessFactorsField` has never wiped a live description to ''
  // and no live description still contains widget chrome. That's the same
  // shape as `crawler-regression-quality-guards.test.ts`'s "CORPUS INVARIANT"
  // test above (also `data/jobs/by-crawler/`, also already in this list): a
  // regression anchor on the PUBLISHED corpus, where a red from new data is
  // the intended signal, not noise. Pinning it to a fixture would stop it
  // from ever catching a real production wipe.
  { file: 'tests/weekly-employers.test.ts', roots: ['services/locales/'] },

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
    file: 'tests/generate-crawler-group-workflows.test.ts',
    roots: ['data/jobs/'],
    reason: 'job slice paths are asserted YAML/env strings, not checkout filesystem reads',
  },
  {
    file: 'tests/nord-anglia-crawler.test.ts',
    roots: ['data/jobs/'],
    reason: 'the path is an expected workflow env string; ROOT reads target workflow/parser sources',
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
 * introduceva questa partizione. Passare i file sulla riga di comando ottiene
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
    const roots = LIVE_DATA_ROOTS.filter((r) => code.includes(`'${r}`) || code.includes(`\`${r}`) || code.includes(`"${r}`));
    for (const segs of LIVE_DATA_SEGMENTS) {
      if (!segmentSequenceRegex(segs).test(code)) continue;
      const asRoot = `${segs.join('/')}/`;
      if (!roots.some((r) => r.startsWith(asRoot) || asRoot.startsWith(r))) roots.push(asRoot);
    }
    if (roots.length) out.push({ file: rel, roots: roots.sort() });
  }
  return out;
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
