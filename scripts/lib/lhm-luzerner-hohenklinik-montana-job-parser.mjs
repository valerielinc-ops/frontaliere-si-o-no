#!/usr/bin/env node
/**
 * Luzerner Höhenklinik Montana (LHM) — rehab clinic operated by Luzerner
 * Kantonsspital (LUKS) on the Crans-Montana plateau (VS, 1400 m a.s.l.).
 * Specialised in pulmonary + cardiovascular rehabilitation, psychosomatic
 * medicine and a sleep-medicine centre. German-speaking workplace inside
 * the francophone Valais — sits in our Valais coverage scope.
 *
 * Public career page (DE):
 *   https://www.lhm.ch/de/allgemein/jobs
 *
 * The listing is a static HTML page hosted on lhm.ch (no third-party ATS,
 * no AJAX). Each open position is a child page under `/de/allgemein/jobs/{slug}`
 * referenced as a list of <a href="…/jobs/{slug}"> links inside the same
 * portlet block. We:
 *
 *   1. fetch the listing page
 *   2. extract every child link under `/de/allgemein/jobs/{slug}` (excluding
 *      the `jobs-neu` overview placeholder and the `spontanbewerbung` link)
 *   3. fetch each detail page and pull the body text after the first <h1>
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

export const LHM_KEY = 'lhm-luzerner-hohenklinik-montana';
export const LHM_COMPANY_NAME = 'Luzerner Höhenklinik Montana';
export const LHM_COMPANY_DOMAIN = 'lhm.ch';

const LISTING_URL = 'https://www.lhm.ch/de/allgemein/jobs';
const DETAIL_DELAY_MS = 250;
const EXCLUDED_SLUGS = new Set(['jobs-neu', 'spontanbewerbung', '']);

export function isLhmJob(job) {
  const url = String(job?.url || '').toLowerCase();
  if (job?.companyKey === LHM_KEY) return true;
  return url.includes('lhm.ch');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'lhm.ch' || host.endsWith('.lhm.ch');
  } catch {
    return false;
  }
}

export function parseListing(html) {
  const out = [];
  const seen = new Set();
  const re = /href="(https?:\/\/(?:www\.)?lhm\.ch\/de\/allgemein\/jobs\/([a-z0-9][a-z0-9-]*?))"/gi;
  let m;
  while ((m = re.exec(html))) {
    const url = m[1];
    const slug = (m[2] || '').toLowerCase();
    if (!slug || EXCLUDED_SLUGS.has(slug)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, slug });
  }
  return out;
}

function extractH1(html) {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m) return '';
  return normalizeSpace(decodeEntities(m[1].replace(/<[^>]+>/g, ' ')));
}

function extractBodyText(html) {
  // The detail body is rendered as a stack of <p>/<h2>/<ul> elements after
  // the <h1>. Take the substring from the closing </h1> to the next footer.
  // If that fails, fall back to the whole document.
  const h1End = html.search(/<\/h1>/i);
  if (h1End < 0) return '';
  const tail = html.slice(h1End + '</h1>'.length, h1End + 30000); // generous cap
  const stopIdx = tail.search(/<footer|<div[^>]*class="[^"]*footer/i);
  const block = stopIdx > 0 ? tail.slice(0, stopIdx) : tail;
  // Strip nav portlets ("Suchen", "Sie sind hier:", contact widget,
  // breadcrumbs) — the LHM portal wraps everything in
  // `<div class="portlet-…">` blocks. Drop any portlet block with class
  // "search" or "breadcrumb".
  const cleaned = block
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<div[^>]*class="[^"]*(?:search|breadcrumb|navigation)[^"]*"[\s\S]*?<\/div>/gi, '');
  const text = htmlToText(cleaned);
  return normalizeSpace(text).slice(0, 6000);
}

async function fetchDetail(url) {
  try {
    const html = await fetchHtml(url);
    const title = extractH1(html);
    const body = extractBodyText(html);
    return { title, body };
  } catch (err) {
    console.warn(`  ⚠️ Detail fetch failed (${url}): ${err?.message || err}`);
    return { title: '', body: '' };
  }
}

function slugToTitle(slug) {
  return slug
    .replace(/-+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function fetchAllLhmJobs() {
  console.log(`🏥 Fetching ${LHM_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL}\n`);

  let listingHtml;
  try {
    listingHtml = await fetchHtml(LISTING_URL);
  } catch (err) {
    console.warn(`⚠️ Listing fetch failed: ${err?.message || err}`);
    return [];
  }

  const rows = parseListing(listingHtml);
  console.log(`  ✓ ${rows.length} job links discovered`);
  if (!rows.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];

  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (i > 0) await new Promise((res) => setTimeout(res, DETAIL_DELAY_MS));
    const detail = await fetchDetail(r.url);
    const title = detail.title || slugToTitle(r.slug);
    if (!title || title.length < 3) continue;

    const fallback = `${title} bei ${LHM_COMPANY_NAME}, Crans-Montana (VS). Stelle veröffentlicht auf der Karriereseite der Luzerner Höhenklinik Montana — einer Rehabilitationsklinik des Luzerner Kantonsspitals (LUKS) mit Spezialgebieten Pulmologie, Kardiologie und Psychosomatik.`;
    const description = detail.body && detail.body.split(/\s+/).length >= 30
      ? detail.body
      : [fallback, detail.body].filter(Boolean).join('\n\n');

    const sourceLang = detectLang(description || title, 'de');
    const jobSlug = slugify(`${title} ${LHM_KEY} crans-montana`);
    const urlHash = createHash('sha1').update(r.url).digest('hex').slice(0, 12);

    jobs.push({
      id: `${LHM_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: LHM_COMPANY_NAME,
      companyKey: LHM_KEY,
      companyDomain: LHM_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't (cache miss + AI quota), the flag stays and
      // `translate-pending.yml` picks the job up out-of-band.
      needsRetranslation: true,
      location: 'Crans-Montana',
      canton: 'VS',
      url: r.url,
      source: `${LHM_COMPANY_NAME} Dedicated Parser (Custom HTML)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: 'Crans-Montana',
      addressRegion: 'VS',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '3963',
      category: detectHealthcareCategory(`${title} ${description.slice(0, 600)}`),
      contract: 'full-time',
      employmentType: detectHealthcareEmploymentType(`${title} ${description.slice(0, 400)}`),
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: r.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`📋 Total ${LHM_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { LISTING_URL };
