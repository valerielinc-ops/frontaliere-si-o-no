#!/usr/bin/env node
/**
 * Banque Cantonale du Valais job parser — Fetcher and job builder.
 *
 * Source: https://www.bcvs.ch/la-bcvs/carriere/ressources-humaines/offres-demploi
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllBcvsJobs()  — Fetch and parse all jobs
 *   - isBcvsJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const BCVS_KEY = 'bcvs';
export const BCVS_COMPANY_NAME = 'Banque Cantonale du Valais';
export const BCVS_COMPANY_DOMAIN = 'bcvs.ch';

const CAREER_URL = 'https://www.bcvs.ch/la-bcvs/carriere/ressources-humaines/offres-demploi';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Banque Cantonale du Valais.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isBcvsJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === BCVS_KEY ||
    key.startsWith('bcvs') ||
    company.includes('banque cantonale du valais') ||
    url.includes('bcvs.ch')
  );
}

/**
 * Validate that a URL belongs to Banque Cantonale du Valais's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'bcvs.ch' || host.endsWith('.bcvs.ch');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur)/.test(t)) return 'Produzione';
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
 * BCVs uses a TYPO3-based CMS with server-rendered HTML.
 * The career listing page at /la-bcvs/carriere/ressources-humaines/offres-demploi
 * contains job cards as <a> links pointing to /job/{slug} detail pages.
 *
 * Each card has:
 *   - <h4> title
 *   - <li> location (e.g. "Valais Central", "Sion", "Visp")
 *   - <li> pensum (e.g. "80-100%")
 *
 * Detail pages contain the full description with structured sections
 * (mission, requirements, call to action).
 *
 * All jobs are in canton Valais (VS).
 */

const BCVS_BASE = 'https://www.bcvs.ch';

/**
 * Fetch HTML with timeout handling.
 */
async function fetchHtml(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Parse job listings from the BCVs careers listing page HTML.
 * Returns array of { title, location, pensum, url } objects.
 */
function parseListingPage(html) {
  const listings = [];
  if (!html) return listings;

  // Job cards are <a> tags linking to /job/ detail pages.
  // The <a> tag may have a title attribute before href:
  //   <a title="Job Title" href="/la-bcvs/carriere/.../job/{slug}">
  //     <div>...<h4>Title</h4><ul><li>Location</li><li>Pensum</li></ul>...</div>
  //   </a>
  const cardPattern = /<a\s+[^>]*href="(\/la-bcvs\/carriere\/[^"]*\/job\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = cardPattern.exec(html)) !== null) {
    const jobPath = match[1];
    const cardHtml = match[2];

    // Extract title from <h4>
    const titleMatch = cardHtml.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i);
    const title = titleMatch ? stripHtml(titleMatch[1]).trim() : '';
    if (!title || title.length < 3) continue;

    // Extract list items (location and pensum)
    const liItems = [];
    const liPattern = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let liMatch;
    while ((liMatch = liPattern.exec(cardHtml)) !== null) {
      liItems.push(stripHtml(liMatch[1]).trim());
    }

    // First <li> is usually the location, second is the pensum
    const location = liItems[0] || 'Sion';
    const pensum = liItems[1] || '';

    listings.push({
      title,
      location,
      pensum,
      url: `${BCVS_BASE}${jobPath}`,
    });
  }

  return listings;
}

/**
 * Fetch and parse a BCVs job detail page to extract description and requirements.
 */
