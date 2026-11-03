/**
 * Small identity helpers shared by journalist article workflows.
 *
 * Keep this module free of the article-generation pipeline: the post-deploy
 * live notifier only needs to check the registry and normalize a document id.
 * Importing create-article.mjs for those two operations also loads the full
 * generation graph and forces that workflow back to a multi-gigabyte checkout.
 */
import { readFileSync } from 'node:fs';

const ARTICLE_REGISTRIES = Object.freeze([
  {
    relativePath: 'packages/articles/content/routerBlogData.ts',
    constName: 'BLOG_SLUGS',
  },
  {
    relativePath: 'packages/articles/content/routerSwissData.ts',
    constName: 'SWISS_SLUGS',
  },
]);

const ARTICLE_ENTRY_RE = /^\s+(['"])([^'"]+)\1:\s*\{/gm;

/** Extract one registry object without importing a site-only helper. */
export function extractRegistryObject(source, constName) {
  const declaration = new RegExp(`\\bconst\\s+${constName}\\b[^=]*=\\s*\\{`).exec(source);
  if (!declaration) return '';
  const open = declaration.index + declaration[0].length - 1;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  return '';
}

let articleIdsCache = null;

/** Read the article ids shared by the frontaliere and svizzera namespaces. */
export function getAllArticleIds() {
  if (articleIdsCache) return articleIdsCache;
  const ids = new Set();
  for (const { relativePath, constName } of ARTICLE_REGISTRIES) {
    let registrySource = '';
    try {
      registrySource = readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
    } catch {
      // Keep the same fail-closed behavior as the generation pipeline: a
      // missing registry cannot make an id appear to be already registered.
    }
    const block = extractRegistryObject(registrySource, constName);
    for (const match of block.matchAll(ARTICLE_ENTRY_RE)) ids.add(match[2]);
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
