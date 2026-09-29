#!/usr/bin/env node
/**
 * Shared reader for a jobs.ch company profile.
 *
 * Four dedicated crawlers (gim-architekten, saint-gobain-weber-isover, strabag,
 * visionapartments) scrape the same public jobs.ch surface and carried four
 * byte-identical copies of the same loop, including the same
 * `catch → console.warn → continue` that makes a failed fetch look exactly like
 * a company with no openings. That ambiguity is what keeps reopening
 * `[crawler-health] … crawler unhealthy` issues (#7458): the monitor cannot tell
 * "the source says zero" from "the run never reached the source".
 *
 * One copy, and the loop now reports which of the two it saw.
 */
import { fetchHtml } from './hospital-custom-html-helpers.mjs';
import { extractJobPostingDescription, extractJobPostingField } from './jobposting-jsonld.mjs';

export const JOBS_CH_BASE_URL = 'https://www.jobs.ch';

/**
 * Open vacancy detail links rendered on a company profile.
 *
 * Quote-agnostic, like every other reader in this module: the attribute
 * delimiter is the serialiser's choice, not a fact about the page. A reader
 * that only accepts `href="` reads zero links the day jobs.ch ships
 * single-quoted attributes — and on this surface "zero" is not inert, it is
 * half of the emptiness proof.
 *
 * @param {string} html
 * @returns {string[]} absolute jobs.ch URLs
 */
export function parseVacancyLinks(html = '') {
  if (!html) return [];
  const urls = new Set();
  const re = /href=(["'])(\/en\/vacancies\/detail\/[a-f0-9-]+\/)\1/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    urls.add(`${JOBS_CH_BASE_URL}${m[2]}`);
  }
  return Array.from(urls);
}


/**
 * The employer part of a jobs.ch company slug, with its profile id stripped.
 *
 * jobs.ch mints two id shapes for the same employer — a legacy numeric one
 * (`49929-gim-architekten-ag`) and a UUID (`d7896bfc-…-gim-architekten-ag`) —
 * and a profile reached through the legacy id answers 200 while canonicalising
 * to the UUID. The two ids are not interchangeable as strings, but everything
 * after them is the same employer, and it is the employer that the counter has
 * to be scoped to. Foreign counters stay out: `867-jobcloud-ag` reduces to
 * `jobcloud-ag`, which is not this page's employer under any id.
 *
 * A slug with no recognisable id prefix is returned unchanged, so the
 * comparison degrades to the exact match it used to be.
 *
 * @param {string} slug
 * @returns {string}
 */
function companySlugIdentity(slug) {
  const value = String(slug || '').toLowerCase();
  const stripped = value
    .replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/, '')
    .replace(/^\d+-/, '');
  return stripped || value;
}

/**
 * The company slug this page declares as its own, read from `rel="canonical"`.
 *
 * The canonical is used rather than the requested path because jobs.ch keeps
 * legacy numeric profile ids alive as redirects: `70650-gim-architekten-ag`
 * answers 200 but canonicalises to `d7896bfc-…-gim-architekten-ag`, so scoping
 * on the requested slug would never match and the proof would be dead on
 * arrival for every redirected profile.
 *
 * @param {string} html
 * @returns {string|null}
 */
