/**
 * Follow an employer's careers trail: site -> careers page -> where the
 * vacancies actually live.
 *
 * This is discovery detector D1, and the whole platform registry is fed by it.
 *
 * The trail has to be followed for TWO hops, not one. A first pass that only
 * read homepages was measured at 2 platform sightings across 44 resolved Swiss
 * SME sites, because the homepage link is almost always INTERNAL
 * (`/it/azienda/lavora-con-noi/`) and the hop to the hosted ATS happens on that
 * page. Following the internal link is the difference between seeing the vendor
 * and not seeing it at all.
 *
 * Three ways in, tried cheapest-first and stopping as soon as one yields:
 *   1. careers links on the homepage (anchor text or href token)
 *   2. sitemap.xml URLs whose path looks like a careers page
 *   3. the common career paths, probed directly
 */
import { politeFetch } from './polite-fetch.mjs';
import { CAREER_TOKEN_RX, CAREER_PATH_HINTS } from './config.mjs';
import { normalizeHost, registrableDomain, sameOrg, safeDecodePath } from './registrable.mjs';
import { isPlatformEligible } from './platform-registry.mjs';
import { decodeEntities } from './entities.mjs';
import { scoreVacancyPage, textOf } from './extract.mjs';
import { looksLikeAggregator } from './tenant-enum.mjs';
import { readAttr } from '../html-attr.mjs';

/**
 * HTTP outcomes that do not prove an employer site is permanently absent.
 * 401/403 are included because WAFs and geo/IP fences commonly use them for a
 * browser-visible site; the next run may reach the same public page.
 *
 * @param {number} status
 * @returns {boolean}
 */
export function isRetryableTraceStatus(status) {
  const code = Number(status) || 0;
  return code === 0 || code === 401 || code === 403 || code === 408
    || code === 425 || code === 429 || code >= 500;
}

function isRetryableTraceResponse(response) {
  return !response?.policyBlocked
    && !response?.blockedByRobots
    && isRetryableTraceStatus(response?.status);
}

function recordTraceResponse(result, response) {
  result.failureStatuses.push(Number(response?.status) || 0);
  if (isRetryableTraceResponse(response)) result.retryable = true;
}

/**
 * Detect a JavaScript-only career surface before the vacancy extractor gives
 * it a zero score. These pages intentionally contain no server-rendered job
 * rows, but their custom-element/ATS fingerprints are still strong evidence
 * that the employer publishes vacancies there.
 *
 * @param {string} html
 * @returns {boolean}
 */
export function isJavascriptCareerSurface(html = '') {
  const source = String(html || '');
  const customElement = /<mmsg-(?:page|search-results|job-item)\b/i.test(source);
  const atsShell = /(?:csb\.esm\.js|searchui\.search\.windows\.net|successfactors|data-careersite-propertyid)/i.test(source);
  return (customElement && atsShell)
    || (atsShell && /(?:career|careers|job|jobs|search)/i.test(source));
}

/**
 * Tidy anchor text: decode entities, collapse whitespace, and drop the
 * immediate self-repetition that markup like
 * `<a title="X"><span>X</span></a>` produces once tags are stripped. Left
 * uncollapsed it doubles every synthesised job title.
 *
 * @param {string} raw
 * @returns {string}
 */
export function cleanAnchorText(raw = '') {
  const t = decodeEntities(String(raw)).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const half = Math.floor(t.length / 2);
  // Exact doubling, with or without a separating space.
  for (const cut of [half, half + 1]) {
    const a = t.slice(0, cut).trim();
    const b = t.slice(cut).trim();
    if (a && a.length > 4 && a === b) return a;
  }
  return t.slice(0, 160);
}

