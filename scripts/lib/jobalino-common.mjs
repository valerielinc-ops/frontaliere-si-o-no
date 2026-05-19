#!/usr/bin/env node
/**
 * Shared factory for Swiss employers using **Jobalino** (jobalino.ch)
 * as their public ATS. Jobalino is a Swiss careers SaaS that ships a
 * `<jobalino-joblist>` custom element (custel_joblist.js) plus a
 * JSONP-wrapped server-rendered HTML response.
 *
 * Public endpoint (no authentication, JSONP shell):
 *
 *   GET https://my.jobalino.ch/custel_jobExternalList/{COMPANY_SLUG}
 *       ?additional_company_names={URL_ENCODED_SIBLING_SLUGS}
 *       &filter5=Ja                  (optional flag toggles)
 *       &custelid=...                (optional, harmless when omitted)
 *
 *   → `jb_ShowJsonHtml({"error":"","html":"…HTML…"}, '...');`
 *
 * The inner HTML lists every opening as
 *   <a href="https://my.jobalino.ch/job/{HASH}/{slug}" class="reflink">
 *     <span class="title">…</span>
 *     <span class="workload">80% - 100%</span>
 *     <span class="jobtype">Festanstellung</span>
 *     <span class="company">…</span><span class="zip">3860</span>
 *     <span class="city">Meiringen</span><span class="country">Schweiz</span>
 *     <span class="filter3">Pflege- und Betreuungsberufe</span>
 *   </a>
 *
 * Detail pages at `https://my.jobalino.ch/job/{HASH}/{slug}` always ship a
 * schema.org `JobPosting` `<script type="application/ld+json">` with a rich
 * `description` (HTML inside a JSON string). We parse the JSON-LD for the
 * canonical description, title, datePosted; fall back to the listing
 * payload for workload / city when JSON-LD is missing.
 *
 * Confirmed tenants (May 2026):
 *   - Privatklinik Meiringen (`privatklinik-meiringen`) — additional
 *     companies `michel-gruppe-ag`. Combined ~9 active openings.
 *   - Michel-Gruppe AG (`michel-gruppe-ag`) — umbrella that contains
 *     Klinik Aadorf and Privatklinik Meiringen (also has Aadorf openings
 *     when the parent clinics post them). Standalone fetch returns the
 *     Michel-Gruppe-AG openings only.
 *   - Klinik Aadorf has NO standalone Jobalino tenant (`klinik-aadorf`
 *     and `privatklinik-aadorf` both 404 with "Die Firma wurde nicht
 *     gefunden"); its openings flow through `michel-gruppe-ag`.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import {
  decodeEntities,
  normalizeSpace,
  htmlToText,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';

const API_HOST = 'https://my.jobalino.ch';
const DETAIL_DELAY_MS = 250;
const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

function normalize(s = '') {
  return String(s || '').trim().toLowerCase();
}

async function fetchText(url, accept = 'application/javascript,text/html,*/*') {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: accept, 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Unwrap `jb_ShowJsonHtml({...}, '...');` JSONP payload to the inner object.
 * Returns `null` on parse failure or if the server reports "Die Firma wurde
 * nicht gefunden." (plain string response).
 */
