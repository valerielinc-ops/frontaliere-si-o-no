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
import { decodeEntities, normalizeSpace, extractBalancedTagBlock } from './hospital-custom-html-helpers.mjs';
import { htmlToTextLines } from './html-to-text-lines.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';

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
    // Hash char-class is `[a-z0-9-]`, not `[a-z0-9]`: onlyfy hashes are opaque
    // and a `-` separator must NOT make this guard reject an otherwise-valid
    // job card (that would silently drop the role from the listing). Keep in
    // lockstep with the `matchKey` regex in the per-tenant update scripts.
    if (!/\/job\/[a-z0-9-]+/i.test(path)) continue;
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

/**
 * URL of the job ad itself for an onlyfy.jobs detail URL.
 *
 * The public detail page (`/{lang}/job/{handle}`) is a Next.js shell: its
 * server HTML carries only "Alle Jobs · Datenschutzhinweis | Impressum", and
 * the ad is rendered client-side in an iframe pointing at
 * `/job/show/{handle}/full?lang={lang}&mode=candidate` (JobPageContainer in the
 * career-page bundle). A `<p>/<li>` sweep of the shell found no role text on
 * any vacancy, so both tenants published a synthesised stub instead.
 *
 * @param {string} jobUrl  e.g. https://spitex-zuerich.onlyfy.jobs/de/job/ypv2le9p78ygmhn2pogybj1gphgx2ls
 * @returns {string}       '' when the URL is not an onlyfy job URL
 */
export function onlyfyFullAdUrl(jobUrl = '') {
  let url;
  try {
    url = new URL(jobUrl);
  } catch {
    return '';
  }
  const match = url.pathname.match(/^\/(?:([a-z]{2})\/)?job\/([a-z0-9-]+)\/?$/i);
  if (!match) return '';
  const lang = (match[1] || 'de').toLowerCase();
  return `${url.origin}/job/show/${match[2]}/full?lang=${lang}&mode=candidate`;
}

/**
 * Text of an onlyfy job ad (the `/job/show/{handle}/full` document), one line
 * per paragraph/heading and `• ` list items, without page chrome.
 *
 * Two ad templates are live on the portal:
 *   - the component template (`job-ad-component`, e.g. vamed-ag-ch): the ad is
 *     the `<main>` element, followed inside it by the apply button, the
 *     contact persons and the social links → read `<main>` up to the
 *     `apply-button-element` anchor. The hidden `step-stone-job-ad` copy after
 *     `</main>` is never read;
 *   - the prescreen template (`ja-wrap`, e.g. spitex-zuerich): the ad is the
 *     `ja-block` (intro, subtitle and the itemprop sections), followed by the
 *     apply buttons (`mobile-hidden` / `mobile-view`) and the contact card →
 *     read `ja-block` up to the first of those blocks, title `<h1>` dropped.
 *
 * @param {string} html
 * @returns {string} '' when neither template is found
 */
export function extractOnlyfyJobAdText(html = '') {
  const page = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  const main = /<main\b[^>]*>/i.exec(page);
  if (main && /\bjob-ad-component\b/.test(page)) {
    let body = extractBalancedTagBlock(page.slice(main.index + main[0].length), 'main', page.length);
    const apply = body.search(/<a\b[^>]*\bapply-button-element\b/i);
    if (apply >= 0) body = body.slice(0, apply);
    return tidyAdText(htmlToTextLines(body));
  }

  const block = /<div\b[^>]*class="[^"]*\bja-block\b[^"]*"[^>]*>/i.exec(page);
  if (block) {
    let body = extractBalancedTagBlock(page.slice(block.index + block[0].length), 'div', page.length);
    const chrome = body.search(/<div\b[^>]*class="[^"]*\b(?:mobile-hidden|mobile-view|btn-section|contact-section)\b/i);
    if (chrome >= 0) body = body.slice(0, chrome);
    body = body.replace(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi, '');
    return tidyAdText(htmlToTextLines(body));
  }
  return '';
}

// Benefit cards and empty template paragraphs leave runs of blank lines and
// bullet markers without text.
function tidyAdText(text = '') {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '•')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// What an ad URL answers with instead of the ad: a consent or cookie wall, an
// error page, a vacancy that is no longer online. Checked on the opening of
// the text, where such a page states what it is.
const NOT_AN_AD_LEAD_RE = /^\s*(?:cookie[- ]?(?:einstellungen|settings|richtlinie|policy|hinweis)|wir verwenden cookies|we use cookies|diese (?:website|webseite|seite) verwendet cookies|this (?:website|site) uses cookies|datenschutzeinstellungen|privacy (?:settings|preferences)|einwilligung|zustimmung|consent\b|404\b|500\b|seite nicht gefunden|page not found|nicht gefunden|not found\b|fehler\b|error\b|zugriff verweigert|access denied|forbidden\b|(?:diese|die) (?:stelle|stellenanzeige|position) ist nicht mehr|this (?:job|position|vacancy) is no longer|stelle nicht (?:gefunden|verfügbar))/i;

/**
 * True when text read from an onlyfy ad document is the ad itself: a body
 * long enough to stand on its own (source-body-floor, 50 words) that is not a
 * consent, cookie or error page the ad URL answered with. Anything else is
 * not published as the vacancy's description.
 *
 * @param {string} text  output of `extractOnlyfyJobAdText`
 * @returns {boolean}
 */
export function isOnlyfyJobAdText(text = '') {
  const body = String(text || '').trim();
  if (!body || NOT_AN_AD_LEAD_RE.test(body)) return false;
  return meetsSourceBodyFloor(body);
}
