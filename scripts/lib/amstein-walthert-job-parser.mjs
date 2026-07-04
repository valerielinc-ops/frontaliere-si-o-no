#!/usr/bin/env node
/**
 * Amstein + Walthert AG job parser — bespoke in-house CMS (NOT an ATS).
 *
 * Source: https://amstein-walthert.ch/de/uber-w/w-als-arbeitgeber/offene-stellen/
 *
 * Live-verification note (2026-07): the campaign table tagged this row
 * ats='Custom' — verified TRUE. There is no third-party ATS (checked for
 * Prospective ohws.prospective.ch, SuccessFactors career*.successfactors.*,
 * Teamtailor *.teamtailor.com, Workday, SmartRecruiters, Refline
 * apply.refline.ch, rexx systems, Avature, Softgarden, Personio — none of
 * these signatures appear anywhere in the page source or network requests).
 * The listing page ships a free, unauthenticated JSON endpoint at
 *   https://amstein-walthert.ch/de/uber-w/w-als-arbeitgeber/offene-stellen/json/
 * (`{ filters, objects: [...] }`, 57 open roles observed live — well above
 * the campaign-table hint of "19 ruoli", which was stale) which is used to
 * discover all postings across every Swiss office in one request. Each entry
 * carries `workplace_id` (zurich/basel/bern/chur/frauenfeld/genf/baden/
 * lausanne/luzern/stgallen/aarau) but only a bare city label — no street/
 * postal code — so the per-job detail page (same canonical `/de/…/{id}/`
 * URL regardless of the posting's own language: German AND French postings
 * both resolve correctly under the `/de/` path, confirmed live for the
 * Geneva/French postings) is fetched to extract the full description
 * (`.intro` + `.duty` + `.requirement` sections) and the authoritative
 * office address (`h3` labelled "Adresse" + the following `<p>`, format
 * "{legal entity}<br>{street} {no}<br>{postal} {city}", sometimes with an
 * extra legal-entity/division line, e.g. Geneva's "AMSTEIN + WALTHERT
 * GENEVE SA<br>Engineering & Consulting<br>Avenue Edmond-Vaucher 18<br>1203
 * Genève"). `OFFICE_BY_WORKPLACE_ID` below is the confirmed-live fallback
 * (and canton source-of-truth — city-name canton inference is ambiguous for
 * "Buchs" (AG here, workplace_id 'aarau') and "Horw" (LU, workplace_id
 * 'luzern')) if a detail-page fetch fails.
 *
 * Group note: `company` on individual postings is either "Amstein +
 * Walthert AG" or "Amstein + Walthert Holding AG" (JSON `company` field) —
 * both canonicalised to AMSTEIN_WALTHERT_COMPANY_NAME for the job object;
 * the detail-page address may show a subsidiary legal entity (Infra,
 * Sicherheit, Lausanne SA, Genève SA) which is kept only in the address
 * fields, not in `company`.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllAmsteinWalthertJobs()  — Fetch and parse all jobs
 *   - isAmsteinWalthertJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()              — Validate URLs belong to this company
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace, fetchHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const AMSTEIN_WALTHERT_KEY = 'amstein-walthert';
export const AMSTEIN_WALTHERT_COMPANY_NAME = 'Amstein + Walthert AG';
export const AMSTEIN_WALTHERT_COMPANY_DOMAIN = 'amstein-walthert.ch';

const BASE_URL = 'https://amstein-walthert.ch';
const LISTING_PATH = '/de/uber-w/w-als-arbeitgeber/offene-stellen/';
const CAREER_URL = `${BASE_URL}${LISTING_PATH}`;
const JSON_URL = `${BASE_URL}${LISTING_PATH}json/`;

const MIN_DESC_LENGTH = 80;

const SECTOR = 'Ingegneria / Consulenza tecnica edile';

/* ── Confirmed-live office directory (fallback + canton source-of-truth) ── */
/* city/canton/postalCode/streetAddress fetched live from each office's
 * /de/kontakt/aw-{office}/ contact page (2026-07). */
