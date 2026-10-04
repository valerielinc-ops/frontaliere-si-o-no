#!/usr/bin/env node
/**
 * Solothurner Spitäler AG (soH / SOH) — Solothurn cantonal hospital group.
 *
 * Public listing page (DOES NOT require auth):
 *   https://www.solothurnerspitaeler.ch/jobs-karriere/jobangebote
 * Public detail URLs (DOES NOT require auth, but ATS root is auth-gated):
 *   https://jobs.so-h.ch/offene-stellen/{slug}/{uuid}
 *
 * The "jobs.so-h.ch" host is a SaaS-style ATS subdomain that blocks crawler
 * access at the index level (returns HTTP 200 with 0 bytes / 403 on most
 * paths) — likely a Cloudfront WAF or auth-gated career site. However:
 *   - the corporate Typo3 site (www.solothurnerspitaeler.ch/jobs-karriere/
 *     jobangebote) renders ALL active openings server-side with direct links
 *     to the deep-link detail URL for each opening; and
 *   - each /offene-stellen/{slug}/{uuid} detail page IS accessible without
 *     a session and embeds a complete JSON-LD `JobPosting` document with
 *     title, description, qualifications, responsibilities, location,
 *     employment type and datePosted.
 *
 * Strategy:
 *   1. Fetch the public listing on solothurnerspitaeler.ch and extract every
 *      unique `https://jobs.so-h.ch/offene-stellen/{slug}/{uuid}` link.
 *   2. Polite-fetch each detail page (250 ms delay), parse the JSON-LD
 *      script tag, and assemble a ParsedJob.
 *
 * As of May 2026 the listing exposes ~129 unique openings across all soH
 * sites (Solothurn, Olten, Dornach, Breitenbach, Niederbipp, …).
 */
import { sourcePostingDateFields, mergeSourcePostingDates } from './source-posting-date.mjs';
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  htmlToText,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';
import { htmlToTextLines } from './html-to-text-lines.mjs';

export const SOH_KEY = 'soh-solothurner-spitaeler';
export const SOH_COMPANY_NAME = 'Solothurner Spitäler AG (soH)';
export const SOH_COMPANY_DOMAIN = 'solothurnerspitaeler.ch';

const LISTING_URL = 'https://www.solothurnerspitaeler.ch/jobs-karriere/jobangebote';
const ATS_HOST = 'jobs.so-h.ch';
const DETAIL_DELAY_MS = 250;

const DEFAULT_CANTON = 'SO';
const DEFAULT_CITY = 'Solothurn';
const DEFAULT_POSTAL = '4500';

const SOURCE_LABEL = 'Solothurner Spitäler Dedicated Parser (Typo3 listing + JSON-LD detail)';

function normalize(s = '') {
  return String(s || '').trim().toLowerCase();
}

export function isSohJob(job) {
  const key = normalize(job?.companyKey || '');
  const url = normalize(job?.url || '');
  return key === SOH_KEY
    || url.includes('jobs.so-h.ch')
    || url.includes('solothurnerspitaeler.ch');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === ATS_HOST
      || host === 'so-h.ch'
      || host === SOH_COMPANY_DOMAIN
      || host.endsWith(`.${SOH_COMPANY_DOMAIN}`)
      || host.endsWith('.so-h.ch');
  } catch {
    return false;
  }
}

/**
 * Extract unique soH detail-page URLs from the public listing HTML.
 * Each card emits ≥2 anchors (title + "Zur Stellenanzeige") for the same
 * URL — we dedupe.
 */
