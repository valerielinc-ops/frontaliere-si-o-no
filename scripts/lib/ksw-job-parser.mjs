#!/usr/bin/env node
/**
 * Kantonsspital Winterthur (KSW) job parser — Solique ATS.
 *
 * The www.ksw.ch career page links out to:
 *   https://live.solique.ch/KSW/de/internet/#/
 * which serves a single SSR HTML page at https://live.solique.ch/ksw/
 * with all open vacancies as `<div class="job">` cards. No JSON API needed —
 * we parse the rendered HTML directly.
 *
 * Detail URL: live.solique.ch/ksw/job/details/{id} (target=_blank links).
 *
 * Solique is a Swiss niche ATS (also used by some KMUs / Spitex). Each `.job`
 * card carries `.jobtitle`, `.workload-from-num`, `.workload-to-num`,
 * `.occupation`, `.department`. There is no per-page paging on KSW (~60
 * vacancies fit on one page).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllKswJobs()  — Fetch and parse all jobs
 *   - isKswJob()         — Match jobs belonging to KSW
 *   - isTrustedDomain()  — Validate URLs belong to KSW / Solique tenant `ksw`
 *   - KSW_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createHash } from 'node:crypto';
import { slugify, stripHtml, normalizeSpace } from './crawler-template.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const KSW_KEY = 'ksw';
export const KSW_COMPANY_NAME = 'Kantonsspital Winterthur (KSW)';
export const KSW_COMPANY_DOMAIN = 'ksw.ch';

const SOLIQUE_TENANT = 'ksw';
const LISTING_URL = `https://live.solique.ch/${SOLIQUE_TENANT}/`;
const PUBLIC_CAREER_URL = 'https://www.ksw.ch/jobs-karriere/jobs/offene-stellen/';

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
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—');
}

/* ── Company Matchers ──────────────────────────────────────── */

export function isKswJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === KSW_KEY ||
    key.startsWith('kantonsspital-winterthur') ||
    company.includes('kantonsspital winterthur') ||
    company === 'ksw' ||
    url.includes('ksw.ch') ||
    url.includes(`solique.ch/${SOLIQUE_TENANT}/`) ||
    url.includes('solique.ch/KSW/')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();
    if (host === 'ksw.ch' || host.endsWith('.ksw.ch')) return true;
    if (host === 'live.solique.ch' && /^\/ksw(\/|$)/i.test(u.pathname)) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category / experience / employment heuristics ─────────── */

function detectCategory(title = '', occupation = '', department = '') {
  const signal = `${normalize(title)} ${normalize(occupation)} ${normalize(department)}`;
  if (/\b(pflege|pflegefach|stationsleitung|fage|fachperson gesundheit|spitex|hebamme)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(arzt|ärztin|oberarzt|chefarzt|leitend|medizin|chirurg|anästhes|notfall|onkolog|kardiolog|neurolog)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(ops|operation|lagerung)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(labor|laborant|biomedizin|analyse)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(apothek|pharma)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(radiolog|röntgen|mtra|mrt)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(physiother|ergo|logopäd|rehabilit)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(praxisassistent|mpa)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(techni|haustechni|facility|wartung|maintenance|elektr|install)/.test(signal)) return 'Tecnica';
  if (/\b(it|software|develop|programm|system|informatik)/.test(signal)) return 'IT';
  if (/\b(admin|segret|buchhalt|sachbearbeiter|account|finanz|controll)/.test(signal)) return 'Amministrazione';
  if (/\b(hr|human|personal|talent|recruit)/.test(signal)) return 'Risorse Umane';
  if (/\b(küche|koch|gastro|hauswirtschaft|reinigung|hotellerie)/.test(signal)) return 'Ospitalità';
  if (/\b(logist|magazz|lager|einkauf|transport)/.test(signal)) return 'Logistica';
  if (/\b(market|kommunik)/.test(signal)) return 'Marketing';
  if (/\b(lernend|praktik|ausbildung|apprenti|doktorand)/.test(signal)) return 'Formazione';
  return 'Sanità / Ospedali';
}

