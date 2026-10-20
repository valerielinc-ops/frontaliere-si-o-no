/**
 * SmartRecruiters API parser for lastminute.com jobs.
 *
 * Fetches full job details from the SmartRecruiters public API,
 * combining all sections (jobDescription, qualifications,
 * companyDescription, additionalInformation) into a rich
 * markdown description.
 */

import { sourcePostingDateFields } from './source-posting-date.mjs';
import { decode as decodeHTML } from 'html-entities';
import { inferAnyCanton } from './target-swiss-locations.mjs';

function normalizeSpace(value = '') {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/&#xa0;/gi, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripLastminuteBoilerplate(value = '') {
  return String(value || '')
    .replace(/(?:^|\n)\s*#?\s*Careers\b[\s\S]*?(?=\bThe Company\b|\bJob Description\b|\bDescription du poste\b|\bStellenbeschreibung\b|$)/i, ' ')
    .replace(/\bShare this job:?\b[\s\S]*?(?=\bThe Company\b|\bJob Description\b|\bDescription du poste\b|\bStellenbeschreibung\b|$)/i, ' ')
    .replace(/\b(?:corporate\.lastminute\.com|https?:\/\/corporate\.lastminute\.com\/\S+|https?:\/\/jobs\.smartrecruiters\.com\/\S+)\b/gi, ' ')
    .replace(/\b(?:Apply now|Candidati ora|Jetzt bewerben|Postulez maintenant)\b/gi, ' ')
    .replace(/\b(?:Back to Job Search|Torna alla ricerca di lavoro|Zuruck zur Jobsuche|Retour a la recherche d'emploi)\b/gi, ' ')
    .replace(/\b(?:Main Language|Lingua principale|Hauptsprache|Langue principale)\s*:\s*[A-Za-zÀ-ÿ ]+/gi, ' ')
    .replace(/\b(?:Job title|Titolo del lavoro|Stellenbezeichnung|Intitule du poste)\s*:\s*/gi, ' ')
    .replace(/\b(?:Brand|Marca|Marke)\s*:\s*lastminute\.com\b/gi, ' ')
    .replace(/\b(?:Department|Dipartimento|Abteilung|Departement)\s*:\s*[^.\n]+/gi, ' ')
    .replace(/\b(?:Location|Sede|Standort|Lieu)\s*:\s*[^.\n]+/gi, ' ')
    .replace(/\b(?:Contract|Contratto|Vertrag|Contrat)\s*:\s*[^.\n]+/gi, ' ')
    .replace(/\*{2,}/g, ' ')
    .replace(/[ \t]+/g, ' ');
}

function stripTags(html = '') {
  return normalizeSpace(
    stripLastminuteBoilerplate(String(html || ''))
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
  );
}

/**
 * Convert HTML fragment to structured markdown.
 * Handles <strong>/<b> as headings, <ul>/<ol> as bullet lists, <p>/<div> as paragraphs.
 */
function htmlToMarkdown(html = '') {
  if (!html) return '';

  let md = decodeHTML(stripLastminuteBoilerplate(html)
    // Section headings
    .replace(/<(?:h[1-6])[^>]*>([\s\S]*?)<\/(?:h[1-6])>/gi, (_, inner) => {
      const text = stripTags(inner);
      return text ? `\n\n## ${text}\n\n` : '';
    })
    // Bold text on its own line → heading
    .replace(/<p[^>]*>\s*<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>\s*<\/p>/gi, (_, inner) => {
      const text = stripTags(inner);
      return text ? `\n\n## ${text}\n\n` : '';
    })
    // List items
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => {
      const text = stripTags(inner);
      return text ? `\n- ${text}` : '';
    })
    // Remove list wrappers
    .replace(/<\/?(?:ul|ol)[^>]*>/gi, '\n')
    // Paragraphs and divs
    .replace(/<\/(?:p|div)>/gi, '\n\n')
    .replace(/<(?:p|div)[^>]*>/gi, '')
    // Line breaks
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    // Strip remaining tags
    .replace(/<[^>]+>/g, ' '), { scope: 'strict' })
    .replaceAll('\u00a0', ' ')
    // Clean up whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  md = stripLastminuteBoilerplate(md)
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return md;
}

function extractLastminuteRequirements(description = '') {
  const text = normalizeSpace(description);
  if (!text) return [];
  const lines = text
    .split(/[\n\r•·]+|(?<=[.!?;:])\s+/)
    .map((x) => normalizeSpace(String(x || '').replace(/^[)\]}\-–—:.,\s]+/, '')))
    .filter(Boolean);

  const out = [];
  for (const line of lines) {
    if (line.length < 18 || line.length > 160) continue;
    if (/\b(apply now|candidati ora|back to job search|share this job|main language|corporate\.lastminute\.com)\b/i.test(line)) continue;
    if (!/(experience|esperienza|react|python|sql|cloud|kafka|spark|airflow|language|lingua|english|inglese|leadership|api|microservices|data|engineering|degree|laurea|qualifications|requisiti)/i.test(line)) continue;
    out.push(line);
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * Map SmartRecruiters section keys to readable Italian headings.
 */
const SECTION_HEADINGS = {
  jobDescription: null, // Use content as-is (usually has its own headings)
  qualifications: 'Requisiti e competenze',
  companyDescription: "Chi è lastminute.com",
  additionalInformation: 'Cosa offriamo',
};

/**
 * Ordered sections for the final description.
 */
const SECTION_ORDER = ['jobDescription', 'qualifications', 'additionalInformation', 'companyDescription'];

const LASTMINUTE_CORPORATE_ORIGIN = 'https://corporate.lastminute.com';

function lastminuteDeclaredTotals(html = '') {
  return [...new Set(
    [...String(html || '').matchAll(/\b(\d+)\s+(?:open\s+positions?|positions?\s+found)\b/giu)]
      .map((match) => Number(match[1]))
      .filter((value) => Number.isInteger(value)),
  )];
}

/**
 * Read the total exposed by the corporate page or its HTMX search response.
 * A missing or contradictory count is deliberately not a completeness proof.
 */
export function parseLastminuteDeclaredTotal(html = '') {
  const totals = lastminuteDeclaredTotals(html);
  return totals.length === 1 ? totals[0] : null;
}

/**
 * Parse the source-owned Lastminute listing response and prove discovery.
 *
 * The HTMX endpoint emits two anchors for each job row, so completeness is
 * based on unique SmartRecruiters IDs, not anchor occurrences. The response is
 * complete only when its single declared total is positive and exactly equals
 * the number of unique canonical detail URLs.
 */
export function parseLastminuteListingDiscovery(html = '') {
  const source = String(html || '');
  const totals = lastminuteDeclaredTotals(source);
  const detailById = new Map();
  const hrefRe = /href\s*=\s*(["'])(.*?)\1/giu;
  let anchorOccurrences = 0;
  let match = null;

  while ((match = hrefRe.exec(source)) !== null) {
    const rawHref = decodeHTML(String(match[2] || ''));
    if (!rawHref) continue;

    let detailUrl = null;
    try {
      detailUrl = new URL(rawHref, LASTMINUTE_CORPORATE_ORIGIN);
    } catch {
      continue;
    }
    if (
      detailUrl.hostname.toLowerCase() !== 'corporate.lastminute.com'
      || !/^\/careers\/jobs\/job\/?$/i.test(detailUrl.pathname)
    ) {
      continue;
    }

    const postingId = extractSrIdFromUrl(detailUrl.href);
    if (!postingId) continue;
    anchorOccurrences += 1;
    detailUrl.hash = '';
    if (!detailById.has(postingId)) detailById.set(postingId, detailUrl.href);
  }

  const detailUrls = [...detailById.values()];
  const declaredTotal = totals.length === 1 ? totals[0] : null;
  let reason = '';
  if (detailUrls.length === 0) {
    reason = 'no canonical detail URLs';
  } else if (totals.length === 0) {
    reason = 'no source-declared total';
  } else if (totals.length > 1) {
    reason = `conflicting source-declared totals: ${totals.join(', ')}`;
  } else if (declaredTotal === 0) {
    reason = 'empty source discovery is not publishable';
  } else if (detailUrls.length !== declaredTotal) {
    reason = `discovered ${detailUrls.length} unique detail URLs but source declared ${declaredTotal}`;
  }

  return {
    complete: reason === '',
    reason,
    declaredTotal,
    declaredTotals: totals,
    detailUrls,
    anchorOccurrences,
  };
}

/**
 * Parse SmartRecruiters API response into a structured job detail.
 *
 * @param {object} data - Parsed JSON from SR API
 * @returns {{ title, description, location, city, canton, country, applyUrl, postedDate, sourceTextLength, sectionCount, requirements }}
 */
export function parseSmartRecruitersDetail(data = {}) {
  const title = normalizeSpace(data.name || '');
  const sections = data.jobAd?.sections || {};
  const location = data.location || {};

  // Build description from all sections
  const parts = [];
  let totalSourceLen = 0;
  let sectionCount = 0;

  for (const key of SECTION_ORDER) {
    const section = sections[key];
    if (!section?.text) continue;

    const sectionHtml = section.text;
    totalSourceLen += stripTags(sectionHtml).length;
    const md = htmlToMarkdown(sectionHtml);
    if (!md) continue;

    sectionCount++;
    const heading = SECTION_HEADINGS[key];
    if (heading && !md.includes('## ')) {
      parts.push(`## ${heading}\n\n${md}`);
    } else if (heading) {
      // Section already has its own headings, add our heading as context
      parts.push(`## ${heading}\n\n${md}`);
    } else {
      parts.push(md);
    }
  }

  const description = stripLastminuteBoilerplate(parts.join('\n\n'))
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Location
  const city = normalizeSpace(location.city || '');
  const region = normalizeSpace(location.region || '');
  const canton = inferAnyCanton([city, region].filter(Boolean).join(', '));
  const country = normalizeSpace(location.country || '').toUpperCase();

  return {
    title,
    description,
    location: city,
    city,
    canton,
    country,
    applyUrl: data.applyUrl || '',
    ...sourcePostingDateFields(data.releasedDate),
    sourceTextLength: totalSourceLen,
    sectionCount,
    requirements: extractLastminuteRequirements(description),
  };
}

/**
 * Guard: validate extracted description against quality thresholds.
 */
export function validateLastminuteDescription(detail, minChars = 500, minSourceRatio = 0.25) {
  const warnings = [];
  const desc = detail.description || '';

  if (desc.length < minChars) {
    warnings.push(`Description too short: ${desc.length} chars (min ${minChars})`);
  }

  if (detail.sourceTextLength > 300 && desc.length < detail.sourceTextLength * minSourceRatio) {
    warnings.push(
      `Description is ${((desc.length / detail.sourceTextLength) * 100).toFixed(0)}% of source (min ${minSourceRatio * 100}%): ${desc.length}/${detail.sourceTextLength} chars`
    );
  }

  if (detail.sectionCount < 2 && detail.sourceTextLength > 500) {
    warnings.push(`Only ${detail.sectionCount} section(s) extracted from source with ${detail.sourceTextLength} chars`);
  }

  return { ok: warnings.length === 0, warnings };
}

/**
 * Extract SmartRecruiters posting ID from a corporate.lastminute.com URL.
 */
export function extractSrIdFromUrl(rawUrl = '') {
  const value = String(rawUrl || '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    // Corporate URL: /careers/jobs/job?id=744000111059566
    const idParam = url.searchParams.get('id') || '';
    const m = idParam.match(/(\d{6,})/);
    if (m) return m[1];
    // SmartRecruiters URL: /lastminutecom/744000111059566-slug
    const pathMatch = url.pathname.match(/\/lastminutecom\/(\d{6,})/i);
    if (pathMatch) return pathMatch[1];
    return '';
  } catch {
    return '';
  }
}

/**
 * Fetch full job detail from SmartRecruiters API.
 *
 * @param {string} postingId - SR posting ID (e.g., "744000111059566")
 * @param {number} timeoutMs
 * @returns {Promise<object|null>}
 */
export async function fetchSmartRecruitersDetail(postingId, timeoutMs = 12000) {
  const apiUrl = `https://api.smartrecruiters.com/v1/companies/lastminutecom/postings/${postingId}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(apiUrl, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent':
          process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    if (!res.ok) {
      console.warn(`⚠️ SR API ${res.status} for posting ${postingId}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`⚠️ SR API fetch failed for ${postingId}: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
