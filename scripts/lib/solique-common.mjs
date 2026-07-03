#!/usr/bin/env node
/**
 * Shared factory for Swiss employers using **Solique** (live.solique.ch)
 * as their careers-portal SaaS. Solique is a Swiss-built recruiting
 * platform that server-renders the job list as HTML. Most (small/mid)
 * tenants fit their whole board on one payload (no JSON API, no pagination
 * — verified May 2026: /api/v1, /feed all 404); large retail tenants (e.g.
 * OTTO'S AG, ~167 openings) instead paginate the SSR listing 25-per-page via
 * a `?page=N` query param (verified Jul 2026) — see `paginate` config below.
 *
 * Public endpoints (no authentication):
 *
 *   GET https://live.solique.ch/{TENANT}/
 *     → HTML listing with `<div class="job…">` tiles. Tile structure varies
 *       by tenant template:
 *
 *       a) "Anchor-wrap" template (Spital Emmental; OTTO'S AG is a variant —
 *          see (c) below):
 *          <div class="job">
 *            <a href="job/details/{ID}" id="{ID}">
 *              <div class="jobtitle">…</div>
 *              <span class="workload-group">…</span>
 *              <div class="job-details">
 *                <div class="location">…</div>
 *                <div class="area">…</div>
 *                <div class="employment">…</div>
 *              </div>
 *            </a>
 *          </div>
 *
 *       b) "Link-button" template (SVAR Spitalverbund AR):
 *          <div class="job">
 *            <div class="job-group">
 *              <h3 class="jobtitle">…</h3>
 *              <div class="location">…</div>
 *              <div class="startdate">…</div>
 *              <div class="link"><a id="{ID}" href="job/details/{ID}">…</a></div>
 *            </div>
 *          </div>
 *
 *       c) "Prefixed anchor-wrap" template (OTTO'S AG, `ottosag` — Jul 2026):
 *          a same-shape variant of (a) whose outer `<div>` carries an EXTRA
 *          class token (`class="job standard"`, not bare `class="job"`) and
 *          whose anchor `href` is site-absolute with the tenant segment
 *          (`/ottosag/job/details/{ID}`, not the bare relative
 *          `job/details/{ID}` (a)/(b) use), with the title in a `<span
 *          class="jobtitle">` instead of a `<div>`/`<h[1-6]>`. `parseSoliqueListing`
 *          template (a)'s regex tolerates both variants (multi-class-token
 *          and prefixed-path superset), so this is not a separate branch.
 *
 *   GET https://live.solique.ch/{TENANT}/job/details/{ID}
 *     → Server-rendered detail HTML. Body content varies:
 *
 *       Template "intro+title-green" (Spital Emmental):
 *         `<div class="intro">…</div>` × N
 *         `<div class="title-green">…</div><ul class="list">…</ul>` × N
 *
 *       Template "offer-section" (SVAR):
 *         `<div class="offer">…</div>` with `<h4 class="sub-subtitle">…</h4>`
 *         then `<ul>…</ul>` content.
 *
 *       Template "tasks-profile-wrapper" (OTTO'S AG — Jul 2026): a balanced
 *         `<div class="tasks-profile-wrapper">` container (no `<section>`
 *         tags on the page at all) nesting `<div class="tasks-wrapper">` /
 *         `<div class="profile-wrapper">`, each opened by an `<h3
 *         class="subtitle">` heading + `<ul>` body. See
 *         `extractBalancedDivByClass` + Template (vi) below.
 *
 * Confirmed tenants (Jul 2026):
 *   - Spital Emmental (`spital-emmental`) ~50 active openings — see
 *     `scripts/lib/spital-emmental-job-parser.mjs`.
 *   - SVAR Spitalverbund Appenzell Ausserrhoden (`svar`) ~10 active
 *     openings — see `scripts/lib/svar-spitalverbund-ar-job-parser.mjs`.
 *   - OTTO'S AG (`ottosag`) ~167 active openings (retail, paginated) — see
 *     `scripts/lib/ottos-job-parser.mjs`.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, normalizeSpace, stripHtml, classAttrRx } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import {
  decodeEntities,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
  fetchHtml,
} from './hospital-custom-html-helpers.mjs';

const DETAIL_DELAY_MS = 250;

/**
 * Matches JavaScript-error-shaped strings that can leak into extracted fields
 * when a Solique tenant's JS template fails to render a variable (e.g. the
 * SVAR tenant renders literal `"location" is not defined` inside every
 * `<div class="location">` when its AngularJS/Vue binding breaks). These must
 * never propagate into title/location/description/slug. Pattern covers:
 *   - `"<identifier>" is not defined`   (ReferenceError message variant)
 *   - `<identifier> is not defined`     (bare form, same meaning)
 *   - `ReferenceError`                  (error constructor name)
 *   - `undefined`                       (lone JS falsy literal)
 * The check is case-insensitive and trims surrounding whitespace/quotes first.
 */
const JS_ERROR_RX = /^(?:"?\w[\w.]*"?\s+is\s+not\s+defined|referenceerror(?:\s*:\s*.+)?|undefined)$/i;

/**
 * Return `''` if `value` is a JS-error-shaped string (see `JS_ERROR_RX`),
 * otherwise return `value` unchanged. Used to sanitize location/title/area
 * fields extracted from live Solique pages whose JS template may be broken.
 * @param {string} value
 * @returns {string}
 */
