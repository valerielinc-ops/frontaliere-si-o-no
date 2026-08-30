/**
 * Production runtime for a synthesised crawler.
 *
 * A crawler promoted by the prospector is not a hand-written parser: it is a
 * declarative spec (`data/prospector/crawlers/<key>.json`) plus this runtime.
 * Everything vendor-specific lives in the spec, so a listing that changes shape
 * is a data fix, not a code fix — which is what makes hundreds of micro-employer
 * crawlers maintainable at all.
 *
 * Deliberately fetches through `fetchHtml` from crawler-template rather than the
 * prospector's own polite client: in production a crawler must inherit the
 * retry, anti-bot and clean-IP fallback behaviour the other 580 crawlers have.
 * The prospector's client is tuned for discovery — one request per host per
 * second across thousands of strangers — and would make a production run
 * needlessly slow and needlessly fragile.
 *
 * The extraction itself is the same cascade the prospector graded, so what runs
 * in production is what the quality gate measured. Anything else would make the
 * grade a statement about a different program.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fetchHtml } from '../crawler-template.mjs';
import { extractVacancies, extractDetailFields } from './extract.mjs';
import { extractLinks } from './careers-trail.mjs';
import { normalizeHost } from './registrable.mjs';
import { PROSPECTOR_DIR } from './config.mjs';

/**
 * @param {string} companyKey
 * @param {string} [dir]
 * @returns {import('./synthesize.mjs').CrawlerSpec}
 */
export function loadSpec(companyKey, dir = path.join(PROSPECTOR_DIR, 'crawlers')) {
  const file = path.join(dir, `${companyKey}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Match links directly against an already-learned detail template.
 *
 * `extractByTemplate` (the generic discovery cascade) refuses any cluster
 * with fewer than two same-shaped links, because when the template itself is
 * unknown a lone link is as likely to be chrome as a vacancy. In production
 * the template was already learned from a real, graded sample — it is
 * evidence, not a guess — so a single matching link is exactly as
 * trustworthy as two. Without this, a company whose listing drops to one
 * open role reports zero jobs forever, purely from the size-2 floor, not
 * because anything on the page changed shape (observed on
 * recruitingapp-2563, #6660).
 *
 * @param {{ url: string, text: string }[]} links
 * @param {RegExp} templateRx
 * @param {string} host
 * @returns {{ title: string, url: string, via: 'known-template' }[]}
 */
function matchKnownTemplate(links, templateRx, host) {
  const seen = new Set();
  const out = [];
  for (const l of links) {
    let u;
    try { u = new URL(l.url); } catch { continue; }
    if (normalizeHost(u.hostname) !== host) continue;
    if (!templateRx.test(u.pathname)) continue;
    if (seen.has(l.url)) continue;
    seen.add(l.url);
    const title = (l.text || '').replace(/\s+/g, ' ').trim();
    if (title.length <= 3) continue;
    out.push({ title: title.slice(0, 180), url: l.url, via: 'known-template' });
  }
  return out;
}

/**
 * Run a spec and return listing rows in the shape the generated parser's
 * `fetchJobListings()` contract expects.
 *
 * Rows the spec's own detail template rejects are dropped: the template is the
 * one piece of evidence that a link belongs to the listing rather than to the
 * navigation around it, and in production — unattended — a chrome link becomes
 * a published fake vacancy.
 *
 * @param {import('./synthesize.mjs').CrawlerSpec} spec
 * @returns {Promise<{ title: string, url: string, location: string, description: string, postedAt: string|null, company: string }[]>}
 */
export async function runSpecInProduction(spec) {
  /** @type {Map<string, any>} */
  const bySlug = new Map();
  const templateRx = spec.detailTemplate ? templateToRegex(spec.detailTemplate) : null;

  for (const seed of spec.seedUrls || []) {
    let html;
    try {
      html = await fetchHtml(seed);
    } catch (err) {
      // Let the standard pipeline classify it: a connection-level failure is
      // infra and must soft-exit, an HTTP status is a real break.
      throw err;
    }
    if (!html) continue;
    const links = extractLinks(html, seed);
    const { vacancies } = extractVacancies(html, seed, links);
    // jsonld/microdata are stronger evidence than any link-shape guess, so
    // only override when the generic cascade fell back to (or below) its own
    // template heuristic and we hold a better one already vetted for this spec.
    let candidates = vacancies;
    if (templateRx && vacancies.every((v) => v.via !== 'jsonld' && v.via !== 'microdata')) {
      let host = '';
      try { host = normalizeHost(new URL(seed).hostname); } catch { /* skip override */ }
      const direct = host ? matchKnownTemplate(links, templateRx, host) : [];
      if (direct.length) candidates = direct;
    }
    for (const v of candidates) {
      if (!v.title || !v.url) continue;
      if (templateRx) {
        let pathname = '';
        try { pathname = new URL(v.url).pathname; } catch { continue; }
        if (!templateRx.test(pathname)) continue;
      }
      if (bySlug.has(v.url)) continue;
      bySlug.set(v.url, {
        title: v.title,
        url: v.url,
        location: v.location || '',
        description: v.description || '',
        postedAt: v.postedDate || null,
        company: v.company || spec.companyName,
      });
    }
  }
  const rows = [...bySlug.values()];
  if (!spec.detailEnrichment) return rows;

  // Template extraction has no per-row semantics. Visit the detail pages with
  // a bounded pool so location and full descriptions are source-backed.
  const enriched = [];
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const row = rows[next++];
      try {
        const detail = extractDetailFields(await fetchHtml(row.url), row.url);
        const location = detail.location || row.location;
        const description = detail.description || row.description;
        if (!location || !description) continue;
        enriched.push({ ...row, title: detail.title || row.title, location, description,
          postedAt: detail.postedDate || row.postedAt,
          employmentType: detail.employmentType || row.employmentType });
      } catch (err) {
        // A row without both source-backed fields must not be published with a
        // fabricated employer default. Keep already complete index rows only.
        if (row.location && row.description) enriched.push(row);
      }
    }
  };
  const concurrency = Math.max(1, Math.min(8, Number(spec.detailFetchWorkers) || 4));
  await Promise.all(Array.from({ length: concurrency }, worker));
  return enriched;
}

/**
 * Turn a `/annunci-lavoro/*` style template into a matcher.
 *
 * `*` stands for one variable segment and `#` for a numeric one — the same two
 * placeholders `pathTemplate()` emits, so a template always round-trips.
 *
 * @param {string} template
 * @returns {RegExp}
 */
export function templateToRegex(template) {
  const body = template
    .split('/')
    .map((seg) => {
      if (seg === '*') return '[^/]+';
      if (seg === '#') return '\\d+';
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return new RegExp(`^${body}/?$`);
}
