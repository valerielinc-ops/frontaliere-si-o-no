#!/usr/bin/env node
/**
 * Nestlé job parser — Fetcher and job builder.
 *
 * Source: https://nestle.ch/careers
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllNestleJobs()  — Fetch and parse all jobs
 *   - isNestleJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { rescueHtmlIfChallenged } from './jina-proxy.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { splitJobLocation } from './job-location-display.mjs';
import {
  fetchSuccessFactorsJobs,
  SuccessFactorsAuthError,
} from './ats-clients/successfactors-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const NESTLE_KEY = 'nestle';
export const NESTLE_COMPANY_NAME = 'Nestlé';
export const NESTLE_COMPANY_DOMAIN = 'nestle.com';

const SUCCESSFACTORS_HOST = 'jobdetails.nestle.com';
const SUCCESSFACTORS_SEARCH_URL = `https://${SUCCESSFACTORS_HOST}/search/?createNewAlert=false&q=&locationsearch=Switzerland&optionsFacetsDD_country=CH&locale=en_US`;
const CAREER_URL = SUCCESSFACTORS_SEARCH_URL;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function isSwissLocation(location = '') {
  return /(?:^|,\s*)CH(?:\s|$)/i.test(String(location || ''));
}

function wordCount(text = '') {
  return String(text || '').split(/\s+/).filter(Boolean).length;
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Nestlé.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isNestleJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === NESTLE_KEY ||
    key.startsWith('nestle') ||
    company.includes('nestlé') ||
    company.includes('nestle') ||
    url.includes('nestle.com') ||
    url.includes('nestle.ch') ||
    url.includes(SUCCESSFACTORS_HOST)
  );
}

/**
 * Validate that a URL belongs to Nestlé's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'nestle.com' ||
      host.endsWith('.nestle.com') ||
      host === 'nestle.ch' ||
      host.endsWith('.nestle.ch') ||
      host === SUCCESSFACTORS_HOST
    );
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

/* ── SuccessFactors fetcher ───────────────────────────────────
 * Nestlé's global careers site moved from Workday to SAP SuccessFactors
 * (`jobdetails.nestle.com`). The search page is server-rendered and paginated
 * with `startrow`, so the shared SuccessFactors jobs2web parser can discover
 * the Swiss listing rows without browser automation.
 */
async function fetchJobListings() {
  const out = [];
  try {
    for await (const posting of fetchSuccessFactorsJobs(SUCCESSFACTORS_SEARCH_URL, {
      company: NESTLE_COMPANY_NAME,
      maxPages: 100000,
      minDelayMs: 750,
    })) {
      out.push({
        title: posting.title,
        location: posting.location,
        url: posting.applyUrl,
        postedAt: posting.postedAt,
        jobReqId: posting.jobReqId,
      });
    }
  } catch (err) {
    if (err instanceof SuccessFactorsAuthError) {
      console.error(`❌ SuccessFactors anti-bot block: ${err.message}`);
      return [];
    }
    throw err;
  }
  return out.filter((job) => isSwissLocation(job.location));
}

async function fetchJobDescriptionText(listingUrl) {
  if (!listingUrl) return '';
  try {
    const res = await fetch(listingUrl, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'FrontaliereTicino-Bot/1.0 (+https://frontaliereticino.ch/)',
      },
      redirect: 'follow',
    });
    if (!res.ok) return '';
    // 200-but-challenge (IP-reputation WAF, cambiavalute class #1363) → Jina.
    const html = await rescueHtmlIfChallenged(await res.text(), listingUrl, {});
    const match = html.match(/<span[^>]*class="[^"]*jobdescription[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    if (!match) return '';
    return stripHtml(match[1])
      .replace(/[ \t]+/g, ' ')
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 4000);
  } catch {
    return '';
  }
}

/**
 * Fetch all Nestlé jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllNestleJobs() {
  console.log(`🔍 Fetching Nestlé jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    // TODO: Extract fields from each listing.
    // Adapt these field names to match the actual API response.
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const rawLocation = listing.location || 'Vevey';
    const canton = inferSwissTargetCanton(rawLocation) || 'VD';
    // Nestlé's feed appends the country to every city ("Konolfingen, CH"), and
    // that string was stored verbatim as `location`/`addressLocality`. Every
    // consumer then added the canton on top of it: the `• Location:` line below
    // shipped "Konolfingen, CH, Kanton BE" on 35 postings (measured on
    // origin/main 2026-08-19, the only crawler where the duplication actually
    // reached a published description), and the job page hero printed
    // "Konolfingen, CH (BE)". Strip the marker ONCE, here, so the stored field
    // is the city and nothing downstream has to know the feed's shape.
    const location = splitJobLocation(rawLocation, canton).city || rawLocation;
    const publicUrl = listing.url || CAREER_URL;

    const detailDescription = await fetchJobDescriptionText(publicUrl);
    await new Promise((r) => setTimeout(r, 400));

    const fallbackDescription = [
      `${title} — ${NESTLE_COMPANY_NAME}, ${location}.`,
      '',
      'Key details:',
      `• Location: ${location}${canton ? `, ${canton} canton` : ''}, Switzerland`,
      '• Employer: Nestlé — world\'s largest food and beverage company',
      '• Apply on: Nestlé careers portal',
      '',
      'This listing is part of Nestlé’s official Swiss careers feed. Review the role requirements, team context, contract details, and application instructions directly on the Nestlé job page before applying. The position is kept in this dataset only while the official careers portal keeps the requisition active.',
    ].join('\n');
    const descriptionText = wordCount(detailDescription) >= 50 ? detailDescription : fallbackDescription;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} nestle ch`);
    const stableId = listing.jobReqId || createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `nestle-${stableId}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: NESTLE_COMPANY_NAME,
      companyKey: NESTLE_KEY,
      companyDomain: NESTLE_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'Nestlé Switzerland Dedicated Parser (Workday)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(listing.timeType || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Food / Beverage',
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedAt || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total Nestlé jobs discovered: ${jobs.length}`);
  return jobs;
}
