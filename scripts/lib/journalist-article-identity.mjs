/**
 * Small identity helpers shared by journalist article workflows.
 *
 * Keep this module free of the article-generation pipeline: the post-deploy
 * live notifier only needs to check the registry and normalize a document id.
 * Importing create-article.mjs for those two operations also loads the full
 * generation graph and forces that workflow back to a multi-gigabyte checkout.
 */
import { ARTICLE_REGISTRY_FILES, readSlugRegistry } from './article-slug-registry.mjs';

let articleIdsCache = null;

/** Read the article ids shared by the frontaliere and svizzera namespaces. */
export function getAllArticleIds() {
  if (articleIdsCache) return articleIdsCache;
  const ids = new Set();
  for (const { file, constName } of Object.values(ARTICLE_REGISTRY_FILES)) {
    const registry = readSlugRegistry(new URL(`../../${file}`, import.meta.url), constName);
    for (const id of Object.keys(registry)) ids.add(id);
  }
  articleIdsCache = [...ids];
  return articleIdsCache;
}

/** Invalidate the registry snapshot after an article writer changes either file. */
export function invalidateArticleIdCache() {
  articleIdsCache = null;
}

/** True when an article id is already registered in either article section. */
export function checkArticleIdExists(id) {
  return getAllArticleIds().includes(id);
}

/** Normalize a Firestore journalist document id to the article-id format. */
export function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}
