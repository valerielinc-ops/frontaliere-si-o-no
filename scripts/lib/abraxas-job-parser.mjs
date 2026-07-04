#!/usr/bin/env node
/**
 * Abraxas Informatik AG job parser — custom Umbraco career site.
 *
 * Abraxas is a Swiss IT service provider for public administration
 * (cantons/municipalities), headquartered in St. Gallen (St. Leonhard-Strasse
 * 80, 9001 St. Gallen SG — confirmed via https://www.abraxas.ch/de/impressum).
 * Direct employer, no staffing-agency risk. Issue #3342 row 30, note
 * "IT per pubblica amministrazione, 31 ruoli".
 *
 * ATS discovery: Abraxas subscribes to Refline (tenant 215876 — visible via
 * the "Jobmail abonnieren" links `https://apply.refline.ch/215876/jobmail.html`
 * and per-job apply CTAs `https://apply.refline.ch/215876/{posId}/index.html`),
 * but unlike other Refline tenants in this codebase (see
 * `./refline-common.mjs`) the listing + detail pages themselves are NOT
 * served from `apply.refline.ch` — Abraxas's own Umbraco-driven corporate
 * site (`www.abraxas.ch`) renders a fully custom, server-rendered listing
 * and detail HTML (class names `job-list__*`, `header__title`,
 * `c-definition-list--default`, `rich-text-field`). The `refline-common.mjs`
 * factory's regexes target the `apply.refline.ch` anchor-list/table-row
 * templates and do not match this shape, so this is a bespoke custom-HTML
 * parser (same category as `./hospital-custom-html-helpers.mjs` consumers)
 * rather than a `createReflineParser()` instance. The Refline apply link is
 * captured per-job as `applyUrl` for provenance, but `url` (canonical,
 * user-facing) stays on `www.abraxas.ch` where the full description lives.
 *
 * Listing: https://www.abraxas.ch/de/karriere/offene-stellen
 *   `<li class="job-list__list-item" data-name="…" data-location="…">`
 *   `<a href="/de/karriere/offene-stellen/{slug}" class="job-list__job">`
 *
 * Detail: https://www.abraxas.ch/de/karriere/offene-stellen/{slug}
 *   Title:   `<h1 class="header__title">{title}<span class="subtitle">{location}</span></h1>`
 *   Facts:   `<div class="c-definition-list--default">` → Pensum / Anstellung / Standort
 *   Body:    `<div class="rich-text-field">` … up to `<div class="c-job-info--default"`
 *   Apply:   `https://apply.refline.ch/215876/{posId}/index.html?lang=de&cid=1`
 *
 * Six known office locations (dropdown on listing page, confirmed live
 * 2026-07-03): Bern, Frauenfeld, Morges, Münchenstein, St. Gallen (HQ),
 * Zürich-Flughafen. Postal codes below are well-known public Swiss PLZ for
 * each city centre (not fabricated); street address only known for HQ.
 *
 * Exports 4 required functions for the crawler template:
 * - fetchAllAbraxasJobs() — Fetch + parse all Abraxas jobs
 * - isAbraxasJob()        — Match jobs belonging to this company
 * - isTrustedDomain()     — Validate URLs belong to abraxas.ch / Refline
 * - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace, normalizeDescriptionSpace, fetchHtml } from './crawler-template.mjs';
import { decodeEntities } from './hospital-custom-html-helpers.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

export const ABRAXAS_KEY = 'abraxas';
export const ABRAXAS_COMPANY_NAME = 'Abraxas Informatik AG';
export const ABRAXAS_COMPANY_DOMAIN = 'abraxas.ch';
export const CAREER_URL = 'https://www.abraxas.ch/de/karriere/offene-stellen';
const REFLINE_TENANT = '215876';
const SECTOR = 'IT / Informatica per la pubblica amministrazione';
const DETAIL_DELAY_MS = 300;

/* HQ — confirmed via https://www.abraxas.ch/de/impressum */
const HQ = {
  city: 'St. Gallen',
  canton: 'SG',
  postalCode: '9001',
  streetAddress: 'St. Leonhard-Strasse 80',
  region: 'SG',
};