function sanitizeField(value) {
  if (!value) return value;
  // Normalize smart/curly/guillemet quotes to straight quotes BEFORE the
  // JS_ERROR_RX test (#1849 item 2). `decodeEntities` only straightens
  // `&quot;` → `"`; a tenant emitting `&ldquo;`/`&rdquo;` (`“”`), `&lsquo;`/`&rsquo;`
  // (`‘’`) or `&laquo;`/`&raquo;` (`«»`) — all in the entity table at
  // `hospital-custom-html-helpers.mjs` — yields fancy quotes that neither the
  // leading/trailing quote strip below nor JS_ERROR_RX's `"?` anchor cover, so
  // `“location” is not defined` (or the single/guillemet variants) would bypass
  // the guard and leak the error string into the slug. Cover the full class so a
  // future quote variant does not re-open the same whack-a-mole (#1682/#1741).
  // We normalize only the value used for the test — the returned `value` keeps
  // its original quotes when it is NOT error-shaped.
  const trimmed = String(value)
    .replace(/[“”‘’«»]/g, '"')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .trim();
  return JS_ERROR_RX.test(trimmed) ? '' : value;
}

function normalize(s = '') {
  return String(s || '').trim().toLowerCase();
}

/**
 * Parse the Solique listing HTML into structured tiles. Handles both the
 * "anchor-wrap" and "link-button" templates seen across tenants.
 */
export function parseSoliqueListing(html = '') {
  if (!html || typeof html !== 'string') return [];
  const out = [];
  const seen = new Set();

  // Template (a): anchor-wrap. The `<a href="job/details/{ID}">` wraps the
  // tile body. Accept both `<div class="job">` (Spital Emmental) and
  // `<article class="job">` (Spital Oberengadin / SGO) container elements.
  // Also covers template (c) (OTTO'S AG): the class attribute allows an
  // extra token after "job" (`class="job standard"` — `job(?:\s[^"]*)?`
  // requires a quote or whitespace right after "job", so it does NOT
  // false-match unrelated chrome classes like "job-counter"/"job-section"),
  // and the href allows an optional site-absolute `/{tenant}/` prefix before
  // `job/details/{ID}` (OTTO'S emits `/ottosag/job/details/{ID}` instead of
  // the bare relative `job/details/{ID}` templates (a)/(b) use). Both
  // extensions are strict supersets of the original pattern, so established
  // tenants match byte-identically.
  const tileWrapRx = /<(?:div|article)\s+class="job(?:\s[^"]*)?"\s*>\s*<a\s+(?:id="\d+"\s+)?href="(?:\/[a-z0-9_-]+\/)?job\/details\/(\d+)"[^>]*>([\s\S]*?)<\/a>\s*<\/(?:div|article)>/g;
  let m;
  while ((m = tileWrapRx.exec(html))) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(parseSoliqueTileBody(id, m[2]));
  }

  // Template (b): link-button. The `<a href="job/details/{ID}">` lives in
  // a `<div class="link">` sibling inside the tile.
  const tileLinkRx = /<div\s+class="job">([\s\S]*?)<div\s+class="link">\s*<a[^>]+href="job\/details\/(\d+)"[^>]*>[\s\S]*?<\/a>\s*<\/div>\s*[\s\S]*?(?=<div\s+class="job">|$)/g;
  while ((m = tileLinkRx.exec(html))) {
    const id = m[2];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(parseSoliqueTileBody(id, m[1]));
  }

  return out.filter((t) => t && t.title && t.title.length >= 3);
}

function parseSoliqueTileBody(id, body) {
  if (!body) return null;
  // OTTO'S AG (template c) wraps the title in `<span class="jobtitle">`
  // instead of the `<div>`/`<h[1-6]>` established tenants use — `span` is
  // additive to the tag alternation, established tenants never emit it.
  const titleMatch = body.match(/<(?:div|span|h[1-6])\s+class="jobtitle"[^>]*>([\s\S]*?)<\/(?:div|span|h[1-6])>/i);
  const title = sanitizeField(titleMatch ? normalizeSpace(decodeEntities(stripHtml(titleMatch[1]))) : '');
  const minMatch = body.match(/<span\s+class="min[^"]*"[^>]*>\s*(\d{1,3})\s*<\/span>/);
  const maxMatch = body.match(/<span\s+class="max[^"]*"[^>]*>\s*(\d{1,3})\s*<\/span>/);
  const minPct = minMatch ? parseInt(minMatch[1], 10) : null;
  const maxPct = maxMatch ? parseInt(maxMatch[1], 10) : null;
  const locationMatch = body.match(/<div\s+class="location"[^>]*>([\s\S]*?)<\/div>/);
  const location = sanitizeField(locationMatch ? normalizeSpace(decodeEntities(stripHtml(locationMatch[1]))) : '');
  const areaMatch = body.match(/<div\s+class="area"[^>]*>([\s\S]*?)<\/div>/);
  const area = sanitizeField(areaMatch ? normalizeSpace(decodeEntities(stripHtml(areaMatch[1]))) : '');
  const employmentMatch = body.match(/<div\s+class="employment"[^>]*>([\s\S]*?)<\/div>/);
  const employment = employmentMatch ? normalizeSpace(decodeEntities(stripHtml(employmentMatch[1]))) : '';
  const startMatch = body.match(/<div\s+class="startdate"[^>]*>([\s\S]*?)<\/div>/);
  const startDate = startMatch ? normalizeSpace(decodeEntities(stripHtml(startMatch[1]))) : '';
  return { id, title, minPct, maxPct, location, area, employment, startDate };
}

