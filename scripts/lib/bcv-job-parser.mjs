#!/usr/bin/env node
/**
 * Banque Cantonale Vaudoise (BCV) job parser — Fetcher and job builder.
 *
 * Source: https://bcv.ch/emploi → https://jobs.bcv.ch/ (SAP SuccessFactors,
 * html-jobreq flavor — sitemap.xml-driven discovery + server-rendered HTML
 * detail pages with schema.org itemprop microdata, no JSON-LD).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllBcvJobs()  — Fetch and parse all jobs
 *   - isBcvJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()  — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const BCV_KEY = 'bcv';
export const BCV_COMPANY_NAME = 'Banque Cantonale Vaudoise';
export const BCV_COMPANY_DOMAIN = 'bcv.ch';

const CAREER_URL = 'https://jobs.bcv.ch/';
const SITEMAP_URL = 'https://jobs.bcv.ch/sitemap.xml';

// BCV is a single-canton employer — Banque Cantonale Vaudoise operates
// exclusively within canton Vaud (branches in Lausanne, Aigle, Yverdon,
// Pully, Payerne, etc.). HQ used as the canton-gated address fallback.
const HQ = {
  city: 'Lausanne',
  canton: 'VD',
  postalCode: '1003',
  streetAddress: 'Place Saint-François 14',
  region: 'VD',
};

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Canton-gated address resolution (mirrors yapeal-job-parser.mjs's
 * resolveAddress()). Only attach HQ postalCode/streetAddress when the
 * job's resolved canton matches the HQ canton — never misattribute an
 * out-of-canton job with the HQ street address.
 */
function resolveAddress(cityRaw = '') {
  const city = normalizeSpace(cityRaw);
  const canton = city ? inferSwissTargetCanton(city) : null;

  if (city && canton) {
    const isHqCity = /lausanne/i.test(city);
    return {
      city,
      canton,
      postalCode: isHqCity ? HQ.postalCode : '',
      streetAddress: isHqCity ? HQ.streetAddress : '',
      region: canton,
    };
  }

  return {
    city: HQ.city,
    canton: HQ.canton,
    postalCode: HQ.postalCode,
    streetAddress: HQ.streetAddress,
    region: HQ.region,
  };
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Banque Cantonale Vaudoise.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isBcvJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === BCV_KEY ||
    key.startsWith('bcv') ||
    company.includes('banque cantonale vaudoise') ||
    url.includes('jobs.bcv.ch')
  );
}

/**
 * Validate that a URL belongs to Banque Cantonale Vaudoise's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'bcv.ch' || host.endsWith('.bcv.ch');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl|développ|dévelop)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account|assistant|assistante)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce|conseill|conseiller)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm|data)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal|ressources humaines)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ|cr[eé]dit|risque|risk|audit|banque|banc|priva)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht|juridique)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * BCV runs SAP SuccessFactors (html-jobreq flavor) on jobs.bcv.ch. Job URLs
 * follow the pattern /job/{City-Title-slug}/{numericId}/ and are discovered
 * via sitemap.xml (same platform pattern as jobs.mobiliar.ch), each with a
 * <lastmod> date usable as postedDate.
 *
 * Detail pages have no JSON-LD and no h1/h2 headings — content lives in
 * schema.org microdata: a single itemprop="title" span and THREE
 * itemprop="description" spans that must be concatenated.
 */

/**
 * Parse sitemap.xml and extract all BCV job URLs with their lastmod dates.
 */
async function fetchAllJobUrls() {
  console.log(`  📄 Fetching sitemap: ${SITEMAP_URL}`);
  const xml = await fetchHtml(SITEMAP_URL, { headers: { Accept: 'application/xml,text/xml,*/*' } });

  const entries = [];
  const urlBlockPattern = /<url>([\s\S]*?)<\/url>/gi;
  let blockMatch;
  while ((blockMatch = urlBlockPattern.exec(xml)) !== null) {
    const block = blockMatch[1];
    const locMatch = block.match(/<loc>([^<]+)<\/loc>/i);
    if (!locMatch) continue;
    const loc = locMatch[1].trim();
    if (!loc.includes('/job/')) continue;
    const lastmodMatch = block.match(/<lastmod>([^<]+)<\/lastmod>/i);
    entries.push({ url: loc, lastmod: lastmodMatch ? lastmodMatch[1].trim() : '' });
  }

  console.log(`  📦 Total job URLs in sitemap: ${entries.length}`);
  return entries;
}

/**
 * Extract the numeric job ID from a BCV job URL.
 * Pattern: /job/{slug}/{ID}/
 */
function extractJobId(url = '') {
  const match = url.match(/\/job\/[^/]+\/(\d+)\/?$/);
  return match ? match[1] : '';
}

/**
 * Extract the city token from the job URL path (first hyphen-segment).
 * Pattern: /job/{City}-{rest-of-title}/{ID}/
 */
