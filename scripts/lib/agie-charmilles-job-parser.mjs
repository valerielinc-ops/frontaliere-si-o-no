import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
/**
 * AGIE Charmilles SA — HTML job parser
 *
 * Source: https://www.find-your-future.ch/it/lavoro-nel-settore-mem/settore-azienda/ritratti-aziendali/agie-charmilles-sa/
 *
 * The company profile page at find-your-future.ch renders all job listings as
 * server-side HTML. Each job has:
 *   - ID (hidden input with name="id" and type="joboffer")
 *   - Title (<li class="joboffer-name"><h3>...</h3></li>)
 *   - PLZ, canton, city (from inline dataLayer push)
 *   - Language, workload (from expanded detail section)
 *   - Detail URL (/it/arbeiten-mem-branche/branche-unternehmen/jobdetails/{slug}/)
 *   - Apply URL (tracking.jobchannel.ch redirect)
 *   - Location text (from expanded section, e.g. "Switzerland, Losone")
 *
 * AGIE Charmilles SA is part of GF Machining Solutions (Georg Fischer group),
 * headquartered in Losone (TI). They also have offices in Biel, Meyrin, Langnau.
 * GF Machining is a national manufacturer: we collect positions CH-wide across
 * all 26 cantons, inferring each job's canton from its own location signal.
 */

import { inferAnyCanton } from './target-swiss-locations.mjs';
import { isTargetCanton } from './crawler-location-config.mjs';
import { sourceLocaleDescription } from './source-locale-description.mjs';

const BASE_URL = 'https://www.find-your-future.ch';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * Reduce a raw location signal (PLZ + city + country prefix, possibly a list
 * like "6616 Losone, Meyrin or Biel") to a single clean city string suitable
 * for inferAnyCanton. We take the first listed city only: combining city +
 * region or multiple cities makes inferAnyCanton resolve the wrong canton.
 */
export function cleanAgieCharmillesCity(rawLocation = '') {
  // Strip a "CH-" / "CH " country prefix ONLY when followed by a separator, so
  // real cities starting with "Ch" (Chur, Chiasso, Cham, Chêne) are NOT mangled.
  let s = String(rawLocation || '').replace(/\bCH[-\s]+/i, '').trim();
  s = s.split(/,| or /i)[0].trim(); // first city only
  s = s.replace(/^\d{4}(?:\s+|-(?=\p{L}))(?=\p{L})/u, '').trim(); // strip leading 4-digit PLZ
  return s;
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

function decodeHtmlEntities(str = '') {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\*\/in/g, '')
    .trim();
}

/**
 * Parse the company profile page HTML to extract job offers.
 * Returns only jobs with type="joboffer" (not apprenticeships).
 *
 * @param {string} html - Raw HTML of the company profile page
 * @returns {{ items: Array<{ jobId: string, title: string, detailUrl: string, applyUrl: string, city: string, canton: string, plz: string, language: string, workload: string, locationText: string, isTemporary: boolean }> }}
 */
