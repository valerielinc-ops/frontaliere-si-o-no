/**
 * Article rename → redirect bridges: the DATA half of a mechanism whose CODE
 * half already existed (issue #5352).
 *
 * **Read this before designing anything new here.** The site already redirects
 * renamed article URLs, and has done so in production for months:
 * `build-plugins/legacyRedirectsPlugin.ts` emits, for every `from → to` pair in
 * its map, a bridge page carrying `noindex,follow` + `<link rel="canonical">`
 * to the new URL + a 0s meta-refresh — the shape the owner chose in issue #2996
 * as this site's 301-equivalent, and the same shape `cantonOrphanRedirectsPlugin`
 * and `cfHot404BridgePlugin` use. Verified live on 2026-08-10 for article
 * renames that already went through it:
 *
 *   /articoli-frontaliere/tassa-transito-svizzera-2023/      → 200 noindex,follow
 *       canonical → /articoli-frontaliere/tassa-transito-svizzera-2026/
 *   /en/cross-border-articles/transit-fee-switzerland-2023/  → 200 noindex,follow
 *   /articoli-frontaliere/naspi-disoccupazione-frontalieri/  → 200 noindex,follow
 *
 * So the gap issue #5352 describes is NOT "no redirect mechanism for articles".
 * It is narrower, and this module closes exactly it:
 *
 *  1. the only entry point was a **hand-edited TypeScript literal inside a
 *     build plugin**, so a rename meant a code change in the build graph;
 *  2. `data/article-redirects.json` — the data file created for this purpose in
 *     commit 393411f5 (2026-05-27) — had **no reader at all**. It stayed `{}`
 *     for its whole life because nothing consumed it, so nothing rewarded
 *     filling it in;
 *  3. its only writer, `scripts/manage-article.mjs`'s `addRedirectMapping`,
 *     produced wrong keys (locale-independent slug lookup + a hardcoded
 *     `/{loc}/articoli-frontaliere/` prefix that is a real URL in exactly one
 *     of the four locales, and never for svizzera-section articles).
 *
 * The fix is deliberately NOT a second redirect mechanism — two of those are
 * worse than one. This module only parses and validates the data file;
 * `legacyRedirectsPlugin` merges the result into the same map it already had,
 * and every emitted byte comes from the existing bridge builder.
 *
 * **Why the validation is fail-closed.** A redirect map is write-once,
 * read-never: a malformed entry produces no error at runtime, it produces a
 * page that quietly does not exist (or, worse, a bridge pointing at a 404).
 * The three failures that are invisible in production and cheap here are:
 * a `to` that is not an article URL, a cross-locale pair (which breaks the
 * hreflang cluster of both articles), and a chain `a → b → c` (Googlebot
 * follows one hop of a soft redirect reliably, not two). All three throw.
 *
 * `.mjs`, not `.ts`, for the same reason as its neighbour
 * `articleSectionCore.mjs`: it must load unchanged in BOTH the Vite-bundled
 * build-plugin graph (`legacyRedirectsPlugin.ts`) and raw `node` CI scripts
 * with no TS loader (`scripts/manage-article.mjs`).
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { ARTICLE_SECTION_CORE_LIST } from './articleSectionCore.mjs';

/** Repo-relative path of the redirect map. */
export const ARTICLE_REDIRECTS_FILE = 'data/article-redirects.json';

/** The four content locales, in canonical order. `it` carries no URL prefix. */
export const ARTICLE_LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);

/**
 * @typedef {Object} ArticlePathParts
 * @property {string} locale   One of {@link ARTICLE_LOCALES}.
 * @property {'frontaliere'|'svizzera'} section
 * @property {string} slug     The article slug, no slashes.
 * @property {string} path     The normalized path, always trailing-slashed.
 */

/**
 * Every article-detail URL prefix that exists, derived from
 * `ARTICLE_SECTION_CORE` so a renamed section slug cannot desync this map
 * (AGENTS.md #6). Eight entries: 2 sections × 4 locales.
 *
 * @returns {Map<string, {locale: string, section: 'frontaliere'|'svizzera'}>}
 */