export function unwrapJobalinoJsonp(text = '') {
  if (!text || typeof text !== 'string') return null;
  if (!/^\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\(/.test(text)) return null;
  const stripped = text.replace(/^\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\(/, '');
  // Find balanced closing `}` for the first JSON object argument.
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = 0; i < stripped.length; i += 1) {
    const c = stripped[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end === -1) return null;
  try {
    return JSON.parse(stripped.slice(0, end));
  } catch {
    return null;
  }
}

/**
 * Parse the inner HTML payload returned by Jobalino into structured tiles.
 */
export function parseJobalinoListingHtml(html = '') {
  if (!html || typeof html !== 'string') return [];
  const out = [];
  const seen = new Set();
  // Each opening is a single <a class="reflink" href="…/job/{HASH}/{slug}">…</a>.
  const tileRx = /<a\s+href="(https:\/\/my\.jobalino\.ch\/job\/([a-f0-9]+)\/([a-z0-9-]+))"[^>]*class="reflink"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = tileRx.exec(html))) {
    const url = m[1];
    const id = m[2];
    const slug = m[3];
    if (seen.has(id)) continue;
    seen.add(id);
    const body = m[4];
    const pick = (cls) => {
      const re = new RegExp(`<span\\s+class=\"${cls}\"[^>]*>([\\s\\S]*?)<\\/span>`);
      const x = body.match(re);
      return x ? normalizeSpace(decodeEntities(x[1].replace(/<[^>]+>/g, ' '))) : '';
    };
    out.push({
      id,
      slug,
      url,
      title: pick('title'),
      workload: pick('workload'),
      jobtype: pick('jobtype'),
      placeOfWork: pick('place_of_work'),
      company: pick('company'),
      address: pick('address'),
      zip: pick('zip'),
      city: pick('city'),
      country: pick('country'),
      filter1: pick('filter1'),
      filter3: pick('filter3'),
    });
  }
  return out;
}

/**
 * Extract the schema.org JobPosting JSON-LD from a Jobalino detail page.
 * Returns `null` if not found or unparseable.
 */
export function extractJobalinoJobPostingJsonLd(html = '') {
  if (!html || typeof html !== 'string') return null;
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    try {
      const parsed = JSON.parse(m[1]);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const obj of arr) {
        if (obj && obj['@type'] === 'JobPosting') return obj;
      }
    } catch { /* keep trying */ }
  }
  return null;
}

/**
 * Convenience: parse Jobalino's HTML-encoded JobPosting description down
 * to plain text. The description string ships with double-escaped HTML
 * (`&lt;ul&gt;&lt;li&gt;…`); we decode once, then htmlToText once.
 */
export function jobalinoDescriptionToText(raw = '') {
  if (!raw) return '';
  // Two passes: the JSON string is already HTML-escaped, and inner HTML
  // tags use `<br>` / real `<ul>` / `&lt;li&gt;` mixes. Decode + strip.
  const once = decodeEntities(String(raw));
  return htmlToText(once);
}

export async function fetchJobalinoListing({ company, additionalCompanies = '', filters = {}, locale = 'de' } = {}) {
  if (!company) throw new Error('fetchJobalinoListing: missing company slug');
  const params = new URLSearchParams();
  if (additionalCompanies) params.set('additional_company_names', additionalCompanies);
  for (const [k, v] of Object.entries(filters)) {
    if (v == null || v === '') continue;
    params.set(k, String(v));
  }
  const localePrefix = /^(de|fr|it|en)$/.test(locale) && locale !== 'de' ? `${locale}/` : '';
  const url = `${API_HOST}/custel_jobExternalList/${localePrefix}${encodeURIComponent(company)}${params.toString() ? `?${params}` : ''}`;
  const raw = await fetchText(url, 'application/javascript,*/*');
  const obj = unwrapJobalinoJsonp(raw);
  if (!obj) return { html: '', error: raw.slice(0, 200) };
  return { html: String(obj.html || ''), error: String(obj.error || '') };
}

/**
 * Build a parser bundle for one Jobalino tenant.
 *
 * @param {Object} config
 * @param {string} config.jobalinoCompanySlug   Tenant slug.
 * @param {string} [config.additionalCompanies] Comma-separated sibling
 *                                              tenants to merge in (mirrors
 *                                              the widget's `additional_companies` attr).
 * @param {string} [config.locale='de']
 * @param {Object} [config.listingFilters]      Extra Jobalino filter params.
 * @param {string} config.companyKey
 * @param {string} config.companyName
 * @param {string} config.companyDomain
 * @param {string} config.defaultCanton
 * @param {string} config.defaultCity
 * @param {string} [config.defaultPostalCode]
 * @param {string} [config.publicCareerUrl]
 * @param {string} [config.defaultSourceLang='de']
 * @param {string} [config.sourceLabel]
 * @param {string} [config.matchCompanyName]    When set, only include tiles
 *                                              whose `company` span matches
 *                                              this string (case-insensitive
 *                                              substring). Useful when an
 *                                              umbrella tenant returns sibling
 *                                              clinics you don't want to claim.
 */
