import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
/**
 * Alpiq — career page parser
 *
 * Alpiq lists open positions at:
 *   https://www.alpiq.com/career/open-jobs
 *
 * Job detail pages:
 *   https://www.alpiq.com/career/open-jobs/your-application/{jobId}
 *
 * Application links go to SuccessFactors:
 *   https://career5.successfactors.eu/careers?company=Alpiq&career_job_req_id={jobId}
 *
 * HTML structure on listing page:
 *   <ul> containing <li> items with:
 *     - Category tag
 *     - <a href="/career/open-jobs/your-application/{jobId}">Job Title</a>
 *     - Brief description text
 *     - Location and employment type (e.g., "Lausanne - 100% Permanent")
 *
 * This parser extracts jobs from the listing page HTML, filtering for
 * Swiss/Ticino locations only.
 */

import { isTargetSwissLocation, inferAnyCanton } from './target-swiss-locations.mjs';
import {
  fetchHtml,
  normalizeSpace,
  normalizeDescriptionSpace,
  stripScriptsAndStyles,
} from './crawler-template.mjs';
import { decodeHtmlEntities } from './dedicated-crawler-common.mjs';
import { fetchHtmlViaJinaWithRetry, looksLikeAntiBotChallenge } from './jina-proxy.mjs';

const CAREERS_URL = 'https://www.alpiq.com/career/open-jobs';
const CAREERS_BASE = 'https://www.alpiq.com';
const UA = 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';
const MIN_RICH_DETAIL_WORDS = 30;

/**
 * Build the listing URL for a given 1-based page number.
 *
 * Alpiq switched pagination from the legacy `?page=N` query (now 404) to a
 * path-segment scheme: `.../jobs/job-page-{N}/f1-<x>/f2-<y>/search`, where
 * `f1`/`f2` are the category/location facet filters and `%2A` (URL-encoded `*`)
 * means unfiltered. Page 1 stays on the bare listing URL.
 */
function alpiqListingPageUrl(page) {
  if (page <= 1) return CAREERS_URL;
  return `${CAREERS_BASE}/career/open-jobs/jobs/job-page-${page}/f1-%2A/f2-%2A/search`;
}


export function stripHtml(html = '') {
  return String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeListingWhitespace(value = '') {
  const withBoundaries = String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|li|div|section|article|tr|td|th)>/gi, '\n');
  return stripHtml(withBoundaries)
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractLocationContractSegment(value = '') {
  const text = normalizeListingWhitespace(value);
  const labelledLocation = text.match(/\b(?:Location|Standort|Lieu|Luogo)\s*:\s*([^|\n]+)/i);
  if (labelledLocation?.[1]) return normalizeSpace(labelledLocation[1]);

  const contractLocation = text.match(
    /([A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÿ.'-]*(?:\s+[A-Za-zÀ-ÿ.'-]+){0,5})\s*,\s*(?:CH|CHE)\s*[-–—]\s*\d{1,3}(?:-\d{1,3})?%/iu,
  );
  if (contractLocation?.[1]) return normalizeSpace(contractLocation[1]);

  const legacyLocation = text.match(
    /(?:^|[\n|])\s*(?:•\s*)?([A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÿ.'-]*(?:\s+[A-Za-zÀ-ÿ.'-]+){0,5})\s*[-–—]\s*\d{1,3}(?:-\d{1,3})?%/u,
  );
  return normalizeSpace(legacyLocation?.[1] || '');
}

export function hasStandaloneSwissSignal(value = '') {
  const text = normalizeListingWhitespace(value);
  return /(?:^|[^\p{L}\p{N}])(?:ch|che|swiss|switzerland|schweiz|svizzera|suisse)(?=$|[^\p{L}\p{N}])/iu.test(text);
}

