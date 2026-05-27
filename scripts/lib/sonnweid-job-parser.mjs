#!/usr/bin/env node
/**
 * Pflegezentrum Sonnweid (Wetzikon, ZH) job parser — Custom HTML.
 *
 * Sonnweid is a specialist dementia-care home / "Demenz-Kompetenzzentrum" with
 * ~200+ employees in the Zürcher Oberland (Wetzikon, ZH). Independent
 * foundation, no group-wide ATS — uses a hand-rolled WordPress jobs listing
 * that renders the openings as `<a class="jobItem">` cards on a static page.
 *
 * Public career site:
 *   https://www.sonnweid.ch/karriere/
 *   https://www.sonnweid.ch/karriere/offene-stellen/   ← parsed
 *
 * Each card looks like:
 *   <a href="https://www.sonnweid.ch/karriere/job/{slug}/" class="jobItem">
 *     <div class="jobItemInner">
 *       <div class="uk-width-1-2@m jobItemTitle">{TITLE}</div>
 *       <div class="… jobItemPensum">Pensum:<br>{PENSUM}</div>
 *       <div class="… jobItemEintritt">Eintritt:<br>{START}</div>
 *     </div>
 *   </a>
 *
 * Detail page (`/karriere/job/{slug}/`) contains the full description in the
 * `pagecontent singlejob` container, with h2 sections "Ihre Aufgaben",
 * "Sie bringen mit", "Wir bieten Ihnen".
 *
 * Some "job" cards are actually PDF info-sheets (Wiedereinstieg) — those URLs
 * contain `/job/https-www-sonnweid-ch-wp-content-uploads-` and are filtered.
 *
 * Polite delay: 250 ms between detail-page fetches.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  htmlToText,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';

export const SONNWEID_KEY = 'sonnweid';
export const SONNWEID_COMPANY_NAME = 'Pflegezentrum Sonnweid';
export const SONNWEID_COMPANY_DOMAIN = 'sonnweid.ch';

const LISTING_URL = 'https://www.sonnweid.ch/karriere/offene-stellen/';
const DETAIL_DELAY_MS = 250;

const SONNWEID_CITY = 'Wetzikon';
const SONNWEID_CANTON = 'ZH';
const SONNWEID_POSTAL = '8623';

export function isSonnweidJob(job) {
  const url = String(job?.url || '').toLowerCase();
  if (job?.companyKey === SONNWEID_KEY) return true;
  if (url.includes('sonnweid.ch')) return true;
  return false;
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'sonnweid.ch' || host.endsWith('.sonnweid.ch')) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Parse the listing HTML into `{ url, title, pensum, eintritt }` rows.
 * Filters out PDF info-sheets masquerading as job cards.
 */
export function parseListing(html) {
  const out = [];
  const seen = new Set();
  // <a class="jobItem" …> … </a>  (the closing </a> is balanced because
  // the card has no nested links). Use a non-greedy stop at </a>.
  const re = /<a[^>]*href="(https:\/\/www\.sonnweid\.ch\/karriere\/job\/[^"]+)"[^>]*class="jobItem"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const url = m[1].replace(/&amp;/g, '&');
    // Filter PDF info-sheets — their slug starts with `https-www-sonnweid-ch-wp-content-uploads-...`
    if (/\/job\/https-www-sonnweid-ch-wp-content-uploads/i.test(url)) continue;
    if (seen.has(url)) continue;
    const body = m[2];
    const titleMatch = body.match(/class="[^"]*jobItemTitle[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (!titleMatch) continue;
    const title = normalizeSpace(decodeEntities(titleMatch[1].replace(/<[^>]+>/g, ' ')));
    if (!title) continue;
    const pensumMatch = body.match(/class="[^"]*jobItemPensum[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const eintrittMatch = body.match(/class="[^"]*jobItemEintritt[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const pensum = pensumMatch ? normalizeSpace(htmlToText(pensumMatch[1])).replace(/^Pensum:\s*/i, '') : '';
    const eintritt = eintrittMatch ? normalizeSpace(htmlToText(eintrittMatch[1])).replace(/^Eintritt:\s*/i, '') : '';
    seen.add(url);
    out.push({ url, title, pensum, eintritt });
  }
  return out;
}

function extractDetailBody(html) {
  // The job description lives in `<div class="… pagecontent singlejob …">`.
  // Capture from that container; if not found, fall back to <main>.
  const single = html.match(/<div[^>]*class="[^"]*pagecontent\s+singlejob[^"]*"[^>]*>([\s\S]*?)<\/main>/i)
    || html.match(/<div[^>]*class="[^"]*pagecontent\s+singlejob[^"]*"[^>]*>([\s\S]*?)<footer/i);
  const raw = single ? single[1] : (html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1] || '');
  if (!raw) return '';
  // Drop the related-jobs block (`<div class="jobs">…</div>`) — it lists OTHER
  // openings and would pollute every job's description identically.
  const cleaned = raw.replace(/<div[^>]*class="[^"]*\bjobs\b[^"]*"[^>]*>[\s\S]*$/i, '');
  return normalizeSpace(htmlToText(cleaned)).slice(0, 6000);
}

