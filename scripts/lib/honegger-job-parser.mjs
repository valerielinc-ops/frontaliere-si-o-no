#!/usr/bin/env node
/**
 * Honegger AG job parser — custom WordPress board (no ATS).
 *
 * Honegger AG (honegger.ch, Wallisellen, est. 1948, ~6500 employees, ~23
 * branches across all 4 CH language regions) is a facility-services group
 * (Unterhaltsreinigung/Spezialreinigung cleaning, Gärtner gardening,
 * Betriebsunterhalt/Facility Management). NOTE: the discovery-stage tag for
 * this row ("impiantistica/elettrotecnica" / building-technology-electrical)
 * does NOT match reality — verified live (2026-07) there is no dedicated
 * Honegger electrotechnical contractor at this scale; this IS the real,
 * only company matching the ~20-branch national footprint. Per the
 * campaign's recurring gotcha, discovery tags are treated as unverified.
 *
 * Site sits behind Cloudflare's JS challenge (plain fetch/curl → "Just a
 * moment..." / 403). crawler-template.mjs's fetchHtml() already retries
 * through the shared Jina Reader proxy (scripts/lib/jina-proxy.mjs) on a
 * connection-level failure or WAF-block status, so no bespoke proxy logic
 * is needed here — just use the standard fetchHtml().
 *
 * Listing page: https://honegger.ch/jobs/
 *   - WordPress "jobs" CPT query loop, one <li> per job:
 *     <li class="wp-block-post post-{ID} jobs type-jobs status-publish ...
 *         standorte-{slug} beschaetigungsgrade-{slug} positionen-{slug}
 *         job-kategorie-{slug}">
 *       <h2 class="wp-block-post-title ...">{Title} | {Location} {Pct}%</h2>
 *       <div class="hon-excerpt-list-jobs ...">
 *         <p class="wp-block-post-excerpt__excerpt">{teaser}</p>
 *         <p class="wp-block-post-excerpt__more-text">
 *           <a class="wp-block-post-excerpt__more-link" href="{detailUrl}">Mehr erfahren</a>
 *         </p>
 *       </div>
 *     </li>
 *   (~18 confirmed live; 2 are Liechtenstein branches (Schaan/Mühleholz,
 *   postal 9494/9490) — excluded, out of Swiss-canton scope.)
 *
 * Detail page: https://honegger.ch/job/{slug}/
 *   - Clean role title:      <h2 class="wp-block-heading has-deepwhite-color
 *                             has-text-color has-xx-large-font-size">{Title}</h2>
 *   - "Spezifikationen" card:
 *       <div class="taxonomy-job-kategorie ...">      <a href=".../job-kategorie/{slug}/">{Label}</a></div>
 *       <p class="hon-inline-image-spez ...">{abwann.svg}{Since-when text}</p>
 *       <div class="taxonomy-standorte ...">          <a href=".../standort/{slug}/">{Label}</a>[, <a>...] (multi-location)
 *       <div class="taxonomy-beschaetigungsgrade ..."> <a href=".../beschaetigungsgrad/{slug}/">{Pct label}</a></div>
 *   - Content sections (heading text is the stable anchor, not classes):
 *       <h2 ...>Das kannst du bei uns bewirken</h2> <ul class="wp-block-list hon-list"><li>...
 *       <h2 ...>Das bringst du mit</h2>              <ul class="wp-block-list hon-list"><li>...
 *       <h2 class="wp-block-heading">Wir als Arbeitgeber</h2> <p>...</p> <ul class="wp-block-list hon-list"><li>...
 *   - <meta property="article:modified_time" content="ISO8601"> → postedDate
 *
 * Exports the required functions for the crawler template:
 *   - fetchAllHoneggerJobs() — Fetch and parse all jobs
 *   - isHoneggerJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()      — Validate URLs belong to this company
 */
import { createHash } from 'node:crypto';
import { fetchHtml, slugify, stripHtml, normalizeSpace, normalizeDescriptionSpace } from './crawler-template.mjs';
import { readAttr, readMetaContent } from './html-attr.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const HONEGGER_KEY = 'honegger';
export const HONEGGER_COMPANY_NAME = 'Honegger AG';
export const HONEGGER_COMPANY_DOMAIN = 'honegger.ch';

