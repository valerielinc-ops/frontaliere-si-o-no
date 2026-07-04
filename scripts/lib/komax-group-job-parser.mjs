// Dedicated crawler parser for Komax Group (Komax Holding AG, komaxgroup.com)
// — Swiss wire-processing / automation-technology group, HQ Dierikon LU.
//
// ── ATS identification (issue #3337 misclassifies this as "Custom") ───────
// Confirmed live via curl: Komax runs SAP SuccessFactors / Jobs2Web (the
// classic "Career Site Builder"), hosted on a fully custom domain
// (jobs.komaxgroup.com). Evidence:
//   - robots.txt Disallow rules match the classic jobs2web path set
//     (/applybutton/, /talentcommunity/, /mobile/talentcommunity/,
//     /preapply/, /emailsubscribe/) — identical fingerprint to other
//     jobs2web tenants in this codebase (e.g. Barry Callebaut).
//   - Search-page JS references `j2w.Search` (jobs2web namespace).
// This is NOT a custom/bespoke ATS — issue #3337's label is wrong.
//
// ── Why not the shared successfactors-client.mjs ───────────────────────────
// `detectSuccessFactorsKind()` in scripts/lib/ats-clients/successfactors-client.mjs
// only recognises a fixed host allowlist (career*.successfactors.eu,
// theheinekencompany.com, jobs.sbb.ch, jobs.mobiliar.ch, careers.oerlikon.com,
// jobs.h-och.ch, jobdetails.nestle.com) — `jobs.komaxgroup.com` is not on it,
// so the shared client would return null (zero jobs). Same situation as
// scripts/lib/barry-callebaut-job-parser.mjs, which documents an identical
// justification.
//
// ── Data source ────────────────────────────────────────────────────────────
// Despite its filename, `https://jobs.komaxgroup.com/sitemap_index.xml` is
// NOT a URL-only sitemap (that's the separate, differently-named
// `/sitemap.xml`) — it's a Google-Jobs-style RSS 2.0 feed with one <item>
// per open requisition: title (with a "(City, CC, Postal)" suffix), full
// HTML description (double HTML-entity-encoded inside CDATA), <link>
// (public apply URL), <guid>/<g:id>, <g:employer>, <g:location>. Confirmed
// live: 81 total items, 19 in Switzerland (Dierikon LU + Thun BE) before
// dedup. Far more reliable than scraping the paginated HTML job list.
//
// ── Quirk: duplicate postings ───────────────────────────────────────────────
// The feed sometimes lists the exact same job (identical title + location)
// twice under two different numeric `g:id`s (e.g. "Strategic Procurement
// Manager 100 % (m/w/d)" in Dierikon appeared as both 1164641455 and
// 1164641555). We dedup client-side on normalized `title|location`, not on
// URL/id, since those differ between the duplicate rows.

import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml, normalizeSpace } from './crawler-template.mjs';
import { decodeHtmlEntities } from './decode-html-entities.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';
import { inferAnyCanton } from './target-swiss-locations.mjs';

export const KOMAX_KEY = 'komax';
export const KOMAX_COMPANY_NAME = 'Komax';
export const KOMAX_COMPANY_DOMAIN = 'komaxgroup.com';

const CAREER_URL = 'https://jobs.komaxgroup.com';
const FEED_URL = 'https://jobs.komaxgroup.com/sitemap_index.xml';

// HQ fallback — Zefix (Swiss commercial register), firm ehraid 100752,
// uid CHE-102.274.193, legalSeat "Dierikon". streetAddress is not stored in
// the shared crawler-location-config.mjs registry (which only ever carries
// city/canton/postalCode/addressRegion), so it's kept locally here, mirroring
// scripts/lib/staubli-job-parser.mjs's convention.
const HQ = {
  ...(getCompanyDefaults(KOMAX_KEY) || { city: 'Dierikon', canton: 'LU', postalCode: '6036', addressRegion: 'LU' }),
  streetAddress: 'Industriestrasse 6',
};

function normalize(text = '') {
  return String(text).toLowerCase().trim();
}

function extractTag(itemXml, tag) {
  const m = itemXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1] : '';
}

function extractCdataOrText(itemXml, tag) {
  const cdata = itemXml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, 'i'));
  if (cdata) return cdata[1];
  return extractTag(itemXml, tag);
}

