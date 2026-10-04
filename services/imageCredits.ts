/**
 * Credits of the Wikimedia Commons cover photos, for the SPA article page (P14).
 *
 * The static article page reads one credit record per cover file from disk
 * (packages/articles/engine/shared/imageCredits.mjs). The SPA cannot: the
 * records live in the corpus, and the boundary between site and corpus is
 * JSON over HTTP. So the corpus publishes a compact copy per section next to
 * its blog index (frontaliere-articles `scripts/build-blog-index.mjs`, same
 * upload, `public,max-age=600`):
 *
 *   data/image-credits-<section>.json
 *   { schema: 1, commit, section,
 *     files:  { <Commons title>: { pageUrl, author{name,url,type}, attribution,
 *                                  licence{name,url,family,attributionRequired}, fetchedAt } },
 *     covers: { <cover key>: { file: <Commons title>, modified } } }
 *
 * Fetched in the background, so a credit added to a fresh article reaches the
 * page within minutes instead of waiting for a site deploy. For one cover this
 * module rebuilds the record the engine's projections read (`imageCreditParts`,
 * `imageObjectCreditFields`) and validates it with the engine's own validator,
 * so the SPA accepts exactly what the static page would.
 *
 * FAIL-OPEN, like the article overlay (services/articlesOverlay.ts): a missing
 * file, a bad status, malformed JSON, a timeout, an unknown shape or an entry
 * that does not validate all resolve to `null`, and the article renders as it
 * did before — no credit line, and the JSON-LD keeps what it had.
 */

import { cdnDataUrl, cdnFreshUrl } from '@/services/cdnDataBase';
import type { ArticleSection } from '@/services/articleSections';
import { imageObjectLd, isSiteOrganizationCreator } from '@/services/seo/imageObjectLd';
import {
  coverKey,
  imageObjectCreditFields,
  validateImageCreditRecord,
  type ImageCreditRecord,
} from '@/packages/articles/engine/shared/imageCredits.mjs';

/** Schema of the published file this module understands. */
const IMAGE_CREDITS_INDEX_SCHEMA = 1;

/** Beyond this the fetch is abandoned — same budget as the article overlay. */
const TIMEOUT_MS = 4000;