export function articleSectionPrefixes() {
  /** @type {Map<string, {locale: string, section: 'frontaliere'|'svizzera'}>} */
  const out = new Map();
  for (const { section, indexSlug } of ARTICLE_SECTION_CORE_LIST) {
    for (const locale of ARTICLE_LOCALES) {
      const hub = indexSlug[locale];
      const prefix = locale === 'it' ? `/${hub}/` : `/${locale}/${hub}/`;
      out.set(prefix, { locale, section });
    }
  }
  return out;
}

/** Add the trailing slash the whole redirect pipeline assumes. */
export function withTrailingSlash(p) {
  if (typeof p !== 'string' || p.length === 0) return p;
  return p.endsWith('/') ? p : `${p}/`;
}

/**
 * Parse an article-DETAIL path. Returns `null` for anything else — including
 * the section hubs themselves (`/articoli-frontaliere/`), which must never be
 * a rename endpoint: a hub is not a renamed article, and bridging an article
 * to its hub is the section-level fallback `searchConsoleCompat` already owns.
 *
 * @param {unknown} p
 * @returns {ArticlePathParts | null}
 */
export function parseArticlePath(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) return null;
  if (/[?#\s]/.test(p) || p.includes('//')) return null;
  const norm = withTrailingSlash(p);
  for (const [prefix, meta] of articleSectionPrefixes()) {
    if (!norm.startsWith(prefix)) continue;
    const slug = norm.slice(prefix.length, -1);
    // Deliberately a DENYLIST, not an alphabet allowlist. The first version of
    // this function required `^[a-z0-9][a-z0-9-]*$`, which reads like an
    // obviously-safe slug rule and is wrong about this corpus: measured against
    // the 15.356 published article paths, it rejects 93 of them —
    //   · 89 with accented lowercase (ß à ä è é ê ï ô ö ü): the whole DE/FR
    //     side, e.g. `naspi-ehemalige-grenzgänger-2026`, `ristournes-gelées-tessin-italie`;
    //   · 3 with underscores: `coop_calls_back_cheese_salmonella` + siblings;
    //   · 1 with an uppercase letter: `san-gottardo-Code-good-friday`.
    // Since `loadArticleRedirects` throws by design, an allowlist here does not
    // reject one entry — it kills the whole production build the day anybody
    // renames one of those 93 articles. `tests/article-rename-redirects.test.ts`
    // pins this by parsing every published path, so the rule cannot drift away
    // from the corpus again.
    //
    // What is actually worth refusing is the shape that is not a slug at all:
    // empty, a nested path, or path traversal. Everything else is settled by a
    // check no regex can do — the truth table against the published registries.
    if (!slug || slug === '.' || slug === '..') return null;
    if (/[\\/\s?#]/.test(slug)) return null;
    return { locale: meta.locale, section: meta.section, slug, path: norm };
  }
  return null;
}

/**
 * Validate a raw parsed `article-redirects.json` object and return it
 * normalized (trailing slashes on both sides). Throws on the first offender
 * with a message naming it — see the module header for why this is
 * fail-closed rather than skip-and-warn.
 *
 * @param {unknown} raw
 * @param {{ file?: string }} [opts]
 * @returns {Record<string, string>}
 */
export function parseArticleRedirects(raw, opts = {}) {
  const file = opts.file ?? ARTICLE_REDIRECTS_FILE;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${file}: deve contenere un oggetto JSON { "<vecchia URL>": "<nuova URL>" }`);
  }

  /** @type {Record<string, string>} */
  const out = {};
  /** @type {Set<string>} */
  const targets = new Set();

  for (const [fromRaw, toRaw] of Object.entries(raw)) {
    const from = parseArticlePath(fromRaw);
    if (!from) {
      throw new Error(
        `${file}: la chiave ${JSON.stringify(fromRaw)} non e' una URL di articolo. ` +
        `Attese: ${[...articleSectionPrefixes().keys()].join(', ')}<slug>/`,
      );
    }
    if (typeof toRaw !== 'string') {
      throw new Error(`${file}: il valore di ${from.path} deve essere una stringa, non ${typeof toRaw}`);
    }
    const to = parseArticlePath(toRaw);
    if (!to) {
      throw new Error(`${file}: il valore ${JSON.stringify(toRaw)} (chiave ${from.path}) non e' una URL di articolo`);
    }
    if (from.locale !== to.locale) {
      throw new Error(
        `${file}: ${from.path} → ${to.path} attraversa i locali (${from.locale} → ${to.locale}). ` +
        'Un rename e\' within-locale: un bridge cross-locale rompe il cluster hreflang di entrambi gli articoli.',
      );
    }
    if (from.path === to.path) {
      throw new Error(`${file}: ${from.path} redirige a se stessa`);
    }
    if (Object.prototype.hasOwnProperty.call(out, from.path)) {
      throw new Error(`${file}: ${from.path} e' dichiarata due volte (le due forme con e senza slash finale coincidono)`);
    }
    out[from.path] = to.path;
    targets.add(to.path);
  }

  for (const from of Object.keys(out)) {
    if (targets.has(from)) {
      throw new Error(
        `${file}: catena di redirect su ${from} (e' insieme sorgente e destinazione). ` +
        'Ogni vecchia URL deve puntare DIRETTAMENTE alla URL finale.',
      );
    }
  }

  return out;
}

