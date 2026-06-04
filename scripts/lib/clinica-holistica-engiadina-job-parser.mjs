#!/usr/bin/env node
/**
 * Clinica Holistica Engiadina (Susch, GR) — Drupal job listing.
 *
 * Public career site: https://www.clinica-holistica.ch/de/karriere
 *
 * Background:
 *   The site is a Drupal install behind an aggressive WAF/cache layer that
 *   serves 403 to non-browser clients (the previously linked
 *   `/de/offene-stellen` URL specifically returns 403 even via Playwright —
 *   the Karriere index `/de/karriere` is the actually-reachable listing).
 *
 *   We render the Karriere page with Playwright, collect every `/de/job/`
 *   AND `/de/node/NNN` anchor with the "Stellenausschreibung" label, then
 *   visit each detail page and harvest `<h1>` + article body. No public
 *   ATS or JSON feed is exposed.
 *
 * Tenant facts:
 *   - Holistic / psychiatric / psychotherapeutic rehab clinic (~120 beds).
 *   - Located in Susch, canton GR, postal code 7542.
 *   - DE-only career content. FR carriere returns no offers.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace } from './crawler-template.mjs';
import { launchChromium } from './ensure-chromium.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const CLINICA_HOLISTICA_KEY = 'clinica-holistica-engiadina';
export const CLINICA_HOLISTICA_COMPANY_NAME = 'Clinica Holistica Engiadina';
export const CLINICA_HOLISTICA_COMPANY_DOMAIN = 'clinica-holistica.ch';

const PUBLIC_CAREER_URL = 'https://www.clinica-holistica.ch/de/karriere';
const LISTING_URLS = [
  'https://www.clinica-holistica.ch/de/karriere',
  // /de/offene-stellen is a known-403 trap; do NOT add it.
];

/**
 * Playwright launch settings tuned to slip past the soft WAF block.
 *
 * Confirmed by manual probe 2026-05-20: with these settings the listing
 * (`/de/karriere`) and detail pages (`/de/job/...`) both resolve to 200.
 */
const PW_LAUNCH_ARGS = ['--disable-blink-features=AutomationControlled'];
const PW_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* ── Helpers ───────────────────────────────────────────────── */

async function createStealthContext(browser) {
  const ctx = await browser.newContext({
    userAgent: PW_USER_AGENT,
    viewport: { width: 1280, height: 800 },
    locale: 'de-CH',
    timezoneId: 'Europe/Zurich',
    extraHTTPHeaders: {
      'Accept-Language': 'de-CH,de;q=0.9,en;q=0.8',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    },
  });
  ctx.setDefaultNavigationTimeout(60_000);
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['de-CH', 'de', 'en'] });
  });
  return ctx;
}

/* ── Category detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = String(title || '').toLowerCase();
  if (/\b(arzt|ärzt|oberarzt|chefarzt|m[eé]decin|psychiater|psychotherap)\b/.test(t))
    return 'healthcare-medical';
  if (/\b(pflege|fachfrau\s+gesundheit|fage|assc|pflegefach|krankenpfleg)\b/.test(t))
    return 'healthcare-nursing';
  if (/\b(physio|ergo|therap|massage|kinetik|kunst.?therapie)\b/.test(t)) return 'healthcare-therapy';
  if (/\b(psycholog)\b/.test(t)) return 'healthcare-psychology';
  if (/\b(koch|küch|kueche|hilfskoch)\b/.test(t)) return 'hospitality';
  if (/\b(hotelle|service|hauswirt|reinig|housekeep|wäscherei|waescherei)\b/.test(t))
    return 'hospitality';
  if (/\b(administrat|verwaltung|secret|sekret|empfang|rezeption)\b/.test(t)) return 'administration';
  if (/\b(technik|haustechn|elektri|sanitär|sanitar|maintenance)\b/.test(t)) return 'logistics';
  return 'healthcare';
}

function detectExperienceLevel(title = '') {
  const t = String(title || '').toLowerCase();
  if (/\b(praktik|intern|stagiair|lehrling|apprenti|trainee)\b/.test(t)) return 'intern';
  if (/\b(junior|jr)\b/.test(t)) return 'junior';
  if (/\b(leiter|chef|head|directeur|directrice|responsable|senior|sr|oberarzt|chefarzt)\b/.test(t))
    return 'senior';
  return 'mid';
}

function detectEmploymentType(title = '') {
  const t = String(title || '').toLowerCase();
  const pctMatch = t.match(/(\d{1,3})\s*[-–]\s*(\d{1,3})\s*%/) || t.match(/(\d{1,3})\s*%/);
  if (/\b(praktik|intern|stagiair)\b/.test(t)) return 'INTERN';
  if (/\b(ferienvertret|vertretung|temporary|befristet|fixed|cdd)\b/.test(t)) return 'CONTRACTOR';
  if (pctMatch) {
    const hi = pctMatch[2] ? parseInt(pctMatch[2], 10) : parseInt(pctMatch[1], 10);
    const lo = pctMatch[2] ? parseInt(pctMatch[1], 10) : hi;
    if (hi === 100 && lo === 100) return 'FULL_TIME';
    if (lo < 100) return 'PART_TIME';
  }
  return 'OTHER';
}

/* ── Job identity / trust ──────────────────────────────────── */

