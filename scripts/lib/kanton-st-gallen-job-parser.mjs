#!/usr/bin/env node
/**
 * Kanton St. Gallen (cantonal administration) job parser — Umantis ATS
 * (tenant 2800).
 *
 * Discovery correction (2026-07-03): the orchestrator brief tagged this row
 * "jobs.ch (feed)" / "Custom (jobs.ch affiliate)". Live verification of the
 * official stellenportal (`https://www.sg.ch/ueber-den-kanton-st-gallen/
 * arbeitgeber-kanton-stgallen/stellenportal.html`) shows the embedded search
 * widget actually calls `https://recruitingapp-2800.umantis.com/Jobs/All?
 * CompanyID=1|24|25|...|136&DesignID=00` — i.e. the real backend is Umantis
 * ATS, not a jobs.ch feed (same discovery-tag unreliability pattern already
 * seen on Kanton Aargau in this campaign). The `CompanyID` list enumerates
 * every department/Amt of the cantonal administration that publishes via
 * this tenant.
 *
 * Public career site: https://www.sg.ch/ueber-den-kanton-st-gallen/arbeitgeber-kanton-stgallen/stellenportal.html
 *   "Hier finden Sie alle offenen Stellen der kantonalen Verwaltung" — genuine
 *   direct public-sector employer (5th-largest Swiss canton, ~6000
 *   Mitarbeitende per the tenant's own careers blurb), NOT a staffing agency.
 *   Listing rows cover real Amt-level roles (Wasserbau, Handelsregister und
 *   Notariate, Verkehrsplanung, Sozialarbeit, Schwarzarbeit-Aufsicht, ...) —
 *   sanity-checked against staffing-agency patterns (no "Personalvermittlung",
 *   no third-party client-brand listings): confirmed genuine.
 *
 * Listing page (server-rendered "older UI", 25 rows/page, pagination via
 * `tc1152481=pN&_search_token1152481=TOKEN`, same mechanism as
 * kanton-aargau-job-parser.mjs / ksa-job-parser.mjs):
 *   https://recruitingapp-2800.umantis.com/Jobs/All?CompanyID=...&DesignID=00&lang=ger
 *
 * UNLIKE Kanton Aargau (whose Umantis detail pages dead-redirect cross-host),
 * this tenant's detail pages (`/Vacancies/{id}/Description/1`) are LIVE and
 * server-rendered with rich per-job content in a THIRD Umantis layout variant
 * not covered by the two layouts already handled in
 * `umantis-detail-helpers.mjs` (`expander-N`/`expandable-N` and bare
 * `h3`+`div.padding`):
 *
 *   <h1>{title}</h1>
 *   <p class="location-text"> Pensum: NN-NN% <br><br> Arbeitsort: {city} </p>
 *   <h3>{section heading}</h3><div class="list-reduce"><ul><li>...</li></ul></div>
 *   (repeated per section: "Was Sie erwartet" / "Was Sie auszeichnet" /
 *   "Was wir bieten" / ...)
 *
 * plus a `<p class="custom-intro-text">` paragraph naming the issuing
 * Amt/Abteilung, and a contact block with a named person + direct email
 * (`vorname.nachname@sg.ch`). This file implements its own
 * `extractStGallenDetailContent()` for that layout rather than extending the
 * shared `umantis-detail-helpers.mjs` (kept additive/local, matching the
 * Kanton Aargau precedent of a fully custom parser file — reconciled with
 * siblings at PR-batch-merge time, not here).
 *
 * A general HR/personnel postal address (`Lämmlisbrunnenstrasse 54, 9001
 * St.Gallen`) appears inside an HTML comment on every detail page checked
 * (job IDs 6209, 6371) as the template's fallback "Weitere Auskünfte" block —
 * used here as the safe default `streetAddress`/`postalCode` for the
 * cantonal administration HQ.
 *
 * Reuses shared Umantis listing helpers from `umantis-listing-common.mjs`
 * (`parseUmantisListing`, `decodeEntities`, `parseSwissDate`) — the
 * `createUmantisListingParser()` factory in that module does not paginate
 * and hardcodes a hospital-sector default, so (like kanton-aargau /
 * ksa / inselspital) this file implements its own pagination walk and
 * public-admin category heuristics on top of the shared row-parsing helpers.
 *
 * Exports 4 items for the crawler template:
 * - fetchAllKantonStGallenJobs() — Fetch + parse all jobs across pagination
 * - isKantonStGallenJob()        — Match jobs belonging to Kanton St. Gallen
 * - isTrustedDomain()            — Validate URLs belong to sg.ch / Umantis tenant 2800
 * - KANTON_ST_GALLEN_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createHash } from 'node:crypto';
import { parseUmantisListing, decodeEntities, parseSwissDate } from './umantis-listing-common.mjs';
import { slugify, normalizeSpace, stripHtml } from './crawler-template.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const KANTON_ST_GALLEN_KEY = 'kanton-st-gallen';
export const KANTON_ST_GALLEN_COMPANY_NAME = 'Kanton St. Gallen';
export const KANTON_ST_GALLEN_COMPANY_DOMAIN = 'sg.ch';

const UMANTIS_TENANT = '2800';
const BASE_URL = `https://recruitingapp-${UMANTIS_TENANT}.umantis.com`;
// Full CompanyID enumeration copied verbatim from the live sg.ch stellenportal
// widget config (all departments/Ämter that publish via this tenant).
const COMPANY_IDS = '1|24|25|26|27|28|29|30|31|32|33|34|35|36|37|38|39|40|41|42|43|44|45|46|47|48|49|50|51|52|53|54|55|56|57|58|59|61|62|63|64|65|66|67|68|69|70|71|72|73|75|76|77|78|79|80|81|82|83|84|85|86|87|88|89|90|91|92|94|96|98|100|102|104|106|108|110|132|134|136';
const LISTING_URL = `${BASE_URL}/Jobs/All?CompanyID=${COMPANY_IDS}&DesignID=00&lang=ger`;
const PUBLIC_CAREER_URL = 'https://www.sg.ch/ueber-den-kanton-st-gallen/arbeitgeber-kanton-stgallen/stellenportal.html';

// HQ defaults — cantonal administration general HR/personnel address,
// confirmed consistent across multiple detail pages (see file header).
const HQ_STREET = 'Lämmlisbrunnenstrasse 54';
const HQ_POSTAL_CODE = '9001';
const HQ_CITY = 'St. Gallen';
const HQ_CANTON = 'SG';

// Hard cap on pagination walk (25 rows/page). Live count observed
// 2026-07-03 was ~41 across 2 pages (matches discovery estimate).
const MAX_PAGES = 30;

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/**
 * Skip QA/placeholder/spontaneous-application listings that aren't real
 * vacancies.
 */
