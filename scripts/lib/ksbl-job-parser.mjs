#!/usr/bin/env node
/**
 * Kantonsspital Baselland (KSBL) job parser — TYPO3 + cs2jobs extension.
 *
 * Public career site: https://karriere.ksbl.ch/de/offene-stellen/jobs/
 *
 * Hospital group operating three Basel-Land sites with ~4'500 employees:
 *   - Bruderholzspital, Bruderholz
 *   - Kantonsspital Liestal
 *   - Spital Laufen
 *
 * Architecture: the corporate career site is built on TYPO3 with the
 * `cs2jobs` extension (developed by CS2 AG, Basel). Jobs are loaded via an
 * AJAX endpoint returning HTML fragments:
 *
 *   GET /de/offene-stellen/jobs/
 *     ?ceuid=1355
 *     &tx_cs2jobs_grid%5Baction%5D=ajaxGrid
 *     &tx_cs2jobs_grid%5Bcontroller%5D=Jobs
 *     &type=13378
 *     &cHash={static_hash}
 *     &page={N}
 *
 * Each page returns ~10 cards. Total ~70 jobs across ~7 pages.
 *
 * Card structure:
 *   <div class="col-12 col-sm-6 col-lg-4 mb-gap mt-gap">
 *     <a href="...detail/job/{slug}/{uuid}">...</a>
 *     <span class="optional-label">{CATEGORY}</span>  (e.g. "Pflege")
 *     <h3 class="card-title">{TITLE}</h3>
 *     <span class="lead font-weight-normal">{PERCENT}</span>  (e.g. "80%")
 *   </div>
 *
 * The Umantis tenant (`recruitingapp-2748.umantis.com`) only exposes
 * placeholder Initiativbewerbung entries — DO NOT scrape that endpoint.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

export const KSBL_KEY = 'ksbl';
export const KSBL_COMPANY_NAME = 'Kantonsspital Baselland (KSBL)';
export const KSBL_COMPANY_DOMAIN = 'ksbl.ch';

const AJAX_BASE = 'https://karriere.ksbl.ch/de/offene-stellen/jobs/'
  + '?ceuid=1355'
  + '&tx_cs2jobs_grid%5Baction%5D=ajaxGrid'
  + '&tx_cs2jobs_grid%5Bcontroller%5D=Jobs'
  + '&type=13378'
  + '&cHash=8c314d87aa74585635e15d4b06215f47';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

const MAX_PAGES = 20; // safety cap

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  uuml: 'ü', ouml: 'ö', auml: 'ä', Uuml: 'Ü', Ouml: 'Ö', Auml: 'Ä',
  szlig: 'ß', eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  agrave: 'à', acirc: 'â', icirc: 'î', oacute: 'ó', ocirc: 'ô', ucirc: 'û',
  ccedil: 'ç', rsquo: '’', ndash: '–', mdash: '—',
};

function decodeEntities(s = '') {
  return String(s || '')
    .replace(/&([a-zA-Z]+);/g, (m, n) => Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, n) ? NAMED_ENTITIES[n] : m)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function normalize(s = '') {
  return String(s || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

export function isKsblJob(job) {
  const key = normalize(job?.companyKey || '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');
  if (key === KSBL_KEY) return true;
  if (company.includes('ksbl') || company.includes('kantonsspital baselland')) return true;
  if (url.includes('karriere.ksbl.ch') || url.includes('ksbl.ch')) return true;
  return false;
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'ksbl.ch' || host.endsWith('.ksbl.ch');
  } catch {
    return false;
  }
}

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

/**
 * Parse one cs2jobs HTML page and return job entries.
 */