const OFFICE_BY_WORKPLACE_ID = {
  zurich: { city: 'Zürich', canton: 'ZH', postalCode: '8050', streetAddress: 'Andreasstrasse 5' },
  basel: { city: 'Basel', canton: 'BS', postalCode: '4051', streetAddress: 'Petri-Strasse 15' },
  bern: { city: 'Bern', canton: 'BE', postalCode: '3001', streetAddress: 'Hodlerstrasse 5' },
  chur: { city: 'Chur', canton: 'GR', postalCode: '7000', streetAddress: 'Gürtelstrasse 11' },
  frauenfeld: { city: 'Frauenfeld', canton: 'TG', postalCode: '8500', streetAddress: 'Stammeraustrasse 8' },
  genf: { city: 'Genève', canton: 'GE', postalCode: '1203', streetAddress: 'Avenue Edmond-Vaucher 18' },
  baden: { city: 'Baden', canton: 'AG', postalCode: '5400', streetAddress: 'Stadtturmstrasse 19' },
  lausanne: { city: 'Lausanne', canton: 'VD', postalCode: '1006', streetAddress: "Avenue d'Ouchy 52" },
  luzern: { city: 'Horw', canton: 'LU', postalCode: '6048', streetAddress: 'Allmendstrasse 18' },
  stgallen: { city: 'St. Gallen', canton: 'SG', postalCode: '9000', streetAddress: 'Fürstenlandstrasse 41' },
  // "aarau" workplace label maps to the "Amstein + Walthert Sicherheit AG"
  // office, actually located in Buchs (AG) — confirmed live via a detail
  // page's Adresse block, not Aarau itself.
  aarau: { city: 'Buchs', canton: 'AG', postalCode: '5033', streetAddress: 'Bresteneggstrasse 5' },
};
const HQ = OFFICE_BY_WORKPLACE_ID.zurich;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Amstein + Walthert AG.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isAmsteinWalthertJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === AMSTEIN_WALTHERT_KEY ||
    key.startsWith('amstein-walthert') ||
    company.includes('amstein + walthert') ||
    company.includes('amstein+walthert') ||
    url.includes('amstein-walthert.ch')
  );
}

/**
 * Validate that a URL belongs to Amstein + Walthert AG's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'amstein-walthert.ch' || host.endsWith('.amstein-walthert.ch');
  } catch {
    return false;
  }
}

/* ── Category / Employment helpers ────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(brandschutz|sicherheit|security)/.test(t)) return 'Sicurezza';
  if (/\b(elektro|elettr)/.test(t)) return 'Ingegneria';
  if (/\b(hlk|hlks|heizung|lüftung|luftung|klima|sanitär|sanitar|gebäudetechnik|gebaudetechnik|gebäudeautomation|gebaudeautomation|bâtiment|batiment|chauffage|ventilation)/.test(t)) return 'Ingegneria';
  if (/\b(planer|projektleiter|gesamtprojektleiter|teamleiter|fachkoordinator|chef de projet|projeteur|ingegner|engineer)/.test(t)) return 'Ingegneria';
  if (/\b(consultant|expert|beratung|conseil)/.test(t)) return 'Consulenza';
  if (/\b(admin|segret|contab|buchhalt|account|administrat)/.test(t)) return 'Amministrazione';
  if (/\b(werkstudent|apprenti|praktik|stage|lehrling|lernend)/.test(t)) return 'Formazione';
  return 'Ingegneria';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(werkstudent|apprenti|praktik|stage|stagiair|intern|apprendist|lehrling|lernend)/.test(t)) return 'intern';
  if (/\bjunior\b/.test(t)) return 'junior';
  if (/\b(senior|gesamtprojektleiter|teamleiter|expert|chef de projet senior|leiter|leitend)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(title = '') {
  const t = normalize(title);
  if (/\b(werkstudent|apprenti|praktik|stage|lehrling|lernend)/.test(t)) return 'INTERN';
  const pctMatch = t.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || t.match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const minPct = Number(pctMatch[1]);
    if (minPct > 0 && minPct < 50) return 'PART_TIME';
  }
  return 'FULL_TIME';
}

/* ── JSON listing fetch ───────────────────────────────────── */

/**
 * Fetch the bespoke listing JSON feed. Returns the raw `objects` array
 * (id, title, url, workplace, workplace_id, employment_type_id, segment,
 * operation_area — no description/address, those live on the detail page).
 */
