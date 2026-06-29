/**
 * Coop — Detail page parser for post-processing.
 *
 * After the base crawler runs, this module re-validates each Coop job
 * against the JSON-LD data on the detail page to fix title mismatches
 * and ensure description quality.
 */

import { JSDOM } from 'jsdom';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────────
// Title overlap guard
// ─────────────────────────────────────────────────────────────

function normWords(s = '') {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

export function titleOverlap(expected = '', actual = '') {
  const expWords = normWords(expected);
  const actWords = new Set(normWords(actual));
  if (expWords.length === 0) return 1;
  return expWords.filter((w) => actWords.has(w)).length / expWords.length;
}

// ─────────────────────────────────────────────────────────────
// JSON-LD extraction from Coop detail pages
// ─────────────────────────────────────────────────────────────

/**
 * Fetch a Coop detail page and extract the JSON-LD JobPosting data.
 */
export async function fetchCoopJsonLd(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html',
        'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    return extractJsonLd(html);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract JSON-LD JobPosting from HTML.
 */
export function extractJsonLd(html = '') {
  // Permissive regex: tolerate single quotes, reordered attributes and a
  // missing/relocated `type=` — mirrors the robust extractor introduced for
  // Straumann (straumann-job-parser.mjs). Coop is ~95% of job volume, so a
  // silent regex miss on markup drift would drop recoverable listings.
  const matches = [...String(html).matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of matches) {
    try {
      const data = JSON.parse(m[1]);
      // Handle bare object, top-level array and @graph containers; match
      // `@type` as array/string via includes() instead of strict equality.
      const candidates = Array.isArray(data) ? data : Array.isArray(data?.['@graph']) ? data['@graph'] : [data];
      for (const node of candidates) {
        if (String(node?.['@type'] || '').includes('JobPosting')) return node;
      }
    } catch {}
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// HTML → Markdown converter for JSON-LD description
// ─────────────────────────────────────────────────────────────

export function coopDescHtmlToMarkdown(html = '') {
  if (!html || !html.trim()) return '';

  const dom = new JSDOM(`<div id="root">${html}</div>`);
  const root = dom.window.document.getElementById('root');
  if (!root) return '';

  const lines = [];

  function processNode(el) {
    for (const child of el.childNodes) {
      if (child.nodeType === 3) {
        const text = child.textContent.replace(/\s+/g, ' ').trim();
        if (text) lines.push(text);
        continue;
      }
      if (child.nodeType !== 1) continue;

      const tag = child.tagName.toLowerCase();

      if (/^h[1-3]$/.test(tag)) {
        const text = normalizeSpace(child.textContent);
        if (text) lines.push('', `## ${text}`);
        continue;
      }

      if (tag === 'ul' || tag === 'ol') {
        const items = child.querySelectorAll(':scope > li');
        for (const li of items) {
          const text = normalizeSpace(li.textContent);
          if (text) lines.push(`- ${text}`);
        }
        continue;
      }

      if (tag === 'li') continue;
      if (tag === 'br') continue;

      if (tag === 'div') {
        const text = normalizeSpace(child.textContent);
        if (!text) continue;
        // Check if this div is a section header (short, followed by ul)
        const next = child.nextElementSibling;
        const isHeader = text.length < 60 && (next?.tagName?.toLowerCase() === 'ul' || next?.tagName?.toLowerCase() === 'br');
        if (isHeader && !text.includes('.')) {
          lines.push('', `## ${text}`);
        } else {
          // Recurse into div with children, or output text for leaf divs
          const hasChildElements = Array.from(child.childNodes).some((n) => n.nodeType === 1);
          if (hasChildElements) {
            processNode(child);
          } else {
            lines.push(text);
          }
        }
        continue;
      }

      if (tag === 'p') {
        const hasChildElements = Array.from(child.childNodes).some((n) => n.nodeType === 1);
        if (hasChildElements) {
          processNode(child);
        } else {
          const text = normalizeSpace(child.textContent);
          if (text) lines.push(text);
        }
        continue;
      }

      // Default: recurse
      processNode(child);
    }
  }

  processNode(root);

  // Deduplicate consecutive identical lines
  const result = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' && result.length > 0 && result[result.length - 1].trim() === '') continue;
    if (result.length > 0 && result[result.length - 1].trim() === trimmed && trimmed !== '') continue;
    result.push(trimmed);
  }

  return result.join('\n').trim();
}

// ─────────────────────────────────────────────────────────────
// Canton normalization (local copy — same logic as update-coop-jobs.mjs)
// ─────────────────────────────────────────────────────────────

function normalizeCantonCode(raw = '', fallback = '') {
  const lower = String(raw || '').trim().toLowerCase();
  if (['ti', 'ticino', 'tessin'].includes(lower)) return 'TI';
  if (['gr', 'grigioni', 'graubunden', 'graubünden', 'grisons'].includes(lower)) return 'GR';
  return fallback || '';
}

// ─────────────────────────────────────────────────────────────
// Apply JSON-LD location/company data to a job object (pure fn)
// ─────────────────────────────────────────────────────────────

/**
 * Apply authoritative location and company data from JSON-LD to a job object.
 * Returns { job, changed } where `job` is a shallow copy with updated fields.
 */
export function applyCoopJsonLdToJob(job, jsonLd) {
  const updated = { ...job };
  let changed = false;

  // Location update from JSON-LD (authoritative source for actual work location)
  const ldLocality = (jsonLd?.jobLocation?.address?.addressLocality || '').trim();
  const ldRegion = (jsonLd?.jobLocation?.address?.addressRegion || '').trim();
  if (ldLocality && ldLocality !== updated.addressLocality) {
    updated.location = ldLocality;
    updated.addressLocality = ldLocality;
    changed = true;
  }
  if (ldRegion) {
    const ldCanton = normalizeCantonCode(ldRegion, updated.canton);
    if (ldCanton && ldCanton !== updated.canton) {
      updated.canton = ldCanton;
      updated.addressRegion = ldCanton;
      changed = true;
    }
  }

  // Company update — use store-specific name if more specific than "Coop" alone
  const ldCompany = (jsonLd?.hiringOrganization?.name || '').trim();
  if (ldCompany && ldCompany.length > 4 && ldCompany !== updated.company) {
    updated.company = ldCompany;
    changed = true;
  }

  return { job: updated, changed };
}

// ─────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────

export function validateCoopDescription(markdown = '', sourceHtmlLength = 0) {
  const warnings = [];
  const textLength = markdown.replace(/[#\-*>\n]/g, ' ').replace(/\s+/g, ' ').trim().length;

  if (textLength < 200) {
    warnings.push(`Description too short: ${textLength} chars (minimum 200)`);
  }

  if (sourceHtmlLength > 0) {
    const ratio = textLength / sourceHtmlLength;
    if (ratio < 0.15) {
      warnings.push(`Coverage ratio too low: ${(ratio * 100).toFixed(1)}% (minimum 15%)`);
    }
  }

  // Count content blocks
  const headings = (markdown.match(/^#{2,4}\s+/gm) || []).length;
  const listItems = (markdown.match(/^- /gm) || []).length;
  if (headings === 0 && listItems === 0 && textLength < 400) {
    warnings.push('No structured sections found (no headings or lists)');
  }

  return { ok: warnings.length === 0, warnings };
}

// ─────────────────────────────────────────────────────────────
// Translation cache entry shape
// ─────────────────────────────────────────────────────────────

/**
 * Build the lightweight cache record persisted to
 * `data/jobs/by-crawler/coop-ticino-locale-cache.json` for a single Coop job.
 *
 * Why redirect history MUST be preserved (404-risk, issue #2962):
 * Coop is the only crawler with a translation cache, and its slugs churn
 * heavily because the slice often re-translates from scratch when validation
 * fails. When the slice is missing from `data/jobs.json`, this cache is the
 * sole source the next run re-injects jobs from
 * (`injectCachedCoopTranslations`). A job restored WITHOUT its
 * `previousSlugs` / `previousSlugsByLocale` loses its slug-redirect history,
 * so `jobsSeoPagesPlugin` can no longer emit the bridge pages that keep
 * previously-indexed (and sitemap-referenced) old URLs served — they turn
 * into silent GitHub Pages 404s instead of self-healing. Carrying the two
 * redirect-history fields through the cache round-trip keeps the served set
 * aligned with the sitemap across cache re-injection.
 *
 * Pure (no IO, no `Date.now()`): the caller stamps `cachedAt` so this stays
 * deterministic and unit-testable. Redirect-history fields are emitted only
 * when non-empty to avoid churning the committed cache file with empty
 * `[]` / `{}` placeholders.
 *
 * @param {Record<string, any>} job
 * @returns {Record<string, any>}
 */
export function buildCoopTranslationCacheEntry(job = {}) {
  const hasPrevSlugs = Array.isArray(job.previousSlugs) && job.previousSlugs.length > 0;
  const hasPrevSlugsByLocale =
    job.previousSlugsByLocale &&
    typeof job.previousSlugsByLocale === 'object' &&
    Object.keys(job.previousSlugsByLocale).length > 0;
  return {
    url: job.url,
    slug: job.slug,
    title: job.title,
    company: job.company,
    companyKey: job.companyKey,
    location: job.location,
    canton: job.canton,
    description: job.description,
    requirements: job.requirements || [],
    titleByLocale: job.titleByLocale || {},
    descriptionByLocale: job.descriptionByLocale || {},
    requirementsByLocale: job.requirementsByLocale || {},
    slugByLocale: job.slugByLocale || {},
    // Redirect history — keep old URLs served via bridge pages after a cache
    // round-trip (issue #2962). Omitted when empty to avoid cache-file churn.
    ...(hasPrevSlugs ? { previousSlugs: job.previousSlugs } : {}),
    ...(hasPrevSlugsByLocale ? { previousSlugsByLocale: job.previousSlugsByLocale } : {}),
    postedDate: job.postedDate,
    crawledAt: job.crawledAt,
    source: job.source,
    sourceLang: job.sourceLang,
  };
}
