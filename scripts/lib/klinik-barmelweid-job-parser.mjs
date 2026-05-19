#!/usr/bin/env node
/**
 * Klinik Barmelweid job parser.
 *
 * Public career site: https://jobs.barmelweid.ch/offene-stellen
 *
 * TYPO3 site where each job is fully server-rendered as a clickable card:
 *
 *   <div class="hf-portrait ... hf-searchable-jobs sorting"
 *        onclick="javascript:location.href='/offene-stellen/stellenangebot/{UUID}'">
 *     <h3>{TITLE}</h3>
 *     <p>{INTRO}</p>
 *     <p>{PERCENT_AND_START_DATE}</p>
 *     ...
 *     <div class="hf-filterable-jobs">{GROUP_CODE}</div>
 *   </div>
 *
 * Detail page URL: https://jobs.barmelweid.ch/offene-stellen/stellenangebot/{UUID}
 *
 * Barmelweid is a 600-bed mountain hospital (psychiatry, somatic medicine,
 * rehabilitation) in Erlinsbach AG, with departments for sleep medicine,
 * psychosomatics, and a Kindertagesstätte. Group codes: ARZT, AUSB, ADMIN,
 * HOTEL, MEDTECH, PFLEGE, SB, THERAPIE, ZIVI.
 *
 * Polite delay: 250 ms between detail-page fetches.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import {
  decodeEntities,
  normalizeSpace,
  htmlToText,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';

// Barmelweid's TYPO3 stack returns HTTP 406 for anything that doesn't look
// like a real browser User-Agent, so we cannot reuse the shared `fetchHtml`
// helper (it uses the FrontaliereTicinoBot UA). Send a desktop-Chrome UA
// instead — same code path otherwise.
const BARMELWEID_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function fetchHtml(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-CH,de;q=0.9,en;q=0.5',
        'User-Agent': BARMELWEID_USER_AGENT,
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

export const KLINIK_BARMELWEID_KEY = 'klinik-barmelweid';
export const KLINIK_BARMELWEID_COMPANY_NAME = 'Klinik Barmelweid';
export const KLINIK_BARMELWEID_COMPANY_DOMAIN = 'barmelweid.ch';

const BASE_URL = 'https://jobs.barmelweid.ch';
const LISTING_URL = `${BASE_URL}/offene-stellen`;
const DETAIL_DELAY_MS = 250;

const GROUP_CODE_CATEGORY = {
  ARZT: 'Sanità / Ospedali',
  PFLEGE: 'Sanità / Ospedali',
  THERAPIE: 'Sanità / Ospedali',
  MEDTECH: 'Sanità / Ospedali',
  SB: 'Sanità / Ospedali',
  ADMIN: 'Amministrazione',
  HOTEL: 'Ospitalità',
  AUSB: 'Formazione',
  ZIVI: 'Formazione',
};

export function isKlinikBarmelweidJob(job) {
  const url = String(job?.url || '').toLowerCase();
  return job?.companyKey === KLINIK_BARMELWEID_KEY || url.includes('barmelweid.ch');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'barmelweid.ch' || host.endsWith('.barmelweid.ch');
  } catch {
    return false;
  }
}

/**
 * Parse the listing page into `{ url, title, intro, pensum, startDate,
 * groupCode }` rows.
 */
