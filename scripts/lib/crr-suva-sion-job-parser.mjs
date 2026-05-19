#!/usr/bin/env node
/**
 * Clinique romande de réadaptation (CRR) — Suva-operated reference rehab
 * clinic in Sion (VS). Specialised in trauma rehabilitation and
 * reintegration of accident victims; ~580 collaborators. The Sion site
 * sits in the French-speaking Valais and is the Romandie counterpart of
 * Rehab Bellikon (AG).
 *
 * Public career page:
 *   https://www.crr-suva.ch/clinique-readaptation/carriere-797.html
 *
 * The listing page is a static HTML page (TYPO3-style; no third-party
 * ATS). Each opening is rendered as:
 *
 *   <a class="listElement" href="/clinique-readaptation/{slug}-{id}.html">
 *     {TITLE}
 *     Entrée en fonction : {DATE}
 *     Taux d'activité {…} {DD.MM.YYYY}
 *   </a>
 *
 * The DD.MM.YYYY date is the "online since" date — present only on real
 * job postings, not on the generic intro / "Rejoindre les soins" /
 * "Candidature spontanée" cards. We use that as the filter.
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

export const CRR_KEY = 'crr-suva-sion';
export const CRR_COMPANY_NAME = 'Clinique romande de réadaptation (CRR Suva)';
export const CRR_COMPANY_DOMAIN = 'crr-suva.ch';

const LISTING_URL = 'https://www.crr-suva.ch/clinique-readaptation/carriere-797.html';
const BASE_HOST = 'https://www.crr-suva.ch';
const DETAIL_DELAY_MS = 250;
// Pages on the same path that are NOT real jobs (intros, application
// instructions, café-carrière event, etc.). The DD.MM.YYYY date check is
// the primary filter; this set adds a belt-and-braces safeguard.
const EXCLUDED_SLUG_PATTERNS = [
  /candidature-spontanee/i,
  /cafe-carriere/i,
  /soins-infirmiers/i,
  /partenaires-carriere/i,
  /devenir-apprenti/i,
];

export function isCrrJob(job) {
  const url = String(job?.url || '').toLowerCase();
  if (job?.companyKey === CRR_KEY) return true;
  return url.includes('crr-suva.ch');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'crr-suva.ch' || host.endsWith('.crr-suva.ch');
  } catch {
    return false;
  }
}

const DATE_RX = /(\d{2})\.(\d{2})\.(\d{4})/;

export function parseListing(html) {
  const out = [];
  const seen = new Set();
  const re = /<a[^>]*class="listElement"[^>]*href="(\/clinique-readaptation\/[^"]+\.html)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const path = m[1];
    const inner = normalizeSpace(decodeEntities(m[2].replace(/<[^>]+>/g, ' ')));
    if (EXCLUDED_SLUG_PATTERNS.some((rx) => rx.test(path))) continue;
    const dateMatch = inner.match(DATE_RX);
    if (!dateMatch) continue; // only real postings show DD.MM.YYYY
    const url = new URL(path, BASE_HOST).href;
    if (seen.has(url)) continue;
    seen.add(url);
    // Take the title up to the first "Entrée" or " Taux d'activité" marker.
    const title = inner.split(/\bEntrée|\bTaux d'activité|\b\d{2}\.\d{2}\.\d{4}/)[0].trim();
    const postedDate = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
    out.push({ url, title, postedDate });
  }
  return out;
}

function extractDetailBody(html) {
  const h1End = html.search(/<\/h1>/i);
  if (h1End < 0) return '';
  const tail = html.slice(h1End + '</h1>'.length, h1End + 30000);
  const stopIdx = tail.search(/<footer|<aside|<div[^>]*class="[^"]*(?:footer|sidebar|partenaires)/i);
  const block = stopIdx > 0 ? tail.slice(0, stopIdx) : tail;
  const cleaned = block
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<div[^>]*class="[^"]*(?:share|partage|breadcrumb)[^"]*"[\s\S]*?<\/div>/gi, '');
  return normalizeSpace(htmlToText(cleaned)).slice(0, 6000);
}

function extractH1(html) {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m) return '';
  return normalizeSpace(decodeEntities(m[1].replace(/<[^>]+>/g, ' ')));
}

async function fetchDetail(url) {
  try {
    const html = await fetchHtml(url);
    return { title: extractH1(html), body: extractDetailBody(html) };
  } catch (err) {
    console.warn(`  ⚠️ Detail fetch failed (${url}): ${err?.message || err}`);
    return { title: '', body: '' };
  }
}

export async function fetchAllCrrJobs() {
  console.log(`🏥 Fetching ${CRR_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL}\n`);

  let html;
  try {
    html = await fetchHtml(LISTING_URL);
  } catch (err) {
    console.warn(`⚠️ Listing fetch failed: ${err?.message || err}`);
    return [];
  }
  const rows = parseListing(html);
  console.log(`  ✓ ${rows.length} dated openings discovered`);
  if (!rows.length) return [];

  const jobs = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (i > 0) await new Promise((res) => setTimeout(res, DETAIL_DELAY_MS));
    const detail = await fetchDetail(r.url);
    const title = detail.title || r.title;
    if (!title || title.length < 3) continue;

    const fallback = `${title} à la Clinique romande de réadaptation (CRR Suva), Sion (VS). Institution de référence en réadaptation et réinsertion des personnes victimes d'accidents, au cœur du Valais.`;
    const description = detail.body && detail.body.split(/\s+/).length >= 30
      ? detail.body
      : [fallback, detail.body].filter(Boolean).join('\n\n');

    const sourceLang = detectLang(description || title, 'fr');
    const jobSlug = slugify(`${title} ${CRR_KEY} sion`);
    const urlHash = createHash('sha1').update(r.url).digest('hex').slice(0, 12);

    jobs.push({
      id: `${CRR_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CRR_COMPANY_NAME,
      companyKey: CRR_KEY,
      companyDomain: CRR_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't (cache miss + AI quota), the flag stays and
      // `translate-pending.yml` picks the job up out-of-band.
      needsRetranslation: true,
      location: 'Sion',
      canton: 'VS',
      url: r.url,
      source: `${CRR_COMPANY_NAME} Dedicated Parser (Custom HTML)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: 'Sion',
      addressRegion: 'VS',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '1950',
      category: detectHealthcareCategory(`${title} ${description.slice(0, 600)}`),
      contract: 'full-time',
      employmentType: detectHealthcareEmploymentType(`${title} ${description.slice(0, 400)}`),
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: r.postedDate,
      applyUrl: r.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`📋 Total ${CRR_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { LISTING_URL };
