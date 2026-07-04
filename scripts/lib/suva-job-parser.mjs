#!/usr/bin/env node
/**
 * Suva job parser — Fetcher and job builder.
 *
 * Source: https://jobs.suva.ch/ — SAP SuccessFactors Recruiting Marketing
 * (jobs2web / Career Site Builder, "html-jobreq" flavor — same family as
 * jobs.mobiliar.ch and jobs.sbb.ch). Live-verified 2026-07-04 by fetching
 * the career site and inspecting page source: `performancemanager.
 * successfactors.eu` script includes, `rmkcdn.successfactors.com` assets,
 * `sitebuilderframework.min.css`, `j2w.fallbacks.js`. This is a DIFFERENT
 * backend than whatever ATS tag was suggested for this campaign row (per
 * the campaign's known recurring wrong-discovery-tag bug) — no assumption
 * carried over from the discovery table.
 *
 * Sitemap-driven discovery: https://jobs.suva.ch/sitemap.xml lists every
 * live job detail URL. The slug embeds a trailing `-{CANTON}-{ZIP}` suffix
 * (e.g. `/job/Root-Assistentin-...-100-LU-6039/1392999433/`) — a far more
 * reliable geo signal than free-text city inference, used as the primary
 * canton/postal-code source here.
 *
 * Detail pages carry schema.org JobPosting microdata (not JSON-LD): the
 * `itemprop="description"` span holds the full body; `streetAddress` /
 * `postalCode` / `addressRegion` spans are populated client-side by an
 * inline <script> (never executed by our fetch) from a static per-office
 * switch-case table. That table is reproduced verbatim below
 * (SUVA_OFFICE_ADDRESSES) rather than depended on at runtime, since it is
 * identical boilerplate on every job page and does not require JS execution
 * to read. It only covers Suva's ~18 regional agency cities — jobs at other
 * work locations (e.g. "Root") or multi-location postings fall through to
 * the shared build-plugin's HQ/city-centro fallback in
 * `build-plugins/shared/jobPostingSchema.ts` (per CLAUDE.md non-negotiable
 * #3: missing source data gets a safe default, not a dropped check).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSuvaJobs() — Fetch and parse all jobs
 *   - isSuvaJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()  — Validate URLs belong to this company
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, buildJobSlug, stripHtml, fetchHtml } from './crawler-template.mjs';
import { inferAnyCanton } from './target-swiss-locations.mjs';
import { ALL_CANTON_CODES } from './crawler-location-config.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SUVA_KEY = 'suva';
export const SUVA_COMPANY_NAME = 'Suva';
export const SUVA_COMPANY_DOMAIN = 'suva.ch';

const SITEMAP_URL = 'https://jobs.suva.ch/sitemap.xml';

/**
 * Static Suva regional-agency address table — reproduced from the inline
 * `switch($(".addressLocality").text()){ ... }` block present verbatim on
 * every jobs.suva.ch detail page (client-side JS that never executes for a
 * plain fetch). Keyed by the exact city string Suva displays.
 */
