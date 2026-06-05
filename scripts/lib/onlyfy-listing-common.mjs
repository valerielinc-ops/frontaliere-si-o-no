#!/usr/bin/env node
/**
 * Shared listing parser for softgarden-hosted onlyfy.jobs portals
 * (https://{tenant}.onlyfy.jobs/).
 *
 * onlyfy redesigned the listing markup (2026): the legacy
 *   <strong class="job-title"><a href="/job/{hash}">{TITLE}</a></strong>
 * with sibling `icon-map-marker` / `icon-time` cells was replaced by a card:
 *   <a data-testid="job-card" aria-label="{TITLE}" href="/{lang}/job/{hash}"> …
 *     <h3 data-testid="job-title">{TITLE}</h3> …
 *     <div data-testid="job-more-info">{Location} | {Type} | {Date}</div>
 *   </a>
 *
 * Both spitex-zuerich (spitex-zuerich.onlyfy.jobs) and vitrea-gesundheit
 * (vamed-ag-ch.onlyfy.jobs) sit on this exact portal, so the listing regex
 * lives here ONCE — copy-pasting it into each tenant crawler is what let the
 * two drift apart and both silently return 0 after the redesign.
 */
import { decodeEntities, normalizeSpace } from './hospital-custom-html-helpers.mjs';

/**
 * Parse an onlyfy.jobs listing page into role rows.
 *
 * @param {string} html                     listing-page HTML
 * @param {object} opts
 * @param {string} opts.portalBase          e.g. 'https://spitex-zuerich.onlyfy.jobs' (no trailing slash)
 * @param {string} [opts.defaultLocation]   fallback when the card carries no location
 * @returns {Array<{url:string, title:string, location:string, employmentTypeStr:string}>}
 */
export function parseOnlyfyListing(html, { portalBase, defaultLocation = 'Schweiz' } = {}) {
  const out = [];
  const seen = new Set();
  const base = String(portalBase || '').replace(/\/+$/, '');
  // Each role is an `<a data-testid="job-card" …>` whose opening tag carries the
  // clean title (aria-label) and the detail href; the location + employment
  // type live in a `data-testid="job-more-info"` cell inside the card.
  const cardRx = /<a\b[^>]*\bdata-testid="job-card"[^>]*>/gi;
  let m;
  while ((m = cardRx.exec(html))) {
    const openTag = m[0];
    const hrefMatch = openTag.match(/\bhref="([^"]+)"/);
    if (!hrefMatch) continue;
    const path = hrefMatch[1];
    if (!/\/job\/[a-z0-9]+/i.test(path)) continue;
    const url = /^https?:/i.test(path) ? path : `${base}${path}`;
    if (seen.has(url)) continue;

    const cardWindow = html.slice(m.index, m.index + 1600);
    const labelMatch = openTag.match(/\baria-label="([^"]*)"/);
    let title = labelMatch ? normalizeSpace(decodeEntities(labelMatch[1])) : '';
    if (!title) {
      const tMatch = cardWindow.match(/data-testid="job-title"[^>]*>([\s\S]*?)<\/h[1-6]>/i);
      title = tMatch ? normalizeSpace(decodeEntities(tMatch[1].replace(/<[^>]+>/g, ''))) : '';
    }
    if (!title || title.length < 5) continue;
    seen.add(url);

    let location = defaultLocation;
    let employmentTypeStr = '';
    const infoMatch = cardWindow.match(/data-testid="job-more-info"[^>]*>([\s\S]*?)<\/div>/i);
    if (infoMatch) {
      const parts = normalizeSpace(decodeEntities(infoMatch[1].replace(/<[^>]+>/g, ' ')))
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts[0]) location = parts[0];
      if (parts[1]) employmentTypeStr = parts[1];
    }
    out.push({ url, title, location, employmentTypeStr });
  }
  return out;
}