export function createJobalinoParser(config) {
  const {
    jobalinoCompanySlug,
    additionalCompanies = '',
    locale = 'de',
    listingFilters = {},
    companyKey,
    companyName,
    companyDomain,
    defaultCanton,
    defaultCity,
    defaultPostalCode = '',
    publicCareerUrl = '',
    defaultSourceLang = 'de',
    sourceLabel,
    matchCompanyName = '',
  } = config;

  if (!jobalinoCompanySlug || !companyKey || !companyName || !defaultCanton) {
    throw new Error('createJobalinoParser: missing required config');
  }

  const corporateHost = String(companyDomain || '').replace(/^www\./, '').toLowerCase();
  const label = sourceLabel || `${companyName} Dedicated Parser (Jobalino)`;
  const matchTokenLower = matchCompanyName ? matchCompanyName.toLowerCase() : '';

  function isCompanyJob(job) {
    const key = normalize(job?.companyKey || '');
    const url = normalize(job?.url || '');
    if (key === companyKey) return true;
    if (corporateHost && url.includes(corporateHost)) return true;
    return false;
  }

  function isTrustedDomain(rawUrl = '') {
    try {
      const host = new URL(rawUrl).hostname.toLowerCase();
      if (corporateHost && (host === corporateHost || host.endsWith(`.${corporateHost}`))) return true;
      if (host === 'my.jobalino.ch' || host === 'jobalino.ch' || host.endsWith('.jobalino.ch')) return true;
      return false;
    } catch {
      return false;
    }
  }

  async function fetchAllJobs() {
    console.log(`🏥 Fetching ${companyName} jobs`);
    const sib = additionalCompanies ? ` (+${additionalCompanies})` : '';
    console.log(`   Source: ${API_HOST}/custel_jobExternalList/${jobalinoCompanySlug}${sib} (Jobalino)\n`);

    let listing;
    try {
      listing = await fetchJobalinoListing({
        company: jobalinoCompanySlug,
        additionalCompanies,
        locale,
        filters: listingFilters,
      });
    } catch (err) {
      console.warn(`⚠️ Jobalino listing fetch failed: ${err?.message || err}`);
      return [];
    }
    if (listing.error) {
      console.warn(`⚠️ Jobalino error for '${jobalinoCompanySlug}': ${listing.error}`);
      return [];
    }
    const tiles = parseJobalinoListingHtml(listing.html);
    if (!tiles.length) {
      console.warn(`⚠️ No openings parsed from Jobalino listing for ${jobalinoCompanySlug}`);
      return [];
    }
    const filteredTiles = matchTokenLower
      ? tiles.filter((t) => (t.company || '').toLowerCase().includes(matchTokenLower))
      : tiles;
    console.log(`  ✓ ${tiles.length} tiles parsed (${filteredTiles.length} after company filter)`);

    const todayIso = new Date().toISOString().slice(0, 10);
    const jobs = [];
    let detailHits = 0;
    let failed = 0;

    for (let i = 0; i < filteredTiles.length; i += 1) {
      const tile = filteredTiles[i];
      let detailHtml = '';
      try {
        detailHtml = await fetchText(tile.url, 'text/html,*/*');
      } catch (err) {
        console.warn(`  ⚠️ Detail fetch failed (${tile.url}): ${err?.message || err}`);
      }

      const jsonLd = detailHtml ? extractJobalinoJobPostingJsonLd(detailHtml) : null;
      if (jsonLd) detailHits += 1;

      const title = normalizeSpace(decodeEntities(String(jsonLd?.title || tile.title || '')));
      if (!title) {
        failed += 1;
        if (i < filteredTiles.length - 1) await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
        continue;
      }

      const descriptionRaw = jsonLd?.description
        ? jobalinoDescriptionToText(jsonLd.description)
        : `${title} — ${companyName} (${tile.city || defaultCity}).`;

      const city = tile.city || defaultCity;
      const postal = tile.zip || defaultPostalCode;
      const canton = inferSwissTargetCanton(`${city} ${tile.country || ''}`) || defaultCanton;

      // Workload "80% - 100%" → numeric range
      let pensumMin = null;
      let pensumMax = null;
      const wlRange = (tile.workload || '').match(/(\d{1,3})\s*%?\s*-\s*(\d{1,3})\s*%/);
      const wlSingle = (tile.workload || '').match(/(\d{1,3})\s*%/);
      if (wlRange) { pensumMin = parseInt(wlRange[1], 10); pensumMax = parseInt(wlRange[2], 10); }
      else if (wlSingle) { pensumMin = parseInt(wlSingle[1], 10); pensumMax = pensumMin; }

      const sourceLang = detectLang(descriptionRaw || title, defaultSourceLang);
      const employmentType = Number.isFinite(pensumMax) && pensumMax < 90
        ? 'PART_TIME'
        : detectHealthcareEmploymentType(`${title} ${tile.workload || ''}`);
      const isTemporary = /befristet|temporaire|temporary|interim/i.test(tile.jobtype || '')
        && !/festanstellung|permanent|unbefristet/i.test(tile.jobtype || '');
      const contract = isTemporary ? 'temporary' : 'full-time';

      const postedDate = jsonLd?.datePosted && /^\d{4}-\d{2}-\d{2}/.test(jsonLd.datePosted)
        ? String(jsonLd.datePosted).slice(0, 10)
        : todayIso;

      const jobSlug = slugify(`${title} ${companyKey} ${city}`);
      const urlHash = createHash('sha1')
        .update(`${companyKey}:${tile.id}`)
        .digest('hex')
        .slice(0, 12);
      const publicUrl = tile.url;

      const job = {
        id: `${companyKey}-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { [sourceLang]: jobSlug },
        company: companyName,
        companyKey,
        companyDomain,
        title,
        titleByLocale: { [sourceLang]: title },
        description: descriptionRaw,
        descriptionByLocale: { [sourceLang]: descriptionRaw },
        needsRetranslation: true,
        location: city,
        canton,
        url: publicUrl,
        source: label,
        sourceLang,
        crawledAt: new Date().toISOString(),
        addressLocality: city,
        addressRegion: canton,
        addressCountry: 'CH',
        country: 'CH',
        postalCode: postal,
        category: detectHealthcareCategory(`${title} ${tile.filter3 || ''}`),
        contract,
        employmentType,
        experienceLevel: detectHealthcareExperienceLevel(title),
        sector: 'Sanità / Ospedali',
        currency: 'CHF',
        featured: false,
        postedDate,
        applyUrl: publicUrl,
        requirements: [],
        requirementsByLocale: { [sourceLang]: [] },
        externalId: String(tile.id),
      };

      if (Number.isFinite(pensumMin) || Number.isFinite(pensumMax)) {
        const mn = Number.isFinite(pensumMin) ? pensumMin : pensumMax;
        const mx = Number.isFinite(pensumMax) ? pensumMax : pensumMin;
        job.pensumMin = mn;
        job.pensumMax = mx;
        job.pensum = mn === mx ? `${mx}%` : `${mn} - ${mx}%`;
      }
      if (isTemporary) job.contractDuration = 'temporary';
      else if (/festanstellung|unbefristet|permanent/i.test(tile.jobtype || '')) job.contractDuration = 'permanent';
      if (tile.filter3) job.department = tile.filter3;

      jobs.push(job);
      if (i < filteredTiles.length - 1) await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
    }

    console.log(`📋 Total ${companyName} jobs discovered: ${jobs.length} (${detailHits}/${filteredTiles.length} with JSON-LD JobPosting, ${failed} skipped)`);
    return jobs;
  }

  return { fetchAllJobs, isCompanyJob, isTrustedDomain };
}