/** Where the hand-authored half of the redirect map lives. */
export const LEGACY_REDIRECTS_SOURCE = 'build-plugins/legacyRedirectsPlugin.ts';

/**
 * Fewer pairs than this means the scan below stopped matching, not that the map
 * shrank: it has 156 today and only ever grows. A scan that silently finds
 * nothing would make every cross-source check pass vacuously.
 */
const HARDCODED_SCAN_FLOOR = 50;

/**
 * The hand-authored redirect map, read from the plugin's SOURCE TEXT.
 *
 * Not by importing it: `legacyRedirectsPlugin` pulls in `constants.ts` and
 * `searchConsoleCompat.ts`, which `import` a dozen files under `data/` and
 * `public/assets/` at module scope. `data/` alone is 1.7 GB and is absent from
 * every sparse worktree in this repo (CLAUDE.md), so an import would make every
 * consumer of this function red locally and green in CI. The scan matches only
 * the single-quoted `'/from/': '/to/',` pairs of the literal — the one entry
 * built with a template literal (`/job-board/`) is deliberately out of reach,
 * and it is a job path, which no article redirect can ever collide with.
 *
 * @param {string} rootDir
 * @param {{ readFileSync?: typeof readFileSync }} [io]
 * @returns {Record<string, string>} normalized `from` → `to`
 */