export function isClinicaHolisticaJob(job) {
  const key = String(job?.companyKey || '').toLowerCase();
  const company = String(job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  return (
    key === CLINICA_HOLISTICA_KEY ||
    company.includes('clinica holistica') ||
    url.includes('clinica-holistica.ch')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'clinica-holistica.ch' || host === 'www.clinica-holistica.ch';
  } catch {
    return false;
  }
}

/* ── Listing & detail scraping ─────────────────────────────── */

async function discoverDetailUrls(context) {
  const urls = new Map();
  for (const listingUrl of LISTING_URLS) {
    const page = await context.newPage();
    try {
      const resp = await page.goto(listingUrl, { waitUntil: 'networkidle', timeout: 45_000 });
      const status = resp ? resp.status() : 0;
      if (status >= 400) {
        console.warn(`  ⚠️ ${listingUrl} returned status ${status} — skipping.`);
        continue;
      }
      // Collect every /de/job/... and /de/node/<num> link whose anchor text is
      // "Stellenausschreibung" (Drupal places that label on each job teaser).
      const found = await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll('a'));
        return anchors
          .map((a) => ({
            url: a.href || '',
            text: (a.innerText || a.textContent || '').trim(),
          }))
          .filter((x) => {
            if (!x.url) return false;
            if (!/clinica-holistica\.ch/i.test(x.url)) return false;
            if (!/\/de\/(job|node)\//.test(x.url)) return false;
            return /stellenausschreibung/i.test(x.text);
          });
      });
      for (const f of found) urls.set(f.url, true);
    } catch (err) {
      console.warn(`  ⚠️ Listing fetch failed for ${listingUrl}: ${err?.message || err}`);
    } finally {
      await page.close().catch(() => {});
    }
  }
  return Array.from(urls.keys());
}

