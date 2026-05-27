#!/usr/bin/env node
/**
 * Shared factory for Swiss employers using **Refline** as their careers-portal
 * ATS. Refline ships under two host families that share the same on-page HTML
 * layout (server-rendered HTML, no pagination, no JSON feed):
 *
 *   - `https://apply.refline.ch/{TENANT}/…`        (numeric tenant 5-6 digits)
 *   - `https://app.reflinejobs.io/{TENANT}/…`      (lower-numeric tenant, newer SaaS)
 *
 * The listing endpoint exposes three known templates depending on tenant choice:
 *
 *   a) "anchor-list" (Spital Limmattal `486538`, Pigna `1531`):
 *        `<a href=".../{posId}/pub/{rev}/index.html">Title</a>`
 *        Pigna additionally wraps each row in `<div class="listblock listcontent">`
 *        with a `<div class="item workName">Arbeitsort</div>`.
 *
 *   b) "table-row" (Hohenegg `640332`, Caritas Schweiz `126757`):
 *        `<tr><td class="position"><a …>Title</a></td>
 *             <td class="workplace">…</td>
 *             <td class="workload">…</td>
 *             [<td class="entryDate">…</td>] </tr>`
 *        Caritas additionally groups rows under `<div class="searchBox">` per
 *        sub-organisation, using `positions_grouped.html` instead of
 *        `positions.html` / `search.html`.
 *
 *   c) "structured-detail" (Kanton GR `514915`): combines multiple listing
 *        pages (search/apprentice/stage) and uses well-known DOM IDs on the
 *        detail page (`#bDescription`, `#bDuty`, `#bRequirement`). This pattern
 *        is NOT covered by the generic factory — Kanton GR keeps its bespoke
 *        parser.
 *
 * Detail pages: across all tenants the title sits in `<h1>` (often
 * `class="posTitle"`) and the body content lives in `<p>` / `<li>` / `<h3>` /
 * `<h4>` blocks; the factory walks every such block and skips boilerplate noise
 * (cookies, datenschutz, impressum, "bewerbung absenden", refline branding).
 *
 * Tenants currently covered by bespoke wrappers (NOT migrated by this factory
 * — left untouched per task spec):
 *
 *   - Spital Limmattal       (`486538`, apply.refline.ch, anchor-list)
 *   - Caritas Schweiz        (`126757`, apply.refline.ch, grouped-table)
 *   - Privatklinik Hohenegg  (`640332`, apply.refline.ch, table-row)
 *   - Stiftung Pigna         (`1531`,   app.reflinejobs.io, anchor-list + workName)
 *   - Kantonale Verwaltung GR(`514915`, apply.refline.ch, structured-detail)
 *
 * This factory targets the three high-frequency templates (anchor-list,
 * table-row, anchor-list-with-workName). Pass `listingTemplate` to opt into
 * the right parser; or omit it and the factory will autodetect on the first
 * `fetchAllJobs()` call.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace, normalizeDescriptionSpace } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import {
  decodeEntities,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
  fetchHtml,
} from './hospital-custom-html-helpers.mjs';

const DETAIL_DELAY_MS = 300;

function normalize(s = '') {
  return String(s || '').trim().toLowerCase();
}

/**
 * Parse a Refline listing page using the "anchor-list" template.
 * Returns: [{ url, posId, rev, title, workplace, workload }, ...]
 *
 * The `workplace` value comes from `<div class="item workName">` (Pigna-style)
 * when present, otherwise an empty string.
 */