export function parseAgieCharmillesProfilePage(html = '') {
  const items = [];

  // Split on each joboffer list item — each starts with <li class="single color-separation">
  // inside the <ul class="standard-list joboffer-list"> section
  const jobofferSection = html.split('joboffer-list');
  if (jobofferSection.length < 2) return { items: [] };

  const jobsHtml = jobofferSection[1];

  // Each job block contains a hidden input with type="joboffer" and id value
  const jobBlocks = jobsHtml.split(/(?=<li class="mark-container)/);

  for (const block of jobBlocks) {
    // Extract job ID
    const idMatch = block.match(/<input\s+type="hidden"\s+name="id"\s+value="(\d+)"/);
    if (!idMatch) continue;

    const typeMatch = block.match(/<input\s+type="hidden"\s+name="type"\s+value="joboffer"/);
    if (!typeMatch) continue;

    const jobId = idMatch[1];

    // Extract title from <li class="joboffer-name"><h3>...</h3></li>
    const titleMatch = block.match(/<li\s+class="joboffer-name"><h3>([^<]+)<\/h3>/);
    if (!titleMatch) continue;
    const title = decodeHtmlEntities(normalizeSpace(titleMatch[1]));

    // Extract dataLayer push info: plz, kanton, ort
    const plzMatch = block.match(/'plz'\s*:\s*'([^']*)'/);
    const kantonMatch = block.match(/'kanton'\s*:\s*'([^']*)'/);
    const ortMatch = block.match(/'ort'\s*:\s*'([^']*)'/);
    const plz = plzMatch ? plzMatch[1] : '';
    const canton = kantonMatch ? kantonMatch[1] : '';
    const city = ortMatch ? ortMatch[1] : '';

    // Extract detail URL
    const detailMatch = block.match(/<a\s+href="(\/it\/arbeiten-mem-branche\/branche-unternehmen\/jobdetails\/[^"]+)"/);
    const detailUrl = detailMatch ? `${BASE_URL}${detailMatch[1]}` : '';

    // Extract apply URL (tracking redirect)
    const applyMatch = block.match(/<a\s+target="_blank"\s+href="(https:\/\/tracking\.jobchannel\.ch\/redirect\/[^"]+)"/);
    const applyUrl = applyMatch ? applyMatch[1] : '';

    // Extract language
    const langMatch = block.match(/Lingua:(\w+)/);
    const language = langMatch ? langMatch[1] : '';

    // Extract workload
    const workloadMatch = block.match(/Carico di lavoro:\s*\n?\s*(\d+%)/);
    const workload = workloadMatch ? workloadMatch[1] : '100%';

    // Extract temporary status
    const tempMatch = block.match(/Temporaneo:\s*\n?\s*(S[iì]|No)/i);
    const isTemporary = tempMatch ? /s[iì]/i.test(tempMatch[1]) : false;

    // Extract full location text from expanded details. This is the authoritative
    // per-job location: the 'ort' dataLayer push is unreliable (the national feed
    // emits "Biel/Bienne" for every offer) and the 'kanton' push is partially
    // wrong, so we derive the real city from this text.
    const locationTextMatch = block.match(/AGIE Charmilles SA,\s*([^<]+)/);
    const locationText = locationTextMatch ? normalizeSpace(locationTextMatch[1]) : city;

    // Clean single-city signal for canton inference + display (locationText first,
    // dataLayer 'ort' only as fallback).
    const cleanCity = cleanAgieCharmillesCity(locationText) || cleanAgieCharmillesCity(city);

    items.push({
      jobId,
      title,
      detailUrl,
      applyUrl,
      city: cleanCity || city,
      canton,
      plz,
      language,
      workload,
      isTemporary,
      locationText,
    });
  }

  return { items };
}

/**
 * Check whether a parsed job resolves to a Swiss canton (CH-wide, 26 cantons).
 * GF Machining is a national manufacturer, so we keep every job whose location
 * resolves to a real Swiss canton and drop only non-CH / unresolved offers.
 * Canton is inferred from the clean single-city signal — NEVER defaulted to TI.
 */
export function isAgieCharmillesSwissRelevant(job = {}) {
  return Boolean(inferAgieCharmillesCanton(job));
}

/**
 * Infer canton from job data, CH-wide.
 * Derives from the clean city name (authoritative — via BFS municipality dataset),
 * then falls back to the dataLayer 'kanton' value only as a last resort. The
 * dataLayer 'ort'/'kanton' pushes are unreliable on the national feed (every
 * offer reports "Biel/Bienne" and some Losone jobs are mistagged TI), so the
 * parsed clean city wins. Returns '' for non-CH / unresolved jobs (caller drops).
 */
export function inferAgieCharmillesCanton(job = {}) {
  const city = (job.city || '').trim();
  const cantonFromCity = city ? inferAnyCanton(cleanAgieCharmillesCity(city)) : '';
  if (cantonFromCity) return cantonFromCity;
  // Last-resort dataLayer fallback, only if it's a valid Swiss canton code.
  const dl = String(job.canton || '').trim().toUpperCase();
  return isTargetCanton(dl) ? dl : '';
}

/**
 * Infer job category from title.
 */