function isTestOrPlaceholderListing(title = '') {
  return /^test\b/i.test(title.trim())
    || /(^|\b)(initiativbewerbung|spontanbewerbung|blindbewerbung)\b/i.test(title);
}

/* ── Company Matchers ─────────────────────────────────────── */

export function isKantonStGallenJob(job) {
  if (!job) return false;
  const key = normalize(job?.companyKey || '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');
  return (
    key === KANTON_ST_GALLEN_KEY
    || company === normalize(KANTON_ST_GALLEN_COMPANY_NAME)
    || url.includes(`recruitingapp-${UMANTIS_TENANT}.umantis.com`)
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'sg.ch' || host.endsWith('.sg.ch')) return true;
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
  if (/\b(pflege|pflegefach|fage|gesundheit|arzt|ärztin|medizin|sozialdienst|sozialarbeit|betreuung)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(recht|jurist|rechtspraktikum|gericht|staatsanwalt|notariat|handelsregister)/.test(t)) return 'Legale';
  if (/\b(it|informatik|software|develop|system|digital)/.test(t)) return 'IT';
  if (/\b(admin|sekretariat|sachbearbeit|buchhalt|finanz|controll|revision|revisor)/.test(t)) return 'Amministrazione';
  if (/\b(hr|personal|talent|recruit)/.test(t)) return 'Risorse Umane';
  if (/\b(techni|haustechni|facility|wald|förster|umwelt|natur|landschaft|wasserbau|wasser|energie)/.test(t)) return 'Tecnica';
  if (/\b(küche|koch|gastro|hauswirtschaft|reinigung)/.test(t)) return 'Ospitalità';
  if (/\b(logist|magazz|lager|transport|verkehr)/.test(t)) return 'Logistica';
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

function detectEmploymentType(pensum = '', title = '') {
  const t = normalize(pensum || title);
  const pct = t.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || t.match(/(\d{2,3})\s*%/);
  if (pct) {
    const maxPct = pct[2] ? parseInt(pct[2], 10) : parseInt(pct[1], 10);
    return maxPct < 80 ? 'PART_TIME' : 'FULL_TIME';
  }
  return 'OTHER';
}

/* ── Detail-page extraction (3rd Umantis layout: h1 + location-text +
 *    h3/list-reduce sections) ──────────────────────────────────────── */

/**
 * Extract the issuing Amt/Abteilung blurb from the `custom-intro-text`
 * paragraph that precedes the job title, e.g. "Das <b>Amt für Wasser und
 * Energie (AWE)</b> setzt sich ein für ...".
 */
function extractIntroBlurb(html = '') {
  const m = html.match(/<p class="custom-intro-text">([\s\S]*?)<\/p>/);
  if (!m) return '';
  return normalizeSpace(decodeEntities(stripHtml(m[1])));
}

/** Extract "Pensum: NN-NN%" / "Arbeitsort: {city}" from `location-text`. */
function extractLocationText(html = '') {
  const m = html.match(/<p class="location-text">([\s\S]*?)<\/p>/);
  if (!m) return { pensum: '', arbeitsort: '' };
  const text = normalizeSpace(decodeEntities(stripHtml(m[1])));
  const pensumMatch = text.match(/Pensum:\s*([\d%\s\-–]+)/);
  const ortMatch = text.match(/Arbeitsort:\s*([^,]+?)(?:\s*$)/);
  // Umantis renders the cantonal capital as "St.Gallen" (no space) — normalize
  // to the sitewide canonical spelling "St. Gallen" used everywhere else
  // (crawler-location-config.mjs, canton-url-slugs.json).
  const rawArbeitsort = ortMatch ? ortMatch[1].trim() : '';
  const arbeitsort = rawArbeitsort.replace(/\bSt\.\s*Gallen\b/i, 'St. Gallen');
  return {
    pensum: pensumMatch ? pensumMatch[1].trim() : '',
    arbeitsort,
  };
}

/** Extract every `<h3>heading</h3><div class="list-reduce">body</div>` pair. */
function extractSections(html = '') {
  const sections = [];
  const rx = /<h3>([\s\S]*?)<\/h3>\s*<div class="list-reduce">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = rx.exec(html))) {
    const heading = normalizeSpace(decodeEntities(stripHtml(m[1])));
    if (!heading) continue;
    let body = m[2]
      .replace(/<li[^>]*>/gi, '\n• ')
      .replace(/<\/li\s*>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n');
    body = normalizeSpace(decodeEntities(stripHtml(body))).replace(/\s*•\s*/g, '\n• ');
    if (body) sections.push(`${heading}:\n${body}`);
  }
  return sections;
}

