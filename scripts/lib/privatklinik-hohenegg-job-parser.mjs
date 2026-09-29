#!/usr/bin/env node
/**
 * Privatklinik Hohenegg (Meilen ZH) job parser — Refline ATS tenant 640332.
 *
 * Public career site: https://www.hohenegg.ch/stellen/
 *   → embeds Refline at https://apply.refline.ch/640332/search.html
 *
 * Hohenegg is a private psychiatric / psychosomatic clinic
 * on the eastern shore of Lake Zurich (8706 Meilen), specialised in
 * burnout, depression, anxiety and psychosomatic disorders.
 * ~250 employees, owned by the Stiftung Privatklinik Hohenegg.
 *
 * Refline listing format: `<a href=".../{posId}/pub/{rev}/index.html">Title</a>`
 * where posId is a 4-digit zero-padded alphanumeric (e.g. 0052, 0047).
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { fetchHtml, slugify, stripHtml, normalizeSpace } from './crawler-template.mjs';
import { parseReflineDetail } from './refline-common.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const PRIVATKLINIK_HOHENEGG_KEY = 'privatklinik-hohenegg';
export const PRIVATKLINIK_HOHENEGG_COMPANY_NAME = 'Privatklinik Hohenegg';

/**
 * A fragment only the crawler's former stand-in description wrote (company
 * paragraph and "Was die Hohenegg bietet:" list), for
 * `dropFabricatedDescriptions` on the stored jobs (issue 5253).
 */
export const PRIVATKLINIK_HOHENEGG_FABRICATED_DESCRIPTION_RE = /Was die Hohenegg bietet:\n• Modernes Klinikumfeld mit hoher fachlicher Qualität/;
export const PRIVATKLINIK_HOHENEGG_COMPANY_DOMAIN = 'hohenegg.ch';

const REFLINE_TENANT = '640332';
const REFLINE_LISTING_URL = `https://apply.refline.ch/${REFLINE_TENANT}/search.html`;
const PUBLIC_CAREER_URL = 'https://www.hohenegg.ch/stellen/';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

export function isPrivatklinikHoheneggJob(job) {
  const key = normalize(job?.companyKey || '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');
  return (
    key === PRIVATKLINIK_HOHENEGG_KEY ||
    key.startsWith('privatklinik-hohenegg') ||
    key === 'hohenegg' ||
    company.includes('hohenegg') ||
    url.includes('hohenegg.ch') ||
    url.includes(`apply.refline.ch/${REFLINE_TENANT}`)
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'hohenegg.ch' || host.endsWith('.hohenegg.ch')) return true;
    if ((host === 'apply.refline.ch' || host === 'pub.refline.ch') && rawUrl.includes(`/${REFLINE_TENANT}/`)) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Detection helpers ─────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(pflege|pflegefach|stationsleitung|fage|nachtwache|gesundheit|hf|efz|psychiatr)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(arzt|ärztin|oberarzt|chefarzt|leitend|medizin|psychotherap|psycholog)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(labor|laborant|biomedizin|analyse|radiolog|röntgen|mtra|physiother|ergo|logopäd)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(techni|haustechni|facility|wartung)/.test(t)) return 'Tecnica';
  if (/\b(it|software|develop|programm|system|informatik)/.test(t)) return 'IT';
  if (/\b(admin|sekret|buchhalt|sachbearbeiter|finanz|controll|account)/.test(t)) return 'Amministrazione';
  if (/\b(hr|human|personal|talent|recruit)/.test(t)) return 'Risorse Umane';
  if (/\b(küche|koch|gastro|hauswirtschaft|reinigung|hotellerie|haus.?dienst)/.test(t)) return 'Ospitalità';
  if (/\b(lehrstelle|lernend|praktik|ausbildung|trainee)/.test(t)) return 'Formazione';
  return 'Sanità / Ospedali';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(lehrstelle|lernend|praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprenti|ausbildung|trainee)/.test(t)) return 'intern';
  if (/\b(junior|jr|assistent)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|chef|verantwort|leiter|leitend|stationsleitung|oberarzt|chefarzt)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(workload = '', title = '') {
  const source = `${workload} ${title}`.toLowerCase();
  if (/teilzeit|part[- ]?time/.test(source)) return 'PART_TIME';
  const range = source.match(/(\d{1,3})\s*[-–%]\s*(\d{1,3})\s*%/);
  if (range) {
    const maxPct = parseInt(range[2], 10);
    return maxPct < 80 ? 'PART_TIME' : 'FULL_TIME';
  }
  const single = source.match(/(\d{1,3})\s*%/);
  if (single) {
    const v = parseInt(single[1], 10);
    return v < 80 ? 'PART_TIME' : 'FULL_TIME';
  }
  if (/vollzeit|full[- ]?time|100\s*%/.test(source)) return 'FULL_TIME';
  return 'FULL_TIME';
}

function extractPensum(workload = '') {
  const range = workload.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/);
  if (range) return { min: parseInt(range[1], 10), max: parseInt(range[2], 10) };
  const single = workload.match(/(\d{2,3})\s*%/);
  if (single) {
    const v = parseInt(single[1], 10);
    return { min: v, max: v };
  }
  return null;
}