const SUVA_OFFICE_ADDRESSES = {
  Aarau: { canton: 'AG', postalCode: '5000', streetAddress: 'Rain 35' },
  Basel: { canton: 'BS', postalCode: '4052', streetAddress: 'St. Jakobs-Strasse 24' },
  Bellinzona: { canton: 'TI', postalCode: '6500', streetAddress: 'Piazza del Sole 6' },
  Bern: { canton: 'BE', postalCode: '3008', streetAddress: 'Laupenstrasse 11' },
  Chur: { canton: 'GR', postalCode: '7000', streetAddress: 'Tittwiesenstrasse 25' },
  'Delémont': { canton: 'JU', postalCode: '2800', streetAddress: 'Quai de la Sorne 22' },
  Fribourg: { canton: 'FR', postalCode: '1700', streetAddress: 'Rue de Locarno 3' },
  Genf: { canton: 'GE', postalCode: '1207', streetAddress: 'Rue Ami-Lullin 12' },
  'Genève': { canton: 'GE', postalCode: '1207', streetAddress: 'Rue Ami-Lullin 12' },
  'La Chaux-de-Fonds': { canton: 'NE', postalCode: '2300', streetAddress: 'Avenue Léopold-Robert 25' },
  Lausanne: { canton: 'VD', postalCode: '1003', streetAddress: 'Avenue de la Gare 19' },
  Luzern: { canton: 'LU', postalCode: '6004', streetAddress: 'Fluhmattstrasse 1' },
  Sion: { canton: 'VS', postalCode: '1950', streetAddress: 'Avenue de Tourbillon 36' },
  Solothurn: { canton: 'SO', postalCode: '4500', streetAddress: 'Schänzlistrasse 8' },
  'St. Gallen': { canton: 'SG', postalCode: '9000', streetAddress: 'Unterstrasse 15' },
  Wetzikon: { canton: 'ZH', postalCode: '8620', streetAddress: 'Guyer-Zeller-Strasse 27' },
  Winterthur: { canton: 'ZH', postalCode: '8400', streetAddress: 'Lagerhausstrasse 17' },
  'Ziegelbrücke': { canton: 'GL', postalCode: '8866', streetAddress: 'Ziegelbrückstrasse 64' },
  'Zürich': { canton: 'ZH', postalCode: '8002', streetAddress: 'Dreikönigstrasse 7' },
};

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Suva.
 *
 * NOTE: Suva runs a subsidiary rehab clinic with its OWN dedicated crawler
 * (`crr-suva-sion-job-parser.mjs`, companyKey `crr-suva-sion`, company name
 * "Clinique romande de réadaptation (CRR Suva)") — that display name
 * contains the substring "suva", so this matcher intentionally uses an
 * EXACT company-name match (not `.includes('suva')`) to avoid cross-company
 * contamination when filtering the global dataset.
 */
export function isSuvaJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SUVA_KEY ||
    company === 'suva' ||
    url.includes('jobs.suva.ch')
  );
}

/**
 * Validate that a URL belongs to Suva's job board domain.
 *
 * Scoped to `jobs.suva.ch` (not a bare `.suva.ch` suffix check) — the
 * subsidiary clinic's own site is `crr-suva.ch`, which does NOT end with
 * `.suva.ch`, so this is already collision-safe, but the explicit host is
 * kept for clarity and to avoid ever matching a stray `*.suva.ch` subdomain
 * that isn't the job board.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'jobs.suva.ch';
  } catch {
    return false;
  }
}

/* ── Category / Employment Detection ──────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(m[ée]decin|arzt|ärztin|psychiat|neurolog|traumatolog)/.test(t)) return 'Medicina';
  if (/\b(ingegner|engineer|entwickl|bauingenieur|baumeister)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install|cyber|security)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|assistent|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(sachbearbeit|gestionnaire|specialist[ae]|sp[ée]cialiste)/.test(t)) return 'Amministrazione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal|talent)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz|redaktion)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Assicurazioni';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|d[ée]couverte)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|leitung|leiterin|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Extract the pensum percentage range from a title (e.g. "80 - 100 %",
 * "100%", "60-100 % (befristet)") and derive a schema.org employmentType +
 * simple contract label from it.
 */
function detectPensum(title = '') {
  const match = title.match(/(\d{1,3})\s*(?:[-–]\s*(\d{1,3}))?\s*%/);
  if (!match) return { pensum: '', employmentType: 'OTHER', contract: 'full-time' };
  const min = Number(match[1]);
  const max = match[2] ? Number(match[2]) : min;
  const pensum = match[2] ? `${match[1]}-${match[2]}%` : `${match[1]}%`;
  const employmentType = max >= 100 ? 'FULL_TIME' : 'PART_TIME';
  const contract = max >= 100 ? 'full-time' : 'part-time';
  return { pensum, employmentType, contract };
}