export function inferAgieCharmillesCategory(title = '') {
  const t = title.toLowerCase();
  if (/engineer|ingegnere|sviluppat|developer|software|plc|cnc/i.test(t)) return 'engineering';
  if (/project\s*lead|projekt|chef\s*de\s*projet/i.test(t)) return 'management';
  if (/simulation|research|r&d|ricerca/i.test(t)) return 'engineering';
  if (/control|automat/i.test(t)) return 'engineering';
  if (/logisti|magazzin|warehouse/i.test(t)) return 'logistics';
  if (/sales|vendita|commercial/i.test(t)) return 'sales';
  if (/admin|segretari|contabil/i.test(t)) return 'admin';
  if (/marketing|comunicazion/i.test(t)) return 'marketing';
  if (/hr|risorse\s*umane|human/i.test(t)) return 'hr';
  if (/meccan|mechanical|electric/i.test(t)) return 'engineering';
  if (/apprendist|apprentice|efz|afc/i.test(t)) return 'apprenticeship';
  return 'engineering';
}

/**
 * Strip HTML tags from a string.
 */
function stripHtml(html = '') {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
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

function extractJobListDescriptionHtml(html = '') {
  const match = String(html || '').match(/<p\b[^>]*class="[^"]*\bjob-list-desc\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
  return match ? match[1] : '';
}

function cleanAgieDetailDescription(text = '') {
  const headingByLine = new Map([
    ['Ihre Aufgaben', '## Ihre Aufgaben'],
    ['Ihr Profil', '## Ihr Profil'],
    ['Wir bieten', '## Wir bieten'],
    ['Über United Machining', '## Über United Machining'],
    ['Ihre Kontaktperson', '## Ihre Kontaktperson'],
  ]);
  const bulletHeadings = new Set(['## Ihre Aufgaben', '## Ihr Profil', '## Wir bieten']);
  const lines = String(text || '')
    .replace(/\\\*/g, '*')
    .split(/\n+/)
    .map((line) => normalizeSpace(decodeHtmlEntities(line)))
    .filter(Boolean);

  const out = [];
  const seen = new Set();
  let currentHeading = '';
  for (const line of lines) {
    if (/^(Indietro|Homepage|Mehr erfahren\.\.\.)$/i.test(line)) continue;
    if (/^Jetzt bewerben\b/i.test(line)) continue;
    if (/\bji[dtvy][a-z0-9]+\b/i.test(line)) continue;
    const normalized = line.replace(/\\-/g, '-');
    const heading = headingByLine.get(normalized);
    if (heading) {
      currentHeading = heading;
      if (!seen.has(heading.toLowerCase())) {
        seen.add(heading.toLowerCase());
        out.push(heading);
      }
      continue;
    }
    const value = bulletHeadings.has(currentHeading) ? `- ${normalized}` : normalized;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out.join('\n').trim();
}

/**
 * Parse a find-your-future.ch job detail page for rich description.
 * The detail page contains the full job description, requirements, and benefits.
 *
 * @param {string} html - Raw HTML of the detail page
 * @returns {{ description: string }}
 */
export function parseAgieCharmillesDetailPage(html = '') {
  const jobListDescriptionHtml = extractJobListDescriptionHtml(html);
  if (jobListDescriptionHtml) {
    const text = cleanAgieDetailDescription(stripHtml(jobListDescriptionHtml));
    if (text.split(/\s+/).length >= 50) return { description: text };
  }

  // Narrow to main content area first to avoid sidebar "other positions" contamination.
  const mainAreaMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    || html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    || html.match(/<div[^>]*class="[^"]*job-?detail[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
    || html.match(/<div[^>]*class="[^"]*vacancy[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const searchArea = mainAreaMatch ? mainAreaMatch[1] : html;

  const sections = [];

  // Strategy 1: Extract sections by heading + content
  const sectionRegex = /<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>\s*([\s\S]*?)(?=<h[2-4][^>]*>|<footer|<\/main|<\/article|$)/gi;
  let match;
  const skipHeadings = /cookie|datenschutz|privacy|navigation|menu|footer|header|breadcrumb|teilen|share|drucken|print|kontakt|contact|weitere\s+stellen|standort|arbeitgeber|unternehmen|firma|employer/i;

  while ((match = sectionRegex.exec(searchArea)) !== null) {
    const heading = stripHtml(match[1]).trim();
    if (!heading || heading.length > 100 || skipHeadings.test(heading)) continue;

    const content = stripHtml(match[2]).trim();
    if (!content || content.length < 20) continue;

    sections.push(`## ${heading}\n${content}`);
  }

  if (sections.length > 0) {
    const text = sections.join('\n\n');
    if (text.split(/\s+/).length >= 50) return { description: text };
  }

  // Strategy 2: Extract from article or main content area
  const mainMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    || html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    || html.match(/<div[^>]*class="[^"]*job-?detail[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

  if (mainMatch) {
    const text = cleanAgieDetailDescription(stripHtml(mainMatch[1]));
    if (text.split(/\s+/).length >= 50) return { description: text };
  }

  return { description: '' };
}

/**
 * Build localized content for an AGIE Charmilles job. The description is the
 * find-your-future detail text, whatever its length, published in its own
 * language slot only (`job.language` when the listing states it); the
 * translation step fills the other locales.
 *
 * This used to put a line of its own in front of the text ("<title> — AGIE
 * Charmilles SA (GF Machining Solutions), <city> (<canton>).") and copy the
 * result — German, for the Biel postings — into all four slots, so the
 * Italian/English/French pages showed the German posting and were never
 * translated; under 50 words it published a company paragraph of its own in
 * four languages instead. A posting without text now gets no description and
 * takes the pipeline's thin-source path.
 */
export function buildAgieCharmillesLocalizedContent(job = {}) {
  const title = String(job.title || '').trim();
  const city = String(job.city || 'Losone').trim();
  const source = sourceLocaleDescription(job.detailDescription, { defaultLang: 'en' });
  const sourceLang = String(job.language || '').trim().toLowerCase() || source.sourceLang;

  return {
    description: source.description,
    sourceLang,
    titleByLocale: { it: title, en: title, de: title, fr: title },
    descriptionByLocale: source.description ? { [sourceLang]: source.description } : {},
    slugByLocale: {
      it: slugify(`${title}-agie-charmilles-${city}`),
      en: slugify(`${title}-agie-charmilles-${city}`),
      de: slugify(`${title}-agie-charmilles-${city}`),
      fr: slugify(`${title}-agie-charmilles-${city}`),
    },
  };
}

// Fossils of the former builder in stored jobs: the header line in front of
// the posting, or the substituted company paragraph (four languages).
const AGIE_HEADER_RE = /^[^\n]{1,300}? — AGIE Charmilles SA \(GF Machining Solutions\), [^\n]{1,80}? \([A-Z]{2}\)\.\s*/;
const AGIE_FALLBACK_RE = /^AGIE Charmilles SA \(GF Machining Solutions\) (?:cerca|is hiring for|sucht|recrute) /;

/**
 * Remove the former builder's text from a stored job. Every locale slot held
 * the prefixed source (a copy, not a translation) or the substituted
 * paragraph, and the runner's merge keeps existing non-source slots, so all
 * slots are dropped and rebuilt by the translation step; the description keeps
 * only the posting text (nothing, when it was the substituted paragraph).
 *
 * @returns {boolean} true when the job carried the former text.
 */
export function dropAgieCharmillesFabricatedText(job) {
  if (!job || typeof job !== 'object') return false;
  const texts = [job.description, ...Object.values(job.descriptionByLocale || {})].map((t) => String(t || '').trim());
  if (!texts.some((t) => AGIE_HEADER_RE.test(t) || AGIE_FALLBACK_RE.test(t))) return false;
  const description = String(job.description || '').trim();
  const body = AGIE_FALLBACK_RE.test(description) ? '' : description.replace(AGIE_HEADER_RE, '').trim();
  const sourceLang = String(job.sourceLang || '').trim() || sourceLocaleDescription(body).sourceLang;
  job.description = body;
  job.descriptionByLocale = body ? { [sourceLang]: body } : {};
  job.needsRetranslation = true;
  return true;
}