export function parseReflineAnchorListing(html = '', { listingHost, tenant } = {}) {
  if (!html) return [];
  const out = [];
  const seen = new Set();

  // Detail-link pattern. Refline posIds are alphanumeric (e.g. "0052") on some
  // tenants and purely numeric on others — accept both.
  const linkRe = new RegExp(
    `<a\\s+href="(https?:\\/\\/${listingHost.replace(/\\./g, '\\.')}\\/${tenant}\\/([A-Za-z0-9]+)\\/pub\\/(\\d+)\\/index\\.html)"[^>]*>([\\s\\S]*?)<\\/a>`,
    'gi',
  );

  // Pigna-style: each link sits inside a "listblock listcontent" div, optionally
  // with a workName child. We support both shapes by walking links first, then
  // looking back/forward for an optional workName div within a 600-char window.
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const url = m[1];
    const posId = m[2];
    const rev = m[3];
    const title = normalizeSpace(stripHtml(decodeEntities(m[4])));
    if (!title || title.length < 3) continue;
    if (seen.has(posId)) continue;
    if (/apply-spontaneous|spontan|spontaneous/.test(url)) continue;
    seen.add(posId);

    // Sniff a nearby workName / workplace hint (Pigna template)
    const winStart = Math.max(0, m.index - 200);
    const winEnd = Math.min(html.length, m.index + m[0].length + 600);
    const win = html.slice(winStart, winEnd);
    const wnMatch = win.match(/<div class="item workName"[^>]*>([\s\S]*?)<\/div>/i);
    const workplace = wnMatch ? normalizeSpace(stripHtml(decodeEntities(wnMatch[1]))) : '';

    out.push({ url, posId, rev, title, workplace, workload: '' });
  }
  return out;
}

/**
 * Parse a Refline listing page using the "table-row" template.
 * Returns: [{ url, posId, rev, title, workplace, workload, entryDate }, ...]
 */
export function parseReflineTableListing(html = '', { listingHost, tenant } = {}) {
  if (!html) return [];
  const out = [];
  const seen = new Set();

  const rowRe = new RegExp(
    `<tr[^>]*>\\s*<td class="position">\\s*<a\\s+href="(https?:\\/\\/${listingHost.replace(/\\./g, '\\.')}\\/${tenant}\\/([A-Za-z0-9]+)\\/pub\\/(\\d+)\\/index\\.html)"[^>]*>([\\s\\S]*?)<\\/a>\\s*<\\/td>\\s*(?:<td class="workplace">([\\s\\S]*?)<\\/td>\\s*)?(?:<td class="workload">([\\s\\S]*?)<\\/td>\\s*)?(?:<td class="entryDate">([\\s\\S]*?)<\\/td>)?`,
    'gi',
  );
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const url = m[1];
    const posId = m[2];
    const rev = m[3];
    const title = normalizeSpace(stripHtml(decodeEntities(m[4])));
    const workplace = m[5] ? normalizeSpace(stripHtml(decodeEntities(m[5]))) : '';
    const workload = m[6] ? normalizeSpace(stripHtml(decodeEntities(m[6]))) : '';
    const entryDate = m[7] ? normalizeSpace(stripHtml(decodeEntities(m[7]))) : '';
    if (!title || title.length < 3) continue;
    if (seen.has(posId)) continue;
    seen.add(posId);
    out.push({ url, posId, rev, title, workplace, workload, entryDate });
  }
  return out;
}

/**
 * Autodetect which listing template a tenant uses, and parse accordingly.
 * If neither template matches, returns an empty array.
 */
export function parseReflineListing(html = '', opts = {}) {
  // Table-row template wins when present (more structured); fall back to anchors.
  const table = parseReflineTableListing(html, opts);
  if (table.length) return table;
  return parseReflineAnchorListing(html, opts);
}

/**
 * Parse a Refline detail page. Returns { title, description }.
 * Same algorithm across all tenants: extract <h1> title, walk content blocks,
 * skip boilerplate.
 */
export function parseReflineDetail(html = '') {
  if (!html) return { title: '', description: '' };

  const titleMatch = html.match(/<h1[^>]*class="[^"]*posTitle[^"]*"[^>]*>([\s\S]*?)<\/h1>/i)
    || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
    || html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)
    || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? normalizeSpace(stripHtml(decodeEntities(titleMatch[1]))) : '';

  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '');

  const parts = [];
  const blockRe = /<(p|li|h3|h4)[^>]*>([\s\S]*?)<\/\1>/gi;
  let bm;
  while ((bm = blockRe.exec(cleaned)) !== null) {
    const tag = bm[1].toLowerCase();
    const text = normalizeDescriptionSpace(stripHtml(decodeEntities(bm[2])));
    if (text.length > 20 && !/cookie|datenschutz|privacy|impressum|bewerbung absenden|reflinejobs|refline\.io/i.test(text)) {
      parts.push(tag === 'li' ? `• ${text}` : text);
    }
  }
  return { title, description: parts.join('\n') };
}

