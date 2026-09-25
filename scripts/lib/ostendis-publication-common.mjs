#!/usr/bin/env node
/**
 * Shared factory for Swiss employers using Ostendis as their ATS.
 *
 * Two listing surfaces, one detail surface:
 *
 *   a) **Static anchors** — the employer's career page server-renders
 *      `<a href="https://link.ostendis.com/publication/{slug}/{token}">` per
 *      opening (e.g. Hof Weissbad).
 *   b) **OJP widget** — the employer embeds the Ostendis Jobs Platform widget
 *      via `<script>OSTENDISJOBS.embed("{customer-id}","{lang}","#ostendisJobs",{});</script>`
 *      The widget hydrates a `<div id="ostendisJobs">` with the same anchor
 *      pattern after the loader runs (e.g. Kantonsspital Obwalden).
 *
 *   Detail pages are always `link.ostendis.com/publication/{slug}/{token}` —
 *   server-rendered HTML that ships a JSON-LD `JobPosting` block (preferred
 *   source of `title`, `description`, `datePosted`) with a DOM fallback.
 *
 * Both flavours need Playwright: surface (a) because the host fronts Vercel
 * with a JS challenge, surface (b) because the widget is a Symfony live
 * component that requires `JavaScript aktiviert` to render.
 *
 * Anti-bot:
 *   - Use a realistic Chrome UA — the FrontaliereTicino default bot UA
 *     trips Vercel/Cloudflare on several Ostendis-hosted sites.
 *   - `waitUntil: 'domcontentloaded'` + `networkidle` (best-effort) before
 *     scraping anchors. Some widget bundles take 4-6 s to inject anchors.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import {
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';
import {
  createBrowser,
  createPoliteContext,
  closeAll,
  AntiBotBlockError,
  NavigationTimeout,
} from './ats-clients/playwright-runtime.mjs';

const REALISTIC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const OSTENDIS_HOSTS = new Set([
  'link.ostendis.com',
  'odm.ostendis.com',
  'ats.ostendis.com',
  'www.ostendis.com',
  'ostendis.com',
]);

const WIDGET_WAIT_MS = 8_000;
const PUBLICATION_ANCHOR_SELECTOR = 'a[href*="link.ostendis.com/publication/"]';

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Build a parser bundle for one Ostendis-backed employer.
 *
 * @param {Object} config
 * @param {string} config.companyKey
 * @param {string} config.companyName
 * @param {string} config.companyDomain        Bare domain, no scheme/path.
 * @param {string} config.careerUrl            Listing page that hosts (or
 *                                             widget-renders) the publication
 *                                             anchors.
 * @param {string} config.defaultCanton        ISO 3166-2 cantonal code.
 * @param {string} config.defaultCity
 * @param {string} [config.defaultPostalCode]
 * @param {string} [config.defaultSourceLang='de']
 * @param {string} [config.sector='Sanità / Ospedali']
 * @param {string} [config.sourceLabel]        Source string written into
 *                                             ParsedJob.source. Falls back
 *                                             to a sensible default.
 * @param {string} [config.fallbackDescription] Description used when the
 *                                             detail JSON-LD ships less than
 *                                             80 chars. Defaults to a generic
 *                                             company tagline.
 * @param {boolean} [config.waitForWidget=true] Wait for an OJP widget anchor
 *                                             to appear before harvesting.
 *                                             Set false when anchors are
 *                                             server-rendered (no widget).
 * @param {number} [config.widgetTimeoutMs=8000]
 */