async function fetchDetail(url) {
  try {
    const html = await fetchHtml(url);
    return { body: extractDetailBody(html) };
  } catch (err) {
    console.warn(`  ⚠️ Detail fetch failed (${url}): ${err?.message || err}`);
    return { body: '' };
  }
}

export async function fetchAllSonnweidJobs() {
  console.log(`🏥 Fetching ${SONNWEID_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL}\n`);

  let listingHtml;
  try {
    listingHtml = await fetchHtml(LISTING_URL);
  } catch (err) {
    console.warn(`  ⚠️ Listing fetch failed: ${err?.message || err}`);
    return [];
  }
  const rows = parseListing(listingHtml);
  console.log(`  ✓ listing: ${rows.length} jobs`);
  if (!rows.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (i > 0) await new Promise((res) => setTimeout(res, DETAIL_DELAY_MS));
    const detail = await fetchDetail(r.url);

    const pensumText = r.pensum ? ` Pensum: ${r.pensum}.` : '';
    const eintrittText = r.eintritt ? ` Eintritt: ${r.eintritt}.` : '';
    const fallback = `${r.title} im ${SONNWEID_COMPANY_NAME}, ${SONNWEID_CITY} (${SONNWEID_CANTON}).${pensumText}${eintrittText}`.trim();
    const description = detail.body && detail.body.split(/\s+/).length >= 30
      ? detail.body
      : [fallback, detail.body].filter(Boolean).join('\n\n');

    const sourceLang = detectLang(description || r.title, 'de');
    const jobSlug = slugify(`${r.title} ${SONNWEID_KEY} ${SONNWEID_CITY}`);
    const urlHash = createHash('sha1').update(r.url).digest('hex').slice(0, 12);

    // Combine pensum + title text for employment-type detection (Pensum "80-100%" → FULL_TIME)
    const employmentText = `${r.title} ${r.pensum}`;

    jobs.push({
      id: `${SONNWEID_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SONNWEID_COMPANY_NAME,
      companyKey: SONNWEID_KEY,
      companyDomain: SONNWEID_COMPANY_DOMAIN,
      title: r.title,
      titleByLocale: { [sourceLang]: r.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't (cache miss + AI quota), the flag stays and
      // `translate-pending.yml` picks the job up out-of-band.
      needsRetranslation: true,
      location: SONNWEID_CITY,
      canton: SONNWEID_CANTON,
      url: r.url,
      source: `${SONNWEID_COMPANY_NAME} Dedicated Parser (Custom HTML — WordPress)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: SONNWEID_CITY,
      addressRegion: SONNWEID_CANTON,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: SONNWEID_POSTAL,
      category: detectHealthcareCategory(`${r.title} ${description.slice(0, 600)}`),
      contract: 'full-time',
      employmentType: detectHealthcareEmploymentType(employmentText),
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

  console.log(`📋 Total ${SONNWEID_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { LISTING_URL };