export function parseSohListing(html) {
  const out = [];
  const seen = new Set();
  // Same Swiss Medical Network `/offene-stellen/{slug}/{detail}` board template as the
  // spital-zofingen / pbl / bls parsers. The trailing detail segment is a 36-char UUID
  // today, but pin it to a generic slug-like token (`[^"/]+`, not hex-only `[a-f0-9-]{8,}`)
  // so a non-UUID detail path (e.g. `…/{slug}/job-42`) still matches instead of silently
  // dropping every job on a template switch — the exact zero-match failure class this PR
  // hardens. The two-segment `/offene-stellen/{slug}/{detail}` shape keeps it from matching
  // the listing index. Host stays absolute-pinned (NOT optional like the siblings): this
  // listing is scraped cross-domain from `www.solothurnerspitaeler.ch`, where a root-relative
  // `/offene-stellen/…` href would resolve to the corporate host, not `jobs.so-h.ch`, so
  // relative-tolerant normalization would mint wrong URLs here.
  const linkRe = /href="(https:\/\/jobs\.so-h\.ch\/offene-stellen\/[^"/]+\/[^"/]+)"/gi;
  let m;
  while ((m = linkRe.exec(html))) {
    const url = m[1];
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/**
 * Key facts rendered above the posting (`div-job-info` → `job-infos`):
 * Eintritt, Pensum, Standort (site + street address), Abteilung. They are the
 * only place the page states the start date, workload and ward — the JSON-LD
 * body starts directly with the tasks list.
 */
export function sohJobFacts(html = '') {
  const lines = [];
  const rx = /<div\s+class="job-infos">\s*<div\s+class="jobInfoTitle">[\s\S]*?<span>([\s\S]*?)<\/span>\s*<\/div>\s*<span[^>]*>([\s\S]*?)<\/span>\s*<\/div>/gi;
  let m;
  while ((m = rx.exec(String(html || '')))) {
    const label = normalizeSpace(decodeEntities(m[1].replace(/<[^>]+>/g, ' ')));
    const value = normalizeSpace(decodeEntities(m[2].replace(/<[^>]+>/g, ' ')));
    if (label && value) lines.push(`${label}: ${value}`);
  }
  return lines.join('\n');
}

/**
 * The offer ("Für uns selbstverständlich") is a benefits carousel that exists
 * only in the HTML, not in the JSON-LD. Each card renders twice (front/back
 * face of the flip card); read the front face once per card.
 */
export function sohBenefits(html = '') {
  const start = String(html || '').search(/<section\b[^>]*\bid="job-advantages"/i);
  if (start < 0) return '';
  const end = html.indexOf('</section>', start);
  const section = html.slice(start, end > start ? end : undefined);
  const heading = section.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  const label = heading ? normalizeSpace(decodeEntities(heading[1].replace(/<[^>]+>/g, ' '))) : '';
  const seen = new Set();
  const items = [];
  for (const m of section.matchAll(/<span\s+class="benefitTitle"[^>]*>([\s\S]*?)<\/span>/gi)) {
    const titleMatch = m[1].match(/<strong[^>]*>([\s\S]*?)<\/strong>/i);
    const cardTitle = titleMatch ? normalizeSpace(decodeEntities(titleMatch[1].replace(/<[^>]+>/g, ' '))) : '';
    const text = normalizeSpace(decodeEntities(
      m[1].replace(/<strong[^>]*>[\s\S]*?<\/strong>/i, ' ').replace(/<[^>]+>/g, ' '),
    ));
    const item = cardTitle && text ? `${cardTitle}: ${text}` : (cardTitle || text);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    items.push(`• ${item}`);
  }
  if (!items.length) return '';
  return [label, ...items].filter(Boolean).join('\n');
}

/**
 * The workplace the page renders under "Standort" ("Bürgerspital Solothurn,
 * Schöngrünstrasse 42, 4500 Solothurn"). The JSON-LD `jobLocation` is filled
 * by hand in the ATS and disagrees with it on ~7 % of postings: typos
 * ("Oltern", "Soloturn") and the other hospital's town (a Bürgerspital
 * Solothurn vacancy tagged Olten 4600), which also made two distinct
 * site-specific postings look like one duplicated Olten listing. Returned only
 * when the Standort names exactly one postal address; a multi-site Standort
 * leaves the JSON-LD location in charge.
 */
export function sohStandortAddress(html = '') {
  const facts = sohJobFacts(html);
  const line = facts.split('\n').find((l) => /^Standort:/i.test(l)) || '';
  const addresses = new Map();
  for (const m of line.matchAll(/\b(\d{4})\s+([A-ZÄÖÜ][^,\d]*?)\s*(?=,|$)/g)) {
    addresses.set(`${m[1]} ${m[2]}`, { postalCode: m[1], city: m[2].trim() });
  }
  return addresses.size === 1 ? [...addresses.values()][0] : null;
}

/** Vacancy reference as rendered in the contact block ("Referenz 986"). */
function sohVacancyReference(html = '') {
  const m = String(html || '').match(/Referenz\s+(\d+)\s*\)/i);
  return m ? m[1] : '';
}

/** Place the offer before the contact block, as the page does. */
function insertBeforeContact(text, benefits) {
  if (!benefits) return text;
  const at = text.search(/(?:^|\n)Bei Fragen zur Stelle/);
  if (at < 0) return `${text}\n\n${benefits}`;
  const cut = text[at] === '\n' ? at + 1 : at;
  return `${text.slice(0, cut).trimEnd()}\n\n${benefits}\n\n${text.slice(cut)}`;
}

/**
 * Parse a soH detail page. The page embeds a `<script type="application/ld+json">`
 * containing a `JobPosting` document. We strip JSON-escape artifacts and
 * extract the fields we need.
 */
export function parseSohDetail(html) {
  if (!html || typeof html !== 'string') return null;
  // Find all JSON-LD blocks — the page may have multiple (WebSite + JobPosting).
  const blocks = [];
  const rx = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = rx.exec(html))) blocks.push(m[1].trim());
  let jp = null;
  for (const raw of blocks) {
    try {
      const obj = JSON.parse(raw);
      // Could be an array or a single object
      const candidates = Array.isArray(obj) ? obj : [obj];
      for (const c of candidates) {
        const type = c?.['@type'];
        if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) {
          jp = c;
          break;
        }
      }
      if (jp) break;
    } catch {
      // skip malformed block
    }
  }
  if (!jp) return null;

  const title = String(jp.title || '').trim();
  const descriptionHtml = String(jp.description || '');
  // The JSON-LD `description` already carries the tasks ("Das bewegen Sie bei
  // uns") and profile ("Das bringen Sie mit") lists; `responsibilities` and
  // `qualifications` repeat them verbatim. Appending both unconditionally
  // printed every list twice. Add them only when the description lacks them.
  const descriptionPlain = normalizeSpace(htmlToText(descriptionHtml));
  const richParts = [descriptionHtml];
  for (const extra of [jp.responsibilities, jp.qualifications]) {
    const extraHtml = extra ? String(extra) : '';
    const extraPlain = normalizeSpace(htmlToText(extraHtml));
    if (extraPlain && !descriptionPlain.includes(extraPlain)) richParts.push(extraHtml);
  }
  const richHtml = richParts.join('\n\n');
  const reference = sohVacancyReference(html);
  const descriptionText = insertBeforeContact(
    [
      sohJobFacts(html),
      // The contact line interpolates an ATS custom field the JSON-LD leaves
      // unresolved ("Referenz %kundenfeld-520%"); the page renders the value.
      htmlToTextLines(richHtml).replace(
        /\s*\(?Referenz\s+%[a-z]+-\d+%\)?/gi,
        reference ? ` (Referenz ${reference})` : '',
      ),
    ].filter(Boolean).join('\n\n'),
    sohBenefits(html),
  );

  const loc = jp.jobLocation && jp.jobLocation.address ? jp.jobLocation.address : {};
  const standort = sohStandortAddress(html);
  const city = standort?.city || String(loc.addressLocality || '').trim();
  const region = String(loc.addressRegion || '').trim();
  const postalCode = standort?.postalCode || String(loc.postalCode || '').trim();
  const country = String(loc.addressCountry || '').trim();

  const employmentTypeRaw = String(jp.employmentType || '').toUpperCase();
  const validThrough = jp.validThrough ? String(jp.validThrough) : '';
  const publication = sourcePostingDateFields(jp.datePosted);

  return {
    title,
    descriptionHtml: richHtml,
    descriptionText,
    city,
    region,
    postalCode,
    country,
    employmentTypeRaw,
    ...publication,
    validThrough,
    industry: jp.industry ? String(jp.industry) : '',
  };
}