/** Extract the direct-contact line ("Vorname Nachname, Rolle, Telefon N oder email"). */
function extractContact(html = '') {
  // Only take the line OUTSIDE the HTML comment (the real per-job contact),
  // not the commented-out generic Personaldienst template block.
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const m = withoutComments.match(/Weitere Auskünfte unter:<\/strong><br\s*\/?>\s*([\s\S]*?)<br/);
  if (!m) return '';
  return normalizeSpace(decodeEntities(stripHtml(m[1])));
}

/**
 * Extract rich structured content from a Kanton St. Gallen Umantis detail
 * page (3rd layout variant — see file header). Returns '' when the expected
 * markers aren't found (caller falls back to a synthesised description).
 */
export function extractStGallenDetailContent(html = '') {
  if (!html || typeof html !== 'string' || html.length < 200) return '';
  const cleaned = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ');

  const intro = extractIntroBlurb(cleaned);
  const sections = extractSections(cleaned);
  const contact = extractContact(cleaned);

  const parts = [];
  if (intro) parts.push(intro);
  parts.push(...sections);
  if (contact) parts.push(`Kontakt: ${contact}`);
  return parts.join('\n\n');
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

/* ── Main Fetch Function ──────────────────────────────────── */

export async function fetchAllKantonStGallenJobs() {
  console.log(`🏛️  Fetching ${KANTON_ST_GALLEN_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL}`);
  console.log(`   Public: ${PUBLIC_CAREER_URL}\n`);

  const seenIds = new Set();
  const allEntries = [];

  let html;
  try {
    html = await fetchPage(LISTING_URL);
  } catch (err) {
    console.warn(`  ⚠️  Kanton St. Gallen listing fetch failed: ${err?.message || err}. Returning 0 jobs.`);
    return [];
  }

  const collectPage = (pageHtml) => {
    const { entries } = parseUmantisListing(pageHtml);
    let added = 0;
    for (const entry of entries) {
      if (seenIds.has(entry.id)) continue;
      if (isTestOrPlaceholderListing(entry.title)) continue;
      seenIds.add(entry.id);
      allEntries.push(entry);
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
      console.log(`  📄 page ${pageNum}: ${allEntries.length} jobs so far`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  console.log(`  ✓ ${allEntries.length} unique jobs across pagination\n`);
  if (!allEntries.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  let detailHits = 0;
  for (const entry of allEntries) {
    const { id: vacancyId, title: rawTitle, datum } = entry;
    const title = decodeEntities(rawTitle);
    if (!title || title.length < 3) continue;

    const detailUrl = `${BASE_URL}/Vacancies/${vacancyId}/Description/1`;
    const applyUrl = `${BASE_URL}/Vacancies/${vacancyId}/Application/CheckLogin/1`;

    let detailHtml = '';
    try {
      detailHtml = await fetchPage(detailUrl);
    } catch (err) {
      console.warn(`  ⚠️  Detail fetch failed for ${vacancyId}: ${err?.message || err}`);
    }
    await new Promise((r) => setTimeout(r, 200));

    const detailContent = detailHtml ? extractStGallenDetailContent(detailHtml) : '';
    const { pensum, arbeitsort } = detailHtml ? extractLocationText(detailHtml) : { pensum: '', arbeitsort: '' };
    if (detailContent) detailHits++;

    const location = arbeitsort || HQ_CITY;

    let description;
    if (detailContent && detailContent.length >= 60) {
      const bullets = [];
      if (pensum) bullets.push(`• Pensum: ${pensum}`);
      bullets.push(`• Standort: ${location}`);
      bullets.push(`• Bewerbung über das offizielle Stellenportal des Kantons St. Gallen (${PUBLIC_CAREER_URL})`);
      description = [detailContent, bullets.join('\n')].join('\n\n');
    } else {
      // Fallback structured synthesis when the detail page didn't yield
      // parseable content (network hiccup, layout drift on a given tenant
      // page). Always comfortably above the 50-word thin-content floor.
      const intro = `${title} — offene Stelle beim Kanton St. Gallen, direkt auf dem offiziellen Stellenportal der Kantonalen Verwaltung ausgeschrieben.`;
      const blurb = `Der Kanton St. Gallen zählt mit rund 530'000 Einwohnerinnen und Einwohnern zu den bevölkerungsreichsten Kantonen der Schweiz und beschäftigt als fünftgrösster Kanton rund 6000 Mitarbeitende in der kantonalen Verwaltung. Die Aufgaben reichen über Bildung, Wirtschaft, Recht, Sicherheit, Natur, Gesundheit, Bau, Kultur und Finanzen — mit vielfältigen, sinnstiftenden Karrieremöglichkeiten in unterschiedlichen Fachbereichen.`;
      const bullets = [
        `• Arbeitgeber: ${KANTON_ST_GALLEN_COMPANY_NAME}`,
        `• Standort: ${location} (Kanton ${HQ_CANTON})`,
      ];
      if (pensum) bullets.push(`• Pensum: ${pensum}`);
      if (datum) bullets.push(`• Online seit: ${datum}`);
      bullets.push(`• Bewerbung über das offizielle Stellenportal des Kantons St. Gallen (${PUBLIC_CAREER_URL})`);
      description = [intro, blurb, bullets.join('\n')].join('\n\n');
    }

    const postedDate = parseSwissDate(datum) || todayIso;
    const sourceLang = 'de';
    const jobSlug = slugify(`${title} kanton-st-gallen ch`);
    const urlHash = createHash('sha1').update(`kanton-st-gallen-vacancy-${vacancyId}`).digest('hex').slice(0, 12);

    const job = {
      id: `${KANTON_ST_GALLEN_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: KANTON_ST_GALLEN_COMPANY_NAME,
      companyKey: KANTON_ST_GALLEN_KEY,
      companyDomain: KANTON_ST_GALLEN_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't (cache miss + AI quota), the flag stays and
      // `translate-pending.yml` picks the job up out-of-band.
      needsRetranslation: true,
      location,
      canton: HQ_CANTON,
      url: detailUrl,
      source: `${KANTON_ST_GALLEN_COMPANY_NAME} Dedicated Parser (Umantis tenant ${UMANTIS_TENANT})`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: location,
      addressRegion: HQ_CANTON,
      streetAddress: HQ_STREET,
      postalCode: HQ_POSTAL_CODE,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(pensum, title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Amministrazione Pubblica',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`📋 Total ${KANTON_ST_GALLEN_COMPANY_NAME} jobs discovered: ${jobs.length} (${detailHits}/${allEntries.length} with rich detail content)`);
  return jobs;
}
