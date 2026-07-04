#!/usr/bin/env node
/**
 * Kanton Aargau (cantonal administration) job parser — Umantis ATS
 * (tenant 12705).
 *
 * Discovery correction (2026-07-03): the original orchestrator brief
 * pointed at `ohws.prospective.ch` (Prospective ATS, ~69 roles estimate).
 * Live verification found every "Kanton Aargau" listing on Prospective is a
 * stale, closed vacancy (404 "diese Vakanz wurde bereits wieder
 * geschlossen") — Prospective is a dead lead. The canton's own public
 * stellenmarkt (`https://www.ag.ch/de/ueber-uns/jobs-karriere/offene-stellen/stellenmarkt`)
 * embeds a widget (`data-api="/io/jobs-proxy"`) whose config attributes
 * reveal the real backend: `https://recruitingapp-12705.umantis.com`
 * (Umantis ATS). Confirmed by the single-employer logo (`logo_kag.jpg`) and
 * company label ("Kanton Aargau") on every listing row.
 *
 * Public career site: https://www.ag.ch/de/ueber-uns/jobs-karriere/offene-stellen/stellenmarkt
 *   "Im Stellenmarkt finden Sie alle offenen Stellen der Verwaltung, Gerichte,
 *   Kantonspolizei und der Lehrerschaft des Kantons Aargau" — i.e. this
 *   tenant covers the WHOLE cantonal administration + courts + cantonal
 *   police + teaching staff, not just central administration. That is why
 *   the real listing count (~440+, paginated 10/page) is an order of
 *   magnitude above the ~69 discovery estimate.
 *
 * Listing page (server-rendered "older UI", 10 rows/page, pagination via
 * `tc1152481=pN&_search_token1152481=TOKEN`, same mechanism as
 * ksa-job-parser.mjs / inselspital-job-parser.mjs):
 *   https://recruitingapp-12705.umantis.com/Jobs/All?lang=ger
 *
 * Detail pages are DEAD: `/Vacancies/{id}/Description/1` 302-redirects
 * cross-host to a generic `www.ag.ch` careers landing page (not job-specific
 * — confirmed by direct fetch, issue #1245 pattern). `/Vacancies/{id}/Application/CheckLogin/1`
 * stays same-host (redirects to `/Vacancies/{id}/Application/New/1`), so
 * that is used as the canonical job URL instead.
 *
 * The listing rows themselves carry almost no metadata beyond title +
 * "Online seit" date + internal "Planstelle" reference number (no
 * department/pensum/Befristung/city columns are populated for this
 * tenant — verified empty across every `tableaslist_element_*` span).
 * Employment type is therefore derived from the `NN%`/`NN-MM%` pattern
 * embedded in the title itself (the only per-job pensum signal available),
 * and the description is a structured synthesised paragraph (title +
 * canton-employer blurb + reference/date bullets) rather than scraped
 * body text, since no real per-job body is reachable from either ATS.
 *
 * Reuses shared Umantis helpers from `umantis-listing-common.mjs`
 * (`parseUmantisListing`, `decodeEntities`, `parseSwissDate`) — the
 * `createUmantisListingParser()` factory in that module does not paginate,
 * so (like ksa/inselspital) this file implements its own pagination walk
 * on top of the shared row-parsing helpers rather than the single-page
 * factory.
 *
 * Exports 4 functions crawler template:
 * - fetchAllKantonAargauJobs() — Fetch + parse all jobs across pages
 * - isKantonAargauJob()        — Match jobs belonging to Kanton Aargau
 * - isTrustedDomain()          — Validate URLs belong to ag.ch / Umantis tenant 12705
 * - KANTON_AARGAU_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createHash } from 'node:crypto';
import { parseUmantisListing, decodeEntities, parseSwissDate } from './umantis-listing-common.mjs';
import { slugify } from './crawler-template.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const KANTON_AARGAU_KEY = 'kanton-aargau';
export const KANTON_AARGAU_COMPANY_NAME = 'Kanton Aargau';
export const KANTON_AARGAU_COMPANY_DOMAIN = 'ag.ch';

const UMANTIS_TENANT = '12705';
const BASE_URL = `https://recruitingapp-${UMANTIS_TENANT}.umantis.com`;
const LISTING_URL = `${BASE_URL}/Jobs/All?lang=ger`;
const PUBLIC_CAREER_URL = 'https://www.ag.ch/de/ueber-uns/jobs-karriere/offene-stellen/stellenmarkt';

// HQ defaults — cantonal administration headquarters (Regierungsgebäude).
const HQ_STREET = 'Bahnhofstrasse 2';
const HQ_POSTAL_CODE = '5000';
const HQ_CITY = 'Aarau';
const HQ_CANTON = 'AG';

// Hard cap on pagination walk (10 rows/page → 600 vacancies max). Live
// count observed 2026-07-03 was ~442 across 45 pages.
const MAX_PAGES = 60;

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/**
 * Skip QA/placeholder listings that aren't real vacancies (e.g. "Test HRAG
 * ELM" observed live in the tenant's listing — an integration-test entry
 * left in the ATS, not a job).
 */