/* Known office locations (listing page location filter, live 2026-07-03).
 * Public, well-known Swiss PLZ per city centre — street address only known
 * for HQ (safe default '' elsewhere per AGENTS.md Non-Negotiable #3, never
 * fabricated). */
const OFFICE_LOCATIONS = {
  bern: { city: 'Bern', canton: 'BE', postalCode: '3000', streetAddress: '' },
  frauenfeld: { city: 'Frauenfeld', canton: 'TG', postalCode: '8500', streetAddress: '' },
  morges: { city: 'Morges', canton: 'VD', postalCode: '1110', streetAddress: '' },
  munchenstein: { city: 'Münchenstein', canton: 'BL', postalCode: '4142', streetAddress: '' },
  stgallen: { city: 'St. Gallen', canton: 'SG', postalCode: HQ.postalCode, streetAddress: HQ.streetAddress },
  zurichflughafen: { city: 'Zürich-Flughafen', canton: 'ZH', postalCode: '8058', streetAddress: '' },
};

function officeKey(city = '') {
  return String(city || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .toLowerCase();
}

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* Company Matchers ──────────────────────────────────────── */

export function isAbraxasJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === ABRAXAS_KEY ||
    key.startsWith('abraxas') ||
    company.includes('abraxas') ||
    url.includes('abraxas.ch')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'abraxas.ch' || host.endsWith('.abraxas.ch')) return true;
    if (host === 'apply.refline.ch' || host === 'm.refline.ch') return true;
    return false;
  } catch {
    return false;
  }
}

/* Field heuristics ──────────────────────────────────────── */

function detectCategory(text = '') {
  const t = normalize(text);
  if (/security|cyber|iam|siem/.test(t)) return 'IT / Sicurezza';
  if (/devops|cloud|system engineer|infrastruktur|infrastructure/.test(t)) return 'IT / Infrastruttura';
  if (/software|entwickl|developer|architekt/.test(t)) return 'IT / Sviluppo software';
  if (/support|helpdesk|service desk/.test(t)) return 'IT / Supporto';
  if (/projekt|produkt|product|project/.test(t)) return 'IT / Project management';
  return 'IT / Informatica';
}

function detectExperienceLevel(text = '') {
  const t = normalize(text);
  if (/\b(lehre|praktikum|junior|einsteiger|trainee)\b/.test(t)) return 'entry';
  if (/\b(senior|teamleiter|leiter|head|manager|chef)\b/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(teilzeit|part.?time)\b/.test(t)) return 'PART_TIME';
  if (/\b(festanstellung|vollzeit|full.?time)\b/.test(t)) return 'FULL_TIME';
  return 'FULL_TIME';
}

function extractPensum(text = '') {
  const range = text.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/);
  if (range) return { min: parseInt(range[1], 10), max: parseInt(range[2], 10) };
  const single = text.match(/(\d{2,3})\s*%/);
  if (single) return { min: parseInt(single[1], 10), max: parseInt(single[1], 10) };
  return null;
}

/**
 * Resolve best-known address fields from a free-text location string
 * (e.g. "St. Gallen, Zürich-Flughafen" or "St. Gallen oder Zürich-Flughafen").
 * Picks the first recognized office out of OFFICE_LOCATIONS; falls back to
 * HQ if nothing matches (never dropped — safe default per Non-Negotiable #3).
 */