function extractPensum(text = '') {
  const range = text.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/);
  if (range) return { min: parseInt(range[1], 10), max: parseInt(range[2], 10) };
  const single = text.match(/(\d{2,3})\s*%/);
  if (single) {
    const v = parseInt(single[1], 10);
    return { min: v, max: v };
  }
  return null;
}

/**
 * Build a Refline parser bundle for one tenant.
 *
 * @param {object} config
 * @param {string} config.reflineTenant         — numeric / short ID
 * @param {string} config.companyKey            — kebab-case key
 * @param {string} config.companyName           — display name
 * @param {string} config.companyDomain         — corporate domain (no scheme, no www)
 * @param {string} config.defaultCanton         — 2-letter canton fallback
 * @param {string} config.defaultCity           — city fallback
 * @param {string} [config.defaultPostalCode=''] — postal fallback (if city is stable)
 * @param {string} [config.publicCareerUrl=''] — public career page (for Referer)
 * @param {string} [config.defaultSourceLang='de']
 * @param {string} [config.listingHost='apply.refline.ch']
 *                                              — pick `app.reflinejobs.io` for
 *                                                lower-numeric SaaS tenants.
 * @param {string} [config.listingPath]         — default `positions.html` on
 *                                                apply.refline.ch and
 *                                                `positions.html?lang=de` on
 *                                                reflinejobs.io. Override when
 *                                                a tenant uses `search.html` or
 *                                                `positions_grouped.html`.
 * @param {string} [config.sector='Sanità / Ospedali']
 * @param {string} [config.sourceLabel]
 * @param {function(string):{ city:string, canton:string, postal:string }} [config.locationHintsFor]
 *           — optional mapper from workplace string → location hints. Default
 *             behaviour: infer canton from workplace text using
 *             inferSwissTargetCanton(); fall back to defaultCity/Canton/Postal.
 */