export function slugify(value = '') {
  return truncateSlugAtWordBoundary(String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-'), 180);
}

/**
 * Check if a location string is in Ticino specifically.
 */
export function isTicinoLocation(location = '') {
  return isTargetSwissLocation(location);
}

/**
 * Check if a location string is in Switzerland.
 */
export function isSwissLocation(location = '') {
  const normalized = normalizeListingWhitespace(location);
  if (isTargetSwissLocation(normalized)) return true;
  if (hasStandaloneSwissSignal(normalized)) return true;
  return inferAnyCanton(normalized.toLowerCase()) !== '';
}

/**
 * Parse a single job listing block from the Alpiq listing page.
 * Expects a block of HTML containing one job entry.
 */
export function parseAlpiqJobBlock(block) {
  if (!block) return null;

  // Extract link and title
  const linkMatch = block.match(/<a\s+[^>]*href="(\/career\/open-jobs\/your-application\/(\d+))"[^>]*>([\s\S]*?)<\/a>/i);
  if (!linkMatch) return null;

  const relUrl = linkMatch[1];
  const jobId = linkMatch[2];
  const title = normalizeSpace(stripHtml(linkMatch[3]));
  if (!title || title.length < 3) return null;

  const fullUrl = `${CAREERS_BASE}${relUrl}`;

  // The current listing exposes the place in a labelled description line
  // (`Location: Olten`) and repeats it in the contract row (`Olten, CH`).
  // Keep the older `Olten - 100%` fallback for archived/fixture markup, but do
  // not mistake the country code from the contract row for the whole location.
  const text = normalizeListingWhitespace(block);
  const locationRaw = extractLocationContractSegment(block);

  // Extract description snippet
  const descText = normalizeDescriptionSpace(stripHtml(block));
  const description = descText.length > 50 ? descText.slice(0, 500) : descText;

  // Extract category
  const categoryMatch = block.match(/(?:Assets|Finance|Trading|HR|Legal|Origination|Projects|Sales|IT|Engineering|Operations|Administration|Digital)/i);
  const category = categoryMatch ? categoryMatch[0] : '';

  // Extract contract type
  const contractMatch = text.match(/(\d{1,3}(?:-\d{1,3})?)%\s*(?:\|?\s*)?(Permanent|Temporary|Fixed[\s-]term)?/i);
  const percentage = contractMatch ? contractMatch[1] : '100';
  const contractType = contractMatch && contractMatch[2] ? contractMatch[2] : 'Permanent';

  return {
    id: `alpiq-${jobId}`,
    title,
    url: fullUrl,
    applyUrl: `https://career5.successfactors.eu/careers?career_ns=job_application&company=Alpiq&career_job_req_id=${jobId}&lang=en_GB`,
    location: locationRaw,
    jobId,
    category,
    percentage,
    contractType,
    description,
  };
}

/**
 * Parse the Alpiq listing page HTML to extract all jobs.
 * Can optionally filter for Swiss-only or Ticino-only jobs.
 */
export function parseAlpiqListingHtml(html, { swissOnly = true } = {}) {
  if (!html || typeof html !== 'string') return [];

  const jobs = [];

  // Split by job link pattern
  const segments = html.split(/(?=<a\s+[^>]*href="\/career\/open-jobs\/your-application\/\d+)/gi);

  for (const segment of segments) {
    const job = parseAlpiqJobBlock(segment);
    if (!job) continue;

    if (swissOnly && !isSwissLocation(job.location)) continue;

    jobs.push(job);
  }

  // Deduplicate by jobId
  const seen = new Set();
  return jobs.filter((j) => {
    if (seen.has(j.jobId)) return false;
    seen.add(j.jobId);
    return true;
  });
}

/**
 * Parse an Alpiq detail page for full description.
 */
function extractAlpiqRoleContentHtml(html) {
  const cleanedHtml = stripScriptsAndStyles(String(html || ''));
  const missionMatch = cleanedHtml.match(
    /<(?:p|div)[^>]*>\s*<(?:strong|b)[^>]*>\s*Mission\s*<\/(?:strong|b)>/i,
  );
  const mainStart = cleanedHtml.search(/<main\b/i);
  const start = missionMatch?.index ?? (mainStart >= 0 ? mainStart : 0);
  const endCandidates = [
    cleanedHtml.indexOf('data-content-element="facts_container"', start),
    cleanedHtml.indexOf("data-content-element='facts_container'", start),
    cleanedHtml.indexOf('<footer', start),
    cleanedHtml.indexOf('</main>', start),
  ].filter((position) => position > start);
  const end = endCandidates.length ? Math.min(...endCandidates) : cleanedHtml.length;
  let roleHtml = cleanedHtml.slice(start, end);

  // The role block is followed by a legal disclaimer before the generic
  // benefits/contact/company content. Keep the vacancy's responsibilities and
  // profile, but do not publish the legal footer as job description content.
  const disclaimerPosition = roleHtml.search(/\bDisclaimer\s*:/i);
  if (disclaimerPosition > 0) roleHtml = roleHtml.slice(0, disclaimerPosition);
  return roleHtml;
}

export function parseAlpiqDetailHtml(html) {
  if (!html || typeof html !== 'string') return null;

  // Jina normally returns raw HTML, but its Reader fallback can return
  // Markdown when the upstream WAF changes the response negotiation. Keep the
  // detail rescue useful in that case instead of silently falling back to the
  // 20-word listing card (which is exactly what tripped the boilerplate guard).
  const markdownDetail = parseAlpiqMarkdownDetail(html);
  if (markdownDetail) return markdownDetail;

  const cleanedHtml = stripScriptsAndStyles(html);
  const roleHtml = extractAlpiqRoleContentHtml(cleanedHtml);

  // The current Sitecore detail page uses the hero h1; old fixtures and
  // archived pages use an h2. Prefer the actual vacancy title in either case.
  const h1Match = cleanedHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const h2Match = cleanedHtml.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  const titleHtml = h1Match?.[1] || h2Match?.[1] || '';
  const title = normalizeSpace(decodeHtmlEntities(stripHtml(titleHtml)));

  // Extract description from main content sections
  const sections = [];
  const strongRe = /<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi;
  let m;
  while ((m = strongRe.exec(roleHtml)) !== null) {
    const heading = normalizeSpace(decodeHtmlEntities(stripHtml(m[1])));
    if (heading.length > 3 && heading.length < 100) {
      sections.push(heading);
    }
  }

  // Extract bullet points
  const bullets = [];
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  while ((m = liRe.exec(roleHtml)) !== null) {
    const text = normalizeDescriptionSpace(decodeHtmlEntities(stripHtml(m[1])));
    if (text.length > 5) bullets.push(text);
  }

  // Build full description
  const bodyText = normalizeDescriptionSpace(decodeHtmlEntities(stripHtml(roleHtml)));
  const description = bodyText.slice(0, 3000);

  return {
    title,
    description,
    sections,
    bullets,
  };
}

/**
 * Parse the role section of the Markdown envelope returned by Jina Reader.
 * The function is deliberately narrow: it only accepts a non-HTML payload
 * with an explicit Mission heading, so a generic WAF/error page cannot become
 * a vacancy description by accident.
 */
function parseAlpiqMarkdownDetail(markdown = '') {
  const source = String(markdown || '').replace(/\r\n?/g, '\n');
  if (!source || /<\/?(?:html|body|main|div|p|li)\b/i.test(source)) return null;

  const mission = source.match(
    /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?Mission(?:\*\*)?\s*(?:\n|$)/i,
  );
  if (!mission || mission.index == null) return null;

  let roleText = source.slice(mission.index + mission[0].length);
  roleText = roleText.split(/\n\s*(?:Disclaimer:|(?:\*\*)?(?:Your benefits|How to apply|Apply now)(?:\*\*)?)/i)[0];
  roleText = normalizeDescriptionSpace(roleText);
  if (!roleText) return null;

  const sections = [];
  const sectionRe = /^\s*(?:#{1,6}\s+|\*\*)([^*\n#]+?)(?:\*\*)?\s*$/gm;
  let sectionMatch;
  while ((sectionMatch = sectionRe.exec(roleText)) !== null) {
    const section = normalizeSpace(sectionMatch[1]);
    if (section.length > 2 && section.length < 100) sections.push(section);
  }

  const bullets = roleText
    .split('\n')
    .map((line) => line.match(/^\s*(?:[*-]|\d+[.)])\s+(.*)$/)?.[1] || '')
    .map((line) => normalizeSpace(line))
    .filter((line) => line.length > 5);

  return { title: '', description: roleText, sections, bullets };
}

/**
 * Prefer a real detail-page description over a listing card snippet only when
 * the detail contains enough role-specific content. A failed/partial detail
 * fetch therefore degrades to the previous listing text instead of turning a
 * transient page response into an empty job.
 */
export function preferAlpiqDetailDescription(listingDescription = '', detail = null) {
  const candidate = normalizeDescriptionSpace(detail?.description || '');
  const wordCount = candidate.split(/\s+/).filter(Boolean).length;
  const hasStructuredContent = (detail?.bullets?.length || 0) >= 2 || (detail?.sections?.length || 0) >= 1;
  if (candidate.length >= 180 && wordCount >= 30 && hasStructuredContent) return candidate;
  return normalizeDescriptionSpace(listingDescription);
}

/**
 * Replace stale, obviously truncated Alpiq locale copies with the freshly
 * crawled source description while the translation queue is unavailable.
 *
 * `mergePreserveLocaleData()` deliberately keeps existing translations. That
 * is normally correct, but old Alpiq records can contain 20-word snippets in
 * `it`/`de`/`fr` next to a newly recovered detail-page description. Leaving
 * those snippets in place makes the boilerplate guard judge the translation
 * fossil instead of parser output. Copying the source is the same safe
 * fallback used for empty locale slots elsewhere; `needsRetranslation` makes
 * the next translate-pending run replace it with a real translation.
 *
 * Empty non-source slots are left alone: the shared locale hardener already
 * fills those, and this repair is intentionally limited to stale truncations.
 *
 * @returns {number} Number of non-source locale slots repaired.
 */
export function repairThinAlpiqLocaleDescriptions(jobs, {
  minSourceChars = 500,
  maxLocaleRatio = 0.45,
} = {}) {
  const locales = ['it', 'en', 'de', 'fr'];
  let repaired = 0;

  for (const job of Array.isArray(jobs) ? jobs : []) {
    const source = normalizeDescriptionSpace(job?.description || '');
    if (source.length < minSourceChars) continue;

    const sourceLang = String(job?.sourceLang || '').trim().toLowerCase() || 'en';
    const map = job?.descriptionByLocale && typeof job.descriptionByLocale === 'object'
      ? { ...job.descriptionByLocale }
      : {};
    let changed = false;

    // Keep the source-locale slot authoritative even when an older snapshot
    // omitted it or preserved a shorter pre-detail-page copy.
    const sourceLocaleText = normalizeDescriptionSpace(map[sourceLang] || '');
    if (sourceLocaleText.length < source.length * 0.85) {
      map[sourceLang] = source;
      changed = true;
    }

    for (const locale of locales) {
      if (locale === sourceLang) continue;
      const current = normalizeDescriptionSpace(map[locale] || '');
      if (!current || current.length >= source.length * maxLocaleRatio) continue;

      map[locale] = source;
      job.needsRetranslation = true;
      repaired += 1;
      changed = true;
    }

    if (changed) job.descriptionByLocale = map;
  }

  return repaired;
}

async function enrichAlpiqJobDescription(job, timeoutMs) {
  let bestDescription = normalizeDescriptionSpace(job.description);

  const considerDetail = (html) => {
    const detail = parseAlpiqDetailHtml(html);
    const candidate = preferAlpiqDetailDescription(job.description, detail);
    if (candidate.split(/\s+/).filter(Boolean).length
      > bestDescription.split(/\s+/).filter(Boolean).length) {
      bestDescription = candidate;
    }
  };

  try {
    const detailHtml = await fetchHtml(job.url, {
      timeoutMs,
      headers: { Accept: 'text/html', 'User-Agent': UA },
      label: `alpiq detail ${job.jobId}`,
    });
    considerDetail(detailHtml);
  } catch (err) {
    console.warn(`   ⚠️ Alpiq detail ${job.jobId}: ${err?.message || err} — keeping listing description.`);
  }

  // A direct 200 can still be a generic shell that carries no role content.
  // Give the clean-IP reader one explicit quality-gated chance before the
  // caller decides that the snapshot is incomplete.
  if (bestDescription.split(/\s+/).filter(Boolean).length < MIN_RICH_DETAIL_WORDS) {
    try {
      const proxyHtml = await fetchHtmlViaJinaWithRetry(job.url, { timeoutMs });
      if (proxyHtml) considerDetail(proxyHtml);
    } catch (err) {
      console.warn(`   ⚠️ Alpiq Jina detail ${job.jobId}: ${err?.message || err}`);
    }
  }

  if (bestDescription.split(/\s+/).filter(Boolean).length >= MIN_RICH_DETAIL_WORDS) {
    return {
      ...job,
      description: bestDescription,
      _alpiqDetailIncomplete: false,
    };
  }

  console.warn(
    `   ⚠️ Alpiq detail ${job.jobId}: no rich role description after direct + Jina fetch; deferring this snapshot.`,
  );
  return { ...job, _alpiqDetailIncomplete: true };
}

/**
 * Fetch all pages of Alpiq job listings.
 */
export async function fetchAlpiqListingPages(maxPages = 10, timeoutMs = 15000) {
  const allJobs = [];
  const seen = new Set();
  for (let page = 1; page <= maxPages; page++) {
    const url = alpiqListingPageUrl(page);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'text/html', 'User-Agent': UA },
        redirect: 'follow',
      });
      if (!res.ok) break;
      const html = await res.text();
      if (looksLikeAntiBotChallenge(html)) {
        // 200 status but a challenge page — parses to 0 jobs and is
        // otherwise indistinguishable from genuine end-of-pagination. Skip
        // this page rather than stopping the whole crawl on it.
        console.warn(`   ⚠️ Alpiq page ${page}: anti-bot challenge page detected — skipping, continuing pagination.`);
        continue;
      }
      // Parse the FULL page (all locations), not the Swiss-filtered subset, to
      // drive pagination: Alpiq interleaves non-Swiss postings, so a page with
      // zero Swiss jobs (e.g. page 1 = Praha/Madrid/Milano) must NOT stop the
      // crawl before later pages that do carry Swiss jobs.
      const pageJobs = parseAlpiqListingHtml(html, { swissOnly: false });
      if (pageJobs.length === 0) break;
      // Out-of-range page numbers are clamped to the last page and re-served, so
      // a page that adds no new job ids means we've reached the end.
      const fresh = pageJobs.filter((j) => !seen.has(j.jobId));
      if (fresh.length === 0) break;
      for (const j of fresh) {
        seen.add(j.jobId);
        if (isSwissLocation(j.location)) {
          allJobs.push(await enrichAlpiqJobDescription(j, timeoutMs));
        }
      }
    } catch (err) {
      console.warn(`\u26a0\ufe0f Failed to fetch Alpiq page ${page}: ${err.message}`);
      break;
    } finally {
      clearTimeout(timer);
    }
  }

  return allJobs;
}

/**
 * Infer employment type from title, description and optional percentage field.
 * Swiss job postings commonly include percentage (e.g. "80-100%").
 * @param {string} title
 * @param {string} description
 * @param {string} percentage
 * @returns {string} FULL_TIME or PART_TIME
 */
export function inferEmploymentType(title = '', description = '', percentage = '') {
  const combined = `${title} ${percentage} ${description}`;
  if (/part[- ]?time|teilzeit|tempo parziale|temps partiel/i.test(combined)) return 'PART_TIME';
  const pctMatch = combined.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || combined.match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2]) : parseInt(pctMatch[1]);
    if (maxPct < 80) return 'PART_TIME';
  }
  return 'FULL_TIME';
}