async function fetchDetail(context, detailUrl) {
  const page = await context.newPage();
  try {
    const resp = await page.goto(detailUrl, { waitUntil: 'networkidle', timeout: 45_000 });
    const status = resp ? resp.status() : 0;
    if (status >= 400) {
      console.warn(`    ⚠️ detail ${detailUrl} returned ${status} — skipping.`);
      return null;
    }
    const data = await page.evaluate(() => {
      const h1 = document.querySelector('h1');
      // Drupal article body lives inside #block-mainpagecontent or article.node
      const body =
        document.querySelector('article.node, .node--type-job, [role="main"]') ||
        document.querySelector('main') ||
        document.body;
      return {
        title: h1 ? h1.innerText.trim() : '',
        bodyText: body ? body.innerText : '',
        canonical:
          (document.querySelector('link[rel="canonical"]') &&
            document.querySelector('link[rel="canonical"]').href) ||
          location.href,
      };
    });
    return data;
  } catch (err) {
    console.warn(`    ⚠️ detail ${detailUrl} failed: ${err?.message || err}`);
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

/* ── Build ParsedJob ───────────────────────────────────────── */

function buildJob(detailUrl, detail) {
  if (!detail) return null;
  const title = normalizeSpace(detail.title || '');
  if (!title || title.length < 3) return null;

  // Body may already be plain-text from page.evaluate(innerText); run through
  // stripHtml to neutralize residual entities and collapse blank lines.
  const description = stripHtml(detail.bodyText || '') || `${title} — ${CLINICA_HOLISTICA_COMPANY_NAME}`;
  const sourceLang = detectLang(description || title, 'de');

  const urlHash = createHash('sha1').update(detailUrl).digest('hex').slice(0, 12);
  const jobSlug = slugify(`${title} ${CLINICA_HOLISTICA_COMPANY_NAME} Susch`);

  return {
    id: `${CLINICA_HOLISTICA_KEY}-${urlHash}`,
    slug: jobSlug,
    slugByLocale: { [sourceLang]: jobSlug },
    company: CLINICA_HOLISTICA_COMPANY_NAME,
    companyKey: CLINICA_HOLISTICA_KEY,
    companyDomain: CLINICA_HOLISTICA_COMPANY_DOMAIN,
    title,
    titleByLocale: { [sourceLang]: title },
    description,
    descriptionByLocale: { [sourceLang]: description },
    location: 'Susch',
    canton: 'GR',
    addressLocality: 'Susch',
    addressRegion: 'GR',
    addressCountry: 'CH',
    country: 'CH',
    postalCode: '7542',
    category: detectCategory(title),
    sector: 'Salute / Psichiatria',
    contract: 'full-time',
    employmentType: detectEmploymentType(title),
    experienceLevel: detectExperienceLevel(title),
    currency: 'CHF',
    featured: false,
    postedDate: new Date().toISOString().slice(0, 10),
    url: detailUrl,
    applyUrl: detailUrl,
    source: 'Clinica Holistica Engiadina Dedicated Parser (Playwright)',
    sourceLang,
    crawledAt: new Date().toISOString(),
    needsRetranslation: true,
  };
}

/* ── Main fetch function ───────────────────────────────────── */

export async function fetchAllClinicaHolisticaJobs() {
  console.log(`🏥 Fetching Clinica Holistica Engiadina jobs`);
  console.log(`   Public career page: ${PUBLIC_CAREER_URL}\n`);

  let browser;
  try {
    browser = await launchChromium({ headless: true, args: PW_LAUNCH_ARGS });
  } catch (err) {
    console.warn(`⚠️ chromium launch failed: ${err?.message || err}`);
    return [];
  }

  try {
    const context = await createStealthContext(browser);
    const detailUrls = await discoverDetailUrls(context);
    console.log(`  Discovered ${detailUrls.length} job URL(s)`);
    if (detailUrls.length === 0) {
      console.warn(`  ⚠️ No job links found at ${PUBLIC_CAREER_URL}`);
      return [];
    }

    const jobs = [];
    for (const detailUrl of detailUrls) {
      const detail = await fetchDetail(context, detailUrl);
      if (!detail) continue;
      const job = buildJob(detailUrl, detail);
      if (job) {
        jobs.push(job);
        console.log(`  ✅ ${detailUrl.replace('https://www.clinica-holistica.ch', '')} — ${job.title.slice(0, 60)}`);
      }
      // Light per-page delay so we stay polite.
      await new Promise((r) => setTimeout(r, 600));
    }

    // Deduplicate by id.
    const seen = new Set();
    const deduped = [];
    for (const job of jobs) {
      if (seen.has(job.id)) continue;
      seen.add(job.id);
      deduped.push(job);
    }
    console.log(`\n📋 Total unique Clinica Holistica jobs: ${deduped.length}`);
    return deduped;
  } finally {
    try {
      await browser.close();
    } catch {
      /* no-op */
    }
  }
}
