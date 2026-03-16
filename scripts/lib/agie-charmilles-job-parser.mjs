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

import { isTicinoRelevant, isGrigioniRelevant } from './target-swiss-locations.mjs';

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
 * Check if a parsed job is Ticino-relevant based on canton and city.
 */
export function isAgieCharmillesTicinoRelevant(job = {}) {
  if (job.canton === 'TI') return true;
  const city = (job.city || '').toLowerCase();
  const locationText = (job.locationText || '').toLowerCase();
  if (isTicinoRelevant(city) || isTicinoRelevant(locationText)) return true;
  if (/losone|locarno|bellinzona|lugano|mendrisio|chiasso|ascona|muralto/i.test(city)) return true;
  if (/losone|locarno|bellinzona|lugano|mendrisio|chiasso|ascona|muralto/i.test(locationText)) return true;
  return false;
}

/**
 * Infer canton from job data.
 */
export function inferAgieCharmillesCanton(job = {}) {
  if (job.canton === 'TI') return 'TI';
  if (job.canton === 'GR') return 'GR';
  const city = (job.city || '').toLowerCase();
  if (/losone|locarno|ascona|muralto|minusio|bellinzona|lugano|mendrisio|chiasso/i.test(city)) return 'TI';
  if (isGrigioniRelevant(city)) return 'GR';
  return job.canton || 'TI';
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
 * Build localized content for an AGIE Charmilles job.
 */
export function buildAgieCharmillesLocalizedContent(job = {}) {
  const title = String(job.title || '').trim();
  const city = String(job.city || 'Losone').trim();

  const itDesc = `AGIE Charmilles SA (GF Machining Solutions) cerca ${title} a ${city}. Azienda leader mondiale nelle macchine utensili ad alta precisione (elettroerosione, fresatura, laser, AM). Sede a Losone (TI), parte del gruppo Georg Fischer.`;
  const enDesc = `AGIE Charmilles SA (GF Machining Solutions) is hiring for ${title} in ${city}. Global leader in high-precision machine tools (EDM, milling, laser, AM). Based in Losone (TI), part of the Georg Fischer group.`;
  const deDesc = `AGIE Charmilles SA (GF Machining Solutions) sucht ${title} in ${city}. Weltmarktfuehrer fuer hochpraezise Werkzeugmaschinen (EDM, Fraesen, Laser, AM). Sitz in Losone (TI), Teil der Georg Fischer Gruppe.`;
  const frDesc = `AGIE Charmilles SA (GF Machining Solutions) recrute ${title} a ${city}. Leader mondial des machines-outils de haute precision (EDM, fraisage, laser, AM). Siege a Losone (TI), groupe Georg Fischer.`;

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
