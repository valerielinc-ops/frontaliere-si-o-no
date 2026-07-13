#!/usr/bin/env node
/**
 * Belimo job parser — SAP SuccessFactors Career Site Builder (CSB).
 *
 * Source: https://jobsredirect.belimo.com/ (tenant `belimoauto`), crawled
 * sitemap-first like die Mobiliar (`mobiliar-job-parser.mjs`):
 *   1. GET /sitemap.xml            → every live job detail URL (+ lastmod)
 *   2. GET /job/{slug}/{reqId}/    → SSR detail page with full schema.org
 *      microdata (itemprop title/description/addressLocality/addressRegion/
 *      postalCode/addressCountry/datePosted) — the CH gate reads
 *      `addressCountry` off the page itself, never the URL slug.
 *
 * Belimo is a Swiss manufacturer of damper and valve actuators for HVAC /
 * building automation, headquartered in Hinwil ZH (Brunnenbachstrasse 1,
 * 8340 Hinwil).
 *
 * ISSUE #3892 RE-SOURCING (this crawler had NEVER produced a job):
 * The previous revision scraped a bespoke `.joblist__item` widget on
 * www.belimo.com/{site}/{locale}/job-listing. That widget is dead for every
 * visitor, not just for crawlers: its XHR endpoint (`data-url="/{site}/
 * {locale}/jobs"`) 301s to /{site}/{locale}/about/careers/jobs, which 302s to
 * jobs.belimo.com/search, which 301s BACK to www.belimo.com/job-listing — a
 * circular chain that can never return job data, so the widget renders zero
 * rows even in a real headless browser (verified via a Jina Reader Chromium
 * render with `X-Wait-For-Selector: .joblist__item`: timeout, 0 items).
 * The other candidate sources verified dead/empty on 2026-07-11:
 *   - jobs.belimo.com (old CSB vanity host): 301s every path — /search/,
 *     /sitemap.xml, /job/… — to the broken www widget page.
 *   - ohws.prospective.ch careercenter 1003051 (embedded on
 *     /ch/de_CH/about/careers/jobs/emea): live but SSRs 0 vacancies, and
 *     public/v1/medium/1003051/jobs returns `{"total":0,"jobs":[]}`.
 * The REAL live board was found by walking a jobs.ch Belimo ad (13 active
 * Hinwil postings) to its apply chain: jobs.ch → belimo-automation-ag.
 * contactrh.com → **jobsredirect.belimo.com** — a fully server-rendered SF
 * CSB with ~99 sitemap'd jobs (~38 Swiss), reachable from datacenter egress
 * (no Akamai block, unlike www.belimo.com which 403s plain curl; fetchHtml's
 * Jina rescue still backstops any future WAF drift).
 *
 * The shared `ats-clients/successfactors-client.mjs` html-jobreq flavor is
 * host-allowlisted and doesn't know this host; rather than touching the
 * shared client, this parser follows the in-tree sitemap-driven CSB idiom
 * (Mobiliar) with plain `fetchHtml()`. Only the shared date normalizer
 * (`parseSuccessFactorsPostedDate`) is imported from the client.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllBelimoJobs()   — Fetch and parse all Swiss jobs
 *   - isBelimoJob()          — Match jobs belonging to this company
 *   - isTrustedDomain()      — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { parseSuccessFactorsPostedDate } from './ats-clients/successfactors-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const BELIMO_KEY = 'belimo';
export const BELIMO_COMPANY_NAME = 'Belimo';
export const BELIMO_COMPANY_DOMAIN = 'belimo.com';

const CAREER_URL = 'https://jobsredirect.belimo.com/search/';
const SITEMAP_URL = 'https://jobsredirect.belimo.com/sitemap.xml';
const JOB_BASE = 'https://jobsredirect.belimo.com';

// ── Detail-page fetch budget ──
// Sitemap lists every worldwide posting (~99 live, ~38 Swiss). The 4-digit
// postal prefilter (below) drops the US/DE bulk before any detail fetch, so
// a run costs ~40 × (fetch + delay). The cap is a safety valve against a
// listing-count explosion, NOT a routine limiter: when it trips, skipped
// URLs are counted and reported loudly in the run log.
export const DETAIL_FETCH_DELAY_MS = 400;
export const MAX_DETAIL_FETCHES = (() => {
  const raw = Number(process.env.BELIMO_MAX_DETAIL_FETCHES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 300;
})();

/* ── HQ fallback (Brunnenbachstrasse 1, 8340 Hinwil, ZH) ─────── */

const HQ = {
  city: 'Hinwil',
  canton: 'ZH',
  postalCode: '8340',
  streetAddress: 'Brunnenbachstrasse 1',
  region: 'Zürich',
};

const SECTOR = 'Industria / Automazione edifici';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Belimo.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isBelimoJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === BELIMO_KEY ||
    key.startsWith('belimo') ||
    company.includes('belimo') ||
    url.includes('belimo.com')
  );
}