/* ── URL / HTML Extraction ────────────────────────────────── */

/**
 * Extract a stable numeric-ish job id fragment from the job URL for logging.
 */
function extractJobId(url = '') {
  const match = url.match(/\/job\/[^/]+\/(\d+)\/?$/);
  return match ? match[1] : '';
}

/**
 * Extract canton + postal code from the trailing `-{CANTON}-{ZIP}` suffix
 * that Suva's own sitemap slugs embed, e.g.
 * `/job/Root-Assistentin-...-100-LU-6039/1392999433/` → { canton: 'LU', postalCode: '6039' }.
 * Validated against the canonical 26-canton code list to reject accidental
 * false-positive matches.
 */
function extractCantonZipFromUrl(url = '') {
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    // Malformed percent-encoding — fall back to the raw string.
  }
  const match = decoded.match(/-([A-Z]{2})-(\d{4})\/\d+\/?$/);
  if (!match) return { canton: '', postalCode: '' };
  const canton = match[1];
  if (!ALL_CANTON_CODES.includes(canton)) return { canton: '', postalCode: '' };
  return { canton, postalCode: match[2] };
}

/**
 * Parse a Suva job detail page (jobs2web / SF Career Site Builder HTML).
 *
 * Layout (verified live across DE/FR samples): two short plain-text
 * `class="rtltextaligneligible"` blocks appear before the
 * `itemprop="description"` block — the first is the title (we prefer
 * `og:title`, cleaner), the second is the location display text (may be a
 * single city, or several cities joined with " | " for multi-location
 * postings — passed through as-is, matching how the SPA already handles
 * non-geographic multi-location blobs elsewhere in the codebase).
 */
function parseDetailPage(html = '') {
  if (!html) return null;

  const ogTitleMatch = html.match(/property="og:title"\s+content="([^"]*)"/i);
  const titleFallback = html.match(/<title>([\s\S]*?)\s*(?:Stellendetails|D[ée]tails du poste|Dettagli.*?impiego)?\s*\|\s*Suva<\/title>/i);
  const title = normalizeSpace(
    stripHtml(ogTitleMatch ? ogTitleMatch[1] : titleFallback ? titleFallback[1] : '')
  );
  if (!title || title.length < 3) return null;

  const descMatch = html.match(/<span[^>]*itemprop="description"[^>]*>([\s\S]*?)<\/span>/i);
  const description = normalizeSpace(stripHtml(descMatch ? descMatch[1] : ''));

  const descIdx = html.indexOf('itemprop="description"');
  const before = descIdx >= 0 ? html.slice(0, descIdx) : html;
  const spanPattern = /<span[^>]*class="rtltextaligneligible"[^>]*>([\s\S]*?)<\/span>/gi;
  let spanMatch;
  let location = '';
  while ((spanMatch = spanPattern.exec(before)) !== null) {
    const text = normalizeSpace(stripHtml(spanMatch[1]));
    if (text) location = text;
  }

  return { title, description, location };
}

/**
 * Parse sitemap.xml and extract all live Suva job detail URLs.
 */
async function fetchAllSuvaJobUrls() {
  console.log(` 📄 Fetching sitemap: ${SITEMAP_URL}`);
  const xml = await fetchHtml(SITEMAP_URL, { headers: { Accept: 'application/xml,text/xml,*/*' } });
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)]
    .map((m) => m[1].trim())
    .filter((url) => url.includes('/job/'));
  const unique = [...new Set(urls)];
  console.log(` 📦 Total job URLs in sitemap: ${unique.length}`);
  return unique;
}

/* ── Main Fetch ────────────────────────────────────────────── */

