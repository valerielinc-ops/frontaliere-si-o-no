#!/usr/bin/env node
/**
 * SRO AG (Spital Region Oberaargau) job parser.
 *
 * SRO operates Spital Langenthal (acute hospital) plus the Gesundheitszentren
 * Huttwil and Niederbipp, the PanoramaPark in Herzogenbuchsee and several
 * regional Hausarztpraxen — covering ~150k residents of the Oberaargau region
 * of canton Bern.
 *
 * Public career page (TYPO3 + custom `tx_srojobs` extension):
 *   https://www.sro.ch/sro/karriere/stellenangebote/
 *     → server-renders ~50 job tiles as `<article class="col-md-4">` elements,
 *       each pointing at a Prospective.ch detail page via fancybox iframe:
 *       <a href="https://ohws.prospective.ch/public/v1/jobs/{UUID}" …>
 *
 * Unlike most Prospective tenants, SRO does NOT expose its medium ID in either
 * the page HTML or the per-job detail response — they use the platform purely
 * as a job-detail/application backend behind their own TYPO3 listing. There is
 * therefore no `/medium/{ID}/jobs` shortcut; we crawl the SRO listing HTML for
 * UUIDs + tile metadata, then fetch each `ohws.prospective.ch/public/v1/jobs/{UUID}`
 * detail page for JSON-LD enrichment (title, datePosted, validThrough,
 * employmentType, jobLocation address, description).
 *
 * The JSON-LD block is the canonical source of truth on every Prospective
 * detail page (`<script type="application/ld+json">`) and ships fully
 * populated even when no medium-level API is exposed.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSroJobs()
 *   - isSroJob()
 *   - isTrustedDomain()
 *   - SRO_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SRO_KEY = 'sro';
export const SRO_COMPANY_NAME = 'SRO AG (Spital Region Oberaargau)';
export const SRO_COMPANY_DOMAIN = 'sro.ch';

const LISTING_URL = 'https://www.sro.ch/sro/karriere/stellenangebote/';
const PROSPECTIVE_JOB_PREFIX = 'https://ohws.prospective.ch/public/v1/jobs/';
const SPONTANEOUS_APPLY_URL = 'https://www.sro.ch/sro/karriere/spontanbewerbung/';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  uuml: 'ü', ouml: 'ö', auml: 'ä', Uuml: 'Ü', Ouml: 'Ö', Auml: 'Ä',
  szlig: 'ß', eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  agrave: 'à', acirc: 'â', icirc: 'î', iuml: 'ï', oacute: 'ó', ocirc: 'ô',
  ucirc: 'û', ccedil: 'ç', ndash: '–', mdash: '—', rsquo: '’',
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

export function isSroJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SRO_KEY ||
    key.startsWith('sro-') ||
    company.includes('sro ag') ||
    company.includes('spital region oberaargau') ||
    company.includes('spital langenthal') ||
    url.includes('sro.ch') ||
    (url.includes('ohws.prospective.ch/public/v1/jobs/') && url.includes('sro'))
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'sro.ch' || host.endsWith('.sro.ch')) return true;
    if (host === 'ohws.prospective.ch') return true;
    if (host === 'pms.imgix.net') return true; // logo CDN used in JSON-LD
    return false;
  } catch {
    return false;
  }
}

/* ── Category / experience heuristics ─────────────────────── */