/**
 * Join anchor inner text with its `aria-label`/`title`, dropping the attribute
 * when it carries no information the inner text does not already have.
 *
 * Second line of defence for issue #6480. The first line is `readAttr()`, which
 * stops the attribute from being truncated at an apostrophe; this stops the
 * concatenation itself whenever the two parts say the same thing — the common
 * `<a title="X"><span>X</span></a>` shape, and every partial variant of it that
 * `cleanAnchorText()` cannot catch because its collapse needs the two halves to
 * be EXACTLY equal.
 *
 * Deliberately narrow: it only drops a part wholly contained in the other. It
 * does NOT collapse a repeated prefix in general — that heuristic is what made
 * the measurement in #6480 unusable, because German double-gender titles
 * (`Ernährungsberaterin / Ernährungsberater`) are legitimate strings whose tail
 * IS a prefix of their head.
 *
 * @param {string} text  Anchor inner text, tags already stripped.
 * @param {string} attr  aria-label / title value.
 * @returns {string}
 */
export function joinAnchorParts(text = '', attr = '') {
  const a = String(text || '').replace(/\s+/g, ' ').trim();
  const b = String(attr || '').replace(/\s+/g, ' ').trim();
  if (!a) return b;
  if (!b) return a;
  const na = a.toLowerCase();
  const nb = b.toLowerCase();
  // Same string modulo case: keep the one that is NOT shouted. A job card
  // often renders its title in an all-caps `<span>` while the `title=`
  // attribute carries the authored casing, and `INFERMIERE SSS` is a worse
  // stored title than `Infermiere SSS`. Only all-caps loses — a genuine
  // acronym like `SSS` inside otherwise mixed-case text is untouched, because
  // such a string is not all-caps as a whole.
  if (na === nb) {
    const shouted = (s) => s === s.toUpperCase() && /[A-ZÀ-Þ]/.test(s);
    if (shouted(a) && !shouted(b)) return b;
    return a;
  }
  if (na.includes(nb)) return a;
  if (nb.includes(na)) return b;
  return `${a} ${b}`;
}

/**
 * Return balanced list-item scopes so overlay headings cannot leak across
 * cards when the source contains an empty, aria-hidden anchor.
 * @param {string} html
 * @returns {{ start: number, end: number }[]}
 */
function balancedListItemScopes(html = '') {
  const scopes = [];
  const stack = [];
  const rx = /<\/?li\b[^>]*>/gi;
  let match;
  while ((match = rx.exec(String(html || '')))) {
    if (match[0].startsWith('</')) {
      const start = stack.pop();
      if (start !== undefined) scopes.push({ start, end: match.index + match[0].length });
    } else {
      stack.push(match.index);
    }
  }
  return scopes;
}

function containingListItem(scopes, anchorStart, anchorEnd) {
  let closest = null;
  for (const scope of scopes) {
    if (scope.start < anchorStart && scope.end >= anchorEnd
      && (!closest || scope.start > closest.start)) {
      closest = scope;
    }
  }
  return closest;
}

/**
 * Absolute same-host links in an HTML document, with their anchor text.
 * Cross-origin links are available only when a caller explicitly opts in;
 * careers-trail discovery does that for the separate ATS hop, while the
 * default keeps a document's own link evidence from leaking into another
 * host. HTTP/HTTPS links on the same host remain usable when a page mixes
 * transport schemes; a different host or port is still excluded.
 *
 * Written as a scan for `href=` rather than a full anchor match on purpose:
 * SME sites nest `<span>`/`<img>` inside `<a>` freely, and a
 * `<a ...>(.*?)</a>` regex silently drops those. Here the anchor text is a
 * best-effort slice AFTER the tag, and a missing one is fine because the href
 * itself usually carries the token.
 *
 * @param {string} html
 * @param {string} baseUrl
 * @param {{ sameOriginOnly?: boolean }} [options]
 * @returns {{ url: string, text: string, host: string }[]}
 */
