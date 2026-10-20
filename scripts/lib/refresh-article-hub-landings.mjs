// Refresh the eight article-section landing pages from the live shell.
//
// The archive and topic-hub renderers already have a writer on the serving
// path. The root landing pages are different: their editorial shell is owned
// by the site, while the article grid is owned by the corpus. Keeping those
// responsibilities separate lets this repair preserve the shell and replace
// only the data-dependent grid.

import fs from 'node:fs';
import path from 'node:path';

import { ARTICLE_SECTION_CORE } from '../../build-plugins/shared/articleSectionCore.mjs';
import {
  readArticleExcerpts,
  readArticleSlugs,
  readBlogUrlSlugs,
} from '../../packages/articles/engine/shared/articleReaders.ts';
import { parseArticleRegistryEntries } from '../../packages/articles/engine/shared/articleRegistryEntries.ts';
import {
  ensureArticleHubCards,
  renderArticleHubCards,
} from '../../packages/articles/engine/articlesHubCards.ts';
import {
  hasBlogImageLeak,
  rewriteBlogImageRefs,
} from '../../packages/articles/engine/blogImageCdnFinalize.ts';
import { compareArticleSourceDates } from '../../services/articleSourceDates.ts';

export const ARTICLE_HUB_LANDING_LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);
export const ARTICLE_HUB_LANDING_TIMEOUT_MS = 20_000;
const FETCH_HEADERS = Object.freeze({
  'User-Agent': 'frontaliere-article-hub-refresh/1.0',
});

function landingPath(cfg, locale) {
  const prefix = locale === 'it' ? '' : `/${locale}`;
  return `${prefix}/${cfg.indexSlug[locale]}/`;
}

function relativeLandingPath(cfg, locale) {
  return path.posix.join(landingPath(cfg, locale).replace(/^\/+/, ''), 'index.html');
}

function sampleIds(ids) {
  const shown = ids.slice(0, 5).join(', ');
  return ids.length > 5 ? `${shown} (+${ids.length - 5} altri)` : shown;
}

function emptyResult(locales) {
  return {
    written: 0,
    pathsByLocale: Object.fromEntries(locales.map((locale) => [locale, []])),
    cardsByLocale: Object.fromEntries(locales.map((locale) => [locale, 0])),
    errors: [],
  };
}

/**
 * Refresh the root landing for each requested locale.
 *
 * A live shell is required because the landing's editorial copy, navigation,
 * metadata and ad reservations belong to the site shard. Every source needed
 * for the replacement grid is checked before a locale is written. Missing
 * localized metadata, missing localized URL slugs, an unreachable shell, an
 * unbalanced grid, or a missing shell anchor all refuse that page rather than
 * inventing a title/slug or publishing a partial landing.
 *
 * @param {{rootDir: string, distDir: string, section: string,
 *          locales?: readonly string[], siteBase?: string,
 *          fetchImpl?: Function, timeoutMs?: number, logPrefix?: string}} opts
 */
export async function refreshArticleHubLandings(opts) {
  const {
    rootDir,
    distDir,
    section,
    locales = ARTICLE_HUB_LANDING_LOCALES,
    siteBase = process.env.ARTICLE_HUB_SITE_BASE ?? 'https://frontaliereticino.ch',
    fetchImpl = globalThis.fetch,
    timeoutMs = ARTICLE_HUB_LANDING_TIMEOUT_MS,
    logPrefix = '[article-hub-landings]',
  } = opts;
  const result = emptyResult(locales);
  const cfg = ARTICLE_SECTION_CORE[section];

  if (!cfg) {
    result.errors.push(`${section}: unknown article section`);
    return result;
  }
  if (typeof fetchImpl !== 'function') {
    result.errors.push(`${section}: live landing fetch is unavailable`);
    return result;
  }

  let source;
  try {
    source = fs.readFileSync(path.resolve(rootDir, cfg.registryFile), 'utf-8');
  } catch (err) {
    result.errors.push(`${section}: article registry unreadable (${err.message})`);
    return result;
  }

  const articles = parseArticleRegistryEntries(source)
    .map(({ id, category, date, image }) => ({ id, category, date, image }))
    .sort(compareArticleSourceDates);
  if (articles.length === 0) {
    result.errors.push(`${section}: article registry has no renderable entries`);
    return result;
  }

  const cards = articles.slice(0, 100);
  const urlSlugs = readBlogUrlSlugs(
    fs,
    path,
    rootDir,
    cfg.slugDataFile,
    cfg.slugConst,
  );
  const normalizedSiteBase = String(siteBase).replace(/\/$/, '');

  for (const locale of locales) {
    const localeLanding = `${section}/${locale}`;
    const titleById = new Map(
      readArticleSlugs(fs, path, rootDir, locale, cfg.metaPrefix).map(({ slug, title }) => [slug, title]),
    );
    const excerptById = readArticleExcerpts(fs, path, rootDir, locale, cfg.metaPrefix);
    const missingMeta = cards
      .filter((article) => !titleById.get(article.id) || !excerptById.has(article.id))
      .map((article) => article.id);
    if (missingMeta.length > 0) {
      result.errors.push(
        `${localeLanding}: metadata coverage is incomplete for ${sampleIds(missingMeta)}`,
      );
      continue;
    }

    const missingSlugs = cards
      .filter((article) => !urlSlugs[article.id]?.[locale])
      .map((article) => article.id);
    if (missingSlugs.length > 0) {
      result.errors.push(
        `${localeLanding}: localized URL slugs are incomplete for ${sampleIds(missingSlugs)}`,
      );
      continue;
    }

    const sectionSlug = cfg.indexSlug[locale];
    if (!sectionSlug) {
      result.errors.push(`${localeLanding}: section landing slug is missing`);
      continue;
    }

    const localePrefix = locale === 'it' ? '' : locale;
    const cardsHtml = renderArticleHubCards({
      articles: cards,
      locale,
      sectionSlug,
      localePrefix,
      resolveSlug: (id) => urlSlugs[id]?.[locale],
      resolveMeta: (id) => ({
        title: titleById.get(id),
        desc: excerptById.get(id),
      }),
    });

    const urlPath = landingPath(cfg, locale);
    const url = `${normalizedSiteBase}${urlPath}`;
    let liveHtml;
    try {
      const response = await fetchImpl(url, {
        headers: FETCH_HEADERS,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response?.ok) {
        throw new Error(`HTTP ${response?.status ?? 'unknown'}`);
      }
      liveHtml = await response.text();
    } catch (err) {
      result.errors.push(`${localeLanding}: live shell unavailable (${err.message})`);
      continue;
    }

    const refreshed = ensureArticleHubCards(liveHtml, cardsHtml, locale);
    if (refreshed === null) {
      result.errors.push(
        `${localeLanding}: live shell has no balanced article grid or safe shell navigation anchor`,
      );
      continue;
    }

    const finalHtml = rewriteBlogImageRefs(refreshed);
    if (hasBlogImageLeak(finalHtml)) {
      result.errors.push(`${localeLanding}: rendered cards still contain a same-origin blog image`);
      continue;
    }

    const relPath = relativeLandingPath(cfg, locale);
    const absPath = path.join(distDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, finalHtml, 'utf-8');
    result.pathsByLocale[locale].push(relPath);
    result.cardsByLocale[locale] = cards.length;
    result.written += 1;
    console.log(`${logPrefix} ${localeLanding}: landing refreshed (${cards.length} cards)`);
  }

  return result;
}