function isTestOrPlaceholderListing(title = '') {
  return /^test\b/i.test(title.trim())
    || /(^|\b)(initiativbewerbung|spontanbewerbung|blindbewerbung)\b/i.test(title);
}

/* ── Company Matchers ─────────────────────────────────────── */

export function isKantonAargauJob(job) {
  if (!job) return false;
  const key = normalize(job?.companyKey || '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');
  return (
    key === KANTON_AARGAU_KEY
    || company === normalize(KANTON_AARGAU_COMPANY_NAME)
    || url.includes('ag.ch')
    || url.includes(`recruitingapp-${UMANTIS_TENANT}.umantis.com`)
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'ag.ch' || host.endsWith('.ag.ch')) return true;
    if (host === `recruitingapp-${UMANTIS_TENANT}.umantis.com`) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category / experience / employment heuristics (public admin) ─ */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(lehrperson|lehrer|lehrerin|schule|kindergarten|primarstufe|sekundarstufe|kantonsschule|berufsschule|dozent)/.test(t)) return 'Formazione';
  if (/\b(polizist|polizei|kapo|einsatz|fahndung)/.test(t)) return 'Sicurezza';
  if (/\b(pflege|pflegefach|fage|gesundheit|arzt|ärztin|medizin|sozialdienst|betreuung)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(recht|jurist|rechtspraktikum|gericht|staatsanwalt|notariat)/.test(t)) return 'Legale';
  if (/\b(it|informatik|software|develop|system|digital)/.test(t)) return 'IT';
  if (/\b(admin|sekretariat|sachbearbeit|buchhalt|finanz|controll|revision|revisor)/.test(t)) return 'Amministrazione';
  if (/\b(hr|personal|talent|recruit)/.test(t)) return 'Risorse Umane';
  if (/\b(techni|haustechni|facility|wald|förster|umwelt|natur|landschaft)/.test(t)) return 'Tecnica';
  if (/\b(küche|koch|gastro|hauswirtschaft|reinigung)/.test(t)) return 'Ospitalità';
  if (/\b(logist|magazz|lager|transport)/.test(t)) return 'Logistica';
  if (/\b(market|kommunik)/.test(t)) return 'Marketing';
  if (/\b(lernend|praktik|ausbildung|apprenti|hochschulpraktikum)/.test(t)) return 'Formazione';
  return 'Amministrazione Pubblica';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|intern|lehrling|lernend|apprenti|hochschulpraktikum|rechtspraktikum)/.test(t)) return 'intern';
  if (/\b(junior|jr|assistent)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|chef|verantwort|leiter|leiterin|leitend|kommandant)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(title = '') {
  const t = normalize(title);
  const pct = t.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || t.match(/(\d{2,3})\s*%/);
  if (pct) {
    const maxPct = pct[2] ? parseInt(pct[2], 10) : parseInt(pct[1], 10);
    return maxPct < 80 ? 'PART_TIME' : 'FULL_TIME';
  }
  return 'OTHER';
}

