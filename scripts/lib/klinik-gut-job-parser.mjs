#!/usr/bin/env node
/**
 * Klinik Gut AG (Gruppe) — orthopaedic / accident private clinic group in
 * Graubünden + Ascona. HQ in St. Moritz (postal 7500).
 *
 * Public career site (Drupal 11 — RZ theme), German source:
 *   https://www.klinik-gut.ch/de/jobs-karriere   ← landing (HTTP 200)
 *
 * WAF / access note (2026-06, #1872):
 *   The previous source `…/de/offene-stellen` now returns a Drupal
 *   application-level **HTTP 403 "Zugriff verweigert"** to EVERY client —
 *   curl (Chrome UA), Jina clean-IP, AND a real headless Chromium all get the
 *   same 403 (the page renders the site chrome but the body says "Sie haben
 *   keine Zugriffsberechtigung für diese Seite"). It is NOT a TLS/JS
 *   fingerprint WAF — the rest of the site (homepage, every job detail page)
 *   serves 200 to a normal browser. The aggregator node was simply restricted.
 *
 *   The real, public openings are listed on `…/de/jobs-karriere`, which is
 *   linked from the main nav ("Jobs & Karriere") and serves 200. That page
 *   renders the openings as Drupal "infobox" cards:
 *
 *     <li class="rz-infobox__item">
 *       <section class="rz-infobox__content">
 *         <h3>{title}</h3>
 *         <div class="infobox__text">…teaser…</div>
 *         <a class="infobox__more …" href="…/de/{slug}">Mehr Informationen</a>
 *       </section>
 *     </li>
 *
 *   Each card links to a dedicated detail page (`…/de/{slug}`, HTTP 200) whose
 *   `<article class="node node--type-page"><div class="node__content">` holds
 *   the full posting body. The `{slug}` is a stable Drupal path alias — perfect
 *   canonical job id (survives re-crawls).
 *
 * Rendering: the listing + detail HTML is fetched via a real Playwright
 * Chromium session (the `update-alten-jobs.mjs` pattern) because plain
 * `fetch()`/Jina trip the same access layer. The parsers below operate on
 * `page.content()` HTML, so they stay transport-agnostic.
 *
 * Group sites: Klinik St. Moritz (7500), Klinik Fläsch (7306), Praxis Chur /
 * Buchs SG / Zürich / Ascona. Default location = St. Moritz (HQ, GR).
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import { launchChromium } from './ensure-chromium.mjs';
import {
  decodeEntities,
  normalizeSpace,
  htmlToText,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const KLINIK_GUT_KEY = 'klinik-gut';
export const KLINIK_GUT_COMPANY_NAME = 'Klinik Gut AG';
export const KLINIK_GUT_COMPANY_DOMAIN = 'klinik-gut.ch';

// Public careers landing (HTTP 200). The legacy `…/de/offene-stellen`
// aggregator is now access-denied (HTTP 403) and must NOT be used as a source.
export const PUBLIC_CAREER_URL = 'https://www.klinik-gut.ch/de/jobs-karriere';
const ORIGIN = 'https://www.klinik-gut.ch';
// The restricted aggregator link still appears as a "Mehr Informationen" CTA
// inside the infobox list — it is a meta-link, never a real opening. Drop it.
const RESTRICTED_PATHS = new Set(['/de/offene-stellen', '/de/offene-stellen/']);

const REALISTIC_UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const STANDORT_PROFILE = {
  'st. moritz': { city: 'St. Moritz', canton: 'GR', postal: '7500' },
  'st moritz':  { city: 'St. Moritz', canton: 'GR', postal: '7500' },
  'flaesch':    { city: 'Fläsch',     canton: 'GR', postal: '7306' },
  'fläsch':     { city: 'Fläsch',     canton: 'GR', postal: '7306' },
  'chur':       { city: 'Chur',       canton: 'GR', postal: '7000' },
  'buchs':      { city: 'Buchs SG',   canton: 'SG', postal: '9470' },
  'zürich':     { city: 'Zürich',     canton: 'ZH', postal: '8001' },
  'zuerich':    { city: 'Zürich',     canton: 'ZH', postal: '8001' },
  'ascona':     { city: 'Ascona',     canton: 'TI', postal: '6612' },
};

const DEFAULT_LOCATION = { city: 'St. Moritz', canton: 'GR', postal: '7500' };

/* ── Company matchers ──────────────────────────────────────── */

