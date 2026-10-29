/**
 * Crawler synthesis — turn a traced candidate into a runnable crawler spec.
 *
 * A spec, not a hand-written parser. The extraction cascade already reads
 * JSON-LD, microdata and templated listings generically, so what a new employer
 * actually needs is a small declarative record: where to start, how the listing
 * was recognised, and how to reach a detail page. Emitting a spec instead of
 * code is what makes onboarding hundreds of micro-employers tractable — and it
 * keeps every one of them auditable in a diff.
 *
 * Specs are learned from the LIVE page, not assumed: the synthesiser fetches the
 * careers URL, runs the cascade, and records which rung fired and what it saw.
 * A spec that yields nothing is never written — a crawler that has never
 * extracted a vacancy is worse than no crawler, because the health monitor will
 * carry it as broken for ever.
 */
import { politeFetch } from './polite-fetch.mjs';
import { extractVacancies, isSufficientVacancyDescription, textOf } from './extract.mjs';
import { extractLinks, isRetryableTraceStatus } from './careers-trail.mjs';
import { resolveDetailOrListingSwissGeography } from './location-evidence.mjs';
import { normalizeHost, registrableDomain, tenantLabel } from './registrable.mjs';
import { KNOWN_AGGREGATOR_DOMAINS } from '../known-aggregator-domains.mjs';
import { createSpecUrlPolicy } from './public-fetch-policy.mjs';
import { isConnectionLevelFetchResult } from '../transient-fetch.mjs';
import { extractUmantisListingEvidence, umantisVacancyIdentity } from './umantis-detail.mjs';
import { listingEvidenceFields } from './detail-extract.mjs';
import { BREFISPERSONAL_PAGINATION } from './brefispersonal-contract.mjs';

