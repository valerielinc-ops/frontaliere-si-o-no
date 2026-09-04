#!/usr/bin/env node
/**
 * Shared helpers for Swiss employers that publish jobs via a jobup.ch feed
 * (the "company mask" pattern used by the Jalios JCMS PluginJobUp and several
 * other Romandie HR integrations).
 *
 * Feed URL convention:
 *   https://www.jobup.ch/masks/{KEY}/list_{KEY}.asp?cmd=json
 *
 * Response shape (JSON):
 *   {
 *     "jobcount": "7",
 *     "jobs": [
 *       {
 *         "titre":       "Apprenti agent d'exploitation CFC",
 *         "puddate":     "11/05/2026"           (DD/MM/YYYY),
 *         "lieu":        "1660 Château d'Oex"  (postal + city),
 *         "ref":         "Bâtiment / Construction" (category),
 *         "link":        "https://www.jobup.ch/fr/emplois/detail/{uuid}/",
 *         "canton":      "Riviera - Chablais"   (region label, not ISO),
 *         "contrat":     "PERMANENT" | ""       (employment contract),
 *         "occupationmin": "80",                 (numeric percent or empty),
 *         "occupationmax": "100%"                (numeric percent with optional %)
 *       }
 *     ]
 *   }
 *
 * Confirmed users (May 2026):
 *   - Pôle Santé Pays-d'Enhaut, Château-d'Oex (key `hpe`)
 *   - Étab. Hospitaliers Nord Vaudois, Yverdon (key `ehnv`)
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import { fetchWithRetry } from './transient-fetch.mjs';
import { launchChromium } from './ensure-chromium.mjs';
import { fetchHtmlViaJinaWithRetry } from './jina-proxy.mjs';
import { assertJsonListShape } from './assert-json-list-shape.mjs';
import { isSufficientVacancyDescription as hasPublishableJobupDetail } from './prospector/extract.mjs';
import { resolveSourceBackedSwissGeography } from './prospector/location-evidence.mjs';
import { ALL_CANTON_CODES } from './crawler-location-config.mjs';
import {
  createSpecUrlPolicy,
  fetchFollowingValidatedRedirects,
} from './prospector/public-fetch-policy.mjs';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

// jobup.ch's CDN/WAF returns HTTP 403 for the FrontaliereTicinoBot UA (#1305
// ehnv). Present as a real desktop browser — rotated per attempt — to clear the
// anti-bot gate, mirroring the goline crawler's realistic-UA + Playwright
// fallback pattern. The feed endpoint is a plain JSON .asp; a real browser UA
// + Accept-Language + Referer is enough in the common case, with Playwright as
// the last resort when the WAF demands a full JS-capable client.
const BROWSER_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

/**
 * Whether an HTTP status looks like jobup's anti-bot fence (403/406/401). 429 is
 * NOT here — it is routed as retryable-transient in fetchFeed (rotating UA +
 * backoff), not via the Playwright fallback.
 */
function isAntiBotStatus(status) {
  return status === 403 || status === 406 || status === 401;
}

/**
 * Whether a Playwright-fetched body looks like the jobup feed payload, i.e. raw
 * JSON (`[`/`{`) or a JSONP `xCallback({...})` wrapper (the two shapes
 * `parseFeedBody` accepts). Used to reject a WAF 200-with-JS/CAPTCHA challenge
 * page, which would pass `resp.ok()` but is not the feed — returning it would
 * throw in `parseFeedBody` and re-surface a confusing parse error instead of the
 * original anti-bot failure (#1323 item 7).
 */
