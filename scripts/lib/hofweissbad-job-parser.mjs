#!/usr/bin/env node
/**
 * Resort Hof Weissbad job parser — Ostendis ATS via Vercel-hosted Next.js
 * landing page.
 *
 * Source:
 *   - Listing index: https://www.hofweissbad.ch/jobs   (Next.js, Vercel)
 *   - Detail pages:  https://link.ostendis.com/publication/{slug}/{token}
 *
 * STATUS (2026-05-20):
 *   The /jobs page sits behind a Vercel security checkpoint that 429s any
 *   plain HTTP client. Playwright with a realistic Chrome UA satisfies the
 *   challenge transparently. The listing page server-renders an anchor per
 *   open position pointing at `link.ostendis.com/publication/...`. Each
 *   Ostendis detail page is HTML with a single `application/ld+json`
 *   `JobPosting` block — we read title + description from JSON-LD when
 *   available and fall back to a DOM scrape otherwise.
 *
 * Hof Weissbad is a 4*+ resort + Gesundheitszentrum in Weissbad/Appenzell
 * Innerrhoden (AI). All jobs are Swiss; no further geographic filter needed.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllHofweissbadJobs()  — Fetch and parse all jobs
 *   - isHofweissbadJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()          — Validate URLs belong to this company
 *   - slugify() / stripHtml()    — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import {
  createBrowser,
  createPoliteContext,
  closeAll,
  AntiBotBlockError,
  NavigationTimeout,
} from './ats-clients/playwright-runtime.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const HOFWEISSBAD_KEY = 'hofweissbad';
export const HOFWEISSBAD_COMPANY_NAME = 'Resort Hof Weissbad';
export const HOFWEISSBAD_COMPANY_DOMAIN = 'hofweissbad.ch';

const CAREER_URL = 'https://www.hofweissbad.ch/jobs';
const REALISTIC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const DEFAULT_CITY = 'Weissbad';
const DEFAULT_CANTON = 'AI';
const DEFAULT_POSTAL = '9057';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

export function isHofweissbadJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === HOFWEISSBAD_KEY ||
    /^hofweissbad(-|$)/.test(key) ||
    /^resort-?hof-?weissbad/.test(key) ||
    company.includes('hof weissbad') ||
    company.includes('hofweissbad') ||
    url.includes('hofweissbad.ch') ||
    /ostendis\.com\/publication\//.test(url)
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'hofweissbad.ch' || host.endsWith('.hofweissbad.ch')) return true;
    // Ostendis hosts the canonical apply pages — first-party for our trust model
    // because the listing page on hofweissbad.ch links directly there.
    if (host === 'link.ostendis.com' || host === 'odm.ostendis.com') return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(koch|k[oö]chin|chef.?de.?partie|patissier|cuisine|kitchen|sous.?chef|kuchen)/.test(t)) return 'Ristorazione';
  if (/\b(service|sommelier|barkeeper|barista|restaurant|kellner|maitre)/.test(t)) return 'Ristorazione';
  if (/\b(rezeption|reception|portier|concierge)/.test(t)) return 'Servizi alla persona';
  if (/\b(etage|housekeep|reinigung|lingerie|wäscherei|laundry|hauswirtschaft)/.test(t)) return 'Servizi';
  if (/\b(spa|wellness|massage|masseur|therapeut|kosmetik|beauty)/.test(t)) return 'Salute / Benessere';
  if (/\b(pflege|fage|fagh|fa-?gesundheit|gesundheits|pfleger|nurse|krankenschwester|krankenpfleger|fachfrau|fachmann|efz|efa)/.test(t)) return 'Sanità';
  if (/\b(arzt|aerztin|ärztin|medizin|physiotherap|ergotherap)/.test(t)) return 'Sanità';
  if (/\b(verwalt|admin|sekretär|empfang|bookkeep|buchhalt|hr|personal)/.test(t)) return 'Amministrazione';
  if (/\b(it|edv|netzwerk|system|software)/.test(t)) return 'IT';
  if (/\b(markt|sales|verkauf|reservierung|reservation)/.test(t)) return 'Commerciale';
  if (/\b(techni|haustech|handwerk|gärtner|gardener|garden)/.test(t)) return 'Tecnica';
  if (/\b(lehrling|lernend|apprenti|praktik|intern)/.test(t)) return 'Formazione';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(lehrling|lernend|apprenti|praktik|intern|trainee|aushilfe)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|chef|leiter|leitend|head|director|responsab|sous.?chef|demi.?chef)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  // Look for percentage hints in the title (e.g. "60%", "100%", "40 - 90 %")
  const pctMatch = t.match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const pct = Number(pctMatch[1]);
    if (pct >= 90) return 'FULL_TIME';
    if (pct > 0) return 'PART_TIME';
  }
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  if (/\b(praktik|intern|stage|lehrling|lernend|apprenti)/.test(t)) return 'INTERN';
  if (/\b(aushilfe|temporary|tempor|befristet|fixed.?term)/.test(t)) return 'CONTRACTOR';
  return 'OTHER';
}

/* ── Playwright fetcher ─────────────────────────────────────── */