function detectExperienceLevel(title = '', occupation = '') {
  const t = `${normalize(title)} ${normalize(occupation)}`;
  if (/\b(praktik|stage|intern|apprendist|lehrling|lernend|doktorand|ausbildung|weiterbildung)/.test(t)) return 'intern';
  if (/\b(junior|jr|assistent)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|chef|verantwort|leiter|leitend|stationsleitung|oberarzt|chefarzt)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(workloadMin, workloadMax) {
  const max = Number(workloadMax || workloadMin || 0);
  if (max > 0 && max < 80) return 'PART_TIME';
  if (max >= 80) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Listing Page Parser ──────────────────────────────────── */

/**
 * Parse a Solique KSW listing page. Each card looks like:
 *   <div class="job">
 *     <a href="job/details/{id}" id="{id}" target="_blank">
 *       <div class="job-group">
 *         <div class="jobtitle">{title}</div>
 *         <span class="workload-group">
 *           <span class="min workload-from-num">{min}</span>
 *           <span class="range">-</span>
 *           <span class="max workload-to-num">{max}</span>
 *           <span class="percent">%</span>
 *         </span>
 *       </div>
 *       <div class="job-group">
 *         <div class="occupation">{occupation}</div>
 *         <div class="department">{department}</div>
 *       </div>
 *     </a>
 *   </div>
 */
export function parseKswListingPage(html = '') {
  const results = [];
  const seen = new Set();
  const cardRegex = /<div\s+class="job"\s*>([\s\S]*?)<\/a>\s*<\/div>/g;
  let cardMatch;
  while ((cardMatch = cardRegex.exec(html)) !== null) {
    const cardHtml = cardMatch[1];
    const idMatch = cardHtml.match(/href="job\/details\/(\d+)"/i);
    if (!idMatch) continue;
    const jobId = idMatch[1];
    if (seen.has(jobId)) continue;
    seen.add(jobId);

    const titleMatch = cardHtml.match(/<div\s+class="jobtitle"[^>]*>([^<]+)<\/div>/i);
    const title = titleMatch ? normalizeSpace(decodeEntities(titleMatch[1])) : '';
    if (!title || title.length < 3) continue;

    const minMatch = cardHtml.match(/class="[^"]*workload-from-num[^"]*"[^>]*>(\d+)</i);
    const maxMatch = cardHtml.match(/class="[^"]*workload-to-num[^"]*"[^>]*>(\d+)</i);
    const workloadMin = minMatch ? Number(minMatch[1]) : 0;
    const workloadMax = maxMatch ? Number(maxMatch[1]) : workloadMin;

    const occupationMatch = cardHtml.match(/<div\s+class="occupation"[^>]*>([^<]+)<\/div>/i);
    const departmentMatch = cardHtml.match(/<div\s+class="department"[^>]*>([^<]+)<\/div>/i);
    const occupation = occupationMatch ? normalizeSpace(decodeEntities(occupationMatch[1])) : '';
    const department = departmentMatch ? normalizeSpace(decodeEntities(departmentMatch[1])) : '';

    results.push({
      jobId,
      title,
      workloadMin,
      workloadMax,
      occupation,
      department,
      detailUrl: `${LISTING_URL}job/details/${jobId}`,
    });
  }
  return results;
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
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/* ── Main Fetch Function ──────────────────────────────────── */

export async function fetchAllKswJobs() {
  console.log(`🏥 Fetching ${KSW_COMPANY_NAME} jobs`);
  console.log(`   Source:        ${LISTING_URL}`);
  console.log(`   Public career: ${PUBLIC_CAREER_URL}\n`);

  let html;
  try {
    html = await fetchPage(LISTING_URL);
  } catch (err) {
    console.error(`❌ Failed to fetch Solique tenant page: ${err?.message}`);
    return [];
  }

  const listings = parseKswListingPage(html);
  if (listings.length === 0) {
    console.warn('⚠️ No job listings found on the page.');
    return [];
  }
  console.log(`  📋 Listings found: ${listings.length}\n`);

  const jobs = [];
  for (const listing of listings) {
    const title = listing.title;
    const location = 'Winterthur';
    const canton = 'ZH';

    const descBits = [];
    if (listing.occupation) descBits.push(`• Berufsfeld: ${listing.occupation}`);
    if (listing.department) descBits.push(`• Bereich: ${listing.department}`);
    if (listing.workloadMin || listing.workloadMax) {
      const pct = listing.workloadMin === listing.workloadMax
        ? `${listing.workloadMax}%`
        : `${listing.workloadMin}-${listing.workloadMax}%`;
      descBits.push(`• Pensum: ${pct}`);
    }
    const fallbackDesc = `${title} — ${KSW_COMPANY_NAME}, Winterthur`;
    const descriptionText = descBits.length ? `${fallbackDesc}\n\n${descBits.join('\n')}` : fallbackDesc;

    const sourceLang = 'de';
    const jobSlug = slugify(`${title} ksw ch`);
    const urlHash = createHash('sha1')
      .update(`ksw-vacancy-${listing.jobId}`)
      .digest('hex')
      .slice(0, 12);

    const employmentType = detectEmploymentType(listing.workloadMin, listing.workloadMax);
    const contract = listing.workloadMax > 0 && listing.workloadMax < 80 ? 'part-time' : 'full-time';

    const job = {
      id: `ksw-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: KSW_COMPANY_NAME,
      companyKey: KSW_KEY,
      companyDomain: KSW_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: listing.detailUrl,
      source: 'KSW Dedicated Parser (Solique tenant ksw)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: location,
      addressRegion: canton,
      postalCode: '8400',
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, listing.occupation, listing.department),
      contract,
      employmentType,
      experienceLevel: detectExperienceLevel(title, listing.occupation),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().split('T')[0],
      applyUrl: listing.detailUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    if (listing.department) job.department = listing.department;

    jobs.push(job);
  }

  console.log(`\n📋 Total ${KSW_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
