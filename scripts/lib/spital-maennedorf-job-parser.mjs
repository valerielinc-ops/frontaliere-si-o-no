#!/usr/bin/env node
/**
 * Spital Männedorf job parser — Umantis ATS (tenant 2736).
 *
 * Listing page: https://recruitingapp-2736.umantis.com/Jobs/All?lang=ger
 *   - Same Umantis 2023 server-rendered HTML layout used by Inselspital
 *     (tenant 2624). `<tr class="table-as-list__contentrow1|2">` rows
 *     with `tableaslist_element_*` children. Element IDs are stable
 *     across tenants:
 *       1152488: title + link (`<h3><a href="/Vacancies/{id}/Description/1">`)
 *       1184115: snippet
 *       1184128: department
 *       1184117: Art (Vollzeit / Teilzeit)
 *       1184118: Befristung (befristet / unbefristet)
 *       1184120: Organisationseinheit
 *   - Pagination via `?tc1152481=pN&_search_token1152481=TOKEN` —
 *     surfaced in `data-pagination-next-href` on the bottom paging widget.
 *
 * Detail page: /Vacancies/{ID}/Description/1 returns the careercenter SPA
 * shell — real description hydrates client-side. We use the listing title
 * and snippet as source of truth (same pattern as Inselspital tenant 2624).
 *
 * Public iframe wrapper: https://karriere.spitalmaennedorf.ch/stellenboerse/
 *
 * Spital Männedorf HQ: Asylstrasse 10, 8708 Männedorf, ZH.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSpitalMaennedorfJobs() — Fetch and parse all jobs across pages
 *   - isSpitalMaennedorfJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()              — Validate URLs belong to Umantis tenant
 *   - SPITAL_MAENNEDORF_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createHash } from 'node:crypto';
import { slugify, stripHtml, normalizeSpace } from './crawler-template.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SPITAL_MAENNEDORF_KEY = 'spital-maennedorf';
export const SPITAL_MAENNEDORF_COMPANY_NAME = 'Spital Männedorf';
export const SPITAL_MAENNEDORF_COMPANY_DOMAIN = 'spitalmaennedorf.ch';

const UMANTIS_TENANT = '2736';
const BASE_URL = `https://recruitingapp-${UMANTIS_TENANT}.umantis.com`;
const LISTING_URL = `${BASE_URL}/Jobs/All?lang=ger`;
const PUBLIC_CAREER_URL = 'https://karriere.spitalmaennedorf.ch/stellenboerse/';

const MAX_PAGES = 20;

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function decodeEntities(html = '') {
  return html
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&uuml;/g, 'ü')
    .replace(/&ouml;/g, 'ö')
    .replace(/&auml;/g, 'ä')
    .replace(/&Uuml;/g, 'Ü')
    .replace(/&Ouml;/g, 'Ö')
    .replace(/&Auml;/g, 'Ä')
    .replace(/&eacute;/g, 'é')
    .replace(/&egrave;/g, 'è')
    .replace(/&szlig;/g, 'ß')
    .replace(/&#8209;/g, '-')
    .replace(/&#x2011;/g, '-')
    .replace(/&ndash;/g, '–')
    .replace(/&#8211;/g, '–')
    .replace(/&mdash;/g, '—');
}

/* ── Company Matchers ──────────────────────────────────────── */

export function isSpitalMaennedorfJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SPITAL_MAENNEDORF_KEY ||
    key.startsWith('spital-maennedorf') ||
    key.startsWith('spital-mannedorf') ||
    company.includes('spital männedorf') ||
    company.includes('spital mannedorf') ||
    company.includes('spital maennedorf') ||
    url.includes('spitalmaennedorf.ch') ||
    url.includes(`recruitingapp-${UMANTIS_TENANT}.umantis.com`)
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'spitalmaennedorf.ch' ||
      host.endsWith('.spitalmaennedorf.ch') ||
      host === `recruitingapp-${UMANTIS_TENANT}.umantis.com` ||
      host.endsWith('.umantis.com')
    );
  } catch {
    return false;
  }
}

/* ── Category / experience / employment heuristics ─────────── */

