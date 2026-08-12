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

import {  isTargetSwissLocation, inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';
import { normalizeSpace, normalizeDescriptionSpace } from './crawler-template.mjs';
import { assertJsonListShape } from './assert-json-list-shape.mjs';
import { extractMetaDescriptionRaw } from './meta-description-extract.mjs';

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
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 180);
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
        ? String(item.publicationDate).slice(0, 10)
        : new Date().toISOString().slice(0, 10),
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
 * Extract job description from a detail page HTML.
 * Sources: dataLayer.description > JSON-LD > meta description
 */
export function parseHitachiEnergyDetailPage(html = '') {
  let description = '';

  // 1. Try extracting from window.dataLayer push
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

  // 2. Fallback: JSON-LD JobPosting description
  if (!description) {
    const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
    if (jsonLdMatch) {
      try {
        const data = JSON.parse(jsonLdMatch[1]);
        if (data?.['@type'] === 'JobPosting' && data.description) {
          description = stripHtml(data.description);
        }
      } catch { /* ignore */ }
    }
  }

  // 3. Fallback: meta description
  if (!description) {
    const metaRaw = extractMetaDescriptionRaw(html);
    if (metaRaw !== null) {
      description = stripHtml(metaRaw);
    }
  }

  return normalizeDescriptionSpace(description).slice(0, 4000);
}

/**
 * Build localized content for a Hitachi Energy job.
 */
export function buildHitachiEnergyLocalizedContent(job = {}) {
  const title = String(job.title || '').trim();
  const location = String(job.primaryLocation || job.location || '').trim() || 'Switzerland';
  const description = String(job.description || '').trim();
  const jobFunction = String(job.jobFunction || '').trim();
  const jobType = String(job.jobType || '').trim();

  const itDesc = description
    || `Hitachi Energy cerca un/a ${title} con sede a ${location}. ${jobFunction ? `Settore: ${jobFunction}.` : ''} ${jobType ? `Tipo: ${jobType}.` : ''} Candidati tramite il sito ufficiale Hitachi Energy.`;
  const enDesc = description
    || `Hitachi Energy is hiring for the ${title} role based in ${location}. ${jobFunction ? `Function: ${jobFunction}.` : ''} ${jobType ? `Type: ${jobType}.` : ''} Apply through the official Hitachi Energy careers page.`;
  const deDesc = description
    || `Hitachi Energy sucht derzeit für die Position ${title} am Standort ${location}. ${jobFunction ? `Bereich: ${jobFunction}.` : ''} ${jobType ? `Art: ${jobType}.` : ''} Bewirb dich über die offizielle Karriereseite von Hitachi Energy.`;
  const frDesc = description
    || `Hitachi Energy recrute actuellement pour le poste ${title} basé à ${location}. ${jobFunction ? `Domaine: ${jobFunction}.` : ''} ${jobType ? `Type: ${jobType}.` : ''} Postulez via la page carrière officielle de Hitachi Energy.`;

  return {
    titleByLocale: { it: title, en: title, de: title, fr: title },
    descriptionByLocale: { it: itDesc, en: enDesc, de: deDesc, fr: frDesc },
    slugByLocale: {
      it: slugify(`${title} hitachi-energy ${location}`),
      en: slugify(`${title} hitachi-energy ${location}`),
      de: slugify(`${title} hitachi-energy ${location}`),
      fr: slugify(`${title} hitachi-energy ${location}`),
    },
  };
}

/**
 * Check whether a job location is relevant to Ticino/Grigioni frontalieri.
 */
export function isHitachiEnergyTicinoRelevant(location = '') {
  const loc = normalizeSpace(location).toLowerCase();
  if (!loc) return false;
  return isTargetSwissLocation(loc);
}

/**
 * Infer canton from location text.
 */
export function inferHitachiEnergyCanton(location = '') {
  const canton = inferAnyCanton(location);
  return canton || '';
}

export { PAGE_SIZE, slugify };