const MAX_SYNTHESIS_FETCHES = 5;
const CAREER_LINK_RX = /(?:^|[\/_-])(?:jobs?|careers?|vacancies|karriere|stellen(?:angebote)?|offene-stellen|emplois?|carrieres?|offres-d-emploi|lavora|carriere|posizioni-aperte|offerte-di-lavoro|posti-vacanti)(?:[/?#._-]|$)/i;
const CAREER_LINK_TEXT_RX = /\b(jobs?|careers?|vacancies|karriere|stellen|emplois?|carri[eè]re|lavora|posizioni|offerte di lavoro|posti vacanti)\b/i;

function normalizedHttpUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(String(value));
    if (!/^https?:$/.test(url.protocol)) return '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function synthesisSeeds(candidate) {
  const careerSeeds = [candidate.careersUrl, ...(Array.isArray(candidate.careersUrls) ? candidate.careersUrls : [])]
    .map(normalizedHttpUrl)
    .filter(Boolean);
  const tenantHost = normalizeHost(candidate.tenantHost || '');
  const employerHost = normalizeHost(candidate.domain || '');
  const seen = new Set();
  const uniqueSeeds = (values) => {
    const seeds = [];
    for (const value of values) {
      const normalized = normalizedHttpUrl(value);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      seeds.push(normalized);
    }
    return seeds;
  };
  const priority = uniqueSeeds([
    careerSeeds[0],
    tenantHost ? `https://${tenantHost}/` : null,
    employerHost ? `https://${employerHost}/` : null,
  ]);
  const alternates = uniqueSeeds(careerSeeds.slice(1));
  return { priority, alternates };
}

function careerLinksFromPage(body, baseUrl) {
  return extractLinks(body, baseUrl)
    .filter((link) => CAREER_LINK_RX.test(new URL(link.url).pathname)
      || CAREER_LINK_TEXT_RX.test(link.text || ''))
    .map((link) => link.url);
}

/**
 * @typedef {Object} CrawlerSpec
 * @property {string} companyKey
 * @property {string} companyName
 * @property {string} companyHost
 * @property {string} platform            registrable domain of the ATS, '' when self-hosted
 * @property {'jsonld'|'microdata'|'template'} mode
 * @property {string[]} seedUrls
 * @property {string[]} [transportFallbackSeedUrls] Listing seeds tried only after a primary seed fails without receiving an HTTP response
 * @property {string[]} [allowedDetailOrigins] Exact extra origins reviewed for cross-origin ATS/CDN detail URLs
 * @property {string | string[]} [detailTemplate]    URL template(s) shared by the vacancy links
 * @property {string} [detailLocationLabel] Exact detail-page heading whose following paragraph names the vacancy workplace
 * @property {string} [listingCandidateText]         Normalised text required in a listing candidate
 * @property {string} [detailCandidateText]          Normalised text required in an enriched detail record
 * @property {{ nativeMarker: string, expectedText?: string, listingExpectedText?: string, foreignLocationOutOfScope?: boolean, listingMarker?: { tag?: string, class: string, containerTag?: string, containerClass: string } }} [tenantScope]
 *   Explicit source-native tenant identity. `nativeMarker` names a field the
 *   detail extractor returns; `listingMarker`, when present, names the source
 *   element within its containerClass that can prove a non-target tenant
 *   before enrichment. Neither a missing detail marker nor absent target text
 *   is a positive mismatch.
 * @property {boolean} [detailEnrichment] Fetch detail pages for authoritative fields
 * @property {Array<{ postalCode: string, locality: string, canton: string }>} [umantisListingCantonOverrides]
 *   Reviewed exact Umantis listing postcode/locality pairs used only to
 *   disambiguate the canton; the shared Swiss geography resolver still validates them.
 * @property {boolean} [rescueOnEmptyListing] Retry a zero-candidate seed through the clean-IP rescue
 * @property {'ok'|'filtered_empty'|'anti_bot_block'|'selector_miss'|'connection_error'} [emptyListingOutcome]
 *   Outcome to attach when the spec has no accepted listing after its configured rescue path
 * @property {number} [detailFetchWorkers] Maximum concurrent detail fetches
 * @property {'expected-filter'} [detailNotFoundPolicy] Treat definitive detail HTTP 404s as stale listing filters after enough valid detail rows prove the source
 * @property {number} [detailNotFoundMinimumPublished] Minimum valid detail rows required before 404s can be classified as expected filters
 * @property {number} [qualityContractVersion] Version of the quality evidence rules; bump to require fresh validations
 * @property {{ maxPages?: number, minCoverage?: number, declaredTotalPattern?: string, declaredPageCountPattern?: string, stopAfterDeclaredPageCount?: boolean, pageStateParams?: string[], selfNextIsTerminal?: boolean, countDuplicateRowsForCoverage?: boolean }} [pagination]
 *   Follow the seed's `rel="next"` pages; with `declaredTotalPattern` the walk must
 *   collect `minCoverage` of the count the source declares, or the run fails closed;
 *   `declaredPageCountPattern` can provide an explicit terminal page count for
 *   sources whose generated `rel="next"` survives past the last real page;
 *   `stopAfterDeclaredPageCount` opts into that terminal boundary and fails
 *   closed when the source does not declare it;
 *   `pageStateParams` are stripped from detail URLs found on later pages;
 *   `selfNextIsTerminal` is a source-specific declaration that a self-link on
 *   the final page is an end marker rather than an incomplete listing
 * @property {{ url: string, method?: 'GET', params?: Record<string, string|number|boolean>, pageParam?: string, maxPages?: number, responseFormat?: 'json'|'jsonp', responseHtmlField?: string, responseMaxPagesField?: string, responseMaxNumPages?: number }} [listingEndpoint]
 *   Fetch a source-owned JSON/JSONP listing endpoint instead of assuming the
 *   seed HTML contains the rendered vacancy cards. The endpoint response must
 *   expose the source's listing HTML and either `max_num_pages` or the
 *   explicitly reviewed `responseMaxNumPages` bound so pagination remains
 *   fail-closed.
 * @property {number} sampleVacancyCount
 * @property {string[]} sampleTitles
 * @property {string} [canton]
 * @property {string} sourceLang
 * @property {string} learnedAt
 */

/** Rough language read of a page, enough to set `sourceLang` on the jobs. */
export function detectPageLang(html = '') {
  const declared = /<html[^>]*\blang\s*=\s*["']([a-z]{2})/i.exec(html)?.[1];
  if (declared && ['it', 'de', 'fr', 'en'].includes(declared)) return declared;
  const t = textOf(html).toLowerCase().slice(0, 6000);
  const score = {
    it: (t.match(/\b(e|di|il|la|per|con|del|della|lavoro|azienda|nostra)\b/g) || []).length,
    de: (t.match(/\b(und|der|die|das|für|mit|bei|unsere|stellen|arbeit)\b/g) || []).length,
    fr: (t.match(/\b(et|le|la|les|pour|avec|notre|emploi|entreprise)\b/g) || []).length,
    en: (t.match(/\b(and|the|for|with|our|job|company|apply)\b/g) || []).length,
  };
  return Object.entries(score).sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * The longest common URL template across a set of vacancy links — the pattern a
 * validator can later use to tell "this link is a vacancy" from "this link is
 * the About page".
 *
 * @param {string[]} urls
 * @returns {string}
 */
export function commonUrlTemplate(urls = []) {
  const paths = urls.map((u) => { try { return new URL(u).pathname; } catch { return ''; } }).filter(Boolean);
  if (paths.length < 2) return paths[0] || '';
  const split = paths.map((p) => p.split('/'));
  const out = [];
  for (let i = 0; i < split[0].length; i++) {
    const seg = split[0][i];
    out.push(split.every((s) => s[i] === seg) ? seg : '*');
  }
  return out.join('/');
}

// Hosted ATS vendors often expose every employer from an infrastructure label
// such as `apply.refline.ch` or `jobs.vendor.example`. Using that label as the
// crawler key collides with an existing hand-written crawler (and lets a later
// synthesis overwrite its spec). Keep the tenant label for name-like hosts,
// but derive the key from the employer name when the label is only platform
// plumbing.
//
// The list only names labels seen in production. The structural rule in
// `crawlerKeyFor()` is what covers the next one: `company.sbb.ch` (elvetino),
// `my.jobalino.ch` (a shared board) and `link.ostendis.com` all became crawler
// keys before they were listed here, because the label did not name the
// employer it was serving.
const GENERIC_TENANT_LABELS = new Set([
  'app', 'apps', 'apply', 'career', 'careers', 'community', 'company', 'job',
  'jobboard', 'job-boards', 'jobs', 'karriere', 'link', 'my', 'portal',
  'recruiting', 'recruitingapp', 'stellen', 'www',
]);

/**
 * Lowercase alphanumerics only, so `CH Media`, `chmedia` and `ch-media`
 * compare equal.
 *
 * @param {unknown} value
 * @returns {string}
 */
function compactIdentity(value) {
  return crawlerKeyToken(value).replace(/-/g, '');
}

/** @param {string} a @param {string} b */
function identitiesOverlap(a, b) {
  return a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a));
}

/**
 * The employer's own domain label, or `''` when the candidate only knows the
 * vendor's host: `bluedotbpo.careers-page.com` is Manatal's domain, and the
 * page title there names Manatal too, so neither can contradict the tenant.
 *
 * @param {{ domain?: string, tenantHost?: string }} candidate
 * @returns {string}
 */
function employerOwnDomainLabel(candidate) {
  const vendorDomain = registrableDomain(normalizeHost(String(candidate.tenantHost ?? '')));
  const employerDomain = registrableDomain(normalizeHost(String(candidate.domain ?? '')));
  if (!employerDomain || employerDomain === vendorDomain) return '';
  return compactIdentity(employerDomain.split('.')[0]);
}

/**
 * True when the employer's own domain is known and the tenant label names
 * neither it nor the employer: the label is then the vendor's plumbing
 * (`company.sbb.ch` serving elvetino.ch, `link.ostendis.com` serving
 * wassermann-company.ch), and the next employer on that host would get the
 * same key.
 *
 * @param {string} label
 * @param {{ name?: string, domain?: string, tenantHost?: string }} candidate
 * @returns {boolean}
 */
function tenantLabelContradictsEmployer(label, candidate) {
  const ownDomain = employerOwnDomainLabel(candidate);
  if (!ownDomain) return false;
  const compactLabel = compactIdentity(label);
  return !identitiesOverlap(compactLabel, ownDomain)
    && !identitiesOverlap(compactLabel, compactIdentity(candidate.name));
}

/**
 * Turn a candidate-provided identity into the key form used by crawler files.
 * Keeping the normalization in one place matters here: whitespace and names
 * made only of punctuation must be rejected before the generic ATS fallback is
 * selected, rather than becoming an empty key after the choice was made.
 *
 * @param {unknown} value
 * @returns {string}
 */
function crawlerKeyToken(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

/**
 * The employer-owned domain is the safe identity fallback when an ATS tenant
 * has no usable employer name. `registrableDomain` strips a vendor subdomain;
 * preserve the complete normalized registrable domain so equal brand labels on
 * different suffixes remain distinct crawler keys.
 *
 * @param {unknown} domain
 * @returns {string}
 */
function employerDomainToken(domain) {
  const normalized = registrableDomain(normalizeHost(String(domain ?? '')));
  const labels = normalized.split('.');
  if (!normalized || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) return '';
  return crawlerKeyToken(normalized);
}

/**
 * A crawler key that is stable, filesystem-safe and unique enough to sit
 * alongside the 580-odd existing crawler keys.
 *
 * @param {{ name?: string, tenantHost?: string, domain?: string }} candidate
 * @returns {string}
 */
export function crawlerKeyFor(candidate) {
  const fromHost = candidate.tenantHost ? tenantLabel(candidate.tenantHost) : '';
  // Un tenant id opaco (`recruitingapp-2862`) e' una chiave pessima: non dice
  // di chi e' il crawler, e finisce nel nome dei file, nel manifest e nei
  // gruppi di workflow. Quando il vendor usa id anonimi, il nome dell'azienda
  // — che la pagina del tenant ci ha gia' dato — e' l'unica cosa leggibile.
  const opaqueLabel = OPAQUE_TENANT_LABEL_RX.test(fromHost) || /^\d/.test(fromHost);
  // Two letters are a country or language prefix (`ch.talent.com`), never an
  // employer.
  const genericLabel = GENERIC_TENANT_LABELS.has(fromHost.toLowerCase())
    || (Boolean(fromHost) && compactIdentity(fromHost).length < 3);
  const nameKey = crawlerKeyToken(candidate.name);
  const domainKey = employerDomainToken(candidate.domain);
  const hasEmployerName = Boolean(nameKey
    && nameKey !== fromHost.toLowerCase()
    && !GENERIC_TENANT_LABELS.has(nameKey));
  // A readable label that the employer's own domain contradicts is as wrong as
  // a generic one. The name replaces it only when that domain corroborates the
  // name; otherwise the domain is the identity we can actually prove.
  const contradictedLabel = Boolean(fromHost) && !opaqueLabel && !genericLabel
    && tenantLabelContradictsEmployer(fromHost, candidate);
  const corroboratedName = hasEmployerName
    && identitiesOverlap(compactIdentity(nameKey), employerOwnDomainLabel(candidate));
  const preferred = contradictedLabel
    ? (corroboratedName ? nameKey : domainKey)
    : opaqueLabel || genericLabel
      ? (hasEmployerName ? nameKey : domainKey)
      : crawlerKeyToken(fromHost);
  const base = preferred || (!opaqueLabel && !genericLabel ? domainKey || nameKey : '') || 'unknown';
  return crawlerKeyToken(base);
}

/**
 * A crawler key that nobody else owns.
 *
 * The key names the spec file, and a production parser reads its spec from
 * that file at every run: writing a second employer's spec under a taken key
 * silently re-points a live crawler. Measured on 2026-10-24: `my` belonged to
 * the Teo Jakob AG parser, and the synthesis of Stiftung Helsenberg under the
 * same host label overwrote `my.json`, so production published Helsenberg's
 * posting as a Teo Jakob vacancy.
 *
 * @param {string} key
 * @param {{ domain?: string }} candidate
 * @param {(key: string) => boolean} isTaken
 * @returns {string}
 */
export function disambiguateCrawlerKey(key, candidate, isTaken) {
  if (!isTaken(key)) return key;
  const domainKey = employerDomainToken(candidate.domain);
  for (const option of [domainKey, crawlerKeyToken(`${key.slice(0, 24)}-${domainKey}`)]) {
    if (option && option !== key && !isTaken(option)) return option;
  }
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const option = `${key.slice(0, 44)}-${suffix}`;
    if (!isTaken(option)) return option;
  }
  throw new Error(`nessuna chiave crawler libera per ${key}`);
}

/** `recruitingapp-2862`: a vendor's numeric tenant id, not a name. */
const OPAQUE_TENANT_LABEL_RX = /^[a-z]*[-_]?\d{2,}$/i;

/** Statuses whose spec has been written but has not reached production. */
const REKEYABLE_STATUSES = new Set(['synthesized', 'validated', 'promoted']);

/**
 * Candidates whose crawler key is a tenant host label that `crawlerKeyFor()`
 * no longer accepts. Several of them share one spec file (`jobportal.json`
 * was written by seven abaservices tenants in turn), so their validation
 * history may describe another employer's spec: they go back to SYNTHESIZE
 * under their own key rather than keep a key they cannot own.
 *
 * A candidate that already owns a production crawler under the old key is
 * left alone: re-synthesizing it would put the same employer in production
 * twice.
 *
 * @param {Record<string, any>[]} candidates
 * @param {{ productionKeys?: Set<string>, specFor?: (key: string) => any }} [ctx]
 * @returns {{ candidate: Record<string, any>, from: string, to: string }[]}
 */
export function findMiskeyedCandidates(candidates, { productionKeys = new Set(), specFor = () => null } = {}) {
  const out = [];
  for (const candidate of candidates) {
    if (!REKEYABLE_STATUSES.has(candidate?.status) || !candidate.crawlerKey || !candidate.tenantHost) continue;
    const from = String(candidate.crawlerKey);
    if (tenantLabel(candidate.tenantHost) !== from) continue;
    // An opaque tenant id (`recruitingapp-2896`) is an unreadable key but a
    // unique one: no other employer writes that spec, so its history is its
    // own and is not worth resetting.
    if (OPAQUE_TENANT_LABEL_RX.test(from) || /^\d/.test(from)) continue;
    const to = crawlerKeyFor(candidate);
    if (to === from) continue;
    if (productionKeys.has(from)) {
      let spec;
      try {
        spec = specFor(from);
      } catch {
        // A production spec that cannot be read is not evidence that the key
        // is free. Fail closed and leave the candidate attached to its key.
        continue;
      }
      if (spec && compactIdentity(spec.companyName) === compactIdentity(candidate.name)) continue;
    }
    out.push({ candidate, from, to });
  }
  return out;
}

/**
 * True when `err` is the kind of malformed-input failure SYNTHESIZE is meant
 * to isolate per-candidate (a `%E9` Latin-1 escape, an unparseable URL) rather
 * than a genuine programming bug. The caller uses this to decide whether a
 * rejected candidate is expected noise or a regression that deserves to stay
 * visible instead of vanishing into "candidato rifiutato".
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isExpectedSynthesisError(err) {
  // `instanceof` da solo non basta: un URIError attraversato da un realm o
  // ri-lanciato da una lib puo' perderlo. Ma il solo `.name` e' troppo largo —
  // una libreria che sovrascrive `.name` su un errore qualsiasi verrebbe
  // riassorbita come rumore atteso, cioe' proprio il bug che questa distinzione
  // vuole rendere visibile. Quindi: instanceof, oppure un vero Error il cui
  // nome E' URIError.
  if (err instanceof URIError) return true;
  return err instanceof Error && err.name === 'URIError';
}

/**
 * Learn a spec by crawling the candidate's careers page for real.
 *
 * @param {Record<string, any>} candidate
 * @returns {Promise<{ spec: CrawlerSpec|null, reason?: string, reasonCode?: string, vacancies: any[], retryable?: boolean, diagnostics?: Record<string, any> }>}
 */
export async function synthesizeSpec(candidate, runtime = {}) {
  const { priority, alternates } = synthesisSeeds(candidate);
  if (!priority.length && !alternates.length) return { spec: null, reason: 'nessun URL di partenza', vacancies: [] };

  const pendingPriority = [...priority];
  const pendingInitial = [...alternates];
  const pendingDiscovered = [];
  const queued = new Set([...pendingPriority, ...pendingInitial]);
  const attempted = new Set();
  const failures = [];
  let reachablePages = 0;
  let malformedResponses = 0;
  let extracted = null;
  let suppliedSeedsAttempted = 0;
  while ((pendingPriority.length || pendingInitial.length || pendingDiscovered.length)
    && attempted.size < MAX_SYNTHESIS_FETCHES) {
    let seed;
    if (pendingPriority.length) {
      seed = pendingPriority.shift();
      suppliedSeedsAttempted++;
    } else if (pendingDiscovered.length) {
      seed = pendingDiscovered.shift();
    } else if (pendingInitial.length && suppliedSeedsAttempted < MAX_SYNTHESIS_FETCHES - 1) {
      seed = pendingInitial.shift();
      suppliedSeedsAttempted++;
    } else if (pendingInitial.length) {
      // Use the fifth slot for another supplied seed only when no discovered
      // careers link is waiting to be followed.
      seed = pendingInitial.shift();
      suppliedSeedsAttempted++;
    } else {
      break;
    }
    if (attempted.has(seed)) continue;
    attempted.add(seed);
    let response;
    try {
      response = await politeFetch(seed, {
        fetchImpl: runtime.fetchImpl,
        lookupImpl: runtime.lookupImpl,
        sleepImpl: runtime.sleepImpl,
      });
    } catch (error) {
      failures.push({
        ok: false,
        status: 0,
        url: seed,
        transportError: error instanceof Error ? error.message : 'fetch_failed',
      });
      continue;
    }
    if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean') {
      malformedResponses++;
      failures.push({
        ok: false,
        status: Number(response?.status) || 0,
        url: typeof response?.url === 'string' ? response.url : seed,
        transportError: response?.transportError || 'missing_or_invalid_fetch_response',
        malformedResponse: true,
      });
      continue;
    }
    if (response.ok && typeof response.body !== 'string') {
      malformedResponses++;
      failures.push({
        ok: false,
        status: Number(response.status) || 0,
        url: typeof response.url === 'string' && response.url ? response.url : seed,
        transportError: 'missing_response_body',
        malformedResponse: true,
      });
      continue;
    }
    const res = {
      ...response,
      url: typeof response.url === 'string' && response.url ? response.url : seed,
      body: response.body,
    };
    if (!res.ok) {
      failures.push(res);
      continue;
    }
    reachablePages++;
    const links = extractLinks(res.body, res.url);
    const result = extractVacancies(res.body, res.url, links);
    if (result.vacancies.length) {
      extracted = { res, vacancies: result.vacancies, via: result.via };
      break;
    }
    // A homepage often points to the real career listing. Follow only links
    // whose path or authored label signals recruitment, and extractLinks
    // already limits these links to the page's own origin.
    for (const link of careerLinksFromPage(res.body, res.url)) {
      const normalizedLink = normalizedHttpUrl(link);
      if (!normalizedLink || queued.has(normalizedLink) || attempted.has(normalizedLink)) continue;
      queued.add(normalizedLink);
      pendingDiscovered.push(normalizedLink);
    }
  }
  if (!extracted) {
    if (reachablePages > 0 && malformedResponses === 0) {
      return {
        spec: null,
        reason: 'nessun annuncio estratto dal seed',
        reasonCode: 'no_verified_vacancies',
        retryable: true,
        vacancies: [],
        diagnostics: { attemptedUrls: attempted.size, reachablePages, malformedResponses },
      };
    }
    const isRetryableFetchFailure = (attempt) => {
      if (attempt.blockedByRobots || attempt.policyBlocked) return false;
      if (attempt.malformedResponse) return true;
      const status = Number(attempt.status) || 0;
      return status > 0 ? isRetryableTraceStatus(status) : Boolean(attempt.transportError);
    };
    const retryableFailures = failures.filter(isRetryableFetchFailure);
    const failure = retryableFailures.at(-1) || failures.at(-1) || {};
    const blocked = failure.blockedByRobots || failure.policyBlocked;
    return {
      spec: null,
      reason: `seed irraggiungibile (${failure.status || 0})`,
      reasonCode: retryableFailures.length ? 'transient_seed_failure' : (blocked ? 'policy_blocked' : 'seed_unreachable'),
      vacancies: [],
      retryable: retryableFailures.length > 0,
      diagnostics: { attemptedUrls: attempted.size, reachablePages, malformedResponses },
    };
  }

  const { res, vacancies, via } = extracted;

  // A synthesised spec must not silently learn an unreviewed ATS/CDN origin.
  // Existing promoted specs may name `allowedDetailOrigins` explicitly, but
  // autonomous discovery has no evidence that employer.example is entitled to
  // make us fetch ats.example. Reject the candidate instead of passing a gate
  // that production later (correctly) reduces to zero rows.
  const seedOrigin = new URL(res.url).origin;
  const crossOriginVacancy = vacancies.find((vacancy) => {
    try { return new URL(vacancy.url).origin !== seedOrigin; } catch { return true; }
  });
  if (crossOriginVacancy) {
    return {
      spec: null,
      reason: `origine dettaglio non autorizzata: ${String(crossOriginVacancy.url || '').slice(0, 160)}`,
      vacancies: [],
    };
  }

  const host = normalizeHost(new URL(res.url).hostname);
  const hostDomain = registrableDomain(host);
  // The structural aggregator test in TRACE reads a listing; a single posting
  // page on a job search engine names one employer and passes it. Global Sana
  // reached the promotion gate from `ch.talent.com/view?id=…` that way.
  if (KNOWN_AGGREGATOR_DOMAINS.has(hostDomain)) {
    return {
      spec: null,
      reason: `seed su un aggregatore (${hostDomain}): non e' la pagina del datore`,
      reasonCode: 'aggregator_seed',
      vacancies: [],
    };
  }
  const employerDomain = registrableDomain(candidate.domain || '');
  const inferredPlatform = candidate.selfHosted === undefined
    ? (hostDomain === employerDomain ? '' : hostDomain)
    : (candidate.selfHosted === false && hostDomain !== employerDomain ? hostDomain : '');
  const companyKey = crawlerKeyFor(candidate);
  const candidateName = String(candidate.name || '').toLowerCase();
  const isBrefispersonal = companyKey === 'brefispersonal'
    || (hostDomain === 'brefis.ch' && /\bbrefis\s+personal\b/.test(candidateName));
  const pagination = isBrefispersonal && hostDomain === 'brefis.ch'
    ? { ...BREFISPERSONAL_PAGINATION }
    : undefined;
  const listingNeedsDetail = vacancies.some(
    (vacancy) => !resolveDetailOrListingSwissGeography({}, vacancy).geography
      || !isSufficientVacancyDescription(vacancy.description),
  );
  /** @type {CrawlerSpec} */
  const spec = {
    companyKey,
    companyName: candidate.name || tenantLabel(host) || host,
    companyHost: host,
    platform: candidate.platform || inferredPlatform,
    mode: /** @type {'jsonld'|'microdata'|'template'} */ (via),
    seedUrls: [res.url],
    detailTemplate: commonUrlTemplate(vacancies.map((v) => v.url)) || undefined,
    detailEnrichment: via === 'template' || listingNeedsDetail,
    detailFetchWorkers: 4,
    pagination,
    sampleVacancyCount: vacancies.length,
    sampleTitles: vacancies.slice(0, 5).map((v) => v.title),
    canton: candidate.canton || undefined,
    sourceLang: detectPageLang(res.body),
    learnedAt: new Date().toISOString(),
  };
  return { spec, vacancies };
}