function isSwissLocation(locationText = '') {
  // Komax's feed consistently uses an explicit 2-letter ISO country code as
  // the middle segment of "City, CC, Postal" — matching that directly is
  // more robust than a fuzzy city-name list (cf. barry-callebaut's approach).
  return /,\s*ch\s*(,|$)/i.test(String(locationText).trim());
}

// City/postal segment is a formatted "City, CC, Postal" string (e.g.
// "Dierikon, CH, 6036" or "Manchester, NH, US, 03103" for US locations with
// a state segment). We only need the leading city and trailing postal code.
function parseLocation(locationText = '') {
  const parts = String(locationText).split(',').map((p) => p.trim()).filter(Boolean);
  const city = parts[0] || '';
  const postalCode = parts.length ? parts[parts.length - 1] : '';
  return { city, postalCode: /^\d[\d-]*$/.test(postalCode) ? postalCode : '' };
}

function parseFeedItems(xml = '') {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const itemXml = m[1];
    const rawTitle = decodeHtmlEntities(normalizeSpace(extractCdataOrText(itemXml, 'title')));
    // Strip the trailing "(City, CC, Postal)" location suffix Komax appends
    // to every title — but only the LAST parenthetical group, so an earlier
    // one like "(m/w/d)" is preserved.
    const title = rawTitle.replace(/\s*\([^()]*\)\s*$/, '').trim() || rawTitle;
    const descriptionHtml = decodeHtmlEntities(extractCdataOrText(itemXml, 'description'));
    const url = normalizeSpace(extractTag(itemXml, 'link'));
    const jobId = normalizeSpace(extractTag(itemXml, 'g:id')) || normalizeSpace(extractTag(itemXml, 'guid'));
    const location = decodeHtmlEntities(normalizeSpace(extractTag(itemXml, 'g:location')));
    const employer = decodeHtmlEntities(normalizeSpace(extractTag(itemXml, 'g:employer')));
    if (!title || !url) continue;
    items.push({ title, descriptionHtml, url, jobId, location, employer });
  }
  return items;
}

