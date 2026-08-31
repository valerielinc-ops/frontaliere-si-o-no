#!/usr/bin/env node
/**
 * RFSM — Réseau fribourgeois santé mentale (Fribourg, FR).
 *
 * Listing: https://jobs.fr.ch/search/?q=RFSM&locale=fr_FR
 *   SAP SuccessFactors career site of the State of Fribourg. We narrow
 *   the global job pool to RFSM postings via the `?q=RFSM` query string.
 *
 *   Each search row links to a detail page of the form:
 *     /job/{location-slug}-{title-slug}/{numeric-id}/
 *   The same job is rendered as ~3 anchors per card (icon + title + link),
 *   so we dedupe by the numeric ID.
 *
 * Detail: server-rendered SF careersection page. Key tokens:
 *   - <span itemprop="title" data-careersite-propertyid="title">…</span>
 *   - <span class="jobdescription">…</span>
 *   - <span data-careersite-propertyid="shifttype">…</span>     (taux %)
 *   - <span data-careersite-propertyid="location">…</span>      (location)
 *
 * RFSM operates psychiatric sites across the canton FR:
 *   Marsens (1633), Villars-sur-Glâne (1752), Givisiez (1762), Bulle (1630).
 * Canton is always FR.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, normalizeDescriptionBullets } from './crawler-template.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  htmlToText,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';
import { dedicatedFribourgOwner } from './crawler-company-ownership.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const RFSM_FRIBOURG_KEY = 'rfsm-fribourg';
export const RFSM_FRIBOURG_COMPANY_NAME = 'RFSM - Réseau fribourgeois santé mentale';
export const RFSM_FRIBOURG_COMPANY_DOMAIN = 'jobs.fr.ch';
export const RFSM_FRIBOURG_CAREERS_URL =
  'https://jobs.fr.ch/search/?q=RFSM&locale=fr_FR';
export const RFSM_FRIBOURG_CAREERS_URLS = [
  RFSM_FRIBOURG_CAREERS_URL,
  'https://jobs.fr.ch/search/?q=FNPG&locale=de_DE',
];

const DETAIL_DELAY_MS = 600;
const HQ_CANTON = 'FR';

/* ── City → postal code map (RFSM operational sites) ──────── */

const RFSM_SITES = [
  { match: /marsens/i, city: 'Marsens', postalCode: '1633' },
  { match: /villars[- ]sur[- ]gl[âa]ne/i, city: 'Villars-sur-Glâne', postalCode: '1752' },
  { match: /givisiez/i, city: 'Givisiez', postalCode: '1762' },
  { match: /bulle/i, city: 'Bulle', postalCode: '1630' },
  { match: /fribourg/i, city: 'Fribourg', postalCode: '1700' },
];

function resolveSite(text = '') {
  const haystack = String(text || '');
  for (const site of RFSM_SITES) {
    if (site.match.test(haystack)) return site;
  }
  return { city: 'Fribourg', postalCode: '1700' };
}

/* ── Company matchers ──────────────────────────────────────── */

export function isRfsmFribourgJob(job) {
  if (job?.companyKey === RFSM_FRIBOURG_KEY) return true;
  const company = String(job?.company || '').toLowerCase();
  if (company.includes('rfsm')) return true;
  if (company.includes('réseau fribourgeois')) return true;
  const url = String(job?.url || '').toLowerCase();
  return url.includes('jobs.fr.ch') && /\brfsm\b/i.test(url);
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'jobs.fr.ch' || host.endsWith('.jobs.fr.ch');
  } catch {
    return false;
  }
}

/* ── Listing parsing ──────────────────────────────────────── */

/**
 * Parse the SF search HTML, returning one row per unique RFSM job posting.
 *
 * The same job appears as ~3 anchors per card in SF search markup; we
 * dedupe by the numeric job ID embedded at the end of the path
 * `/job/{slug}/{numeric-id}/`.
 *
 * @param {string} html
 * @returns {Array<{ url: string, title: string, jobId: string }>}
 */
export function parseListing(html = '') {
  const out = [];
  const seen = new Set();
  // Match anchor with /job/{slug}/{numeric}/ href + optional visible title text.
  const re =
    /<a[^>]*href="(\/job\/([^"]+?)\/(\d{6,})\/?)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const jobId = m[3];
    if (seen.has(jobId)) continue;
    const anchorInner = m[4];
    const titleRaw = normalizeSpace(decodeEntities(anchorInner.replace(/<[^>]+>/g, ' ')));
    // Skip anchors that don't carry a visible title — there are link/icon
    // anchors for the same job whose anchor text is empty or "View".
    if (!titleRaw || titleRaw.length < 5) continue;
    if (/^(view|details|d[ée]tails|voir|see)/i.test(titleRaw)) continue;
    if (dedicatedFribourgOwner({ title: titleRaw }) !== RFSM_FRIBOURG_KEY) continue;
    seen.add(jobId);
    out.push({
      url: `https://jobs.fr.ch${href}`,
      title: titleRaw,
      jobId,
    });
  }
  return out;
}

/* ── Detail parsing ───────────────────────────────────────── */

function extractToken(html, propertyId) {
  const re = new RegExp(
    `<span[^>]*data-careersite-propertyid="${propertyId}"[^>]*>([\\s\\S]*?)<\\/span>`,
    'i'
  );
  const m = html.match(re);
  if (!m) return '';
  return normalizeSpace(decodeEntities(m[1].replace(/<[^>]+>/g, ' ')));
}

