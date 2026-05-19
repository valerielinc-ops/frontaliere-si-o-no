#!/usr/bin/env node
/**
 * Spital Emmental job parser — Solique career-portal (live.solique.ch).
 *
 * Spital Emmental AG operates the Burgdorf and Langnau campuses plus a network
 * of regional outpatient clinics across the Emmental region (BE). Public career
 * site: https://www.spital-emmental.ch/jobs which redirects readers to the
 * Solique-hosted listing:
 *
 *   https://live.solique.ch/spital-emmental/   (server-rendered HTML, ~50 jobs)
 *   https://live.solique.ch/spital-emmental/job/details/{ID}  (detail page)
 *
 * Solique is a Swiss careers-portal SaaS (Solique AG, Bern) used by several
 * mid-size hospitals. The platform server-renders the entire job list in one
 * HTML payload — no pagination, no JSON API needed.
 *
 * LISTING TILE structure (one per `<div class="job">`):
 *   <div class="job">
 *     <a href="job/details/{ID}" id="{ID}" target="_blank">
 *       <div class="job-group">
 *         <div class="jobtitle">…title…</div>
 *         <span class="workload-group">
 *           <span class="min workload-from-num">60</span><span class="range">-</span>
 *           <span class="max workload-to-num">100</span><span class="percent">%</span>
 *         </span>
 *       </div>
 *       <div class="job-details">
 *         <div class="location">Burgdorf</div>
 *         <div class="area">Chirurgische Abteilung</div>
 *         <div class="employment">unbefristet</div>
 *       </div>
 *     </a>
 *   </div>
 *
 * DETAIL page (Solique) ships the rich description as plain HTML inside a
 * `.wrapper > .intro` + `.tasks-profile-wrapper` + `.info` block. We extract
 * intro + tasks + profile + info text to build a substantive description.
 *
 * The crawler is polite: it pulls one listing HTML + N detail HTMLs in series
 * with a small delay between requests. With ~50 active jobs and a 200 ms
 * pause the run completes in roughly 15 s.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSpitalEmmentalJobs()
 *   - isSpitalEmmentalJob()
 *   - isTrustedDomain()
 *   - SPITAL_EMMENTAL_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SPITAL_EMMENTAL_KEY = 'spital-emmental';
export const SPITAL_EMMENTAL_COMPANY_NAME = 'Spital Emmental';
export const SPITAL_EMMENTAL_COMPANY_DOMAIN = 'spital-emmental.ch';

const LISTING_URL = 'https://live.solique.ch/spital-emmental/';
const DETAIL_URL_PREFIX = 'https://live.solique.ch/spital-emmental/job/details/';
const PUBLIC_CAREER_URL = 'https://www.spital-emmental.ch/jobs';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  uuml: 'ü', ouml: 'ö', auml: 'ä', Uuml: 'Ü', Ouml: 'Ö', Auml: 'Ä',
  szlig: 'ß', eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  agrave: 'à', acirc: 'â', icirc: 'î', iuml: 'ï', oacute: 'ó', ocirc: 'ô',
  ucirc: 'û', ccedil: 'ç', ndash: '–', mdash: '—', rsquo: '’',
  laquo: '«', raquo: '»', hellip: '…',
};

function decodeEntities(s = '') {
  return String(s || '')
    .replace(/&([a-zA-Z]+);/g, (m, name) =>
      Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : m)
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company matchers ─────────────────────────────────────── */

export function isSpitalEmmentalJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SPITAL_EMMENTAL_KEY ||
    key.startsWith('spital-emmental') ||
    company.includes('spital emmental') ||
    url.includes('spital-emmental.ch') ||
    url.includes('live.solique.ch/spital-emmental')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'spital-emmental.ch' || host.endsWith('.spital-emmental.ch')) return true;
    if (host === 'live.solique.ch' && /\/spital-emmental(\/|$)/i.test(rawUrl)) return true;
    if (host === 'rse.abacuscity.ch') return true; // spontaneous application target
    return false;
  } catch {
    return false;
  }
}

/* ── Category / experience heuristics ─────────────────────── */