export function extractLinks(html = '', baseUrl = '', options = {}) {
  const out = [];
  const seen = new Set();
  let baseHost = '';
  try { baseHost = new URL(baseUrl).host; } catch { /* absolute hrefs may still be usable */ }
  const sameOriginOnly = options.sameOriginOnly ?? true;
  const anchors = [...String(html || '').matchAll(/<a\b([^>]*)>/gi)];
  const listItemScopes = balancedListItemScopes(html);
  for (let anchorIndex = 0; anchorIndex < anchors.length; anchorIndex += 1) {
    const m = anchors[anchorIndex];
    const attrs = m[1];
    const anchorContentStart = m.index + m[0].length;
    const nextAnchorStart = anchors[anchorIndex + 1]?.index ?? html.length;
    const textWindowEnd = Math.min(html.length, nextAnchorStart, anchorContentStart + 4000);
    const closeOffset = html.slice(anchorContentStart, textWindowEnd).search(/<\/a>/i);
    const anchorClose = closeOffset >= 0 ? anchorContentStart + closeOffset : -1;
    const href = readAttr(attrs, 'href');
    if (!href) continue;
    if (/^(#|mailto:|tel:|javascript:|data:)/i.test(href.trim())) continue;
    // Anchor text = the markup up to the next </a>, tags stripped.
    const rest = html.slice(
      anchorContentStart,
      anchorClose >= 0 ? anchorClose : Math.min(html.length, anchorContentStart + 400),
    );
    const text = rest.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const aria = readAttr(attrs, ['aria-label', 'title']);
    // Some card templates use an empty, aria-hidden overlay anchor as the
    // click target and render the authored title in a sibling heading. Keep
    // that heading as link evidence when the source explicitly marks the
    // anchor as hidden; this avoids guessing from arbitrary nearby prose.
    let overlayHeading = '';
    if (!text && /^true$/i.test(String(readAttr(attrs, 'aria-hidden') || '').trim())) {
      const anchorEnd = anchorClose >= 0 ? anchorClose + 4 : anchorContentStart;
      const item = containingListItem(listItemScopes, m.index, anchorEnd);
      if (item && item.end > anchorEnd) {
        const scope = html.slice(anchorEnd, item.end);
        overlayHeading = scope.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1]
          ?.replace(/<[^>]*>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim() || '';
      }
    }
    let parsed;
    try { parsed = new URL(href, baseUrl); } catch { continue; }
    if (!/^https?:$/i.test(parsed.protocol)) continue;
    if (sameOriginOnly && baseHost && parsed.host !== baseHost) continue;
    const abs = parsed.toString();
    const key = abs.split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      url: abs,
      text: cleanAnchorText(joinAnchorParts(text || overlayHeading, aria)),
      host: normalizeHost(parsed.hostname),
    });
  }
  return out;
}

/**
 * Does this link look like a careers link?
 * @param {{ url: string, text: string }} link
 */
export function isCareerLink(link) {
  let pathPart = '';
  pathPart = safeDecodePath(link.url) || link.url;
  return hasCareerToken(link.text) || hasCareerToken(pathPart);
}

/**
 * Match a career token only as a standalone word/phrase. The shared token
 * list is intentionally broad, but an unbounded `stellen` match turns a
 * normal product URL such as `/elektrokamin-aufstellen` into a fake careers
 * page. Keep the broad vocabulary while rejecting matches embedded in a
 * larger word; real slugs such as `/offene-stellen` still pass.
 *
 * @param {string} value
 * @returns {boolean}
 */
function hasCareerToken(value = '') {
  const text = String(value || '');
  const scanner = new RegExp(CAREER_TOKEN_RX.source, 'gi');
  for (const match of text.matchAll(scanner)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const before = text[start - 1] || '';
    const after = text[end] || '';
    if (!/[a-z0-9à-öø-ÿ]/i.test(before) && !/[a-z0-9à-öø-ÿ]/i.test(after)) return true;
  }
  return false;
}

/**
 * Careers-looking URLs listed in a site's sitemap. Reads the sitemap index one
 * level deep, which is where most WordPress/Wix sites keep the page sitemap.
 *
 * @param {string} origin
 * @param {{ onFailure?: (outcome: { status: number, retryable: boolean, blockedByRobots: boolean, policyBlocked: boolean }) => void }} [opts]
 * @returns {Promise<string[]>}
 */
