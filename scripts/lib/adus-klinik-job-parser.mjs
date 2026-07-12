#!/usr/bin/env node
/**
 * ADUS Klinik Dielsdorf — Teamtailor ATS via public RSS feed.
 *
 * Source:
 *   - Career site: https://karriere.adus-klinik.ch/jobs
 *   - RSS feed:    https://karriere.adus-klinik.ch/jobs.rss
 *   - Detail:      https://karriere.adus-klinik.ch/jobs/{id}-{slug}
 *
 * The ADUS Klinik is a privately held Belegarztspital (consultant-physician
 * hospital) in Dielsdorf (ZH, 8157), part of the Epiona Gruppe since 2025.
 * Specialisation: elective orthopedic surgery (~2'000 ops/year). The
 * Teamtailor career site serves a clean RSS feed with full JobPosting
 * descriptions (HTML) plus `<tt:locations>` blocks carrying zip / city /
 * canton — no JS rendering needed.
 *
 * Re-discovery note (2026-05-20): batch-21 originally probed
 * `adus-medica.ch` (NXDOMAIN). The clinic actually lives at
 * `adus-klinik.ch` (legal entity Adus-Medica AG); career site at
 * `karriere.adus-klinik.ch`.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';

export const ADUS_KLINIK_KEY = 'adus-klinik';
export const ADUS_KLINIK_COMPANY_NAME = 'ADUS Klinik';
export const ADUS_KLINIK_COMPANY_DOMAIN = 'adus-klinik.ch';

const RSS_URL = 'https://karriere.adus-klinik.ch/jobs.rss';
const CAREER_URL = 'https://karriere.adus-klinik.ch/jobs';
const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

const DEFAULT_CITY = 'Dielsdorf';
const DEFAULT_CANTON = 'ZH';
const DEFAULT_POSTAL = '8157';

function normalize(s = '') {
  return String(s || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function decodeEntities(s = '') {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number.parseInt(n, 10)));
}

/* ── Company matchers ─────────────────────────────────────── */

export function isAdusKlinikJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === ADUS_KLINIK_KEY ||
    /^adus(-|$)/.test(key) ||
    /adus-medica/.test(key) ||
    company.includes('adus') ||
    url.includes('adus-klinik.ch') ||
    url.includes('karriere.adus-klinik.ch')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'adus-klinik.ch' || host.endsWith('.adus-klinik.ch')) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category / employment helpers ────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(pflege|fage|fa-?gesundheit|gesundheits|pfleger|krankenschwester|krankenpfleger|fachfrau|fachmann|efz|efa|anaesth|anästh)/.test(t)) return 'Sanità';
  if (/\b(arzt|aerztin|ärztin|medizin|physiotherap|ergotherap|psychotherap|facharzt)/.test(t)) return 'Sanità';
  if (/\b(therapeut|therapie|logoped)/.test(t)) return 'Sanità';
  if (/\b(verwalt|admin|sekretär|empfang|bookkeep|buchhalt|hr|personal)/.test(t)) return 'Amministrazione';
  if (/\b(it|edv|netzwerk|system|software)/.test(t)) return 'IT';
  if (/\b(techni|haustech|handwerk)/.test(t)) return 'Tecnica';
  if (/\b(lehrling|lernend|apprenti|praktik|intern)/.test(t)) return 'Formazione';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(lehrling|lernend|apprenti|praktik|intern|trainee|aushilfe)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|chef|leiter|leitend|head|director|responsab|expert)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  const pctMatch = t.match(/(\d{2,3})\s*[-–]\s*\d{2,3}\s*%/) || t.match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const pct = Number(pctMatch[1]);
    if (pct >= 90) return 'FULL_TIME';
    if (pct > 0) return 'PART_TIME';
  }
  if (/\b(part.?time|teilzeit)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit)/.test(t)) return 'FULL_TIME';
  if (/\b(praktik|intern|stage|lehrling|lernend)/.test(t)) return 'INTERN';
  if (/\b(stundenlohn|aushilfe|befristet)/.test(t)) return 'CONTRACTOR';
  return 'OTHER';
}

/* ── RSS parsing ──────────────────────────────────────────── */