function dedupJobs(listings) {
  const seen = new Set();
  const out = [];
  for (const listing of listings) {
    const key = `${normalize(listing.title)}|${normalize(listing.location)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(listing);
  }
  return out;
}

async function fetchJobListings() {
  const xml = await fetchHtml(FEED_URL, { headers: { Accept: 'application/rss+xml,text/xml,*/*' } });
  const all = parseFeedItems(xml);
  const swiss = all.filter((job) => isSwissLocation(job.location));
  return dedupJobs(swiss);
}

// City-gated address resolution (Non-Negotiable per task spec + precedent in
// scripts/lib/staubli-job-parser.mjs's resolveAddress()): the HQ fallback
// (postalCode + streetAddress) is granted ONLY when the job's own resolved
// city text matches Dierikon — NEVER on canton alone. Komax also posts jobs
// from Thun (canton BE, a different canton) and could in principle post from
// another Lucerne-canton city (e.g. Luzern/Kriens) that must NOT inherit the
// Dierikon street address just because it shares a canton.
export function resolveAddress(city = '', postalCodeFromFeed = '') {
  const cityText = String(city || '').trim();
  // Grant the HQ fallback when the city text actually names Dierikon, OR
  // when there's no city text at all to go on (mirrors staubli-job-parser.mjs's
  // `!city || /pf[aä]ffikon/i.test(city)` pattern) — but NEVER for a
  // different, non-empty city name, even one in the same canton (LU).
  const grantHqFallback = !cityText || /dierikon/i.test(cityText);
  return {
    city: cityText || HQ.city,
    postalCode: postalCodeFromFeed || (grantHqFallback ? HQ.postalCode : ''),
    streetAddress: grantHqFallback ? HQ.streetAddress : '',
  };
}

/**
 * Resolve the canton for a job, or signal (via null) that it should be
 * skipped.
 *
 * isSwissLocation() filters on the feed's ", CH," country-code segment
 * only — it is NOT restricted to Dierikon/Thun, so a real, non-empty city
 * text that is neither Dierikon nor Thun (nor otherwise inferable) must
 * never fabricate the Dierikon HQ canton (LU) for a job that isn't
 * positively there (AGENTS.md Non-Negotiable #3, mirrors
 * clariant-job-parser.mjs / swisslog-job-parser.mjs / debiopharm). Only
 * default to HQ.canton when there's no real city text at all.
 */
export function resolveKomaxCanton(rawCity = '') {
  const cityText = String(rawCity || '').trim();
  if (/dierikon/i.test(cityText)) return 'LU';
  if (/thun/i.test(cityText)) return 'BE';
  const inferredCanton = inferAnyCanton(cityText);
  if (inferredCanton) return inferredCanton;
  if (cityText) return null;
  return HQ.canton;
}

function detectCategory(title = '') {
  const t = normalize(title);
  if (/procurement|einkauf|supply chain|logistik|logistic/.test(t)) return 'Logistica';
  if (/software|embedded|ingenieur|engineer|technical|technik|electron/.test(t)) return 'Ingegneria';
  if (/qualit[aà]|quality/.test(t)) return 'Qualità';
  if (/buchhalt|finance|controlling|accountant/.test(t)) return 'Finanza';
  if (/hr\b|human resources|personal/.test(t)) return 'Risorse Umane';
  if (/marketing|vertrieb|sales|commercial/.test(t)) return 'Commerciale';
  if (/it\b|informatik|system/.test(t)) return 'IT';
  if (/produktion|production|monteur|mechatroniker|polymechaniker/.test(t)) return 'Produzione';
  if (/legal|recht/.test(t)) return 'Legale';
  if (/admin|assistent/.test(t)) return 'Amministrazione';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/lehrstelle|lehrling|ausbildung|apprenti|schnupperpraktikum|praktikum/.test(t)) return 'entry';
  if (/junior/.test(t)) return 'junior';
  if (/senior|leiter|head of|manager|director/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(title = '') {
  const t = normalize(title);
  if (/lehrstelle|lehrling|ausbildung|apprenti|schnupperpraktikum|praktikum|trainee/.test(t)) return 'INTERN';
  if (/\b(\d{1,2})\s*-\s*(\d{2,3})\s*%/.test(t)) {
    const m = t.match(/\b(\d{1,2})\s*-\s*(\d{2,3})\s*%/);
    const min = m ? Number(m[1]) : 100;
    return min < 50 ? 'PART_TIME' : 'FULL_TIME';
  }
  if (/teilzeit|part[\s-]?time|\b[1-7]\d\s*%/.test(t)) return 'PART_TIME';
  return 'FULL_TIME';
}

export async function fetchAllKomaxGroupJobs() {
  console.log(`🔍 Fetching Komax jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);
  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }
  console.log(`  📋 Listings found: ${listings.length}`);
  const jobs = [];
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;
    const { city: rawCity, postalCode: feedPostalCode } = parseLocation(listing.location);
    const address = resolveAddress(rawCity, feedPostalCode);
    const canton = resolveKomaxCanton(rawCity);
    if (canton === null) {
      console.warn(` ⚠️ Komax: skipping unresolvable location "${rawCity}" (${title})`);
      continue;
    }
    const descriptionHtml = listing.descriptionHtml || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url || CAREER_URL;
    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} komax ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const job = {
      id: `komax-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: KOMAX_COMPANY_NAME,
      companyKey: KOMAX_KEY,
      companyDomain: KOMAX_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — Komax`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — Komax` },
      location: address.city,
      canton,
      url: publicUrl,
      source: 'Komax Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: address.city,
      addressRegion: canton,
      streetAddress: address.streetAddress,
      postalCode: address.postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Industria / Automazione', // wire-processing / automation-technology manufacturer
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      jobReqId: listing.jobId || '',
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };
    jobs.push(job);
  }
  console.log(`\n📋 Total Komax jobs discovered: ${jobs.length}`);
  return jobs;
}

export function isKomaxJob(job) {
  if (!job) return false;
  const companyKey = normalize(job.companyKey || '');
  const company = normalize(job.company || '');
  if (companyKey === KOMAX_KEY) return true;
  if (company.includes('komax')) return true;
  try {
    if (job.url) {
      const host = new URL(job.url).hostname.toLowerCase();
      if (host === KOMAX_COMPANY_DOMAIN || host.endsWith(`.${KOMAX_COMPANY_DOMAIN}`)) return true;
    }
  } catch {
    // ignore invalid URL
  }
  return false;
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === KOMAX_COMPANY_DOMAIN || host.endsWith(`.${KOMAX_COMPANY_DOMAIN}`);
  } catch {
    return false;
  }
}