/**
 * Walk forward from a `<span class="jobdescription">` open tag, counting
 * nested `<span ...>` opens vs `</span>` closes, and return the substring
 * between them. SF jobdescription spans are heavily nested (divs + inline
 * spans for font styling), so a naive non-greedy regex stops at the first
 * nested `</span>` and returns ~465 chars instead of the full 5-10k body.
 */
export function extractBalancedJobDescription(html = '') {
  const openRe =
    /<span[^>]*class="(?:[^"]*\s)?jobdescription(?:\s[^"]*)?"[^>]*>/i;
  const openMatch = html.match(openRe);
  if (!openMatch) return '';
  const bodyStart = openMatch.index + openMatch[0].length;
  let depth = 1;
  let i = bodyStart;
  const len = html.length;
  while (i < len && depth > 0) {
    const nextOpen = html.indexOf('<span', i);
    const nextClose = html.indexOf('</span>', i);
    if (nextClose === -1) break;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      // Confirm it's a real <span...> open (not e.g. <spanother>).
      const after = html.charAt(nextOpen + 5);
      if (after === ' ' || after === '>' || after === '\t' || after === '\n') {
        depth += 1;
        i = nextOpen + 5;
        continue;
      }
      // Not a real span open — advance past it.
      i = nextOpen + 5;
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return html.slice(bodyStart, nextClose);
    }
    i = nextClose + 7;
  }
  return html.slice(bodyStart, i);
}

export function parseDetail(html = '') {
  if (!html) return { title: '', shiftType: '', location: '', description: '' };
  const title = extractToken(html, 'title');
  const shiftType = extractToken(html, 'shifttype');
  const location = extractToken(html, 'location');
  // Body lives inside <span class="jobdescription">…</span> with heavy
  // nesting — use a balanced span walker, not a non-greedy regex.
  const rawBody = extractBalancedJobDescription(html);
  let description = '';
  if (rawBody) {
    const cleaned = htmlToText(rawBody)
      .replace(/[ \t]+/g, ' ')
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    description = normalizeDescriptionBullets(cleaned).slice(0, 7000);
  }
  return { title, shiftType, location, description };
}

/* ── Fetcher ───────────────────────────────────────────────── */

export async function fetchAllRfsmFribourgJobs() {
  console.log(`🏥 Fetching ${RFSM_FRIBOURG_COMPANY_NAME} jobs`);
  console.log(`   Listings: ${RFSM_FRIBOURG_CAREERS_URLS.join(', ')}\n`);

  const byId = new Map();
  for (const listingUrl of RFSM_FRIBOURG_CAREERS_URLS) {
    try {
      const listingHtml = await fetchHtml(listingUrl);
      for (const row of parseListing(listingHtml)) {
        if (!byId.has(row.jobId)) byId.set(row.jobId, row);
      }
    } catch (err) {
      console.warn(`⚠️ Listing fetch failed (${listingUrl}): ${err?.message || err}`);
    }
  }
  const rows = [...byId.values()];
  console.log(`  ✓ ${rows.length} unique RFSM/FNPG postings detected`);
  if (rows.length === 0) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (i > 0) await new Promise((res) => setTimeout(res, DETAIL_DELAY_MS));
    console.log(`  📄 Detail ${i + 1}/${rows.length}: ${row.title.slice(0, 80)}`);
    let detail = { title: '', shiftType: '', location: '', description: '' };
    try {
      const detailHtml = await fetchHtml(row.url);
      detail = parseDetail(detailHtml);
    } catch (err) {
      console.warn(`     ⚠️ Detail fetch failed: ${err?.message || err}`);
    }
    const title = detail.title || row.title;
    const site = resolveSite(`${detail.location} ${title}`);
    const fallback = `Poste "${title}" au ${RFSM_FRIBOURG_COMPANY_NAME}, ${site.city} (${HQ_CANTON}). Le RFSM est le pôle de santé mentale du canton de Fribourg : psychiatrie adulte, enfants/adolescents, personnes âgées, addictions.`;
    const richDescription = detail.description && detail.description.length > 200
      ? `${fallback}\n\n${detail.description}`
      : fallback;

    const sourceLang = detectLang(richDescription || title, 'fr');
    const jobSlug = slugify(`${title} ${RFSM_FRIBOURG_KEY} ${site.city}`);
    const urlHash = createHash('sha1').update(row.url).digest('hex').slice(0, 12);

    jobs.push({
      id: `${RFSM_FRIBOURG_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: RFSM_FRIBOURG_COMPANY_NAME,
      companyKey: RFSM_FRIBOURG_KEY,
      companyDomain: RFSM_FRIBOURG_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: richDescription,
      descriptionByLocale: { [sourceLang]: richDescription },
      needsRetranslation: true,
      location: site.city,
      canton: HQ_CANTON,
      url: row.url,
      source: `${RFSM_FRIBOURG_COMPANY_NAME} Dedicated Parser`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: site.city,
      addressRegion: HQ_CANTON,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: site.postalCode,
      category: detectHealthcareCategory(`${title} ${richDescription.slice(0, 500)}`),
      contract: /\b\d{2,3}\s*[-–]\s*\d{2,3}\s*%\b/.test(detail.shiftType || title)
        ? 'part-time'
        : 'full-time',
      employmentType: detectHealthcareEmploymentType(
        `${title} ${detail.shiftType} ${richDescription.slice(0, 500)}`
      ),
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Santé mentale / Psychiatrie',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: row.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`📋 Total ${RFSM_FRIBOURG_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { HQ_CANTON, RFSM_SITES, resolveSite };