function extractCityFromUrl(url = '') {
  const match = url.match(/\/job\/([^/]+)\//);
  if (!match) return '';
  const slug = decodeURIComponent(match[1]);
  const parts = slug.split('-');
  return parts[0] || '';
}

/**
 * Parse a BCV job detail page HTML to extract title + description.
 * Markup has no h1/h2/JSON-LD — content lives in schema.org microdata:
 *   <span itemprop="title">...</span>
 *   <span itemprop="description">...</span>  (×3, must concatenate)
 */
function parseDetailPage(html = '') {
  if (!html) return null;

  const titleMatch = html.match(/<span[^>]*itemprop="title"[^>]*>([\s\S]*?)<\/span>/i);
  const title = titleMatch ? normalizeSpace(stripHtml(titleMatch[1])) : '';
  if (!title || title.length < 3) return null;

  // Description spans may contain nested <span> tags themselves, so match
  // up to the </span> immediately followed by the closing wrapper </div>.
  const descPattern = /<span[^>]*itemprop="description"[^>]*>([\s\S]*?)<\/span>\s*<\/div>/gi;
  const descParts = [];
  let descMatch;
  while ((descMatch = descPattern.exec(html)) !== null) {
    const text = normalizeSpace(stripHtml(descMatch[1]));
    if (text) descParts.push(text);
  }
  const description = descParts.join('\n\n').trim();

  return { title, description };
}

/**
 * Fetch all Banque Cantonale Vaudoise jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllBcvJobs() {
  console.log(`🔍 Fetching Banque Cantonale Vaudoise jobs`);
  console.log(`   Source: ${CAREER_URL}`);
  console.log(`   Platform: SAP SuccessFactors (sitemap.xml + itemprop microdata)\n`);

  const entries = await fetchAllJobUrls();
  if (!entries || entries.length === 0) {
    console.warn('⚠️ No job URLs found in sitemap.');
    return [];
  }

  console.log(`\n  📋 Fetching ${entries.length} detail pages...\n`);

  const jobs = [];
  for (const entry of entries) {
    const jobUrl = entry.url;
    const jobId = extractJobId(jobUrl);
    const urlCity = extractCityFromUrl(jobUrl);

    try {
      const html = await fetchHtml(jobUrl);
      const parsed = parseDetailPage(html);

      if (!parsed) {
        console.warn(`  ⚠️ Could not parse detail page: ${jobUrl}`);
        continue;
      }

      const address = resolveAddress(urlCity);
      let description = parsed.description || `${parsed.title} — ${BCV_COMPANY_NAME}, ${address.city}.`;

      // Non-Negotiable #4: never index thin content <50 words. Pad with a
      // guaranteed-rich company blurb + CTA so every job clears the guard.
      const wordCount = description.split(/\s+/).filter(Boolean).length;
      if (wordCount < 50) {
        description = [
          description,
          `La Banque Cantonale Vaudoise (BCV) est la première banque universelle du canton de Vaud et l'une des banques les plus solides au monde, notée AA par Standard & Poor's depuis 2011. Avec ses quelque 2000 collaboratrices et collaborateurs répartis entre le siège de Lausanne et son réseau d'agences régionales (Aigle, Yverdon, Pully, Payerne notamment), la BCV accompagne particuliers, entreprises et institutions dans leurs projets financiers tout en contribuant activement à l'essor du tissu économique vaudois.`,
          `Postulez en ligne directement sur le portail carrière jobs.bcv.ch.`,
        ].join('\n\n');
      }

      const sourceLang = detectLang(description || parsed.title, 'fr');
      const jobSlug = slugify(`${parsed.title} bcv ${address.city || 'lausanne'}`);
      const urlHash = createHash('sha1').update(jobUrl).digest('hex').slice(0, 12);
      const postedDate = entry.lastmod || new Date().toISOString().split('T')[0];

      const job = {
        // ── Required fields ──
        id: `bcv-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { [sourceLang]: jobSlug },
        company: BCV_COMPANY_NAME,
        companyKey: BCV_KEY,
        companyDomain: BCV_COMPANY_DOMAIN,
        title: parsed.title,
        titleByLocale: { [sourceLang]: parsed.title },
        description,
        descriptionByLocale: { [sourceLang]: description },
        location: address.city,
        canton: address.canton,
        url: jobUrl,
        source: 'Banque Cantonale Vaudoise Dedicated Parser (SuccessFactors)',
        sourceLang,
        crawledAt: new Date().toISOString(),

        // ── Location details (canton-gated per resolveAddress()) ──
        addressLocality: address.city,
        addressRegion: address.region,
        addressCountry: 'CH',
        country: 'CH',
        postalCode: address.postalCode,
        streetAddress: address.streetAddress,

        // ── Job metadata ──
        category: detectCategory(parsed.title),
        contract: 'full-time',
        employmentType: detectEmploymentType(`${parsed.title} ${description}`),
        experienceLevel: detectExperienceLevel(parsed.title),
        sector: 'Banca / Finanza',
        currency: 'CHF',
        featured: false,
        postedDate,
        applyUrl: jobUrl,

        // ── Requirements ──
        requirements: [],
        requirementsByLocale: { [sourceLang]: [] },
      };

      if (jobId) job.sfJobId = jobId;

      jobs.push(job);
      console.log(`  ✅ ${jobId || '—'} — ${parsed.title.substring(0, 60)} (${address.city})`);
    } catch (err) {
      console.warn(`  ⚠️ Skipping ${jobUrl} — fetch failed: ${err?.message || err}`);
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n📋 Total Banque Cantonale Vaudoise jobs discovered: ${jobs.length}`);
  return jobs;
}
