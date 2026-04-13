#!/usr/bin/env node
/**
 * localsearch job parser — Jobylon embed page fetcher and job builder.
 *
 * localsearch uses Jobylon (company ID 3174) for their career portal.
 * Strategy:
 *   1. Fetch the Jobylon embed page to get all jobs as embedded JS data
 *   2. Fetch each detail page on emp.jobylon.com to extract JSON-LD
 *
 * Source: https://karriere.localsearch.ch/en/
 * Data:   https://cdn.jobylon.com/jobs/companies/3174/embed/v2/
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

const JOBYLON_EMBED_URL = 'https://cdn.jobylon.com/jobs/companies/3174/embed/v2/';
const JOBYLON_DETAIL_BASE = 'https://emp.jobylon.com';
const CAREER_URL = 'https://karriere.localsearch.ch/en/';

export const LOCALSEARCH_KEY = 'localsearch';
export const LOCALSEARCH_COMPANY_NAME = 'localsearch';
export const LOCALSEARCH_COMPANY_DOMAIN = 'localsearch.ch';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to localsearch.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isLocalsearchJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === LOCALSEARCH_KEY ||
    key.startsWith('localsearch') ||
    company.includes('localsearch') ||
    url.includes('localsearch.ch')
  );
}

/**
 * Validate that a URL belongs to localsearch's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'localsearch.ch' || host.endsWith('.localsearch.ch') ||
      host === 'emp.jobylon.com' || host === 'cdn.jobylon.com';
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '', func = '') {
  const t = normalize(`${title} ${func}`);
  if (/\b(ingegner|engineer|entwickl|developer|software|programm|data|cloud|devops)/.test(t)) return 'IT';
  if (/\b(techni|tecnic|mecanic|elektr|install)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce|verkäufer|aussendienst|innendienst|success|berater|consultant)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(hr|human|risorse|personal|recruit|talent)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz|content|seo|campaign)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ|controlling)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht|compliance)/.test(t)) return 'Legale';
  if (/\b(kundendienst|customer|support|service)/.test(t)) return 'Commerciale';
  if (/\b(product\s*manag|produktmanag)/.test(t)) return 'IT';
  return 'Altro';
}

function detectExperienceLevel(title = '', experience = '') {
  const t = normalize(`${title} ${experience}`);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|studentisch)/.test(t)) return 'intern';
  if (/\b(junior|jr|einsteig|entry)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|principal)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(empType = '') {
  const t = normalize(empType);
  if (t.includes('teilzeit') || t.includes('part')) return 'PART_TIME';
  if (t.includes('vollzeit') || t.includes('full')) return 'FULL_TIME';
  if (t.includes('praktikum') || t.includes('studentisch') || t.includes('intern')) return 'INTERN';
  return 'FULL_TIME';
}

/* ── Jobylon Client ──────────────────────────────────────── */

/**
 * Fetch page content as text.
 */
async function fetchPage(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
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
 * Parse embedded job data from the Jobylon embed page.
 * The page contains a JS array: JBL.embed_v2['jobs'] = [...];
 */
function parseJobylonEmbed(html) {
  const match = html.match(/JBL\.embed_v2\['jobs'\]\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) return [];

  try {
    // Jobylon uses JS object notation (unquoted keys), so we use Function() to parse
    // eslint-disable-next-line no-new-func
    const jobs = new Function(`return ${match[1]}`)();
    return Array.isArray(jobs) ? jobs : [];
  } catch {
    return [];
  }
}

/**
 * Extract JSON-LD from a Jobylon detail page for richer description.
 */
function extractJsonLd(html) {
  const ldMatch = html.match(
    /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!ldMatch) return null;

  try {
    const cleaned = ldMatch[1].replace(/[\x00-\x1f]/g, ' ');
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

/**
 * Detect language code from Jobylon language field.
 */
function mapJobylonLang(lang = '') {
  const l = normalize(lang);
  if (l === 'german' || l === 'de' || l === 'deutsch') return 'de';
  if (l === 'french' || l === 'fr' || l === 'français') return 'fr';
  if (l === 'italian' || l === 'it' || l === 'italiano') return 'it';
  if (l === 'english' || l === 'en') return 'en';
  return 'de';
}

/**
 * Fetch all localsearch jobs from the Jobylon embed page.
 * Returns ParsedJob[] with source-locale fields only.
 */
export async function fetchAllLocalsearchJobs() {
  console.log(`🔍 Fetching localsearch jobs from Jobylon`);
  console.log(`   Embed: ${JOBYLON_EMBED_URL}`);
  console.log(`   Career: ${CAREER_URL}\n`);

  // Step 1: Fetch and parse the Jobylon embed page
  const embedHtml = await fetchPage(JOBYLON_EMBED_URL);
  const listings = parseJobylonEmbed(embedHtml);

  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings found in Jobylon embed.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  // Step 2: For each job, fetch detail page for richer description
  const jobs = [];
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const detailUrl = `${JOBYLON_DETAIL_BASE}${listing.url}`;
    console.log(`  📄 Fetching detail: ${title}`);

    let descriptionText = normalizeSpace(listing.summary || '');
    let datePosted = listing.published_date || '';

    try {
      const detailHtml = await fetchPage(detailUrl);
      const jsonLd = extractJsonLd(detailHtml);

      if (jsonLd?.description) {
        descriptionText = stripHtml(jsonLd.description);
      }
      if (jsonLd?.datePosted) {
        datePosted = jsonLd.datePosted.split('T')[0];
      }
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed for ${title}: ${err?.message || err}`);
    }

    const city = (listing.locations || [])[0] || listing.locations_text || 'Zürich';
    const canton = inferAnyCanton(city) || 'ZH';
    const sourceLang = mapJobylonLang(listing.language);
    const jobSlug = slugify(`${title} localsearch ch`);
    const publicUrl = detailUrl;
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const empType = detectEmploymentType(listing.employment_type || '');

    const job = {
      // ── Required fields ──
      id: `localsearch-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: LOCALSEARCH_COMPANY_NAME,
      companyKey: LOCALSEARCH_KEY,
      companyDomain: LOCALSEARCH_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — localsearch`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — localsearch` },
      location: city,
      canton,
      url: publicUrl,
      source: 'localsearch Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, listing.function || ''),
      contract: empType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: empType,
      experienceLevel: detectExperienceLevel(title, listing.experience || ''),
      sector: 'Marketing digitale / Tecnologia',
      currency: 'CHF',
      featured: false,
      postedDate: datePosted || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    console.log(`  ✅ ${title} — ${city} (${sourceLang})`);

    await new Promise((r) => setTimeout(r, 300));
  }

  // Deduplicate by URL
  const seen = new Set();
  const deduped = [];
  for (const job of jobs) {
    const key = job.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(job);
  }

  console.log(`\n📋 Total localsearch jobs discovered: ${deduped.length}`);
  return deduped;
}
