/**
 * SmartRecruiters API parser for lastminute.com jobs.
 *
 * Fetches full job details from the SmartRecruiters public API,
 * combining all sections (jobDescription, qualifications,
 * companyDescription, additionalInformation) into a rich
 * markdown description.
 */

import { getCompanyDefaults } from './crawler-location-config.mjs';

const HQ = getCompanyDefaults('lastminute');

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

  let md = stripLastminuteBoilerplate(html)
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
    .replace(/<[^>]+>/g, ' ')
    // Decode entities
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&ndash;/gi, '\u2013')
    .replace(/&mdash;/gi, '\u2014')
    .replace(/&nbsp;|&#xa0;/gi, ' ')
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
  const canton = normalizeSpace(location.region || '').toUpperCase() || HQ.canton;
  const country = normalizeSpace(location.country || '').toUpperCase() || 'CH';

  return {
    title,
    description,
    location: city || 'Chiasso',
    city,
    canton,
    country,
    applyUrl: data.applyUrl || '',
    postedDate: data.releasedDate ? data.releasedDate.split('T')[0] : '',
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
 * Generate a locale-specific boilerplate description wrapping the English
 * job content. Used as a deterministic fallback when AI translation fails.
 *
 * @param {{ title: string, location: string, enDescription: string }} opts
 * @param {string} locale - Target locale (it, de, fr)
 * @returns {string} Boilerplate description with English content appended
 */
export function buildLastminuteLocaleFallback({ title, location, enDescription }, locale) {
  const loc = location || 'Chiasso';
  const intros = {
    it: `lastminute.com cerca per la sede di ${loc} un/a ${title}. Scopri i dettagli della posizione e candidati online tramite il portale aziendale.`,
    de: `lastminute.com sucht am Standort ${loc} eine/n ${title}. Entdecken Sie die Details der Stelle und bewerben Sie sich online über das Unternehmensportal.`,
    fr: `lastminute.com recherche pour son site de ${loc} un/e ${title}. Découvrez les détails du poste et postulez en ligne via le portail de l'entreprise.`,
  };

  const intro = intros[locale];
  if (!intro) return '';

  // Append English content below the locale intro for context
  if (enDescription && enDescription.length > 100) {
    return `${intro}\n\n---\n\n${enDescription}`;
  }
  return intro;
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
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`⚠️ SR API ${res.status} for posting ${postingId}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    console.warn(`⚠️ SR API fetch failed for ${postingId}: ${err.message}`);
    return null;
  }
}
