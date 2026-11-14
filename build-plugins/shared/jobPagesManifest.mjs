// build-plugins/shared/jobPagesManifest.mjs
//
// Il manifest delle pagine annuncio pubblicate (perf-plan PR 5).
//
// IL PROBLEMA. Prima di spedire un job alert il sender deve sapere se la pagina
// di ogni annuncio e' ancora viva: il sito non risponde mai 404 per un annuncio
// scaduto (AGENTS.md, «Static SEO Pages»: soft-landing con HTTP 200), quindi un
// controllo di stato e' cieco e serve scaricare l'HTML intero cercando il
// marcatore `__EXPIRED_JOB_DATA__=`. Run 43572400758: 6.040 GET, 564 s, 1.583
// avvisi «only N/10 resolved live ... failing open» (in fail-open il sender
// spedisce link non verificati).
//
// L'IDEA. Chi sa quali pagine annuncio sono vive e' il build che le emette:
// `jobsSeoPagesPlugin` registra ogni pagina annuncio ATTIVA che scrive, e le
// scadute escono solo come soft-landing. Il build scrive un manifest con
// l'insieme dei percorsi canonici delle pagine attive; il sender lo scarica UNA
// volta e risponde «viva?» con una ricerca in un Set. Una pagina assente dal
// manifest e' scaduta oppure non ancora pubblicata: in entrambi i casi non e' un
// link da spedire oggi.
//
// FORMATO. Chiave = cartella della sezione (con il prefisso di locale, senza
// slash finale), valore = gli slug ordinati e codificati a prefisso comune
// (front coding): `["a-slug", "5|-b", ...]`. Il percorso della pagina e'
// `<cartella>/<slug>`. Lo stesso modulo scrive (build) e legge (sender), cosi'
// la codifica non puo' divergere.

import { createHash } from 'node:crypto';

export const JOB_PAGES_MANIFEST_VERSION = 1;
/** Percorso stabile sul sito, accanto a sitemap-index.xml. */
export const JOB_PAGES_MANIFEST_FILE = 'job-pages-manifest.json';
export const JOB_PAGES_MANIFEST_URL_PATH = `/${JOB_PAGES_MANIFEST_FILE}`;

/**
 * Normalizza un URL o un percorso di pagina: solo il percorso, niente query,
 * niente hash, niente slash finale, sempre con lo slash iniziale. Lo stesso
 * criterio vale per chi scrive e per chi legge.
 */
export function normalizeJobPagePath(input) {
  let value = String(input ?? '').trim();
  if (!value) return '';
  const origin = value.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i);
  if (origin) value = value.slice(origin[0].length);
  value = value.split('#')[0].split('?')[0];
  if (!value.startsWith('/')) value = `/${value}`;
  return value.replace(/\/+$/, '');
}

function splitPath(path) {
  const normalized = normalizeJobPagePath(path);
  const cut = normalized.lastIndexOf('/');
  if (cut <= 0) return null;
  return { dir: normalized.slice(0, cut), slug: normalized.slice(cut + 1) };
}

/** Front coding di una lista ORDINATA di stringhe senza `|`. */
export function encodeSortedSlugs(slugs) {
  const out = [];
  let previous = '';
  for (const slug of slugs) {
    let shared = 0;
    const limit = Math.min(previous.length, slug.length);
    while (shared < limit && previous.charCodeAt(shared) === slug.charCodeAt(shared)) shared += 1;
    out.push(out.length === 0 || shared === 0 ? slug : `${shared.toString(36)}|${slug.slice(shared)}`);
    previous = slug;
  }
  return out;
}

export function decodeSortedSlugs(encoded) {
  const out = [];
  let previous = '';
  for (const entry of encoded) {
    const text = String(entry);
    const cut = out.length === 0 ? -1 : text.indexOf('|');
    // Uno slug intero non puo' contenere `|`: il separatore e' inequivocabile.
    const slug = cut > 0 && /^[0-9a-z]+$/.test(text.slice(0, cut))
      ? previous.slice(0, Number.parseInt(text.slice(0, cut), 36)) + text.slice(cut + 1)
      : text;
    out.push(slug);
    previous = slug;
  }
  return out;
}

/**
 * Costruisce il manifest dai percorsi canonici delle pagine annuncio attive.
 * Deterministico: stesso insieme di percorsi, stesso contenuto (tranne
 * `generatedAt`), indipendente dall'ordine di inserimento.
 *
 * @param {{paths: Iterable<string>, generatedAt?: string, buildCommit?: string}} input
 */
export function buildJobPagesManifest({ paths, generatedAt = new Date().toISOString(), buildCommit = '' }) {
  const byDir = new Map();
  let total = 0;
  for (const raw of paths) {
    const parts = splitPath(raw);
    if (!parts || !parts.slug || parts.slug.includes('|')) continue;
    let slugs = byDir.get(parts.dir);
    if (!slugs) { slugs = new Set(); byDir.set(parts.dir, slugs); }
    if (!slugs.has(parts.slug)) { slugs.add(parts.slug); total += 1; }
  }
  const pages = {};
  const hash = createHash('sha256');
  for (const dir of [...byDir.keys()].sort()) {
    const sorted = [...byDir.get(dir)].sort();
    pages[dir] = encodeSortedSlugs(sorted);
    hash.update(`${dir}\n${sorted.join('\n')}\n`);
  }
  return {
    version: JOB_PAGES_MANIFEST_VERSION,
    generatedAt,
    buildCommit: String(buildCommit || ''),
    contentSha256: hash.digest('hex'),
    counts: { pages: total, sections: byDir.size },
    pages,
  };
}

/**
 * Valida e indicizza un manifest letto dalla rete. Restituisce `null` per un
 * manifest malformato o incoerente (versione, conteggi): il chiamante ripiega sul
 * controllo HTTP, mai su un manifest di cui non si fida.
 */
export function createJobPagesManifestLookup(manifest) {
  if (!manifest || typeof manifest !== 'object' || manifest.version !== JOB_PAGES_MANIFEST_VERSION) return null;
  if (!manifest.pages || typeof manifest.pages !== 'object') return null;
  const generatedAtMs = Date.parse(manifest.generatedAt);
  if (!Number.isFinite(generatedAtMs)) return null;
  const index = new Map();
  let total = 0;
  for (const [dir, encoded] of Object.entries(manifest.pages)) {
    if (!Array.isArray(encoded)) return null;
    const slugs = new Set(decodeSortedSlugs(encoded));
    total += slugs.size;
    index.set(dir, slugs);
  }
  if (manifest.counts && (manifest.counts.pages !== total || manifest.counts.sections !== index.size)) return null;
  if (total === 0) return null;
  return {
    generatedAtMs,
    buildCommit: String(manifest.buildCommit || ''),
    contentSha256: String(manifest.contentSha256 || ''),
    pageCount: total,
    sectionCount: index.size,
    /** `true` se la pagina (URL o percorso) e' una pagina annuncio attiva pubblicata. */
    has(pathOrUrl) {
      const parts = splitPath(pathOrUrl);
      if (!parts) return false;
      return index.get(parts.dir)?.has(parts.slug) === true;
    },
  };
}