/**
 * Fetch all Suva jobs across Switzerland (CH-wide, all 26 cantons — Suva is
 * a national institution with regional agencies in every canton).
 *
 * Strategy:
 *  1. Fetch sitemap.xml → every live job URL (canton+zip embedded in slug)
 *  2. Fetch each detail page → title, description, location text
 *  3. Build ParsedJob objects (canton-quorum-gate re-classifies downstream)
 *
 * IMPORTANT: Only source-locale fields are set here. Other locales are
 * filled by the AI localization step in the translate-pending pipeline.
 */
export async function fetchAllSuvaJobs() {
  console.log(`🔍 Fetching Suva jobs (CH-wide, all 26 cantons)`);
  console.log(` Source: ${SITEMAP_URL}`);
  console.log(` Strategy: Sitemap → all Swiss job URLs → detail pages\n`);

  const jobUrls = await fetchAllSuvaJobUrls();
  if (!jobUrls || jobUrls.length === 0) {
    console.warn('⚠️ No job URLs found in sitemap.');
    return [];
  }

  console.log(`\n 📋 Fetching ${jobUrls.length} detail pages...\n`);

  const jobs = [];
  for (const jobUrl of jobUrls) {
    const jobId = extractJobId(jobUrl);

    try {
      const html = await fetchHtml(jobUrl);
      const parsed = parseDetailPage(html);
      if (!parsed) {
        console.warn(` ⚠️ Could not parse detail page: ${jobUrl}`);
        continue;
      }

      const { canton: urlCanton, postalCode: urlPostalCode } = extractCantonZipFromUrl(jobUrl);
      const location = parsed.location || 'Luzern';
      // Primary city for the office-address lookup: first segment before a
      // " | " multi-location separator, if present.
      const primaryCity = location.split('|')[0].trim();
      const officeAddress = SUVA_OFFICE_ADDRESSES[primaryCity];

      const canton = urlCanton || officeAddress?.canton || inferAnyCanton(location) || '';
      const postalCode = urlPostalCode || officeAddress?.postalCode || '';
      const streetAddress = officeAddress?.streetAddress || '';

      const description = parsed.description || `${parsed.title} — ${SUVA_COMPANY_NAME}`;
      const sourceLang = detectLang(description || parsed.title, 'de');
      const jobSlug = buildJobSlug(parsed.title, `suva ${primaryCity}`);
      const urlHash = createHash('sha1').update(jobUrl).digest('hex').slice(0, 12);
      const { pensum, employmentType, contract } = detectPensum(parsed.title);

      const job = {
        // ── Required fields ──
        id: `suva-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { [sourceLang]: jobSlug },
        company: SUVA_COMPANY_NAME,
        companyKey: SUVA_KEY,
        companyDomain: SUVA_COMPANY_DOMAIN,
        title: parsed.title,
        titleByLocale: { [sourceLang]: parsed.title },
        description,
        descriptionByLocale: { [sourceLang]: description },
        location,
        canton,
        url: jobUrl,
        source: 'Suva Dedicated Parser (SuccessFactors — jobs2web/CSB)',
        sourceLang,
        crawledAt: new Date().toISOString(),

        // ── Recommended fields ──
        addressLocality: location,
        addressCountry: 'CH',
        country: 'CH',
        ...(postalCode ? { postalCode } : {}),
        ...(streetAddress ? { streetAddress } : {}),
        category: detectCategory(parsed.title),
        contract,
        employmentType,
        experienceLevel: detectExperienceLevel(parsed.title),
        sector: 'Assicurazioni',
        currency: 'CHF',
        featured: false,
        postedDate: new Date().toISOString().split('T')[0],
        applyUrl: jobUrl,
        ...(pensum ? { pensum } : {}),
      };

      if (jobId) job.sfJobId = jobId;

      jobs.push(job);
      console.log(` ✅ ${jobId || '—'} — ${parsed.title.substring(0, 60)}`);
    } catch (err) {
      console.warn(` ⚠️ Skipping ${jobUrl} — fetch failed: ${err?.message || err}`);
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\n📋 Total Suva jobs discovered: ${jobs.length}`);
  return jobs;
}