/**
 * Load the listing page and harvest every `link.ostendis.com/publication/*`
 * anchor along with its rendered title (the heading inside the card).
 *
 * @param {import('playwright').BrowserContext} context
 * @returns {Promise<Array<{title: string, url: string}>>}
 */
async function discoverHofweissbadListings(context) {
  const page = await context.newPage();
  try {
    const resp = await page.goto(CAREER_URL, { waitUntil: 'domcontentloaded' });
    const status = resp ? resp.status() : 0;
    if (status === 429 || status === 403 || status === 522) {
      throw new AntiBotBlockError(
        `Vercel anti-bot block on ${CAREER_URL} (status=${status})`,
        { url: CAREER_URL, status },
      );
    }
    // Vercel challenge runs JS and re-issues the request; give it time to
    // settle before scraping anchors.
    try {
      await page.waitForLoadState('networkidle', { timeout: 30_000 });
    } catch {
      /* swallow — we'll inspect what's there */
    }

    const tiles = await page.evaluate(() => {
      const out = [];
      const anchors = document.querySelectorAll('a[href*="link.ostendis.com/publication/"]');
      for (const a of anchors) {
        // Walk up to a card-like container that holds the title heading.
        let card = a;
        for (let i = 0; i < 5; i += 1) {
          if (!card.parentElement) break;
          card = card.parentElement;
          if (card.querySelector('h1, h2, h3, h4')) break;
        }
        const headingEl = card.querySelector('h1, h2, h3, h4');
        const title =
          (headingEl?.textContent || '').trim() ||
          (a.textContent || '').trim() ||
          '';
        out.push({ title, url: a.href });
      }
      return out;
    });

    // Deduplicate by URL (without query string).
    const seen = new Set();
    const unique = [];
    for (const t of tiles) {
      if (!t.url || !t.title) continue;
      let key;
      try {
        const u = new URL(t.url);
        key = `${u.origin}${u.pathname}`;
      } catch {
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push({ title: t.title, url: t.url });
    }
    return unique;
  } finally {
    try { await page.close(); } catch { /* no-op */ }
  }
}

/**
 * Fetch one Ostendis detail page and extract description from JSON-LD or DOM.
 * @param {import('playwright').BrowserContext} context
 * @param {string} url
 * @returns {Promise<{title: string, descriptionHtml: string, postedAt: string|null}>}
 */
async function fetchHofweissbadDetail(context, url) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    try { await page.waitForLoadState('networkidle', { timeout: 20_000 }); } catch { /* no-op */ }

    const jsonLdRaw = await page.$$eval('script[type="application/ld+json"]', (els) =>
      els.map((e) => e.textContent || ''),
    );
    let title = '';
    let descriptionHtml = '';
    let postedAt = null;

    for (const raw of jsonLdRaw) {
      try {
        const parsed = JSON.parse(raw);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        for (const node of arr) {
          if (!node || typeof node !== 'object') continue;
          if (node['@type'] === 'JobPosting' || (Array.isArray(node['@type']) && node['@type'].includes('JobPosting'))) {
            title = title || String(node.title || '').trim();
            descriptionHtml = descriptionHtml || String(node.description || '');
            postedAt = postedAt || node.datePosted || node.validThrough || null;
          }
        }
      } catch {
        /* malformed JSON-LD — ignore */
      }
    }

    if (!title) {
      title = await page.title();
    }
    if (!descriptionHtml) {
      descriptionHtml = await page.evaluate(() => {
        const main = document.querySelector('main, article, [role="main"], body');
        return (main?.innerHTML || '').slice(0, 30_000);
      });
    }
    return { title: normalizeSpace(title), descriptionHtml, postedAt };
  } finally {
    try { await page.close(); } catch { /* no-op */ }
  }
}

/* ── ParsedJob builder ─────────────────────────────────────── */

