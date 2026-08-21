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
import { extractVacancies } from './extract.mjs';
import { extractLinks } from './careers-trail.mjs';
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
 * Run a spec and return listing rows in the shape the generated parser's
 * `fetchJobListings()` contract expects.
 *
 * Rows the spec's own detail template rejects are dropped: the template is the
 * one piece of evidence that a link belongs to the listing rather than to the
 * navigation around it, and in production — unattended — a chrome link becomes
 * a published fake vacancy.
 *
 * @param {import('./synthesize.mjs').CrawlerSpec} spec
 * @returns {Promise<{ title: string, url: string, location: string, postedAt: string|null, company: string }[]>}
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
    for (const v of vacancies) {
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
        postedAt: v.postedDate || null,
        company: v.company || spec.companyName,
      });
    }
  }
  return [...bySlug.values()];
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