function parseRssItems(xml = '') {
  const items = [];
  const itemRe = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const get = (tag) => {
      const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
      const mm = block.match(re);
      if (!mm) return '';
      let v = mm[1].trim();
      // strip CDATA
      const cdata = v.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
      if (cdata) v = cdata[1];
      return v;
    };
    const item = {
      title: decodeEntities(get('title')),
      description: decodeEntities(get('description')),
      link: decodeEntities(get('link')),
      pubDate: get('pubDate'),
      guid: get('guid'),
    };
    // tt:location nested block
    const locBlock = block.match(/<tt:locations>([\s\S]*?)<\/tt:locations>/i);
    if (locBlock) {
      const inner = locBlock[1];
      item.locationName = decodeEntities((inner.match(/<tt:name>([\s\S]*?)<\/tt:name>/i) || [])[1] || '').trim();
      item.locationCity = decodeEntities((inner.match(/<tt:city>([\s\S]*?)<\/tt:city>/i) || [])[1] || '').trim();
      item.locationZip = decodeEntities((inner.match(/<tt:zip>([\s\S]*?)<\/tt:zip>/i) || [])[1] || '').trim();
      item.locationCountry = decodeEntities((inner.match(/<tt:country>([\s\S]*?)<\/tt:country>/i) || [])[1] || '').trim();
      item.locationAddress = decodeEntities((inner.match(/<tt:address>([\s\S]*?)<\/tt:address>/i) || [])[1] || '').trim();
    }
    items.push(item);
  }
  return items;
}

async function fetchText(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml,application/xml,text/xml,*/*' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/* ── ParsedJob builder ────────────────────────────────────── */

function buildParsedJob(item) {
  const title = normalizeSpace(item.title || '');
  if (!title || title.length < 3) return null;

  const descText = stripHtml(item.description || '');
  const sourceLang = detectLang(descText || title, 'de');
  const city = item.locationCity || DEFAULT_CITY;
  const zip = (item.locationZip && /^\d{4}$/.test(item.locationZip)) ? item.locationZip : DEFAULT_POSTAL;
  const country = item.locationCountry && /switzerland|schweiz|suisse|svizzera/i.test(item.locationCountry) ? 'CH' : 'CH';

  // Country gate — skip non-CH listings
  if (item.locationCountry && country !== 'CH') return null;

  const publicUrl = item.link || '';
  if (!publicUrl) return null;
  const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
  const jobSlug = slugify(`${title} ${ADUS_KLINIK_KEY} ${city}`);

  const fallbackDesc =
    `${title} — Stelle bei der ADUS Klinik in ${city} (${DEFAULT_CANTON}), Schweiz. ` +
    'Die ADUS Klinik ist ein privatrechtlich geführtes Belegarztspital im Zürcher Unterland mit Schwerpunkt elektive Orthopädie (rund 2\'000 Eingriffe pro Jahr). Seit 2025 Teil der Epiona Gruppe.';
  const desc = descText.length >= 80 ? descText : fallbackDesc;

  const postedDate = (() => {
    if (!item.pubDate) return new Date().toISOString().slice(0, 10);
    const d = new Date(item.pubDate);
    if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
    return d.toISOString().slice(0, 10);
  })();

  return {
    id: `adus-klinik-${urlHash}`,
    slug: jobSlug,
    slugByLocale: { [sourceLang]: jobSlug },
    company: ADUS_KLINIK_COMPANY_NAME,
    companyKey: ADUS_KLINIK_KEY,
    companyDomain: ADUS_KLINIK_COMPANY_DOMAIN,
    title,
    titleByLocale: { [sourceLang]: title },
    description: desc,
    descriptionByLocale: { [sourceLang]: desc },
    location: city,
    canton: DEFAULT_CANTON,
    url: publicUrl,
    source: 'ADUS Klinik Dedicated Parser (Teamtailor RSS)',
    sourceLang,
    crawledAt: new Date().toISOString(),
    addressLocality: city,
    addressRegion: DEFAULT_CANTON,
    addressCountry: 'CH',
    country: 'CH',
    postalCode: zip,
    category: detectCategory(title),
    contract: detectEmploymentType(title) === 'PART_TIME' ? 'part-time' : 'full-time',
    employmentType: detectEmploymentType(title),
    experienceLevel: detectExperienceLevel(title),
    sector: 'Sanità',
    currency: 'CHF',
    featured: false,
    postedDate,
    applyUrl: publicUrl,
    requirements: [],
    requirementsByLocale: { [sourceLang]: [] },
    needsRetranslation: true,
  };
}

/* ── Main fetcher ─────────────────────────────────────────── */

export async function fetchAllAdusKlinikJobs() {
  console.log(`🔍 Fetching ADUS Klinik jobs (Teamtailor RSS)`);
  console.log(`   Source: ${CAREER_URL}`);
  console.log(`   Feed:   ${RSS_URL}\n`);

  let xml;
  try {
    xml = await fetchText(RSS_URL);
  } catch (err) {
    console.warn(`⚠️ ADUS Klinik RSS fetch failed: ${err?.message || err}`);
    return [];
  }
  const items = parseRssItems(xml);
  console.log(`   Parsed ${items.length} RSS items`);

  const jobs = [];
  for (const item of items) {
    try {
      const job = buildParsedJob(item);
      if (job) jobs.push(job);
    } catch (err) {
      console.warn(`⚠️ Skipping ${item.link || '<?>'}: ${err?.message || err}`);
    }
  }

  console.log(`\n📋 Total ADUS Klinik jobs discovered: ${jobs.length}`);
  return jobs;
}