/**
 * Validate that a URL belongs to Belimo's own domain (the CSB lives on the
 * jobsredirect.belimo.com subdomain).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'belimo.com' || host.endsWith('.belimo.com');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl|architect)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install|meccatron|mechatron|instandhalt)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur|montage|fertigung|assembly)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|working student)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * The CSB detail page carries no explicit employment-type field, so this is
 * title-driven: a Swiss "(NN%)" / "(NN-MM%)" workload suffix below 100%
 * means part-time; temp/intern keywords beat the FULL_TIME default.
 */
export function detectEmploymentType(title = '') {
  const pctMatch = String(title).match(/\((\d{1,3})\s*(?:-\s*(\d{1,3})\s*)?%\)/);
  if (pctMatch) {
    const nums = [pctMatch[1], pctMatch[2]].filter(Boolean).map(Number);
    if (nums.length && Math.max(...nums) < 100) return 'PART_TIME';
  }
  const t = normalize(title);
  // No \b before "aushilfe": German compounds it ("Ferienaushilfe").
  if (/tempor[aä]r|temporary|befristet|temporaneo|aushilfe/.test(t)) return 'TEMPORARY';
  if (/\b(praktik|intern\b|stage|working student|lernend|lehrling)/.test(t)) return 'INTERN';
  return 'FULL_TIME';
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Extract the SF requisition ID from a CSB job URL.
 * Pattern: /job/{slug}/{reqId}/
 */
export function extractJobReqId(url = '') {
  const match = String(url).match(/\/job\/[^/]+\/(\d+)\/?$/);
  return match ? match[1] : '';
}

/**
 * Cheap pre-filter on the sitemap URL slug, to avoid fetching ~60 non-Swiss
 * detail pages per run. CSB slugs end in "…-{Region}-{postal}/{reqId}/";
 * Swiss postal codes are 4 digits, US ZIP / German PLZ are 5. A slug WITHOUT
 * a recognizable postal tail stays a candidate — the authoritative gate is
 * the detail page's `addressCountry` microdata, never this heuristic.
 */
export function isSwissJobUrlCandidate(url = '') {
  let path = '';
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    return false;
  }
  const match = path.match(/\/job\/([^/]+)\/\d+\/?$/);
  if (!match) return false;
  const postal = match[1].match(/-(\d{4,6})$/);
  if (!postal) return true;
  return postal[1].length === 4;
}

/**
 * Fetch the CSB sitemap and return every job detail URL.
 */
async function fetchAllJobUrls() {
  console.log(`  📄 Fetching sitemap: ${SITEMAP_URL}`);
  const xml = await fetchHtml(SITEMAP_URL, {
    headers: { Accept: 'application/xml,text/xml,*/*' },
  });

  const allUrls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)]
    .map((m) => m[1].trim())
    .filter((url) => /\/job\/[^/]+\/\d+\/?$/.test(url))
    .map((url) => new URL(url, JOB_BASE).toString());

  console.log(`  📦 Total job URLs in sitemap: ${allUrls.length}`);
  return allUrls;
}

/**
 * Parse a CSB job detail page (schema.org microdata + jobdescription body).
 *
 * @param {string} html Raw detail-page HTML.
 * @returns {{title: string, city: string, region: string, postalCode: string,
 *            country: string, postedDate: string|null, descriptionHtml: string} | null}
 *   `null` when the page carries no job microdata (challenge page, redirect
 *   stub, "The desired job cannot be found" template, expired posting).
 */
export function parseBelimoDetailPage(html = '') {
  if (!html) return null;
  const grabMeta = (prop) => {
    const m = String(html).match(
      new RegExp(`itemprop="${prop}"[^>]*content="([^"]*)"`, 'i')
    );
    return m ? normalizeSpace(m[1]) : '';
  };

  const titleMatch = html.match(/<h1[^>]*itemprop="title"[^>]*>([\s\S]*?)<\/h1>/i);
  const title = titleMatch ? normalizeSpace(stripHtml(titleMatch[1])) : '';

  // Description: from the itemprop="description" container up to the bottom
  // apply-button block (the body nests unbalanced <div>s, so a non-greedy
  // closing-tag match would truncate or overshoot — same caveat as the
  // shared client's joqReqDescription slicing).
  let descriptionHtml = '';
  const anchor = html.search(/<[a-z]+[^>]*itemprop="description"[^>]*>/i);
  if (anchor !== -1) {
    const fromAnchor = html.slice(anchor);
    const bodyStart = fromAnchor.indexOf('>') + 1;
    const body = fromAnchor.slice(bodyStart);
    const end = body.search(/<div[^>]*class="[^"]*applylink|<script\b/i);
    descriptionHtml = (end !== -1 ? body.slice(0, end) : body.slice(0, 20000)).trim();
  }

  const city = grabMeta('addressLocality');
  const country = grabMeta('addressCountry');
  if (!title && !city && !country) return null;

  // SF CSB truncates region labels ("Züri" for Zürich) — expand the known one.
  let region = grabMeta('addressRegion');
  if (/^z[uü]ri$/i.test(region)) region = 'Zürich';

  return {
    title,
    city,
    region,
    postalCode: grabMeta('postalCode'),
    country: country.toUpperCase(),
    postedDate: parseSuccessFactorsPostedDate(grabMeta('datePosted')),
    descriptionHtml,
  };
}