/**
 * Extract the total job count from the Solique "counter" badge
 * (`<div class="job-counter"><span class="counter">167</span>…`). Large
 * (retail) tenants like OTTO'S AG paginate the SSR listing 25-per-page, so
 * this is used to detect and drive `?page=N` pagination in `fetchAllJobs`
 * below (see the `paginate` config flag). Established tenants whose whole
 * board fits on page 1 (spital-emmental ~50, svar ~10) never trigger the
 * pagination loop even if this badge is present, because `total <=
 * tiles.length` there — so this addition is inert for them.
 * @param {string} html
 * @returns {number|null}
 */
export function parseSoliqueCounterTotal(html = '') {
  const m = /<div\s+class="job-counter">\s*<span\s+class="counter">\s*(\d+)\s*<\/span>/i.exec(html);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Parse the Solique JSON list endpoint (`/{tenant}/{lang}/api/v1/data/`) used by
 * the AngularJS board variant (e.g. ipw). Returns the same tile shape as
 * `parseSoliqueListing`, plus an explicit `detailUrl` (the SSR detail page under
 * `/{lang}/{job.link}`) since these tenants don't use the flat `/job/details/{id}`
 * path. Placeholder rows with an empty title are skipped.
 *
 * @param {object} data        parsed JSON (caller strips the UTF-8 BOM)
 * @param {string} soliqueTenant  tenant slug, e.g. 'ipw'
 * @param {string} [lang='de']  API lang segment
 */
export function parseSoliqueApiListing(data, soliqueTenant, lang = 'de') {
  const base = `https://live.solique.ch/${soliqueTenant}`;
  // Non-silent shape guard (#1518 item 2). The Solique JSON envelope is only
  // exercised against `apiLang:'de'`; a different lang segment, a paginated
  // ({jobs}→{data,page,…}) or renamed envelope would otherwise drop every row
  // through the `Array.isArray` fallback below and look identical to a board
  // that is genuinely empty. Warn loudly so a shape/lang/pagination change
  // surfaces immediately instead of decaying into a silent zero-job crawl.
  if (!Array.isArray(data?.jobs)) {
    // `data` can be a bare array/string/number for a fully-changed endpoint
    // (JSON.parse yields a non-object); only print envelope keys when `data`
    // is a plain object, else describe the actual type so the warn isn't
    // misleading (printing array/char indices).
    const shapeDesc =
      data == null
        ? String(data)
        : Array.isArray(data)
          ? `array[${data.length}]`
          : typeof data !== 'object'
            ? typeof data
            : `\`${typeof data.jobs}\` (envelope keys: ${Object.keys(data).join(', ') || 'none'})`;
    console.warn(
      `⚠️ Solique API shape mismatch for ${soliqueTenant} (${lang}): expected an array at \`data.jobs\`, got ${shapeDesc} — the /${lang}/api/v1/data/ response may have changed shape, lang, or paginated.`,
    );
  }
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  // Distinguish a per-row *schema drift* (renamed fields → nothing parseable)
  // from the known, intentional empty-`title.value` *placeholder* rows (skipped
  // silently below). Both drop a row, but only drift is a problem. The guard
  // must mirror the parser's REAL acceptance predicate (L191-193): a row is
  // usable iff it exposes an *id source* (`title.id` || top-level `id`) AND a
  // `title.value` property — `link` is OPTIONAL (L199 falls back to
  // `jobs/--{id}`), so it must NOT be part of the test. We check *structural*
  // presence of those properties (not their non-emptiness) so an all-empty
  // placeholder board does not false-warn, while a rename that moves the id
  // source (e.g. `title.id`→`title.uid`) or the `value` key still fires — the
  // exact silent zero-job class item 2 targets. Scan ALL rows so a well-formed
  // head followed by a drifted tail also warns.
  if (jobs.length > 0) {
    const hasIdSource = (r) =>
      (r?.title != null && typeof r.title === 'object' && 'id' in r.title) || 'id' in r;
    const structurallyOk = (r) =>
      r != null &&
      typeof r === 'object' &&
      hasIdSource(r) &&
      r.title != null &&
      typeof r.title === 'object' &&
      'value' in r.title;
    const firstBad = jobs.find((r) => !structurallyOk(r));
    if (firstBad !== undefined) {
      console.warn(
        `⚠️ Solique API row shape mismatch for ${soliqueTenant} (${lang}): a row among ${jobs.length} is missing the expected id source (\`title.id\`/\`id\`) + \`title.value\` shape (row keys: ${
          firstBad && typeof firstBad === 'object' ? Object.keys(firstBad).join(', ') || 'none' : typeof firstBad
        }) — per-job field names may have changed.`,
      );
    }
  }
  const out = [];
  const seen = new Set();
  for (const j of jobs) {
    const id = String(j?.title?.id || j?.id || '').trim();
    const title = sanitizeField(normalizeSpace(decodeEntities(String(j?.title?.value || ''))));
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    const location = sanitizeField(normalizeSpace(decodeEntities(String(j?.location?.value || ''))));
    const minPct = j?.from?.value != null && j.from.value !== '' ? parseInt(j.from.value, 10) : null;
    const maxPct = j?.to?.value != null && j.to.value !== '' ? parseInt(j.to.value, 10) : null;
    const link = String(j?.link || '').replace(/^\/+/, '');
    // Two shapes seen across `mode: 'api'` tenants: ipw's AngularJS board emits
    // a tenant/lang-RELATIVE link (`jobs/{slug}--{id}`), so it belongs under
    // `${base}/${lang}/…`. Kanton Zürich (`ktzh`) instead emits a SITE-ABSOLUTE
    // link that already carries the tenant segment, mirroring the flat SSR
    // `job/details/{id}` path (`ktzh/job/details/{id}/` once the leading slash
    // is stripped) — routing that through `${base}/${lang}/…` would double the
    // tenant (`.../ktzh/de/ktzh/job/details/…`) and 404. Detect the absolute
    // form by its leading tenant segment and build off the site root instead.
    const isSiteAbsoluteLink = link.startsWith(`${soliqueTenant}/`);
    const detailUrl = link
      ? (isSiteAbsoluteLink ? `https://live.solique.ch/${link}` : `${base}/${lang}/${link}`)
      : `${base}/${lang}/jobs/--${id}`;
    out.push({
      id,
      title,
      location,
      minPct: Number.isFinite(minPct) ? minPct : null,
      maxPct: Number.isFinite(maxPct) ? maxPct : null,
      area: '',
      employment: '',
      startDate: '',
      detailUrl,
    });
  }
  return out;
}

/**
 * Return the inner HTML of the first `<section>` whose `id` attribute carries
 * `idValue` (quote-agnostic), balancing nested `<section>` tags so a nested
 * `<section>` inside the block does not truncate the capture. The lazy
 * `[\s\S]*?</section>` idiom stops at the FIRST close tag, which a nested
 * section would shadow; this walks open/close tags tracking depth instead.
 * Returns '' when no matching open tag is found, and the remainder of the
 * string when the section is left unclosed (better a long capture than '').
 */
function extractBalancedSectionById(html, idValue) {
  const open = new RegExp(`<section\\s+[^>]*id=["']?${idValue}\\b[^>]*>`, 'i').exec(html);
  if (!open) return '';
  const start = open.index + open[0].length;
  const tagRx = /<(\/?)section\b[^>]*>/gi;
  tagRx.lastIndex = start;
  let depth = 1;
  let m;
  while ((m = tagRx.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index);
  }
  return html.slice(start);
}

/**
 * Return the inner HTML of the first `<div>` whose `class` attribute is
 * exactly `className` (no other tokens), balancing nested `<div>` tags —
 * same rationale as `extractBalancedSectionById` above, but for tenants
 * whose detail page has NO `<section>` tags at all (OTTO'S AG), where the
 * job body instead lives inside a balanced `<div class="…-wrapper">`
 * container. Returns '' when no matching open tag is found.
 * @param {string} html
 * @param {string} className exact class value to match (e.g. `tasks-profile-wrapper`)
 */
function extractBalancedDivByClass(html, className) {
  const open = new RegExp(`<div\\s+[^>]*class=["']?${className}["']?[^>]*>`, 'i').exec(html);
  if (!open) return '';
  const start = open.index + open[0].length;
  const tagRx = /<(\/?)div\b[^>]*>/gi;
  tagRx.lastIndex = start;
  let depth = 1;
  let m;
  while ((m = tagRx.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index);
  }
  return html.slice(start);
}

/**
 * Pull a substantive description text from a Solique detail page. Covers the
 * "intro+title-green" template (Spital Emmental), the "offer-section" template
 * (SVAR), the job-panel template (Oberengadin), and the "job-introduction +
 * content" template (migrated tenants adullam/ipw), with bullet preservation.
 */
export function extractSoliqueDetailContent(html = '', opts = {}) {
  if (!html || typeof html !== 'string') return '';

  // Strip <script>, <style>, and HTML comments BEFORE the regex extraction.
  // Solique detail pages embed inline `<script>function sendMail(){…}</script>`
  // blocks after the offer section. The regex pipeline below only strips
  // `<[^>]+>` tags, which leaves the JS BODY (var/let/function statements,
  // string literals, `document.location.href = …`) sitting as plain text
  // inside the extracted description. validate-jobs-quality catches this as
  // `code_in_description` and blocks the deploy (run 26104688496 surfaced
  // 35 Spital Emmental jobs failing this gate). Pre-stripping removes the
  // entire script body before any tag is touched, so the extracted text
  // stays clean prose.
  // Pattern matches both `<script>…</script>` and `<script src="…"></script>`
  // (self-closing is rare but the lazy `[\s\S]*?` handles the empty case).
  // The `<!-- … -->` strip also removes the CMS template-source comments
  // that occasionally include code snippets.
  const cleaned = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  const sections = [];

  // Template (i): .intro blocks
  const introRx = /<div\s+class="intro"[^>]*>([\s\S]*?)<\/div>/g;
  let im;
  while ((im = introRx.exec(cleaned))) {
    let text = im[1]
      .replace(/<br\s*\/?>(?!\s*<)/gi, '\n')
      .replace(/<[^>]+>/g, ' ');
    text = normalizeSpace(decodeEntities(text));
    if (text && text.length > 25) sections.push(text);
  }

  // Template (i): .title-green blocks
  const titledRx = /<div\s+class="title-green"[^>]*>([\s\S]*?)<\/div>([\s\S]*?)(?=<div\s+class="title-green"|$)/g;
  let tm;
  while ((tm = titledRx.exec(cleaned))) {
    const title = sanitizeField(normalizeSpace(decodeEntities(stripHtml(tm[1]))));
    if (!title) continue;
    let body = tm[2]
      .replace(/<li[^>]*>/gi, '\n• ')
      .replace(/<\/li\s*>/gi, '')
      .replace(/<br\s*\/?>(?!\s*<)/gi, '\n')
      .replace(/<[^>]+>/g, ' ');
    body = normalizeSpace(decodeEntities(body)).replace(/\s*•\s*/g, '\n• ');
    if (body && body.length > 5) sections.push(`${title}\n${body}`);
  }

  // Template (ii): <div class="offer"> with <h4 class="sub-subtitle"> headings
  const offerRx = /<div\s+class="offer(?:\s+[^"]*)?"[^>]*>([\s\S]*?)<\/div>\s*(?=<div\s+class="offer(?:\s+[^"]*)?"|<div\s+class="offer-additional"|<\/div>\s*<\/div>|$)/g;
  let om;
  while ((om = offerRx.exec(cleaned))) {
    const inner = om[1];
    // Look for sub-subtitle headings, otherwise treat the whole block as a single section.
    const headingRx = /<h[1-6][^>]*class="sub-subtitle"[^>]*>([\s\S]*?)<\/h[1-6]>([\s\S]*?)(?=<h[1-6][^>]*class="sub-subtitle"|$)/g;
    let hm;
    let captured = false;
    while ((hm = headingRx.exec(inner))) {
      const title = sanitizeField(normalizeSpace(decodeEntities(stripHtml(hm[1]))));
      if (!title) continue;
      captured = true;
      let body = hm[2]
        .replace(/<li[^>]*>/gi, '\n• ')
        .replace(/<\/li\s*>/gi, '')
        .replace(/<br\s*\/?>(?!\s*<)/gi, '\n')
        .replace(/<[^>]+>/g, ' ');
      body = normalizeSpace(decodeEntities(body)).replace(/\s*•\s*/g, '\n• ');
      if (body && body.length > 5) sections.push(`${title}\n${body}`);
    }
    if (!captured) {
      let body = inner
        .replace(/<li[^>]*>/gi, '\n• ')
        .replace(/<\/li\s*>/gi, '')
        .replace(/<br\s*\/?>(?!\s*<)/gi, '\n')
        .replace(/<[^>]+>/g, ' ');
      body = normalizeSpace(decodeEntities(body)).replace(/\s*•\s*/g, '\n• ');
      if (body && body.length > 25) sections.push(body);
    }
  }

  // Template (iii): <div class="job-panel job-panel--{tasks|profile|offer|...}">
  // with <h2> heading + <ul>/<div> body (Spital Oberengadin / SGO).
  const panelRx = /<div\s+class="job-panel\s+job-panel--[a-z0-9_-]+[^"]*"[^>]*>\s*<h2[^>]*>([\s\S]*?)<\/h2>\s*<div[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
  let pm;
  while ((pm = panelRx.exec(cleaned))) {
    const title = sanitizeField(normalizeSpace(decodeEntities(stripHtml(pm[1]))));
    if (!title) continue;
    let body = pm[2]
      .replace(/<li[^>]*>/gi, '\n• ')
      .replace(/<\/li\s*>/gi, '')
      .replace(/<br\s*\/?>(?!\s*<)/gi, '\n')
      .replace(/<[^>]+>/g, ' ');
    body = normalizeSpace(decodeEntities(body)).replace(/\s*•\s*/g, '\n• ');
    if (body && body.length > 5) sections.push(`${title}\n${body}`);
  }

  // Template (iii-extra): introduction blurb sitting above the panels
  // (Spital Oberengadin keeps the role intro in <div class="introduction">…</div>).
  const introTopRx = /<div\s+class="introduction"[^>]*>([\s\S]*?)<\/div>/g;
  let itm;
  while ((itm = introTopRx.exec(cleaned))) {
    let text = itm[1]
      .replace(/<br\s*\/?>(?!\s*<)/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n• ')
      .replace(/<\/li\s*>/gi, '')
      .replace(/<[^>]+>/g, ' ');
    text = normalizeSpace(decodeEntities(text));
    if (text && text.length > 25) sections.unshift(text);
  }

  // Template (iv): the migrated-tenant boards lay the description out as an intro
  // div (`job-introduction` on adullam SSR, `introduction` on ipw JSON-API) plus a
  // `<div class="content">` body (employer blurb + Aufgaben/Profil bullets, ipw
  // wrapping them in `group`/`group-title` sub-sections). This template OWNS the
  // description, so it must NEVER fire for the established tenants
  // (spital-emmental / oberengadin / svar) — instead of sniffing the generic
  // `content` class on the shared HTML, it is opt-in per tenant via
  // `opts.migratedBoard` (set only by adullam + ipw configs). Default off → the
  // established tenants' extraction is byte-identical to before.
  if (opts.migratedBoard) {
    const ivSections = [];
    // Stop at the NEXT intro/content block or page chrome. The intro/content
    // tokens require a class-boundary (`"` or whitespace) so a nested
    // `content-wrapper`/`introduction-note` can't prematurely truncate the
    // capture; the chrome tokens stay prefix-matches (e.g. `apply-button`).
    const TEMPLATE_IV_STOP = '<div\\s+class="(?:(?:job-introduction|introduction|content)["\\s]|apply|footer|sidebar|social|share|navigation|cookie)';
    for (const cls of ['job-introduction', 'introduction', 'content']) {
      const rx = new RegExp(`<div\\s+class="${cls}"[^>]*>([\\s\\S]*?)(?:${TEMPLATE_IV_STOP}|$)`, 'i');
      const bm = cleaned.match(rx);
      if (!bm) continue;
      let body = bm[1]
        .replace(/<li[^>]*>/gi, '\n• ')
        .replace(/<\/li\s*>/gi, '')
        .replace(/<br\s*\/?>(?!\s*<)/gi, '\n')
        .replace(/<[^>]+>/g, ' ');
      body = normalizeSpace(decodeEntities(body)).replace(/\s*•\s*/g, '\n• ');
      if (body && body.length > 20) ivSections.push(body);
    }
    if (ivSections.length) return ivSections.join('\n\n');
  }

  // Template (vi): the "wrapper" redesign (OTTO'S AG, `ottosag` — Jul 2026).
  // Unlike SVAR's Template (v), OTTO'S detail page has ZERO `<section>` tags
  // anywhere, so (v)'s `</section>` lookahead-stop can never fire — its
  // capture would run off the end of the document and swallow every sibling
  // block (benefits/contact/share chrome) as plain text. Instead the job body
  // is nested in a balanced `<div class="tasks-profile-wrapper">` container
  // (`<div class="tasks-wrapper">` + `<div class="profile-wrapper">`, each
  // opened by an `<h3 class="subtitle">` heading + `<ul>` body), so this
  // template scopes the capture to that balanced container FIRST — bounded by
  // real DOM nesting rather than a lookahead — before any classAttrRx scan can
  // run unbounded. Checked BEFORE (v) (both gated on `sections.length === 0`)
  // so OTTO'S never reaches (v)'s unbounded scan; established tenants have no
  // `tasks-profile-wrapper` container, so `extractBalancedDivByClass` returns
  // '' for them and this block is a no-op — extraction stays byte-identical.
  if (sections.length === 0) {
    const wrapperInner = extractBalancedDivByClass(cleaned, 'tasks-profile-wrapper');
    if (wrapperInner) {
      const subtitleRx = /<h3[^>]*class="subtitle"[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)(?=<h3[^>]*class="subtitle"|$)/g;
      let sm;
      while ((sm = subtitleRx.exec(wrapperInner))) {
        const title = sanitizeField(normalizeSpace(decodeEntities(stripHtml(sm[1]))));
        if (!title) continue;
        let body = sm[2]
          .replace(/<li[^>]*>/gi, '\n• ')
          .replace(/<\/li\s*>/gi, '')
          .replace(/<br\s*\/?>(?!\s*<)/gi, '\n')
          .replace(/<[^>]+>/g, ' ');
        body = normalizeSpace(decodeEntities(body)).replace(/\s*•\s*/g, '\n• ');
        if (body && body.length > 5) sections.push(`${title}\n${body}`);
      }
    }
  }

  // Template (v): the "section/tasks-profile" redesign (SVAR, 2026-06 — #2034).
  // Solique rebuilt the detail page around `<section id="…">` blocks: the job
  // body now lives in `<div class="tasks">` (Aufgaben) and `<div class="profile">`
  // (Profil) inside `<section id="tasks-profile">`, each opened by an
  // `<h4 class="sub-subtitle">` heading, with the perks list in
  // `<section id="offer">`. NONE of templates (i)-(iv) match this layout, so
  // before this handler every SVAR job extracted to '' → the thin-source guard
  // saw 10/10 thin → hard-failed the whole run and filed a "Crawler Failure"
  // issue every crawl.
  //
  // GATED on `sections.length === 0` so it is a pure FALLBACK: the established
  // tenants (emmental/oberengadin/adullam/ipw) already populate `sections` from
  // (i)-(iv) and never reach here, so their extraction stays byte-identical.
  // This gate (not a structural exclusion) is what keeps them apart — note
  // emmental ALSO wraps its body in `<div class="tasks">`, but that div nests
  // `<div class="title-green">` blocks captured by (i), so emmental never
  // arrives with an empty `sections`.
  if (sections.length === 0) {
    const vSections = [];
    // `tasks`/`profile` divs: capture up to the next tasks/profile div or the
    // enclosing </section>. Same bullet/`<br>` flattening as the other templates.
    // Selectors are quote-agnostic and multi-class tolerant (`classAttrRx`) so a
    // markup tweak (`class="tasks col-6"`, single quotes) keeps matching.
    for (const cls of ['tasks', 'profile']) {
      const m = cleaned.match(
        new RegExp(
          `<div\\s+[^>]*?${classAttrRx(cls)}[^>]*>([\\s\\S]*?)(?=<div\\s+[^>]*?${classAttrRx('tasks|profile')}|<\\/section)`,
          'i',
        ),
      );
      if (!m) continue;
      let body = m[1]
        .replace(/<li[^>]*>/gi, '\n• ')
        .replace(/<\/li\s*>/gi, '')
        .replace(/<br\s*\/?>(?!\s*<)/gi, '\n')
        .replace(/<[^>]+>/g, ' ');
      body = normalizeSpace(decodeEntities(body)).replace(/\s*•\s*/g, '\n• ');
      if (body && body.length > 5) vSections.push(body);
    }
    // Perks list (`<section id="offer">`) — short, optional. Quote-agnostic id
    // and nesting-balanced (a nested `<section>` inside the perks block must not
    // truncate the lazy `</section>` capture).
    const offerInner = extractBalancedSectionById(cleaned, 'offer');
    if (offerInner) {
      let body = offerInner
        .replace(/<li[^>]*>/gi, '\n• ')
        .replace(/<\/li\s*>/gi, '')
        .replace(/<br\s*\/?>(?!\s*<)/gi, '\n')
        .replace(/<[^>]+>/g, ' ');
      body = normalizeSpace(decodeEntities(body)).replace(/\s*•\s*/g, '\n• ');
      if (body && body.length > 25) vSections.push(body);
    }
    if (vSections.length) return vSections.join('\n\n');
  }

  return sections.join('\n\n');
}

