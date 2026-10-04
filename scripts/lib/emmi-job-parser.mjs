#!/usr/bin/env node
/**
 * Emmi job parser — Fetcher and job builder.
 *
 * Source: https://group.emmi.com/che/de/arbeiten-bei-emmi/offene-stellen
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllEmmiJobs()  — Fetch and parse all jobs
 *   - isEmmiJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { sourcePostingDateFields } from './source-posting-date.mjs';
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchJson, fetchHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { assertJsonListShape } from './assert-json-list-shape.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const EMMI_KEY = 'emmi';
export const EMMI_COMPANY_NAME = 'Emmi';
export const EMMI_COMPANY_DOMAIN = 'emmi.com';

const CAREER_URL = 'https://group.emmi.com/che/de/arbeiten-bei-emmi/offene-stellen';

// prospective.ch OHWS careercenter id for Emmi (CH-only board).
const OHWS_MEDIUM_ID = '1003228';
const OHWS_JOBS_URL = `https://ohws.prospective.ch/public/v1/medium/${OHWS_MEDIUM_ID}/jobs`;
const SOURCE_LANG = 'de';
const HQ = { city: 'Luzern', canton: 'LU', postalCode: '6005', region: 'Luzern' };
const SECTOR = 'Food & Beverage (dairy)';

const CH_COUNTRY_LABELS = new Set(['schweiz', 'suisse', 'svizzera', 'switzerland']);

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Emmi.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isEmmiJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === EMMI_KEY ||
    key.startsWith('emmi') ||
    company.includes('emmi') ||
    url.includes('emmi.com')
  );
}

/**
 * Validate that a URL belongs to Emmi's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    // Primary domain + subdomains (keeps the unit test green) ...
    if (host === 'emmi.com' || host.endsWith('.emmi.com')) return true;
    // ... plus the real ATS posting/feed hosts (prospective.ch OHWS board).
    if (host === 'prospective.ch' || host.endsWith('.prospective.ch')) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Is this OHWS job located in Switzerland? The 1003228 careercenter is
 * CH-only, but we guard via country label + 4-digit Swiss zip anyway.
 */
function isSwissJob(szas = {}) {
  const country = normalize(szas['sza_location.country'] || '');
  if (country && CH_COUNTRY_LABELS.has(country)) return true;
  const zip = String(szas['sza_location.zip'] || '').trim();
  if (/^\d{4}$/.test(zip)) return true;
  return false;
}

/**
 * Fetch the prospective.ch OHWS JSON feed for Emmi's careercenter and
 * return raw listing objects. The feed paginates via offset/limit; total
 * is small (~65) so a single limit=100 page returns everything, but we
 * loop defensively in case the catalogue grows.
 */
async function fetchJobListings() {
  console.log(`   Fetching OHWS feed: ${OHWS_JOBS_URL}?lang=${SOURCE_LANG}`);

  const limit = 100;
  let offset = 0;
  const collected = [];

  // Bounded loop (safety cap) — exits as soon as a page returns < limit.
  for (let page = 0; page < 50; page += 1) {
    const url = `${OHWS_JOBS_URL}?lang=${SOURCE_LANG}&offset=${offset}&limit=${limit}`;
    const data = await fetchJson(url);
    const batch = assertJsonListShape(data, { key: 'jobs', source: 'emmi' });
    collected.push(...batch);

    const total = Number(data?.total) || collected.length;
    offset += limit;
    if (batch.length < limit || collected.length >= total) break;
  }

  return collected;
}

const DETAIL_DELAY_MS = 150;
const DETAIL_CONCURRENCY = 3;

function sectionInner(html, id) {
  const match = new RegExp(`<section\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)</section>`, 'i').exec(html);
  return match ? match[1] : '';
}