/**
 * Pick the best city / postal code / street / region for a Belimo posting,
 * falling back to the documented HQ address (Hinwil ZH) only when the
 * resolved city TEXT matches Hinwil — never on canton equality (all Swiss
 * Belimo postings currently observed are in Hinwil, but this must not
 * silently paper over a future non-Hinwil ZH posting).
 */
function resolveAddress(rawLoc = {}) {
  const city = (rawLoc.city || '').trim();
  const postalCode = (rawLoc.postalCode || '').trim();
  const region = (rawLoc.region || '').trim();
  const isHq = !city || /hinwil/i.test(city);

  return {
    city: city || HQ.city,
    postalCode: postalCode || (isHq ? HQ.postalCode : ''),
    streetAddress: isHq ? HQ.streetAddress : '',
    region,
  };
}

/**
 * Fetch all Belimo jobs (Switzerland only).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllBelimoJobs() {
  console.log(`🔍 Fetching ${BELIMO_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_URL} (SuccessFactors CSB, sitemap-driven)\n`);

  const allUrls = await fetchAllJobUrls();
  if (!allUrls || allUrls.length === 0) {
    console.warn('⚠️ No job URLs found in sitemap.');
    return [];
  }

  const candidates = allUrls.filter(isSwissJobUrlCandidate);
  console.log(`  🇨🇭 Swiss candidates after postal prefilter: ${candidates.length} / ${allUrls.length}`);

  const jobs = [];
  const seen = new Set();
  let fetched = 0;
  let skippedByCap = 0;

  for (const jobUrl of candidates) {
    if (fetched >= MAX_DETAIL_FETCHES) {
      skippedByCap += 1;
      continue;
    }
    fetched += 1;

    let parsed;
    try {
      const html = await fetchHtml(jobUrl, {
        headers: { Accept: 'text/html,application/xhtml+xml' },
      });
      parsed = parseBelimoDetailPage(html);
    } catch (err) {
      console.warn(`  ⚠️ Skipping ${jobUrl} — fetch failed: ${err?.message || err}`);
      continue;
    }

    if (!parsed) {
      console.warn(`  ⚠️ Could not parse detail page: ${jobUrl}`);
      continue;
    }
    // Authoritative CH gate: the page's own microdata, not the URL slug.
    // Only reject an EXPLICIT non-CH country — an absent/empty value (page
    // template drift) falls back to CH like the other CH-only dedicated
    // parsers (emil-frey-job-parser.mjs, stadler-rail-job-parser.mjs), since
    // this job already passed the postal-based Swiss candidate prefilter.
    if (parsed.country && parsed.country !== 'CH') continue;

    const title = normalizeSpace(parsed.title || '');
    if (!title || title.length < 3) continue;

    const publicUrl = jobUrl;
    if (seen.has(publicUrl)) continue;
    seen.add(publicUrl);

    const { city, postalCode, streetAddress, region } = resolveAddress(parsed);
    const location = city;
    const canton = inferSwissTargetCanton(location) || inferSwissTargetCanton(region) || HQ.canton;

    const descriptionText = stripHtml(parsed.descriptionHtml || '');
    const description = descriptionText || `${title} presso ${BELIMO_COMPANY_NAME} a ${location}.`;
    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} belimo ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(title);
    const postedDate = parsed.postedDate || new Date().toISOString().split('T')[0];
    const jobReqId = extractJobReqId(jobUrl) || null;

    const job = {
      // ── Required fields ──
      id: `${BELIMO_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: BELIMO_COMPANY_NAME,
      companyKey: BELIMO_KEY,
      companyDomain: BELIMO_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'Belimo Dedicated Parser (SuccessFactors Career Site Builder)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city || location,
      addressRegion: region || canton,
      streetAddress,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      jobReqId,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    console.log(`  ✅ ${jobReqId || '—'} — ${title.substring(0, 60)}`);

    await new Promise((r) => setTimeout(r, DETAIL_FETCH_DELAY_MS));
  }

  if (skippedByCap > 0) {
    console.warn(
      `⚠️ MAX_DETAIL_FETCHES=${MAX_DETAIL_FETCHES} tripped — ${skippedByCap} candidate URLs were NOT fetched. ` +
        'Raise BELIMO_MAX_DETAIL_FETCHES if the listing count grew legitimately.'
    );
  }

  console.log(`\n📋 Total ${BELIMO_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