export function readHardcodedRedirects(rootDir, io = {}) {
  const readFile = io.readFileSync ?? readFileSync;
  const src = String(readFile(path.join(rootDir, LEGACY_REDIRECTS_SOURCE), 'utf-8'));
  /** @type {Record<string, string>} */
  const out = {};
  let n = 0;
  let dynamic = 0;
  /** @type {string[]} */
  const unsupported = [];

  // One pass that classifies EVERY line shaped like a map key, instead of a
  // regex that quietly matches a subset. A canary on the total ("more than 50")
  // only catches a scan that broke completely; it says nothing about a scan
  // that silently skips the twenty entries someone reformatted. Here a key line
  // this parser cannot read is an error, not an absence:
  //   group 2 = key, group 3 = single-quoted path value (a pair),
  //   group 4 = backtick (a computed value — one exists today, `/job-board/`,
  //   whose target is resolveCantonSection(); it is a job path and can never
  //   collide with an article redirect), group 5 = anything else.
  for (const m of src.matchAll(/^[ \t]*(['"])(\/[^'"\n]*)\1\s*:\s*(?:'(\/[^'\n]*)'|(`)|(\S))/gm)) {
    if (m[3] !== undefined) {
      out[withTrailingSlash(m[2])] = withTrailingSlash(m[3]);
      n++;
    } else if (m[4] !== undefined) {
      dynamic++;
    } else {
      unsupported.push(m[2]);
    }
  }

  if (unsupported.length > 0) {
    throw new Error(
      `${LEGACY_REDIRECTS_SOURCE}: ${unsupported.length} voci con un valore che questo scan non sa leggere ` +
      `(atteso '/percorso/' fra apici singoli): ${unsupported.join(', ')}. ` +
      'Sono redirect reali che verrebbero esclusi in silenzio dai controlli sulle catene: ' +
      'aggiornare lo scan, non ignorarle.',
    );
  }
  if (n < HARDCODED_SCAN_FLOOR) {
    throw new Error(
      `${LEGACY_REDIRECTS_SOURCE}: lo scan ha trovato ${n} coppie (< ${HARDCODED_SCAN_FLOOR}). ` +
      'La mappa e\' stata rifattorizzata e questo scan non la legge piu\': aggiornarlo, ' +
      'non abbassare la soglia — un controllo che scansiona il vuoto passa sempre.',
    );
  }
  return out;
}

/**
 * @typedef {Object} CrossSourceChain
 * @property {string} from  La URL piu' vecchia della catena.
 * @property {string} via   L'anello di mezzo: e' `to` di un lato e `from` dell'altro.
 * @property {string} to    La destinazione finale.
 * @property {'hardcoded-into-data'|'data-into-hardcoded'} kind Quale lato apre la catena.
 */

/**
 * Catene di redirect che attraversano le DUE fonti (issue #5352, review round 1).
 *
 * `parseArticleRedirects` vieta le catene **dentro** il file dati, ma le due
 * mappe si fondono in una sola prima dell'emissione, e una catena si forma
 * altrettanto bene a cavallo:
 *
 *   hardcoded `X → A`  +  dati `A → B`   ⇒  X → A → B
 *   dati `A → B`       +  hardcoded `B → C`  ⇒  A → B → C
 *
 * Il primo caso non e' ipotetico: 34 delle 156 coppie hardcoded sono
 * articolo → articolo, quindi 34 bersagli che un rename futuro puo' spostare.
 * Quattro di quei bersagli hanno **3 sorgenti a testa** (il gruppo
 * `frontalieri-ticino-*-2025`, in tutti e quattro i locali), quindi un solo
 * rename ne aprirebbe 12 in un colpo.
 *
 * Perche' e' peggio di una catena di 301: questi non sono 301, sono pagine 200
 * `noindex` con un canonical. Un canonical che punta a una pagina `noindex` non
 * inoltra il segnale, lo **uccide** — la URL piu' vecchia smette di consolidare
 * su chiunque. Un 301 → 301 almeno arriva.
 *
 * @param {Record<string, string>} hardcoded
 * @param {Record<string, string>} data
 * @returns {CrossSourceChain[]}
 */
export function findCrossSourceChains(hardcoded, data) {
  /** @type {Map<string, string>} from → to */
  const hardFrom = new Map();
  /** @type {Map<string, string[]>} to → [from…] — un bersaglio puo' avere piu' sorgenti */
  const hardTo = new Map();
  for (const [rawFrom, rawTo] of Object.entries(hardcoded)) {
    const from = withTrailingSlash(rawFrom);
    const to = withTrailingSlash(rawTo);
    hardFrom.set(from, to);
    if (!hardTo.has(to)) hardTo.set(to, []);
    hardTo.get(to).push(from);
  }

  /** @type {CrossSourceChain[]} */
  const out = [];
  for (const [rawFrom, rawTo] of Object.entries(data)) {
    const from = withTrailingSlash(rawFrom);
    const to = withTrailingSlash(rawTo);
    // dati `from → to`, hardcoded `to → C`
    if (hardFrom.has(to)) {
      out.push({ from, via: to, to: hardFrom.get(to), kind: 'data-into-hardcoded' });
    }
    // hardcoded `X → from`, dati `from → to` — tutte le X, non solo la prima
    for (const x of hardTo.get(from) ?? []) {
      out.push({ from: x, via: from, to, kind: 'hardcoded-into-data' });
    }
  }
  return out;
}

/**
 * Catene DENTRO una sola mappa: `X → A` e `A → B` dichiarate entrambe qui.
 *
 * `findCrossSourceChains` guarda **fra** le due fonti e per costruzione non
 * vede questa forma. Serve, e non per simmetria: al momento in cui e' stata
 * scritta la mappa hardcoded ne conteneva **due**, entrambe su URL di
 * produzione, entrambe nate nello stesso modo — un batch successivo ha
 * ripuntato l'anello di mezzo e nessuno e' tornato a guardare chi ci puntava
 * dentro (issue #5352, review round 3):
 *
 *   /comparatori/traffico-valichi/       → /statistiche/traffico-dogane/            → /guida-frontaliere/tempi-attesa-dogana/
 *   /fr/primes-assurance-maladie/ticino/ → /fr/primes-assurance-maladie-communes/…  → /fr/statistiques/primes-assurance-maladie-communes/
 *
 * Misurate live prima della fix: 200 `noindex,follow` → 200 `noindex,follow` →
 * 200 `index,follow`. Cioe' esattamente il difetto che questa PR descrive, gia'
 * in produzione. Con i tre controlli — dati×dati (`parseArticleRedirects`),
 * hardcoded×hardcoded (questo) e hardcoded×dati (`findCrossSourceChains`) — la
 * mappa finale non puo' piu' contenere due hop da nessuna combinazione.
 *
 * @param {Record<string, string>} map
 * @returns {Array<{from: string, via: string, to: string}>}
 */
export function findInternalChains(map) {
  /** @type {Map<string, string>} */
  const byFrom = new Map();
  for (const [f, t] of Object.entries(map)) byFrom.set(withTrailingSlash(f), withTrailingSlash(t));

  const out = [];
  for (const [from, via] of byFrom) {
    const to = byFrom.get(via);
    if (to === undefined || via === from) continue;
    out.push({ from, via, to });
  }
  return out;
}

/**
 * @param {Record<string, string>} map
 * @param {{ file?: string }} [opts]
 */
export function assertNoInternalChains(map, opts = {}) {
  const file = opts.file ?? LEGACY_REDIRECTS_SOURCE;
  const chains = findInternalChains(map);
  if (chains.length === 0) return;

  const lines = chains.map(({ from, via, to }) =>
    `  ${from}\n    → ${via}   (a sua volta reindirizzata)\n    → ${to}\n` +
    `    rimedio: '${from}': '${to}',`,
  );
  throw new Error(
    `${file}: ${chains.length} catena/e di redirect dentro la stessa mappa.\n` +
    'Il primo bridge manda il canonical su una pagina 200 `noindex`, che non inoltra il\n' +
    'segnale: la URL piu\' vecchia smette di consolidare su qualunque cosa. Ogni voce deve\n' +
    'puntare DIRETTAMENTE alla destinazione finale.\n' +
    lines.join('\n'),
  );
}

/**
 * Fa fallire il build (e prima ancora la CI e il writer) su una catena a cavallo
 * delle due fonti, con il rimedio scritto per esteso: la voce hardcoded va
 * ripuntata sulla destinazione finale, cosi' la catena torna a un hop solo.
 *
 * Volutamente NON risolve la catena da sola riscrivendo il bersaglio: sarebbe
 * una mutazione silenziosa, a build time, di redirect gia' deployati. Che sia
 * una modifica visibile in review della mappa e' il punto.
 *
 * @param {Record<string, string>} hardcoded
 * @param {Record<string, string>} data
 * @param {{ file?: string }} [opts]
 */
export function assertNoCrossSourceChains(hardcoded, data, opts = {}) {
  const file = opts.file ?? ARTICLE_REDIRECTS_FILE;
  const chains = findCrossSourceChains(hardcoded, data);
  if (chains.length === 0) return;

  const lines = chains.map(({ from, via, to, kind }) => {
    const first = kind === 'hardcoded-into-data' ? LEGACY_REDIRECTS_SOURCE : file;
    const second = kind === 'hardcoded-into-data' ? file : LEGACY_REDIRECTS_SOURCE;
    return (
      `  ${from}\n` +
      `    → ${via}   (${first})\n` +
      `    → ${to}   (${second})\n` +
      `    rimedio: in ${LEGACY_REDIRECTS_SOURCE} riscrivi\n` +
      `      '${kind === 'hardcoded-into-data' ? from : via}': '${to}',`
    );
  });

  throw new Error(
    `${file}: ${chains.length} catena/e di redirect attraverso le due fonti.\n` +
    'Le due mappe si fondono in una sola prima dell\'emissione, quindi una catena a cavallo\n' +
    'e\' una catena. E qui pesa piu\' che con i 301: il bridge intermedio e\' una pagina 200\n' +
    '`noindex` con canonical, e un canonical verso una pagina noindex non inoltra il segnale,\n' +
    'lo perde. Ogni vecchia URL deve puntare DIRETTAMENTE alla destinazione finale.\n' +
    lines.join('\n'),
  );
}

/**
 * Read + validate `data/article-redirects.json` under `rootDir`.
 *
 * A missing file yields `{}` **with a warning**, never a throw: `data/` is
 * absent from every sparse worktree in this repo (see CLAUDE.md), and a build
 * plugin must not die there. The file's PRESENCE is asserted by
 * `tests/article-rename-redirects.test.ts`, which runs on a full checkout —
 * that is what keeps "no file" from silently reading as "no redirects".
 *
 * @param {string} rootDir
 * @param {{ existsSync?: typeof existsSync, readFileSync?: typeof readFileSync, warn?: (msg: string) => void }} [io]
 * @returns {Record<string, string>}
 */
export function loadArticleRedirects(rootDir, io = {}) {
  const exists = io.existsSync ?? existsSync;
  const readFile = io.readFileSync ?? readFileSync;
  const warn = io.warn ?? ((msg) => console.warn(msg));

  const abs = path.join(rootDir, ARTICLE_REDIRECTS_FILE);
  if (!exists(abs)) {
    warn(`\x1b[33m[article-redirects]\x1b[0m ${ARTICLE_REDIRECTS_FILE} assente — nessun bridge di rename emesso.`);
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(String(readFile(abs, 'utf-8')));
  } catch (err) {
    throw new Error(`${ARTICLE_REDIRECTS_FILE}: JSON non valido — ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseArticleRedirects(parsed);
}

/**
 * Every article-detail path currently PUBLISHED, read from the two slug
 * registries under `packages/articles/content/` (via the `slugDataFile` of
 * `ARTICLE_SECTION_CORE`, which are symlinks into that corpus copy).
 *
 * Used by the tests to decide, for each redirect entry, which phase of a
 * rename it is in — see the truth table in
 * `tests/article-rename-redirects.test.ts`. Deliberately NOT used by the build
 * plugin: during the window between the corpus rename landing and the site's
 * next `pull-articles-api.mjs` sync, `from` is still live, and the plugin
 * already handles that correctly by refusing to overwrite an existing page.
 *
 * @param {string} rootDir
 * @param {{ existsSync?: typeof existsSync, readFileSync?: typeof readFileSync }} [io]
 * @returns {{ paths: Set<string>, scanned: string[], missing: string[] }}
 */
export function readPublishedArticlePaths(rootDir, io = {}) {
  const exists = io.existsSync ?? existsSync;
  const readFile = io.readFileSync ?? readFileSync;

  /** @type {Set<string>} */
  const paths = new Set();
  /** @type {string[]} */
  const scanned = [];
  /** @type {string[]} */
  const missing = [];

  for (const { indexSlug, slugDataFile, slugConst } of ARTICLE_SECTION_CORE_LIST) {
    const abs = path.join(rootDir, slugDataFile);
    if (!exists(abs)) {
      missing.push(slugDataFile);
      continue;
    }
    const src = String(readFile(abs, 'utf-8'));
    // Same shape/regex convention as manage-article.mjs's parseSectionSlugs and
    // scripts/ci/check-blog-slugs-sitemap-sync.mjs's parseSlugsConst.
    const block = src.match(new RegExp(`const ${slugConst}[\\s\\S]*?\\n\\};`, 'm'))?.[0] ?? '';
    const rx = /["'][^"']+["']:\s*\{\s*it:\s*["']([^"']+)["'],\s*en:\s*["']([^"']+)["'],\s*de:\s*["']([^"']+)["'],\s*fr:\s*["']([^"']+)["']/g;
    let m;
    let count = 0;
    while ((m = rx.exec(block)) !== null) {
      const bySlug = { it: m[1], en: m[2], de: m[3], fr: m[4] };
      for (const locale of ARTICLE_LOCALES) {
        const hub = indexSlug[locale];
        const prefix = locale === 'it' ? `/${hub}/` : `/${locale}/${hub}/`;
        paths.add(`${prefix}${bySlug[locale]}/`);
      }
      count++;
    }
    scanned.push(`${slugDataFile} (${count})`);
  }

  return { paths, scanned, missing };
}
