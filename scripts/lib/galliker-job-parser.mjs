#!/usr/bin/env node
/**
 * Galliker Transport AG — dedicated job parser.
 *
 * Public careers site: https://www.galliker.com/jobs-karriere/offene-stellen
 * (Neos CMS, fully server-rendered — but that page is a marketing mirror,
 * NOT the source of truth). The discovery-stage tag called this "Custom",
 * which is only half right: every job card's "Details anzeigen" / apply
 * button links out to `https://apply.refline.ch/878019/{posId}/index.html`
 * — the real backend is the **Refline** ATS (tenant `878019`), already
 * covered by the shared `refline-common.mjs` factory used by ZKB, Spital
 * Limmattal, Pigna, Hohenegg, Caritas Schweiz, Kanton GR.
 *
 * This tenant's listing (`https://apply.refline.ch/878019/positions.html`)
 * uses the same "table-row" template as ZKB (`<td class="position">` +
 * `<td class="operationArea">` + `<td class="entryDate">`, no workplace/
 * workload columns) — reused via `parseReflineListing()` from
 * `refline-common.mjs` rather than duplicating that regex (AGENTS.md #6).
 *
 * Unlike the generic Refline detail-page heuristic (`parseReflineDetail`,
 * which scrapes `<p>/<li>` blocks because most Refline tenants ship none),
 * this tenant's detail pages embed a clean schema.org/JobPosting JSON-LD
 * block with real `streetAddress`/`postalCode`/`addressRegion` (canton
 * code) and `datePosted`/`employmentType` — so we use the shared
 * `jsonld-jobposting.mjs` helper (already used by `spital-zofingen-job-
 * parser.mjs`) instead, which yields materially better structured-data
 * coverage (AGENTS.md #3) than the text-scrape fallback would.
 *
 * Galliker is a Swiss logistics/transport group headquartered in
 * Altishofen (LU) with sites across most cantons (Möhlin AG, Pfungen ZH,
 * Jona SG, Staad SG, Landquart GR, S'Antonino TI, Conthey VS, Aclens VD,
 * Genève GE, Luzern LU, Schachen LU, …) — a wide, multi-canton dataset
 * relevant to this site's CH-wide job cathedral.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import { fetchHtml, normalizeSpace } from './hospital-custom-html-helpers.mjs';
import { parseReflineListing } from './refline-common.mjs';
import { extractJobPostingLd, jobPostingDescriptionText, jobPostingAddress } from './jsonld-jobposting.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { SWISS_CANTONS } from './crawler-location-config.mjs';

export const GALLIKER_KEY = 'galliker';
export const GALLIKER_COMPANY_NAME = 'Galliker Transport AG';
export const GALLIKER_COMPANY_DOMAIN = 'galliker.com';

const REFLINE_TENANT = '878019';
const REFLINE_HOST = 'apply.refline.ch';
const LISTING_URL = `https://${REFLINE_HOST}/${REFLINE_TENANT}/positions.html`;
const DEFAULT_CANTON = 'LU';
const DEFAULT_CITY = 'Altishofen';
const DEFAULT_POSTAL = '6246';
const DEFAULT_STREET = 'Industriestrasse 19';
const DETAIL_DELAY_MS = 250;

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

export function isGallikerJob(job) {
  if (!job) return false;
  const key = normalize(job.companyKey || '');
  const company = normalize(job.company || '');
  const url = normalize(job.url || '');
  return (
    key === GALLIKER_KEY
    || company.includes('galliker')
    || url.includes('galliker.com')
    || url.includes(`${REFLINE_HOST}/${REFLINE_TENANT}`)
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === GALLIKER_COMPANY_DOMAIN
      || host.endsWith(`.${GALLIKER_COMPANY_DOMAIN}`)
      || host === REFLINE_HOST;
  } catch {
    return false;
  }
}

/* ── Category / Experience / Employment detection ──────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(chauffeur|fahrer|driver|lastwagen)/.test(t)) return 'Autisti / Chauffeur';
  if (/\b(lager|logist|magazz|disponent|warehouse|shuttle)/.test(t)) return 'Logistica';
  if (/\b(mechatroniker|mechaniker|schlosser|carrosserie|karosser|lackier|spengler|werkstatt|techniker|elektriker)/.test(t)) return 'Tecnica';
  if (/\b(software|devops|it-|application manager|data.?analyst|data.?engineer|infrastructure|network)/.test(t)) return 'IT';
  if (/\b(sachbearbeit|admin|buchhalt|contab|hr\b|personal|recruit)/.test(t)) return 'Amministrazione';
  if (/\b(projektleit|bauleit|gebaeudetechnik|gebäudetechnik)/.test(t)) return 'Progetti / Tecnica edile';
  if (/\b(verkauf|sales|vendita|kunden)/.test(t)) return 'Commerciale';
  if (/\b(lernende|lehrling|apprendist|auszubild|praktik)/.test(t)) return 'Formazione';
  if (/\b(qualität|quality)/.test(t)) return 'Qualità';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(lernende|lehrling|apprendist|auszubild|praktik|junior|quereinsteiger)/.test(t)) return 'junior';
  if (/\b(senior|leiter|verantwortlich|chef|leitung|manager|head)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(ldEmploymentType, text = '') {
  const fromLd = Array.isArray(ldEmploymentType) ? ldEmploymentType[0] : ldEmploymentType;
  if (fromLd && /part.?time/i.test(String(fromLd))) return 'PART_TIME';
  if (fromLd && /full.?time/i.test(String(fromLd))) return 'FULL_TIME';
  const t = normalize(text);
  if (/\b(teilzeit|part.?time|tempo parziale)/.test(t)) return 'PART_TIME';
  if (/\b(lernende|lehrling|apprendist|praktik|stage|intern)/.test(t)) return 'INTERN';
  if (/\b(temporaer|befristet|temporary|tempor)/.test(t)) return 'CONTRACTOR';
  return 'FULL_TIME';
}

function pickCanton(addressRegion = '', city = '') {
  const code = String(addressRegion || '').trim().toUpperCase();
  if (SWISS_CANTONS[code]) return code;
  return inferSwissTargetCanton(city || addressRegion) || DEFAULT_CANTON;
}

function pickPostedDate(raw) {
  const s = typeof raw === 'string' ? raw.slice(0, 10) : '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return new Date().toISOString().slice(0, 10);
}

/* ── Main entry ────────────────────────────────────────────── */