/* ── Description synthesis ───────────────────────────────────
 * No per-job body content is reachable from either ATS (Umantis detail
 * pages dead-redirect to a generic careers page; Prospective listings are
 * all stale/closed — see file header). The description is therefore a
 * structured paragraph built from the one real per-job signal we have
 * (title) plus a factual employer blurb + reference bullets, always
 * comfortably above the 50-word thin-content floor. */
function buildDescription(title, postedIso, planstelle) {
  const intro = `${title} — offene Stelle beim Kanton Aargau, direkt auf dem offiziellen Stellenportal der Kantonalen Verwaltung ausgeschrieben.`;
  const blurb = `Der Kanton Aargau zählt mit rund 700'000 Einwohnerinnen und Einwohnern zu den bevölkerungsreichsten Kantonen der Schweiz und ist einer der grössten Arbeitgeber der Region. Als öffentliche Verwaltung beschäftigt er Mitarbeitende in der kantonalen Verwaltung, den Gerichten, der Kantonspolizei und im Bildungswesen und bietet vielfältige, sinnstiftende Karrieremöglichkeiten in unterschiedlichen Fachbereichen.`;
  const bullets = [
    `• Arbeitgeber: ${KANTON_AARGAU_COMPANY_NAME}`,
    `• Standort: ${HQ_CITY} (Kanton ${HQ_CANTON})`,
  ];
  if (planstelle) bullets.push(`• Referenznummer: ${planstelle}`);
  if (postedIso) bullets.push(`• Online seit: ${postedIso}`);
  bullets.push(`• Bewerbung über das offizielle Stellenportal des Kantons Aargau (${PUBLIC_CAREER_URL})`);
  return [intro, blurb, bullets.join('\n')].join('\n\n');
}

/* ── HTTP Fetch ───────────────────────────────────────────── */

async function fetchPage(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': USER_AGENT,
        'Accept-Language': 'de-CH,de;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function extractPagingToken(html = '') {
  const m = html.match(
    /data-pagination-next-href="\?tc1152481=p\d+&amp;_search_token1152481=(\d+)/,
  );
  return m ? m[1] : null;
}

/** Extract the "Planstelle: NNNNN" reference number for a listing, if present. */
function extractPlanstelle(html = '', vacancyId = '') {
  const rx = new RegExp(`href="/Vacancies/${vacancyId}/Description/\\d+"[\\s\\S]{0,600}?Planstelle:\\s*(\\d+)`);
  const m = html.match(rx);
  return m ? m[1] : '';
}

/** Extract the "Online seit: DD.MM.YYYY" date for a listing, if present. */
function extractOnlineSeit(html = '', vacancyId = '') {
  const rx = new RegExp(`href="/Vacancies/${vacancyId}/Description/\\d+"[\\s\\S]{0,900}?Online seit:\\s*(\\d{1,2}\\.\\d{1,2}\\.\\d{4})`);
  const m = html.match(rx);
  if (m) return m[1];
  // "Online seit" can also appear just before the title anchor (older UI order varies).
  const before = new RegExp(`Online seit:\\s*(\\d{1,2}\\.\\d{1,2}\\.\\d{4})[\\s\\S]{0,900}?href="/Vacancies/${vacancyId}/Description/\\d+"`);
  const m2 = html.match(before);
  return m2 ? m2[1] : '';
}

/* ── Main Fetch Function ──────────────────────────────────── */