export async function fetchAllSohJobs() {
  console.log(`🏥 Fetching ${SOH_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL} (Typo3) + ${ATS_HOST}/offene-stellen (JSON-LD)\n`);

  let listingHtml;
  try {
    listingHtml = await fetchHtml(LISTING_URL);
  } catch (err) {
    console.warn(`⚠️ Listing fetch failed: ${err?.message || err}`);
    // A fetch failure is not an empty listing: let the crawler pipeline
    // classify it (connection-level soft exit or HTTP error) instead of
    // publishing a cause-less no-jobs-parsed abort.
    throw err;
  }

  const urls = parseSohListing(listingHtml);
  console.log(`  ✓ ${urls.length} unique offerings discovered`);
  if (!urls.length) return [];

  const jobs = [];
  let failed = 0;
  for (let i = 0; i < urls.length; i += 1) {
    const fullUrl = urls[i];
    let detail = null;
    try {
      const html = await fetchHtml(fullUrl);
      detail = parseSohDetail(html);
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed for ${fullUrl}: ${err?.message || err}`);
    }
    if (!detail || !detail.title) {
      failed += 1;
      if (i < urls.length - 1) {
        await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
      }
      continue;
    }

    const title = detail.title;
    const city = detail.city || DEFAULT_CITY;
    const cantonInferred = inferSwissTargetCanton(`${city} ${detail.region || ''}`) || DEFAULT_CANTON;
    const postalCode = detail.postalCode || DEFAULT_POSTAL;
    const sourceLang = detectLang(detail.descriptionText || title, 'de');

    // The detail's own text, whatever its length. Under 30 distinct words the
    // crawler used to replace it with a paragraph of its own on the soH; a
    // detail without text now gives no description and the job takes the
    // pipeline's thin-source path.
    const description = detail.descriptionText || '';

    const urlHash = createHash('sha1').update(fullUrl).digest('hex').slice(0, 12);
    const jobSlug = slugify(`${title} ${SOH_KEY} ${city}`);

    // Map SF-style employmentType to our internal enum
    let employmentType = 'OTHER';
    if (/FULL_TIME/.test(detail.employmentTypeRaw)) employmentType = 'FULL_TIME';
    else if (/PART_TIME/.test(detail.employmentTypeRaw)) employmentType = 'PART_TIME';
    else if (/\bINTERN(?:SHIP)?S?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|TRAINEE|APPRENT/.test(detail.employmentTypeRaw)) employmentType = 'OTHER';
    if (employmentType === 'OTHER') {
      employmentType = detectHealthcareEmploymentType(title);
    }

    jobs.push({
      id: `${SOH_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SOH_COMPANY_NAME,
      companyKey: SOH_KEY,
      companyDomain: SOH_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: city,
      canton: cantonInferred,
      url: fullUrl,
      source: SOURCE_LABEL,
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: city,
      addressRegion: cantonInferred,
      addressCountry: 'CH',
      country: 'CH',
      postalCode,
      category: detectHealthcareCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: detail.industry && /gesundheit/i.test(detail.industry) ? 'Sanità / Ospedali' : 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      ...mergeSourcePostingDates({}, detail),
      applyUrl: fullUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });

    if (i < urls.length - 1) {
      await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
    }
  }

  console.log(`📋 Total ${SOH_COMPANY_NAME} jobs discovered: ${jobs.length} (${failed} detail failures)`);
  return jobs;
}

export const fetchAllSohSolothurnerSpitaelerJobs = fetchAllSohJobs;
export const isSohSolothurnerSpitaelerJob = isSohJob;
