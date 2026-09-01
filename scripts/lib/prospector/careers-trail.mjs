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
 * Absolute links in an HTML document, with their anchor text.
 *
 * Written as a scan for `href=` rather than a full anchor match on purpose:
 * SME sites nest `<span>`/`<img>` inside `<a>` freely, and a
 * `<a ...>(.*?)</a>` regex silently drops those. Here the anchor text is a
 * best-effort slice AFTER the tag, and a missing one is fine because the href
 * itself usually carries the token.
 *
 * @param {string} html
 * @param {string} baseUrl
 * @returns {{ url: string, text: string, host: string }[]}
 */
export function extractLinks(html = '', baseUrl = '') {
  const out = [];
  const seen = new Set();
  const rx = /<a\b([^>]*)>/gi;
  let m;
  while ((m = rx.exec(html))) {
    const attrs = m[1];
    const href = readAttr(attrs, 'href');
    if (!href) continue;
    if (/^(#|mailto:|tel:|javascript:|data:)/i.test(href.trim())) continue;
    // Anchor text = the markup up to the next </a>, tags stripped.
    const rest = html.slice(rx.lastIndex, rx.lastIndex + 400);
    const text = rest.split(/<\/a>/i)[0].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const aria = readAttr(attrs, ['aria-label', 'title']);
    let abs;
    try { abs = new URL(href, baseUrl).toString(); } catch { continue; }
    if (!/^https?:/i.test(abs)) continue;
    const key = abs.split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: abs, text: cleanAnchorText(joinAnchorParts(text, aria)), host: normalizeHost(new URL(abs).hostname) });
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
  return CAREER_TOKEN_RX.test(link.text) || CAREER_TOKEN_RX.test(pathPart);
}

/**
 * Careers-looking URLs listed in a site's sitemap. Reads the sitemap index one
 * level deep, which is where most WordPress/Wix sites keep the page sitemap.
 *
 * @param {string} origin
 * @returns {Promise<string[]>}
 */
export async function careersFromSitemap(origin) {
  const found = [];
  const seen = new Set();
  /** @param {string} url @param {number} depth */
  const read = async (url, depth) => {
    if (depth > 1 || seen.has(url) || found.length >= 8) return;
    seen.add(url);
    const res = await politeFetch(url, { accept: 'application/xml,text/xml,*/*' });
    if (!res.ok || !res.body.includes('<')) return;
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
      if (CAREER_TOKEN_RX.test(p)) found.push(loc);
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
 * @returns {Promise<{ host: string, url: string, text: string, score: number, signals: string[], vacancyCount: number, aggregator?: boolean, distinctCompanies?: number, verified: boolean }>}
 */
export async function verifyAtsHost(candidate, minScore = 3) {
  const res = await politeFetch(candidate.url);
  if (!res.ok || res.body.length < 200) {
    return { ...candidate, score: 0, signals: ['unreachable'], vacancyCount: 0, verified: false };
  }
  const links = extractLinks(res.body, res.url);
  const scored = scoreVacancyPage(res.body, res.url, links);
  // A careers link that lands on an aggregator tells us where the employer
  // ADVERTISES, not where it publishes. Recording it would seed the registry
  // with job boards — inventory everyone already has — and the loop exists for
  // the opposite: employers who hire directly and are indexed nowhere else.
  const surface = looksLikeAggregator(scored.vacancies, candidate.host);
  return {
    ...candidate,
    url: res.url,
    score: scored.score,
    signals: scored.signals,
    vacancyCount: scored.vacancies.length,
    aggregator: surface.aggregator,
    distinctCompanies: surface.distinctCompanies,
    verified: scored.score >= minScore && !surface.aggregator,
  };
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
 * @param {string} employerDomain
 * @returns {Promise<Awaited<ReturnType<typeof traceCareers>>>}
 */
export async function traceFromCareersUrl(careersUrl, employerDomain) {
  const result = { domain: employerDomain, reachable: false, careersUrls: [], externalHosts: [], rejectedHosts: [], selfHosted: false, via: ['known-careers-url'] };
  const page = await politeFetch(careersUrl);
  if (!page.ok || page.body.length < 300) return result;
  result.reachable = true;
  result.careersUrls.push(page.url);
  const links = extractLinks(page.body, page.url);
  const checked = [];
  for (const cand of externalAtsLinks(links, employerDomain, { relaxed: true }).slice(0, 6)) {
    checked.push(await verifyAtsHost(cand));
  }
  result.externalHosts = checked.filter((c) => c.verified);
  result.rejectedHosts = checked.filter((c) => !c.verified).map((c) => ({ host: c.host, score: c.score, aggregator: c.aggregator || false }));
  result.selfHosted = result.externalHosts.length === 0;
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
 *   rejectedHosts?: { host: string, score: number }[], selfHosted: boolean, via: string[]
 * }>}
 */
export async function traceCareers(domain, opts = {}) {
  const maxCareerPages = opts.maxCareerPages ?? 3;
  const result = { domain, reachable: false, careersUrls: [], externalHosts: [], selfHosted: false, via: [] };

  let home = await politeFetch(`https://${domain}/`);
  if (!home.ok) home = await politeFetch(`https://www.${domain}/`);
  if (!home.ok || home.body.length < 300) return result;
  result.reachable = true;
  const origin = new URL(home.url).origin;
  const homeLinks = extractLinks(home.body, home.url);

  // Hop 0 — the ATS link is sometimes right on the homepage.
  const fromHome = externalAtsLinks(homeLinks, domain);
  if (fromHome.length) { result.externalHosts.push(...fromHome); result.via.push('homepage'); }

  // Hop 1 — candidate careers pages, cheapest source first.
  const candidates = [];
  for (const l of homeLinks) {
    if (!isCareerLink(l)) continue;
    if (registrableDomain(l.host) !== registrableDomain(domain)) continue;
    candidates.push(l.url);
  }
  if (candidates.length) result.via.push('homepage-link');
  if (!candidates.length) {
    const sm = await careersFromSitemap(origin);
    if (sm.length) { candidates.push(...sm); result.via.push('sitemap'); }
  }
  if (!candidates.length) {
    for (const hint of CAREER_PATH_HINTS) {
      const probe = await politeFetch(`${origin}${hint}`);
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

  const seen = new Set();
  for (const url of candidates.slice(0, maxCareerPages)) {
    const key = url.split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    const page = await politeFetch(url);
    if (!page.ok) continue;
    if (!isDistinctCareerSurface(home.body, page.body, page.url, home.url)) continue;
    result.careersUrls.push(page.url);
    const links = extractLinks(page.body, page.url);
    for (const ext of externalAtsLinks(links, domain, { relaxed: true, globalLinks: homeLinks })) {
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
  result.externalHosts = checked.filter((c) => c.verified);
  result.rejectedHosts = checked.filter((c) => !c.verified).map((c) => ({ host: c.host, score: c.score, aggregator: c.aggregator || false }));

  // No third-party host anywhere, but a careers page exists -> the employer
  // publishes on its own site and needs a bespoke crawler rather than a family one.
  result.selfHosted = result.careersUrls.length > 0 && result.externalHosts.length === 0;
  return result;
}
