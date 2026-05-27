#!/usr/bin/env node
/**
 * Pallas Kliniken AG (SO) — Augenheilkunde & Aesthetics, 17 standorte in CH.
 *
 * Public career site:   https://www.pallas-kliniken.ch/karriere/
 * Flair HR ATS portal:  https://pallasjobs.careers.flair.hr/
 * Detail page URLs:     /positions/{salesforceId}
 *
 * Flair HR is a Next.js + Salesforce-backed careers product. The listing page
 * is server-rendered and exposes each position as a relative anchor
 * `/positions/{a3LTG...}`. Each detail page embeds a clean
 * `<script type="application/ld+json">` JobPosting with `title`, `description`
 * (HTML-encoded), `datePosted`, `employmentType`, `jobLocation` (full address
 * + postalCode + addressLocality + streetAddress), and `hiringOrganization`.
 * No API endpoint is needed; the JSON-LD covers everything.
 *
 * Polite delay: 250 ms between detail fetches.
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

export const PALLAS_KLINIKEN_KEY = 'pallas-kliniken';
export const PALLAS_KLINIKEN_COMPANY_NAME = 'Pallas Kliniken';
export const PALLAS_KLINIKEN_COMPANY_DOMAIN = 'pallas-kliniken.ch';

const PORTAL_BASE = 'https://pallasjobs.careers.flair.hr';
const LISTING_URL = `${PORTAL_BASE}/`;
const DETAIL_DELAY_MS = 250;

// Headquarters fallback when JSON-LD jobLocation is unusable. The group is
// headquartered in Olten (SO), even though some sites span ZH, BE, AG, etc.
const HQ = {
  city: 'Olten',
  canton: 'SO',
  postalCode: '4600',
  streetAddress: 'Louis Giroud-Strasse 20',
};

// Map Pallas site names → Swiss canton (where the JSON-LD jobLocation address
// uses `addressCountry: 'Schweiz'` and we infer the canton from the city).
const CITY_TO_CANTON = {
  Olten: 'SO',
  Bern: 'BE',
  Basel: 'BS',
  'Zürich': 'ZH',
  Zurich: 'ZH',
  Solothurn: 'SO',
  Aarau: 'AG',
  Baden: 'AG',
  Brugg: 'AG',
  Grenchen: 'SO',
  Langenthal: 'BE',
  Biel: 'BE',
  Bienne: 'BE',
  'Bern Wankdorf': 'BE',
  Winterthur: 'ZH',
  Luzern: 'LU',
  'St. Gallen': 'SG',
  'Schaffhausen': 'SH',
  Wohlen: 'AG',
  Lenzburg: 'AG',
  Rheinfelden: 'AG',
  Wettingen: 'AG',
  Frauenfeld: 'TG',
  Bellinzona: 'TI',
  Lugano: 'TI',
  Locarno: 'TI',
  Sion: 'VS',
  Lausanne: 'VD',
  Vevey: 'VD',
  Yverdon: 'VD',
  Geneva: 'GE',
  'Genève': 'GE',
  Chur: 'GR',
};

export function isPallasKlinikenJob(job) {
  const url = String(job?.url || '').toLowerCase();
  return job?.companyKey === PALLAS_KLINIKEN_KEY
    || url.includes('pallas-kliniken.ch')
    || url.includes('pallasjobs.careers.flair.hr');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'pallas-kliniken.ch'
      || host.endsWith('.pallas-kliniken.ch')
      || host === 'pallasjobs.careers.flair.hr';
  } catch {
    return false;
  }
}

/**
 * Extract the list of `/positions/{ID}` URLs from the Flair HR listing page.
 * The page renders position cards as anchors; we collect unique IDs.
 */
export function parsePallasListing(html) {
  const out = [];
  const seen = new Set();
  const rx = /href="\/positions\/([A-Za-z0-9]+)"/g;
  let m;
  while ((m = rx.exec(html))) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, detailUrl: `${PORTAL_BASE}/positions/${id}` });
  }
  return out;
}

/**
 * Extract the JSON-LD JobPosting block from a Flair HR detail page.
 * Returns `null` if not present or malformed.
 */
