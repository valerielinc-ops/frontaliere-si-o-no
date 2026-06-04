#!/usr/bin/env node
/**
 * Helpers to extract the rich job description from Umantis vacancy detail pages.
 *
 * Some Umantis tenants (e.g. Inselspital 2624) ship a SPA shell at
 * `/Vacancies/{ID}/Description/1` — only `<div id="root">` plus a bundle.js
 * pointer. Other tenants on the SAME ATS server-render the full content
 * including all "Aufgaben / Profil / Wir bieten" sections directly in the
 * HTML — verified May 2026 for:
 *
 *   - tenant 2939 (See-Spital):     `<h2 id="expander-N">` + `<div id="expandable-N">`
 *   - tenant 2736 (Spital Männedorf): `<h3>` + `<div class="padding">`
 *
 * This helper auto-detects the layout per page, walks the headings, and
 * returns a `Section`-headed plain-text body that satisfies the
 * boilerplate-guard `CONTENT_HEADINGS_RE` (Aufgaben/Anforderungen/Compiti/
 * Profilo/...). When a tenant turns out to be SPA-only, the helper returns
 * an empty string and the caller falls back to the listing snippet.
 */
import { stripHtml, normalizeSpace } from './crawler-template.mjs';

const DEFAULT_TIMEOUT_MS = 20_000;
const FETCH_DELAY_MS = 250;

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

