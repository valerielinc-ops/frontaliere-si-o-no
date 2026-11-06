import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
/**
 * Hitachi Energy — AEM job listing parser
 *
 * Listing API (JSON):
 *   https://www.hitachienergy.com/careers/open-jobs/_jcr_content/root/container/content_1/content/grid_0/joblist.listsearchresults.json?location=Switzerland
 *   Pagination: &offset=20, &offset=40, ...  (20 items per page)
 *
 * Detail page:
 *   https://www.hitachienergy.com/careers/open-jobs/details/JID3-{id}
 *   Full description embedded in window.dataLayer[0].description
 *   JobPosting JSON-LD in <script type="application/ld+json">
 *
 * ATS: Workday (apply URLs → hitachi.wd1.myworkdayjobs.com)
 */

import { isSwissLocationText, inferAnyCanton } from './target-swiss-locations.mjs';
import { normalizeSpace, normalizeDescriptionSpace } from './crawler-template.mjs';
import { assertJsonListShape } from './assert-json-list-shape.mjs';
import { extractMetaDescriptionRaw } from './meta-description-extract.mjs';
import { sourceLangOfBody } from './source-locale-slots.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { markRetryExhaustedError } from './transient-fetch.mjs';
import { extractJobPostingNodes } from './jobposting-jsonld.mjs';

const PAGE_SIZE = 20;

function stripHtml(html = '') {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x26;/gi, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\x26#39;/g, "'")
    .replace(/\u00b7/g, '·')
    .replace(/\u2013/g, '–')
    .replace(/\u2019/g, "'")
    .replace(/\u002D/g, '-')
    .trim();
}