function detectCategory(title = '', department = '') {
  const t = normalize(title);
  const d = normalize(department);
  const signal = `${t} ${d}`;

  if (/\b(pflege|pflegefach|stationsleitung|pflegehelfer|fage|fachperson gesundheit|spitex|hebamme|nachtwache)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(arzt|ärztin|oberarzt|chefarzt|leitend|medizin|chirurg|anästhes|notfall|onkolog|kardiolog|neurolog)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(ops|operation|lagerung)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(labor|laborant|biomedizin|analyse)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(apothek|pharma)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(radiolog|röntgen|mtra|mrt)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(physiother|ergo|logopäd|rehabilit)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(praxisassistent|mpa)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(techni|haustechni|facility|wartung|maintenance)/.test(signal)) return 'Tecnica';
  if (/\b(it|software|develop|programm|system|informatik)/.test(signal)) return 'IT';
  if (/\b(admin|segret|buchhalt|sachbearbeiter|account|finanz|controll)/.test(signal)) return 'Amministrazione';
  if (/\b(hr|human|personal|talent|recruit)/.test(signal)) return 'Risorse Umane';
  if (/\b(küche|koch|gastro|hauswirtschaft|reinigung|hotellerie|haus.?dienst)/.test(signal)) return 'Ospitalità';
  if (/\b(logist|magazz|lager|einkauf|transport)/.test(signal)) return 'Logistica';
  if (/\b(market|kommunik)/.test(signal)) return 'Marketing';
  if (/\b(lernend|praktik|ausbildung|apprenti|doktorand)/.test(signal)) return 'Formazione';
  return 'Sanità / Ospedali';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|doktorand|phd)/.test(t)) return 'intern';
  if (/\b(junior|jr|assistent)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter|leitend|stationsleitung|oberarzt|chefarzt|executive)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(artText = '', title = '') {
  const t = normalize(artText || title);
  if (/teilzeit/.test(t)) return 'PART_TIME';
  if (/vollzeit/.test(t)) return 'FULL_TIME';
  const pctMatch = normalize(title).match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || normalize(title).match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2], 10) : parseInt(pctMatch[1], 10);
    return maxPct < 80 ? 'PART_TIME' : 'FULL_TIME';
  }
  return 'OTHER';
}

function extractPensum(title = '') {
  const rangeMatch = title.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/);
  if (rangeMatch) {
    return { min: parseInt(rangeMatch[1], 10), max: parseInt(rangeMatch[2], 10) };
  }
  const singleMatch = title.match(/(\d{2,3})\s*%/);
  if (singleMatch) {
    const val = parseInt(singleMatch[1], 10);
    return { min: val, max: val };
  }
  return null;
}

/* ── Listing Page Parser (Umantis 2023 layout) ─────────────── */

export function extractPagingToken(html = '') {
  const m = html.match(
    /data-pagination-next-href="\?tc1152481=p\d+&amp;_search_token1152481=(\d+)/
  );
  if (!m) return null;
  return { searchToken: m[1] };
}

export function parseSpitalMaennedorfListingPage(html = '') {
  const results = [];
  const seen = new Set();

  const rowRegex = /<tr\s+class="table-as-list__contentrow[12]"[^>]*>([\s\S]*?)<\/tr>/g;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];

    const titleMatch = rowHtml.match(
      /tableaslist_element_1152488[\s\S]*?<a\s[^>]*href="\/Vacancies\/(\d+)\/Description\/\d+"[^>]*>([^<]+)<\/a>/
    );
    if (!titleMatch) continue;

    const vacancyId = titleMatch[1];
    if (seen.has(vacancyId)) continue;
    seen.add(vacancyId);

    const title = normalizeSpace(decodeEntities(titleMatch[2]));
    if (!title || title.length < 3) continue;

    if (/^(initiativbewerbung|spontanbewerbung|blindbewerbung)$/i.test(title.trim())) continue;

    const snippet = extractElementText(rowHtml, '1184115');
    const department = extractColumnValue(rowHtml, '1184128') || extractColumnValue(rowHtml, '1184120');
    const artText = extractColumnValue(rowHtml, '1184117');
    const befristung = extractColumnValue(rowHtml, '1184118');

    results.push({
      vacancyId,
      title,
      snippet: normalizeSpace(snippet),
      artText: normalizeSpace(artText),
      befristung: normalizeSpace(befristung),
      department: normalizeSpace(department),
      detailUrl: `${BASE_URL}/Vacancies/${vacancyId}/Description/1`,
      applyUrl: `${BASE_URL}/Vacancies/${vacancyId}/Application/CheckLogin/1`,
    });
  }

  return results;
}

function extractElementText(rowHtml, elementId) {
  const regex = new RegExp(`tableaslist_element_${elementId}"[^>]*>([\\s\\S]*?)(?:<\\/p\\s*>|<\\/h3\\s*>|<\\/li\\s*>)`);
  const match = rowHtml.match(regex);
  if (!match) return '';
  return normalizeSpace(decodeEntities(stripHtml(match[1])));
}

function extractColumnValue(rowHtml, elementId) {
  const regex = new RegExp(`tableaslist_element_${elementId}"[\\s\\S]*?<span\\s+class="column-value"[^>]*>([^<]+)<\\/span>`);
  const match = rowHtml.match(regex);
  if (!match) return '';
  return normalizeSpace(decodeEntities(match[1]));
}