/**
 * Run a spec: fetch its seeds and return the vacancies it yields today.
 * This is both the crawler itself and the thing the validator re-runs.
 *
 * @param {CrawlerSpec} spec
 * @returns {Promise<{ vacancies: any[], errors: string[] }>}
 */
export async function runSpec(spec, runtime = {}) {
  /** @type {any[]} */
  const all = [];
  const errors = [];
  const urlPolicy = createSpecUrlPolicy(spec, { lookupImpl: runtime.lookupImpl });
  try {
    const fallbackSeeds = [...new Set(
      (Array.isArray(spec.transportFallbackSeedUrls) ? spec.transportFallbackSeedUrls : [])
        .map((url) => String(url || '').trim())
        .filter(Boolean),
    )];
    for (const seed of spec.seedUrls) {
      const seedCandidates = [seed, ...fallbackSeeds]
        .filter((candidate, index, all) => all.indexOf(candidate) === index);
      let effectiveSeed = seed;
      let res;
      for (let candidateIndex = 0; candidateIndex < seedCandidates.length; candidateIndex += 1) {
        const candidate = seedCandidates[candidateIndex];
        res = await politeFetch(candidate, {
          urlPolicy,
          dispatcher: urlPolicy.dispatcher,
          fetchImpl: runtime.fetchImpl,
          sleepImpl: runtime.sleepImpl,
        });
        effectiveSeed = candidate;
        const hasNextCandidate = candidateIndex < seedCandidates.length - 1;
        if (res.ok || !hasNextCandidate || !isConnectionLevelFetchResult(res)) break;
      }
      if (!res?.ok) {
        errors.push(`${effectiveSeed}: ${res?.status ? `HTTP ${res.status}` : `transport ${res?.transportError || 'other'}`}`);
        continue;
      }
      // Stessa evidenza di listing che allega `runSpecInProduction()`: su
      // Umantis la localita' dell'annuncio sta nella riga del listing, non
      // nella pagina di dettaglio. Senza, il validatore grada righe piu'
      // povere di quelle che il runtime pubblichera' e boccia il candidato per
      // «nessuna localita' source-backed» — misurato il 2026-09-05 su
      // recruitingapp-2924, che pubblica 6 annunci con geografia Rheinfelden AG
      // mentre la validazione ne misurava 0%.
      const listingEvidence = spec.platform === 'umantis.com'
        ? extractUmantisListingEvidence(res.body, res.url, {
          cantonOverrides: spec.umantisListingCantonOverrides,
        })
        : new Map();
      const links = extractLinks(res.body, res.url);
      const { vacancies } = extractVacancies(res.body, res.url, links);
      for (const v of vacancies) {
        try { await urlPolicy(v.url); } catch {
          errors.push(`${v.url}: origine dettaglio non autorizzata`);
          continue;
        }
        const evidence = listingEvidence.get(umantisVacancyIdentity(v.url));
        all.push({
          ...v,
          ...listingEvidenceFields(v, evidence),
          company: v.company || spec.companyName,
          companyKey: spec.companyKey,
          companyDomain: spec.companyHost,
          sourceLang: spec.sourceLang,
          canton: spec.canton,
        });
      }
    }
  } finally {
    await urlPolicy.dispatcher.close();
  }
  // Same vacancy can surface from two seeds; key on URL.
  const seen = new Set();
  const unique = all.filter((v) => (seen.has(v.url) ? false : (seen.add(v.url), true)));
  return { vacancies: unique, errors };
}
