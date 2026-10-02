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
  isSufficientVacancyDescription,
} from './extract.mjs';
import { extractLinks } from './careers-trail.mjs';
import { politeFetch } from './polite-fetch.mjs';
import { normalizeHost } from './registrable.mjs';
import {
  resolveDetailOrListingSwissGeography,
} from './location-evidence.mjs';
import { PROSPECTOR_DIR } from './config.mjs';
import { createSpecUrlPolicy } from './public-fetch-policy.mjs';
import { WAF_IP_BLOCK_STATUS } from '../transient-fetch.mjs';
import { CRAWLER_FETCH_OUTCOMES } from '../crawler-fetch-outcome.mjs';
import { fetchHtmlViaJinaWithRetry, looksLikeAntiBotChallenge } from '../jina-proxy.mjs';
import { launchChromium } from '../ensure-chromium.mjs';
import {
  extractUmantisListingEvidence,
  umantisVacancyIdentity,
} from './umantis-detail.mjs';
import { extractRuntimeDetailFields, listingEvidenceFields, runtimeDetailFallbackUrl } from './detail-extract.mjs';
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

const BROWSER_RESCUE_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Fetch a source page through a real browser after direct transport and the
 * clean-IP proxy have both hit the source's anti-bot wall. The caller still
 * owns the URL policy; this helper only turns an already-validated URL into
 * HTML and rejects a browser-rendered challenge instead of handing it to the
 * vacancy extractor as an empty page.
 *
 * @param {string} url
 * @param {{ timeoutMs?: number, attempts?: number }} [options]
 * @returns {Promise<string|null>}
 */
export async function fetchHtmlViaBrowser(url, { timeoutMs = 45000, attempts = 3 } = {}) {
  let browser;
  try {
    browser = await launchChromium({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    const context = await browser.newContext({
      userAgent: BROWSER_RESCUE_USER_AGENT,
      locale: 'de-CH',
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();
    let lastReason = 'unknown browser failure';
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: Math.max(Number(timeoutMs) || 0, 45000),
        });
        await page.waitForTimeout(attempt === 1 ? 2500 : 4500);
        const title = await page.title().catch(() => '');
        const bodyText = await page.locator('body').textContent().catch(() => '');
        const html = await page.content();
        if (!looksLikeAntiBotChallenge(`${title}\n${bodyText}\n${html}`)) {
          return html;
        }
        lastReason = !response || !response.ok()
          ? `HTTP ${response?.status?.() ?? 'no response'} with browser challenge marker`
          : 'browser challenge marker';
      } catch (error) {
        lastReason = error?.message || String(error);
      }
      if (attempt < attempts) await page.waitForTimeout(2500 * attempt);
    }
    console.warn(`⚠️ Browser rescue exhausted for ${url} (${lastReason}).`);
    return null;
  } catch (error) {
    console.warn(`⚠️ Browser rescue unavailable for ${url}: ${error?.message || error}.`);
    return null;
  } finally {
    await browser?.close().catch(() => {});
  }
}

/**
 * Run an opt-in browser rescue supplied by a source-specific parser.
 *
 * @param {string} url
 * @param {Record<string, any>} runtime
 * @returns {Promise<string|null>}
 */
async function tryBrowserRescue(url, runtime) {
  if (typeof runtime.browserFetchImpl !== 'function') return null;
  try {
    const body = await runtime.browserFetchImpl(url, { timeoutMs: runtime.timeoutMs });
    return typeof body === 'string' && body.trim() && !looksLikeAntiBotChallenge(body)
      ? body
      : null;
  } catch (error) {
    console.warn(`⚠️ Browser rescue failed for ${url}: ${error?.message || error}.`);
    return null;
  }
}

const SPEC_FETCH_METADATA_KEYS = ['fetchOutcome', 'discoveredCount', 'fetchDetail'];

/**
 * Keep a spec fetch verdict attached to the array without making it part of the
 * job payload. The standard crawler accepts this legacy array shape and reads
 * the fields before any merge or validation step.
 *
 * @param {any[]} target
 * @param {any[]|Record<string, any>} source
 * @returns {any[]}
 */
export function copySpecFetchMetadata(target, source) {
  for (const key of SPEC_FETCH_METADATA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source || {}, key)) continue;
    Object.defineProperty(target, key, {
      value: source[key],
      enumerable: false,
      configurable: true,
    });
  }
  return target;
}

/**
 * A spec may opt into an explicit outcome for a zero that remains after its
 * own rescue path. Unknown values are deliberately ignored: the shared
 * crawler vocabulary is fail-closed and must not gain a producer-only typo.
 *
 * @param {import('./synthesize.mjs').CrawlerSpec} spec
 * @returns {string|null}
 */