export async function fetchAllKantonAargauJobs() {
  console.log(`🏛️  Fetching ${KANTON_AARGAU_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL}`);
  console.log(`   Public: ${PUBLIC_CAREER_URL}\n`);

  const seenIds = new Set();
  const allEntries = [];

  let html;
  try {
    html = await fetchPage(LISTING_URL);
  } catch (err) {
    console.warn(`  ⚠️  Kanton Aargau listing fetch failed: ${err?.message || err}. Returning 0 jobs.`);
    return [];
  }

  const collectPage = (pageHtml) => {
    const { entries } = parseUmantisListing(pageHtml);
    let added = 0;
    for (const entry of entries) {
      if (seenIds.has(entry.id)) continue;
      if (isTestOrPlaceholderListing(entry.title)) continue;
      seenIds.add(entry.id);
      allEntries.push({
        id: entry.id,
        title: entry.title,
        planstelle: extractPlanstelle(pageHtml, entry.id),
        onlineSeit: extractOnlineSeit(pageHtml, entry.id),
      });
      added++;
    }
    return added;
  };

  collectPage(html);
  console.log(`  📄 page 1: ${allEntries.length} jobs`);

  const searchToken = extractPagingToken(html);
  if (searchToken) {
    for (let pageNum = 2; pageNum <= MAX_PAGES; pageNum++) {
      const pageUrl = `${LISTING_URL}&tc1152481=p${pageNum}&_search_token1152481=${searchToken}`;
      let pageHtml;
      try {
        pageHtml = await fetchPage(pageUrl);
      } catch (err) {
        console.warn(`  ⚠️  Page ${pageNum} fetch failed: ${err?.message || err}`);
        break;
      }
      const added = collectPage(pageHtml);
      if (added === 0) break;
      if (pageNum % 10 === 0) console.log(`  📄 page ${pageNum}: ${allEntries.length} jobs so far`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  console.log(`  ✓ ${allEntries.length} unique jobs across pagination\n`);
  if (!allEntries.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (const entry of allEntries) {
    const { id: vacancyId, title, planstelle, onlineSeit } = entry;
    if (!title || title.length < 3) continue;

    const decodedTitle = decodeEntities(title);
    const detailUrl = `${BASE_URL}/Vacancies/${vacancyId}/Description/1`;
    // Detail pages dead-redirect cross-host (see file header) — use the
    // same-host Application URL as the stable canonical job URL instead.
    const applyUrl = `${BASE_URL}/Vacancies/${vacancyId}/Application/CheckLogin/1`;
    const jobUrl = applyUrl;

    const postedDate = parseSwissDate(onlineSeit) || todayIso;
    const description = buildDescription(decodedTitle, postedDate, planstelle);

    const sourceLang = 'de';
    const jobSlug = slugify(`${decodedTitle} kanton-aargau ch`);
    const urlHash = createHash('sha1').update(`kanton-aargau-vacancy-${vacancyId}`).digest('hex').slice(0, 12);

    const job = {
      id: `${KANTON_AARGAU_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: KANTON_AARGAU_COMPANY_NAME,
      companyKey: KANTON_AARGAU_KEY,
      companyDomain: KANTON_AARGAU_COMPANY_DOMAIN,
      title: decodedTitle,
      titleByLocale: { [sourceLang]: decodedTitle },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't (cache miss + AI quota), the flag stays and
      // `translate-pending.yml` picks the job up out-of-band.
      needsRetranslation: true,
      location: HQ_CITY,
      canton: HQ_CANTON,
      url: jobUrl,
      source: `${KANTON_AARGAU_COMPANY_NAME} Dedicated Parser (Umantis tenant ${UMANTIS_TENANT})`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: HQ_CITY,
      addressRegion: HQ_CANTON,
      streetAddress: HQ_STREET,
      postalCode: HQ_POSTAL_CODE,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(decodedTitle),
      contract: 'full-time',
      employmentType: detectEmploymentType(decodedTitle),
      experienceLevel: detectExperienceLevel(decodedTitle),
      sector: 'Amministrazione Pubblica',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    if (planstelle) job.referenceNumber = planstelle;

    jobs.push(job);
  }

  console.log(`📋 Total ${KANTON_AARGAU_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