function resolveAddress(locationText = '') {
  const parts = String(locationText || '')
    .split(/,|\/|\boder\b|\bou\b|\bor\b/i)
    .map((s) => normalizeSpace(s))
    .filter(Boolean);

  for (const part of parts) {
    const key = officeKey(part);
    if (OFFICE_LOCATIONS[key]) return { ...OFFICE_LOCATIONS[key], primaryCity: OFFICE_LOCATIONS[key].city };
  }

  // Try canton inference as a secondary signal before falling back to HQ.
  const canton = locationText ? inferSwissTargetCanton(locationText) : null;
  if (canton) {
    const matchByCanton = Object.values(OFFICE_LOCATIONS).find((o) => o.canton === canton);
    if (matchByCanton) return { ...matchByCanton, primaryCity: matchByCanton.city };
  }

  return { ...HQ, primaryCity: HQ.city };
}

/* Listing parser ────────────────────────────────────────── */

/**
 * Parse the Abraxas listing page.
 * Returns: [{ url, title, location }, ...]
 */
export function parseAbraxasListing(html = '') {
  if (!html) return [];
  const out = [];
  const seen = new Set();

  const itemRe = /<li class="job-list__list-item"[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = itemRe.exec(html)) !== null) {
    const block = m[1];
    const linkMatch = block.match(/<a\s+href="([^"]+)"\s+class="job-list__job"/i);
    if (!linkMatch) continue;
    const href = linkMatch[1];
    const url = href.startsWith('http') ? href : `https://www.abraxas.ch${href}`;
    if (seen.has(url)) continue;
    seen.add(url);

    const titleMatch = block.match(/<div class="job-list__job-title">([\s\S]*?)<\/div>/i);
    const locationMatch = block.match(/<div class="job-list__job-location">([\s\S]*?)<\/div>/i);
    const title = titleMatch ? normalizeSpace(stripHtml(decodeEntities(titleMatch[1]))) : '';
    const location = locationMatch ? normalizeSpace(stripHtml(decodeEntities(locationMatch[1]))) : '';

    out.push({ url, title, location });
  }
  return out;
}

/* Detail parser ─────────────────────────────────────────── */

/**
 * Parse an Abraxas job detail page.
 * Returns: { title, location, pensum, employmentTypeRaw, description, applyUrl, posId }
 */