const BASE_URL = 'https://honegger.ch';
const LISTING_URL = `${BASE_URL}/jobs/`;

/**
 * WordPress "standorte" taxonomy term slug → Swiss location.
 * Built from live term slugs observed on honegger.ch/jobs/ (2026-07).
 * Liechtenstein branches (schaan, muehleholz) are deliberately absent —
 * see EXCLUDED_LOCATION_SLUGS below.
 */
export const STANDORT_LOCATIONS = {
  'sarnen': { city: 'Sarnen', canton: 'OW', postalCode: '6060' },
  'boudry-ne': { city: 'Boudry', canton: 'NE', postalCode: '2017' },
  'langenthal': { city: 'Langenthal', canton: 'BE', postalCode: '4900' },
  'amriswil': { city: 'Amriswil', canton: 'TG', postalCode: '8580' },
  'st-gallen': { city: 'St. Gallen', canton: 'SG', postalCode: '9000' },
  'basel-stadt': { city: 'Basel', canton: 'BS', postalCode: '4001' },
  'basel-land': { city: 'Liestal', canton: 'BL', postalCode: '4410' },
  'region-zuerich-unterer-zuerichsee-horgen-waedenswil-thalwil': { city: 'Horgen', canton: 'ZH', postalCode: '8810' },
  'horgen': { city: 'Horgen', canton: 'ZH', postalCode: '8810' },
  'waedenswil': { city: 'Wädenswil', canton: 'ZH', postalCode: '8820' },
  'thalwil-bis-uznach': { city: 'Thalwil', canton: 'ZH', postalCode: '8800' },
  'stans': { city: 'Stans', canton: 'NW', postalCode: '6370' },
  'savognin': { city: 'Savognin', canton: 'GR', postalCode: '7460' },
  'schwyz': { city: 'Schwyz', canton: 'SZ', postalCode: '6430' },
  'region-bern': { city: 'Bern', canton: 'BE', postalCode: '3000' },
  'zuerich': { city: 'Zürich', canton: 'ZH', postalCode: '8000' },
  'zuerich-und-umgebung': { city: 'Zürich', canton: 'ZH', postalCode: '8000' },
  'adliswil': { city: 'Adliswil', canton: 'ZH', postalCode: '8134' },
  'rapperswil-2': { city: 'Rapperswil', canton: 'SG', postalCode: '8640' },
};

/** Liechtenstein branches — real Honegger locations, but FL ≠ CH, out of scope. */
export const EXCLUDED_LOCATION_SLUGS = new Set(['schaan', 'muehleholz']);

/**
 * When a job carries multiple "standorte" terms, pick the primary one
 * deterministically: Basel-Stadt over Baselland (more precise city+postal),
 * Schwyz over the generic "thalwil-bis-uznach" route descriptor, otherwise
 * the first term in document order (already primary-first on this site,
 * e.g. "adliswil" before "horgen"/"rapperswil-2"/"waedenswil").
 */
export function pickPrimaryLocationSlug(slugs = []) {
  const valid = slugs.filter((s) => STANDORT_LOCATIONS[s]);
  if (valid.includes('basel-stadt')) return 'basel-stadt';
  if (valid.includes('schwyz')) return 'schwyz';
  return valid[0] || null;
}

/* ── Helpers ───────────────────────────────────────────────── */

/**
 * Decode the small set of HTML entities honegger.ch actually emits
 * (the theme outputs raw UTF-8 for accented characters, unlike legacy
 * entity-heavy WordPress themes seen elsewhere in this codebase).
 */
