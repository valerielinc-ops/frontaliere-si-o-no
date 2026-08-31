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
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { fetchHtml } from '../crawler-template.mjs';
import { extractVacancies, extractDetailFields } from './extract.mjs';
import { extractLinks } from './careers-trail.mjs';
import { normalizeHost } from './registrable.mjs';
import { resolveDetailOrListingSwissGeography } from './location-evidence.mjs';
import { PROSPECTOR_DIR } from './config.mjs';

function isPrivateOrLocalAddress(address = '') {
  const value = String(address || '').toLowerCase().split('%')[0];
  if (isIP(value) === 4) {
    const octets = value.split('.').map(Number);
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19));
  }
  if (isIP(value) === 6) {
    if (value === '::' || value === '::1') return true;
    if (/^(?:fc|fd|fe[89a-f]|ff)/i.test(value)) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value)?.[1];
    return mapped ? isPrivateOrLocalAddress(mapped) : false;
  }
  return false;
}

/**
 * URL policy for a promoted spec. Seeds define exact allowed origins; an ATS
 * CDN/canonical host must be named explicitly in `allowedDetailOrigins`.
 */
export function createSpecUrlPolicy(spec, { lookupImpl = dnsLookup } = {}) {
  const configured = [...(spec.seedUrls || []), ...(spec.allowedDetailOrigins || [])];
  const allowedOrigins = new Set();
  for (const raw of configured) {
    try {
      const url = new URL(raw);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password) {
        allowedOrigins.add(url.origin);
      }
    } catch { /* invalid configured URLs are rejected when requested */ }
  }
  const checkedHosts = new Map();
  const assertPublicHost = async (hostname) => {
    const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost') || isPrivateOrLocalAddress(host)) {
      throw new Error(`unsafe prospector URL host: ${host || '[empty]'}`);
    }
    if (!checkedHosts.has(host)) {
      const check = (async () => {
        const resolved = await lookupImpl(host, { all: true, verbatim: true });
        const addresses = (Array.isArray(resolved) ? resolved : [resolved])
          .map((entry) => String(entry?.address || entry || ''))
          .filter((address) => isIP(address));
        if (!addresses.length || addresses.some((address) => isPrivateOrLocalAddress(address))) {
          throw new Error(`unsafe prospector DNS target: ${host}`);
        }
      })();
      checkedHosts.set(host, check);
      check.catch(() => checkedHosts.delete(host));
    }
    await checkedHosts.get(host);
  };
  return async (rawUrl) => {
    let url;
    try { url = new URL(rawUrl); } catch { throw new Error('invalid prospector URL'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsafe prospector URL protocol');
    if (url.username || url.password) throw new Error('credentials forbidden in prospector URL');
    if (!allowedOrigins.has(url.origin)) throw new Error(`prospector URL origin not allowed: ${url.origin}`);
    await assertPublicHost(url.hostname);
    return url.toString();
  };
}

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
 */
export function needsDetailEnrichment(spec) {
  return spec.mode === 'template' || spec.detailEnrichment === true;
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
export async function runSpecInProduction(spec, runtime = {}) {
  /** @type {Map<string, any>} */
  const bySlug = new Map();
  const templateRx = spec.detailTemplate ? templateToRegex(spec.detailTemplate) : null;
  const validateUrl = createSpecUrlPolicy(spec, { lookupImpl: runtime.lookupImpl || dnsLookup });

  for (const seed of spec.seedUrls || []) {
    let html;
    try {
      html = await fetchHtml(seed, { validateRedirectUrl: validateUrl });
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
      try { await validateUrl(v.url); } catch { continue; }
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
        addressCountry: v.addressCountry || '',
        locationCandidates: v.locationCandidates || [],
        description: v.description || '',
        postedAt: v.postedDate || null,
        company: v.company || spec.companyName,
      });
    }
  }
  const rows = [...bySlug.values()];
  if (!needsDetailEnrichment(spec)) {
    const safeRows = rows.flatMap((row) => {
      const { geography } = resolveDetailOrListingSwissGeography({}, row);
      return geography ? [{ ...row, ...geography }] : [];
    });
    reportDroppedRows(spec, rows.length - safeRows.length, rows.length,
      'localita svizzera source-backed assente o non verificabile');
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
        const detail = extractDetailFields(
          await fetchHtml(row.url, { validateRedirectUrl: validateUrl }),
          row.url,
        );
        const decision = resolveDetailOrListingSwissGeography(detail, row);
        const geography = decision.geography;
        const description = detail.description || row.description;
        if (!geography) { geographyDrops++; continue; }
        if (!description) { descriptionDrops++; continue; }
        enriched[index] = { ...row, ...geography, title: detail.title || row.title, description,
          postedAt: detail.postedDate || row.postedAt,
          employmentType: detail.employmentType || row.employmentType };
      } catch (err) {
        // A row without both source-backed fields must not be published with a
        // fabricated employer default. Keep already complete index rows only.
        const { geography } = resolveDetailOrListingSwissGeography({}, row);
        if (!geography) geographyDrops++;
        else if (!row.description) descriptionDrops++;
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