export function createReflineParser(config) {
  const {
    reflineTenant,
    companyKey,
    companyName,
    companyDomain,
    defaultCanton,
    defaultCity,
    defaultPostalCode = '',
    publicCareerUrl = '',
    defaultSourceLang = 'de',
    listingHost = 'apply.refline.ch',
    listingPath,
    sector = 'Sanità / Ospedali',
    sourceLabel,
    locationHintsFor,
  } = config;

  if (!reflineTenant || !companyKey || !companyName || !defaultCanton || !defaultCity) {
    throw new Error('createReflineParser: missing required config (reflineTenant, companyKey, companyName, defaultCanton, defaultCity)');
  }

  const tenantStr = String(reflineTenant);
  const corporateHost = String(companyDomain || '').replace(/^www\./, '').toLowerCase();
  const isReflineJobsIo = listingHost === 'app.reflinejobs.io';
  const defaultPath = listingPath || (isReflineJobsIo ? 'positions.html?lang=de' : 'positions.html');
  const listingUrl = `https://${listingHost}/${tenantStr}/${defaultPath}`;
  const label = sourceLabel || `${companyName} Dedicated Parser (Refline ${tenantStr})`;

  function isCompanyJob(job) {
    const key = normalize(job?.companyKey || '');
    const company = normalize(job?.company || '');
    const url = normalize(job?.url || '');
    if (key === companyKey) return true;
    if (corporateHost && (company.includes(corporateHost.split('.')[0]) || url.includes(corporateHost))) return true;
    if (url.includes(`${listingHost}/${tenantStr}`)) return true;
    return false;
  }

  function isTrustedDomain(rawUrl = '') {
    try {
      const host = new URL(rawUrl).hostname.toLowerCase();
      if (corporateHost && (host === corporateHost || host.endsWith(`.${corporateHost}`))) return true;
      if ((host === 'apply.refline.ch' || host === 'pub.refline.ch' || host === 'app.reflinejobs.io')
        && rawUrl.includes(`/${tenantStr}/`)) return true;
      return false;
    } catch {
      return false;
    }
  }

  function defaultLocationHints(workplace = '') {
    const wp = String(workplace || '').trim();
    if (!wp) return { city: defaultCity, canton: defaultCanton, postal: defaultPostalCode };
    const cleaned = wp.replace(/^Kanton\s+/i, '').trim();
    const cityPart = cleaned.split(/[-–—,]/)[0].trim();
    const inferred = inferSwissTargetCanton(cityPart) || inferSwissTargetCanton(cleaned);
    if (inferred) return { city: cityPart || defaultCity, canton: inferred, postal: '' };
    return { city: cityPart || defaultCity, canton: defaultCanton, postal: defaultPostalCode };
  }

  const pickHints = typeof locationHintsFor === 'function' ? locationHintsFor : defaultLocationHints;

  function buildFallbackDescription(title, workplace) {
    return [
      `${title} bei ${companyName}${workplace ? ` in ${workplace}` : ` in ${defaultCity}`}.`,
      '',
      `${companyName} bietet eine sinnstiftende Tätigkeit in einem engagierten Team.`,
      '• Vielfältige Aus- und Weiterbildungsmöglichkeiten',
      '• Faire Anstellungsbedingungen',
      '• Moderne Arbeitsumgebung',
    ].join('\n');
  }

  async function fetchAllJobs() {
    const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
    console.log(`🏥 Fetching ${companyName} jobs`);
    console.log(`   Source: ${listingUrl} (Refline tenant ${tenantStr})\n`);

    let listingHtml;
    try {
      listingHtml = await fetchHtml(listingUrl, { timeoutMs });
    } catch (err) {
      console.warn(`⚠️ Refline listing fetch failed: ${err?.message || err}`);
      return [];
    }

    const listings = parseReflineListing(listingHtml, { listingHost, tenant: tenantStr });
    console.log(`  📋 Found ${listings.length} positions on Refline listing\n`);
    if (!listings.length) return [];

    const todayIso = new Date().toISOString().slice(0, 10);
    const jobs = [];

    for (const listing of listings) {
      let detail = { title: '', description: '' };
      try {
        const detailHtml = await fetchHtml(listing.url, { timeoutMs });
        detail = parseReflineDetail(detailHtml);
      } catch (err) {
        console.warn(`  ⚠️ Detail fetch failed for ${listing.title}: ${err?.message || err}`);
      }

      const title = detail.title || listing.title;
      const hints = pickHints(listing.workplace || '');
      const location = hints.city;
      const canton = hints.canton;
      const postalCode = hints.postal || defaultPostalCode;

      const description = detail.description && detail.description.split(/\s+/).length >= 40
        ? detail.description
        : buildFallbackDescription(title, listing.workplace);

      const haystack = `${title} ${description}`;
      const sourceLang = detectLang(description || title, defaultSourceLang);
      const jobSlug = slugify(`${title} ${companyKey} ${location}`);
      const urlHash = createHash('sha1').update(listing.url).digest('hex').slice(0, 12);

      const workloadHaystack = `${listing.workload || ''} ${title}`;
      const employmentType = detectHealthcareEmploymentType(workloadHaystack) || 'FULL_TIME';
      const pensum = extractPensum(listing.workload || '') || extractPensum(title);

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
        // Newly-discovered jobs ship source-locale only; the AI step clears the
        // flag once it fills the 3 remaining locales, otherwise translate-pending
        // picks them up.
        needsRetranslation: true,
        location,
        canton,
        url: listing.url,
        source: label,
        sourceLang,
        crawledAt: new Date().toISOString(),
        addressLocality: location,
        addressRegion: canton,
        addressCountry: 'CH',
        country: 'CH',
        postalCode,
        category: detectHealthcareCategory(haystack),
        contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
        employmentType,
        experienceLevel: detectHealthcareExperienceLevel(haystack),
        sector,
        currency: 'CHF',
        featured: false,
        postedDate: todayIso,
        applyUrl: listing.url,
        requirements: [],
        requirementsByLocale: { [sourceLang]: [] },
        externalId: String(listing.posId),
      };

      if (pensum) {
        job.pensumMin = pensum.min;
        job.pensumMax = pensum.max;
        job.pensum = pensum.min === pensum.max ? `${pensum.min}%` : `${pensum.min} - ${pensum.max}%`;
      }

      jobs.push(job);
      console.log(`  ✅ ${title.substring(0, 70)} → ${location} (${canton}, ${listing.posId})`);
      await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
    }

    console.log(`\n📋 Total ${companyName} jobs discovered: ${jobs.length}`);
    return jobs;
  }

  return {
    fetchAllJobs,
    isCompanyJob,
    isTrustedDomain,
    listingUrl,
    publicCareerUrl,
    reflineTenant: tenantStr,
    listingHost,
  };
}
