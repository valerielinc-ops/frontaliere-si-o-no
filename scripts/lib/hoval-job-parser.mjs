import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
/**
 * Hoval — SAP Hybris job parser
 *
 * Listing API: https://www.hoval.it/jobs/results?q=:sortIndex:country:Switzerland
 *   - Returns JSON with { results: [...], pagination: {...} }
 *   - Each result: { jobDescription, country, location, language, department, link }
 *
 * Detail page: https://www.hoval.it/it_IT/job/{id}
 *   - Description in <div class="o-richtext o-richtext--large-article">
 *   - Apply URL in <a> with href to recruitingapp-2710.umantis.com
 */

import { inferAnyCanton } from './target-swiss-locations.mjs';
import { assertJsonListShape } from './assert-json-list-shape.mjs';
import { dropFabricatedDescription } from './drop-fabricated-description.mjs';

const BASE_URL = 'https://www.hoval.it';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripHtml(html = '') {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
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
 * Parse the JSON API response for Swiss job listings.
 * @param {object} json - The parsed JSON from /jobs/results?q=:sortIndex:country:Switzerland
 * @returns {{ items: Array, totalResults: number }}
 */
export function parseHovalListingJson(json = {}) {
  const results = assertJsonListShape(json, { key: 'results', source: 'hoval' });
  const totalResults = json?.pagination?.totalNumberOfResults || results.length;

  const items = results
    .filter((r) => r?.jobDescription && r?.link)
    .map((r) => {
      const jobId = String(r.link || '').replace(/^\/job\//, '');
      return {
        title: normalizeSpace(r.jobDescription),
        jobId,
        detailUrl: `${BASE_URL}/it_IT/job/${jobId}`,
        location: normalizeSpace(r.location || ''),
        country: normalizeSpace(r.country || ''),
        department: normalizeSpace(r.department || ''),
        language: normalizeSpace(r.language || ''),
      };
    });

  return { items, totalResults };
}

/**
 * Extract job description and apply URL from a Hoval detail page.
 * @param {string} html - Raw HTML of the detail page
 * @returns {{ description: string, applyUrl: string }}
 */
export function parseHovalDetailPage(html = '') {
  // Extract description from o-richtext blocks (there are typically 2: description + contact)
  const descBlocks = [];
  const richTextRegex = /<div\s+class="o-richtext\s+o-richtext--large-article[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
  let match;
  while ((match = richTextRegex.exec(html)) !== null) {
    const content = stripHtml(match[1]);
    // Skip contact/address blocks (short, contain typical address patterns)
    if (content.length > 80) {
      descBlocks.push(content);
    }
  }
  const description = descBlocks.join('\n\n');

  // Extract apply URL (umantis.com)
  let applyUrl = '';
  const applyMatch = html.match(/href="(https:\/\/recruitingapp[^"]+)"/);
  if (applyMatch) {
    applyUrl = applyMatch[1];
  }

  return { description, applyUrl };
}

/**
 * Build localized content for a Hoval job.
 */
export function buildHovalLocalizedContent(job = {}) {
  const title = String(job.title || '').trim();
  const location = String(job.location || '').trim() || 'Svizzera';
  const description = String(job.description || '').trim();

  // The posting's own text, in its own language slot (`job.sourceLang`, set
  // by the runner); the translation step fills the other locales. Without
  // a text there is no description: this used to publish a sentence about
  // Hoval of its own in four languages ("… is hiring for the <title>
  // role … Apply through the official … careers page."), which filled every
  // locale so the translation step never replaced it.
  const sourceLang = String(job.sourceLang || '').trim() || 'it';

  return {
    description,
    titleByLocale: { it: title, en: title, de: title, fr: title },
    descriptionByLocale: description ? { [sourceLang]: description } : {},
    slugByLocale: {
      it: slugify(`${title} hoval ${location}`),
      en: slugify(`${title} hoval ${location}`),
      de: slugify(`${title} hoval ${location}`),
      fr: slugify(`${title} hoval ${location}`),
    },
  };
}

/**
 * Check whether a listing is a Swiss (CH) posting.
 *
 * Hoval is a national heating/HVAC employer, so the crawler is CH-wide (all
 * 26 cantons). The Hybris feed is already country-filtered (country:Switzerland),
 * so the feed's own `country` field is the authoritative CH gate — foreign
 * postings (if any) are dropped here. Per-job canton is resolved separately by
 * inferHovalCanton over all 26 cantons; we never default to a single canton.
 *
 * @param {{ country?: string, location?: string }} job
 */
export function isHovalSwissJob(job = {}) {
  const country = normalizeSpace(job.country || '').toLowerCase();
  if (country) {
    return country === 'switzerland' || country === 'svizzera' || country === 'schweiz' || country === 'suisse' || country === 'ch';
  }
  // No country signal: fall back to canton resolution over all 26 cantons.
  return Boolean(inferAnyCanton(normalizeSpace(job.location || '')));
}

/**
 * Infer canton code (one of all 26 Swiss cantons) from the clean city signal
 * via the BFS municipality dataset. Falls back to the generic 'CH' marker for
 * Swiss postings whose small municipality is absent from the BFS token set
 * (e.g. Feldmeilen) — never defaults to a specific canton such as TI.
 */
export function inferHovalCanton(location = '') {
  // Use the clean leading city token alone (strip trailing region/"bzw."
  // clauses) so inferAnyCanton matches the actual city, not a co-located
  // region label that could resolve to the wrong canton via array order.
  const cleanCity = normalizeSpace(location)
    .split(/[,;]|\bbzw\.\b/i)[0]
    .replace(/^(rc|ostschweiz|region)\s+/i, '')
    .trim();
  return inferAnyCanton(cleanCity) || inferAnyCanton(normalizeSpace(location)) || 'CH';
}

// The text this crawler used to write itself: the four sentences the builder wrote without a posting text ("Hoval ha aperto una selezione…", "Hoval is hiring for the…", "Hoval sucht derzeit…", "Hoval recrute actuellement…").
// Only ever recognised, to be removed from stored records (issue 5253).
export const HOVAL_FABRICATED_RE = /Hoval ha aperto una selezione per il ruolo |Hoval is hiring for the |Hoval sucht derzeit für die Position |Hoval recrute actuellement pour le poste /;

/**
 * Remove that text from a stored job before the locale-preserving merge: the
 * slots and flat `description` that carry it and the translations made from
 * it (`dropFabricatedDescription`); the job is flagged for retranslation.
 *
 * @returns {boolean} true when the job changed.
 */
export function dropHovalFabricatedText(job) {
  return dropFabricatedDescription(job, HOVAL_FABRICATED_RE);
}