function slugify(value = '') {
  return truncateSlugAtWordBoundary(String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-'), 180);
}

/**
 * Parse items from the AEM listing JSON API response.
 * Returns an array of { title, jobId, url, applyUrl, location, primaryLocation,
 *   jobType, contractType, experience, jobFunction, publicationDate }
 */
export function parseHitachiEnergyListingJson(json) {
  const items = assertJsonListShape(json, { key: 'items', source: 'hitachi-energy' });
  const results = [];
  const seen = new Set();

  for (const item of items) {
    if (!item.url || !item.title) continue;
    const jobIdMatch = item.url.match(/JID3-(\d+)/);
    const jobId = jobIdMatch ? jobIdMatch[1] : item.url;
    if (seen.has(jobId)) continue;
    seen.add(jobId);

    // Normalize URL to English canonical
    const url = item.url.replace(/\/it\/it\/|\/ch\/de\/|\/ch\/fr\/|\/ch\/it\//, '/');

    results.push({
      title: normalizeSpace(item.title),
      jobId,
      url,
      applyUrl: item.applyNowUrl || '',
      location: normalizeSpace(item.location || ''),
      primaryLocation: normalizeSpace(item.primaryLocation || ''),
      jobType: normalizeSpace(item.jobType || ''),
      contractType: normalizeSpace(item.contractType || ''),
      experience: normalizeSpace(item.experience || ''),
      jobFunction: normalizeSpace(item.jobFunction || ''),
      publicationDate: item.publicationDate
        ? String(item.publicationDate)
        : '',
    });
  }

  return results;
}

/**
 * Check if the listing API response has more pages.
 *
 * The AEM `joblist.listsearchresults.json` endpoint states its own pagination
 * contract in the payload: `loadMore` (boolean — "another page exists") and
 * `totalNumber` (the full result count, e.g. 87). Prefer those over guessing
 * from the page length.
 *
 * Why (issue #4993): the previous implementation inferred "there is another
 * page" from `items.length >= PAGE_SIZE` alone. A full page that comes back
 * one item short — the source filters a posting out server-side after paging,
 * so page 1 carries 19 of 20 — reads as "last page" and the crawl stops
 * immediately, silently discarding every later page. Observed in production
 * on 2026-07-30 (run 30585824881): page 1 returned 19 items, the loop broke
 * after that single page, `Total Switzerland listings: 19`, and the slice
 * would have gone 84 → 18 jobs. Only the shrink guard stopped the write.
 * `loadMore` was `true` in that same payload, so the authoritative signal was
 * present and ignored. The length heuristic is kept as a last-resort fallback
 * for a payload that carries neither field.
 *
 * @param {object} json          Parsed listing API response.
 * @param {object} [options]
 * @param {number} [options.fetchedCount] Items accumulated so far across all
 *   pages, used with `totalNumber` when `loadMore` is absent.
 * @returns {boolean}
 */
export function hasMorePages(json, { fetchedCount } = {}) {
  const pageLength = json?.items?.length || 0;
  // An empty page always terminates, whatever the metadata claims.
  if (pageLength === 0) return false;

  if (typeof json?.loadMore === 'boolean') return json.loadMore;

  const total = Number(json?.totalNumber);
  if (Number.isFinite(total) && total > 0 && Number.isFinite(Number(fetchedCount))) {
    return Number(fetchedCount) < total;
  }

  return pageLength >= PAGE_SIZE;
}

/**
 * Walk the listing pages and return every unique listing.
 *
 * Why (issue #12802): on 2026-10-11 page 1 returned 20 jobs, then page 2 came
 * back with HTTP 200 and no new listing, and the loop read that as the end of
 * the board. The slice would have gone 70 → 19; only the shrink guard stopped
 * the write. Every page states `totalNumber`, so a later page that adds
 * nothing before that total is reached is a degraded response, not the end of
 * the list. Such a page is fetched again up to `emptyPageRetries` times; if it
 * stays empty the run throws a retry-exhausted error, which
 * `exitCrawlerOnError` turns into a named soft exit that keeps the stored
 * slice. A fetch failure after page 1 also throws. A page-1 fetch failure
 * still returns `[]` (the caller's "no listings" exit).
 *
 * @param {object} options
 * @param {(offset: number) => Promise<object>} options.fetchPage Fetches one listing payload.
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {number} [options.maxPages]
 * @param {number} [options.emptyPageRetries]
 * @param {number} [options.retryDelayMs]
 * @returns {Promise<object[]>}
 */
export async function collectHitachiEnergyListings({
  fetchPage,
  sleep = async () => {},
  maxPages = Infinity,
  emptyPageRetries = 2,
  retryDelayMs = 3000,
}) {
  const allItems = [];
  const seenIds = new Set();
  let declaredTotal = 0;
  const recordDeclaredTotal = (json) => {
    const pageTotal = Number(json?.totalNumber);
    if (Number.isFinite(pageTotal) && pageTotal > declaredTotal) declaredTotal = pageTotal;
  };
  const unseen = (json) => parseHitachiEnergyListingJson(json).filter((item) => !seenIds.has(item.jobId));

  for (let page = 0; page < maxPages; page++) {
    const offset = page * PAGE_SIZE;
    let json;
    try {
      json = await fetchPage(offset);
    } catch (err) {
      if (page > 0) throw err;
      // fetch-failure-empty-ok: page 1 only — the caller logs "no listings" and keeps the stored slice; later pages rethrow
      console.log(`  ⚠️ API page 1 fetch failed: ${err.message}`);
      break;
    }

    recordDeclaredTotal(json);
    let newItems = unseen(json);
    for (let retry = 1; newItems.length === 0 && allItems.length < declaredTotal; retry++) {
      const reason = `page ${page + 1} returned no new listings at ${allItems.length} of totalNumber=${declaredTotal}`;
      if (retry > emptyPageRetries) {
        throw markRetryExhaustedError(new Error(`Hitachi Energy listing ${reason} after ${emptyPageRetries} retries`));
      }
      console.warn(`  🔁 Listing ${reason} — retry ${retry}/${emptyPageRetries}`);
      await sleep(retryDelayMs * retry);
      json = await fetchPage(offset);
      recordDeclaredTotal(json);
      newItems = unseen(json);
    }
    if (newItems.length === 0) break;

    for (const item of newItems) {
      seenIds.add(item.jobId);
      allItems.push(item);
    }
    console.log(`     Found ${newItems.length} new jobs (total: ${allItems.length})`);

    // `fetchedCount` lets hasMorePages() fall back to the payload's own
    // `totalNumber` when `loadMore` is absent — never to the page-length
    // heuristic that truncated the crawl at a short first page (#4993).
    if (!hasMorePages(json, { fetchedCount: allItems.length })) break;
    await sleep(800);
  }

  if (declaredTotal > 0 && allItems.length < declaredTotal) {
    // Loud, non-fatal: the source's last page arrived before its own declared
    // count (e.g. `loadMore: false` early). The shrink guard is still the
    // thing that refuses a bad write (#4993).
    console.warn(
      `  ⚠️ Pagination ended at ${allItems.length} listings but the API declares totalNumber=${declaredTotal} — treating this run as truncated.`,
    );
  }

  return allItems;
}

/**
 * Inner HTML of the rendered vacancy body,
 * `<div class="cmp-job-details__description-block">`, read to its own
 * closing tag (depth walk, so a nested `<div>` cannot cut it short).
 */
function descriptionBlockHtml(html = '') {
  const open = /<div\b[^>]*class="[^"]*\bcmp-job-details__description-block\b[^"]*"[^>]*>/i.exec(html);
  if (!open) return '';
  const tagRe = /<(\/?)div\b[^>]*>/gi;
  tagRe.lastIndex = open.index + open[0].length;
  let depth = 1;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(open.index + open[0].length, m.index);
  }
  return '';
}

/**
 * Extract job description from a detail page HTML.
 * Sources: rendered description block > dataLayer.description > JSON-LD >
 * meta description.
 *
 * The rendered block comes first because it is the only source that keeps
 * the vacancy's structure: the dataLayer string is the same text with every
 * tag already removed, so the "How you'll make an impact" and "Your
 * background" lists reached the site as run-on prose. No length cap: the
 * former 4000-character cut chopped the tail of every long posting (audit run
 * 36528331656: 4000 published against ~4500 on the source page).
 */
export function parseHitachiEnergyDetailPage(html = '') {
  let description = '';

  // 1. Rendered description block (headings, paragraphs and lists).
  const blockHtml = descriptionBlockHtml(html);
  if (blockHtml) description = stripHtml(blockHtml);

  // 2. Fallback: window.dataLayer push (flattened text)
  if (!description) {
    const dataLayerMatch = html.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (dataLayerMatch) {
      let raw = dataLayerMatch[1];
      // Unescape JS string escapes
      raw = raw
        .replace(/\\x26/g, '&')
        .replace(/\\u002D/g, '-')
        .replace(/\\"/g, '"')
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, ' ')
        .replace(/\\r/g, '');
      description = stripHtml(raw);
    }
  }

  // 3. Fallback: JSON-LD JobPosting description
  if (!description) {
    const posting = extractJobPostingNodes(html)[0];
    if (posting?.description) description = stripHtml(posting.description);
  }

  // 4. Fallback: meta description
  if (!description) {
    const metaRaw = extractMetaDescriptionRaw(html);
    if (metaRaw !== null) {
      description = stripHtml(metaRaw);
    }
  }

  return normalizeDescriptionSpace(description);
}

/**
 * Rows that carry the posting's own text, at least the shared 50-word floor
 * (source-body-floor.mjs). Only that text is published
 * (issue 5253): a listing whose detail page yielded no body used to go out
 * with an invented four-language blurb ("Hitachi Energy is hiring for the
 * {title} role based in {city}. … Apply through the official Hitachi Energy
 * careers page."); it is not published any more.
 *
 * @param {object[]} rows enriched listings (`description` from the detail page)
 * @returns {{ rows: object[], withoutBody: number }}
 */
export function publishableHitachiEnergyRows(rows = []) {
  const kept = rows.filter((row) => meetsSourceBodyFloor(String(row?.description || '')));
  return { rows: kept, withoutBody: rows.length - kept.length };
}

/**
 * Build localized content for a Hitachi Energy job.
 */
export function buildHitachiEnergyLocalizedContent(job = {}) {
  const title = String(job.title || '').trim();
  const location = String(job.primaryLocation || job.location || '').trim() || 'Switzerland';
  const description = String(job.description || '').trim();
  // The body goes in the slot of the language it is written in (read from
  // the body: 53 English and 16 German postings on 2026-09-29), not copied
  // into all four slots (#5253). Title copies and slugs stay as they were:
  // translate-pending retranslates source-copy titles.
  const sourceLang = sourceLangOfBody(description, 'en');

  return {
    sourceLang,
    titleByLocale: { it: title, en: title, de: title, fr: title },
    descriptionByLocale: { [sourceLang]: description },
    slugByLocale: {
      it: slugify(`${title} hitachi-energy ${location}`),
      en: slugify(`${title} hitachi-energy ${location}`),
      de: slugify(`${title} hitachi-energy ${location}`),
      fr: slugify(`${title} hitachi-energy ${location}`),
    },
  };
}

/**
 * Check whether a job location identifies Switzerland across all 26 cantons.
 */
export function isHitachiEnergySwissRelevant(location = '') {
  const loc = normalizeSpace(location).toLowerCase();
  if (!loc) return false;
  return isSwissLocationText(loc);
}

/** @deprecated Legacy name retained for existing callers; use isHitachiEnergySwissRelevant. */
export const isHitachiEnergyTicinoRelevant = isHitachiEnergySwissRelevant;

/**
 * Infer canton from location text.
 */
export function inferHitachiEnergyCanton(location = '') {
  const canton = inferAnyCanton(location);
  return canton || '';
}

export { PAGE_SIZE, slugify };