/**
 * The ad body of a jobs.emmi.com vacancy page, as HTML.
 *
 * The OHWS feed carries only the two bullet lists (`sza_tasks`,
 * `sza_requirements`); its `sza_benefits` is a single sentence pointing to the
 * careers site. The vacancy page the job links to is the ad itself: the
 * role-specific introduction, the two headed lists ("Das kannst du bewirken",
 * "Das bringst du mit") and the site's benefit cards ("Das bieten wir dir").
 * Publishing the feed alone dropped the introduction, the headings and every
 * benefit — 886 of 4,276 characters on the Langnau Betriebsmechaniker:in page
 * (2026-09-29). About, application process, contact and similar-jobs sections
 * are page chrome and stay out.
 *
 * @param {string} html
 * @returns {string} '' when the page has none of the ad sections
 */
export function extractEmmiVacancyHtml(html = '') {
  const source = String(html || '');
  const parts = [];
  const intro = sectionInner(source, 'introduction');
  if (stripHtml(intro)) parts.push(intro);
  const tasksAndProfile = sectionInner(source, 'tasksAndProfile');
  if (stripHtml(tasksAndProfile)) parts.push(tasksAndProfile);
  const benefits = sectionInner(source, 'benefits');
  if (benefits) {
    const items = [];
    const cardRe = /class="benefitTitle"[^>]*>([\s\S]*?)<\/div>[\s\S]*?class="benefitText"[^>]*>([\s\S]*?)<\/div>/gi;
    let card;
    while ((card = cardRe.exec(benefits)) !== null) {
      const title = normalizeSpace(stripHtml(card[1]));
      const text = normalizeSpace(stripHtml(card[2]));
      if (title || text) items.push(`<li>${[title, text].filter(Boolean).join(': ')}</li>`);
    }
    const heading = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(benefits)?.[0] || '';
    const benefitsLink = /<a\b[^>]*class="[^"]*arrowIconLink[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(benefits)?.[0] || '';
    // Some valid ads have no benefit cards but still publish the section
    // heading and the link to Emmi's benefits page. Keeping that rendered
    // source text prevents the dedicated parser from dropping the final ad
    // section and falling below the source-detail completeness gate.
    if (items.length || heading || benefitsLink) {
      parts.push(`${heading}${items.length ? `<ul>${items.join('')}</ul>` : ''}${benefitsLink}`);
    }
  }
  return parts.join('\n');
}

async function fetchEmmiVacancyHtml(url) {
  if (!isTrustedDomain(url) || !/(^|\.)jobs\.emmi\.com$/i.test(new URL(url).hostname)) return '';
  try {
    return extractEmmiVacancyHtml(await fetchHtml(url));
  } catch (err) {
    console.warn(`  ⚠️ Emmi detail fetch failed (${url}): ${err?.message || err}`);
    return '';
  }
}