export function looksLikeJsonFeedBody(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return false;
  return /^[[{]/.test(trimmed) || /^[a-zA-Z_$][\w$]*\s*\(/.test(trimmed);
}

/**
 * Last-resort fetch of the jobup JSON feed via a headless browser, for when the
 * WAF blocks plain `fetch` with 403 even under a realistic UA. Navigates to the
 * feed URL and returns the raw response body text. Returns null if Playwright is
 * unavailable, navigation fails, or the body is not the JSON feed — caller then
 * surfaces the original HTTP error.
 */
async function fetchFeedViaPlaywright(url) {
  let browser;
  try {
    browser = await launchChromium({ headless: true });
    const context = await browser.newContext({
      userAgent: BROWSER_USER_AGENTS[0],
      locale: 'fr-CH',
      extraHTTPHeaders: { Referer: 'https://www.jobup.ch/' },
    });
    const page = await context.newPage();
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (!resp || !resp.ok()) return null;
    // Read the raw response bytes, not `document.body.innerText`: innerText
    // whitespace-normalizes and headless Chromium renders `application/json`
    // through its JSON viewer, so the extracted text is not guaranteed to be the
    // raw body (#1323 item 4). `resp` is already captured above.
    const body = await resp.text();
    // A WAF can answer 200 with a JS/CAPTCHA challenge page instead of the feed;
    // that passes `resp.ok()` but is not JSON. Reject it so the caller surfaces
    // the original anti-bot failure cleanly (#1323 item 7).
    if (!looksLikeJsonFeedBody(body)) {
      console.warn(`[jobup] Playwright fallback for ${url} returned a non-JSON body (likely a 200 anti-bot challenge)`);
      return null;
    }
    return body;
  } catch (err) {
    console.warn(`[jobup] Playwright fallback failed for ${url}: ${err?.message || err}`);
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/** Parse a jobup feed body (tolerating a JSONP `xCallback({...})` wrapper). */
function parseFeedBody(text) {
  const trimmed = String(text || '').trim();
  const jsonpMatch = trimmed.match(/^[a-zA-Z_$][\w$]*\s*\(\s*([\s\S]+)\s*\)\s*;?\s*$/);
  const jsonText = jsonpMatch ? jsonpMatch[1] : trimmed;
  return JSON.parse(jsonText);
}

/**
 * When Jina Reader fetches a JSON endpoint, Chromium renders the response
 * through its built-in JSON viewer: the JSON payload appears as the text
 * content of a `<pre>` element inside an `<html>` page. Extract the raw JSON
 * text so `parseFeedBody` can parse it — otherwise `looksLikeJsonFeedBody`
 * correctly rejects the HTML-wrapped body as non-JSON.
 *
 * Returns the extracted JSON string if found, or null if the body does not
 * look like a Jina/Chromium JSON-viewer page.
 */
function extractJsonFromJinaHtmlWrapper(body) {
  const trimmed = String(body || '').trim();
  // Fast path: already raw JSON (no HTML wrapper).
  if (looksLikeJsonFeedBody(trimmed)) return trimmed;
  // Chromium JSON viewer: <html>...<body><pre ...>{...}</pre></body></html>
  const preMatch = trimmed.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  if (!preMatch) return null;
  const candidate = preMatch[1].trim();
  if (!looksLikeJsonFeedBody(candidate)) return null;
  return candidate;
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  agrave: 'à', acirc: 'â', auml: 'ä', aring: 'å', atilde: 'ã', aacute: 'á',
  Agrave: 'À', Acirc: 'Â',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  Eacute: 'É', Egrave: 'È', Ecirc: 'Ê', Euml: 'Ë',
  iacute: 'í', igrave: 'ì', icirc: 'î', iuml: 'ï',
  oacute: 'ó', ograve: 'ò', ocirc: 'ô', ouml: 'ö',
  uacute: 'ú', ugrave: 'ù', ucirc: 'û', uuml: 'ü',
  ccedil: 'ç', Ccedil: 'Ç', oelig: 'œ', OElig: 'Œ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  hellip: '…', ndash: '–', mdash: '—', middot: '·',
};

function decodeEntitiesOnce(s) {
  return s
    .replace(/&([a-zA-Z]+);/g, (m, name) => Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : m)
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

/**
 * Decode HTML entities — repeats up to 3 times because jobup.ch's feed
 * sometimes double-encodes (returns `&amp;nbsp;` for what should be ` `).
 */
function decodeEntities(s = '') {
  let cur = String(s || '');
  for (let i = 0; i < 3; i++) {
    const next = decodeEntitiesOnce(cur);
    if (next === cur) return next;
    cur = next;
  }
  return cur;
}

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

async function fetchFeed(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  let attemptIdx = 0; // rotates the realistic UA across retries
  try {
    // Transient network blips + 429/5xx retry via the shared bounded-backoff
    // loop; a real browser UA + Accept-Language + Referer clears jobup's WAF in
    // the common case.
    const text = await fetchWithRetry(async () => {
      const ua = BROWSER_USER_AGENTS[attemptIdx % BROWSER_USER_AGENTS.length];
      attemptIdx += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          headers: {
            Accept: 'application/json,text/javascript,*/*;q=0.8',
            'Accept-Language': 'fr-CH,fr;q=0.9,it;q=0.8,en;q=0.7',
            'User-Agent': ua,
            Referer: 'https://www.jobup.ch/',
          },
          signal: controller.signal,
        });
        if (!res.ok) {
          const err = new Error(`HTTP ${res.status} from ${url}`);
          err.status = res.status;
          // 408/429/5xx are transient; anti-bot 401/403/406 are NOT retried via
          // plain fetch (rotating UA won't help) — handled by Playwright below.
          err.retryable = res.status === 408 || res.status === 429 || res.status >= 500;
          throw err;
        }
        return await res.text();
      } finally {
        clearTimeout(timer);
      }
    }, { label: `jobup ${url}` });
    return parseFeedBody(text);
  } catch (err) {
    // Persistent anti-bot fence (403/406): the feed is a plain GET so we can
    // route it through the Jina Reader proxy (clean egress IP, real browser
    // fetch) as a cheaper intermediate step before spinning up a full headless
    // Chromium. Jina succeeds in the common case (IP-reputation block only);
    // Playwright is the final resort when jobup's WAF demands a full JS session
    // (#1745). Fallback order: Jina → Playwright → re-throw original error.
    if (isAntiBotStatus(err?.status)) {
      console.warn(`[jobup] HTTP ${err.status} from ${url} — trying Jina proxy fallback`);
      const jinaRaw = await fetchHtmlViaJinaWithRetry(url, { timeoutMs: 30000 });
      // Jina renders JSON endpoints through Chromium's JSON viewer → the JSON
      // is wrapped in an HTML page; extract it before parsing.
      const jinaJson = jinaRaw ? extractJsonFromJinaHtmlWrapper(jinaRaw) : null;
      if (jinaJson) {
        try {
          return parseFeedBody(jinaJson);
        } catch (parseErr) {
          console.warn(`[jobup] Jina body did not parse as JSON: ${parseErr?.message || parseErr}`);
        }
      } else if (jinaRaw) {
        console.warn(`[jobup] Jina returned a non-JSON body for ${url} — escalating to Playwright`);
      }
      // Jina unavailable / challenge body / parse error — escalate to Playwright.
      console.warn(`[jobup] Trying Playwright anti-bot fallback for ${url}`);
      const body = await fetchFeedViaPlaywright(url);
      if (body) {
        try {
          return parseFeedBody(body);
        } catch (parseErr) {
          console.warn(`[jobup] Playwright body did not parse as JSON: ${parseErr?.message || parseErr}`);
        }
      }
      // Every layer (realistic-UA fetch → Jina clean IP → headless Playwright)
      // hit the anti-bot fence. That the CLEAN Jina IP was also blocked makes
      // this an IP-reputation/WAF mood transient, not a source removal — the
      // same class as a connection-level egress failure. Mark it so the pipeline
      // soft-exits (keep existing slice, no de-index, no "Crawler Failure" issue
      // every run) instead of hard-failing on the raw HTTP status (#2029 ehnv:
      // the jobup mask is ALSO empty — jobcount:0 — from a clean IP, so even a
      // successful fetch yields 0 jobs; bricking the run on the 403 only spams
      // issues). The crawler-health monitor (3 consecutive 0-job runs) still
      // surfaces a persistent outage, so nothing is silently buried.
      err.antiBotExhausted = true;
    }
    throw err;
  }
}

const CANTON_CODE_SET = new Set(ALL_CANTON_CODES);

// Some jobup `lieu` values append the canton code after the city
// ("6900 Lugano TI"). That trailing token belongs to the same slot as the
// `postal` field, not the city name — left in `city`, it fails the exact-match
// BFS lookup in `isKnownSwissMunicipalityInCanton` (e.g. "Lugano TI" is not a
// registered municipality token, "Lugano" is), rejecting an otherwise valid
// source location. See #7105.
function stripTrailingCantonCode(city = '') {
  const m = city.match(/^(.+?)\s+([A-Z]{2})$/);
  if (m && CANTON_CODE_SET.has(m[2])) return m[1].trim();
  return city;
}

/**
 * Parse the postal code + city from the jobup `lieu` field.
 * Examples:
 *   "1660 Château d'Oex" → { postal: "1660", city: "Château d'Oex" }
 *   "1400 Yverdon-les-Bains" → { postal: "1400", city: "Yverdon-les-Bains" }
 *   "Lausanne" → { postal: "", city: "Lausanne" }
 *   "6900 Lugano TI" → { postal: "6900", city: "Lugano" }
 */
export function parseJobupLieu(raw = '') {
  const decoded = decodeEntities(String(raw || ''));
  const m = decoded.match(/^\s*(\d{4})\s+(.+?)\s*$/);
  if (m) return { postal: m[1], city: stripTrailingCantonCode(normalizeSpace(m[2])) };
  return { postal: '', city: stripTrailingCantonCode(normalizeSpace(decoded)) };
}

/**
 * Convert the jobup occupation range to an `employmentType` constant.
 *   "80" + "100%"  → PART_TIME (max < 90) ? no, max=100 → FULL_TIME
 *   "100" + "100%" → FULL_TIME
 *   "50" + "70%"   → PART_TIME
 */
export function detectEmploymentTypeFromOccupation(min = '', max = '') {
  const maxNum = parseInt(String(max).replace(/[^\d]/g, ''), 10);
  if (!Number.isFinite(maxNum)) return 'OTHER';
  if (maxNum >= 90) return 'FULL_TIME';
  if (maxNum > 0) return 'PART_TIME';
  return 'OTHER';
}

/**
 * Convert jobup DD/MM/YYYY to ISO YYYY-MM-DD.
 */
export function parseJobupDate(raw = '') {
  const m = String(raw || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return '';
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function detectCategoryFromRef(ref = '', title = '') {
  const r = normalize(decodeEntities(ref).replace(/\s+/g, ' '));
  const t = normalize(title);
  if (/sant[éè]|m[ée]decine|soin|infirm|aide.soignant|asa|asse/.test(`${r} ${t}`)) return 'Sanità / Ospedali';
  if (/b[âa]timent|construct|travaux|technique|maintenan/.test(r)) return 'Tecnica';
  if (/informatique|it\b|software|d[ée]vel|programm/.test(r)) return 'IT';
  if (/administrat|secret|gestion|finance|compt/.test(r)) return 'Amministrazione';
  if (/rh\b|ressources humaines|human resources|personnel/.test(r)) return 'Risorse Umane';
  if (/cuisine|restauration|h[ôo]tel|gastronom/.test(r)) return 'Ospitalità';
  if (/logistique|achat|transport|magasin/.test(r)) return 'Logistica';
  if (/marketing|communication/.test(r)) return 'Marketing';
  if (/\b(apprenti|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|formation)/.test(r)) return 'Formazione';
  return 'Sanità / Ospedali'; // default for healthcare employers
}

function detectExperienceLevel(title = '', contrat = '') {
  const t = normalize(title);
  if (/\b(apprenti|stage|stagiair|intern)\b/.test(t)) return 'intern';
  if (/contrat d'apprentissage/i.test(contrat)) return 'intern';
  if (/\b(junior|assistant)\b/.test(t)) return 'junior';
  if (/\b(senior|chef|responsable|directeur|directrice|cadre|encadrant)\b/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Fetch a jobup.ch detail page and extract the JobPosting description from
 * the embedded JSON-LD structured data block. jobup.ch publishes complete
 * `JobPosting` schema with `description` (HTML) — far richer than the feed's
 * `ref` category text.
 */
export async function fetchJobupDetailDescription(detailUrl) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let initialUrl;
    try {
      initialUrl = new URL(detailUrl);
    } catch {
      return '';
    }
    if (
      initialUrl.protocol !== 'https:'
      || initialUrl.username
      || initialUrl.password
      || !['https://jobup.ch', 'https://www.jobup.ch'].includes(initialUrl.origin.toLowerCase())
    ) return '';
    const sourceUrlPolicy = createSpecUrlPolicy({ seedUrls: [initialUrl.href] });
    const res = await fetchFollowingValidatedRedirects(initialUrl.href, {
      validateUrl: sourceUrlPolicy,
      requestOptions: {
        headers: { Accept: 'text/html', 'User-Agent': USER_AGENT },
        signal: controller.signal,
        dispatcher: sourceUrlPolicy.dispatcher,
      },
    });
    if (!res.ok) return '';
    const html = await res.text();
    // Extract every <script type="application/ld+json"> block and look for JobPosting
    const blocks = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g) || [];
    for (const block of blocks) {
      const payload = block.replace(/^<script[^>]+>/, '').replace(/<\/script>$/, '').trim();
      try {
        const data = JSON.parse(payload);
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          if (item?.['@type'] === 'JobPosting' && item?.description) {
            // description is HTML; strip tags and decode entities
            const text = String(item.description)
              .replace(/<br\s*\/?>/gi, '\n')
              .replace(/<li[^>]*>/gi, '\n• ')
              .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
              .replace(/<[^>]+>/g, ' ');
            return decodeEntities(text).replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ').trim();
          }
        }
      } catch {
        // skip malformed JSON-LD blocks
      }
    }
    return '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create a jobup.ch feed parser for one employer.
 *
 * @param {Object} config
 * @param {string} config.companyKey         Internal slug, e.g. 'pole-sante-pays-enhaut'
 * @param {string} config.companyName        Display name
 * @param {string} config.companyDomain      Corporate domain (e.g. 'pspe.ch')
 * @param {string} config.jobupKey           jobup.ch mask key (e.g. 'hpe')
 * @param {string} config.defaultCanton      ISO canton code (e.g. 'VD')
 * @param {string} config.defaultCity        Legacy identity config; never used as a location fallback
 * @param {string} config.defaultPostalCode  Legacy config; never used as a location fallback
 * @param {string} [config.publicCareerUrl]  Corporate career page URL
 * @param {string} [config.defaultSourceLang='fr']
 */
export function createJobupChFeedParser(config) {
  const {
    companyKey,
    companyName,
    companyDomain,
    jobupKey,
    defaultCanton,
    publicCareerUrl,
    defaultSourceLang = 'fr',
  } = config;

  if (!companyKey || !companyName || !jobupKey || !defaultCanton) {
    throw new Error('createJobupChFeedParser: missing required config');
  }

  const FEED_URL = `https://www.jobup.ch/masks/${jobupKey}/list_${jobupKey}.asp?cmd=json`;
  const corporateHost = String(companyDomain || '').replace(/^www\./, '').toLowerCase();

  function isCompanyJob(job) {
    const key = normalize(job?.companyKey || '');
    const company = normalize(job?.company || '');
    const url = normalize(job?.url || '');
    if (key === companyKey) return true;
    if (corporateHost && (company.includes(corporateHost.split('.')[0]) || url.includes(corporateHost))) return true;
    if (url.includes(`/masks/${jobupKey}/`)) return true;
    return false;
  }

  function isTrustedDomain(rawUrl = '') {
    try {
      const host = new URL(rawUrl).hostname.toLowerCase();
      if (host === 'www.jobup.ch' || host === 'jobup.ch') return true;
      if (corporateHost && (host === corporateHost || host.endsWith(`.${corporateHost}`))) return true;
      return false;
    } catch {
      return false;
    }
  }

  async function fetchAllJobs() {
    console.log(`🏥 Fetching ${companyName} jobs`);
    console.log(`   Feed: ${FEED_URL}`);
    if (publicCareerUrl) console.log(`   Public: ${publicCareerUrl}`);
    console.log();

    const payload = await fetchFeed(FEED_URL);
    const items = assertJsonListShape(payload, { key: 'jobs', source: `jobup:${companyName}` });
    const totalReported = parseInt(String(payload?.jobcount || items.length), 10) || items.length;
    console.log(`  ✓ ${items.length} jobs (jobcount=${totalReported})`);
    if (items.length > 0) console.log(`  📄 Fetching jobup.ch detail pages for rich descriptions...`);

    if (!items.length) return [];

    const todayIso = new Date().toISOString().slice(0, 10);
    const jobs = [];
    const seenLinks = new Set();
    let detailHits = 0;

    for (const raw of items) {
      const link = normalizeSpace(raw?.link || '');
      if (!link) continue;
      if (seenLinks.has(link)) continue;
      seenLinks.add(link);

      const title = normalizeSpace(decodeEntities(raw?.titre || ''));
      if (!title || title.length < 3) continue;

      const rawLieu = normalizeSpace(raw?.lieu || '');
      const lieu = parseJobupLieu(rawLieu);
      const hasUnsupportedPostalPrefix = /^\d+\b/.test(rawLieu) && !lieu.postal;
      const location = lieu.city;
      // Feed the already-parsed postal/city split as a structured candidate
      // (addressLocality/postalCode) instead of the whole raw `lieu` string,
      // matching the structured pattern used by the Coop/Cippà family. This
      // grounds municipality→canton matching in the locality jobup itself
      // separated from the postal prefix, instead of fuzzy-matching over the
      // full "<postal> <city>" text.
      const geography = hasUnsupportedPostalPrefix
        ? null
        : resolveSourceBackedSwissGeography({
            location: rawLieu,
            addressLocality: lieu.city,
            postalCode: lieu.postal,
          });
      const canton = geography?.canton || '';
      if (!location || !canton) {
        console.log(`     ⚠ source location rejected for ${link}: missing, foreign or unresolved lieu`);
        return [];
      }
      const postalCode = lieu.postal;

      // Fetch detail page for rich description (JSON-LD JobPosting)
      const detailDescription = await fetchJobupDetailDescription(link);
      await new Promise((r) => setTimeout(r, 250));
      if (!hasPublishableJobupDetail(detailDescription)) {
        console.log(`     ⚠ detail content rejected for ${link}: missing or thin source description`);
        return [];
      }
      detailHits++;

      const description = detailDescription;

      const sourceLang = detectLang(description || title, defaultSourceLang);
      const jobSlug = slugify(`${title} ${companyKey} ${location}`);
      const urlHash = createHash('sha1').update(link).digest('hex').slice(0, 12);
      const postedDate = parseJobupDate(raw?.puddate || '') || todayIso;

      jobs.push({
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
        // Newly-discovered jobs ship with source-locale-only fields. The shared
        // AI-localization step clears this flag when it fills the remaining 3
        // locales; if it can't (cache miss + AI quota), the flag stays and
        // `translate-pending.yml` picks the job up out-of-band. Without this
        // flag the locale-completeness gate trips before translation can run.
        needsRetranslation: true,
        location,
        canton,
        url: link,
        source: `${companyName} Dedicated Parser (jobup.ch feed ${jobupKey})`,
        sourceLang,
        crawledAt: new Date().toISOString(),

        addressLocality: location,
        addressRegion: canton,
        addressCountry: 'CH',
        country: 'CH',
        postalCode,
        category: detectCategoryFromRef(raw?.ref || '', title),
        contract: /permanent/i.test(raw?.contrat || '') ? 'full-time'
          : /temporaire|cdd|fixed/i.test(raw?.contrat || '') ? 'temporary'
          : 'full-time',
        employmentType: detectEmploymentTypeFromOccupation(raw?.occupationmin, raw?.occupationmax),
        experienceLevel: detectExperienceLevel(title, raw?.contrat || ''),
        sector: 'Sanità / Ospedali',
        currency: 'CHF',
        featured: false,
        postedDate,
        applyUrl: link,
        requirements: [],
        requirementsByLocale: { [sourceLang]: [] },
      });
    }

    console.log(`\n📋 Total ${companyName} jobs discovered: ${jobs.length} (${detailHits}/${items.length} with rich detail content)`);
    return jobs;
  }

  return { fetchAllJobs, isCompanyJob, isTrustedDomain };
}

export { decodeEntities };