/**
 * Build a parser bundle for one Solique tenant.
 *
 * @param {Object} config
 * @param {string} config.soliqueTenant      Tenant slug (e.g. `spital-emmental`).
 * @param {string} config.companyKey
 * @param {string} config.companyName
 * @param {string} config.companyDomain
 * @param {string} config.defaultCanton
 * @param {string} config.defaultCity
 * @param {string} [config.defaultPostalCode]
 * @param {string} [config.publicCareerUrl]
 * @param {string} [config.defaultSourceLang='de']
 * @param {string} [config.sourceLabel]
 * @param {Array<string>} [config.extraTrustedHosts]
 * @param {function(string):string} [config.postalCodeForCity]  Optional mapper
 *                                              from primary city → postal code.
 * @param {string} [config.sector='Sanità / Ospedali']  Overridable — every
 *   established tenant is a healthcare operator, but the factory is also
 *   reused by non-healthcare employers (e.g. Kanton Zürich cantonal
 *   administration, retail chains), whose jobs must not be tagged
 *   "Sanità / Ospedali".
 * @param {function(string):string} [config.categoryFn]  Overridable category
 *   classifier, defaults to `detectHealthcareCategory` (whose catch-all
 *   default is also "Sanità / Ospedali") — same rationale as `sector`.
 * @param {boolean} [config.paginate=false]  Opt-in: follow `?page=N` SSR
 *   pagination (see `parseSoliqueCounterTotal`) when the tenant's job-counter
 *   badge reports more jobs than fit on page 1. Established tenants' whole
 *   board fits on one page, so this must stay off for them (default false).
 */
