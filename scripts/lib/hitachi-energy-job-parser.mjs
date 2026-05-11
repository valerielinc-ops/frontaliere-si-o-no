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

const PAGE_SIZE = 20;

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

// Bullet-preserving normalizer for descriptions: collapses runs of spaces/tabs
// to a single space, but preserves newline structure (so `\n• item` lines
// extracted from <li> tags by stripHtml survive into the final output).
function normalizeDescriptionSpace(value = '') {
  return String(value || '')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

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
  const items = json?.items || [];
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
 */
export function hasMorePages(json) {
  return (json?.items?.length || 0) >= PAGE_SIZE;
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
    const metaMatch = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
    if (metaMatch) {
      description = stripHtml(metaMatch[1]);
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