/* ── HTTP Fetch ───────────────────────────────────────────── */

async function fetchPage(url, cookieJar) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers = {
    Accept: 'text/html,application/xhtml+xml',
    'User-Agent': USER_AGENT,
    'Accept-Language': 'de-CH,de;q=0.9',
  };
  if (cookieJar?.value) headers.Cookie = cookieJar.value;

  try {
    const res = await fetch(url, { signal: controller.signal, headers, redirect: 'follow' });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    if (cookieJar) {
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        const pairs = setCookie.split(/,(?=\s*[A-Za-z0-9_-]+=)/g)
          .map((c) => c.split(';')[0].trim())
          .filter(Boolean);
        if (pairs.length) cookieJar.value = pairs.join('; ');
      }
    }
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/* ── Main Fetch Function ──────────────────────────────────── */

export async function fetchAllSpitalMaennedorfJobs() {
  console.log(`🏥 Fetching ${SPITAL_MAENNEDORF_COMPANY_NAME} jobs`);
  console.log(`   Source:        ${LISTING_URL}`);
  console.log(`   Public iframe: ${PUBLIC_CAREER_URL}\n`);

  const cookieJar = { value: '' };
  const allListings = [];
  const seenIds = new Set();

  const firstHtml = await fetchPage(LISTING_URL, cookieJar);
  const firstListings = parseSpitalMaennedorfListingPage(firstHtml);
  for (const l of firstListings) {
    if (!seenIds.has(l.vacancyId)) {
      seenIds.add(l.vacancyId);
      allListings.push(l);
    }
  }

  const paging = extractPagingToken(firstHtml);
  if (paging?.searchToken) {
    for (let pageNum = 2; pageNum <= MAX_PAGES; pageNum++) {
      const pageUrl = `${LISTING_URL}&tc1152481=p${pageNum}&_search_token1152481=${paging.searchToken}`;
      let pageHtml;
      try {
        pageHtml = await fetchPage(pageUrl, cookieJar);
      } catch (err) {
        console.warn(`  ⚠️ Page ${pageNum} fetch failed: ${err?.message}`);
        break;
      }
      const pageListings = parseSpitalMaennedorfListingPage(pageHtml);
      let added = 0;
      for (const l of pageListings) {
        if (!seenIds.has(l.vacancyId)) {
          seenIds.add(l.vacancyId);
          allListings.push(l);
          added++;
        }
      }
      if (added === 0) break;
      await new Promise((r) => setTimeout(r, 350));
    }
  }

  if (allListings.length === 0) {
    console.warn('⚠️ No job listings found on the page.');
    return [];
  }

  console.log(`  📋 Listings found: ${allListings.length}\n`);

  const jobs = [];
  for (const listing of allListings) {
    const title = listing.title;
    const location = 'Männedorf';
    const canton = 'ZH';

    const fallbackDesc = `${title} — ${SPITAL_MAENNEDORF_COMPANY_NAME}, ${location}`;
    const descriptionText = listing.snippet || fallbackDesc;

    const sourceLang = 'de';
    const jobSlug = slugify(`${title} ${SPITAL_MAENNEDORF_KEY} ch`);
    const urlHash = createHash('sha1')
      .update(`${SPITAL_MAENNEDORF_KEY}-vacancy-${listing.vacancyId}`)
      .digest('hex')
      .slice(0, 12);

    const pensum = extractPensum(title);
    const employmentType = detectEmploymentType(listing.artText, title);
    const contract = pensum && pensum.max < 80 ? 'part-time' : 'full-time';

    const job = {
      // ── Required fields ──
      id: `${SPITAL_MAENNEDORF_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SPITAL_MAENNEDORF_COMPANY_NAME,
      companyKey: SPITAL_MAENNEDORF_KEY,
      companyDomain: SPITAL_MAENNEDORF_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: listing.detailUrl,
      source: `${SPITAL_MAENNEDORF_COMPANY_NAME} Dedicated Parser (Umantis tenant ${UMANTIS_TENANT})`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      postalCode: '8708',
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, listing.department),
      contract,
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().split('T')[0],
      applyUrl: listing.applyUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    if (listing.department) {
      job.department = listing.department;
    }
    if (listing.befristung) {
      job.contractDuration = /befristet/i.test(listing.befristung) && !/unbefristet/i.test(listing.befristung)
        ? 'temporary'
        : 'permanent';
    }
    if (pensum) {
      job.pensumMin = pensum.min;
      job.pensumMax = pensum.max;
      job.pensum = pensum.min === pensum.max
        ? `${pensum.min}%`
        : `${pensum.min} - ${pensum.max}%`;
    }

    jobs.push(job);
  }

  console.log(`\n📋 Total ${SPITAL_MAENNEDORF_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