export function parseKsblPage(html) {
  const out = [];
  const cardRx = /<div class="col-12 col-sm-6 col-lg-4 mb-gap mt-gap">([\s\S]*?<h3 class="card-title">[\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g;
  const seen = new Set();
  let m;
  while ((m = cardRx.exec(html))) {
    const cardHtml = m[1];

    // Detail URL + uuid
    const linkMatch = cardHtml.match(/href="(https?:\/\/karriere\.ksbl\.ch\/de\/offene-stellen\/jobs\/detail\/job\/([a-z0-9-]+)\/([a-f0-9-]{36}))"/i);
    if (!linkMatch) continue;
    const detailUrl = linkMatch[1];
    const slug = linkMatch[2];
    const uuid = linkMatch[3];
    if (seen.has(uuid)) continue;
    seen.add(uuid);

    // Title
    const titleMatch = cardHtml.match(/<h3 class="card-title">([\s\S]*?)<\/h3>/);
    if (!titleMatch) continue;
    const title = normalizeSpace(decodeEntities(titleMatch[1].replace(/<[^>]+>/g, '')));
    if (!title || title.length < 3) continue;

    // Category (Pflege, Ärztliches Personal, Therapien, etc.)
    const catMatch = cardHtml.match(/<span class="optional-label">([\s\S]*?)<\/span>/);
    const category = catMatch ? normalizeSpace(decodeEntities(catMatch[1].replace(/<[^>]+>/g, ''))) : '';

    // Occupation percentage (e.g. "80%", "60-100%")
    const pctMatch = cardHtml.match(/<span class="lead font-weight-normal">([\s\S]*?)<\/span>/);
    const occupation = pctMatch ? normalizeSpace(pctMatch[1].replace(/<[^>]+>/g, '')) : '';

    out.push({ uuid, slug, detailUrl, title, category, occupation });
  }
  return out;
}

function detectEmploymentType(occ = '', title = '') {
  const t = `${occ} ${title}`.toLowerCase();
  const m = t.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || t.match(/(\d{2,3})\s*%/);
  if (m) {
    const maxPct = m[2] ? parseInt(m[2], 10) : parseInt(m[1], 10);
    return maxPct < 90 ? 'PART_TIME' : 'FULL_TIME';
  }
  if (/teilzeit/i.test(t)) return 'PART_TIME';
  if (/vollzeit/i.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

function detectCategoryNormalized(rawCat = '', title = '') {
  const c = normalize(rawCat);
  const t = normalize(title);
  const sig = `${c} ${t}`;
  if (/pfleg|berufsbildnerin|fage|pflegehelfer|nachtwache|stationsleitung|hebamme/.test(sig)) return 'Sanità / Ospedali';
  if (/ärztlich|arzt|ärztin|chefarzt|oberarzt|medizin/.test(sig)) return 'Sanità / Ospedali';
  if (/therap|physio|ergo|logopäd|rehabilit/.test(sig)) return 'Sanità / Ospedali';
  if (/labor|biomed|röntgen|radiolog|mtra|mrt|pharma|apothek/.test(sig)) return 'Sanità / Ospedali';
  if (/technisch|techni|haustech|facility|wartung/.test(sig)) return 'Tecnica';
  if (/it\b|informatik|software|develop|applikation|servicenow/.test(sig)) return 'IT';
  if (/admin|sekretar|sachbearbeit|buchhalt|finanz|controll/.test(sig)) return 'Amministrazione';
  if (/hr|human|personal|talent|recruit/.test(sig)) return 'Risorse Umane';
  if (/küche|koch|gastro|hauswirt|reinig|hotellerie/.test(sig)) return 'Ospitalità';
  if (/logist|magazz|lager|einkauf/.test(sig)) return 'Logistica';
  if (/marketing|kommunik/.test(sig)) return 'Marketing';
  if (/lernend|praktik|ausbildung|apprenti/.test(sig)) return 'Formazione';
  return 'Sanità / Ospedali';
}

function detectExperienceLevel(title = '', occupation = '') {
  const t = normalize(title);
  if (/praktik|stage|intern|lehrling|lernend/.test(t)) return 'intern';
  if (/junior|jr|assistent/.test(t)) return 'junior';
  if (/senior|sr|lead|head|chef|leiter|leitend|stationsleitung|oberarzt|chefarzt|berufsbildner|verantwort/.test(t)) return 'senior';
  return 'mid';
}

export async function fetchAllKsblJobs() {
  console.log(`🏥 Fetching ${KSBL_COMPANY_NAME} jobs`);
  console.log(`   Source: karriere.ksbl.ch (TYPO3 cs2jobs)\n`);

  const collected = [];
  const seenUuids = new Set();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${AJAX_BASE}&page=${page}`;
    const html = await fetchHtml(url);
    const entries = parseKsblPage(html);
    const fresh = entries.filter((e) => !seenUuids.has(e.uuid));
    if (fresh.length === 0) {
      console.log(`  page ${page}: 0 new entries — stopping`);
      break;
    }
    for (const e of fresh) seenUuids.add(e.uuid);
    collected.push(...fresh);
    console.log(`  page ${page}: ${fresh.length} new entries (cumulative ${collected.length})`);
    if (entries.length < 10) {
      // last page typically has < 10
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log(`\n  ✓ ${collected.length} unique KSBL job cards across pages\n`);

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (const e of collected) {
    const title = e.title;
    const description = [
      e.category ? `Bereich: ${e.category}` : '',
      e.occupation ? `Beschäftigungsgrad: ${e.occupation}` : '',
      'KSBL — Standorte Bruderholz, Liestal, Laufen.',
    ].filter(Boolean).join('\n\n');

    const location = 'Liestal'; // Default — site is not in the listing card
    const canton = 'BL';
    const sourceLang = detectLang(description || title, 'de');
    const jobSlug = slugify(`${title} ${KSBL_KEY} ${location}`);
    const urlHash = createHash('sha1').update(e.detailUrl).digest('hex').slice(0, 12);

    jobs.push({
      id: `${KSBL_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: KSBL_COMPANY_NAME,
      companyKey: KSBL_KEY,
      companyDomain: KSBL_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: e.detailUrl,
      source: 'KSBL Dedicated Parser (TYPO3 cs2jobs)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: location,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '4410',
      category: detectCategoryNormalized(e.category, title),
      contract: 'full-time',
      employmentType: detectEmploymentType(e.occupation, title),
      experienceLevel: detectExperienceLevel(title, e.occupation),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: e.detailUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`📋 Total ${KSBL_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
