#!/usr/bin/env node
/**
 * Salina Rehaklinik Rheinfelden (Reha Rheinfelden) — Ostendis ATS via the
 * `salina-reha.ch` career landing page.
 *
 * Source:
 *   - Listing:    https://www.salina-reha.ch/de/karriere/stellenangebot/
 *   - Detail:     https://link.ostendis.com/publication/{slug}/{token}
 *
 * The page renders two Ostendis publication places:
 *   - `pubPlace_parkresortRheinfelden_smag`  (SMAG hotel/spa side)
 *   - `pubPlace_rehaRheinfelden_salinaMedical` (Salina/Reha-Klinik side)
 * Both are scraped — they share the Rheinfelden (AG, 4310) postal area.
 *
 * Re-discovery note (2026-05-20): batch-21 originally probed
 * `salina-rehaklinik.ch` (NXDOMAIN). The clinic actually lives at
 * `salina-reha.ch` — confirmed from the user.
 *
 * Implementation follows the Hof Weissbad / Ostendis pattern: Playwright
 * renders the page (the Typo3 widget hydrates client-side), then we walk
 * every `link.ostendis.com/publication/*` anchor + heading, fetch each
 * Ostendis detail page, and parse the schema.org `JobPosting` JSON-LD.
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

export const SALINA_REHA_KEY = 'salina-reha';
export const SALINA_REHA_COMPANY_NAME = 'Salina Rehaklinik Rheinfelden';
export const SALINA_REHA_COMPANY_DOMAIN = 'salina-reha.ch';

const CAREER_URL = 'https://www.salina-reha.ch/de/karriere/stellenangebot/';
const REALISTIC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const DEFAULT_CITY = 'Rheinfelden';
const DEFAULT_CANTON = 'AG';
const DEFAULT_POSTAL = '4310';

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

export function isSalinaRehaJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SALINA_REHA_KEY ||
    /^salina(-|$)/.test(key) ||
    /^reha-?rheinfelden/.test(key) ||
    company.includes('salina') ||
    company.includes('reha rheinfelden') ||
    url.includes('salina-reha.ch') ||
    /ostendis\.com\/publication\//.test(url)
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'salina-reha.ch' || host.endsWith('.salina-reha.ch')) return true;
    if (host === 'link.ostendis.com' || host === 'odm.ostendis.com') return true;
    return false;
  } catch {
    return false;
  }
}

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(pflege|fage|fagh|fa-?gesundheit|gesundheits|pfleger|nurse|krankenschwester|krankenpfleger|fachfrau|fachmann|efz|efa)/.test(t)) return 'Sanità';
  if (/\b(arzt|aerztin|ärztin|medizin|physiotherap|ergotherap|psychotherap|facharzt)/.test(t)) return 'Sanità';
  if (/\b(therapeut|therapie|logoped)/.test(t)) return 'Sanità';
  if (/\b(spa|wellness|massage|masseur|kosmetik|beauty)/.test(t)) return 'Salute / Benessere';
  if (/\b(koch|k[oö]chin|chef.?de.?partie|cuisine|kitchen|sous.?chef)/.test(t)) return 'Ristorazione';
  if (/\b(service|sommelier|restaurant|kellner)/.test(t)) return 'Ristorazione';
  if (/\b(rezeption|reception|portier|empfang)/.test(t)) return 'Servizi alla persona';
  if (/\b(verwalt|admin|sekretär|bookkeep|buchhalt|hr|personal)/.test(t)) return 'Amministrazione';
  if (/\b(it|edv|netzwerk|system|software)/.test(t)) return 'IT';
  if (/\b(techni|haustech|handwerk)/.test(t)) return 'Tecnica';
  if (/\b(lehrling|lernend|apprenti|praktik|intern)/.test(t)) return 'Formazione';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(lehrling|lernend|apprenti|praktik|intern|trainee|aushilfe)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|chef|leiter|leitend|head|director|responsab)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  const pctMatch = t.match(/(\d{2,3})\s*[-–]\s*\d{2,3}\s*%/) || t.match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const pct = Number(pctMatch[1]);
    if (pct >= 90) return 'FULL_TIME';
    if (pct > 0) return 'PART_TIME';
  }
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  if (/\b(praktik|intern|stage|lehrling|lernend|apprenti)/.test(t)) return 'INTERN';
  if (/\b(stundenlohn|aushilfe|temporary|tempor|befristet)/.test(t)) return 'CONTRACTOR';
  return 'OTHER';
}

async function discoverSalinaListings(context) {
  const page = await context.newPage();
  try {
    const resp = await page.goto(CAREER_URL, { waitUntil: 'domcontentloaded' });
    const status = resp ? resp.status() : 0;
    if (status === 429 || status === 403 || status === 522) {
      throw new AntiBotBlockError(
        `Anti-bot block on ${CAREER_URL} (status=${status})`,
        { url: CAREER_URL, status },
      );
    }
    try {
      await page.waitForLoadState('networkidle', { timeout: 30_000 });
    } catch {
      /* swallow */
    }
    // Give the Ostendis loader extra time to render anchors.
    await page.waitForTimeout(2_000);

    const tiles = await page.evaluate(() => {
      const out = [];
      const anchors = document.querySelectorAll('a[href*="link.ostendis.com/publication/"]');
      for (const a of anchors) {
        let card = a;
        for (let i = 0; i < 6; i += 1) {
          if (!card.parentElement) break;
          card = card.parentElement;
          if (card.querySelector('h1, h2, h3, h4, .ost-job-title')) break;
        }
        const headingEl = card.querySelector('h1, h2, h3, h4, .ost-job-title');
        const title =
          (headingEl?.textContent || '').trim() ||
          (a.textContent || '').trim() ||
          '';
        out.push({ title, url: a.href });
      }
      return out;
    });

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

