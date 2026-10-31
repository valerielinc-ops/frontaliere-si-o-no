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
 * Modulo puro, `.mjs` e senza dipendenze: lo importano l'engine sotto Vite/tsx e
 * gli script CI sotto `node` semplice.
 */

export const ARTICLE_INDEX_EXCLUSIONS_FILES = Object.freeze([
  'packages/articles/content/article-index-exclusions.json',
  'content/article-index-exclusions.json',
]);

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
    return parseArticleIndexExclusions(fs.readFileSync(candidate, 'utf-8'));
  }
  return new Set();
}