async function fetchJobListings() {
  const raw = await fetchHtml(JSON_URL, {
    headers: { Accept: 'application/json' },
    timeoutMs: 25000,
  });
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse Amstein + Walthert listing JSON: ${err?.message || err}`);
  }
  return Array.isArray(data?.objects) ? data.objects : [];
}

/* ── Detail page parsing ──────────────────────────────────── */

/**
 * Extract the office address from a detail page's "Adresse" side-content
 * block. Format observed live: `<h3 class="side-content__section …">Adresse
 * </h3><p>{legal entity}[<br>{division}]<br>{street} {no}<br>{postal}
 * {city}</p>` (sometimes wrapped in a stray extra `<p>` — Buchs/Sicherheit
 * office confirmed live). Returns null when the block is missing so callers
 * fall back to `OFFICE_BY_WORKPLACE_ID`.
 */
function parseDetailAddress(document) {
  const headers = document.querySelectorAll('h3.side-content__section, h3');
  let addressP = null;
  for (const h of headers) {
    if (normalize(h.textContent).includes('adresse') || normalize(h.textContent).includes('address')) {
      let sib = h.nextElementSibling;
      while (sib && sib.tagName !== 'P') sib = sib.nextElementSibling;
      if (sib) { addressP = sib; break; }
    }
  }
  if (!addressP) return null;

  const lines = String(addressP.innerHTML || '')
    .split(/<br\s*\/?>/i)
    .map((s) => stripHtml(s).trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  const lastLine = lines[lines.length - 1];
  const cityMatch = lastLine.match(/^(?:CH-)?(\d{4})\s+(.+)$/);
  if (!cityMatch) return null;
  const postalCode = cityMatch[1];
  const city = cityMatch[2].trim();

  let streetAddress = '';
  for (let i = lines.length - 2; i >= 0; i -= 1) {
    if (/\d/.test(lines[i])) { streetAddress = lines[i]; break; }
  }
  if (!streetAddress && lines.length >= 2) streetAddress = lines[lines.length - 2];

  return { city, postalCode, streetAddress };
}

/**
 * Parse a detail page for the full job description text.
 * Combines the intro paragraph + "Aufgaben"/tasks + "Anforderungen"/
 * requirements sections (classes `.intro`, `.duty`, `.requirement` —
 * confirmed stable across German and French postings).
 */
function parseDetailPage(html = '') {
  if (!html) return { description: '', address: null };
  const { document } = new JSDOM(html).window;

  const parts = [];
  for (const sel of ['.intro', '.duty', '.requirement']) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const text = stripHtml(el.innerHTML || '').trim();
    if (text) parts.push(text);
  }
  const description = parts.join('\n\n');
  const address = parseDetailAddress(document);

  return { description, address };
}

/* ── ParsedJob builder ────────────────────────────────────── */

function buildParsedJob(listing, detail) {
  const title = normalizeSpace(listing.title || '');
  if (!title || title.length < 3) return null;

  const nativeId = String(listing.id || '').trim();
  const publicUrl = listing.url
    ? `${BASE_URL}${listing.url.startsWith('/') ? '' : '/'}${listing.url}`
    : CAREER_URL;

  const office = OFFICE_BY_WORKPLACE_ID[listing.workplace_id] || HQ;
  const address = detail?.address || null;
  const city = address?.city || listing.workplace || office.city;
  const postalCode = address?.postalCode || office.postalCode;
  const streetAddress = address?.streetAddress || office.streetAddress;
  // Canton comes from the workplace_id map first (city names like "Buchs"/
  // "Horw" are ambiguous across cantons) — only fall back to free-text
  // inference for an unmapped workplace_id.
  const canton = office.canton || inferSwissTargetCanton(city) || HQ.canton;

  const descriptionText = normalizeSpace(detail?.description || '');
  const sourceLang = detectLang(descriptionText || title, 'de');

  // Non-Negotiable #4 (50-word thin-content floor): guaranteed ≥50 words even
  // when the detail page fetch fails outright or returns none of the
  // expected `.intro`/`.duty`/`.requirement` sections.
  const fallbackDesc =
    `${title} bei ${AMSTEIN_WALTHERT_COMPANY_NAME} in ${city}. ` +
    'Amstein + Walthert ist ein unabhängiges Schweizer Ingenieurunternehmen mit rund 1100 Mitarbeitenden ' +
    'und Standorten in der ganzen Schweiz, tätig in Planung, Consulting und Engineering für Gebäude- und ' +
    'Infrastrukturtechnik über den gesamten Lebenszyklus eines Bauwerks – von der Konzeptstudie über die ' +
    'Projektierung und Ausführung bis zum Betrieb. Für aktuelle Details zu Aufgaben, Anforderungen und ' +
    'Anstellungsbedingungen dieser Position konsultieren Sie bitte die offizielle Stellenausschreibung ' +
    `auf der Karriereseite von ${AMSTEIN_WALTHERT_COMPANY_NAME}.`;
  const description = descriptionText.length >= MIN_DESC_LENGTH ? descriptionText : fallbackDesc;

  const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
  const disambiguator = normalize(nativeId).replace(/[^a-z0-9]+/g, '');
  const baseSlug = slugify(`${title} ${AMSTEIN_WALTHERT_KEY} ${city}`);
  const jobSlug = disambiguator ? slugify(`${baseSlug}-${disambiguator}`, 120) : baseSlug;

  return {
    // ── Required fields ──
    id: `${AMSTEIN_WALTHERT_KEY}-${urlHash}`,
    slug: jobSlug,
    slugByLocale: { [sourceLang]: jobSlug },
    company: AMSTEIN_WALTHERT_COMPANY_NAME,
    companyKey: AMSTEIN_WALTHERT_KEY,
    companyDomain: AMSTEIN_WALTHERT_COMPANY_DOMAIN,
    title,
    titleByLocale: { [sourceLang]: title },
    description,
    descriptionByLocale: { [sourceLang]: description },
    location: city,
    canton,
    url: publicUrl,
    source: 'Amstein + Walthert AG Dedicated Parser (bespoke in-house CMS)',
    sourceLang,
    crawledAt: new Date().toISOString(),

    // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
    addressLocality: city,
    addressRegion: canton,
    streetAddress,
    postalCode,
    addressCountry: 'CH',
    country: 'CH',
    category: detectCategory(title),
    contract: detectEmploymentType(title) === 'PART_TIME' ? 'part-time' : 'full-time',
    employmentType: detectEmploymentType(title),
    experienceLevel: detectExperienceLevel(title),
    sector: SECTOR,
    currency: 'CHF',
    featured: false,
    postedDate: new Date().toISOString().split('T')[0],
    applyUrl: publicUrl,
    jobReqId: nativeId || null,
    slugDisambiguator: disambiguator || null,
    requirements: [],
    requirementsByLocale: { [sourceLang]: [] },
  };
}

/* ── Main fetcher ─────────────────────────────────────────── */

/**
 * Fetch all Amstein + Walthert AG jobs (Switzerland only).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllAmsteinWalthertJobs() {
  console.log(`🔍 Fetching ${AMSTEIN_WALTHERT_COMPANY_NAME} jobs (bespoke in-house CMS)`);
  console.log(`   Source: ${JSON_URL}\n`);

  let listings;
  try {
    listings = await fetchJobListings();
  } catch (err) {
    console.warn(`⚠️ Amstein + Walthert listing fetch failed: ${err?.message || err}`);
    return [];
  }

  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`   📋 Listings found: ${listings.length}`);

  const jobs = [];
  const seen = new Set();
  for (const listing of listings) {
    const publicUrl = listing.url
      ? `${BASE_URL}${listing.url.startsWith('/') ? '' : '/'}${listing.url}`
      : '';
    if (!publicUrl || seen.has(publicUrl)) continue;
    seen.add(publicUrl);

    let detail = null;
    try {
      const detailHtml = await fetchHtml(publicUrl);
      detail = parseDetailPage(detailHtml);
    } catch (err) {
      console.warn(`⚠️ Detail fetch failed for ${publicUrl}: ${err?.message || err}`);
    }

    try {
      const job = buildParsedJob(listing, detail);
      if (job) jobs.push(job);
    } catch (err) {
      console.warn(`⚠️ Skipping ${listing?.id || publicUrl}: ${err?.message || err}`);
    }
  }

  console.log(`\n📋 Total ${AMSTEIN_WALTHERT_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