export function createOstendisPublicationParser(config) {
  const {
    companyKey,
    companyName,
    companyDomain,
    careerUrl,
    defaultCanton,
    defaultCity,
    defaultPostalCode,
    defaultSourceLang = 'de',
    sector = 'Sanità / Ospedali',
    sourceLabel,
    fallbackDescription,
    waitForWidget = true,
    widgetTimeoutMs = WIDGET_WAIT_MS,
  } = config;

  if (!companyKey || !companyName || !companyDomain || !careerUrl || !defaultCanton || !defaultCity) {
    throw new Error('createOstendisPublicationParser: missing required config');
  }

  const corporateHost = String(companyDomain).replace(/^www\./, '').toLowerCase();
  const sourceLine = sourceLabel || `${companyName} Dedicated Parser (Ostendis via Playwright)`;
  const defaultFallback =
    `${companyName} — Stelle in ${defaultCity}` +
    (defaultCanton ? ` (${defaultCanton})` : '') +
    `, Schweiz.`;

  function isCompanyJob(job) {
    if (!job) return false;
    const key = normalize(job.companyKey || '');
    const company = normalize(job.company || '');
    const url = normalize(job.url || '');
    if (key === companyKey) return true;
    if (company && companyName && company === normalize(companyName)) return true;
    if (corporateHost && url.includes(corporateHost)) return true;
    if (/ostendis\.com\/publication\//.test(url) && key === companyKey) return true;
    return false;
  }

  function isTrustedDomain(rawUrl = '') {
    try {
      const host = new URL(rawUrl).hostname.toLowerCase();
      if (corporateHost && (host === corporateHost || host.endsWith(`.${corporateHost}`))) return true;
      if (OSTENDIS_HOSTS.has(host)) return true;
      return false;
    } catch {
      return false;
    }
  }

  async function discoverListings(context) {
    const page = await context.newPage();
    try {
      const resp = await page.goto(careerUrl, { waitUntil: 'domcontentloaded' });
      const status = resp ? resp.status() : 0;
      if (status === 429 || status === 403 || status === 522) {
        throw new AntiBotBlockError(
          `Anti-bot block on ${careerUrl} (status=${status})`,
          { url: careerUrl, status },
        );
      }
      try {
        await page.waitForLoadState('networkidle', { timeout: 30_000 });
      } catch {
        /* widget may keep a websocket open — best-effort */
      }
      if (waitForWidget) {
        try {
          await page.waitForSelector(PUBLICATION_ANCHOR_SELECTOR, { timeout: widgetTimeoutMs });
        } catch {
          /* fall through: maybe zero openings, or anchors landed before timeout */
        }
      }
      const tiles = await page.evaluate((sel) => {
        const out = [];
        const anchors = document.querySelectorAll(sel);
        for (const a of anchors) {
          // Walk up to the nearest card-like container for a heading.
          let card = a;
          for (let i = 0; i < 5; i += 1) {
            if (!card.parentElement) break;
            card = card.parentElement;
            if (card.querySelector('h1, h2, h3, h4, h5, h6')) break;
          }
          const headingEl = card.querySelector('h1, h2, h3, h4, h5, h6');
          const title =
            (headingEl?.textContent || '').trim() ||
            (a.textContent || '').trim() ||
            '';
          out.push({ title, url: a.href });
        }
        return out;
      }, PUBLICATION_ANCHOR_SELECTOR);

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
        unique.push({ title: normalizeSpace(t.title), url: t.url });
      }
      return unique;
    } finally {
      try { await page.close(); } catch { /* no-op */ }
    }
  }

  async function fetchDetail(context, url) {
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
            const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
            if (types.includes('JobPosting')) {
              title = title || String(node.title || '').trim();
              descriptionHtml = descriptionHtml || String(node.description || '');
              postedAt = postedAt || node.datePosted || node.validThrough || null;
            }
          }
        } catch {
          /* malformed JSON-LD — ignore */
        }
      }

      if (!title) title = await page.title();
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

  function buildParsedJob({ title, descriptionHtml, postedAt, publicUrl }) {
    const cleanTitle = normalizeSpace(title || '');
    if (!cleanTitle || cleanTitle.length < 3) return null;

    const descriptionText = stripHtml(descriptionHtml || '');
    const sourceLang = detectLang(descriptionText || cleanTitle, defaultSourceLang);
    const jobSlug = slugify(`${cleanTitle} ${companyKey} ${defaultCity}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const desc =
      descriptionText.length >= 80
        ? descriptionText
        : fallbackDescription || defaultFallback;

    const postedDate = (() => {
      if (!postedAt) return new Date().toISOString().slice(0, 10);
      const d = new Date(postedAt);
      if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
      return d.toISOString().slice(0, 10);
    })();

    const employmentType = detectHealthcareEmploymentType(cleanTitle);

    return {
      id: `${companyKey}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: companyName,
      companyKey,
      companyDomain,
      title: cleanTitle,
      titleByLocale: { [sourceLang]: cleanTitle },
      description: desc,
      descriptionByLocale: { [sourceLang]: desc },
      location: defaultCity,
      canton: defaultCanton,
      url: publicUrl,
      source: sourceLine,
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: defaultCity,
      addressRegion: defaultCanton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: defaultPostalCode || '',
      category: detectHealthcareCategory(cleanTitle),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectHealthcareExperienceLevel(cleanTitle),
      sector,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
      needsRetranslation: true,
    };
  }

  async function fetchAllJobs() {
    console.log(`🔍 Fetching ${companyName} jobs (Ostendis via Playwright)`);
    console.log(`   Source: ${careerUrl}\n`);

    let browser;
    try {
      browser = await createBrowser({ userAgent: REALISTIC_UA });
      const context = await createPoliteContext(browser, { userAgent: REALISTIC_UA });

      let listings = [];
      try {
        listings = await discoverListings(context);
      } catch (err) {
        if (err instanceof AntiBotBlockError) {
          console.warn(`⚠️ Anti-bot block: ${err.message}`);
          return [];
        }
        if (err instanceof NavigationTimeout) {
          console.warn(`⚠️ ${companyName} listing navigation timeout: ${err.message}`);
          return [];
        }
        throw err;
      }

      console.log(`   Discovered ${listings.length} publication tiles`);
      if (listings.length === 0) {
        console.warn(`⚠️ ${companyName} listing yielded 0 jobs.`);
        return [];
      }

      const jobs = [];
      for (const listing of listings) {
        try {
          const detail = await fetchDetail(context, listing.url);
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

      console.log(`\n📋 Total ${companyName} jobs discovered: ${jobs.length}`);
      return jobs;
    } finally {
      await closeAll(browser);
    }
  }

  return { fetchAllJobs, isCompanyJob, isTrustedDomain };
}