/* ── HTTP fetch ────────────────────────────────────────────── */

async function fetchPage(url, timeoutMs = 20000) {
  return fetchHtml(url, {
    timeoutMs,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-CH,de;q=0.9,en;q=0.5',
        Referer: PUBLIC_CAREER_URL,
      },
  });
}

/* ── Listing parser ────────────────────────────────────────── */

/**
 * Parse Refline search.html for Hohenegg.
 * Format:
 *   <td class="position"><a href=".../{posId}/pub/{rev}/index.html">Title</a></td>
 *   <td class="workload">{PENSUM}</td>
 *   <td class="entryDate">{DATE}</td>
 *
 * posId can be alphanumeric / zero-padded (e.g. "0052", "0047").
 */
export function parseHoheneggReflineListing(html = '') {
  if (!html) return [];
  const out = [];
  const seen = new Set();

  const rowRe = new RegExp(
    `<tr[^>]*>\\s*<td class="position">\\s*<a\\s+href="(https://apply\\.refline\\.ch/${REFLINE_TENANT}/([A-Za-z0-9]+)/pub/(\\d+)/index\\.html)"[^>]*>([\\s\\S]*?)</a>\\s*</td>\\s*<td class="workload">([\\s\\S]*?)</td>\\s*<td class="entryDate">([\\s\\S]*?)</td>`,
    'gi',
  );
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const url = m[1];
    const posId = m[2];
    const rev = m[3];
    const title = normalizeSpace(stripHtml(m[4]));
    const workload = normalizeSpace(stripHtml(m[5]));
    const entryDate = normalizeSpace(stripHtml(m[6]));
    if (!title || title.length < 3) continue;
    if (seen.has(posId)) continue;
    seen.add(posId);
    out.push({ url, posId, rev, title, workload, entryDate });
  }
  return out;
}

/* ── Detail parser ─────────────────────────────────────────── */

// The shared Refline detail reader: this tenant used to carry its own copy of
// the paragraph scan, which never sees the bare-text `smartEditable` divs of
// the standard Refline template and so fell back to the invented description
// below on most postings (see `parseReflineDetail` in refline-common.mjs).
export { parseReflineDetail };

/* ── Main fetch ────────────────────────────────────────────── */

export async function fetchAllPrivatklinikHoheneggJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

  console.log(`🏥 Fetching ${PRIVATKLINIK_HOHENEGG_COMPANY_NAME} jobs`);
  console.log(`   Source: ${REFLINE_LISTING_URL} (Refline tenant ${REFLINE_TENANT})\n`);

  let listingHtml;
  try {
    listingHtml = await fetchPage(REFLINE_LISTING_URL, timeoutMs);
  } catch (err) {
    throw new Error(`Failed to fetch Refline listing: ${err?.message || err}`);
  }

  const listings = parseHoheneggReflineListing(listingHtml);
  console.log(`  📋 Found ${listings.length} positions\n`);
  if (listings.length === 0) {
    console.warn('⚠️ No job listings found on Refline page.');
    return [];
  }

  const jobs = [];
  for (const listing of listings) {
    let detail = { title: '', description: '' };
    try {
      const detailHtml = await fetchPage(listing.url, timeoutMs);
      detail = parseReflineDetail(detailHtml);
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed for ${listing.title}: ${err?.message || err}`);
    }

    const title = detail.title || listing.title;
    const location = 'Meilen';
    const canton = inferSwissTargetCanton(location) || 'ZH';
    const postalCode = '8706';

    // Only the posting's own text (issue 5253): a detail body under the common
    // 50-word floor gives no description (the shared pipeline's thin-source
    // path), instead of a company paragraph and benefit list of the crawler's.
    const description = meetsSourceBodyFloor(detail.description) ? detail.description : '';

    const sourceLang = detectLang(description || title, 'de');
    const jobSlug = slugify(`${title} ${PRIVATKLINIK_HOHENEGG_KEY} ch`);
    const urlHash = createHash('sha1').update(listing.url).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(listing.workload, title);
    const pensum = extractPensum(listing.workload);

    const job = {
      id: `${PRIVATKLINIK_HOHENEGG_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: PRIVATKLINIK_HOHENEGG_COMPANY_NAME,
      companyKey: PRIVATKLINIK_HOHENEGG_KEY,
      companyDomain: PRIVATKLINIK_HOHENEGG_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location,
      canton,
      url: listing.url,
      source: `Privatklinik Hohenegg Dedicated Parser (Refline ${REFLINE_TENANT})`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: location,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode,
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().slice(0, 10),
      applyUrl: listing.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    if (pensum) {
      job.pensumMin = pensum.min;
      job.pensumMax = pensum.max;
      job.pensum = pensum.min === pensum.max ? `${pensum.min}%` : `${pensum.min} - ${pensum.max}%`;
    }

    jobs.push(job);
    console.log(`  ✅ ${title.substring(0, 70)} (${listing.posId})`);

    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n📋 Total ${PRIVATKLINIK_HOHENEGG_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
