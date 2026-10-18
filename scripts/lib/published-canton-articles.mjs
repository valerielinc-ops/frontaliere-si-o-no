import fs from 'node:fs';
import path from 'node:path';

import { coverKey } from '../../packages/articles/engine/shared/imageCredits.mjs';

export const PUBLISHED_CANTON_ARTICLES_ARTIFACT = 'canton-articles.json';
export const PUBLISHED_CANTON_ARTICLES_PATH = path.join('public', PUBLISHED_CANTON_ARTICLES_ARTIFACT);

export function parsePublishedCantonArticles(
  raw,
  { label = 'published canton article registry', expectedCommit = null, expectedCount = null } = {},
) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(payload)) throw new Error(`${label} must be a JSON array`);
  if (expectedCount !== null && payload.length !== expectedCount) {
    throw new Error(`${label} contains ${payload.length} articles, manifest says ${expectedCount}`);
  }

  const ids = new Set();
  return payload.map((article, index) => {
    if (!article || typeof article !== 'object' || Array.isArray(article)) {
      throw new Error(`${label}[${index}] is not an object`);
    }
    const id = typeof article.id === 'string' ? article.id.trim() : '';
    const section = typeof article.section === 'string' ? article.section.trim() : '';
    const image = typeof article.image === 'string' ? article.image.trim() : '';
    const isSharedPlaceFallback = image === '/images/places/lugano-view.webp';
    if (!id) throw new Error(`${label}[${index}] has no id`);
    if (ids.has(id)) throw new Error(`${label} contains duplicate article id ${id}`);
    ids.add(id);
    if (!/^canton-[a-z0-9-]+$/.test(section)) {
      throw new Error(`${label}[${index}] has invalid section ${section || '(empty)'}`);
    }
    if (!isSharedPlaceFallback
      && (!/^\/images\/blog\/[a-z0-9][a-z0-9._-]*\.webp$/.test(image) || !coverKey(image))) {
      throw new Error(`${label}[${index}] has invalid blog image ${image || '(empty)'}`);
    }
    if (typeof article.commit !== 'string' || !/^[0-9a-f]{40}$/.test(article.commit)) {
      throw new Error(`${label}[${index}] has an invalid commit pin`);
    }
    if (expectedCommit !== null && article.commit !== expectedCommit) {
      throw new Error(`${label}[${index}] does not match manifest commit ${expectedCommit}`);
    }
    // Canton indexes also carry this shared editorial fallback for event pages;
    // it is a place asset, not an article hero to enter into the blog ledger.
    if (isSharedPlaceFallback) return null;
    return {
      section,
      id,
      image,
      category: typeof article.category === 'string' ? article.category : null,
      date: typeof article.date === 'string' ? article.date : null,
      updatedAt: typeof article.updatedAt === 'string' ? article.updatedAt : null,
      authorSlug: typeof article.authorSlug === 'string' ? article.authorSlug : null,
    };
  }).filter(Boolean);
}

export function readPublishedCantonArticles(root, { optional = false, ...options } = {}) {
  const artifact = readPublishedCantonArticlesArtifact(root, { optional, ...options });
  return artifact?.articles || [];
}

export function readPublishedCantonArticlesArtifact(root, { optional = false, ...options } = {}) {
  const file = path.join(root, PUBLISHED_CANTON_ARTICLES_PATH);
  if (!fs.existsSync(file)) {
    if (optional) return null;
    throw new Error(`${file} is required`);
  }
  const raw = fs.readFileSync(file, 'utf8');
  const articles = parsePublishedCantonArticles(raw, { label: file, ...options });
  const payload = JSON.parse(raw);
  return {
    raw,
    articleCount: payload.length,
    articles,
  };
}