export function parseCanonicalCompanySlug(html = '') {
  const link = /<link\b[^>]*rel=["']canonical["'][^>]*>/i.exec(String(html || ''))
    || /<link\b[^>]*href=["'][^"']*["'][^>]*rel=["']canonical["'][^>]*>/i.exec(String(html || ''));
  if (!link) return null;
  const href = /href=["']([^"']+)["']/i.exec(link[0]);
  if (!href) return null;
  // locale-segment-ok: '/en/' is jobs.ch's own site-language path, not a site locale route
  const slug = /\/[a-z]{2}\/companies\/([^/"'?#]+)\//i.exec(href[1]);
  return slug ? slug[1] : null;
}

/**
 * The server-rendered vacancy counter on the profile's own tab:
 * `<a href="/en/companies/<slug>/vacancies/" …>Jobs (N)</a>`.
 *
 * Deliberately a *second, independent* reading of the same fact that
 * `parseVacancyLinks` extracts. If jobs.ch renames the detail-link shape while
 * the company still has openings, the links go to zero but the counter does
 * not — so an empty result stops being provable and the crawler stays visibly
 * unhealthy instead of silently retiring live vacancies.
 *
 * SCOPED TO THIS PAGE'S OWN COMPANY — by employer identity, not by the id
 * shape in the href — and that is the whole point. A profile
 * page carries other employers' `/companies/<slug>/vacancies/` hrefs — measured
 * on both live GIM profiles 2026-09-05, each also links `867-jobcloud-ag` (the
 * "Join our team" footer). An unscoped regex takes the FIRST counter in the
 * document, so a foreign `Jobs (0)` would grant the proof and the run would
 * retire live vacancies (`retainMissingJobs: false`) exactly in the scenario
 * this second reading exists to catch.
 *
 * Live control 2026-09-05: `city-pop-ag` → `Jobs (1)`, 1 link;
 * `strabag-ag` → `Jobs (22)`, 12 links on page 1 (the counter is the whole
 * board, the links are one page — which is why only `0` is ever read as proof);
 * both GIM profiles → `Jobs (0)`, 0 links.
 *
 * @param {string} html
 * @returns {number|null} the count, or null when this page's own tab did not
 *   render for this employer (including: no canonical, so no company to
 *   scope to)
 */
export function parseVacancyCountTab(html = '') {
  const source = String(html || '');
  const canonical = parseCanonicalCompanySlug(source);
  if (!canonical) return null;
  const identity = companySlugIdentity(canonical);
  // locale-segment-ok: '/en/' is jobs.ch's own site-language path, not a site locale route
  // Quote-agnostic on purpose, and matching `parseCanonicalCompanySlug`, which
  // has always accepted both: the two readers look at the SAME markup, so a
  // counter that only accepts `href="` would read `null` on a single-quoted
  // page whose canonical the other reader parses fine — silently voiding the
  // proof on all five jobs.ch company-page crawlers at once. The backreference
  // keeps the opening and closing delimiter the same, so a `'` inside a
  // double-quoted attribute cannot terminate it.
  const re = /href=(["'])\/[a-z]{2}\/companies\/([^/"']+)\/vacancies\/\1[^>]*>\s*Jobs\s*\((\d+)\)\s*</gi;
  let m;
  while ((m = re.exec(source)) !== null) {
    // Every counter on the page is a candidate; the employer identity decides,
    // not the id shape. A profile fetched by legacy id whose canonical is the
    // UUID keeps its proof, and a foreign employer's counter still cannot grant
    // it — which is the only thing the exact-slug comparison ever bought.
    if (companySlugIdentity(m[2]) === identity) return Number(m[3]);
  }
  return null;
}

/**
 * Languages the site can take as a vacancy's `sourceLang`. jobs.ch declares
 * `originalLanguage` on every vacancy; a value outside this set (none observed
 * so far) falls back to text detection in the caller.
 */
const JOBS_CH_SOURCE_LANGS = new Set(['de', 'fr', 'it', 'en']);

/**
 * The language a jobs.ch vacancy was WRITTEN in, the language this page was
 * served in, and the per-language routes of the same vacancy.
 *
 * Read from the page's own `vacancy-detail` state:
 * `{"originalLanguage":"de","requestedLang":"en",…}` plus
 * `"translatedRoutes":{"de":"/de/stellenangebote/detail/<uuid>/",…}`. On the
 * `/en/vacancies/detail/<uuid>/` route that the company profile links to,
 * jobs.ch serves a MACHINE TRANSLATION of a German or French vacancy in both
 * the JSON-LD `JobPosting` and that state (`requestedLang` ≠
 * `originalLanguage`). Measured 2026-09-29 on strabag
 * `6f2b1045-1245-475b-a118-6690e3b5c0d7`: the `/en/` JSON-LD reads «At STRABAG,
 * around 89,000 people…» while the vacancy was written «Bei STRABAG bauen rund
 * 89.000 Menschen…». Publishing that text as the source mislabels
 * `sourceLang` as `en`, and every other locale is then translated from a
 * translation.
 *
 * @param {string} html
 * @returns {{ originalLanguage: string|null, requestedLang: string|null, translatedRoutes: Record<string, string> }}
 */
export function parseVacancyLanguage(html = '') {
  const source = String(html || '');
  const langs = vacancyLanguageState(source);
  let translatedRoutes = {};
  const routes = /"translatedRoutes"\s*:\s*(\{[^{}]*\})/.exec(source);
  if (routes) {
    try {
      const parsed = JSON.parse(routes[1]);
      if (parsed && typeof parsed === 'object') translatedRoutes = parsed;
    } catch {
      translatedRoutes = {};
    }
  }
  return {
    originalLanguage: langs.originalLanguage,
    requestedLang: langs.requestedLang,
    translatedRoutes,
  };
}

const LANG_CODE_RE = /^[a-z]{2}$/i;
const MAX_ENCLOSING_OBJECT_ATTEMPTS = 64;

/**
 * End index (exclusive) of the JSON object that opens at `start`, scanning
 * with string/escape awareness; -1 when it does not close.
 */
function jsonObjectEnd(source, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * `originalLanguage` and `requestedLang` read as members of the SAME JSON
 * object — the one that declares `requestedLang` — whatever their order.
 *
 * A regex that expects `"originalLanguage":…,"requestedLang":…` in that
 * sequence silently reports "not translated" the day jobs.ch serialises the
 * keys in another order, and the crawler goes back to publishing the English
 * machine translation. The page also carries `originalLanguage` on objects
 * that are not the vacancy (company reviews), so the pair must come from one
 * object: the innermost object around a `requestedLang` key that parses as
 * JSON and owns that key.
 *
 * @param {string} source
 * @returns {{ originalLanguage: string|null, requestedLang: string|null }}
 */
function vacancyLanguageState(source) {
  const keyRe = /"requestedLang"\s*:/g;
  let key;
  while ((key = keyRe.exec(source)) !== null) {
    let start = key.index;
    for (let attempt = 0; attempt < MAX_ENCLOSING_OBJECT_ATTEMPTS; attempt += 1) {
      start = source.lastIndexOf('{', start - 1);
      if (start < 0) break;
      const end = jsonObjectEnd(source, start);
      if (end <= key.index) continue;
      let node;
      try {
        node = JSON.parse(source.slice(start, end));
      } catch {
        continue;
      }
      if (!node || typeof node !== 'object' || !Object.hasOwn(node, 'requestedLang')) continue;
      const originalLanguage = String(node.originalLanguage ?? '');
      const requestedLang = String(node.requestedLang ?? '');
      if (LANG_CODE_RE.test(originalLanguage) && LANG_CODE_RE.test(requestedLang)) {
        return { originalLanguage: originalLanguage.toLowerCase(), requestedLang: requestedLang.toLowerCase() };
      }
      break;
    }
  }
  return { originalLanguage: null, requestedLang: null };
}

/**
 * True when `html` is a readable vacancy page for `uuid`: a JobPosting with a
 * title and a non-empty description, and — when the posting carries a UUID
 * identifier — that UUID. A 200 that is an error page, a generic landing page
 * or another vacancy must not replace the translated vacancy the caller
 * already has: the caller would read no posting from it and drop the job.
 *
 * @param {string} html
 * @param {string} uuid
 */
function isVacancyPageFor(html, uuid) {
  const title = String(extractJobPostingField(html, 'title') || '').trim();
  const description = String(extractJobPostingDescription(html) || '').replace(/<[^>]*>/g, ' ').trim();
  if (!title || !description) return false;
  const identifier = extractJobPostingField(html, 'identifier');
  const id = String(identifier?.value ?? (typeof identifier === 'string' ? identifier : '')).trim().toLowerCase();
  return !(/^[0-9a-f]{8}-[0-9a-f-]+$/.test(id) && uuid && id !== uuid);
}

function vacancyUuidOf(url = '') {
  return /\/detail\/([0-9a-f-]{8,})\/?(?:[?#]|$)/i.exec(String(url || ''))?.[1]?.toLowerCase() || '';
}

/**
 * Fetch a jobs.ch vacancy in the language it was written in.
 *
 * The profile links every vacancy through its `/en/` route. When that page
 * declares a different `originalLanguage`, the original-language route of the
 * SAME vacancy (same UUID, taken from the page's own `translatedRoutes`) is
 * fetched instead, so the JSON-LD the caller reads is the employer's text, not
 * jobs.ch's translation of it. The returned `url` is that original route: it is
 * the page whose visible body matches the published description, which is what
 * a reader (and the source-detail audit) opens.
 *
 * Degrades, never drops: if the original route is missing, points at another
 * vacancy, fails to load, answers with a page that is not this vacancy (error
 * or generic page without its JobPosting), or is itself still a translation,
 * the `/en/` page is
 * returned with `translated: true` so the caller keeps the vacancy (same text
 * it published before this reader existed) and can label it honestly.
 *
 * @param {string} jobUrl `/en/vacancies/detail/<uuid>/` link from the profile
 * @param {{ fetchPage?: (url: string) => Promise<string> }} [options]
 * @returns {Promise<{ html: string, url: string, sourceLang: string|null, translated: boolean }>}
 */
export async function fetchJobsChVacancyInOriginalLanguage(jobUrl, { fetchPage = fetchHtml } = {}) {
  const html = await fetchPage(jobUrl);
  const { originalLanguage, requestedLang, translatedRoutes } = parseVacancyLanguage(html);
  const declared = originalLanguage && JOBS_CH_SOURCE_LANGS.has(originalLanguage) ? originalLanguage : null;
  if (!originalLanguage || !requestedLang || originalLanguage === requestedLang) {
    return { html, url: jobUrl, sourceLang: declared, translated: false };
  }
  const translatedFallback = { html, url: jobUrl, sourceLang: null, translated: true };
  const route = String(translatedRoutes[originalLanguage] || '');
  const uuid = vacancyUuidOf(jobUrl);
  if (!route.startsWith('/') || !uuid || vacancyUuidOf(route) !== uuid) {
    console.warn(`  ⚠️ ${jobUrl}: written in "${originalLanguage}" but no matching original-language route — keeping the jobs.ch translation`);
    return translatedFallback;
  }
  const originalUrl = new URL(route, JOBS_CH_BASE_URL).href;
  let originalHtml;
  try {
    originalHtml = await fetchPage(originalUrl);
  } catch (err) {
    console.warn(`  ⚠️ Original-language fetch failed for ${originalUrl}: ${err?.message || err} — keeping the jobs.ch translation`);
    return translatedFallback;
  }
  if (!isVacancyPageFor(originalHtml, uuid)) {
    console.warn(`  ⚠️ ${originalUrl} is not a readable vacancy page (no JobPosting title/description for ${uuid}) — keeping the jobs.ch translation`);
    return translatedFallback;
  }
  const check = parseVacancyLanguage(originalHtml);
  if (check.requestedLang && check.requestedLang !== originalLanguage) {
    console.warn(`  ⚠️ ${originalUrl} still served "${check.requestedLang}" for a "${originalLanguage}" vacancy — keeping the jobs.ch translation`);
    return translatedFallback;
  }
  return { html: originalHtml, url: originalUrl, sourceLang: declared, translated: false };
}

/** @param {{ label: string, identity?: string }} target */
function identityMarkerFor(target) {
  return target.identity || String(target.label || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/**
 * Case- and whitespace-insensitive containment: jobs.ch renders the employer
 * name from its own record, so casing and internal spacing follow the profile,
 * not our `COMPANY_TARGETS` label (`STRABAG AG` vs `Strabag AG`). An exact
 * `includes()` would refuse the proof on a page that plainly is the right one.
 */
function pageNamesEmployer(html, identity) {
  if (!identity) return false;
  const fold = (value) => String(value).toLowerCase().replace(/\s+/g, ' ');
  return fold(html).includes(fold(identity));
}

/**
 * Statuses that mean this profile URL is not coming back.
 *
 * jobs.ch mints two profile ids per employer and retires the legacy one when it
 * feels like it; the retired URL then answers 404 forever. Every other status
 * is ambiguous about the source — a 503 or an anti-bot fence says "ask again
 * later", so it stays a break — but "gone" is not ambiguous: that profile has
 * no vacancies to omit from the batch, because it has no page at all.
 */
const PROFILE_GONE_STATUS = new Set([404, 410]);

/**
 * The gone-status of a failed fetch, or null when the failure means anything
 * else. `fetchHtml` attaches `.status`; the message is read as a fallback
 * because the error crosses a proxy-rescue path that only guarantees to
 * re-throw the original `HTTP <status> from <url>`.
 *
 * @param {unknown} err
 * @returns {number|null}
 */
function goneStatusOf(err) {
  const fromMessage = /\bHTTP (\d{3})\b/.exec(String(/** @type {any} */ (err)?.message || ''));
  const status = Number(/** @type {any} */ (err)?.status) || Number(fromMessage?.[1]);
  return PROFILE_GONE_STATUS.has(status) ? status : null;
}

/**
 * Walk every jobs.ch profile of one employer and collect its open vacancies.
 *
 * @param {Array<{ path: string, label: string, identity?: string }>} targets
 * @param {{ fetchPage?: (url: string) => Promise<string>, pathSuffix?: string }} [options]
 *   `pathSuffix` is `'vacancies/'` for employers whose board is paginated and
 *   only lists openings on the dedicated sub-tab.
 * @returns {Promise<{ vacancyUrls: string[], provenEmpty: boolean, evidence: string }>}
 *   `provenEmpty` is true only when EVERY profile was fetched, was still this
 *   employer's own profile, rendered its counter, and that counter read zero.
 *   A swallowed fetch error, an unrecognised page or a non-zero counter all
 *   leave it false — i.e. "we did not observe an empty source", which the
 *   caller must translate into "keep the previous slice".
 *
 *   A profile that is *gone* (404/410) is the one failure that does not end the
 *   run: the walk continues on the employer's remaining profiles and the proof
 *   is withheld. Throwing on it made the whole crawler hard-down on every run
 *   for as long as jobs.ch kept the retired id retired — a permanent red that
 *   no longer publishes anything, and a weekly `[crawler-health]` issue, which
 *   is the backlog this module exists to close. If EVERY profile is gone the
 *   error still propagates: an employer with no page left on jobs.ch is a real
 *   break, not a degraded one.
 */
export async function collectJobsChVacancyUrls(targets, { fetchPage = fetchHtml, pathSuffix = '' } = {}) {
  const vacancyUrls = new Set();
  const counters = [];
  let everyProfileProvenEmpty = true;
  let reachedAnyProfile = false;
  let firstGoneError = null;

  for (const target of targets) {
    // locale-segment-ok: '/en/' is jobs.ch's own external site-language path, not a site locale route
    const companyPageUrl = `${JOBS_CH_BASE_URL}/en/companies/${target.path}/${pathSuffix}`;
    // A failed fetch is NOT swallowed. The four copies of this loop each did
    // `catch → warn → continue`, which is how "the runner could not reach
    // jobs.ch" became indistinguishable from "the employer has no openings".
    // Letting it propagate hands the error to the classifier
    // `runStandardCrawlerPipeline` already implements around `fetchJobs()`: a
    // connection-level failure or an exhausted anti-bot fence soft-exits and
    // keeps the previous slice, while a real HTTP status (404 gone, persistent
    // 503) surfaces as the break it is. It also removes the partial-batch
    // hazard — one profile answering while the other is unreachable can no
    // longer publish a batch that silently omits half the employer.
    //
    // The single exception is a profile that is GONE (404/410). "Unreachable"
    // and "retired" are different facts: the first hides vacancies that may
    // exist, the second is jobs.ch stating there are none here any more, so
    // there is no half-employer to omit. Propagating it kept the crawler
    // hard-down on every run, publishing nothing at all, while the employer's
    // surviving profile was answering 200 the whole time.
    let html;
    try {
      html = await fetchPage(companyPageUrl);
    } catch (err) {
      const gone = goneStatusOf(err);
      if (gone === null) throw err;
      console.warn(
        `  ⚠️ ${target.label}: profile is gone (HTTP ${gone}) — continuing with this`
        + " employer's other profiles, without granting the empty proof",
      );
      firstGoneError ??= err;
      everyProfileProvenEmpty = false;
      continue;
    }
    reachedAnyProfile = true;
    const links = parseVacancyLinks(html);
    console.log(`  📋 ${target.label}: ${links.length} open vacancy link(s)`);
    for (const link of links) vacancyUrls.add(link);

    const renderedCount = parseVacancyCountTab(html);
    // A 200 does not prove the page is the page we asked for — a WAF shell or a
    // CDN catch-all answers 200 with HTML too. The employer's own name has to
    // be on it before its counter says anything about this employer.
    const isOwnProfile = pageNamesEmployer(html, identityMarkerFor(target));
    if (renderedCount === null || !isOwnProfile) {
      console.warn(
        `  ⚠️ ${target.label}: no rendered "Jobs (N)" counter on this employer's profile`
        + ` (counter=${renderedCount ?? 'absent'}, identity=${isOwnProfile})`,
      );
      everyProfileProvenEmpty = false;
      continue;
    }
    counters.push(`${target.path}=${renderedCount}`);
    if (renderedCount !== 0) everyProfileProvenEmpty = false;
  }

  // Degrading is only degrading while something is left to degrade to. With
  // every profile gone there is no surviving reading of this employer, so the
  // run must break rather than hand the caller an empty, unproven result that
  // looks exactly like a quiet week.
  if (!reachedAnyProfile && firstGoneError) throw firstGoneError;

  return {
    vacancyUrls: [...vacancyUrls],
    provenEmpty: everyProfileProvenEmpty && vacancyUrls.size === 0,
    evidence: `jobs.ch company profiles render a zero vacancy counter (${counters.join(', ')})`,
  };
}
