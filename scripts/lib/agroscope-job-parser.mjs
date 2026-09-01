import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
/**
 * Agroscope — Prospective.ch JSON API job parser
 *
 * API: https://ohws.prospective.ch/public/v1/medium/1000624/jobs
 *   Query params: lang=it&offset=0&limit=100 (NO server-side org-unit filter —
 *   see below)
 *   Returns JSON: { medium_id, offset, total, jobs: [...], filtercount }
 *   Each job: { id, hk_id, viewkey, title, attributes, szas, links, start_date, end_date, language }
 *
 * ⚠️ medium_id drift (fix for #4799, 2026-07-27): the federal jobs.admin.ch
 * portal migrated from medium `1000626` to `1000624` at some point after this
 * crawler was first written — the old medium_id returns `{total: 0, jobs: []}`
 * for EVERY query (not an error, so it silently looks like "genuinely zero
 * openings"). Verified live via curl; the current medium_id was found in
 * jobs.admin.ch's own bundled JS (`careercenter/1000624/...`).
 *
 * ⚠️ No stable numeric filter for Agroscope specifically. The old
 * `f=verwaltungseinheit:1083812` scoped directly to Agroscope; that ID no
 * longer resolves anything under the new medium. Top-level `verwaltungseinheit`
 * IDs now only identify whole FEDERAL DEPARTMENTS (e.g. `1083373` = DEFR, the
 * department Agroscope sits under, but also covers SECO/SEFRI/other unrelated
 * offices). The actual office name is exposed per-job as a DYNAMIC sub-facet
 * key `verwaltungseinheit_<departmentId>` → `["Agroscope"]` (or another office
 * name) — there is no numeric ID for the office-level facet value, only free
 * text. Server-side filtering is therefore unreliable the same way PostFinance/
 * PostAuto's `job.post.ch` platform has no working server-side brand filter
 * (#4759) — the fix here is the same shape: fetch the WHOLE unfiltered medium
 * (372 jobs / ~4 pages today — cheap) and filter client-side on the
 * `verwaltungseinheit_*` sub-facet text via {@link isAgroscopeApiRecord}. This
 * is more future-proof than pinning to today's DEFR department ID, which is
 * itself a numeric ID subject to the same kind of silent drift that broke
 * `1083812`.
 *
 * No detail page fetching needed — the API returns full descriptions in `szas.*`.
 *   szas.sza_tasks, szas.sza_requirements, szas.sza_benefits, szas.sza_apply_link,
 *   szas.sza_company_profil, szas.sza_contact, szas.sza_location.city, szas.sza_location.region
 *
 * Direct links: jobs.admin.ch/posti-vacanti/{slug}/{viewkey} (from `links.directlink`)
 * Apply links: career74.sapsf.eu/career?company=bundesamtf&...
 */