function configuredEmptyListingOutcome(spec) {
  const outcome = spec?.emptyListingOutcome;
  return typeof outcome === 'string' && CRAWLER_FETCH_OUTCOMES.has(outcome)
    ? outcome
    : null;
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
  if (spec.mode === 'template' || spec.detailEnrichment === true
    || normalizeListingCandidateText(spec.detailCandidateText)) return true;
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
  // Select only publishable address fields. `decision.candidate` also carries
  // duplicateCandidates, which is a diagnostic collision trace and must not
  // enter a persisted vacancy or grow on a later evidence fold.
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

/**
 * Fetch one page on the spec's polite, public-network-only transport.
 *
 * Exported so offline analyses reach the same pages through the same robots,
 * redirect and DNS checks the promoted crawler goes through.
 *
 * @param {string} url @param {any} urlPolicy @param {Record<string, any>} runtime
 */
export async function fetchRuntimePage(url, urlPolicy, runtime) {
  const notifyPageFetched = (page) => {
    // This is an observational, synchronous hook: its return value is
    // deliberately ignored so it cannot change the fetch result or delay the
    // crawler transport.
    if (typeof runtime.onPageFetched === 'function') void runtime.onPageFetched(page, url);
    return page;
  };
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
  let wafProxyExhausted = false;
  const directChallenge = result.ok && looksLikeAntiBotChallenge(result.body);
  const connectionLevelFailure = !result.policyBlocked
    && !result.blockedByRobots
    && !result.status
    && Boolean(result.transportError);
  const antiBotResponse = directChallenge || WAF_IP_BLOCK_STATUS.has(Number(result.status));

  // A WAF may answer HTTP 200 with an interstitial instead of a hard block.
  // Treat that response like the existing 403/406/415/451 rescue path: a
  // successful status is not evidence that the source page was observed when
  // the body is an explicit anti-bot challenge. Without this check a promoted
  // spec crawler feeds the interstitial to vacancy extraction, gets zero rows,
  // and the standard pipeline records a misleading `no-jobs-parsed` bail-out.
  if (result.ok && !directChallenge) return notifyPageFetched(result);

  // Two source-side egress failures can be rescued by the clean-IP Jina path:
  // (a) a public career page answers 403/406/415/451, or an explicit 200
  // challenge, only to the GitHub Actions egress IP; (b) the runner cannot
  // establish a connection at all while a clean egress can still reach the
  // source. The ordinary crawler transport already rescues both classes; the
  // prospector used to be the one HTML path that failed closed before trying
  // it. Keep the target URL policy in front of the request, then reuse the
  // same retried Jina HTML rescue. If the rescue is exhausted, only a
  // confirmed anti-bot response is marked as such; a transport failure stays
  // a transport failure so the standard pipeline preserves the prior slice.
  if (!result.policyBlocked && !result.blockedByRobots
    && (connectionLevelFailure || antiBotResponse)
    && runtime.disableWafProxy !== true) {
    const proxiedBody = await fetchHtmlViaJinaWithRetry(url, {
      timeoutMs: runtime.timeoutMs,
      retries: runtime.jinaRetries,
      retryBaseMs: runtime.jinaRetryBaseMs,
      fetchImpl: runtime.jinaFetchImpl,
      sleepImpl: runtime.jinaSleepImpl,
    });
    if (proxiedBody != null && !looksLikeAntiBotChallenge(proxiedBody)) {
      return notifyPageFetched({
        ...result,
        ok: true,
        status: 200,
        url: result.url || url,
        body: proxiedBody,
        proxiedBy: 'jina',
      });
    }
    // Jina's retry helper filters its known error envelope, but some WAF
    // challenge variants are valid-looking 200 bodies. Keep the same
    // anti-bot safe-fail semantics for those variants instead of parsing a
    // challenge as an empty listing page.
    wafProxyExhausted = antiBotResponse;
  } else if (directChallenge) {
    // Proxy rescue was disabled or the response was otherwise not eligible;
    // the body is still a confirmed anti-bot fence, not an empty source.
    wafProxyExhausted = true;
  }

  // Some source WAFs also challenge every Jina egress IP. A source-specific
  // browser callback gets one last chance after the proxy, while the default
  // runtime remains unchanged for the rest of the prospector fleet.
  if (!result.policyBlocked && !result.blockedByRobots
    && (connectionLevelFailure || antiBotResponse)) {
    const browserBody = await tryBrowserRescue(url, runtime);
    if (browserBody) {
      return notifyPageFetched({
        ...result,
        ok: true,
        status: 200,
        url: result.url || url,
        body: browserBody,
        proxiedBy: 'browser',
      });
    }
  }

  // `HTTP 0` names the layer, not the cause. `politeFetch` now carries the
  // transport kind, so a failure that never reached a status says dns/tls/
  // timeout/reset instead of a zero nobody can act on (#7351).
  const reason = result.blockedByRobots
    ? 'blocked by robots.txt'
    : result.policyBlocked ? (result.error || 'blocked by public URL policy')
      : result.status ? `HTTP ${result.status}` : `transport ${result.transportError || 'other'}`;
  // `politeFetch()` uses status=0 as the no-response sentinel. Do not copy
  // that sentinel onto a transport error: `isConnectionLevelFetchError()`
  // treats a present status as evidence that an HTTP response was received.
  // Keep status=0 for robots/policy outcomes, where it is deliberate evidence
  // that the request was blocked before an HTTP response reached the parser.
  const hasHttpStatus = Number.isFinite(result.status) && result.status > 0;
  const preserveStatusSentinel = result.blockedByRobots || result.policyBlocked;
  const error = Object.assign(
    new Error(`Prospector fetch failed for ${result.url || url}: ${reason}`),
    {
      ...(hasHttpStatus || preserveStatusSentinel ? { status: result.status } : {}),
      retryable: !result.blockedByRobots && !result.policyBlocked && (!result.status || result.status >= 500),
      ...(wafProxyExhausted ? { antiBotExhausted: true } : {}),
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
 * Extract listing candidates using the same cascade as production.
 *
 * Keeping the template override here is important for the empty-page rescue:
 * a clean Jina response must be judged by the exact same evidence rules as
 * the direct response, otherwise the fallback could accept a navigation link
 * that the normal path would reject.
 *
 * @param {string} html
 * @param {string} effectiveUrl
 * @param {RegExp|null} templateRx
 * @returns {{ links: Array<{ url: string, text: string }>, candidates: any[] }}
 */
function extractListingCandidates(html, effectiveUrl, templateRx) {
  const links = extractLinks(html, effectiveUrl);
  const { vacancies } = extractVacancies(html, effectiveUrl, links);
  // jsonld/microdata are stronger evidence than any link-shape guess, so
  // only override when the generic cascade fell back to (or below) its own
  // template heuristic and we hold a better one already vetted for this spec.
  let candidates = vacancies;
  if (templateRx && vacancies.every((v) => v.via !== 'jsonld' && v.via !== 'microdata')) {
    let host = '';
    try { host = normalizeHost(new URL(effectiveUrl).hostname); } catch { /* skip override */ }
    const direct = host ? matchKnownTemplate(links, templateRx, host) : [];
    if (direct.length) candidates = direct;
  }
  // A candidate outside the learned detail template is never published (the
  // row builder drops it), so it must not count as a listing either. The
  // generic cascade's own template guess can pick page chrome: Hotelcareer's
  // empty employer page yields one "Karriere" footer link
  // (`/jobs/yourcareergroup-schweiz-gmbh-42198`). Counted as a candidate, it
  // skipped the empty-listing rescue and diagnostic and turned a page that
  // says "no vacancies" into a silent `no-jobs-parsed` (vereinaklosters,
  // corpus group 19 runs 36632563903 / 36778722341).
  if (templateRx) candidates = candidates.filter((v) => matchesDetailTemplate(v.sourceUrl || v.url, templateRx));
  return { links, candidates };
}

/**
 * @param {string} rawUrl
 * @param {RegExp} templateRx
 * @returns {boolean}
 */
function matchesDetailTemplate(rawUrl, templateRx) {
  try {
    return templateRx.test(new URL(rawUrl).pathname);
  } catch {
    return false;
  }
}

/**
 * Normalise the optional employer discriminator used when a public ATS feed
 * contains several employers. Matching the complete source-backed candidate
 * record (rather than only its URL) lets the same guard work for JSON-LD,
 * microdata and anchor-template listings without allowing a feed-wide
 * employer page to leak unrelated vacancies into a tenant slice.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeListingCandidateText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Apply a spec-declared source discriminator before detail enrichment.
 *
 * @param {import('./synthesize.mjs').CrawlerSpec} spec
 * @param {any} candidate
 * @returns {boolean}
 */
function matchesListingCandidateText(spec, candidate) {
  return candidateContainsText(spec.listingCandidateText, candidate);
}

/**
 * Apply a source discriminator to a candidate record. Listing candidates are
 * allowed to carry only title/link evidence; detail candidates additionally
 * carry the source-backed workplace labels and enriched description. Keeping
 * the normalization shared prevents a multi-employer ATS from being filtered
 * differently before and after detail enrichment.
 *
 * @param {unknown} requiredText
 * @param {any} candidate
 * @returns {boolean}
 */
function candidateContainsText(requiredText, candidate) {
  const needle = normalizeListingCandidateText(requiredText);
  if (!needle) return true;
  const haystack = normalizeListingCandidateText([
    candidate?.title,
    candidate?.url,
    candidate?.sourceUrl,
    candidate?.company,
    candidate?.location,
    candidate?.addressLocality,
    candidate?.addressRegion,
    candidate?.addressCountry,
    candidate?.postalCode,
    candidate?.streetAddress,
    candidate?.description,
    ...(Array.isArray(candidate?.workplaceLabels)
      ? candidate.workplaceLabels
      : [candidate?.workplaceLabels]),
  ].filter(Boolean).join(' '));
  return haystack.includes(needle);
}

/**
 * @param {import('./synthesize.mjs').CrawlerSpec} spec
 * @param {any} candidate
 * @returns {boolean}
 */
function matchesDetailCandidateText(spec, candidate) {
  return candidateContainsText(spec.detailCandidateText, candidate);
}

/**
 * @param {import('./synthesize.mjs').CrawlerSpec} spec
 * @param {any[]} candidates
 * @returns {any[]}
 */
function filterListingCandidates(spec, candidates) {
  if (!normalizeListingCandidateText(spec.listingCandidateText)) return candidates;
  const filtered = candidates.filter((candidate) => matchesListingCandidateText(spec, candidate));
  if (filtered.length !== candidates.length) {
    console.warn(
      `[prospector:${spec.companyKey}] listing discriminator kept `
      + `${filtered.length}/${candidates.length} source candidates`,
    );
  }
  return filtered;
}

const DEFAULT_PAGINATION_MAX_PAGES = 50;
const DEFAULT_PAGINATION_MIN_COVERAGE = 0.95;

/**
 * Resolve the optional `spec.pagination` block.
 *
 * `maxPages` bounds the walk; reaching it with a next link still present is a
 * truncated listing and fails the run. `declaredTotalPattern` is a regex source
 * with one capture group that reads the source's own vacancy count from the
 * seed page; the walk must then collect at least `minCoverage` of it. The
 * tolerance absorbs a vacancy closed while the pages are being read, which
 * shifts the next page up by one row. `pageStateParams` names the query
 * parameters the listing echoes into its detail links (`sf_paged`); only those
 * are stripped, so a real detail parameter (`lang`, a tenant id) survives.
 *
 * @param {import('./synthesize.mjs').CrawlerSpec} spec
 * @returns {{ maxPages: number, minCoverage: number, declaredTotalRx: RegExp|null, pageStateParams: string[] }}
 */
export function normalizeSpecPagination(spec) {
  const raw = spec?.pagination && typeof spec.pagination === 'object' ? spec.pagination : {};
  const maxPages = Number.isInteger(raw.maxPages) && raw.maxPages > 0
    ? raw.maxPages
    : DEFAULT_PAGINATION_MAX_PAGES;
  const minCoverage = Number.isFinite(raw.minCoverage) && raw.minCoverage > 0 && raw.minCoverage <= 1
    ? raw.minCoverage
    : DEFAULT_PAGINATION_MIN_COVERAGE;
  const declaredTotalRx = raw.declaredTotalPattern ? new RegExp(String(raw.declaredTotalPattern), 'i') : null;
  const pageStateParams = Array.isArray(raw.pageStateParams)
    ? raw.pageStateParams.map((name) => String(name || '').trim()).filter(Boolean)
    : [];
  const selfNextIsTerminal = raw.selfNextIsTerminal === true;
  return { maxPages, minCoverage, declaredTotalRx, pageStateParams, selfNextIsTerminal };
}

/**
 * Read the vacancy count the source declares on its own listing page.
 *
 * A spec that declares the pattern and does not find it fails closed: without
 * the count the walk cannot prove it read the whole listing, and a markup
 * change is exactly when it would silently stop at page one again.
 *
 * @param {string} html
 * @param {{ declaredTotalRx: RegExp|null }} pagination
 * @param {import('./synthesize.mjs').CrawlerSpec} spec
 * @returns {number|null}
 */
export function readDeclaredListingTotal(html, pagination, spec) {
  if (!pagination.declaredTotalRx) return null;
  const match = pagination.declaredTotalRx.exec(String(html || ''));
  const total = match ? Number(String(match[1] || '').replace(/[^\d]/g, '')) : NaN;
  if (!Number.isInteger(total) || total < 0 || !match?.[1]) {
    throw new Error(
      `[prospector:${spec.companyKey}] totale dichiarato dalla fonte non trovato `
      + `(declaredTotalPattern ${pagination.declaredTotalRx.source}): impossibile provare la listing completa`,
    );
  }
  return total;
}

/**
 * Remove from a detail URL the declared pagination parameters it shares, name
 * and value, with the listing page it was found on.
 *
 * @param {string} url
 * @param {string} pageUrl
 * @param {string[]} [stateParams] Parameter names declared as listing state
 * @returns {string}
 */
export function stripListingPageState(url, pageUrl, stateParams = []) {
  if (!stateParams.length) return url;
  let detail;
  let page;
  try {
    detail = new URL(url);
    page = new URL(pageUrl);
  } catch {
    return url;
  }
  const pageState = new Set([...page.searchParams]
    .filter(([name]) => stateParams.includes(name))
    .map(([name, value]) => `${name}=${value}`));
  const kept = [...detail.searchParams].filter(([name, value]) => !pageState.has(`${name}=${value}`));
  if (kept.length === [...detail.searchParams].length) return url;
  detail.search = new URLSearchParams(kept).toString();
  return detail.href;
}

/**
 * The listing's next page, from an `<a>` or `<link>` carrying `rel="next"`.
 *
 * Only a same-origin target counts: a next link to another host is not the
 * continuation of this listing.
 *
 * @param {string} html
 * @param {string} pageUrl
 * @returns {string|null}
 */
export function findNextListingPageUrl(html, pageUrl) {
  let current;
  try {
    current = new URL(pageUrl);
  } catch {
    return null;
  }
  const origin = current.origin;
  current.hash = '';
  const tagRx = /<(?:a|link)\b[^>]*>/gi;
  let tag;
  while ((tag = tagRx.exec(String(html || '')))) {
    const rel = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag[0]);
    const relValue = rel ? (rel[1] ?? rel[2] ?? rel[3] ?? '') : '';
    if (!relValue.toLowerCase().split(/\s+/).includes('next')) continue;
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag[0]);
    const hrefValue = href ? (href[1] ?? href[2] ?? href[3] ?? '') : '';
    if (!hrefValue) continue;
    let next;
    try { next = new URL(hrefValue.replace(/&amp;/g, '&'), pageUrl); } catch { continue; }
    if (next.origin !== origin) continue;
    const samePageFragment = hrefValue.trim() === '#'
      && next.pathname === current.pathname
      && next.search === current.search;
    next.hash = '';
    // A few sources leave a placeholder `rel=next href="#"` on their last
    // page. It is a same-page fragment, not a continuation. Do not generalize
    // this to every URL equal to the current page: a real pagination loop can
    // expose the current page as an absolute or query-bearing URL and must
    // still reach the fail-closed visited-page guard.
    if (samePageFragment) continue;
    return next.href;
  }
  return null;
}

/**
 * A fetch failure that proves the page does not exist: a definitive HTTP 404,
 * not retried, and not an anti-bot fence answering 404.
 */
function isTerminalNotFound(error) {
  return error?.status === 404
    && error?.retryable === false
    && !error?.antiBotExhausted;
}

function numericPathPage(url) {
  const match = String(url.pathname || '').match(/^(.*\/page\/)(\d+)(\/.*)?$/i);
  if (!match) return null;
  return {
    prefix: match[1],
    number: Number(match[2]),
    suffix: match[3] || '',
  };
}

function numericQueryPage(url) {
  for (const [name, value] of url.searchParams) {
    if (/(?:^|[_-])(?:page|paged|p)(?:$|[_-])/i.test(name) && /^\d+$/.test(value)) {
      return { name, number: Number(value) };
    }
  }
  return null;
}

function comparableSearchParams(url, excludedName) {
  return [...url.searchParams]
    .filter(([name]) => name !== excludedName)
    .sort(([leftName, leftValue], [rightName, rightValue]) => (
      leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue)
    ));
}

/**
 * The furthest numbered page the current listing announces on `nextUrl`'s
 * route (same path prefix/suffix, or same query parameter and other params).
 *
 * Only numbered controls count — a link whose text, aria-label or title is a
 * page number. The rel=next link itself is never evidence: it is the target
 * being judged.
 *
 * @param {string} html
 * @param {string} pageUrl
 * @param {string} nextUrl
 * @returns {{ number: number, url: string }|null}
 */
export function largestAnnouncedListingPage(html, pageUrl, nextUrl) {
  let current;
  let next;
  try {
    current = new URL(pageUrl);
    next = new URL(nextUrl, pageUrl);
  } catch {
    return null;
  }
  if (current.origin !== next.origin) return null;

  const nextPathPage = numericPathPage(next);
  const nextQueryPage = nextPathPage ? null : numericQueryPage(next);
  if (!nextPathPage && !nextQueryPage) return null;

  const sourceHtml = String(html || '');
  const tagRx = /<(?:a|link)\b[^>]*>/gi;
  let tag;
  let largest = null;
  while ((tag = tagRx.exec(sourceHtml))) {
    const tagName = /^<\s*([a-z]+)/i.exec(tag[0])?.[1]?.toLowerCase() || '';
    const rel = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag[0]);
    const relValue = rel ? (rel[1] ?? rel[2] ?? rel[3] ?? '') : '';
    // The next link is the one-past-the-end signal being validated. It is not
    // independent pagination evidence and must never make itself the largest
    // announced page.
    if (relValue.toLowerCase().split(/\s+/).includes('next')) continue;
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag[0]);
    const hrefValue = href ? (href[1] ?? href[2] ?? href[3] ?? '') : '';
    if (!hrefValue) continue;
    const close = tagName === 'a' ? sourceHtml.indexOf('</a', tagRx.lastIndex) : -1;
    const innerText = (close >= 0 ? sourceHtml.slice(tagRx.lastIndex, close) : '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&(?:nbsp|amp);/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const ariaLabel = /\baria-label\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag[0]);
    const title = /\btitle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag[0]);
    const controlLabel = [
      innerText,
      ariaLabel ? (ariaLabel[1] ?? ariaLabel[2] ?? ariaLabel[3] ?? '') : '',
      title ? (title[1] ?? title[2] ?? title[3] ?? '') : '',
    ].join(' ');
    // A same-origin job/detail link can itself contain `/page/<n>` or
    // `?page=<n>`. Require a distinct numbered control label so those links
    // do not masquerade as pagination evidence.
    if (!/^\d+$/.test(innerText)
      && !/^\d+$/.test(ariaLabel ? (ariaLabel[1] ?? ariaLabel[2] ?? ariaLabel[3] ?? '').trim() : '')
      && !/^\d+$/.test(title ? (title[1] ?? title[2] ?? title[3] ?? '').trim() : '')
      && !/(?:page|seite|pagina)\s*#?\s*\d+/i.test(controlLabel)) continue;
    let candidate;
    try { candidate = new URL(hrefValue.replace(/&amp;/g, '&'), pageUrl); } catch { continue; }
    if (candidate.origin !== current.origin) continue;

    if (nextPathPage) {
      const candidatePage = numericPathPage(candidate);
      if (!candidatePage
        || candidatePage.prefix !== nextPathPage.prefix
        || candidatePage.suffix !== nextPathPage.suffix
        || candidate.search !== next.search) continue;
      if (!largest || candidatePage.number > largest.number) {
        largest = { number: candidatePage.number, url: candidate.href };
      }
      continue;
    }

    const candidatePage = numericQueryPage(candidate);
    if (!candidatePage
      || candidate.pathname !== next.pathname
      || candidatePage.name !== nextQueryPage.name
      || JSON.stringify(comparableSearchParams(candidate, candidatePage.name))
        !== JSON.stringify(comparableSearchParams(next, nextQueryPage.name))) continue;
    if (!largest || candidatePage.number > largest.number) {
      largest = { number: candidatePage.number, url: candidate.href };
    }
  }

  return largest;
}