/** The published file, as far as this module checks it before a lookup. */
export interface ImageCreditsIndex {
  schema: 1;
  commit: string | null;
  section: ArticleSection;
  files: Record<string, unknown>;
  covers: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Own keys only: a cover or file named like an Object.prototype member is just absent. */
function ownValue(object: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined;
}

function isImageCreditsIndex(body: unknown, section: ArticleSection): body is ImageCreditsIndex {
  return isPlainObject(body)
    && body.schema === IMAGE_CREDITS_INDEX_SCHEMA
    && body.section === section
    && isPlainObject(body.files)
    && isPlainObject(body.covers);
}

/** One fetch of a section's file. `null` on any problem. */
async function loadImageCredits(section: ArticleSection): Promise<ImageCreditsIndex | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // cdnFreshUrl, not the bare path: the corpus rewrites this file between
    // site deploys, and only a different url reaches a fresh edge copy (see
    // cdnDataBase.ts).
    const res = await fetch(cdnFreshUrl(cdnDataUrl(`/data/image-credits-${section}.json`)), { signal: controller.signal });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isImageCreditsIndex(body, section) ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const pendingBySection = new Map<ArticleSection, Promise<ImageCreditsIndex | null>>();

/**
 * The credits file of a section, fetched once per session and shared by every
 * caller. A failure is not remembered: the next article view asks again, so a
 * slow network on the first article does not cost the credits of every other.
 */
export function fetchImageCredits(section: ArticleSection): Promise<ImageCreditsIndex | null> {
  const known = pendingBySection.get(section);
  if (known) return known;
  const pending = loadImageCredits(section);
  pendingBySection.set(section, pending);
  void pending.then((index) => {
    if (index === null && pendingBySection.get(section) === pending) pendingBySection.delete(section);
  });
  return pending;
}

/**
 * The credit record of one cover, rebuilt from the published file, or `null`
 * when the file has none or the entry does not validate.
 *
 * The cover is matched by its key (`/images/blog/<key>.<ext>`), so the CDN URL
 * the SPA registry carries and the site path the static page uses find the
 * same record. The published copy keeps only what the line and the
 * ImageObject show; the record fields it leaves out (`author.text`,
 * `restrictions`, `curation`, the Commons ids) are set empty here — neither
 * projection reads them.
 */
export function imageCreditFromIndex(index: ImageCreditsIndex, cover: string | null | undefined): ImageCreditRecord | null {
  const key = coverKey(cover);
  if (!key || typeof cover !== 'string') return null;
  const entry = ownValue(index.covers, key);
  if (!isPlainObject(entry) || typeof entry.file !== 'string') return null;
  const file = ownValue(index.files, entry.file);
  if (!isPlainObject(file) || !isPlainObject(file.author) || !isPlainObject(file.licence)) return null;
  // The site path of this cover, whatever host or query the caller's URL had.
  const sitePath = cover.slice(cover.lastIndexOf('/images/blog/')).replace(/[?#].*$/, '');
  const record = {
    schema: 1,
    cover: sitePath,
    source: 'wikimedia-commons',
    commons: { title: entry.file, pageUrl: file.pageUrl },
    author: { text: null, name: file.author.name, url: file.author.url, type: file.author.type },
    attribution: file.attribution,
    licence: {
      name: file.licence.name,
      url: file.licence.url,
      family: file.licence.family,
      attributionRequired: file.licence.attributionRequired,
    },
    restrictions: [],
    modified: entry.modified,
    fetchedAt: file.fetchedAt,
    status: 'ok',
    curation: null,
  };
  if (coverKey(sitePath) !== key || !validateImageCreditRecord(record).valid) return null;
  return record as ImageCreditRecord;
}

/**
 * The credit of a cover, or `null`. Never rejects. A cover that cannot carry a
 * credit (`/images/places/…`, `/og-image.png`) resolves without a request.
 */
export async function fetchImageCredit(
  section: ArticleSection,
  cover: string | null | undefined,
): Promise<ImageCreditRecord | null> {
  if (!coverKey(cover)) return null;
  const index = await fetchImageCredits(section);
  return index ? imageCreditFromIndex(index, cover) : null;
}

/**
 * The ImageObject of a static article page, kept when the SPA replaces that
 * page's NewsArticle: only for the same cover file, and only when it credits
 * somebody other than the site — i.e. a page rendered with the cover's record.
 * The site's default claim, another image or a bare URL yield `null`.
 *
 * Matched by cover key rather than by URL string: the static page and the SPA
 * registry may spell the same file with different hosts (origin or CDN).
 */
export function creditedStaticImageObject(image: unknown, cover: string): Record<string, unknown> | null {
  if (!isPlainObject(image) || image['@type'] !== 'ImageObject') return null;
  const key = coverKey(cover);
  const url = typeof image.contentUrl === 'string' ? image.contentUrl : image.url;
  if (!key || coverKey(url) !== key) return null;
  const creator = image.creator;
  if (!isPlainObject(creator) || typeof creator.name !== 'string' || !creator.name.trim()) return null;
  return isSiteOrganizationCreator(creator) ? null : image;
}

/**
 * The `image` of the NewsArticle the SPA writes for an article:
 *   1. the credited ImageObject, once the credit has loaded;
 *   2. else the static page's credited ImageObject of the same cover, kept
 *      before its script was replaced — a direct landing, which is what Google
 *      renders, keeps the credit even when the fetch fails;
 *   3. else the bare URL, as before.
 */
export function articleCoverImageLd(
  coverUrl: string,
  credit: ImageCreditRecord | null,
  staticImage: Record<string, unknown> | null,
): string | Record<string, unknown> {
  if (credit) return imageObjectLd({ contentUrl: coverUrl, url: coverUrl, ...imageObjectCreditFields(credit) });
  if (staticImage && creditedStaticImageObject(staticImage, coverUrl)) return staticImage;
  return coverUrl;
}

/** Forget every fetched file. Tests only. */
export function __resetImageCreditsForTests(): void {
  pendingBySection.clear();
}