export function parseAbraxasDetail(html = '') {
  if (!html) return { title: '', location: '', pensum: '', employmentTypeRaw: '', description: '', applyUrl: '', posId: '' };

  const titleMatch = html.match(/<h1[^>]*class="[^"]*header__title[^"]*"[^>]*>([\s\S]*?)<span class="subtitle">([\s\S]*?)<\/span>\s*<\/h1>/i)
    || html.match(/<h1[^>]*class="[^"]*header__title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
  const title = titleMatch ? normalizeSpace(stripHtml(decodeEntities(titleMatch[1]))) : '';
  const location = titleMatch && titleMatch[2] ? normalizeSpace(stripHtml(decodeEntities(titleMatch[2]))) : '';

  const factsMatch = html.match(/c-definition-list--default[\s\S]*?<\/ul>/i);
  const facts = factsMatch ? factsMatch[0] : '';
  const termRe = /<div class="definition-list__term">([\s\S]*?)<\/div>\s*<div class="desfinition-list__description">([\s\S]*?)<\/div>/gi;
  const factMap = {};
  let fm;
  while ((fm = termRe.exec(facts)) !== null) {
    const term = normalize(stripHtml(decodeEntities(fm[1])));
    const value = normalizeSpace(stripHtml(decodeEntities(fm[2])));
    factMap[term] = value;
  }

  const applyMatch = html.match(/https:\/\/apply\.refline\.ch\/(\d+)\/(\d+)\/index\.html[^"'\s]*/i);
  const applyUrl = applyMatch ? decodeEntities(applyMatch[0]) : '';
  const posId = applyMatch ? applyMatch[2] : '';

  const bodyStartMatch = html.match(/<div class="rich-text-field">/i);
  const bodyStart = bodyStartMatch ? bodyStartMatch.index + bodyStartMatch[0].length : -1;
  // "nested__widget" is the next full sibling wrapper's own class token — end
  // slicing there (rather than at "c-job-info--default", which sits inside a
  // nested opening tag and would leave a dangling "<div class=\"" fragment).
  const bodyEndMarker = bodyStart >= 0 ? html.indexOf('nested__widget', bodyStart) : -1;
  const bodyHtml = bodyStart >= 0
    ? html.slice(bodyStart, bodyEndMarker >= 0 ? html.lastIndexOf('<div', bodyEndMarker) : bodyStart + 8000)
    : '';

  // stripHtml already converts <p|div|li|h#> into newlines / "• " bullets —
  // just decode entities first, then split into non-empty normalized lines.
  const parts = [];
  const text = normalizeDescriptionSpace(stripHtml(decodeEntities(bodyHtml)))
    .split('\n')
    .map((line) => normalizeSpace(line))
    .filter(Boolean);
  for (const line of text) parts.push(line);

  return {
    title,
    location: location || factMap.standort || '',
    pensum: factMap.pensum || '',
    employmentTypeRaw: factMap.anstellung || '',
    description: parts.join('\n'),
    applyUrl,
    posId,
  };
}

/* Fetch + Parse orchestration ───────────────────────────── */

export async function fetchAllAbraxasJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  console.log(`💼 Fetching ${ABRAXAS_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  let listingHtml;
  try {
    listingHtml = await fetchHtml(CAREER_URL, { timeoutMs });
  } catch (err) {
    console.warn(`⚠️ Abraxas listing fetch failed: ${err?.message || err}`);
    return [];
  }

  const listings = parseAbraxasListing(listingHtml);
  console.log(`   📋 Found ${listings.length} positions on Abraxas listing\n`);
  if (!listings.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];

  for (const listing of listings) {
    let detail = { title: '', location: '', pensum: '', employmentTypeRaw: '', description: '', applyUrl: '', posId: '' };
    try {
      const detailHtml = await fetchHtml(listing.url, { timeoutMs });
      detail = parseAbraxasDetail(detailHtml);
    } catch (err) {
      console.warn(`   ⚠️ Detail fetch failed for ${listing.title}: ${err?.message || err}`);
    }

    const title = detail.title || listing.title;
    if (!title || title.length < 3) continue;

    const locationText = detail.location || listing.location || '';
    const addr = resolveAddress(locationText);
    const location = addr.primaryCity;
    const canton = addr.canton;

    const haystack = `${title} ${detail.description}`;
    const descriptionText = detail.description
      || `${title} bei ${ABRAXAS_COMPANY_NAME} in ${location}.`;
    const description = descriptionText;
    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} abraxas ${location}`);
    const urlHash = createHash('sha1').update(listing.url).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(`${detail.employmentTypeRaw} ${title}`);
    const pensum = extractPensum(detail.pensum || '');

    const job = {
      // ── Required fields ──
      id: `${ABRAXAS_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: ABRAXAS_COMPANY_NAME,
      companyKey: ABRAXAS_KEY,
      companyDomain: ABRAXAS_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: listing.url,
      source: 'Abraxas Informatik AG Dedicated Parser (custom HTML)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      needsRetranslation: true,
      addressLocality: location,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: addr.postalCode || '',
      streetAddress: addr.streetAddress || '',
      category: detectCategory(haystack),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(haystack),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: detail.applyUrl || listing.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
      externalId: detail.posId ? `${REFLINE_TENANT}-${detail.posId}` : urlHash,
    };

    if (pensum) {
      job.pensumMin = pensum.min;
      job.pensumMax = pensum.max;
      job.pensum = pensum.min === pensum.max ? `${pensum.min}%` : `${pensum.min} - ${pensum.max}%`;
    }

    jobs.push(job);
    console.log(`   ✅ ${title.substring(0, 70)} → ${location} (${canton})`);
    await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
  }

  console.log(`\n📋 Total ${ABRAXAS_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
