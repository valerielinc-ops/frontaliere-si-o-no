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
  { file: 'tests/article-hub-topics-nav.test.ts', roots: ['services/locales/'] },
  { file: 'tests/article-slug-prompt-leak-guard.test.ts', roots: ['packages/articles/content/'] },
  { file: 'tests/articles-sync-pin.test.ts', roots: ['packages/articles/content/'] },
  { file: 'tests/bridge-canton-aware.test.ts', roots: ['data/jobs/'] },
  { file: 'tests/company-alert.test.ts', roots: ['services/locales/'] },
  { file: 'tests/corpus-wide-test-partition.test.ts', roots: ['packages/articles/content/', 'data/jobs/'] },
  { file: 'tests/crawler-regression-quality-guards.test.ts', roots: ['data/jobs/'] },
  { file: 'tests/dist-hash-manifest-deploy-perimeter.test.ts', roots: ['data/jobs.json'] },
  { file: 'tests/edge-retired-paths.test.ts', roots: ['packages/articles/content/'] },
  { file: 'tests/git-commit-data-append-only-sets.test.ts', roots: ['data/jobs/'] },
  { file: 'tests/git-commit-data-grouped-isolation.test.ts', roots: ['data/jobs/'] },
  { file: 'tests/git-commit-data-slice-scoping.test.ts', roots: ['data/jobs/', 'data/jobs-crawler-summaries/'] },
  { file: 'tests/it-microcopy-guard.test.ts', roots: ['packages/articles/content/'] },
  { file: 'tests/job-locale-mark-persistence.test.ts', roots: ['data/jobs/'] },
  { file: 'tests/sitemap-slug-integrity.test.ts', roots: ['data/jobs.json'] },
  { file: 'tests/slug-active-loss-regression-5229.test.ts', roots: ['data/jobs/'] },
  { file: 'tests/slug-leak-allowlist-liveness.test.ts', roots: ['packages/articles/content/'] },
  { file: 'tests/topic-cluster-hubs.test.ts', roots: ['services/locales/'] },
  { file: 'tests/weekly-employers.test.ts', roots: ['services/locales/'] },
  { file: 'tests/whats-new-localization-guard.test.ts', roots: ['services/locales/'] },
]);

/**
 * @param {string} [root]
 * @returns {{ file: string, roots: string[] }[]}
 */
export function scanLiveDataTests(root = ROOT) {
  const dir = path.join(root, 'tests');
  const registered = new Set(listCorpusWideTests());
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.ts')); } catch { return out; }
  for (const f of files.sort()) {
    const rel = `tests/${f}`;
    if (registered.has(rel)) continue; // gia' fuori dal job bloccante
    let src = '';
    try { src = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    const code = stripComments(src);
    if (!ROOT_ANCHOR_RE.test(code)) continue;
    const roots = LIVE_DATA_ROOTS.filter((r) => code.includes(`'${r}`) || code.includes(`\`${r}`) || code.includes(`"${r}`));
    if (roots.length) out.push({ file: rel, roots });
  }
  return out;
}

/**
 * @param {string} [root]
 * @returns {{ added: { file: string, roots: string[] }[], removed: string[] }}
 */
export function diffAgainstInventory(root = ROOT) {
  const found = scanLiveDataTests(root);
  const known = new Set(KNOWN_LIVE_DATA_TESTS.map((e) => e.file));
  const foundFiles = new Set(found.map((e) => e.file));
  return {
    added: found.filter((e) => !known.has(e.file)),
    removed: [...known].filter((f) => !foundFiles.has(f)).sort(),
  };
}
