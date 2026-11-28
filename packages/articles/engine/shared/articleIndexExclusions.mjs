/**
 * Articoli pubblicati ma ritirati dall'indice per mancanza di nesso editoriale.
 *
 * La pagina resta viva e seguibile: niente 404, niente cancellazione. Il ledger
 * dice solo che l'articolo non va proposto ai motori: `noindex,follow` sulla
 * pagina (ogPagesPlugin), fuori dai feed RSS (rssFeeds), fuori dalle sitemap e
 * quindi da sitemap-news e dalla famiglia llms, che dalle sitemap si deriva
 * (`scripts/build-api.mjs` nel corpus).
 *
 * Il file lo genera il corpus (`scripts/audit-article-relevance.mjs`) e vive in
 * `content/`, cosi' risale al sito con `scripts/pull-articles-corpus.mjs`: i due
 * candidati sono i due layout, come per le altre mappe lette dall'engine.
 *
 * File assente → insieme vuoto: e' lo stato legittimo di un checkout che non ha
 * ancora ricevuto il ledger, e di un worktree sparse. File presente ma illeggibile
 * → errore: un insieme vuoto rimetterebbe in indice ogni articolo escluso senza
 * che niente fallisca.
 *
 * Eccezione per domanda: `article-index-demand-keeps.json` (stessa cartella di
 * questo modulo) elenca gli articoli che il ledger ritirerebbe per tema ma che
 * hanno clic GSC reali. Sono sottratti dal ledger qui, una volta, cosi' pagina,
 * RSS e sitemap del corpus decidono tutti allo stesso modo.
 *
 * Modulo `.mjs`, senza dipendenze oltre `node:path`: lo importano l'engine sotto
 * Vite/tsx e gli script CI sotto `node` semplice.
 */

import nodePath from 'node:path';

export const ARTICLE_INDEX_EXCLUSIONS_FILES = Object.freeze([
  'packages/articles/content/article-index-exclusions.json',
  'content/article-index-exclusions.json',
]);

// Canton pages are an always-indexable contract surface. A ledger entry for a
// canton is invalid rather than a silently ignored noindex request.
export const ARTICLE_INDEX_EXCLUSION_SECTIONS = Object.freeze(['frontaliere', 'svizzera']);

export const articleIndexExclusionKey = (section, articleId) => `${section}|${articleId}`;

/**
 * @param {string} raw contenuto del ledger
 * @returns {Set<string>} chiavi `sezione|id`
 */
export function parseArticleIndexExclusions(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.excluded)) {
    throw new Error('article-index-exclusions: manca l\'array `excluded`');
  }
  const keys = new Set();
  for (const row of parsed.excluded) {
    if (typeof row?.section !== 'string' || !row.section || typeof row?.id !== 'string' || !row.id) {
      throw new Error(`article-index-exclusions: riga senza section/id: ${JSON.stringify(row)}`);
    }
    if (!ARTICLE_INDEX_EXCLUSION_SECTIONS.includes(row.section)) {
      throw new Error(`article-index-exclusions: sezione non supportata: ${row.section}`);
    }
    keys.add(articleIndexExclusionKey(row.section, row.id));
  }
  return keys;
}

/**
 * Fail closed when a ledger row no longer identifies a published registry
 * entry. Filtering unknown rows would make a typo look like a successful
 * withdrawal while leaving the article indexed everywhere.
 */
export function assertArticleIndexExclusionsKnown(exclusions, knownKeys) {
  const known = knownKeys instanceof Set ? knownKeys : new Set(knownKeys);
  const unknown = [...exclusions].filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new Error(`article-index-exclusions: identita' non presenti nei registri: ${unknown.join(', ')}`);
  }
  return exclusions;
}

/**
 * Articoli che il ledger ritirerebbe ma che hanno clic GSC reali. Il file sta
 * accanto a questo modulo (`engine/shared/`) in entrambi i layout: da
 * `<root>/packages/articles/content/` o da `<root>/content/` si risale di uno e
 * si scende in `engine/shared/`, quindi ogni consumer del ledger lo trova senza
 * cambiare firma.
 */
export const ARTICLE_INDEX_DEMAND_KEEPS_FILENAME = 'article-index-demand-keeps.json';

/**
 * @param {string} raw contenuto del file keeps
 * @returns {Set<string>} chiavi `sezione|id`
 */
export function parseArticleIndexDemandKeeps(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.keeps)) {
    throw new Error('article-index-demand-keeps: manca l\'array `keeps`');
  }
  const keys = new Set();
  for (const row of parsed.keeps) {
    if (typeof row?.section !== 'string' || !row.section || typeof row?.id !== 'string' || !row.id) {
      throw new Error(`article-index-demand-keeps: riga senza section/id: ${JSON.stringify(row)}`);
    }
    if (!ARTICLE_INDEX_EXCLUSION_SECTIONS.includes(row.section)) {
      throw new Error(`article-index-demand-keeps: sezione non supportata: ${row.section}`);
    }
    keys.add(articleIndexExclusionKey(row.section, row.id));
  }
  return keys;
}

/**
 * @param {{ readFileSync: (file: string, encoding: 'utf-8') => string, existsSync: (file: string) => boolean }} fs
 * @param {readonly string[]} candidates path assoluti, in ordine di risoluzione
 * @returns {Set<string>}
 */
export function loadArticleIndexExclusions(fs, candidates) {
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const excluded = parseArticleIndexExclusions(fs.readFileSync(candidate, 'utf-8'));
    const keepsFile = nodePath.join(nodePath.dirname(candidate), '..', 'engine', 'shared', ARTICLE_INDEX_DEMAND_KEEPS_FILENAME);
    // Absent keeps file = no keeps. Present but unreadable = error: an empty
    // set would silently re-noindex every article that earns clicks.
    if (!fs.existsSync(keepsFile)) return excluded;
    for (const key of parseArticleIndexDemandKeeps(fs.readFileSync(keepsFile, 'utf-8'))) excluded.delete(key);
    return excluded;
  }
  return new Set();
}
