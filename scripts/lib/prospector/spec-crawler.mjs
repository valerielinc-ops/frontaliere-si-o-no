/**
 * Production runtime for a synthesised crawler.
 *
 * A crawler promoted by the prospector is not a hand-written parser: it is a
 * declarative spec (`data/prospector/crawlers/<key>.json`) plus this runtime.
 * Everything vendor-specific lives in the spec, so a listing that changes shape
 * is a data fix, not a code fix — which is what makes hundreds of micro-employer
 * crawlers maintainable at all.
 *
 * Production, discovery and validation deliberately share the same polite,
 * public-network-only transport. Otherwise a spec can pass its gate with
 * robots, redirect and DNS checks that the promoted crawler later bypasses.
 *
 * The extraction itself is the same cascade the prospector graded, so what runs
 * in production is what the quality gate measured. Anything else would make the
 * grade a statement about a different program.
 */
import fs from 'node:fs';
import path from 'node:path';
import { lookup as dnsLookup } from 'node:dns/promises';
import {
  extractVacancies,
  extractDetailFields,
  isSufficientVacancyDescription,
} from './extract.mjs';
import { extractLinks } from './careers-trail.mjs';
import { politeFetch } from './polite-fetch.mjs';
import { normalizeHost } from './registrable.mjs';
import { resolveDetailOrListingSwissGeography } from './location-evidence.mjs';
import { PROSPECTOR_DIR } from './config.mjs';
import { createSpecUrlPolicy } from './public-fetch-policy.mjs';
import {
  extractUmantisDetailFields,
  extractUmantisListingEvidence,
  umantisDetailFallbackUrl,
  umantisVacancyIdentity,
} from './umantis-detail.mjs';
import { extractPageExecutiveDetailFields } from './pageexecutive-detail.mjs';
export { createPublicConnectionLookup, createSpecUrlPolicy } from './public-fetch-policy.mjs';

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
 * Legacy template specs predate the explicit flag, but their index rows never
 * carry authoritative per-job fields. Mode is therefore the invariant; the
 * flag remains useful for non-template specs that opt into detail enrichment.
 *
 * @param {import('./synthesize.mjs').CrawlerSpec} spec
 * @param {any[]} [rows]
 */
export function needsDetailEnrichment(spec, rows = []) {
  if (spec.mode === 'template' || spec.detailEnrichment === true) return true;
  // Legacy structured specs may have been promoted before the synthesiser
  // recorded this flag. If their listing carries no usable Swiss geography,
  // runtime must visit the same detail page that validation graded.
  return rows.some((row) => !resolveDetailOrListingSwissGeography({}, row).geography
    || !isSufficientVacancyDescription(row.description));
}

/**
 * Preserve structured address fields selected by the geography resolver.
 * `location` remains the source display string; schema addressLocality should
 * be the pure municipality whenever the source supplied it.
 *
 * @param {{ geography?: any, candidate?: any }} decision
 */
export function geographyFieldsForDecision(decision = {}) {
  const geography = decision.geography;
  if (!geography) return null;
  const candidate = decision.candidate || {};
  const addressLocality = String(candidate.addressLocality || '').trim()
    || String(geography.location || '').split(/[,;/|]/)[0].trim();
  const addressRegion = String(candidate.addressRegion || '').trim() || geography.canton;
  const addressCountry = String(candidate.addressCountry || geography.addressCountry || 'CH').trim();
  return {
    ...geography,
    addressLocality,
    addressRegion,
    addressCountry,
    country: addressCountry,
    ...(candidate.postalCode ? { postalCode: String(candidate.postalCode).trim() } : {}),
    ...(candidate.streetAddress ? { streetAddress: String(candidate.streetAddress).trim() } : {}),
  };
}