function decodeEntities(s = '') {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function pause(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Decide whether a redirect `Location` points AWAY from the Umantis tenant host
 * that served the detail URL. A same-host redirect (e.g. `?lang=` canon,
 * trailing-slash) is benign and should be followed; a cross-host redirect means
 * the tenant deprecated the Umantis detail URL and now bounces the visitor to
 * its public career site / a migrated ATS (Prospective et al.) — the detail URL
 * is effectively dead and yields no per-job body (issue #1245).
 *
 * @param {string} requestUrl   the original detail URL we requested
 * @param {string} locationHdr  the `Location` response header (may be relative)
 * @returns {boolean} true when the redirect leaves the original host
 */
export function isCrossHostRedirect(requestUrl, locationHdr) {
  if (!locationHdr) return false;
  let target;
  let origin;
  try {
    origin = new URL(requestUrl);
    target = new URL(locationHdr, requestUrl); // resolve relative Location
  } catch {
    return false;
  }
  return target.hostname.toLowerCase() !== origin.hostname.toLowerCase();
}

/**
 * Fetch one Umantis vacancy detail page and report the "dead detail URL"
 * failure mode (issue #1245): several tenants now 3xx-redirect the
 * `/Vacancies/{id}/Description/1` URL AWAY from the umantis host (→ public site
 * / Prospective ATS), so the body carries no per-job content. On a cross-host
 * redirect we flag `deadDetail: true` and DO NOT follow it — following would
 * land on careers chrome that the extractor otherwise turns into synthetic
 * boilerplate that the dataset boilerplate-guard then hard-fails on.
 *
 * Returns `{ html, deadDetail }`:
 *   - `html` — raw HTML body of the (same-host) detail page, '' on
 *     error/redirect/dead-detail.
 *   - `deadDetail` — true only when the detail URL redirected cross-host (source
 *     migrated away) → caller must quarantine the job, never synthesise
 *     boilerplate.
 *
 * Graceful degradation: any network/HTTP error yields `{ html: '', deadDetail:
 * false }` so the crawler keeps going on the listing snippet (unchanged
 * behaviour — only the new cross-host case is special-cased).
 *
 * @param {string} baseUrl  e.g. `https://recruitingapp-2939.umantis.com`
 * @param {string|number} vacancyId
 * @param {object} [opts]
 * @param {string} [opts.lang='ger']
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ html: string, deadDetail: boolean }>}
 */
export async function fetchUmantisDetailResult(baseUrl, vacancyId, opts = {}) {
  const lang = opts.lang || 'ger';
  const timeoutMs = Number(opts.timeoutMs)
    || Number(process.env.JOBS_CRAWLER_TIMEOUT_MS)
    || DEFAULT_TIMEOUT_MS;
  const url = `${baseUrl}/Vacancies/${vacancyId}/Description/1?lang=${lang}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // `redirect: 'manual'` so we can inspect a cross-host 3xx instead of
    // silently landing on the migrated public site.
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*' },
      signal: controller.signal,
      redirect: 'manual',
    });
    clearTimeout(timer);

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location') || '';
      if (isCrossHostRedirect(url, location)) {
        return { html: '', deadDetail: true }; // migrated away → dead detail
      }
      // Same-host redirect (lang/canon): follow it once.
      try {
        const followUrl = new URL(location, url).toString();
        const res2 = await fetch(followUrl, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*' },
          redirect: 'follow',
        });
        if (!res2.ok) return { html: '', deadDetail: false };
        return { html: await res2.text(), deadDetail: false };
      } catch {
        return { html: '', deadDetail: false };
      }
    }

    if (!res.ok) return { html: '', deadDetail: false };
    return { html: await res.text(), deadDetail: false };
  } catch {
    clearTimeout(timer);
    return { html: '', deadDetail: false };
  }
}

/**
 * Fetch one Umantis vacancy detail page HTML. Returns the raw HTML body, or
 * the empty string on any HTTP/network error (graceful degradation — the
 * crawler keeps going with the listing snippet only).
 *
 * Thin wrapper over {@link fetchUmantisDetailResult} for callers that only need
 * the HTML and don't distinguish the dead-detail case.
 *
 * @param {string} baseUrl  e.g. `https://recruitingapp-2939.umantis.com`
 * @param {string|number} vacancyId
 * @param {object} [opts]
 * @param {string} [opts.lang='ger']
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<string>}
 */
export async function fetchUmantisDetailHtml(baseUrl, vacancyId, opts = {}) {
  const { html } = await fetchUmantisDetailResult(baseUrl, vacancyId, opts);
  return html;
}

/**
 * Extract a section-headed plain-text description from a Umantis detail HTML.
 *
 * Detection strategy:
 *   1. Layout A — "expander" (tenant 2939):
 *        `<h2 id="expander-N">Heading</h2>` followed by
 *        `<div id="expandable-N" class="close">…</div>`
 *   2. Layout B — "h3+padding" (tenant 2736):
 *        `<h3>Heading</h3>` followed by `<div class="padding">…</div>`
 *
 * Returns an empty string when no recognised layout is present (e.g. SPA
 * shells like tenant 2624). The caller falls back to the listing snippet.
 *
 * @param {string} html
 * @returns {string} Section-headed plain text, multiple sections joined by `\n\n`.
 */
export function extractUmantisDetailContent(html = '') {
  if (!html || typeof html !== 'string' || html.length < 200) return '';

  // Strip <script>/<style>/comments first — pages embed JS that would otherwise
  // leak into the extracted text.
  const cleaned = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  const sections = [];

  // Layout A: expander
  const expanderRx = /<h2\s+id="expander-(\d+)"[^>]*>([\s\S]*?)<\/h2>\s*<div\s+id="expandable-\1"[^>]*>([\s\S]*?)<\/div>/g;
  let am;
  while ((am = expanderRx.exec(cleaned))) {
    const heading = normalizeSpace(decodeEntities(stripHtml(am[2])));
    if (!heading) continue;
    let body = am[3]
      .replace(/<li[^>]*>/gi, '\n• ')
      .replace(/<\/li\s*>/gi, '')
      .replace(/<br\s*\/?>(?!\s*<)/gi, '\n')
      .replace(/<\/(?:p|div|h[1-6])\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ');
    body = normalizeSpace(decodeEntities(body)).replace(/\s*•\s*/g, '\n• ');
    if (body && body.length > 10) sections.push(`${heading}\n${body}`);
  }

  // Layout B: h3 + padding
  if (sections.length === 0) {
    const h3Rx = /<h3[^>]*>([\s\S]*?)<\/h3>\s*<div\s+class="padding"[^>]*>([\s\S]*?)<\/div>/g;
    let bm;
    while ((bm = h3Rx.exec(cleaned))) {
      const heading = normalizeSpace(decodeEntities(stripHtml(bm[1])));
      if (!heading) continue;
      let body = bm[2]
        .replace(/<li[^>]*>/gi, '\n• ')
        .replace(/<\/li\s*>/gi, '')
        .replace(/<br\s*\/?>(?!\s*<)/gi, '\n')
        .replace(/<\/(?:p|div|h[1-6])\s*>/gi, '\n')
        .replace(/<[^>]+>/g, ' ');
      body = normalizeSpace(decodeEntities(body)).replace(/\s*•\s*/g, '\n• ');
      if (body && body.length > 10) sections.push(`${heading}\n${body}`);
    }
  }

  return sections.join('\n\n');
}

/**
 * Convenience: fetch+extract+sleep in one call, returning both the extracted
 * content and the dead-detail flag.
 *
 *   - `content`    — section-headed plain text, or '' (SPA shell / no layout /
 *                    error / dead detail).
 *   - `deadDetail` — true when the detail URL redirected cross-host (source
 *                    migrated away, issue #1245) → caller must quarantine the
 *                    job, never synthesise boilerplate.
 *
 * @param {string} baseUrl
 * @param {string|number} vacancyId
 * @param {object} [opts]
 * @param {string} [opts.lang='ger']
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.delayMs] Politeness pause AFTER the request resolves.
 * @returns {Promise<{ content: string, deadDetail: boolean }>}
 */
export async function fetchUmantisDetailContentResult(baseUrl, vacancyId, opts = {}) {
  const { html, deadDetail } = await fetchUmantisDetailResult(baseUrl, vacancyId, opts);
  const content = deadDetail ? '' : extractUmantisDetailContent(html);
  if (opts.delayMs !== 0) {
    await pause(Number(opts.delayMs) || FETCH_DELAY_MS);
  }
  return { content, deadDetail };
}

/**
 * Convenience: fetch+extract+sleep in one call. Returns '' on any failure or
 * when the detail page is a SPA shell / dead (cross-host redirect).
 *
 * Backward-compatible wrapper over {@link fetchUmantisDetailContentResult} for
 * callers that don't need the dead-detail flag.
 *
 * @param {string} baseUrl
 * @param {string|number} vacancyId
 * @param {object} [opts]
 * @param {string} [opts.lang='ger']
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.delayMs] Politeness pause AFTER the request resolves.
 * @returns {Promise<string>}
 */
export async function fetchUmantisDetailContent(baseUrl, vacancyId, opts = {}) {
  const { content } = await fetchUmantisDetailContentResult(baseUrl, vacancyId, opts);
  return content;
}