function detectCategory(title = '', industry = '') {
  const signal = normalize(`${title} ${industry}`);
  if (/\b(pflege|pflegefach|stationsleitung|fage|fachperson gesundheit|spitex|hebamme|nachtwache|geburts|ags|pflegeassistent)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(arzt|ärztin|oberarzt|oberärztin|chefarzt|leitend|medizin|chirurg|anästhes|notfall|onkolog|kardiolog|neurolog|pädiatr|gynäk|urolog|psychiatr|geriatr)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(ops|operation|lagerung|operationstechni)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(labor|laborant|biomedizin|analyse|radiolog|röntgen|mtra|mrt|physiother|ergo|logopäd|rehabilit|apothek|pharma|aktivierung|ernährung|diaetet)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(praxisassistent|mpa|mfa|arztsekret)/.test(signal)) return 'Amministrazione';
  if (/\b(techni|haustechni|facility|wartung|maintenance|elektro|gebäude)/.test(signal)) return 'Tecnica';
  if (/\b(it|software|develop|programm|system|informatik|applikation)/.test(signal)) return 'IT';
  if (/\b(admin|sekret|buchhalt|sachbearbeiter|account|finanz|controll|kreditor|debitor)/.test(signal)) return 'Amministrazione';
  if (/\b(hr|human|personal|talent|recruit)/.test(signal)) return 'Risorse Umane';
  if (/\b(küche|koch|gastro|hauswirtschaft|reinigung|hotellerie|haus.?dienst|servicemitarbeit|raumpfleg)/.test(signal)) return 'Ospitalità';
  if (/\b(logist|magazz|lager|einkauf|transport)/.test(signal)) return 'Logistica';
  if (/\b(market|kommunik|comunicaz)/.test(signal)) return 'Marketing';
  if (/\b(lernend|praktik|ausbildung|apprenti|werkstudent|ausbildungsplatz|studierende)/.test(signal)) return 'Formazione';
  return 'Sanità / Ospedali';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|intern|apprendist|lehrling|lernend|apprenti|werkstudent|ausbildungsplatz|studierende)/.test(t)) return 'intern';
  if (/\b(junior|jr|assistent)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|leiter|leitend|stationsleitung|oberarzt|oberärztin|chefarzt)/.test(t)) return 'senior';
  return 'mid';
}

function pensumFromTitle(title = '') {
  const range = title.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/);
  if (range) return { min: parseInt(range[1], 10), max: parseInt(range[2], 10) };
  const single = title.match(/(\d{2,3})\s*%/);
  if (single) return { min: parseInt(single[1], 10), max: parseInt(single[1], 10) };
  return null;
}

/* ── HTTP ─────────────────────────────────────────────────── */

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

const UUID_RX = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * Parse the SRO TYPO3 stellenangebote page. Returns one entry per teaser tile
 * with: { uuid, listingTitle, listingLocation }. The Prospective detail page
 * is the source of truth for everything else (JSON-LD).
 */
export function parseSroListing(html = '') {
  const out = [];
  const seen = new Set();
  // Tile structure: <article class="col-md-4"> … <a … href="…/jobs/{UUID}"> … <h4>…</h4> <address …>…</address> …
  const tileRx = new RegExp(
    `<article\\s+class="col-md-4">[\\s\\S]*?href="${PROSPECTIVE_JOB_PREFIX.replace(/[/.]/g, '\\$&')}(${UUID_RX})"[\\s\\S]*?<h4>([\\s\\S]*?)<\\/h4>([\\s\\S]*?)<\\/article>`,
    'g',
  );
  let m;
  while ((m = tileRx.exec(html))) {
    const uuid = m[1];
    if (seen.has(uuid)) continue;
    seen.add(uuid);
    const listingTitle = normalizeSpace(decodeEntities(stripHtml(m[2])));
    const tailHtml = m[3];
    const addrMatch = tailHtml.match(/<address[^>]*>([\s\S]*?)<\/address>/);
    const listingLocation = addrMatch
      ? normalizeSpace(decodeEntities(stripHtml(addrMatch[1])))
      : '';
    if (!listingTitle || listingTitle.length < 3) continue;
    out.push({ uuid, listingTitle, listingLocation });
  }
  return out;
}

/**
 * Extract the JSON-LD JobPosting object embedded in a Prospective detail page.
 * Returns null when the page doesn't have one or the JSON fails to parse.
 */
export function extractProspectiveJsonLd(html = '') {
  const m = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1]);
    if (obj && (obj['@type'] === 'JobPosting' || obj['@type'] === 'http://schema.org/JobPosting')) {
      return obj;
    }
    return obj;
  } catch {
    return null;
  }
}

function ldToDescription(ld) {
  const parts = [];
  const clean = (raw) => normalizeSpace(decodeEntities(stripHtml(String(raw || ''))));
  if (ld?.description) parts.push(clean(ld.description));
  if (ld?.responsibilities) parts.push(`Aufgaben:\n${clean(ld.responsibilities)}`);
  if (ld?.qualifications) parts.push(`Anforderungen:\n${clean(ld.qualifications)}`);
  return parts.filter(Boolean).join('\n\n');
}