export async function fetchAllGallikerJobs() {
  console.log(`🚚 Fetching ${GALLIKER_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL} (Refline tenant ${REFLINE_TENANT}) → per-position JSON-LD JobPosting\n`);

  let listingHtml;
  try {
    listingHtml = await fetchHtml(LISTING_URL);
  } catch (err) {
    console.warn(`⚠️ Galliker Refline listing fetch failed: ${err?.message || err}. Returning [].`);
    return [];
  }

  const listings = parseReflineListing(listingHtml, { listingHost: REFLINE_HOST, tenant: REFLINE_TENANT });
  console.log(`   ✓ ${listings.length} positions on Refline listing`);
  if (!listings.length) return [];

  const jobs = [];
  for (let i = 0; i < listings.length; i += 1) {
    if (i > 0) await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
    const listing = listings[i];

    let ld = null;
    try {
      const detailHtml = await fetchHtml(listing.url);
      ld = extractJobPostingLd(detailHtml);
    } catch (err) {
      console.warn(`   ⚠️ Detail fetch failed for ${listing.title}: ${err?.message || err}`);
    }

    const title = normalizeSpace(ld?.title || listing.title || '');
    if (!title || title.length < 3) continue;

    const rawDescription = ld?.description ? jobPostingDescriptionText(ld.description) : '';
    const description = rawDescription && rawDescription.split(/\s+/).length >= 15
      ? rawDescription
      : `${title} bei ${GALLIKER_COMPANY_NAME}.\n\n${GALLIKER_COMPANY_NAME} ist ein Schweizer Logistik- und Transportunternehmen mit Hauptsitz in ${DEFAULT_CITY} (LU) und Standorten in der ganzen Schweiz.\n• Vielseitige Aufgaben in einem eingespielten Team\n• Faire Anstellungsbedingungen\n• Moderne Infrastruktur und Fuhrpark`;

    const addr = ld ? jobPostingAddress(ld) : { addressLocality: '', addressRegion: '', streetAddress: '', postalCode: '' };
    const city = addr.addressLocality || DEFAULT_CITY;
    const canton = pickCanton(addr.addressRegion, city);
    const postalCode = addr.postalCode || DEFAULT_POSTAL;
    const streetAddress = addr.streetAddress || DEFAULT_STREET;
    const employmentType = detectEmploymentType(ld?.employmentType, `${title} ${description}`);
    const postedDate = pickPostedDate(ld?.datePosted);

    const sourceLang = detectLang(description || title, 'de');
    const jobSlug = slugify(`${title} ${GALLIKER_KEY} ${city}`);
    const urlHash = createHash('sha1').update(listing.url).digest('hex').slice(0, 12);

    const job = {
      id: `${GALLIKER_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: GALLIKER_COMPANY_NAME,
      companyKey: GALLIKER_KEY,
      companyDomain: GALLIKER_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Source-locale-only payload. The shared AI-localize step clears this
      // flag once it fills IT/EN/FR; if it can't, translate-pending picks
      // the job up on a later run.
      needsRetranslation: true,
      location: city,
      canton,
      url: listing.url,
      source: 'Galliker Dedicated Parser (Refline tenant 878019, JSON-LD)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: city,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode,
      streetAddress,
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Logistica / Trasporti',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: listing.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
      externalId: String(listing.posId || ''),
    };

    jobs.push(job);
    console.log(`   ✅ ${title.substring(0, 70)} → ${city} (${canton}, ${listing.posId})`);
  }

  console.log(`\n📋 Total ${GALLIKER_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
