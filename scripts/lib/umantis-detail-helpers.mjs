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
 * Fetch one Umantis vacancy detail page HTML. Returns the raw HTML body, or
 * the empty string on any HTTP/network error (graceful degradation — the
 * crawler keeps going with the listing snippet only).
 *
 * @param {string} baseUrl  e.g. `https://recruitingapp-2939.umantis.com`
 * @param {string|number} vacancyId
 * @param {object} [opts]
 * @param {string} [opts.lang='ger']
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<string>}
 */
export async function fetchUmantisDetailHtml(baseUrl, vacancyId, opts = {}) {
  const lang = opts.lang || 'ger';
  const timeoutMs = Number(opts.timeoutMs)
    || Number(process.env.JOBS_CRAWLER_TIMEOUT_MS)
    || DEFAULT_TIMEOUT_MS;
  const url = `${baseUrl}/Vacancies/${vacancyId}/Description/1?lang=${lang}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return '';
    return await res.text();
  } catch {
    clearTimeout(timer);
    return '';
  }
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
 * Convenience: fetch+extract+sleep in one call. Returns '' on any failure or
 * when the detail page is a SPA shell.
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
  const html = await fetchUmantisDetailHtml(baseUrl, vacancyId, opts);
  const content = extractUmantisDetailContent(html);
  if (opts.delayMs !== 0) {
    await pause(Number(opts.delayMs) || FETCH_DELAY_MS);
  }
  return content;
}