async function fetchJobDetail(detailUrl) {
  try {
    const html = await fetchHtml(detailUrl);
    if (!html) return { description: '', requirements: [] };

    // The detail page has the main content after the job header.
    // Extract the main content area — text between the header separator and footer.
    // The content is inside the main generic div with paragraphs, headings, and lists.

    // Remove header/nav/footer noise
    let contentHtml = html;
    const mainMatch = html.match(/<hr[^>]*\/?>[\s\S]*?(<(?:p|h\d|ul|ol|div)[^>]*>[\s\S]*?)(?=<footer|<div[^>]*class="[^"]*footer)/i);
    if (mainMatch) {
      contentHtml = mainMatch[1];
    }

    // Try to extract structured sections
    const description = stripHtml(contentHtml).trim();

    // Extract requirements from list items after "profil" or "requis" heading
    const requirements = [];
    const reqSection = contentHtml.match(/(?:profil|requis|fait pour vous)[^<]*[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/i);
    if (reqSection) {
      const reqLiPattern = /<li[^>]*>([\s\S]*?)<\/li>/gi;
      let reqMatch;
      while ((reqMatch = reqLiPattern.exec(reqSection[1])) !== null) {
        const req = stripHtml(reqMatch[1]).trim();
        if (req.length > 3) requirements.push(req);
      }
    }

    return { description, requirements };
  } catch (err) {
    console.warn(`  ⚠️ Error fetching detail: ${err.message}`);
    return { description: '', requirements: [] };
  }
}

/**
 * Map common BCVs locations to specific Valais cities.
 */
function normalizeBcvsLocation(raw = '') {
  const lower = normalize(raw);
  if (lower.includes('sion') || lower.includes('sitten')) return 'Sion';
  if (lower.includes('visp') || lower.includes('viège')) return 'Visp';
  if (lower.includes('sierre') || lower.includes('siders')) return 'Sierre';
  if (lower.includes('martigny')) return 'Martigny';
  if (lower.includes('brig') || lower.includes('brigue')) return 'Brig';
  if (lower.includes('monthey')) return 'Monthey';
  if (lower.includes('zermatt')) return 'Zermatt';
  if (lower.includes('valais central') || lower.includes('mittelwallis')) return 'Sion';
  if (lower.includes('haut-valais') || lower.includes('oberwallis')) return 'Visp';
  if (lower.includes('bas-valais') || lower.includes('unterwallis')) return 'Martigny';
  return raw || 'Sion';
}

/**
 * Fetch all Banque Cantonale du Valais jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllBcvsJobs() {
  console.log(`🔍 Fetching Banque Cantonale du Valais jobs`);
  console.log(`   Source: ${CAREER_URL}`);
  console.log(`   Platform: TYPO3 CMS (HTML scraping)\n`);

  // Step 1: Fetch the listing page
  console.log(`  📄 Fetching listing page...`);
  const listingHtml = await fetchHtml(CAREER_URL);
  const listings = parseListingPage(listingHtml);

  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings found on the careers page.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  // Step 2: Fetch detail pages for each job
  const jobs = [];
  for (const listing of listings) {
    const title = normalizeSpace(listing.title);
    if (!title || title.length < 3) continue;

    const locationRaw = listing.location;
    const city = normalizeBcvsLocation(locationRaw);

    // Fetch detail for richer description
    console.log(`  📥 Fetching detail: ${title.substring(0, 50)}...`);
    const detail = await fetchJobDetail(listing.url);

    const descriptionText = detail.description || `${title} — ${BCVS_COMPANY_NAME}, ${city}`;
    const requirements = detail.requirements || [];

    const sourceLang = detectLang(descriptionText || title, 'fr');
    const jobSlug = slugify(`${title} bcvs ${city || 'valais'}`);
    const urlHash = createHash('sha1').update(listing.url).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `bcvs-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: BCVS_COMPANY_NAME,
      companyKey: BCVS_KEY,
      companyDomain: BCVS_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location: city,
      canton: 'VS',
      url: listing.url,
      source: 'Banque Cantonale du Valais Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Location details ──
      addressLocality: city,
      addressRegion: 'VS',
      addressCountry: 'CH',
      country: 'CH',

      // ── Job metadata ──
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(listing.pensum || title),
      experienceLevel: detectExperienceLevel(title),
      ...(listing.pensum ? { pensum: listing.pensum } : {}),
      sector: 'Banca / Finanza',
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().split('T')[0],
      applyUrl: listing.url,

      // ── Requirements ──
      requirements,
      requirementsByLocale: { [sourceLang]: requirements },
    };

    jobs.push(job);
    console.log(`  ✅ ${title} — ${city} (${listing.pensum || '100%'})`);
    await new Promise((r) => setTimeout(r, 300)); // Rate limiting
  }

  console.log(`\n📋 Total Banque Cantonale du Valais jobs discovered: ${jobs.length}`);
  return jobs;
}