/* ── Main fetcher ─────────────────────────────────────────── */

export async function fetchAllSroJobs() {
  console.log(`🏥 Fetching ${SRO_COMPANY_NAME} jobs`);
  console.log(`   Listing:    ${LISTING_URL}`);
  console.log(`   Detail src: ${PROSPECTIVE_JOB_PREFIX}{UUID}\n`);

  const listingHtml = await fetchHtml(LISTING_URL);
  const tiles = parseSroListing(listingHtml);
  console.log(`  ✓ ${tiles.length} job tiles parsed from SRO listing`);
  if (!tiles.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  let detailHits = 0;

  for (const tile of tiles) {
    const detailUrl = `${PROSPECTIVE_JOB_PREFIX}${tile.uuid}`;
    let detailHtml = '';
    try {
      detailHtml = await fetchHtml(detailUrl);
    } catch (err) {
      console.warn(`  ⚠️ detail fetch failed for ${tile.uuid}: ${err?.message || err}`);
    }
    await new Promise((r) => setTimeout(r, 220));

    const ld = detailHtml ? extractProspectiveJsonLd(detailHtml) : null;
    if (ld) detailHits++;

    // Title source: JSON-LD wins, fall back to listing tile title.
    const titleRaw = (ld?.title && String(ld.title).trim()) || tile.listingTitle;
    const title = normalizeSpace(decodeEntities(titleRaw));
    if (!title || title.length < 3) continue;

    const address = ld?.jobLocation?.address || {};
    const locality = normalizeSpace(decodeEntities(String(address.addressLocality || '').trim()));
    // SRO listing prefixes location with "Spital " — strip the prefix for the
    // structured city field (so canton inference still works), but keep the
    // original tile location in a fallback when JSON-LD is missing.
    const fallbackLocation = tile.listingLocation.replace(/^Spital\s+/i, '').trim();
    const location = locality || fallbackLocation || 'Langenthal';

    const postalCode = normalizeSpace(String(address.postalCode || '').trim())
      || (/langenthal/i.test(location) ? '4900'
        : /huttwil/i.test(location) ? '4950'
        : /niederbipp/i.test(location) ? '4704'
        : /herzogenbuchsee/i.test(location) ? '3360'
        : /niederbipp/i.test(location) ? '4704'
        : '4900');

    const canton = inferSwissTargetCanton(location) || 'BE';

    const description = ldToDescription(ld) || `${title} — ${SRO_COMPANY_NAME}`;
    const sourceLang = detectLang(description, 'de');
    const jobSlug = slugify(`${title} ${SRO_KEY} ${location}`);
    const urlHash = createHash('sha1').update(detailUrl).digest('hex').slice(0, 12);

    const employmentTypeRaw = String(ld?.employmentType || '').toUpperCase();
    const employmentType = /PART/.test(employmentTypeRaw) ? 'PART_TIME'
      : /FULL/.test(employmentTypeRaw) ? 'FULL_TIME'
      : 'OTHER';

    const pensum = pensumFromTitle(title);
    const postedDate = (() => {
      const raw = ld?.datePosted || ld?.dateCreated || '';
      const d = new Date(String(raw || ''));
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
      return todayIso;
    })();
    const validThrough = ld?.validThrough || '';

    const job = {
      id: `${SRO_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SRO_COMPANY_NAME,
      companyKey: SRO_KEY,
      companyDomain: SRO_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location,
      canton,
      url: detailUrl,
      source: `${SRO_COMPANY_NAME} Dedicated Parser (TYPO3 listing + Prospective.ch detail JSON-LD)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: location,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode,
      category: detectCategory(title, ld?.industry || ''),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: detailUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    if (pensum) {
      job.pensumMin = pensum.min;
      job.pensumMax = pensum.max;
      job.pensum = pensum.min === pensum.max ? `${pensum.max}%` : `${pensum.min} - ${pensum.max}%`;
    }
    if (validThrough) job.validThrough = validThrough;
    if (ld?.industry) job.department = normalizeSpace(String(ld.industry));

    jobs.push(job);
  }

  console.log(`\n📋 Total ${SRO_COMPANY_NAME} jobs discovered: ${jobs.length} (${detailHits}/${tiles.length} enriched via JSON-LD)`);
  return jobs;
}