/** @param {string} url @param {any} urlPolicy @param {Record<string, any>} runtime */
async function fetchRuntimePage(url, urlPolicy, runtime) {
  const result = await politeFetch(url, {
    urlPolicy,
    dispatcher: urlPolicy.dispatcher,
    fetchImpl: runtime.fetchImpl,
    sleepImpl: runtime.sleepImpl,
    retries: runtime.retries,
    retryBaseMs: runtime.retryBaseMs,
    timeoutMs: runtime.timeoutMs,
    headers: runtime.headers,
  });
  if (result.ok) return result;
  const reason = result.blockedByRobots
    ? 'blocked by robots.txt'
    : result.policyBlocked ? (result.error || 'blocked by public URL policy') : `HTTP ${result.status}`;
  const error = Object.assign(
    new Error(`Prospector fetch failed for ${result.url || url}: ${reason}`),
    {
      status: result.status,
      retryable: !result.blockedByRobots && !result.policyBlocked && (!result.status || result.status >= 500),
    },
  );
  throw error;
}

function reportDroppedRows(spec, dropped, total, reason) {
  if (!dropped) return;
  console.warn(`[prospector:${spec.companyKey}] scartati ${dropped}/${total} annunci: ${reason}`);
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
  /** @type {{ title: string, url: string, via: 'known-template' }[]} */
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
    out.push({ title: title.slice(0, 180), url: l.url, via: /** @type {const} */ ('known-template') });
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
 * @returns {Promise<Array<Record<string, any> & {
 *   title: string,
 *   url: string,
 *   location: string,
 *   description: string,
 *   postedAt: string|null,
 *   company: string,
 *   addressLocality?: string,
 *   addressRegion?: string,
 *   addressCountry?: string,
 *   country?: string,
 *   postalCode?: string,
 *   streetAddress?: string,
 * }>>}
 */
export async function runSpecInProduction(spec, runtime = {}) {
  /** @type {Map<string, any>} */
  const bySlug = new Map();
  const templateRx = spec.detailTemplate ? templateToRegex(spec.detailTemplate) : null;
  const validateUrl = createSpecUrlPolicy(spec, { lookupImpl: runtime.lookupImpl || dnsLookup });

  for (const seed of spec.seedUrls || []) {
    let page;
    try {
      page = await fetchRuntimePage(seed, validateUrl, runtime);
    } catch (err) {
      // Let the standard pipeline classify it: a connection-level failure is
      // infra and must soft-exit, an HTTP status is a real break.
      await validateUrl.dispatcher.close();
      throw err;
    }
    const html = page.body;
    if (!html) continue;
    const effectiveSeedUrl = page.url || seed;
    const umantisListingEvidence = spec.platform === 'umantis.com'
      ? extractUmantisListingEvidence(html, effectiveSeedUrl)
      : new Map();
    const links = extractLinks(html, effectiveSeedUrl);
    const { vacancies } = extractVacancies(html, effectiveSeedUrl, links);
    // jsonld/microdata are stronger evidence than any link-shape guess, so
    // only override when the generic cascade fell back to (or below) its own
    // template heuristic and we hold a better one already vetted for this spec.
    let candidates = vacancies;
    if (templateRx && vacancies.every((v) => v.via !== 'jsonld' && v.via !== 'microdata')) {
      let host = '';
      try { host = normalizeHost(new URL(effectiveSeedUrl).hostname); } catch { /* skip override */ }
      const direct = host ? matchKnownTemplate(links, templateRx, host) : [];
      if (direct.length) candidates = direct;
    }
    for (const v of candidates) {
      if (!v.title || !v.url) continue;
      try { await validateUrl(v.url); } catch { continue; }
      if (templateRx) {
        let pathname = '';
        try { pathname = new URL(v.url).pathname; } catch { continue; }
        if (!templateRx.test(pathname)) continue;
      }
      if (bySlug.has(v.url)) continue;
      const vacancy = /** @type {any} */ (v);
      const listingEvidence = umantisListingEvidence.get(umantisVacancyIdentity(v.url));
      bySlug.set(v.url, {
        title: v.title,
        url: v.url,
        location: vacancy.location || listingEvidence?.location || '',
        addressLocality: vacancy.addressLocality || listingEvidence?.addressLocality || '',
        addressRegion: vacancy.addressRegion || listingEvidence?.addressRegion || '',
        addressCountry: vacancy.addressCountry || listingEvidence?.addressCountry || '',
        postalCode: vacancy.postalCode || listingEvidence?.postalCode || '',
        streetAddress: vacancy.streetAddress || listingEvidence?.streetAddress || '',
        locationCandidates: [
          ...(vacancy.locationCandidates || []),
          ...(listingEvidence ? [listingEvidence] : []),
        ],
        description: vacancy.description || '',
        postedAt: vacancy.postedDate || null,
        company: vacancy.company || spec.companyName,
      });
    }
  }
  const rows = [...bySlug.values()];
  if (!needsDetailEnrichment(spec, rows)) {
    const safeRows = rows.flatMap((row) => {
      const fields = geographyFieldsForDecision(resolveDetailOrListingSwissGeography({}, row));
      return fields ? [{ ...row, ...fields }] : [];
    });
    reportDroppedRows(spec, rows.length - safeRows.length, rows.length,
      'localita svizzera source-backed assente o non verificabile');
    await validateUrl.dispatcher.close();
    return safeRows;
  }

  // Template extraction has no per-row semantics. Visit the detail pages with
  // a bounded pool so location and full descriptions are source-backed.
  // Workers complete out of order; index-addressed writes keep the listing
  // order deterministic so stable downstream sorts do not churn job slices.
  const enriched = new Array(rows.length);
  let geographyDrops = 0;
  let descriptionDrops = 0;
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const index = next++;
      const row = rows[index];
      try {
        let page;
        try {
          page = await fetchRuntimePage(row.url, validateUrl, runtime);
        } catch (error) {
          const fallbackUrl = spec.platform === 'umantis.com'
            && Number(error?.status) >= 300 && Number(error?.status) < 400
            ? umantisDetailFallbackUrl(row.url)
            : '';
          if (!fallbackUrl) throw error;
          page = await fetchRuntimePage(fallbackUrl, validateUrl, runtime);
        }
        const detailExtractor = typeof runtime.detailExtractor === 'function'
          ? runtime.detailExtractor
          : spec.platform === 'pageexecutive.com'
            ? extractPageExecutiveDetailFields
            : extractDetailFields;
        const detail = detailExtractor(
          page.body,
          page.url || row.url,
        );
        if (spec.platform === 'umantis.com') {
          const umantisDetail = extractUmantisDetailFields(page.body);
          if (isSufficientVacancyDescription(umantisDetail.description)) {
            detail.description = umantisDetail.description;
          }
          if (!detail.locationCandidates.length && umantisDetail.locationCandidates.length) {
            detail.locationCandidates = umantisDetail.locationCandidates;
            const [candidate] = umantisDetail.locationCandidates;
            detail.location = candidate.location;
            detail.addressCountry = candidate.addressCountry;
          }
        }
        const decision = resolveDetailOrListingSwissGeography(detail, row);
        const geography = geographyFieldsForDecision(decision);
        const description = isSufficientVacancyDescription(detail.description)
          ? detail.description
          : row.description;
        if (!geography) { geographyDrops++; continue; }
        if (!isSufficientVacancyDescription(description)) { descriptionDrops++; continue; }
        enriched[index] = { ...row, ...geography, title: detail.title || row.title, description,
          postedAt: detail.postedDate || row.postedAt,
          employmentType: detail.employmentType || row.employmentType };
      } catch (err) {
        // A row without both source-backed fields must not be published with a
        // fabricated employer default. Keep already complete index rows only.
        const geography = geographyFieldsForDecision(resolveDetailOrListingSwissGeography({}, row));
        if (!geography) geographyDrops++;
        else if (!isSufficientVacancyDescription(row.description)) descriptionDrops++;
        else enriched[index] = { ...row, ...geography };
      }
    }
  };
  const concurrency = Math.max(1, Math.min(8, Number(spec.detailFetchWorkers) || 4));
  await Promise.all(Array.from({ length: concurrency }, worker));
  reportDroppedRows(spec, geographyDrops, rows.length,
    'localita svizzera source-backed assente o non verificabile');
  reportDroppedRows(spec, descriptionDrops, rows.length,
    'descrizione source-backed assente o non verificabile');
  await validateUrl.dispatcher.close();
  return enriched.filter(Boolean);
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