export function isKlinikGutJob(job) {
  const key = String(job?.companyKey || '').toLowerCase();
  const company = String(job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  return (
    key === KLINIK_GUT_KEY ||
    key.startsWith('klinik-gut') ||
    company.includes('klinik gut') ||
    url.includes('klinik-gut.ch')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'klinik-gut.ch' || host.endsWith('.klinik-gut.ch');
  } catch {
    return false;
  }
}

/* ── Helpers ───────────────────────────────────────────────── */

/**
 * Resolve a group-site profile from card text, but ONLY when exactly one site
 * is named — a card mentioning both St. Moritz AND Fläsch (the common case)
 * stays on the HQ default rather than picking an arbitrary one.
 */
function resolveCardLocation(text) {
  const lc = String(text || '').toLowerCase();
  const cities = new Set();
  let firstHit = null;
  for (const key of Object.keys(STANDORT_PROFILE)) {
    if (lc.includes(key)) {
      cities.add(STANDORT_PROFILE[key].city);
      if (!firstHit) firstHit = STANDORT_PROFILE[key];
    }
  }
  return cities.size === 1 ? firstHit : null;
}

/** Stable slug for a detail URL (last non-empty path segment of `/de/{slug}`). */
function pathSlug(href = '') {
  try {
    const u = new URL(href, ORIGIN);
    const parts = u.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
  } catch {
    return '';
  }
}

/* ── Parser: listing (infobox cards) ───────────────────────── */

/**
 * Parse the `…/de/jobs-karriere` landing into a list of opening cards. Each
 * `<li class="rz-infobox__item">` yields `{ id, title, teaser, detailUrl }`.
 * The restricted `…/de/offene-stellen` CTA card is filtered out (it is a
 * meta-link to the access-denied aggregator, not a real opening).
 */
export function parseKlinikGutListing(html = '') {
  if (!html || typeof html !== 'string') return [];

  const out = [];
  const seen = new Set();

  // Match the `rz-infobox__item` class token with a word boundary rather than a
  // quote-strict `class="rz-infobox__item"`, so a Drupal-appended state/modifier
  // class (e.g. `rz-infobox__item rz-infobox__item--featured`) doesn't silently
  // drop every listing row.
  const itemRe = /<li[^>]*\brz-infobox__item\b[^>]*>([\s\S]*?)<\/li>/g;
  let im;
  while ((im = itemRe.exec(html)) !== null) {
    const block = im[1];

    const title = normalizeSpace(
      decodeEntities((block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)?.[1] || '').replace(/<[^>]+>/g, '')),
    );
    if (!title || title.length < 3) continue;

    const hrefMatch =
      block.match(/<a[^>]*class="[^"]*infobox__more[^"]*"[^>]*href="([^"]+)"/i) ||
      block.match(/<a[^>]*href="([^"]+)"[^>]*class="[^"]*infobox__more/i);
    const rawHref = hrefMatch?.[1] || '';
    if (!rawHref) continue;

    const detailUrl = new URL(rawHref, ORIGIN).toString();
    if (RESTRICTED_PATHS.has(new URL(detailUrl).pathname)) continue;
    // Skip cards linking off the klinik-gut.ch domain — e.g. the "Social Media"
    // / "Folgen Sie uns" card whose `infobox__more` href is the Instagram profile
    // (https://www.instagram.com/klinikgut/). Those are not job openings; left in,
    // they'd be crawled as a job with an off-domain URL and fail strict
    // localization validation (url_not_klinik-gut_domain + untranslated teaser,
    // since the social detail fetch 429s), failing the whole crawl. #2680
    if (!isTrustedDomain(detailUrl)) continue;

    const id = pathSlug(detailUrl);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const teaser = normalizeSpace(
      decodeEntities(
        (block.match(/<div class="infobox__text">([\s\S]*?)<\/div>\s*<a/i)?.[1] || '').replace(/<[^>]+>/g, ' '),
      ),
    );

    // Upgrade the HQ default only when the card text unambiguously names ONE
    // group site (most cards span both GR hospitals → keep St. Moritz default).
    const location = resolveCardLocation(`${title} ${teaser}`) || DEFAULT_LOCATION;

    out.push({ id, title, teaser, detailUrl, location });
  }

  return out;
}