export function createSoliqueParser(config) {
  const {
    soliqueTenant,
    companyKey,
    companyName,
    companyDomain,
    defaultCanton,
    defaultCity,
    defaultPostalCode = '',
    publicCareerUrl = '',
    defaultSourceLang = 'de',
    sourceLabel,
    extraTrustedHosts = [],
    postalCodeForCity,
    // `mode: 'api'` crawls the AngularJS board variant (e.g. ipw) whose listing
    // is a JSON endpoint and whose detail pages live under `/{lang}/{job.link}`
    // instead of the flat `/job/details/{id}` SSR path. Default 'ssr' (flat board).
    mode = 'ssr',
    apiLang = 'de',
    // Opt-in for detail Template (iv) — the `job-introduction`/`introduction` +
    // `content` layout used by the ex-Umantis migrated boards (adullam, ipw).
    // Keep false for every established tenant so their extraction is untouched.
    migratedBoard = false,
    // Defaults preserve byte-identical behavior for every established
    // (healthcare) tenant; only non-healthcare consumers need to override.
    sector = 'Sanità / Ospedali',
    categoryFn = detectHealthcareCategory,
    // Opt-in SSR pagination — see JSDoc above. Off by default.
    paginate = false,
  } = config;

  if (!soliqueTenant || !companyKey || !companyName || !defaultCanton) {
    throw new Error('createSoliqueParser: missing required config');
  }

  const corporateHost = String(companyDomain || '').replace(/^www\./, '').toLowerCase();
  const label = sourceLabel || `${companyName} Dedicated Parser (Solique careers portal)`;
  const listingUrl = mode === 'api'
    ? `https://live.solique.ch/${soliqueTenant}/${apiLang}/api/v1/data/`
    : `https://live.solique.ch/${soliqueTenant}/`;
  const detailUrlPrefix = `https://live.solique.ch/${soliqueTenant}/job/details/`;
  const trustedHostSet = new Set([
    'live.solique.ch',
    'solique.ch',
    ...extraTrustedHosts.map((h) => String(h || '').toLowerCase()),
  ].filter(Boolean));

  function isCompanyJob(job) {
    const key = normalize(job?.companyKey || '');
    const url = normalize(job?.url || '');
    if (key === companyKey) return true;
    if (corporateHost && url.includes(corporateHost)) return true;
    if (url.includes(`live.solique.ch/${soliqueTenant}`)) return true;
    return false;
  }

  function isTrustedDomain(rawUrl = '') {
    try {
      const host = new URL(rawUrl).hostname.toLowerCase();
      if (corporateHost && (host === corporateHost || host.endsWith(`.${corporateHost}`))) return true;
      if (trustedHostSet.has(host)) {
        if (host === 'live.solique.ch' || host === 'solique.ch' || host.endsWith('.solique.ch')) {
          return new RegExp(`\\/${soliqueTenant}(\\/|$)`, 'i').test(rawUrl);
        }
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async function fetchAllJobs() {
    console.log(`🏥 Fetching ${companyName} jobs`);
    console.log(`   Source: ${listingUrl} (Solique)\n`);

    let listingRaw;
    try {
      listingRaw = await fetchHtml(listingUrl);
    } catch (err) {
      console.warn(`⚠️ Solique listing fetch failed: ${err?.message || err}`);
      return [];
    }
    let tiles;
    if (mode === 'api') {
      let data;
      try {
        data = JSON.parse(String(listingRaw).replace(/^﻿/, ''));
      } catch (err) {
        console.warn(`⚠️ Solique JSON parse failed for ${soliqueTenant}: ${err?.message || err}`);
        return [];
      }
      tiles = parseSoliqueApiListing(data, soliqueTenant, apiLang);
    } else {
      tiles = parseSoliqueListing(listingRaw);
      // Opt-in SSR pagination (large retail tenants — see `paginate` JSDoc).
      // Established tenants never set `paginate`, so this whole block is
      // skipped and their extraction is untouched.
      if (paginate) {
        const total = parseSoliqueCounterTotal(listingRaw);
        if (total && total > tiles.length) {
          const seenIds = new Set(tiles.map((t) => t.id));
          const pageSize = Math.max(tiles.length, 1);
          // +2 page buffer above the exact ceil-division so a mid-crawl count
          // drift (job posted/closed between page fetches) can't strand
          // reachable jobs just below the safety cap.
          const maxPages = Math.ceil(total / pageSize) + 2;
          let page = 2;
          while (tiles.length < total && page <= maxPages) {
            let pageRaw;
            try {
              pageRaw = await fetchHtml(`${listingUrl}?page=${page}`);
            } catch (err) {
              console.warn(`⚠️ Solique pagination fetch failed for ${soliqueTenant} (page ${page}): ${err?.message || err}`);
              break;
            }
            const pageTiles = parseSoliqueListing(pageRaw).filter((t) => !seenIds.has(t.id));
            if (!pageTiles.length) break;
            for (const t of pageTiles) seenIds.add(t.id);
            tiles.push(...pageTiles);
            page += 1;
            await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
          }
        }
      }
    }
    if (!tiles.length) {
      console.warn(`⚠️ No openings parsed from Solique listing for ${soliqueTenant}`);
      return [];
    }
    console.log(`  ✓ ${tiles.length} jobs from Solique listing (${mode})`);

    const todayIso = new Date().toISOString().slice(0, 10);
    const jobs = [];
    let detailHits = 0;
    let failed = 0;

    for (let i = 0; i < tiles.length; i += 1) {
      const tile = tiles[i];
      const detailUrl = tile.detailUrl || `${detailUrlPrefix}${tile.id}`;
      let detailContent = '';
      try {
        const detailHtml = await fetchHtml(detailUrl);
        detailContent = extractSoliqueDetailContent(detailHtml, { migratedBoard });
        if (detailContent) detailHits += 1;
      } catch (err) {
        console.warn(`  ⚠️ Detail fetch failed (${detailUrl}): ${err?.message || err}`);
      }

      const title = tile.title;
      if (!title) {
        failed += 1;
        if (i < tiles.length - 1) await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
        continue;
      }

      const descParts = [];
      if (detailContent) descParts.push(detailContent);
      if (tile.area) descParts.push(`Bereich: ${tile.area}`);
      if (tile.employment) descParts.push(`Anstellung: ${tile.employment}`);
      if (Number.isFinite(tile.maxPct)) {
        const pStr = Number.isFinite(tile.minPct) && tile.minPct !== tile.maxPct
          ? `${tile.minPct}-${tile.maxPct}%`
          : `${tile.maxPct}%`;
        descParts.push(`Pensum: ${pStr}`);
      }
      if (tile.startDate) descParts.push(`Eintritt: ${tile.startDate}`);
      const description = descParts.length
        ? descParts.join('\n\n')
        : `${title} — ${companyName} (${tile.location || defaultCity}).`;

      // Guard: if the Solique server renders a JS-error placeholder (e.g.
      // `"location" is not defined`) inside the location field (observed on the
      // SVAR tenant when its JS template breaks), sanitize it to '' so the
      // defaultCity fallback fires instead of leaking into the slug.
      const rawLocation = sanitizeField(tile.location) || defaultCity;
      const primaryCity = sanitizeField(rawLocation.split(/[&,/]|·/)[0].trim()) || defaultCity;
      const canton = inferSwissTargetCanton(`${primaryCity} ${rawLocation}`) || defaultCanton;
      const postal = (postalCodeForCity ? postalCodeForCity(primaryCity) : '') || defaultPostalCode;

      const sourceLang = detectLang(description || title, defaultSourceLang);
      const employmentType = Number.isFinite(tile.maxPct) && tile.maxPct < 90
        ? 'PART_TIME'
        : detectHealthcareEmploymentType(`${title} ${tile.employment || ''}`);
      const isTemporary = /befristet/i.test(tile.employment) && !/unbefristet/i.test(tile.employment);
      const contract = isTemporary ? 'temporary' : 'full-time';

      const jobSlug = slugify(`${title} ${companyKey} ${primaryCity}`);
      const urlHash = createHash('sha1').update(`${companyKey}:${tile.id}`).digest('hex').slice(0, 12);

      const job = {
        id: `${companyKey}-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { [sourceLang]: jobSlug },
        company: companyName,
        companyKey,
        companyDomain,
        title,
        titleByLocale: { [sourceLang]: title },
        description,
        descriptionByLocale: { [sourceLang]: description },
        needsRetranslation: true,
        location: rawLocation,
        canton,
        url: detailUrl,
        source: label,
        sourceLang,
        crawledAt: new Date().toISOString(),
        addressLocality: primaryCity,
        addressRegion: canton,
        addressCountry: 'CH',
        country: 'CH',
        postalCode: postal,
        category: categoryFn(`${title} ${tile.area || ''}`),
        contract,
        employmentType,
        experienceLevel: detectHealthcareExperienceLevel(title),
        sector,
        currency: 'CHF',
        featured: false,
        postedDate: todayIso,
        applyUrl: detailUrl,
        requirements: [],
        requirementsByLocale: { [sourceLang]: [] },
        externalId: String(tile.id),
      };

      if (tile.area) job.department = tile.area;
      if (Number.isFinite(tile.minPct) || Number.isFinite(tile.maxPct)) {
        const mn = Number.isFinite(tile.minPct) ? tile.minPct : tile.maxPct;
        const mx = Number.isFinite(tile.maxPct) ? tile.maxPct : tile.minPct;
        job.pensumMin = mn;
        job.pensumMax = mx;
        job.pensum = mn === mx ? `${mx}%` : `${mn} - ${mx}%`;
      }
      if (isTemporary) job.contractDuration = 'temporary';
      else if (/unbefristet/i.test(tile.employment)) job.contractDuration = 'permanent';

      jobs.push(job);
      if (i < tiles.length - 1) await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
    }

    console.log(`📋 Total ${companyName} jobs discovered: ${jobs.length} (${detailHits}/${tiles.length} with rich detail content, ${failed} skipped)`);
    return jobs;
  }

  return {
    fetchAllJobs,
    isCompanyJob,
    isTrustedDomain,
    listingUrl,
    detailUrlPrefix,
    publicCareerUrl,
  };
}