export async function careersFromSitemap(origin, { onFailure } = {}) {
  const found = [];
  const seen = new Set();
  /** @param {string} url @param {number} depth */
  const read = async (url, depth) => {
    if (depth > 1 || seen.has(url) || found.length >= 8) return;
    seen.add(url);
    let res;
    try {
      res = await politeFetch(url, { accept: 'application/xml,text/xml,*/*' });
    } catch {
      onFailure?.({ status: 0, retryable: true, blockedByRobots: false, policyBlocked: false });
      return;
    }
    if (!res?.ok) {
      const status = Number(res?.status) || 0;
      const blockedByRobots = Boolean(res?.blockedByRobots);
      const policyBlocked = Boolean(res?.policyBlocked);
      onFailure?.({
        status,
        blockedByRobots,
        policyBlocked,
        retryable: !blockedByRobots && !policyBlocked && isRetryableTraceStatus(status),
      });
      return;
    }
    if (typeof res.body !== 'string' || !/<(?:urlset|sitemapindex)\b/i.test(res.body)) {
      onFailure?.({
        status: Number(res.status) || 0,
        retryable: true,
        blockedByRobots: false,
        policyBlocked: false,
      });
      return;
    }
    const locs = [...res.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
    const isIndex = /<sitemapindex/i.test(res.body);
    for (const loc of locs) {
      if (found.length >= 8) break;
      if (isIndex) {
        // Only descend into sub-sitemaps that could hold pages.
        if (/(page|post|main|sitemap)/i.test(loc)) await read(loc, depth + 1);
        continue;
      }
      let p = '';
      p = safeDecodePath(loc);
      if (!p) continue;
      if (hasCareerToken(p)) found.push(loc);
    }
  };
  await read(`${origin}/sitemap.xml`, 0);
  if (!found.length) await read(`${origin}/sitemap_index.xml`, 0);
  return found.slice(0, 8);
}

/**
 * Third-party hosts on a page that plausibly host its vacancies.
 *
 * Two strictnesses, because context changes what a bare link means:
 *   - default: the link must READ as a careers link (anchor text or href
 *     token) or sit on a job-ish host. Right for a homepage, where most
 *     outbound links are social and partner noise.
 *   - relaxed: any eligible third-party host counts. Right ON a careers page,
 *     where the outbound link is very often an unlabelled logo or button into
 *     the ATS — exactly the shape that made a text-only pass miss the vendor.
 *
 * Relaxed mode is safe only because it is not the last word: every candidate is
 * then fetched and scored as a vacancy page, and the registry additionally
 * waits for a second unrelated employer before acting. A web agency in the
 * footer clears neither gate.
 *
 * @param {{ url: string, text: string, host: string }[]} links
 * @param {string} employerDomain
 * @param {{ relaxed?: boolean, globalLinks?: { url: string, text: string, host: string }[] }} [opts]
 * @returns {{ host: string, url: string, text: string }[]}
 */
export function externalAtsLinks(links, employerDomain, opts = {}) {
  const out = new Map();
  const globalLinks = Array.isArray(opts.globalLinks) ? opts.globalLinks : [];
  for (const l of links) {
    const reg = registrableDomain(l.host);
    if (!reg || sameOrg(reg, employerDomain)) continue;
    if (!isPlatformEligible(l.host)) continue;
    const hostLooksJobish = /(job|karriere|career|stellen|recruit|lavoro|emploi|hr|talent|apply|bewerb|candidat|vacan)/i.test(l.host);
    if (!opts.relaxed && !isCareerLink(l) && !hostLooksJobish) continue;
    if (opts.relaxed && !isCareerLink(l) && !hostLooksJobish) {
      // An unlabelled external logo is useful evidence only when it is
      // specific to the career surface. If the exact same link is already in
      // the homepage chrome it proves partnership, not vacancy ownership.
      const repeatedGlobalLink = globalLinks.some((globalLink) => {
        if (globalLink.host !== l.host) return false;
        try {
          const globalUrl = new URL(globalLink.url);
          const localUrl = new URL(l.url);
          globalUrl.hash = '';
          localUrl.hash = '';
          return globalUrl.href === localUrl.href;
        } catch {
          return globalLink.url === l.url;
        }
      });
      if (repeatedGlobalLink) continue;
    }
    if (!out.has(l.host)) out.set(l.host, { host: l.host, url: l.url, text: l.text });
  }
  return [...out.values()];
}

function normalizedSemanticText(html = '') {
  return textOf(html).replace(/\s+/g, ' ').trim().toLowerCase();
}

function careerSurfaceEvidence(html = '', pageUrl = '') {
  const evidence = new Set();
  if (/"@type"\s*:\s*"JobPosting"/i.test(html)) evidence.add('structured:jobposting');

  const headingRx = /<(?:title|h[1-3])\b[^>]*>([\s\S]*?)<\/(?:title|h[1-3])>/gi;
  for (const match of String(html).matchAll(headingRx)) {
    const value = textOf(match[1]).replace(/\s+/g, ' ').trim().toLowerCase();
    if (value && CAREER_TOKEN_RX.test(value)) evidence.add(`heading:${value}`);
  }
  for (const link of extractLinks(html, pageUrl)) {
    if (!isCareerLink(link)) continue;
    try {
      const url = new URL(link.url);
      url.hash = '';
      evidence.add(`link:${url.href}:${link.text.toLowerCase()}`);
    } catch {
      // extractLinks has already validated URLs. This branch is defensive.
    }
  }
  if (/\b(?:no|nessun[ao]?|keine|aucun(?:e)?|pas de)\s+(?:open\s+)?(?:positions?|posizioni|stellen|emplois?|vacanc)/i.test(textOf(html))) {
    evidence.add('state:explicit-empty');
  }
  return evidence;
}

/**
 * A direct path probe is a career surface only when it differs semantically
 * from the homepage and carries page-specific vacancy/career evidence. This
 * rejects legacy servers that return their homepage with HTTP 200 for every
 * unknown path, as well as pages whose only job-ish link lives in global
 * navigation/footer chrome.
 */
export function isDistinctCareerSurface(homeHtml = '', pageHtml = '', pageUrl = '', homeUrl = pageUrl) {
  const homeText = normalizedSemanticText(homeHtml);
  const pageText = normalizedSemanticText(pageHtml);
  if (!pageText || pageText === homeText) return false;

  const homeEvidence = careerSurfaceEvidence(homeHtml, homeUrl);
  const pageEvidence = careerSurfaceEvidence(pageHtml, pageUrl);
  return [...pageEvidence].some((signal) => !homeEvidence.has(signal));
}

/**
 * Fetch a candidate third-party host and decide whether it really is where the
 * employer's vacancies live.
 *
 * This is the gate that turns relaxed link collection into a trustworthy
 * signal: a certification body, a web agency and a font CDN all score ~0, an
 * ATS tenant scores well above threshold because it carries either structured
 * job data or a repeated vacancy-URL template plus hiring copy.
 *
 * @param {{ host: string, url: string, text: string }} candidate
 * @param {number} [minScore]
 * @returns {Promise<{ host: string, url: string, text: string, score: number, signals: string[], vacancyCount: number, aggregator?: boolean, distinctCompanies?: number, verified: boolean, retryable?: boolean, failureStatus?: number, blockedByRobots?: boolean, policyBlocked?: boolean }>}
 */
export async function verifyAtsHost(candidate, minScore = 3) {
  const res = await politeFetch(candidate.url);
  // A JS-only ATS shell can be deliberately tiny: the server returns little
  // more than its custom element and runtime bootstrap, while the vacancies
  // arrive after hydration. Recognise that fingerprint before applying the
  // generic short-body guard, otherwise a valid tenant is discarded as an
  // unreachable page.
  const jsSurface = res.ok && isJavascriptCareerSurface(res.body);
  if (!res.ok || (res.body.length < 200 && !jsSurface)) {
    return {
      ...candidate,
      score: 0,
      signals: ['unreachable'],
      vacancyCount: 0,
      verified: false,
      retryable: isRetryableTraceResponse(res),
      failureStatus: Number(res?.status) || 0,
      blockedByRobots: Boolean(res?.blockedByRobots),
      policyBlocked: Boolean(res?.policyBlocked),
    };
  }
  const links = extractLinks(res.body, res.url);
  const scored = scoreVacancyPage(res.body, res.url, links);
  // A client-rendered ATS can have a completely empty server-side vacancy
  // list. Its own custom-element/runtime fingerprint is still enough to
  // retain the career surface; the crawler/synthesizer will use the live page
  // URL rather than pretending that zero SSR rows means "no careers".
  // A careers link that lands on an aggregator tells us where the employer
  // ADVERTISES, not where it publishes. Recording it would seed the registry
  // with job boards — inventory everyone already has — and the loop exists for
  // the opposite: employers who hire directly and are indexed nowhere else.
  const surface = looksLikeAggregator(scored.vacancies, candidate.host);
  return {
    ...candidate,
    url: res.url,
    score: jsSurface ? Math.max(scored.score, minScore) : scored.score,
    signals: jsSurface ? [...scored.signals, 'js-career-surface'] : scored.signals,
    vacancyCount: scored.vacancies.length,
    aggregator: surface.aggregator,
    distinctCompanies: surface.distinctCompanies,
    verified: (scored.score >= minScore || jsSurface) && !surface.aggregator,
  };
}

function recordAtsVerificationFailures(result, checks) {
  for (const check of checks) {
    if (!check.retryable) continue;
    result.retryable = true;
    result.failureStatuses.push(Number(check.failureStatus) || 0);
  }
}

/**
 * Trace starting from a careers page we ALREADY know.
 *
 * The web-index source hands us the careers URL directly, so walking the
 * homepage first would be two wasted requests and a chance to lose the trail —
 * plenty of SME homepages hide the careers link behind a script-built menu that
 * the index saw and a plain fetch does not.
 *
 * @param {string} careersUrl
 * @param {string|null} employerDomain
 * @returns {Promise<Omit<Awaited<ReturnType<typeof traceCareers>>, 'domain'> & { domain: string|null }>}
 */
export async function traceFromCareersUrl(careersUrl, employerDomain) {
  const result = {
    domain: employerDomain,
    reachable: false,
    careersUrls: [],
    externalHosts: [],
    rejectedHosts: [],
    failureStatuses: [],
    retryable: false,
    selfHosted: false,
    via: ['known-careers-url'],
  };
  const page = await politeFetch(careersUrl);
  recordTraceResponse(result, page);
  const jsSurface = page.ok && isJavascriptCareerSurface(page.body);
  if (!page.ok || (page.body.length < 300 && !jsSurface)) {
    // A short body is not itself a transient verdict: a small 404 page is a
    // durable absence, while a small 503 page is a transport failure. An HTTP
    // 200 ATS shell is a third case: it is a valid careers surface even when
    // hydration has left the server response under the byte threshold. Carry
    // the HTTP classification explicitly so TRACE cannot revive the former.
    return result;
  }
  result.reachable = true;
  result.careersUrls.push(page.url);
  // Same reasoning as traceCareers(): a cross-origin redirect on `careersUrl`
  // itself means `page.url`'s host, not the caller-supplied `employerDomain`,
  // is what every link on this page is actually relative to.
  const pageHost = normalizeHost(new URL(page.url).hostname);
  const links = extractLinks(page.body, page.url, { sameOriginOnly: false });
  const checked = [];
  for (const cand of externalAtsLinks(links, pageHost, { relaxed: true }).slice(0, 6)) {
    checked.push(await verifyAtsHost(cand));
  }
  recordAtsVerificationFailures(result, checked);
  result.externalHosts = checked.filter((c) => c.verified);
  result.rejectedHosts = checked.filter((c) => !c.verified).map((c) => ({
    host: c.host,
    score: c.score,
    aggregator: c.aggregator || false,
    retryable: Boolean(c.retryable),
    failureStatus: c.failureStatus,
    blockedByRobots: Boolean(c.blockedByRobots),
    policyBlocked: Boolean(c.policyBlocked),
  }));
  const blockedAts = checked.some((c) => c.blockedByRobots || c.policyBlocked);
  result.selfHosted = result.externalHosts.length === 0
    ? blockedAts ? null : !checked.some((c) => c.retryable)
    : false;
  return result;
}

/**
 * Walk an employer's site and report where its vacancies are published.
 *
 * @param {string} domain employer registrable domain, e.g. `acme-trasporti.ch`
 * @param {{ maxCareerPages?: number }} [opts]
 * @returns {Promise<{
 *   domain: string, reachable: boolean, careersUrls: string[],
 *   externalHosts: { host: string, url: string, text: string, score: number, vacancyCount: number }[],
 *   rejectedHosts?: { host: string, score: number, aggregator?: boolean, retryable?: boolean, failureStatus?: number, blockedByRobots?: boolean, policyBlocked?: boolean }[], failureStatuses: number[],
 *   retryable: boolean, selfHosted: boolean|null, via: string[]
 * }>}
 */
export async function traceCareers(domain, opts = {}) {
  const maxCareerPages = opts.maxCareerPages ?? 3;
  const result = {
    domain,
    reachable: false,
    careersUrls: [],
    externalHosts: [],
    failureStatuses: [],
    retryable: false,
    selfHosted: false,
    via: [],
  };

  let home = await politeFetch(`https://${domain}/`);
  recordTraceResponse(result, home);
  if (!home.ok) {
    home = await politeFetch(`https://www.${domain}/`);
    recordTraceResponse(result, home);
  }
  if (!home.ok || home.body.length < 300) {
    return result;
  }
  result.reachable = true;
  const origin = new URL(home.url).origin;
  // A cross-origin redirect can land the homepage on a different registrable
  // domain (rebrand, ccTLD forward, vendor-hosted homepage) before `home.url`
  // is captured. Every "is this link ours or a third party?" check below has
  // to key off where the homepage actually resolved to, not the domain we
  // asked for — comparing against the pre-redirect `domain` would make every
  // link on the redirected page read as external (its host never matches
  // `domain`'s registrable domain), which both hides real on-site careers
  // links and misreads homepage chrome as ATS candidates.
  const homeHost = normalizeHost(new URL(home.url).hostname);
  const homeLinks = extractLinks(home.body, home.url, { sameOriginOnly: false });

  // Hop 0 — the ATS link is sometimes right on the homepage.
  const fromHome = externalAtsLinks(homeLinks, homeHost);
  if (fromHome.length) { result.externalHosts.push(...fromHome); result.via.push('homepage'); }

  // Some corporate groups publish the careers surface on a related domain
  // (`mediamarkt.ch` → `careers.mediamarktsaturn.com`). `externalAtsLinks()`
  // deliberately excludes same-organisation domains so they cannot become a
  // false platform, but that exclusion must not turn an official careers URL
  // into "no careers". Fetch and retain these explicit cross-origin links as
  // career surfaces; only unrelated hosts continue through ATS verification.
  const relatedCareerUrls = [...new Set(homeLinks
    .filter((link) => isCareerLink(link))
    .filter((link) => registrableDomain(link.host) !== registrableDomain(homeHost))
    .filter((link) => sameOrg(link.host, homeHost))
    .map((link) => link.url))];
  for (const url of relatedCareerUrls.slice(0, maxCareerPages)) {
    const page = await politeFetch(url);
    recordTraceResponse(result, page);
    const jsSurface = page.ok && isJavascriptCareerSurface(page.body);
    if (!page.ok || (page.body.length < 300 && !jsSurface)) {
      continue;
    }
    result.careersUrls.push(page.url);
    if (!result.via.includes('external-homepage-link')) result.via.push('external-homepage-link');
    const links = extractLinks(page.body, page.url, { sameOriginOnly: false });
    for (const ext of externalAtsLinks(links, normalizeHost(new URL(page.url).hostname), { relaxed: true, globalLinks: homeLinks })) {
      if (!result.externalHosts.some((e) => e.host === ext.host)) result.externalHosts.push(ext);
    }
  }

  // Hop 1 — candidate careers pages, cheapest source first.
  const candidates = [];
  for (const l of homeLinks) {
    if (!isCareerLink(l)) continue;
    if (registrableDomain(l.host) !== registrableDomain(homeHost)) continue;
    candidates.push(l.url);
  }
  if (candidates.length) result.via.push('homepage-link');
  if (!candidates.length) {
    const sm = await careersFromSitemap(origin, {
      onFailure: ({ status, retryable }) => {
        result.failureStatuses.push(status);
        if (retryable) result.retryable = true;
      },
    });
    if (sm.length) { candidates.push(...sm); result.via.push('sitemap'); }
  }
  if (!candidates.length) {
    for (const hint of CAREER_PATH_HINTS) {
      const probe = await politeFetch(`${origin}${hint}`);
      if (isRetryableTraceResponse(probe)) recordTraceResponse(result, probe);
      if (
        probe.ok
        && probe.body.length > 500
        && isDistinctCareerSurface(home.body, probe.body, probe.url, home.url)
      ) {
        candidates.push(probe.url);
        result.via.push('path-probe');
        break;
      }
    }
  }

  // `home` is safe to read across every iteration below: it is a single
  // `let` binding captured once above, local to this call of `traceCareers`
  // (never shared across employers/candidates, which each get their own
  // invocation and their own `home`), and nothing in this loop ever
  // reassigns it or mutates `home.body`/`home.url` in place — only `page`
  // changes per iteration. See the regression test in
  // `tests/prospector-careers-trail-ownership.test.ts` ("keeps the homepage
  // document stable across multiple candidate-loop iterations").
  const seen = new Set();
  for (const url of candidates.slice(0, maxCareerPages)) {
    const key = url.split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    const page = await politeFetch(url);
    recordTraceResponse(result, page);
    if (!page.ok) continue;
    const jsSurface = isJavascriptCareerSurface(page.body);
    if (page.body.length < 300 && !jsSurface) {
      continue;
    }
    if (!isDistinctCareerSurface(home.body, page.body, page.url, home.url)) continue;
    result.careersUrls.push(page.url);
    const links = extractLinks(page.body, page.url, { sameOriginOnly: false });
    for (const ext of externalAtsLinks(links, homeHost, { relaxed: true, globalLinks: homeLinks })) {
      if (!result.externalHosts.some((e) => e.host === ext.host)) result.externalHosts.push(ext);
    }
  }

  // Verify each candidate before it is allowed to reach the registry. Capped:
  // an employer footer can carry a dozen partner links and none of the tail
  // ones are ever the ATS.
  const checked = [];
  for (const cand of result.externalHosts.slice(0, 6)) {
    checked.push(await verifyAtsHost(cand));
  }
  recordAtsVerificationFailures(result, checked);
  result.externalHosts = checked.filter((c) => c.verified);
  result.rejectedHosts = checked.filter((c) => !c.verified).map((c) => ({
    host: c.host,
    score: c.score,
    aggregator: c.aggregator || false,
    retryable: Boolean(c.retryable),
    failureStatus: c.failureStatus,
    blockedByRobots: Boolean(c.blockedByRobots),
    policyBlocked: Boolean(c.policyBlocked),
  }));
  // No third-party host anywhere, but a careers page exists -> the employer
  // publishes on its own site and needs a bespoke crawler rather than a family one.
  const blockedAts = checked.some((c) => c.blockedByRobots || c.policyBlocked);
  result.selfHosted = result.careersUrls.length > 0 && result.externalHosts.length === 0
    ? blockedAts ? null : !checked.some((c) => c.retryable)
    : false;
  return result;
}