/**
 * Whether `nextUrl` is the last numbered page the current listing announces.
 *
 * A few sources expose a rel=next link to a one-past-the-end page. This helper
 * only recognizes that case when the page itself contains a numbered
 * pagination control whose largest same-route number is the rel=next target.
 *
 * @param {string} html
 * @param {string} pageUrl
 * @param {string} nextUrl
 * @returns {boolean}
 */
export function isLastAnnouncedListingPage(html, pageUrl, nextUrl) {
  const largest = largestAnnouncedListingPage(html, pageUrl, nextUrl);
  return largest != null && largest.number === listingPageNumber(nextUrl, pageUrl);
}

/**
 * The page number a numbered listing URL carries (`/page/<n>/` or a
 * `page`/`paged`/`p` query parameter), or null.
 *
 * @param {string} url
 * @param {string} [base]
 * @returns {number|null}
 */
function listingPageNumber(url, base) {
  let parsed;
  try { parsed = new URL(url, base); } catch { return null; }
  return numericPathPage(parsed)?.number ?? numericQueryPage(parsed)?.number ?? null;
}

/**
 * Whether `nextUrl` is the page right after `pageUrl` in a numbered listing.
 * A seed without a page number is page 1.
 *
 * @param {string} pageUrl
 * @param {string} nextUrl
 * @returns {boolean}
 */