function detectCategory(title = '', area = '') {
  const signal = normalize(`${title} ${area}`);
  if (/\b(pflege|pflegefach|stationsleitung|fage|fachperson gesundheit|spitex|hebamme|nachtwache|geburts)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(arzt|ärztin|oberarzt|oberärztin|chefarzt|leitend|medizin|chirurg|anästhes|notfall|onkolog|kardiolog|neurolog|pädiatr|gynäk|psychiatr|geriatr|gerontopsy)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(ops|operation|lagerung)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(labor|laborant|biomedizin|analyse|radiolog|röntgen|mtra|mrt|physiother|ergo|logopäd|rehabilit|apothek|pharma|aktivierung)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(praxisassistent|mpa|mfa)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(applikationsmanager|techni|haustechni|facility|wartung|maintenance)/.test(signal)) return 'Tecnica';
  if (/\b(ict|it|software|develop|programm|system|informatik|applikation)/.test(signal)) return 'IT';
  if (/\b(admin|sekret|buchhalt|sachbearbeiter|account|finanz|controll|kreditor|debitor)/.test(signal)) return 'Amministrazione';
  if (/\b(hr|human|personal|talent|recruit)/.test(signal)) return 'Risorse Umane';
  if (/\b(küche|koch|gastro|hauswirtschaft|reinigung|hotellerie|haus.?dienst|servicemitarbeit)/.test(signal)) return 'Ospitalità';
  if (/\b(logist|magazz|lager|einkauf|transport)/.test(signal)) return 'Logistica';
  if (/\b(market|kommunik|comunicaz)/.test(signal)) return 'Marketing';
  if (/\b(lernend|praktik|ausbildung|apprenti|werkstudent|ausbildungsplatz)/.test(signal)) return 'Formazione';
  return 'Sanità / Ospedali';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|intern|apprendist|lehrling|lernend|apprenti|werkstudent|ausbildungsplatz)/.test(t)) return 'intern';
  if (/\b(junior|jr|assistent)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|leiter|leitend|stationsleitung|oberarzt|oberärztin|chefarzt)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(maxPct) {
  const n = Number(maxPct);
  if (!Number.isFinite(n) || n <= 0) return 'OTHER';
  return n < 90 ? 'PART_TIME' : 'FULL_TIME';
}

/* ── HTTP fetch ───────────────────────────────────────────── */

async function fetchHtml(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/* ── Listing parser ───────────────────────────────────────── */

/**
 * Parse the Solique listing page (`live.solique.ch/spital-emmental/`).
 * Returns an array of bare-bones job objects with the listing-level fields.
 */
export function parseEmmentalListing(html = '') {
  const out = [];
  const seen = new Set();
  // Each tile is wrapped in <div class="job">…<a href="job/details/{ID}">…</a></div>
  const tileRx = /<div\s+class="job">\s*<a\s+href="job\/details\/(\d+)"[^>]*>([\s\S]*?)<\/a>\s*<\/div>/g;
  let m;
  while ((m = tileRx.exec(html))) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const body = m[2];

    const titleMatch = body.match(/<div\s+class="jobtitle">([\s\S]*?)<\/div>/);
    const title = titleMatch ? normalizeSpace(decodeEntities(stripHtml(titleMatch[1]))) : '';
    if (!title || title.length < 3) continue;

    const minMatch = body.match(/<span\s+class="min[^"]*">\s*(\d{1,3})\s*<\/span>/);
    const maxMatch = body.match(/<span\s+class="max[^"]*">\s*(\d{1,3})\s*<\/span>/);
    const minPct = minMatch ? parseInt(minMatch[1], 10) : null;
    const maxPct = maxMatch ? parseInt(maxMatch[1], 10) : null;

    const locationMatch = body.match(/<div\s+class="location">([\s\S]*?)<\/div>/);
    const location = locationMatch ? normalizeSpace(decodeEntities(stripHtml(locationMatch[1]))) : '';

    const areaMatch = body.match(/<div\s+class="area">([\s\S]*?)<\/div>/);
    const area = areaMatch ? normalizeSpace(decodeEntities(stripHtml(areaMatch[1]))) : '';

    const employmentMatch = body.match(/<div\s+class="employment">([\s\S]*?)<\/div>/);
    const employment = employmentMatch ? normalizeSpace(decodeEntities(stripHtml(employmentMatch[1]))) : '';

    out.push({ id, title, minPct, maxPct, location, area, employment });
  }
  return out;
}

/**
 * Pull a clean description text from a Solique detail page. We concatenate the
 * `.intro` blocks (one or two paragraphs), the green-titled task/profile/info
 * sections, and any sibling bullet lists — keeping a `\n• item` bullet style
 * that survives downstream `stripHtml`/`normalizeSpace` calls.
 */
export function extractEmmentalDetailContent(html = '') {
  if (!html || typeof html !== 'string') return '';

  const sections = [];

  // 1. All .intro blocks — typically one institutional paragraph + one job-specific lead.
  //    Tolerate any closing pattern (`</div>` is enough; we capture until the next opening tag).
  const introRx = /<div\s+class="intro">([\s\S]*?)<\/div>/g;
  let im;
  while ((im = introRx.exec(html))) {
    let text = im[1]
      .replace(/<br\s*\/?>(?!\s*<)/gi, '\n')
      .replace(/<[^>]+>/g, ' ');
    text = normalizeSpace(decodeEntities(text));
    if (text && text.length > 25) sections.push(text);
  }

  // 2. Titled blocks (.title-green) followed by a sibling <ul class="list"> or a
  //    rich text <div>. The Solique template alternates several `.title-green`
  //    blocks in a row, each followed by its content (a <ul> or a <div>) — we
  //    grab each title's adjacent section by capturing everything up to the
  //    next `.title-green` open or the end of the source HTML.
  const titledRx = /<div\s+class="title-green">([\s\S]*?)<\/div>([\s\S]*?)(?=<div\s+class="title-green">|$)/g;
  let tm;
  while ((tm = titledRx.exec(html))) {
    const title = normalizeSpace(decodeEntities(stripHtml(tm[1])));
    if (!title) continue;
    // Convert <li>...</li> → \n• item, then strip the rest.
    let body = tm[2]
      .replace(/<li[^>]*>/gi, '\n• ')
      .replace(/<\/li\s*>/gi, '')
      .replace(/<br\s*\/?>(?!\s*<)/gi, '\n')
      .replace(/<[^>]+>/g, ' ');
    body = normalizeSpace(decodeEntities(body)).replace(/\s*•\s*/g, '\n• ');
    if (body && body.length > 5) sections.push(`${title}\n${body}`);
  }

  return sections.join('\n\n');
}