async function fetchSalinaDetail(context, url) {
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
    let city = '';

    for (const raw of jsonLdRaw) {
      try {
        const parsed = JSON.parse(raw);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        for (const node of arr) {
          if (!node || typeof node !== 'object') continue;
          const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
          if (types.includes('JobPosting')) {
            title = title || String(node.title || '').trim();
            descriptionHtml = descriptionHtml || String(node.description || '');
            postedAt = postedAt || node.datePosted || null;
            if (!city) {
              const addr = node.jobLocation?.address || node.jobLocation;
              if (addr?.addressLocality) city = String(addr.addressLocality);
            }
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
    return { title: normalizeSpace(title), descriptionHtml, postedAt, city };
  } finally {
    try { await page.close(); } catch { /* no-op */ }
  }
}

function buildParsedJob({ title, descriptionHtml, postedAt, publicUrl, city }) {
  const cleanTitle = normalizeSpace(title || '');
  if (!cleanTitle || cleanTitle.length < 3) return null;

  const descriptionText = stripHtml(descriptionHtml);
  const sourceLang = detectLang(descriptionText || cleanTitle, 'de');
  const resolvedCity = city && city.length >= 3 ? city : DEFAULT_CITY;
  const jobSlug = slugify(`${cleanTitle} salina rheinfelden`);
  const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

  const fallbackDesc =
    `${cleanTitle} — Stelle in der Salina Rehaklinik / Reha Rheinfelden in ${resolvedCity} (AG), Schweiz. ` +
    'Die Salina Rehaklinik ist ein Betrieb der Reha Rheinfelden — eines der führenden ' +
    'Rehabilitationszentren der Region mit Schwerpunkten in Neurologie, Pädiatrie und Orthopädie.';
  const desc = descriptionText.length >= 80 ? descriptionText : fallbackDesc;

  const postedDate = (() => {
    if (!postedAt) return new Date().toISOString().slice(0, 10);
    const d = new Date(postedAt);
    if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
    return d.toISOString().slice(0, 10);
  })();

  return {
    id: `salina-reha-${urlHash}`,
    slug: jobSlug,
    slugByLocale: { [sourceLang]: jobSlug },
    company: SALINA_REHA_COMPANY_NAME,
    companyKey: SALINA_REHA_KEY,
    companyDomain: SALINA_REHA_COMPANY_DOMAIN,
    title: cleanTitle,
    titleByLocale: { [sourceLang]: cleanTitle },
    description: desc,
    descriptionByLocale: { [sourceLang]: desc },
    location: resolvedCity,
    canton: DEFAULT_CANTON,
    url: publicUrl,
    source: 'Salina Rehaklinik Dedicated Parser (Ostendis via Playwright)',
    sourceLang,
    crawledAt: new Date().toISOString(),
    addressLocality: resolvedCity,
    addressRegion: DEFAULT_CANTON,
    addressCountry: 'CH',
    country: 'CH',
    postalCode: DEFAULT_POSTAL,
    category: detectCategory(cleanTitle),
    contract: detectEmploymentType(cleanTitle) === 'PART_TIME' ? 'part-time' : 'full-time',
    employmentType: detectEmploymentType(cleanTitle),
    experienceLevel: detectExperienceLevel(cleanTitle),
    sector: 'Sanità',
    currency: 'CHF',
    featured: false,
    postedDate,
    applyUrl: publicUrl,
    requirements: [],
    requirementsByLocale: { [sourceLang]: [] },
    needsRetranslation: true,
  };
}

export async function fetchAllSalinaRehaJobs() {
  console.log(`🔍 Fetching Salina Rehaklinik jobs (Ostendis via Playwright)`);
  console.log(`   Source: ${CAREER_URL}\n`);

  let browser;
  try {
    browser = await createBrowser({ userAgent: REALISTIC_UA });
    const context = await createPoliteContext(browser, { userAgent: REALISTIC_UA });

    let listings = [];
    try {
      listings = await discoverSalinaListings(context);
    } catch (err) {
      if (err instanceof AntiBotBlockError) {
        console.warn(`⚠️ Salina anti-bot block: ${err.message}`);
        return [];
      }
      if (err instanceof NavigationTimeout) {
        console.warn(`⚠️ Salina listing navigation timeout: ${err.message}`);
        return [];
      }
      throw err;
    }

    console.log(`   Discovered ${listings.length} listing tiles`);
    if (listings.length === 0) {
      console.warn(`⚠️ Salina listing yielded 0 jobs.`);
      return [];
    }

    const jobs = [];
    for (const listing of listings) {
      try {
        const detail = await fetchSalinaDetail(context, listing.url);
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
          city: detail.city,
        });
        if (job) jobs.push(job);
      } catch (err) {
        console.warn(`⚠️ Skipping ${listing.url}: ${err?.message || err}`);
      }
    }

    console.log(`\n📋 Total Salina Rehaklinik jobs discovered: ${jobs.length}`);
    return jobs;
  } finally {
    await closeAll(browser);
  }
}
