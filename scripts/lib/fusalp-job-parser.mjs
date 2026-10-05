#!/usr/bin/env node
/**
 * Fusalp job parser — WelcomeKit HTML + JSON-LD fetcher and job builder.
 *
 * Fusalp uses WelcomeKit (Welcome to the Jungle) for their career portal.
 * Strategy:
 *   1. Fetch the listing page HTML to get all job URLs
 *   2. Fetch each detail page to extract JSON-LD structured data
 *
 * Source: https://fusalp.welcomekit.co/
 */
import { createHash } from 'node:crypto';
import { extractJobPostingLd } from './jsonld-jobposting.mjs';
import { sourcePostingDateFields, withLegacyPostingDay } from './source-posting-date.mjs';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeDescriptionSpace } from './crawler-template.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

const CAREER_URL = 'https://fusalp.welcomekit.co';

export const FUSALP_KEY = 'fusalp';
export const FUSALP_COMPANY_NAME = 'Fusalp';
export const FUSALP_COMPANY_DOMAIN = 'fusalp.com';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Fusalp.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isFusalpJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === FUSALP_KEY ||
    key.startsWith('fusalp') ||
    company.includes('fusalp') ||
    url.includes('fusalp.com') ||
    url.includes('fusalp.welcomekit.co')
  );
}

/**
 * Validate that a URL belongs to Fusalp's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'fusalp.com' || host.endsWith('.fusalp.com') ||
      host === 'fusalp.welcomekit.co';
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(responsable|manager|directeur|directrice|gérant)/.test(t)) return 'Commerciale';
  if (/\b(conseill|vendeu[rse]|vente|sales|consultant)/.test(t)) return 'Commerciale';
  if (/\b(développement|development|product|design|tissu)/.test(t)) return 'Produzione';
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(it|software|develop|programm)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(empType = '') {
  const t = normalize(empType);
  if (t.includes('part') || t.includes('temps partiel') || t.includes('teilzeit')) return 'PART_TIME';
  if (t.includes('full') || t.includes('temps plein') || t.includes('vollzeit')) return 'FULL_TIME';
  return 'FULL_TIME';
}

/* ── HTTP Client ─────────────────────────────────────────── */

/**
 * Fetch a URL and return the response body as text.
 */