async function fetchDetailDescription(id) {
  try {
    const html = await fetchHtml(`${DETAIL_URL_PREFIX}${id}`);
    return extractEmmentalDetailContent(html);
  } catch {
    return '';
  }
}

/* ── Main fetcher ─────────────────────────────────────────── */

export async function fetchAllSpitalEmmentalJobs() {
  console.log(`🏥 Fetching ${SPITAL_EMMENTAL_COMPANY_NAME} jobs`);
  console.log(`   Source:        ${LISTING_URL}`);
  console.log(`   Public iframe: ${PUBLIC_CAREER_URL}\n`);

  const listingHtml = await fetchHtml(LISTING_URL);
  const listings = parseEmmentalListing(listingHtml);
  console.log(`  ✓ ${listings.length} jobs from Solique listing`);

  if (!listings.length) {
    console.warn('⚠️ No job tiles parsed from the Solique listing page.');
    return [];
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  let detailHits = 0;

  for (const listing of listings) {
    const { id, title, minPct, maxPct, location, area, employment } = listing;
    const detailUrl = `${DETAIL_URL_PREFIX}${id}`;

    const detailContent = await fetchDetailDescription(id);
    if (detailContent) detailHits++;
    // Polite pacing between detail fetches.
    await new Promise((r) => setTimeout(r, 200));

    const descParts = [];
    if (detailContent) descParts.push(detailContent);
    if (area) descParts.push(`Bereich: ${area}`);
    if (employment) descParts.push(`Anstellung: ${employment}`);
    if (Number.isFinite(maxPct)) {
      const pensumStr = Number.isFinite(minPct) && minPct !== maxPct
        ? `${minPct}-${maxPct}%`
        : `${maxPct}%`;
      descParts.push(`Pensum: ${pensumStr}`);
    }
    const description = descParts.length
      ? descParts.join('\n\n')
      : `${title} — ${SPITAL_EMMENTAL_COMPANY_NAME}`;

    // Spital Emmental ships listings with two-campus locations ("Burgdorf & Langnau").
    // We pick the first campus token for the structured city, but keep the original
    // string in `location` so the listing detail survives.
    const primaryCity = location.split(/[&,/]/)[0].trim() || 'Burgdorf';
    const canton = inferSwissTargetCanton(primaryCity) || 'BE';
    const postal = /langnau/i.test(primaryCity)
      ? '3550'
      : /huttwil/i.test(primaryCity) ? '4950'
      : /niederbipp/i.test(primaryCity) ? '4704'
      : '3400';

    const sourceLang = detectLang(description || title, 'de');
    const jobSlug = slugify(`${title} ${SPITAL_EMMENTAL_KEY} ${primaryCity}`);
    const urlHash = createHash('sha1').update(detailUrl).digest('hex').slice(0, 12);

    const contract = /befristet/i.test(employment) && !/unbefristet/i.test(employment)
      ? 'temporary'
      : 'full-time';

    const job = {
      id: `${SPITAL_EMMENTAL_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SPITAL_EMMENTAL_COMPANY_NAME,
      companyKey: SPITAL_EMMENTAL_KEY,
      companyDomain: SPITAL_EMMENTAL_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: location || primaryCity,
      canton,
      url: detailUrl,
      source: `${SPITAL_EMMENTAL_COMPANY_NAME} Dedicated Parser (Solique careers portal)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: primaryCity,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: postal,
      category: detectCategory(title, area),
      contract,
      employmentType: detectEmploymentType(maxPct),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: detailUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    if (area) job.department = area;
    if (Number.isFinite(minPct) || Number.isFinite(maxPct)) {
      const mn = Number.isFinite(minPct) ? minPct : maxPct;
      const mx = Number.isFinite(maxPct) ? maxPct : minPct;
      job.pensumMin = mn;
      job.pensumMax = mx;
      job.pensum = mn === mx ? `${mx}%` : `${mn} - ${mx}%`;
    }
    if (/befristet/i.test(employment) && !/unbefristet/i.test(employment)) {
      job.contractDuration = 'temporary';
    } else if (/unbefristet/i.test(employment)) {
      job.contractDuration = 'permanent';
    }

    jobs.push(job);
  }

  console.log(`\n📋 Total ${SPITAL_EMMENTAL_COMPANY_NAME} jobs discovered: ${jobs.length} (${detailHits}/${listings.length} with rich detail content)`);
  return jobs;
}