/* ── Parser: detail page body ──────────────────────────────── */

/**
 * Extract the clean posting body from a detail page. The posting lives in
 * `<article class="node node--type-page …"><div class="node__content …">`.
 * That content region also nests a `node--type-team-member` contact teaser
 * ("Zuständige Personen") at the bottom — we cut the body at that boilerplate
 * marker. Falls back to the full document text if the container can't be found.
 *
 * Note: we deliberately do NOT geo-resolve the city from the detail HTML — the
 * site footer lists every Standort, so any per-page match is noise. These
 * openings span both GR hospital sites; the listing-card location is used.
 */
export function parseKlinikGutDetail(html = '') {
  if (!html || typeof html !== 'string') return { body: '' };

  const articleMatch = html.match(
    /<article[^>]*class="node node--type-page[^"]*"[^>]*>([\s\S]*?)<\/article>/i,
  );
  let region = articleMatch?.[1] || '';
  const contentMatch = region.match(/<div class="node__content[^"]*">([\s\S]*)$/i);
  if (contentMatch) region = contentMatch[1];

  let body = htmlToText(region || html);
  if (normalizeSpace(body).length < 30) body = htmlToText(html);

  // Trim the trailing contact card ("Zuständige Personen …") if it leaked in.
  const contactIdx = body.search(/Zuständige Personen/i);
  if (contactIdx > 80) body = body.slice(0, contactIdx).trimEnd();

  return { body: body.trim() };
}

/* ── Description fallback ──────────────────────────────────── */

function buildFallbackDescription(title, cityName) {
  return [
    `${title} bei der Klinik Gut AG am Standort ${cityName}.`,
    '',
    'Die Klinik Gut ist eine etablierte private Klinik-Gruppe für Orthopädie, Unfallchirurgie und Sportmedizin mit Hauptstandorten in St. Moritz und Fläsch (Graubünden) sowie Praxisstandorten in Chur, Buchs SG, Zürich und Ascona. Sie betreut nationale und internationale Patientinnen und Patienten und legt Wert auf ein engagiertes Team und individuelle Versorgung.',
  ].join('\n');
}

/* ── Browser session (Playwright — alten pattern) ──────────── */

const ACCESS_DENIED_RE = /Zugriff verweigert|keine Zugriffsberechtigung/i;
const TRANSIENT_RE =
  /net::ERR_|TimeoutError|timeout|Target closed|Navigation failed|browserType|Executable doesn'?t exist|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i;