function isNextSequentialListingPage(pageUrl, nextUrl) {
  const nextNumber = listingPageNumber(nextUrl, pageUrl);
  if (nextNumber == null) return false;
  return nextNumber === (listingPageNumber(pageUrl) ?? 1) + 1;
}

/**
 * Compare two listing URLs after URL parsing and fragment removal. A small
 * number of sources put a self-referential `rel=next` on their final page;
 * only an explicitly opted-in spec may interpret that source quirk as an end
 * marker. The default loop guard remains fail-closed for every other spec.
 */
function isSameListingPageUrl(left, right) {
  try {
    const a = new URL(left);
    const b = new URL(right);
    a.hash = '';
    b.hash = '';
    return a.href === b.href;
  } catch {
    return String(left || '').trim() === String(right || '').trim();
  }
}

/**
 * Listing rows a spec yields, before any detail-page enrichment.
 *
 * Extracted from `runSpecInProduction()` because the offline measurements have
 * to read the same rows production reads: an analysis that re-implements the
 * listing cascade measures a different program than the one that publishes
 * (see `scripts/prospect-measure-postal-variance.mjs`). The URL policy is
 * passed in and its dispatcher is closed by the caller, which is what lets the
 * caller keep fetching detail pages on the same polite transport.
 *
 * @param {import('./synthesize.mjs').CrawlerSpec} spec
 * @param {Record<string, any>} runtime
 * @param {any} validateUrl URL policy from `createSpecUrlPolicy()`
 * @returns {Promise<Array<Record<string, any>>>}
 */