import { inferAnyCanton } from './target-swiss-locations.mjs';
import { isTargetCanton } from './crawler-location-config.mjs';
import { assertJsonListShape } from './assert-json-list-shape.mjs';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripHtml(html = '') {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function slugify(value = '') {
  return truncateSlugAtWordBoundary(String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-'), 180);
}

/**
 * Reduce a federal arbeitsort string to the bare city — the cleanest single
 * signal for inferAnyCanton. Strips the PLZ prefix ("6593 Cadenazzo"), the
 * trailing country suffix ("Posieux, Svizzera"), and dual-site lists
 * ("1260 Nyon o 1725 Posieux" -> "Nyon").
 */
export function cleanAgroscopeCity(rawLocation = '') {
  return String(rawLocation || '')
    .split(/\s+o\s+|\s*\/\s*/i)[0]
    .replace(/,\s*(?:svizzera|schweiz|suisse|switzerland)\s*$/i, '')
    .replace(/^\d{4}(?:\s+|-(?=\p{L}))(?=\p{L})/u, '')
    .trim();
}

/**
 * Resolve a job's Swiss canton (all 26). Primary: inferAnyCanton on the clean
 * city alone. Fallback: the first canton code inside the macro-region label
 * for Agroscope research stations missing from the BFS dataset. Returns '' for
 * locations that resolve to no Swiss canton (foreign / "Estero").
 */
const AGROSCOPE_STATION_CANTON = {
  posieux: 'FR', changins: 'VD', nyon: 'VD', reckenholz: 'ZH', 'wädenswil': 'ZH',
  waedenswil: 'ZH', 'tänikon': 'TG', taenikon: 'TG', ettenhausen: 'TG',
  liebefeld: 'BE', conthey: 'VS', cadenazzo: 'TI',
};

export function resolveAgroscopeCanton({ city = '', region = '' } = {}) {
  const cleanCity = cleanAgroscopeCity(city);
  const fromCity = String(inferAnyCanton(cleanCity) || '').toUpperCase();
  if (isTargetCanton(fromCity)) return fromCity;
  // Known Agroscope station whose town is absent from the BFS dataset — map to
  // its real canton BEFORE the macro-region first-code fallback (which would
  // mislabel e.g. Posieux→BE).
  const stationCanton = AGROSCOPE_STATION_CANTON[String(cleanCity || '').toLowerCase().trim()];
  if (stationCanton && isTargetCanton(stationCanton)) return stationCanton;
  const regionCanton = [...String(region || '').matchAll(/\b([A-Z]{2})\b/g)]
    .map((m) => m[1].toUpperCase())
    .find((code) => isTargetCanton(code));
  return regionCanton || '';
}

const VERWALTUNGSEINHEIT_SUBFACET_RE = /^verwaltungseinheit_\d+$/;

/**
 * Match a raw Prospective API job record to Agroscope. The medium (`1000624`)
 * is the WHOLE federal jobs.admin.ch portal (~370 jobs across every
 * department) — there is no numeric server-side filter that isolates
 * Agroscope specifically (see module docblock). Agroscope is instead
 * identified per-job by a dynamically-named sub-facet key
 * (`verwaltungseinheit_<departmentId>`) whose text value is the office name,
 * e.g. `attributes.verwaltungseinheit_1083373: ["Agroscope"]`. Scanning every
 * `verwaltungseinheit_*` key (rather than hardcoding today's department id)
 * keeps this resilient to the department itself being reorganised.
 * @param {object} rawJob - one raw entry from the API's `jobs` array
 * @returns {boolean}
 */
export function isAgroscopeApiRecord(rawJob = {}) {
  const attrs = rawJob?.attributes || {};
  for (const [key, values] of Object.entries(attrs)) {
    if (!VERWALTUNGSEINHEIT_SUBFACET_RE.test(key)) continue;
    if (!Array.isArray(values)) continue;
    if (values.some((v) => String(v || '').trim().toLowerCase() === 'agroscope')) return true;
  }
  return false;
}

/**
 * Parse the Prospective API response and extract job items belonging to
 * Agroscope. Filters the raw (whole-portal) job list down to Agroscope
 * records via {@link isAgroscopeApiRecord} BEFORE mapping — `total` reflects
 * the Agroscope-filtered count, not the API's whole-medium `data.total`
 * (which would silently overcount every other federal office).
 * @param {object} data - Parsed JSON from the API
 * @returns {{ items: Array, total: number }}
 */
export function parseAgroscopeApiResponse(data = {}) {
  const allRawJobs = assertJsonListShape(data, { key: 'jobs', source: 'agroscope' });
  const rawJobs = allRawJobs.filter(isAgroscopeApiRecord);
  const items = rawJobs.map((j) => {
    const attrs = j.attributes || {};
    const szas = j.szas || {};
    const links = j.links || {};

    const locationRaw = (attrs.arbeitsort || [])[0] || '';
    const regionRaw = (attrs.region || [])[0] || '';
    const pensum = (attrs['75'] || [])[0] || '';
    const pensumMin = szas.sza_pensum_min || szas['sza_pensum.min'] || '';

    // Extract a clean city from the location (format: "6593 Cadenazzo",
    // "Posieux, Svizzera", "1260 Nyon o 1725 Posieux"). Strip the PLZ prefix,
    // the trailing ", Svizzera/Schweiz" country suffix, and any "city o city"
    // dual-site list (take the first). The CITY ALONE is the cleanest single
    // signal for inferAnyCanton — a "city + region" combined string makes
    // inferAnyCanton return the wrong canton (TARGET_CANTONS array order).
    const city = cleanAgroscopeCity(locationRaw);
    const postalCode = locationRaw.match(/^(\d{4})/)?.[1] || '';

    // Build description from szas fields
    const parts = [];
    if (szas.sza_tasks) parts.push(stripHtml(szas.sza_tasks));
    if (szas.sza_requirements) parts.push(stripHtml(szas.sza_requirements));
    const description = parts.join('\n\n');

    // Per-job canton (CH-wide, all 26 cantons). Primary signal: inferAnyCanton
    // on the clean city alone. Fallback for Agroscope research stations not in
    // the BFS municipality dataset (Posieux, Reckenholz, Ettenhausen, …): the
    // first canton code in the macro-region label (e.g. "Espace Mittelland
    // (BE, FR, JU, NE, SO)"), which keeps the job as Swiss even when the exact
    // municipality is unresolved. Empty canton => not a resolvable CH location.
    const canton = resolveAgroscopeCanton({ city, region: regionRaw });

    return {
      id: String(j.id || ''),
      viewkey: j.viewkey || '',
      title: normalizeSpace(j.title),
      city,
      postalCode,
      location: locationRaw,
      region: regionRaw,
      canton,
      pensum: pensum ? `${pensumMin || pensum}-${pensum}%` : '',
      pensumMax: pensum,
      pensumMin: pensumMin || pensum,
      description,
      applyUrl: szas.sza_apply_link || '',
      directLink: links.directlink || '',
      startDate: j.start_date || '',
      endDate: j.end_date || '',
      language: j.language || 'it',
      fieldOfActivity: szas.sza_field_of_activity || (attrs.taetigkeitsbereich || [])[0] || '',
      role: szas.sza_role || (attrs.funktion || [])[0] || '',
      benefits: szas.sza_benefits ? stripHtml(szas.sza_benefits) : '',
    };
  });

  // `data.total` is the WHOLE portal's total (every federal department), not
  // Agroscope's — using items.length (the post-filter count) is deliberate,
  // see the docblock above `parseAgroscopeApiResponse`.
  return { items, total: items.length };
}

/**
 * Keep a job when it resolves to a Swiss canton (CH-wide, all 26). Agroscope is
 * a national federal research org, so we keep every Swiss posting and drop only
 * foreign ("Estero") ones — those resolve to no canton (the macro-region
 * carries no Swiss canton code and the clean city is not a CH municipality).
 */
export function isAgroscopeSwissRelevant(job = {}) {
  return isTargetCanton(String(job.canton || '').toUpperCase());
}

/**
 * Infer the Swiss canton for a job (all 26). Trusts the canton resolved at
 * parse time; otherwise re-resolves from the clean city / macro-region.
 */
export function inferAgroscopeCanton(job = {}) {
  const canton = String(job.canton || '').toUpperCase();
  if (isTargetCanton(canton)) return canton;
  return resolveAgroscopeCanton({ city: job.city, region: job.region });
}

/**
 * Map field of activity / role to a category.
 */
export function inferAgroscopeCategory(job = {}) {
  const haystack = `${job.fieldOfActivity || ''} ${job.title || ''} ${job.role || ''}`.toLowerCase();
  if (/scien|ricerca|research|forschung|dottoran|post-doc/i.test(haystack)) return 'science';
  if (/ingegner|engineer|techni|tecnico/i.test(haystack)) return 'engineering';
  if (/informatica|software|ict|it\b|digital/i.test(haystack)) return 'it';
  if (/apprendist|lehrstell|apprenti/i.test(haystack)) return 'apprenticeship';
  if (/dirigen|leader|responsabile|leiter|chef/i.test(haystack)) return 'management';
  if (/amministra|admin|sachbearbeit|segretari/i.test(haystack)) return 'admin';
  if (/agronomi|agricol|agrario|veterinar|zoolog|botanik/i.test(haystack)) return 'science';
  return 'science';
}

/**
 * Build localized content for an Agroscope job.
 */
export function buildAgroscopeLocalizedContent(job = {}) {
  const title = String(job.title || '').trim();
  const city = String(job.city || 'Switzerland').trim();
  const description = String(job.description || '').trim();

  const fallbackDesc = `Agroscope cerca ${title} con sede a ${city}. Centro di competenze della Confederazione per la ricerca nel settore agroalimentare. Candidati online su jobs.admin.ch.`;

  return {
    titleByLocale: { it: title, en: title, de: title, fr: title },
    descriptionByLocale: {
      it: description || fallbackDesc,
      en: description || fallbackDesc,
      de: description || fallbackDesc,
      fr: description || fallbackDesc,
    },
    slugByLocale: {
      it: slugify(`${title} agroscope ${city}`),
      en: slugify(`${title} agroscope ${city}`),
      de: slugify(`${title} agroscope ${city}`),
      fr: slugify(`${title} agroscope ${city}`),
    },
  };
}