export function extractJobPostingLd(html) {
  if (!html) return null;
  const scripts = html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of scripts) {
    const raw = m[1].trim();
    try {
      const data = JSON.parse(raw);
      if (data && (data['@type'] === 'JobPosting' || data['@type']?.includes?.('JobPosting'))) {
        return data;
      }
    } catch {
      // Salesforce sometimes wraps HTML in CDATA; ignore parse errors.
    }
  }
  return null;
}

function htmlDescriptionToText(htmlDescription = '') {
  // Flair HR HTML-encodes the description into a single JSON string, so we
  // decode entities first, then strip tags.
  const decoded = decodeEntities(String(htmlDescription));
  const text = htmlToText(decoded);
  return normalizeSpace(text);
}

function mapEmploymentTypeLd(value, fallbackText) {
  const raw = String(value || '').toUpperCase();
  if (raw.includes('PART')) return 'part-time';
  if (raw.includes('FULL')) return 'full-time';
  if (raw.includes('INTERN')) return 'internship';
  if (raw.includes('TEMP') || raw.includes('CONTRACT')) return 'contract';
  return detectHealthcareEmploymentType(fallbackText || '');
}

function pickCanton(addressLocality) {
  if (!addressLocality) return HQ.canton;
  const direct = CITY_TO_CANTON[addressLocality];
  if (direct) return direct;
  for (const [k, v] of Object.entries(CITY_TO_CANTON)) {
    if (addressLocality.toLowerCase().includes(k.toLowerCase())) return v;
  }
  return HQ.canton;
}

export async function fetchAllPallasKlinikenJobs() {
  console.log(`🏥 Fetching ${PALLAS_KLINIKEN_COMPANY_NAME} jobs`);
  console.log(`   Portal: ${LISTING_URL}\n`);

  const listingHtml = await fetchHtml(LISTING_URL);
  const positions = parsePallasListing(listingHtml);
  console.log(`  ✓ ${positions.length} Flair HR positions parsed`);
  if (!positions.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (let i = 0; i < positions.length; i += 1) {
    const p = positions[i];
    if (i > 0) await new Promise((res) => setTimeout(res, DETAIL_DELAY_MS));
    let html;
    try {
      html = await fetchHtml(p.detailUrl);
    } catch (err) {
      console.warn(`  ⚠️ Pallas detail fetch failed (${p.detailUrl}): ${err?.message || err}`);
      continue;
    }
    const ld = extractJobPostingLd(html);
    if (!ld || !ld.title) {
      console.warn(`  ⚠️ Pallas JSON-LD missing for ${p.detailUrl}`);
      continue;
    }

    const title = normalizeSpace(decodeEntities(ld.title));
    const description = htmlDescriptionToText(ld.description || '');
    if (!title || description.split(/\s+/).length < 30) {
      console.warn(`  ⚠️ Pallas thin description for ${title || p.id}`);
      continue;
    }
    const sourceLang = detectLang(description, 'de');

    const addr = ld.jobLocation?.address || {};
    const city = normalizeSpace(decodeEntities(addr.addressLocality || '')) || HQ.city;
    const postalCode = String(addr.postalCode || HQ.postalCode);
    const streetAddress = normalizeSpace(decodeEntities(addr.streetAddress || HQ.streetAddress));
    const canton = pickCanton(city);

    const datePosted = (ld.datePosted && /^\d{4}-\d{2}-\d{2}$/.test(ld.datePosted))
      ? ld.datePosted
      : todayIso;

    const jobSlug = slugify(`${title} ${PALLAS_KLINIKEN_KEY} ${city}`);
    const urlHash = createHash('sha1').update(p.detailUrl).digest('hex').slice(0, 12);

    jobs.push({
      id: `${PALLAS_KLINIKEN_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: PALLAS_KLINIKEN_COMPANY_NAME,
      companyKey: PALLAS_KLINIKEN_KEY,
      companyDomain: PALLAS_KLINIKEN_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: city,
      canton,
      url: p.detailUrl,
      source: `${PALLAS_KLINIKEN_COMPANY_NAME} Dedicated Parser (Flair HR / JSON-LD)`,
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: city,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode,
      streetAddress,
      category: detectHealthcareCategory(`${title} ${description.slice(0, 400)}`),
      contract: 'full-time',
      employmentType: mapEmploymentTypeLd(ld.employmentType, `${title} ${description.slice(0, 200)}`),
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: datePosted,
      applyUrl: p.detailUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }
  console.log(`\n📋 Total ${PALLAS_KLINIKEN_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { LISTING_URL };
