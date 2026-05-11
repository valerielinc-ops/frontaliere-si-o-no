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
 * We filter for Ticino-relevant positions (Losone = canton TI).
 */

import { isTargetSwissLocation, inferAnyCanton } from './target-swiss-locations.mjs';
import { isTargetCanton } from './crawler-location-config.mjs';

const BASE_URL = 'https://www.find-your-future.ch';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
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

function decodeHtmlEntities(str = '') {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/g, "'")
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

    // Extract full location text from expanded details
    const locationTextMatch = block.match(/AGIE Charmilles SA,\s*([^<]+)/);
    const locationText = locationTextMatch ? normalizeSpace(locationTextMatch[1]) : city;

    items.push({
      jobId,
      title,
      detailUrl,
      applyUrl,
      city,
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
 * Check if a parsed job is target-CH-relevant based on canton and city.
 */
export function isAgieCharmillesTicinoRelevant(job = {}) {
  if (isTargetCanton(job.canton)) return true;
  const city = (job.city || '').toLowerCase();
  const locationText = (job.locationText || '').toLowerCase();
  return isTargetSwissLocation(`${city} ${locationText}`);
}

/**
 * Infer canton from job data.
 * Derives from city name first (authoritative — via BFS municipality dataset),
 * then falls back to the dataLayer value. This prevents source sites that
 * embed headquarters canton for all jobs from mislabelling remote-office jobs
 * (e.g. GF Machining tagging Biel jobs as TI).
 */
export function inferAgieCharmillesCanton(job = {}) {
  const city = (job.city || '').trim();
  const cantonFromCity = city ? inferAnyCanton(city) : '';
  if (cantonFromCity) return cantonFromCity;
  return job.canton || '';
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

/**
 * Parse a find-your-future.ch job detail page for rich description.
 * The detail page contains the full job description, requirements, and benefits.
 *
 * @param {string} html - Raw HTML of the detail page
 * @returns {{ description: string }}
 */
export function parseAgieCharmillesDetailPage(html = '') {
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
    const text = stripHtml(mainMatch[1]).trim();
    if (text.split(/\s+/).length >= 50) return { description: text };
  }

  return { description: '' };
}

/**
 * Build localized content for an AGIE Charmilles job.
 */
export function buildAgieCharmillesLocalizedContent(job = {}) {
  const title = String(job.title || '').trim();
  const city = String(job.city || 'Losone').trim();
  const detailDescription = String(job.detailDescription || '').trim();

  // If we have a rich detail description (>= 50 words), use it
  if (detailDescription && detailDescription.split(/\s+/).length >= 50) {
    const metaLine = `${title} — AGIE Charmilles SA (GF Machining Solutions), ${city} (TI).`;
    const description = `${metaLine}\n\n${detailDescription}`;
    return {
      titleByLocale: { it: title, en: title, de: title, fr: title },
      descriptionByLocale: { it: description, en: description, de: description, fr: description },
      slugByLocale: {
        it: slugify(`${title}-agie-charmilles-${city}`),
        en: slugify(`${title}-agie-charmilles-${city}`),
        de: slugify(`${title}-agie-charmilles-${city}`),
        fr: slugify(`${title}-agie-charmilles-${city}`),
      },
    };
  }

  // Richer fallback descriptions (>50 words each)
  const itDesc = `AGIE Charmilles SA (GF Machining Solutions) cerca ${title} a ${city}. L'azienda è leader mondiale nelle macchine utensili ad alta precisione, specializzata in elettroerosione (EDM), fresatura ad alta velocità, tecnologia laser e produzione additiva (AM). Con sede a Losone (TI) e parte del gruppo internazionale Georg Fischer, AGIE Charmilles offre un ambiente di lavoro innovativo e tecnologicamente avanzato, con opportunità di crescita professionale in un contesto multinazionale. Candidati tramite il portale find-your-future.ch.`;
  const enDesc = `AGIE Charmilles SA (GF Machining Solutions) is hiring for ${title} in ${city}. The company is a global leader in high-precision machine tools, specializing in electrical discharge machining (EDM), high-speed milling, laser technology, and additive manufacturing (AM). Based in Losone (TI) and part of the international Georg Fischer group, AGIE Charmilles offers an innovative and technologically advanced work environment with professional growth opportunities in a multinational context. Apply through the find-your-future.ch portal.`;
  const deDesc = `AGIE Charmilles SA (GF Machining Solutions) sucht ${title} in ${city}. Das Unternehmen ist Weltmarktführer für hochpräzise Werkzeugmaschinen, spezialisiert auf Funkenerosion (EDM), Hochgeschwindigkeitsfräsen, Lasertechnologie und additive Fertigung (AM). Mit Sitz in Losone (TI) und als Teil der internationalen Georg Fischer Gruppe bietet AGIE Charmilles ein innovatives und technologisch fortschrittliches Arbeitsumfeld mit Möglichkeiten zur beruflichen Weiterentwicklung in einem multinationalen Kontext. Bewerben Sie sich über das Portal find-your-future.ch.`;
  const frDesc = `AGIE Charmilles SA (GF Machining Solutions) recrute ${title} à ${city}. L'entreprise est un leader mondial des machines-outils de haute précision, spécialisée dans l'électroérosion (EDM), le fraisage à grande vitesse, la technologie laser et la fabrication additive (AM). Basée à Losone (TI) et faisant partie du groupe international Georg Fischer, AGIE Charmilles offre un environnement de travail innovant et technologiquement avancé avec des opportunités de développement professionnel dans un contexte multinational. Postulez via le portail find-your-future.ch.`;

  return {
    titleByLocale: { it: title, en: title, de: title, fr: title },
    descriptionByLocale: { it: itDesc, en: enDesc, de: deDesc, fr: frDesc },
    slugByLocale: {
      it: slugify(`${title}-agie-charmilles-${city}`),
      en: slugify(`${title}-agie-charmilles-${city}`),
      de: slugify(`${title}-agie-charmilles-${city}`),
      fr: slugify(`${title}-agie-charmilles-${city}`),
    },
  };
}