function buildParsedJob({ title, descriptionHtml, postedAt, publicUrl }) {
  const cleanTitle = normalizeSpace(title || '');
  if (!cleanTitle || cleanTitle.length < 3) return null;

  const descriptionText = stripHtml(descriptionHtml);
  const sourceLang = detectLang(descriptionText || cleanTitle, 'de');
  const jobSlug = slugify(`${cleanTitle} hof weissbad ${DEFAULT_CITY}`);
  const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

  const fallbackDesc =
    `${cleanTitle} — Stelle im Resort Hof Weissbad in ${DEFAULT_CITY} (AI), Schweiz. ` +
    `Das 4-Sterne-Plus Resort Hof Weissbad ist ein innovatives Hotel- und Gesundheitszentrum mit rund 270 Mitarbeitenden im Appenzellerland.`;
  const desc = descriptionText.length >= 80 ? descriptionText : fallbackDesc;

  const postedDate = (() => {
    if (!postedAt) return new Date().toISOString().slice(0, 10);
    const d = new Date(postedAt);
    if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
    return d.toISOString().slice(0, 10);
  })();

  return {
    id: `hofweissbad-${urlHash}`,
    slug: jobSlug,
    slugByLocale: { [sourceLang]: jobSlug },
    company: HOFWEISSBAD_COMPANY_NAME,
    companyKey: HOFWEISSBAD_KEY,
    companyDomain: HOFWEISSBAD_COMPANY_DOMAIN,
    title: cleanTitle,
    titleByLocale: { [sourceLang]: cleanTitle },
    description: desc,
    descriptionByLocale: { [sourceLang]: desc },
    location: DEFAULT_CITY,
    canton: DEFAULT_CANTON,
    url: publicUrl,
    source: 'Hof Weissbad Dedicated Parser (Ostendis via Playwright)',
    sourceLang,
    crawledAt: new Date().toISOString(),
    addressLocality: DEFAULT_CITY,
    addressRegion: DEFAULT_CANTON,
    addressCountry: 'CH',
    country: 'CH',
    postalCode: DEFAULT_POSTAL,
    category: detectCategory(cleanTitle),
    contract: detectEmploymentType(cleanTitle) === 'PART_TIME' ? 'part-time' : 'full-time',
    employmentType: detectEmploymentType(cleanTitle),
    experienceLevel: detectExperienceLevel(cleanTitle),
    sector: 'Hôtellerie / Sanità',
    currency: 'CHF',
    featured: false,
    postedDate,
    applyUrl: publicUrl,
    requirements: [],
    requirementsByLocale: { [sourceLang]: [] },
    needsRetranslation: true,
  };
}

/* ── Main fetcher ──────────────────────────────────────────── */

/**
 * Fetch all Hof Weissbad jobs.
 *
 * Pipeline:
 *   1. Launch Playwright with a realistic Chrome UA (the Vercel checkpoint
 *      rejects bot-flagged UAs).
 *   2. Render https://www.hofweissbad.ch/jobs and harvest every
 *      `link.ostendis.com/publication/{slug}/{token}` anchor + heading.
 *   3. For each detail URL, parse the JSON-LD `JobPosting` (preferred) or
 *      fall back to the rendered DOM for the description.
 *   4. Build ParsedJob per result (canton AI, city Weissbad).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled by the
 * AI localization step and translate-pending pipeline.
 */
export async function fetchAllHofweissbadJobs() {
  console.log(`🔍 Fetching Hof Weissbad jobs (Ostendis via Playwright)`);
  console.log(`   Source: ${CAREER_URL}\n`);

  let browser;
  try {
    browser = await createBrowser({ userAgent: REALISTIC_UA });
    const context = await createPoliteContext(browser, { userAgent: REALISTIC_UA });

    let listings = [];
    try {
      listings = await discoverHofweissbadListings(context);
    } catch (err) {
      if (err instanceof AntiBotBlockError) {
        console.warn(`⚠️ Vercel anti-bot block: ${err.message}`);
        return [];
      }
      if (err instanceof NavigationTimeout) {
        console.warn(`⚠️ Hof Weissbad listing navigation timeout: ${err.message}`);
        return [];
      }
      throw err;
    }

    console.log(`   Discovered ${listings.length} listing tiles`);
    if (listings.length === 0) {
      console.warn(`⚠️ Hof Weissbad listing yielded 0 jobs.`);
      return [];
    }

    const jobs = [];
    for (const listing of listings) {
      try {
        const detail = await fetchHofweissbadDetail(context, listing.url);
        const detailTitle = detail.title || '';
        const isExpired =
          /publikation nicht vorhanden|nicht mehr verfügbar|no longer available|vom auftraggeber/i
            .test(detail.descriptionHtml || '') ||
          /^publikation$/i.test(detailTitle.trim());
        if (isExpired) {
          console.warn(`   Skipping expired publication: ${listing.url}`);
          continue;
        }
        const job = buildParsedJob({
          title: detail.title || listing.title,
          descriptionHtml: detail.descriptionHtml,
          postedAt: detail.postedAt,
          publicUrl: listing.url,
        });
        if (job) jobs.push(job);
      } catch (err) {
        console.warn(`⚠️ Skipping ${listing.url}: ${err?.message || err}`);
      }
    }

    console.log(`\n📋 Total Hof Weissbad jobs discovered: ${jobs.length}`);
    return jobs;
  } finally {
    await closeAll(browser);
  }
}