export function parseListing(html) {
  const out = [];
  const seen = new Set();
  const cardRe = /<div\s+class="hf-portrait[^"]*"[^>]*onclick="javascript:location\.href='([^']+)'"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g;
  let m;
  while ((m = cardRe.exec(html))) {
    const rel = m[1];
    const body = m[2];
    const url = rel.startsWith('http') ? rel : `${BASE_URL}${rel}`;
    if (seen.has(url)) continue;
    seen.add(url);

    const titleMatch = body.match(/<h3[^>]*>([\s\S]{3,400}?)<\/h3>/i);
    const title = titleMatch
      ? normalizeSpace(decodeEntities(titleMatch[1].replace(/<[^>]+>/g, '')))
      : '';
    if (!title || title.length < 5) continue;

    // Multiple <p> blocks — first non-empty is the intro, last is the
    // pensum + start date line ("100%, 01.08.2027").
    const pBlocks = [];
    const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    let pm;
    while ((pm = pRe.exec(body))) {
      const pTxt = normalizeSpace(htmlToText(pm[1]));
      if (pTxt) pBlocks.push(pTxt);
    }
    const pensumLine = pBlocks[pBlocks.length - 1] || '';
    const intro = pBlocks.length > 1 ? pBlocks.slice(0, -1).join('\n\n') : '';

    const groupMatch = body.match(/<div\s+class="hf-filterable-jobs[^"]*"[^>]*>\s*([A-Z]+)\s*<\/div>/);
    const groupCode = groupMatch ? groupMatch[1] : '';

    out.push({ url, title, intro, pensumLine, groupCode });
  }
  return out;
}

async function fetchDetailDescription(detailUrl) {
  try {
    const html = await fetchHtml(detailUrl);
    if (!html) return '';
    // Detail pages are TYPO3 — the offer text sits inside the main content
    // wrapper. We strip scripts/styles/header/footer and take the longest
    // text block we find.
    const noScripts = String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '');
    const bodyMatch = noScripts.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const block = bodyMatch ? bodyMatch[1] : noScripts;
    const text = htmlToText(block);
    return normalizeSpace(text).slice(0, 6000);
  } catch (err) {
    console.warn(`  ⚠️ Barmelweid detail fetch failed (${detailUrl}): ${err?.message || err}`);
    return '';
  }
}

export async function fetchAllKlinikBarmelweidJobs() {
  console.log(`🏥 Fetching ${KLINIK_BARMELWEID_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL}\n`);

  const html = await fetchHtml(LISTING_URL);
  const rows = parseListing(html);
  console.log(`  ✓ ${rows.length} jobs from listing page`);
  if (!rows.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (i > 0) await new Promise((res) => setTimeout(res, DETAIL_DELAY_MS));
    const detailDescription = await fetchDetailDescription(r.url);
    const summary = [r.intro, r.pensumLine].filter(Boolean).join('\n\n');
    const description = detailDescription && detailDescription.split(/\s+/).length >= 30
      ? detailDescription
      : [
        summary,
        'Klinik Barmelweid — Akutspital für Psychiatrie, Psychosomatik und somatische Rehabilitation in Erlinsbach (AG).',
      ].filter(Boolean).join('\n\n');

    const sourceLang = detectLang(description || r.title, 'de');
    const jobSlug = slugify(`${r.title} ${KLINIK_BARMELWEID_KEY} barmelweid`);
    const urlHash = createHash('sha1').update(r.url).digest('hex').slice(0, 12);

    const category = GROUP_CODE_CATEGORY[r.groupCode]
      || detectHealthcareCategory(`${r.title} ${r.intro}`);

    jobs.push({
      id: `${KLINIK_BARMELWEID_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: KLINIK_BARMELWEID_COMPANY_NAME,
      companyKey: KLINIK_BARMELWEID_KEY,
      companyDomain: KLINIK_BARMELWEID_COMPANY_DOMAIN,
      title: r.title,
      titleByLocale: { [sourceLang]: r.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't (cache miss + AI quota), the flag stays and
      // `translate-pending.yml` picks the job up out-of-band. Without this
      // flag the locale-completeness gate trips before translation can run.
      needsRetranslation: true,
      location: 'Barmelweid',
      canton: 'AG',
      url: r.url,
      source: `${KLINIK_BARMELWEID_COMPANY_NAME} Dedicated Parser (TYPO3 HTML)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: 'Barmelweid',
      addressRegion: 'AG',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '5017',
      category,
      contract: 'full-time',
      employmentType: detectHealthcareEmploymentType(`${r.title} ${r.pensumLine}`),
      experienceLevel: detectHealthcareExperienceLevel(r.title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: r.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`\n📋 Total ${KLINIK_BARMELWEID_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { LISTING_URL };