export function decodeWpEntities(raw = '') {
  return String(raw || '')
    .replace(/&#160;/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&#8216;/g, '‘')
    .replace(/&#8217;/g, '’')
    .replace(/&#038;/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * Extract the workload percentage range from a beschaetigungsgrad label
 * (e.g. "40 – 50%", "100%", "ca. 18%") or a listing title suffix.
 * Returns { min, max } (both 0-100) or null if no percentage found.
 */
export function extractPensum(text = '') {
  const t = String(text || '');
  const rangeMatch = t.match(/(\d{1,3})\s*[-–]\s*(\d{1,3})\s*%/);
  if (rangeMatch) {
    return { min: Number(rangeMatch[1]), max: Number(rangeMatch[2]) };
  }
  const singleMatch = t.match(/(\d{1,3})\s*%/);
  if (singleMatch) {
    const v = Number(singleMatch[1]);
    return { min: v, max: v };
  }
  return null;
}

export function detectCategory(title = '', categorySlug = '') {
  const t = normalizeSpace(title).toLowerCase();
  if (/gärtner|garten/i.test(t)) return 'Giardinaggio';
  if (categorySlug === 'spezialreinigung') return 'Pulizie Specializzate';
  if (categorySlug === 'facility-management') return 'Facility Management';
  if (categorySlug === 'unterhaltsreinigung') return 'Pulizie di Manutenzione';
  return 'Facility Management';
}

export function detectExperienceLevel(title = '') {
  const t = normalizeSpace(title).toLowerCase();
  if (/lernend|praktikant|stagiaire|apprenti/.test(t)) return 'intern';
  if (/einsatzleiter|teamleiter|vorarbeiter|inspektor|leiter|leitung/.test(t)) return 'senior';
  if (/fachfrau|fachmann|fachmitarbeiter/.test(t)) return 'mid';
  return 'mid';
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Honegger AG.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isHoneggerJob(job) {
  const key = normalizeSpace(job?.companyKey || job?.company || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalizeSpace(job?.company || '').toLowerCase();
  const url = normalizeSpace(job?.url || '').toLowerCase();

  return (
    key === HONEGGER_KEY ||
    key.startsWith('honegger') ||
    company === 'honegger ag' ||
    url.includes('honegger.ch')
  );
}

/**
 * Validate that a URL belongs to Honegger AG's own domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === HONEGGER_COMPANY_DOMAIN || host.endsWith(`.${HONEGGER_COMPANY_DOMAIN}`);
  } catch {
    return false;
  }
}

/* ── Listing Page Parser ──────────────────────────────────── */

/**
 * Parse the honegger.ch/jobs/ listing page into raw listing entries.
 *
 * Only picks up <li> blocks explicitly tagged `type-jobs` (the WP "jobs"
 * custom post type) — the page also embeds unrelated news/widget queries
 * that share class-naming conventions but are NOT job postings.
 */
export function parseHoneggerListingPage(html = '') {
  const results = [];
  const seen = new Set();

  const liRegex = /<li class="wp-block-post post-(\d+) jobs type-jobs[^"]*">([\s\S]*?)<\/li>/g;
  let liMatch;
  while ((liMatch = liRegex.exec(html)) !== null) {
    const postId = liMatch[1];
    const block = liMatch[2];
    if (seen.has(postId)) continue;
    seen.add(postId);

    const titleMatch = block.match(/<h2 class="wp-block-post-title[^"]*">([\s\S]*?)<\/h2>/);
    const title = titleMatch ? normalizeSpace(stripHtml(decodeWpEntities(titleMatch[1]))) : '';
    if (!title) continue;

    const linkTag = (block.match(/<a\b[^>]*>/gi) ?? []).find((tag) =>
      readAttr(tag, 'class').split(/\s+/).includes('wp-block-post-excerpt__more-link'));
    const detailUrl = readAttr(linkTag, 'href');
    if (!detailUrl) continue;

    const excerptMatch = block.match(/<p class="wp-block-post-excerpt__excerpt">([\s\S]*?)<\/p>/);
    const excerpt = excerptMatch ? normalizeSpace(stripHtml(decodeWpEntities(excerptMatch[1]))) : '';

    results.push({ postId, title, detailUrl, excerpt });
  }

  return results;
}

/* ── Detail Page Parser ───────────────────────────────────── */

/**
 * Extract all term slugs + labels inside a "taxonomy-{name}" post-terms
 * block (which may contain one or several comma-separated <a> tags).
 */
function extractTaxonomyTerms(html = '', taxonomyName = '', urlSegment = '') {
  const blockRegex = new RegExp(`taxonomy-${taxonomyName}[^>]*>([\\s\\S]*?)<\\/div>`);
  const blockMatch = html.match(blockRegex);
  if (!blockMatch) return [];

  const terms = [];
  const linkRegex = new RegExp(`href="https:\\/\\/honegger\\.ch\\/${urlSegment}\\/([a-z0-9-]+)\\/"[^>]*>([^<]+)<\\/a>`, 'g');
  let m;
  while ((m = linkRegex.exec(blockMatch[1])) !== null) {
    terms.push({ slug: m[1], label: normalizeSpace(decodeWpEntities(m[2])) });
  }
  return terms;
}

function extractHeadingSection(html = '', headingText) {
  const headingRegex = new RegExp(`<h2[^>]*>\\s*${headingText}[\\s\\S]{0,20}?<\\/h2>([\\s\\S]{0,4000}?)<\\/ul>`);
  const match = html.match(headingRegex);
  if (!match) return [];
  const ulMatch = match[1].match(/<ul class="wp-block-list hon-list">([\s\S]*)$/);
  const listHtml = ulMatch ? ulMatch[1] : match[1];
  const items = [];
  const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/g;
  let liMatch;
  while ((liMatch = liRegex.exec(listHtml)) !== null) {
    const text = normalizeSpace(stripHtml(decodeWpEntities(liMatch[1])));
    if (text.length > 1) items.push(text);
  }
  return items;
}

/**
 * Parse a honegger.ch job detail page.
 *
 * Returns { title, categorySlug, categoryLabel, locationSlugs, sinceWhen,
 *   pensumLabel, tasks[], requirements[], employerBenefits[], postedDate }
 */
export function parseHoneggerDetailPage(html = '', fallbackTitle = '') {
  const titleMatch = html.match(
    /<h2 class="wp-block-heading has-deepwhite-color has-text-color has-xx-large-font-size">([\s\S]*?)<\/h2>/,
  );
  const title = titleMatch ? normalizeSpace(stripHtml(decodeWpEntities(titleMatch[1]))) : fallbackTitle;

  const categoryTerms = extractTaxonomyTerms(html, 'job-kategorie', 'job-kategorie');
  const categorySlug = categoryTerms[0]?.slug || '';
  const categoryLabel = categoryTerms[0]?.label || '';

  const locationTerms = extractTaxonomyTerms(html, 'standorte', 'standort');
  const locationSlugs = locationTerms.map((t) => t.slug);

  const pensumTerms = extractTaxonomyTerms(html, 'beschaetigungsgrade', 'beschaetigungsgrad');
  const pensumLabel = pensumTerms[0]?.label || '';

  const sinceWhenMatch = html.match(/abwann\.svg[^>]*>\s*([^<]+)<\/p>/);
  const sinceWhen = sinceWhenMatch ? normalizeSpace(decodeWpEntities(sinceWhenMatch[1])) : '';

  const tasks = extractHeadingSection(html, 'Das kannst du bei uns bewirken');
  const requirements = extractHeadingSection(html, 'Das bringst du mit');
  const employerBenefits = extractHeadingSection(html, 'Wir als Arbeitgeber');

  const modifiedTime = readMetaContent(html, 'article:modified_time');
  const publishedTime = readMetaContent(html, 'article:published_time');
  const postedDate = (modifiedTime || publishedTime).split('T')[0] || '';

  return {
    title,
    categorySlug,
    categoryLabel,
    locationSlugs,
    sinceWhen,
    pensumLabel,
    tasks,
    requirements,
    employerBenefits,
    postedDate,
  };
}

/**
 * Build a structured description from parsed detail-page sections.
 */
export function buildDescription(detail, fallbackExcerpt = '') {
  const parts = [];

  if (detail.sinceWhen) {
    parts.push(`**Eintritt:** ${detail.sinceWhen}`);
  }

  if (detail.tasks.length > 0) {
    parts.push(`\n## Das kannst du bei uns bewirken\n${detail.tasks.map((t) => `- ${t}`).join('\n')}`);
  } else if (fallbackExcerpt) {
    parts.push(fallbackExcerpt);
  }

  if (detail.requirements.length > 0) {
    parts.push(`\n## Das bringst du mit\n${detail.requirements.map((r) => `- ${r}`).join('\n')}`);
  }

  if (detail.employerBenefits.length > 0) {
    parts.push(`\n## Wir als Arbeitgeber\n${detail.employerBenefits.map((b) => `- ${b}`).join('\n')}`);
  }

  return normalizeDescriptionSpace(parts.join('\n').trim());
}

/* ── Fetch Function ───────────────────────────────────────── */

/**
 * Fetch all Honegger AG jobs.
 * Returns an array of ParsedJob objects (source-locale only — German).
 *
 * Flow:
 *  1. Fetch listing page HTML → parse the ~18 <li> entries.
 *  2. Per job, fetch the detail page → extract structured sections + taxonomy.
 *  3. Drop Liechtenstein-only branches (Schaan / Mühleholz — FL, not CH).
 *  4. Build ParsedJob objects.
 */
export async function fetchAllHoneggerJobs() {
  console.log('🧹 Fetching Honegger AG jobs');
  console.log(`   Source: ${LISTING_URL}\n`);

  const listingHtml = await fetchHtml(LISTING_URL);
  const listings = parseHoneggerListingPage(listingHtml);

  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings found on honegger.ch/jobs/.');
    return [];
  }

  console.log(`   📋 Listings found: ${listings.length}\n`);

  const jobs = [];
  for (const listing of listings) {
    let detail;
    try {
      const detailHtml = await fetchHtml(listing.detailUrl);
      detail = parseHoneggerDetailPage(detailHtml, listing.title);
    } catch (err) {
      console.warn(`   ⚠️ Failed to fetch detail for "${listing.title}": ${err?.message}`);
      continue;
    }

    const primarySlug = pickPrimaryLocationSlug(detail.locationSlugs);
    if (!primarySlug || EXCLUDED_LOCATION_SLUGS.has(primarySlug)) {
      // Liechtenstein branch (Schaan/Mühleholz) or unmappable location — out
      // of Swiss-canton scope for this site; skip rather than emit a job
      // with a wrong/missing canton.
      const isLi = detail.locationSlugs.some((s) => EXCLUDED_LOCATION_SLUGS.has(s));
      console.log(
        `   ⏭️  Skipping "${listing.title}" — ${isLi ? 'Liechtenstein branch (FL, out of CH scope)' : 'unmapped location'}.`,
      );
      continue;
    }

    const loc = STANDORT_LOCATIONS[primarySlug];
    const title = detail.title || listing.title;
    const description = buildDescription(detail, listing.excerpt);
    if (!title || description.split(/\s+/).filter(Boolean).length < 15) {
      console.log(`   ⏭️  Skipping "${listing.title}" — insufficient content.`);
      continue;
    }

    const pensum = extractPensum(detail.pensumLabel) || extractPensum(listing.title);
    const employmentType = pensum && pensum.max < 80 ? 'PART_TIME' : 'FULL_TIME';

    const sourceLang = 'de';
    const jobSlug = slugify(`${title} honegger ag ${loc.city}`);
    const idHash = createHash('sha1').update(`honegger-${listing.postId}`).digest('hex').slice(0, 12);
    const postedDate = detail.postedDate || new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `honegger-${idHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: HONEGGER_COMPANY_NAME,
      companyKey: HONEGGER_KEY,
      companyDomain: HONEGGER_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: loc.city,
      canton: loc.canton,
      url: listing.detailUrl,
      source: 'Honegger AG Dedicated Parser (custom WordPress board)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: loc.city,
      postalCode: loc.postalCode,
      addressRegion: loc.canton,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, detail.categorySlug),
      contract: 'permanent',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Facility Management / Pulizie',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: listing.detailUrl,
      requirements: detail.requirements,
      requirementsByLocale: { [sourceLang]: detail.requirements },
    };

    if (pensum) {
      job.pensumMin = pensum.min;
      job.pensumMax = pensum.max;
      job.pensum = pensum.min === pensum.max ? `${pensum.min}%` : `${pensum.min} - ${pensum.max}%`;
    }

    jobs.push(job);
    console.log(`   ✅ ${title.substring(0, 65)} | ${loc.city} (${loc.canton})`);
  }

  console.log(`\n📊 Total Honegger AG jobs parsed: ${jobs.length}`);
  return jobs;
}