/**
 * Fetch all Emmi jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllEmmiJobs() {
  console.log(`🔍 Fetching Emmi jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  // Vacancy pages, read three at a time (80+ pages one by one cost minutes of
  // cron time); a page that cannot be read falls back to the OHWS blocks.
  const vacancyHtmlByUrl = new Map();
  const detailUrls = [...new Set(listings
    .map((listing) => listing.links?.directlink || '')
    .filter(Boolean))];
  let nextDetail = 0;
  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, detailUrls.length) }, async () => {
    while (nextDetail < detailUrls.length) {
      const url = detailUrls[nextDetail++];
      vacancyHtmlByUrl.set(url, await fetchEmmiVacancyHtml(url));
      await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
    }
  }));

  const jobs = [];
  const seen = new Set();

  for (const listing of listings) {
    const szas = listing.szas || {};

    // Switzerland-only guard (board is CH-only; defensive check anyway).
    if (!isSwissJob(szas)) continue;

    const title = normalizeSpace(listing.title || szas.sza_title || '');
    if (!title || title.length < 3) continue;

    // ── Location: "City, Region(canton-name)" with HQ fallback ──
    const city = normalizeSpace(szas['sza_location.city'] || '');
    const region = normalizeSpace(szas['sza_location.region'] || '');
    const zip = normalizeSpace(szas['sza_location.zip'] || '');
    const street = normalizeSpace(szas['sza_location.street'] || '');
    const location = [city, region].filter(Boolean).join(', ') || HQ.city;
    const canton =
      inferSwissTargetCanton([city, region].filter(Boolean).join(' ')) || HQ.canton;
    const addressLocality = city || HQ.city;
    const postalCode = /^\d{4}$/.test(zip) ? zip : HQ.postalCode;
    const addressRegion = region || HQ.region;

    // ── Canonical job-detail URL (links.directlink) ──
    const publicUrl = listing.links?.directlink || CAREER_URL;

    // ── Description: the vacancy page (intro, headed lists, benefits); the
    // OHWS tasks + requirements blocks only when the page cannot be read ──
    const tasksHtml = szas.sza_tasks || '';
    const reqsHtml = szas.sza_requirements || '';
    const vacancyHtml = vacancyHtmlByUrl.get(publicUrl) || '';
    const descriptionHtml = vacancyHtml || [tasksHtml, reqsHtml].filter(Boolean).join('\n');
    const descriptionText = stripHtml(descriptionHtml) || stripHtml(tasksHtml);

    // Stable reference: prefer prospective viewkey/reference, fallback URL hash.
    const stableRef =
      String(szas.sza_reference_code || listing.viewkey || listing.id || '').trim();
    const urlHash = stableRef
      ? createHash('sha1').update(`emmi:${stableRef}`).digest('hex').slice(0, 12)
      : createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const id = `emmi-${urlHash}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const sourceLang = detectLang(descriptionText || title, SOURCE_LANG);
    const jobSlug = slugify(`${title} emmi ch`);

    // OHWS publication start is corroborated by the employer's JobPosting.
    // Preserve its full timestamp; modification time is not publication evidence.
    const postingDates = sourcePostingDateFields(listing.start_date);

    // ── Employment type: pensum + sza_employment_type label ──
    const pensumMax = Number(szas['sza_pensum.max']);
    const pensumMin = Number(szas['sza_pensum.min']);
    const pensumLabel = normalizeSpace(szas.sza_pensum || '');
    let employmentType;
    if (Number.isFinite(pensumMax) && pensumMax > 0 && pensumMax < 90) {
      employmentType = 'PART_TIME';
    } else if (Number.isFinite(pensumMin) && pensumMin > 0 && pensumMin < 90) {
      employmentType = 'PART_TIME';
    } else if (Number.isFinite(pensumMax) && pensumMax >= 90) {
      employmentType = 'FULL_TIME';
    } else {
      employmentType = detectEmploymentType(
        `${pensumLabel} ${szas.sza_employment_type || ''} ${title}`,
      );
    }

    const requirements = stripHtml(reqsHtml)
      .split(/\n+/)
      .map((s) => normalizeSpace(s))
      .filter((s) => s.length > 0);

    const job = {
      // ── Required fields ──
      id,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: EMMI_COMPANY_NAME,
      companyKey: EMMI_KEY,
      companyDomain: EMMI_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — ${EMMI_COMPANY_NAME}`,
      descriptionByLocale: {
        [sourceLang]: descriptionText || `${title} — ${EMMI_COMPANY_NAME}`,
      },
      location,
      canton,
      url: publicUrl,
      source: 'Emmi Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality,
      postalCode,
      addressRegion,
      streetAddress: street || undefined,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: normalizeSpace(szas['sza_salary.currency'] || '') || 'CHF',
      featured: false,
      ...postingDates,
      applyUrl: normalizeSpace(szas.sza_apply_link || '') || publicUrl,
      requirements,
      requirementsByLocale: { [sourceLang]: requirements },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total Emmi jobs discovered: ${jobs.length}`);
  return jobs;
}