async function withBrowser(fn) {
  const browser = await launchChromium({ headless: process.env.JOBS_KLINIK_GUT_HEADLESS !== '0' });
  const context = await browser.newContext({
    userAgent: REALISTIC_UA,
    viewport: { width: 1440, height: 1200 },
    locale: 'de-CH',
    extraHTTPHeaders: { 'Accept-Language': 'de-CH,de;q=0.9,en;q=0.8' },
  });
  const page = await context.newPage();
  try {
    return await fn(page);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/** Fetch one page's rendered HTML; throws on a 403/access-denied or non-200. */
async function renderHtml(page, url, timeoutMs) {
  let observedStatus = null;
  const onResp = (r) => {
    if (r.url() === url || r.url() === `${url}/`) observedStatus = r.status();
  };
  page.on('response', onResp);
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForTimeout(800);
    const status = resp?.status() ?? observedStatus;
    const html = await page.content();
    if ((status && status >= 400) || ACCESS_DENIED_RE.test(html)) {
      const err = new Error(`HTTP ${status || '???'} / access-denied for ${url}`);
      err.accessDenied = true;
      throw err;
    }
    return html;
  } finally {
    page.off('response', onResp);
  }
}

/* ── Main fetch ────────────────────────────────────────────── */

export async function fetchAllKlinikGutJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 45000;

  console.log(`🏥 Fetching ${KLINIK_GUT_COMPANY_NAME} jobs`);
  console.log(`   Source: ${PUBLIC_CAREER_URL} (Drupal 11 — DE source, Playwright render)\n`);

  try {
    return await withBrowser(async (page) => {
      const listingHtml = await renderHtml(page, PUBLIC_CAREER_URL, timeoutMs);
      const listings = parseKlinikGutListing(listingHtml);
      console.log(`  📋 Found ${listings.length} opening cards\n`);
      if (listings.length === 0) {
        // A 200 page with zero cards is a real "no current openings" state OR a
        // markup change — surface it but don't crash the whole pipeline.
        console.warn('⚠️ No vacancies parsed from Klinik Gut careers page.');
        return [];
      }

      const todayIso = new Date().toISOString().slice(0, 10);
      const jobs = [];

      for (const listing of listings) {
        const title = listing.title;
        const loc = listing.location || DEFAULT_LOCATION;

        // Fetch the detail page for the full posting body.
        let detail = { body: '' };
        try {
          const detailHtml = await renderHtml(page, listing.detailUrl, timeoutMs);
          detail = parseKlinikGutDetail(detailHtml);
        } catch (err) {
          console.warn(`  ⚠️  Detail fetch failed for ${listing.detailUrl}: ${err.message} — using teaser`);
        }

        const bestBody = (detail.body && detail.body.split(/\s+/).length >= 40)
          ? detail.body
          : (listing.teaser || '');

        let description = bestBody && bestBody.split(/\s+/).length >= 40
          ? bestBody
          : buildFallbackDescription(title, loc.city);
        if (description.split(/\s+/).length < 80) {
          description = `${description}\n\n${buildFallbackDescription(title, loc.city)}`;
        }

        const haystack = `${title} ${description}`;
        const sourceLang = detectLang(description || title, 'de');
        const jobSlug = slugify(`${title} ${KLINIK_GUT_KEY} ${loc.city}`);
        const url = listing.detailUrl;
        const urlHash = createHash('sha1')
          .update(`${url}|${listing.id}`)
          .digest('hex')
          .slice(0, 12);
        const employmentType = detectHealthcareEmploymentType(haystack);

        jobs.push({
          id: `${KLINIK_GUT_KEY}-${listing.id}-${urlHash}`,
          slug: jobSlug,
          slugByLocale: { [sourceLang]: jobSlug },
          company: KLINIK_GUT_COMPANY_NAME,
          companyKey: KLINIK_GUT_KEY,
          companyDomain: KLINIK_GUT_COMPANY_DOMAIN,
          title,
          titleByLocale: { [sourceLang]: title },
          description,
          descriptionByLocale: { [sourceLang]: description },
          needsRetranslation: true,
          location: loc.city,
          canton: inferSwissTargetCanton(loc.city) || loc.canton,
          url,
          source: 'Klinik Gut Dedicated Parser (Drupal infobox, Playwright)',
          sourceLang,
          crawledAt: new Date().toISOString(),

          addressLocality: loc.city,
          addressRegion: loc.canton,
          addressCountry: 'CH',
          country: 'CH',
          postalCode: loc.postal,
          category: detectHealthcareCategory(haystack),
          contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
          employmentType,
          experienceLevel: detectHealthcareExperienceLevel(haystack),
          sector: 'Sanità / Ospedali',
          currency: 'CHF',
          featured: false,
          postedDate: todayIso,
          applyUrl: url,
          requirements: [],
          requirementsByLocale: { [sourceLang]: [] },
        });

        console.log(`  ✅ ${title.substring(0, 65)} → ${loc.city} (${listing.id})`);
      }

      console.log(`\n📋 Total ${KLINIK_GUT_COMPANY_NAME} jobs discovered: ${jobs.length}`);
      return jobs;
    });
  } catch (err) {
    const msg = err?.message || String(err);
    // Access-denied on the landing page OR a connectivity/challenge error is a
    // transient unavailability: return [] so the shared pipeline preserves the
    // existing Klinik Gut entries rather than wiping them on a bad run.
    if (err?.accessDenied || TRANSIENT_RE.test(msg)) {
      console.warn(`⚠️  Klinik Gut careers unavailable: ${msg}`);
      console.log('ℹ️  Keeping existing data — no updates this run.');
      return [];
    }
    throw new Error(`Failed to fetch Klinik Gut career page: ${msg}`);
  }
}