async function fetchPage(url) {
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
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse the listing page HTML to extract job URLs and titles.
 */
function parseListingPage(html) {
  const items = html.match(/<li\s+class='jobs-list-item'[\s\S]*?<\/li>/g) || [];
  const jobs = [];

  for (const item of items) {
    const hrefMatch = item.match(/href="([^"]+)"/);
    const titleMatch = item.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
    const contractMatch = item.match(/jobs-list-item-contract['"]\s*>([\s\S]*?)</);

    if (hrefMatch && titleMatch) {
      jobs.push({
        path: hrefMatch[1],
        title: normalizeSpace(stripHtml(titleMatch[1])),
        contract: contractMatch ? normalizeSpace(stripHtml(contractMatch[1])) : '',
      });
    }
  }

  return jobs;
}

/**
 * Extract JSON-LD JobPosting data from a detail page.
 * WelcomeKit embeds a JSON-LD <script> block with rich job data.
 */
function publicationFields(posting, detailUrl) {
  const rawIdentities = [posting?.url, posting?.sameAs].flat().filter((value) => value != null);
  // A date belongs to this vacancy only when every declared identity matches it.
  const matches = rawIdentities.length > 0 && rawIdentities.every((value) => {
    if (typeof value !== 'string' || !value.trim()) return false;
    try {
      const candidate = new URL(value, detailUrl);
      const expected = new URL(detailUrl);
      candidate.hash = '';
      expected.hash = '';
      return candidate.href.replace(/\/$/, '') === expected.href.replace(/\/$/, '');
    } catch {
      return false;
    }
  });
  return sourcePostingDateFields(matches ? posting?.datePosted : '');
}

function readBalancedDiv(html, contentStart) {
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = contentStart;
  let depth = 1;
  let match;
  while ((match = tags.exec(html))) {
    if (match[0][1] === '/') {
      depth -= 1;
      if (depth === 0) return { content: html.slice(contentStart, match.index), end: tags.lastIndex };
    } else if (!/\/\s*>$/.test(match[0])) {
      depth += 1;
    }
  }
  return { content: html.slice(contentStart), end: html.length };
}

// One line per list item: WelcomeKit wraps item text in `<p>` and splits the
// "Additional Information" values over several lines inside `<strong>`.
function htmlBlockToText(html = '') {
  const flatItems = String(html || '').replace(
    /<li\b([^>]*)>([\s\S]*?)<\/li>/gi,
    (_, attrs, inner) => `<li${attrs}>${inner.replace(/<\/?p\b[^>]*>|<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ')}</li>`,
  );
  return normalizeDescriptionSpace(stripHtml(flatItems))
    .replace(/•[ \t]*\n+[ \t]*/g, '• ')
    .replace(/\n{2,}(?=• )/g, '\n');
}

/**
 * Full vacancy text of a WelcomeKit detail page, in page order: every
 * `div.block-job-text` block ("About" — company and role context —, "Job
 * Description", "Preferred Experience", "Recruitment Process", "Additional
 * Information") as `Heading` + body, lists kept as `• ` lines. The apply block
 * and the photo carousel are chrome. The JSON-LD `description` +
 * `qualifications` pair used before carries only two of those blocks, and the
 * old whitespace collapse flattened every list into one paragraph (#5253).
 */
export function parseFusalpDetailDescription(html = '') {
  const source = String(html || '');
  const sections = [];
  const openings = /<div\b[^>]*\bclass\s*=\s*["']([^"']*)["'][^>]*>/gi;
  let match;
  while ((match = openings.exec(source))) {
    const classes = match[1].split(/\s+/);
    if (!classes.includes('block-job-text') || classes.includes('block-job-apply')) continue;
    const { content, end } = readBalancedDiv(source, openings.lastIndex);
    openings.lastIndex = end;
    const heading = normalizeSpace(stripHtml(/<h[23]\b[^>]*class\s*=\s*["'][^"']*block-title[^"']*["'][^>]*>([\s\S]*?)<\/h[23]>/i.exec(content)?.[1] || ''));
    const bodyStart = content.search(/<div\b[^>]*class\s*=\s*["'][^"']*block-content/i);
    const body = bodyStart >= 0 ? htmlBlockToText(content.slice(bodyStart)) : '';
    if (!body) continue;
    sections.push(heading ? `${heading}\n${body}` : body);
  }
  return normalizeDescriptionSpace(sections.join('\n\n'));
}

/**
 * Fetch all Fusalp jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllFusalpJobs() {
  console.log(`🔍 Fetching Fusalp jobs from WelcomeKit`);
  console.log(`   Source: ${CAREER_URL}\n`);

  // Step 1: Fetch listing page and extract all job URLs
  const listingHtml = await fetchPage(CAREER_URL);
  const listings = parseListingPage(listingHtml);

  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings found on WelcomeKit page.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  // Step 2: Fetch each detail page for JSON-LD
  const jobs = [];
  for (const listing of listings) {
    const detailUrl = `${CAREER_URL}${listing.path}`;
    console.log(`  📄 Fetching detail: ${listing.title}`);

    try {
      const detailHtml = await fetchPage(detailUrl);
      const jsonLd = extractJobPostingLd(detailHtml);

      // Extract location from JSON-LD or URL slug
      const jobLocation = jsonLd?.jobLocation?.[0]?.address || jsonLd?.jobLocation?.address || {};
      const orgAddress = jsonLd?.hiringOrganization?.address || {};
      const addressLocality = jobLocation.addressLocality || orgAddress.addressLocality || '';
      const postalCode = jobLocation.postalCode || orgAddress.postalCode || '';
      const addressCountry = jobLocation.addressCountry || orgAddress.addressCountry || '';

      // Infer location from URL slug if not in JSON-LD
      const urlLocMatch = listing.path.match(/_([a-z][a-z-]+?)(?:_FUSAL|$)/i);
      const city = addressLocality || (urlLocMatch ? normalizeSpace(urlLocMatch[1].replace(/-/g, ' ')) : '');

      // Determine country from JSON-LD
      const country = normalize(addressCountry).includes('swi') ? 'CH' :
        normalize(addressCountry).includes('france') ? 'FR' :
          normalize(addressCountry).includes('luxem') ? 'LU' :
            addressCountry === 'CH' ? 'CH' : '';

      const canton = country === 'CH' ? (inferAnyCanton(city) || 'VS') : '';

      // Skip non-Swiss jobs — this is a Swiss frontaliere board
      if (country !== 'CH') {
        console.log(`  ⏭️  Skipped non-Swiss: ${listing.title} in ${city}, ${country || '?'}`);
        continue;
      }

      // Description: the rendered vacancy blocks; JSON-LD only as fallback.
      const rawDescription = jsonLd?.description || '';
      const qualifications = jsonLd?.qualifications || '';
      const descriptionText = parseFusalpDetailDescription(detailHtml) || htmlBlockToText(
        rawDescription + (qualifications ? `\n\n${qualifications}` : ''),
      );

      const title = normalizeSpace(jsonLd?.title || listing.title || '');
      if (!title || title.length < 3) continue;

      const empType = jsonLd?.employmentType || listing.contract || '';
      const publication = publicationFields(jsonLd, detailUrl);

      const publicUrl = detailUrl;
      const sourceLang = detectLang(descriptionText || title, 'fr');
      const jobSlug = slugify(`${title} fusalp ${city || 'ch'}`);
      const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

      const job = {
        // ── Required fields ──
        id: `fusalp-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { [sourceLang]: jobSlug },
        company: FUSALP_COMPANY_NAME,
        companyKey: FUSALP_KEY,
        companyDomain: FUSALP_COMPANY_DOMAIN,
        title,
        titleByLocale: { [sourceLang]: title },
        description: descriptionText || `${title} — Fusalp`,
        descriptionByLocale: { [sourceLang]: descriptionText || `${title} — Fusalp` },
        location: city || 'Crans-Montana',
        canton,
        url: publicUrl,
        source: 'Fusalp Dedicated Parser',
        sourceLang,
        crawledAt: new Date().toISOString(),

        // ── Recommended fields ──
        addressLocality: city || 'Crans-Montana',
        addressCountry: country || 'CH',
        country: country || 'CH',
        postalCode,
        category: detectCategory(title),
        contract: normalize(empType).includes('part') ? 'part-time' : 'full-time',
        employmentType: detectEmploymentType(empType),
        experienceLevel: detectExperienceLevel(title),
        sector: 'Moda / Abbigliamento sportivo',
        currency: country === 'CH' ? 'CHF' : 'EUR',
        featured: false,
        ...withLegacyPostingDay(publication),
        applyUrl: publicUrl,
        requirements: [],
        requirementsByLocale: { [sourceLang]: [] },
      };

      jobs.push(job);
      console.log(`  ✅ ${title} — ${city} (${country || '?'})`);
    } catch (err) {
      console.warn(`  ⚠️ Skipping ${listing.title}: ${err?.message || err}`);
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\n📋 Total Fusalp jobs discovered: ${jobs.length}`);
  return jobs;
}
