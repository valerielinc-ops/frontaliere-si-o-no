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
  { file: 'tests/article-review-overrides.test.ts', roots: ['packages/articles/'] },
  { file: 'tests/article-slug-prompt-leak-guard.test.ts', roots: ['packages/articles/content/'] },
  { file: 'tests/articles-sync-pin.test.ts', roots: ['packages/articles/content/'] },
  // Reaches the live article corpus transitively through create-article.mjs.
  // The source scanner intentionally does not execute imported modules while
  // building the inventory, so this dependency stays explicit.
  { file: 'tests/evergreen-pool-consumption.test.ts', roots: ['packages/articles/content/'], transitive: true },
  { file: 'tests/blog-headline-validation.test.ts', roots: ['services/locales/'] },
  { file: 'tests/bridge-canton-aware.test.ts', roots: ['data/jobs/'] },
  { file: 'tests/build-emit-skip-gate.test.ts', roots: ['packages/articles/'] },
  { file: 'tests/company-alert.test.ts', roots: ['services/locales/'] },
  { file: 'tests/corpus-wide-test-partition.test.ts', roots: ['data/jobs/', 'packages/articles/content/'] },
  { file: 'tests/crawler-regression-quality-guards.test.ts', roots: ['data/jobs/'] },
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
  { file: 'tests/git-commit-data-append-only-sets.test.ts', roots: ['data/jobs/'] },
  { file: 'tests/git-commit-data-grouped-isolation.test.ts', roots: ['data/jobs/'] },
  { file: 'tests/git-commit-data-slice-scoping.test.ts', roots: ['data/jobs-crawler-summaries/', 'data/jobs/'] },
  { file: 'tests/google-news-compliance.test.ts', roots: ['services/locales/'] },
  { file: 'tests/i18n-completeness.test.ts', roots: ['services/locales/'] },
  { file: 'tests/it-microcopy-guard.test.ts', roots: ['packages/articles/content/'] },
  // Reads the assembled live jobs corpus; its rate changes with crawler
  // output, so it is not a deterministic PR gate.
  { file: 'tests/job-locale-consistency.test.ts', roots: ['data/jobs/'], transitive: true },
  { file: 'tests/job-locale-mark-persistence.test.ts', roots: ['data/jobs/'] },
  { file: 'tests/news-ticker-data.test.ts', roots: ['packages/articles/'] },
  { file: 'tests/packages-articles-confinement.test.ts', roots: ['packages/articles/'] },
  // Corpus genuinely the subject: the turnover-safe #7045 observer compares
  // the live iPersonal active and expired slices so every known route keeps one
  // recoverable owner as jobs move between lifecycle states.
  { file: 'tests/ipersonal-route-recovery-7045-live.test.ts', roots: ['data/jobs/'] },
  { file: 'tests/refline-detail-title.test.ts', roots: ['data/jobs/'] },
  { file: 'tests/sitemap-slug-integrity.test.ts', roots: ['data/jobs.json'] },
  { file: 'tests/slug-active-loss-regression-5229.test.ts', roots: ['data/jobs/'] },
  { file: 'tests/slug-leak-allowlist-liveness.test.ts', roots: ['packages/articles/content/'] },
  { file: 'tests/static-pages-blog-skip.test.ts', roots: ['packages/articles/'] },
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
  { file: 'tests/successfactors-jobs2web-widget-guard.test.ts', roots: ['data/jobs/'] },
  { file: 'tests/topic-cluster-hubs.test.ts', roots: ['services/locales/'] },
  { file: 'tests/weekly-employers.test.ts', roots: ['services/locales/'] },
  { file: 'tests/whats-new-localization-guard.test.ts', roots: ['services/locales/'] },
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

export function scanLiveDataTests(root = ROOT) {
  const dir = path.join(root, 'tests');
  const registered = new Set(listCorpusWideTests());
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.ts')); } catch { return out; }
  for (const f of files.sort()) {
    const rel = `tests/${f}`;
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
  const explicitlyTransitive = new Set(
    KNOWN_LIVE_DATA_TESTS
      .filter((e) => e.transitive && fs.existsSync(path.join(root, e.file)))
      .map((e) => e.file),
  );
  return {
    added: found.filter((e) => !known.has(e.file)),
    removed: [...known].filter((f) => !foundFiles.has(f) && !explicitlyTransitive.has(f)).sort(),
  };
}
