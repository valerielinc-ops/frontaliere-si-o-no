#!/usr/bin/env node
/**
 * Fondation Soins Lausanne job parser — custom HTML listing (cms-vaud.ch)
 * with jobup.ch JSON-LD deep-link detail enrichment.
 *
 * Fondation Soins Lausanne (FSL) is one of AVASAD's (Association Vaudoise
 * d'Aide et de Soins à Domicile) regional foundations, providing home-based
 * nursing/care ("aide et soins à domicile") exclusively within the city of
 * Lausanne (its territory is city-scoped, unlike sister foundations such as
 * APROMAD, ASPMAD, ASANTE SANA, APREMADOL, ABSMAD, Fondation de La Côte that
 * cover the rest of canton Vaud). FSL's own domain (fondationsoinslausanne.ch)
 * 301-redirects to the shared AVASAD portal cms-vaud.ch, which is the real,
 * live careers surface — verified live (2026-07): the table's 'jobs.ch
 * (feed) / Custom' hint is only partially right, the true chain is
 * cms-vaud.ch listing (WordPress, server-rendered, filterable by
 * `?employer=`) → jobup.ch (JobCloud network sibling of jobs.ch) detail page
 * carrying a full schema.org JobPosting JSON-LD block.
 *
 * Listing (server-rendered HTML, no JSON API):
 *   https://www.cms-vaud.ch/offres-d-emploi/?employer=fondation%20soins%20lausanne
 *
 *   <article class="job-item">
 *     <h1 class="title"><a target="_blank" href="https://www.jobup.ch/fr/emplois/detail/{uuid}/" class="link">{TITLE}</a></h1>
 *     <div class="desc">
 *       <div class="txt">
 *         <span>{POSTAL} {CITY} {REGION LABEL}</span><br>
 *         <span>{EMPLOYER}</span><br>
 *         <span>Ref: {REF}</span><br>
 *         <span>Publication: {DD.MM.YYYY}</span>
 *       </div>
 *     </div>
 *   </article>
 *
 * Every FSL listing observed live carries the same location line
 * ("1010 Lausanne Région lausannoise") — FSL's whole territory is the city
 * of Lausanne itself, so there is no genuine per-job locality signal to
 * extract; 1010 Lausanne is the real (not fallback) value.
 *
 * Detail page (jobup.ch) exposes a `JobPosting` JSON-LD with rich HTML
 * `description`, `datePosted`, `employmentType`, `workHours`, `baseSalary`
 * (usually an empty MonetaryAmount — jobup rarely discloses pay) and a
 * static HQ `jobLocation` (Route d'Oron 2, 1010 Lausanne). `hiringOrganization`
 * on jobup is AVASAD (the umbrella feed operator), not the real employer —
 * overridden here with the confirmed legal entity name "Fondation Soins
 * Lausanne" for `company`/`hiringOrganization.name`.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import { fetchWithRetry, isConnectionLevelFetchError } from './transient-fetch.mjs';
import { fetchHtmlViaJinaWithRetry, rescueHtmlIfChallenged } from './jina-proxy.mjs';
import {
  decodeEntities,
  normalizeSpace,
  htmlToText,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
  USER_AGENT,
} from './hospital-custom-html-helpers.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const FONDATION_SOINS_LAUSANNE_KEY = 'fondation-soins-lausanne';
export const FONDATION_SOINS_LAUSANNE_COMPANY_NAME = 'Fondation Soins Lausanne';
export const FONDATION_SOINS_LAUSANNE_COMPANY_DOMAIN = 'cms-vaud.ch';

const LISTING_URL = 'https://www.cms-vaud.ch/offres-d-emploi/?employer=fondation%20soins%20lausanne';
const DEFAULT_POSTAL_CODE = '1010';
const DEFAULT_CITY = 'Lausanne';
const DEFAULT_CANTON = 'VD';

/* ── Fetch helpers ─────────────────────────────────────────── */