export async function collectSpecListingRows(spec, runtime, validateUrl) {
  /** @type {Map<string, any>} */
  const bySlug = new Map();
  const templateRx = spec.detailTemplate?.length ? templateToRegex(spec.detailTemplate) : null;
  const emptyOutcome = spec.rescueOnEmptyListing === true
    && runtime.disableWafProxy !== true
    ? configuredEmptyListingOutcome(spec)
    : null;
  const emptyDetails = [];

  /**
   * Add one page of listing candidates to the de-duplicated row set.
   *
   * A page reached by pagination may echo its own state into the detail links
   * (`/job/sa036315/?sf_paged=2`); `pageUrl` strips it so the vacancy keeps one
   * URL, and therefore one id, whichever page it is listed on.
   *
   * @param {any[]} candidates
   * @param {Map<string, any>} umantisListingEvidence
   * @param {string} [pageUrl]
   * @param {string[]} [stateParams]
   */
  const addListingCandidates = async (candidates, umantisListingEvidence, pageUrl = '', stateParams = []) => {
    for (const candidate of candidates) {
      if (!candidate.title || !candidate.url) continue;
      const v = pageUrl
        ? {
          ...candidate,
          url: stripListingPageState(candidate.url, pageUrl, stateParams),
          ...(candidate.sourceUrl ? { sourceUrl: stripListingPageState(candidate.sourceUrl, pageUrl, stateParams) } : {}),
        }
        : candidate;
      const vacancy = /** @type {any} */ (v);
      const sourceUrl = vacancy.sourceUrl || v.url;
      try { await validateUrl(sourceUrl); } catch { continue; }
      if (templateRx && !matchesDetailTemplate(sourceUrl, templateRx)) continue;
      if (bySlug.has(v.url)) continue;
      const listingEvidence = umantisListingEvidence.get(umantisVacancyIdentity(sourceUrl));
      bySlug.set(v.url, {
        title: v.title,
        url: v.url,
        ...(vacancy.sourceUrl ? { sourceUrl: vacancy.sourceUrl } : {}),
        location: vacancy.location || '',
        addressLocality: vacancy.addressLocality || '',
        addressRegion: vacancy.addressRegion || '',
        addressCountry: vacancy.addressCountry || '',
        postalCode: vacancy.postalCode || '',
        streetAddress: vacancy.streetAddress || '',
        locationCandidates: [...(vacancy.locationCandidates || [])],
        // Stessa piega dell'evidenza di listing che applica il sintetizzatore.
        ...listingEvidenceFields(vacancy, listingEvidence),
        description: vacancy.description || '',
        postedAt: vacancy.postedDate || null,
        company: vacancy.company || spec.companyName,
      });
    }
  };

  for (const seed of spec.seedUrls || []) {
    let page;
    try {
      page = await fetchRuntimePage(seed, validateUrl, runtime);
    } catch (err) {
      // Let the standard pipeline classify it: a connection-level failure is
      // infra and must soft-exit, an HTTP status is a real break.
      throw err;
    }
    let html = page.body;
    if (!html) continue;
    let effectiveSeedUrl = page.url || seed;
    let umantisListingEvidence = spec.platform === 'umantis.com'
      ? extractUmantisListingEvidence(html, effectiveSeedUrl)
      : new Map();
    let { links, candidates } = extractListingCandidates(html, effectiveSeedUrl, templateRx);
    candidates = filterListingCandidates(spec, candidates);

    // Some protected boards answer the direct request with a 200 interstitial
    // that has no stable challenge marker. That page is indistinguishable from
    // a legitimate empty employer page until the same seed is viewed through
    // the clean-IP rescue. Opt-in is deliberately spec-scoped: only a crawler
    // with evidence of this source-specific failure pays for the extra fetch.
    if (!candidates.length && spec.rescueOnEmptyListing === true
      && runtime.disableWafProxy !== true) {
      // `fetchRuntimePage()` may already have used Jina to replace a marked
      // challenge. That response can still be a 200 interstitial that is not
      // recognised by the proxy-body detector, so it is safe-looking to the
      // transport layer but still yields no candidates. Give the opt-in spec
      // one more clean-IP rescue in that case; the candidate check below is
      // the source-backed acceptance gate and this block runs only once per
      // seed, so it cannot loop.
      const proxiedBody = await fetchHtmlViaJinaWithRetry(effectiveSeedUrl, {
        timeoutMs: runtime.timeoutMs,
        retries: runtime.jinaRetries,
        retryBaseMs: runtime.jinaRetryBaseMs,
        fetchImpl: runtime.jinaFetchImpl,
        sleepImpl: runtime.jinaSleepImpl,
      });
      if (proxiedBody != null && !looksLikeAntiBotChallenge(proxiedBody)) {
        const rescuedRaw = extractListingCandidates(proxiedBody, effectiveSeedUrl, templateRx);
        const rescued = {
          ...rescuedRaw,
          candidates: filterListingCandidates(spec, rescuedRaw.candidates),
        };
        if (rescued.candidates.length) {
          console.warn(
            `[prospector:${spec.companyKey}] direct seed yielded no listings; using clean-IP rescue (${rescued.candidates.length} candidates)`,
          );
          html = proxiedBody;
          ({ links, candidates } = rescued);
          effectiveSeedUrl = page.url || seed;
          umantisListingEvidence = spec.platform === 'umantis.com'
            ? extractUmantisListingEvidence(html, effectiveSeedUrl)
            : new Map();
        }
      }
      if (!candidates.length) {
        const browserBody = await tryBrowserRescue(effectiveSeedUrl, runtime);
        if (browserBody) {
          const rescuedRaw = extractListingCandidates(browserBody, effectiveSeedUrl, templateRx);
          const rescued = {
            ...rescuedRaw,
            candidates: filterListingCandidates(spec, rescuedRaw.candidates),
          };
          if (rescued.candidates.length) {
            console.warn(
              `[prospector:${spec.companyKey}] direct seed yielded no listings; using browser rescue (${rescued.candidates.length} candidates)`,
            );
            html = browserBody;
            ({ links, candidates } = rescued);
            effectiveSeedUrl = page.url || seed;
            umantisListingEvidence = spec.platform === 'umantis.com'
              ? extractUmantisListingEvidence(html, effectiveSeedUrl)
              : new Map();
          }
        }
      }
    }
    if (!candidates.length) {
      // Un seed che risponde 200 senza nessun annuncio è indistinguibile, a
      // valle, da un datore di lavoro senza offerte: `vereinaklosters`
      // (hotelcareer.ch) dà due annunci da un IP pulito e zero righe dal
      // runner CI, senza altra traccia nel log. Il titolo e il numero di link
      // della pagina ricevuta dicono se era la pagina attesa o un interstiziale.
      const pageTitle = (/<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(html)?.[1] || '').replace(/\s+/g, ' ').trim();
      console.warn(`[prospector:${spec.companyKey}] nessun annuncio su ${effectiveSeedUrl}: title="${pageTitle}", ${links.length} link, ${html.length} byte`);
      if (emptyOutcome) {
        emptyDetails.push(
          `${effectiveSeedUrl}: title="${pageTitle}", links=${links.length}, bytes=${html.length}`,
        );
      }
    }
    const seedRowsBefore = bySlug.size;
    await addListingCandidates(candidates, umantisListingEvidence);

    // Opt-in pagination (`spec.pagination`). A listing that shows only its
    // first page to a single-seed crawler makes every vacancy that scrolls
    // onto page 2 look closed: the miss grace then archives live jobs and the
    // anti-shrink guard aborts the slice (yellowshark, 1103 vacancies on 56
    // pages read as 20, run corpus 36380344842). Every page is read on the
    // same polite transport, and any failure propagates: publishing a partial
    // listing is exactly the failure this exists to prevent.
    if (spec.pagination) {
      const pagination = normalizeSpecPagination(spec);
      const declaredTotal = readDeclaredListingTotal(html, pagination, spec);
      const visited = new Set([effectiveSeedUrl]);
      let pageUrl = effectiveSeedUrl;
      let nextUrl = findNextListingPageUrl(html, pageUrl);
      let pages = 1;
      let currentPageCandidateCount = candidates.length;
      while (nextUrl) {
        if (pagination.selfNextIsTerminal && isSameListingPageUrl(nextUrl, pageUrl)) {
          console.warn(
            `[prospector:${spec.companyKey}] listing paginata: rel=next punta alla stessa pagina dopo ${pages} pagine; fine dichiarata dalla spec`,
          );
          break;
        }
        if (visited.has(nextUrl)) {
          // A next link back to a page already read is a loop or an alias,
          // not the end of the listing: stopping here would publish a partial
          // set as if it were complete.
          throw new Error(
            `[prospector:${spec.companyKey}] listing troncata: il link rel=next dopo ${pages} pagine `
            + `torna a una pagina gia letta (${nextUrl})`,
          );
        }
        if (pages >= pagination.maxPages) {
          throw new Error(
            `[prospector:${spec.companyKey}] listing troncata: ${pages} pagine lette, `
            + `maxPages=${pagination.maxPages} e un link rel=next ancora presente (${nextUrl})`,
          );
        }
        visited.add(nextUrl);
        let next;
        try {
          next = await fetchRuntimePage(nextUrl, validateUrl, runtime);
        } catch (error) {
          const readRows = bySlug.size - seedRowsBefore;
          const coverageSatisfied = declaredTotal != null
            && readRows >= Math.ceil(declaredTotal * pagination.minCoverage);
          const announcedFinal = currentPageCandidateCount > 0
            && isLastAnnouncedListingPage(html, pageUrl, nextUrl);
          const terminalNotFound = isTerminalNotFound(error);
          if (terminalNotFound && (coverageSatisfied || announcedFinal)) {
            console.warn(
              `[prospector:${spec.companyKey}] listing paginata: ${nextUrl} risponde HTTP 404; `
              + `fine della paginazione accettata (${coverageSatisfied ? 'copertura sufficiente' : 'ultima pagina annunciata'})`,
            );
            break;
          }
          // Announced page count overshooting the real listing: a source that
          // declares no total can announce pages past its end (stellentreff:
          // full page 57 links 58 and 59, both 404; page 1 announced 58; run
          // corpus 36988228462). The first missing page ends the walk only
          // when nothing contradicts that: the page just read had vacancies,
          // the 404 is the very next numbered page, and the furthest page the
          // listing announces is gone too (one probe request; a listing that
          // announces no numbered page past the 404 has nothing to probe). If
          // that page exists, the 404 is a hole in the middle and the walk
          // still fails closed. A source that declares a total keeps the
          // coverage rule above: its count is stronger evidence than a 404.
          if (terminalNotFound
            && declaredTotal == null
            && currentPageCandidateCount > 0
            && isNextSequentialListingPage(pageUrl, nextUrl)) {
            const furthest = largestAnnouncedListingPage(html, pageUrl, nextUrl);
            const probeUrl = furthest && furthest.number > (listingPageNumber(nextUrl, pageUrl) ?? 0)
              ? furthest.url
              : null;
            let probeError = null;
            if (probeUrl) {
              try {
                await fetchRuntimePage(probeUrl, validateUrl, runtime);
              } catch (caught) {
                probeError = caught;
              }
              if (!probeError) {
                throw new Error(
                  `[prospector:${spec.companyKey}] listing troncata: ${nextUrl} risponde HTTP 404 `
                  + `ma la pagina annunciata ${probeUrl} esiste (pagina mancante a meta listing)`,
                );
              }
            }
            if (!probeUrl || isTerminalNotFound(probeError)) {
              console.warn(
                `[prospector:${spec.companyKey}] listing paginata: ${nextUrl} risponde HTTP 404 dopo ${pages} pagine; `
                + `fine della paginazione accettata (${probeUrl
                  ? `anche l'ultima pagina annunciata ${probeUrl} risponde 404`
                  : 'nessuna pagina successiva annunciata'})`,
              );
              break;
            }
          }
          throw error;
        }
        pages += 1;
        pageUrl = next.url || nextUrl;
        const body = next.body || '';
        const nextEvidence = spec.platform === 'umantis.com'
          ? extractUmantisListingEvidence(body, pageUrl)
          : new Map();
        const extracted = extractListingCandidates(body, pageUrl, templateRx);
        const nextCandidates = filterListingCandidates(spec, extracted.candidates);
        await addListingCandidates(
          nextCandidates,
          nextEvidence,
          pageUrl,
          pagination.pageStateParams,
        );
        html = body;
        currentPageCandidateCount = nextCandidates.length;
        nextUrl = findNextListingPageUrl(body, pageUrl);
      }
      const seedRows = bySlug.size - seedRowsBefore;
      console.log(
        `[prospector:${spec.companyKey}] listing paginata: ${pages} pagine, ${seedRows} annunci`
        + (declaredTotal == null ? '' : ` (totale dichiarato dalla fonte: ${declaredTotal})`),
      );
      if (declaredTotal != null && seedRows < Math.ceil(declaredTotal * pagination.minCoverage)) {
        throw new Error(
          `[prospector:${spec.companyKey}] listing incompleta: ${seedRows}/${declaredTotal} annunci `
          + `dichiarati dalla fonte su ${pages} pagine (copertura minima ${pagination.minCoverage})`,
        );
      }
    } else if (candidates.length) {
      // Sibling observer: a seed that advertises a next page to a spec without
      // pagination is read as a truncated listing, one page wide.
      const unfollowed = findNextListingPageUrl(html, effectiveSeedUrl);
      if (unfollowed) {
        console.warn(
          `[prospector:${spec.companyKey}] la pagina seed espone un link rel=next non seguito `
          + `(${unfollowed}): la listing letta potrebbe essere solo la prima pagina `
          + `(${candidates.length} candidati). Dichiarare spec.pagination.`,
        );
      }
    }
  }
  const rows = [...bySlug.values()];
  // A configured outcome is evidence about an UNVERIFIED zero only. Never
  // attach it after a seed yielded accepted vacancies: a partial source result
  // must continue through the normal detail/geography gates instead of being
  // reinterpreted as a WAF failure.
  if (rows.length === 0 && emptyOutcome && emptyDetails.length > 0) {
    copySpecFetchMetadata(rows, {
      fetchOutcome: emptyOutcome,
      discoveredCount: 0,
      fetchDetail: emptyDetails.join('; '),
    });
  }
  return rows;
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
 *   sourceUrl?: string,
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
  const validateUrl = createSpecUrlPolicy(spec, { lookupImpl: runtime.lookupImpl || dnsLookup });
  try {
    const rows = await collectSpecListingRows(spec, runtime, validateUrl);
    if (!needsDetailEnrichment(spec, rows)) {
      const safeRows = rows.flatMap((row) => {
        const fields = geographyFieldsForDecision(resolveDetailOrListingSwissGeography({}, row));
        return fields ? [{ ...row, ...fields }] : [];
      });
      reportDroppedRows(spec, rows.length - safeRows.length, rows.length,
        'localita svizzera source-backed assente o non verificabile');
      return copySpecFetchMetadata(safeRows, rows);
    }

    // Template extraction has no per-row semantics. Visit the detail pages with
    // a bounded pool so location and full descriptions are source-backed.
    // Workers complete out of order; index-addressed writes keep the listing
    // order deterministic so stable downstream sorts do not churn job slices.
    const enriched = new Array(rows.length);
    const emptyOutcome = spec.rescueOnEmptyListing === true
      && runtime.disableWafProxy !== true
      ? configuredEmptyListingOutcome(spec)
      : null;
    let detailAntiBotFailures = 0;
    let geographyDrops = 0;
    let descriptionDrops = 0;
    let detailCandidateDrops = 0;
    let next = 0;
    const worker = async () => {
      while (next < rows.length) {
        const index = next++;
        const row = rows[index];
        try {
          const detailUrl = row.sourceUrl || row.url;
          let page;
          try {
            page = await fetchRuntimePage(detailUrl, validateUrl, runtime);
          } catch (error) {
            // Stessa regola di retry del validatore — see detail-extract.mjs.
            const fallbackUrl = runtimeDetailFallbackUrl(spec, error?.status, detailUrl);
            if (!fallbackUrl) throw error;
            page = await fetchRuntimePage(fallbackUrl, validateUrl, runtime);
          }
          // Same extractor the validator grades with — see detail-extract.mjs.
          const detail = extractRuntimeDetailFields(spec, page.body, page.url || detailUrl, {
            detailExtractor: runtime.detailExtractor,
            recordUrl: row.url,
          });
          const decision = resolveDetailOrListingSwissGeography(detail, row);
          const geography = geographyFieldsForDecision(decision);
          const description = isSufficientVacancyDescription(detail.description)
            ? detail.description
            : row.description;
          // Tenant identity is a detail-page contract. Listing fields remain
          // valid enrichment fallbacks below, but they must never satisfy the
          // detail discriminator when the detail response omits that evidence.
          const detailCandidate = { ...detail };
          if (!matchesDetailCandidateText(spec, detailCandidate)) {
            detailCandidateDrops++;
            continue;
          }
          const publishable = { ...row, title: detail.title || row.title, description,
            postedAt: detail.postedDate || row.postedAt,
            employmentType: detail.employmentType || row.employmentType };
          // Free-text NPA variance is measured for diagnostics, but its current
          // precision/recall is not an authority for indexed job geography.
          // Keep the source-backed contract fail-closed until the experiment
          // proves it is safe to wire into publication.
          if (!geography) { geographyDrops++; continue; }
          if (!isSufficientVacancyDescription(description)) { descriptionDrops++; continue; }
          enriched[index] = { ...publishable, ...geography };
        } catch (err) {
          if (err?.antiBotExhausted) detailAntiBotFailures++;
          // A failed detail fetch/extraction carries no source-backed tenant
          // evidence. Never let index-only fields satisfy the detail gate.
          detailCandidateDrops++;
        }
      }
    };
    const concurrency = Math.max(1, Math.min(8, Number(spec.detailFetchWorkers) || 4));
    await Promise.all(Array.from({ length: concurrency }, worker));
    reportDroppedRows(spec, geographyDrops, rows.length,
      'localita svizzera source-backed assente o non verificabile');
    reportDroppedRows(spec, descriptionDrops, rows.length,
      'descrizione source-backed assente o non verificabile');
    reportDroppedRows(spec, detailCandidateDrops, rows.length,
      'identità tenant assente nella pagina dettaglio source-backed');
    const publishedRows = enriched.filter(Boolean);
    // A protected source can expose real listing links while blocking every
    // detail page. Without carrying the same explicit outcome used by the
    // zero-candidate rescue, the standard pipeline turns that proven outage
    // into a misleading generic `no-jobs-parsed` result. Only classify this
    // narrow case when every candidate exhausted the anti-bot rescue and the
    // spec explicitly opted into an empty-listing outcome; ordinary parser or
    // geography drops remain fail-closed without reinterpretation.
    if (publishedRows.length === 0 && rows.length > 0
      && emptyOutcome && detailAntiBotFailures === rows.length) {
      copySpecFetchMetadata(publishedRows, {
        fetchOutcome: emptyOutcome,
        discoveredCount: rows.length,
        fetchDetail: `${rows.length} detail page(s) exhausted anti-bot rescue`,
      });
    }
    return copySpecFetchMetadata(publishedRows, rows);
  } finally {
    try {
      await validateUrl.dispatcher.close();
    } catch (error) {
      console.warn(`[prospector:${spec.companyKey}] dispatcher cleanup failed:`, error);
    }
  }
}

/**
 * Turn a `/annunci-lavoro/*` style template into a matcher.
 *
 * `*` stands for one variable segment and `#` for a numeric one — the same two
 * placeholders `pathTemplate()` emits, so a template always round-trips.
 *
 * A spec may declare several templates: a multilingual site publishes the same
 * listing page under one URL shape per language (okjob links both
 * `/offres-demplois/<slug>/` and `/de/jobangebote/<slug>/` from the same seed),
 * and a single shape would silently drop every vacancy of the other languages.
 *
 * @param {string | string[]} template
 * @returns {RegExp}
 */
export function templateToRegex(template) {
  const templates = (Array.isArray(template) ? template : [template]).filter(Boolean);
  const bodies = templates.map((one) => String(one)
    .split('/')
    .map((seg) => {
      if (seg === '*') return '[^/]+';
      if (seg === '#') return '\\d+';
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/'));
  return new RegExp(`^(?:${bodies.join('|')})/?$`);
}