async function fetchListingHtml(url, { timeoutMs } = {}) {
  const t = timeoutMs || Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  try {
    const html = await fetchWithRetry(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), t);
      try {
        const res = await fetch(url, {
          headers: { Accept: 'text/html,application/xhtml+xml,application/xml,*/*', 'User-Agent': USER_AGENT },
          signal: controller.signal,
        });
        if (!res.ok) {
          const err = new Error(`HTTP ${res.status} from ${url}`);
          err.status = res.status;
          err.retryable = res.status === 408 || res.status === 429 || res.status >= 500;
          throw err;
        }
        return await res.text();
      } finally {
        clearTimeout(timer);
      }
    }, { label: `fondation-soins-lausanne listing ${url}` });
    return await rescueHtmlIfChallenged(html, url, { timeoutMs: t });
  } catch (err) {
    if (isConnectionLevelFetchError(err)) {
      const html = await fetchHtmlViaJinaWithRetry(url, { timeoutMs: t });
      if (html != null) return html;
    }
    throw err;
  }
}

/** Fetch a jobup.ch detail page and extract its `JobPosting` JSON-LD block. Returns null on any failure (caller falls back to listing-only description). */
async function fetchJobupJobPosting(url) {
  const t = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 15000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), t);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'text/html', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const html = await res.text();
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    for (const b of blocks) {
      try {
        const parsed = JSON.parse(b[1]);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        const posting = items.find((it) => it && it['@type'] === 'JobPosting');
        if (posting) return posting;
      } catch {
        // skip malformed JSON-LD block
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ── Listing parser ────────────────────────────────────────── */

export function parseFondationSoinsLausanneListing(html) {
  const out = [];
  const blockRx = /<article class="job-item">[\s\S]*?<\/article>/g;
  let m;
  while ((m = blockRx.exec(html))) {
    const block = m[0];
    const linkMatch = block.match(/<a[^>]*href="([^"]+)"[^>]*class="link">([\s\S]*?)<\/a>/);
    if (!linkMatch) continue;
    const applyUrl = normalizeSpace(decodeEntities(linkMatch[1]));
    const title = normalizeSpace(decodeEntities(linkMatch[2].replace(/<[^>]+>/g, '')));
    if (!applyUrl || !title || title.length < 3) continue;

    const spans = [...block.matchAll(/<span>([^<]*)<\/span>/g)].map((s) => normalizeSpace(decodeEntities(s[1])));
    const locationLine = spans[0] || '';
    const refLine = spans[2] || '';
    const publicationLine = spans[3] || '';

    const refMatch = refLine.match(/Ref:\s*(\S+)/i);
    const pubMatch = publicationLine.match(/(\d{2})\.(\d{2})\.(\d{4})/);

    out.push({
      title,
      applyUrl,
      locationLine,
      ref: refMatch ? refMatch[1] : '',
      publicationIso: pubMatch ? `${pubMatch[3]}-${pubMatch[2]}-${pubMatch[1]}` : '',
    });
  }
  return out;
}

function parseLocationLine(line = '') {
  const m = String(line || '').match(/^(\d{4})\s+(.+)$/);
  if (!m) return { postalCode: DEFAULT_POSTAL_CODE, city: DEFAULT_CITY };
  // "1010 Lausanne Région lausannoise" — take the first word after the
  // postal code as the city; the trailing region label is not a locality.
  const rest = m[2].trim();
  const cityWord = rest.split(/\s+/)[0] || DEFAULT_CITY;
  return { postalCode: m[1], city: cityWord };
}

/* ── Company matchers ──────────────────────────────────────── */

export function isFondationSoinsLausanneJob(job) {
  const key = String(job?.companyKey || '').toLowerCase();
  const company = String(job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  if (key === FONDATION_SOINS_LAUSANNE_KEY) return true;
  if (company.includes('fondation soins lausanne')) return true;
  if (url.includes('cms-vaud.ch') && company.includes('soins lausanne')) return true;
  return false;
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'cms-vaud.ch' || host.endsWith('.cms-vaud.ch')) return true;
    if (host === 'jobup.ch' || host === 'www.jobup.ch') return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Public API ────────────────────────────────────────────── */

export async function fetchAllFondationSoinsLausanneJobs() {
  console.log(`🏥 Fetching ${FONDATION_SOINS_LAUSANNE_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL}\n`);

  let html;
  try {
    html = await fetchListingHtml(LISTING_URL, { timeoutMs: 40000 });
  } catch (err) {
    console.warn(`  ⚠️ Listing fetch failed: ${err?.message || err}`);
    return [];
  }

  const items = parseFondationSoinsLausanneListing(html);
  console.log(`  ✓ ${items.length} offerte trovate`);
  if (!items.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  let detailHits = 0;

  for (const it of items) {
    const { postalCode, city } = parseLocationLine(it.locationLine);
    const canton = DEFAULT_CANTON;

    const posting = await fetchJobupJobPosting(it.applyUrl);
    if (posting) detailHits++;
    await new Promise((r) => setTimeout(r, 250));

    const detailText = posting?.description ? htmlToText(posting.description).trim() : '';
    const employmentTypeRaw = posting?.employmentType || '';
    const workHours = posting?.workHours || '';

    const description = detailText || normalizeSpace(
      [
        it.title,
        `${FONDATION_SOINS_LAUSANNE_COMPANY_NAME} — aide et soins à domicile, territoire lausannois (AVASAD).`,
        it.locationLine,
      ].filter(Boolean).join('\n\n'),
    );

    const heuristicText = `${it.title} ${employmentTypeRaw} ${workHours}`;
    const sourceLang = detectLang(description || it.title, 'fr');
    const slug = slugify(`${it.title} ${FONDATION_SOINS_LAUSANNE_KEY} ${city}`);
    const hashBasis = it.applyUrl || `${FONDATION_SOINS_LAUSANNE_KEY}-${it.ref}`;
    const urlHash = createHash('sha1').update(hashBasis).digest('hex').slice(0, 12);

    const postedDate = posting?.datePosted
      ? String(posting.datePosted).slice(0, 10)
      : (it.publicationIso || todayIso);

    const contractIsTemp = /dur[ée]e d[ée]termin[ée]e|cdd|temporaire|fixed/i.test(employmentTypeRaw);

    jobs.push({
      id: `${FONDATION_SOINS_LAUSANNE_KEY}-${urlHash}`,
      slug,
      slugByLocale: { [sourceLang]: slug },
      company: FONDATION_SOINS_LAUSANNE_COMPANY_NAME,
      companyKey: FONDATION_SOINS_LAUSANNE_KEY,
      companyDomain: FONDATION_SOINS_LAUSANNE_COMPANY_DOMAIN,
      title: it.title,
      titleByLocale: { [sourceLang]: it.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't (cache miss + AI quota), the flag stays and
      // `translate-pending.yml` picks the job up out-of-band.
      needsRetranslation: true,
      location: city,
      canton,
      url: it.applyUrl,
      source: 'Fondation Soins Lausanne Dedicated Parser (cms-vaud.ch listing + jobup.ch JSON-LD)',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: city,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode,
      category: detectHealthcareCategory(`${it.title} ${description}`),
      contract: contractIsTemp ? 'temporary' : 'full-time',
      employmentType: detectHealthcareEmploymentType(heuristicText || it.title),
      experienceLevel: detectHealthcareExperienceLevel(it.title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: it.applyUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
      careerSiteUrl: LISTING_URL,
    });
  }

  console.log(`\n📋 Total ${FONDATION_SOINS_LAUSANNE_COMPANY_NAME} jobs discovered: ${jobs.length} (${detailHits}/${items.length} with rich jobup.ch detail content)`);
  return jobs;
}
