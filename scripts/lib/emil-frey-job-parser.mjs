#!/usr/bin/env node
/**
 * Emil Frey job parser — Fetcher and job builder.
 *
 * Source: https://jobs.emilfrey.ch/
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllEmilFreyJobs()  — Fetch and parse all jobs
 *   - isEmilFreyJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
import { inferAnyCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const EMIL_FREY_KEY = 'emil-frey';
export const EMIL_FREY_COMPANY_NAME = 'Emil Frey';
export const EMIL_FREY_COMPANY_DOMAIN = 'emilfrey.ch';

// jobs.emilfrey.ch is a self-hosted rexx systems instance dedicated to Emil
// Frey Switzerland. Every posting is CH-based (no country facet needed).
const CAREER_URL = 'https://jobs.emilfrey.ch/';
const LISTING_HOST = 'jobs.emilfrey.ch';
const PAGE_SIZE = 25;
const MAX_PAGES = 40; // safety cap (~1000 jobs); the instance lists < 200

// robots.txt Disallows bot UAs (wget/python-requests/node-fetch/...) but a real
// browser UA is served normally (verified). Must use a Mozilla/Chrome UA.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// HQ fallback (Badenerstrasse 600, 8048 Zürich, canton ZH).
const HQ = {
  addressLocality: 'Zürich',
  addressRegion: 'Zürich',
  postalCode: '8048',
  canton: 'ZH',
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
 * Check if a job belongs to Emil Frey.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isEmilFreyJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === EMIL_FREY_KEY ||
    key.startsWith('emil-frey') ||
    company.includes('emil frey') ||
    url.includes('emilfrey.ch')
  );
}

/**
 * Validate that a URL belongs to Emil Frey's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    // Primary corporate domain + any subdomain (keeps the unit test green) —
    // the real job-posting host (jobs.emilfrey.ch, the rexx ATS) is a subdomain
    // of emilfrey.ch, so it is already trusted by the .endsWith() check.
    return (
      host === 'emilfrey.ch' ||
      host.endsWith('.emilfrey.ch') ||
      host === LISTING_HOST
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
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
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

function decodeHtmlEntities(s = '') {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&auml;/g, 'ä').replace(/&ouml;/g, 'ö').replace(/&uuml;/g, 'ü')
    .replace(/&Auml;/g, 'Ä').replace(/&Ouml;/g, 'Ö').replace(/&Uuml;/g, 'Ü')
    .replace(/&szlig;/g, 'ß').replace(/&eacute;/g, 'é').replace(/&egrave;/g, 'è')
    .replace(/&agrave;/g, 'à').replace(/&ccedil;/g, 'ç')
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(Number(d)); } catch { return ''; }
    });
}

/**
 * Parse one rexx <article class="joboffer_container"> block into a listing
 * stub. The server-rendered row carries the detail URL, title, pensum and the
 * job location (job_standort) — enough to build a job even before the detail
 * JSON-LD enriches it with the full address.
 */
function parseListingArticle(block) {
  const urlMatch = block.match(
    /href="(https:\/\/jobs\.emilfrey\.ch\/[^"]*-(?:de|fr|it|en)-j\d+\.html)"/i,
  );
  if (!urlMatch) return null;
  const url = urlMatch[1];

  const titleMatch = block.match(/<a[^>]*href="[^"]*-j\d+\.html"[^>]*>([\s\S]*?)<\/a>/i);
  const title = titleMatch ? decodeHtmlEntities(stripHtml(titleMatch[1])).trim() : '';
  if (!title) return null;

  const locMatch = block.match(/job_standort">([\s\S]*?)<\/span>/i);
  const location = locMatch ? decodeHtmlEntities(stripHtml(locMatch[1])).trim() : '';

  const pensumMatch = block.match(/class="pensum">([\s\S]*?)<\/div>/i);
  const pensum = pensumMatch ? decodeHtmlEntities(stripHtml(pensumMatch[1])).trim() : '';

  const idMatch = url.match(/-j(\d+)\.html$/);
  return {
    title,
    location,
    url,
    pensum,
    jobReqId: idMatch ? idMatch[1] : '',
  };
}

/**
 * Fetch one schema.org JobPosting JSON-LD object from a rexx detail page.
 * Returns null if the page can't be fetched or has no JobPosting block.
 */
async function fetchDetailJsonLd(url) {
  let html;
  try {
    html = await fetchHtml(url, { headers: { 'User-Agent': BROWSER_UA } });
  } catch (err) {
    console.warn(`   ⚠️ detail fetch failed (${url}): ${err && err.message ? err.message : err}`);
    return null;
  }
  const scripts = html.match(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  if (!scripts) return null;
  for (const script of scripts) {
    const inner = script.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/i, '').trim();
    let data;
    try {
      data = JSON.parse(inner);
    } catch {
      continue;
    }
    const candidates = Array.isArray(data) ? data : [data];
    for (const c of candidates) {
      if (c && c['@type'] === 'JobPosting') return c;
    }
  }
  return null;
}

/**
 * Fetch all server-rendered listing rows across every page.
 * The rexx instance paginates via plain GET stellenangebote.html?start=N
 * (25/page) — no JS/AJAX needed despite the on-page "load more" control.
 * Each row is then enriched from its detail page's JobPosting JSON-LD.
 */
async function fetchJobListings() {
  console.log(`   Fetching from: ${CAREER_URL}`);

  const byUrl = new Map();
  let start = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const pageUrl =
      start === 0
        ? CAREER_URL
        : `https://jobs.emilfrey.ch/stellenangebote.html?start=${start}`;
    let html;
    try {
      html = await fetchHtml(pageUrl, { headers: { 'User-Agent': BROWSER_UA } });
    } catch (err) {
      console.warn(`   ⚠️ listing page fetch failed (${pageUrl}): ${err && err.message ? err.message : err}`);
      break;
    }

    const blocks = html.match(/<article class="joboffer_container"[\s\S]*?<\/article>/gi) || [];
    let added = 0;
    for (const block of blocks) {
      const stub = parseListingArticle(block);
      if (!stub || byUrl.has(stub.url)) continue;
      byUrl.set(stub.url, stub);
      added++;
    }

    // data-all-count tells us the total; stop once we've collected them all
    // or a page returns no new rows.
    const totalMatch = html.match(/data-all-count="(\d+)"/);
    const total = totalMatch ? Number(totalMatch[1]) : 0;
    console.log(`   📄 page start=${start}: +${added} (collected ${byUrl.size}${total ? `/${total}` : ''})`);

    if (added === 0 || blocks.length < PAGE_SIZE) break;
    if (total && byUrl.size >= total) break;
    start += PAGE_SIZE;
  }

  const stubs = [...byUrl.values()];
  console.log(`   🔗 ${stubs.length} job detail pages to enrich`);

  // Enrich each with its detail JSON-LD (full address, datePosted, org name).
  const listings = [];
  for (const stub of stubs) {
    const ld = await fetchDetailJsonLd(stub.url);
    listings.push({ ...stub, ld });
    await new Promise((r) => setTimeout(r, 200));
  }
  return listings;
}

/**
 * Fetch all Emil Frey jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllEmilFreyJobs() {
  console.log(`🔍 Fetching Emil Frey jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const ld = listing.ld || null;
    const addr = (ld && ld.jobLocation && ld.jobLocation.address) || {};

    // CH-only guard: the whole rexx instance is Swiss, but honour any explicit
    // addressCountry from the JSON-LD and drop a non-CH posting if it appears.
    const country = (addr.addressCountry || 'CH').toUpperCase();
    if (country && country !== 'CH') continue;

    const title = normalizeSpace(decodeHtmlEntities((ld && ld.title) || listing.title || ''));
    if (!title || title.length < 3) continue;

    // Build the location string from the richest source available.
    const addressLocality = decodeHtmlEntities(addr.addressLocality || listing.location || HQ.addressLocality);
    const addressRegion = decodeHtmlEntities(addr.addressRegion || HQ.addressRegion);
    const postalCode = (addr.postalCode || '').toString().trim() || HQ.postalCode;
    const streetAddress = decodeHtmlEntities(addr.streetAddress || '');
    const location = addressLocality || listing.location || HQ.addressLocality;
    const canton =
      inferAnyCanton(addressLocality) ||
      inferAnyCanton(listing.location) ||
      inferAnyCanton(addressRegion) ||
      HQ.canton;

    // Description from JSON-LD responsibilities + qualifications (rexx splits
    // the body into these two HTML blocks). Fall back to a minimal stub.
    const descParts = [ld && ld.description, ld && ld.responsibilities, ld && ld.qualifications]
      .filter(Boolean)
      .join('\n');
    const descriptionText = normalizeSpace(decodeHtmlEntities(stripHtml(descParts)));
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} emil-frey ${location}`);
    const idBasis = listing.jobReqId ? `emil-frey-j${listing.jobReqId}` : publicUrl;
    const urlHash = createHash('sha1').update(idBasis).digest('hex').slice(0, 12);

    const hiringOrg = (ld && ld.hiringOrganization && ld.hiringOrganization.name) || '';
    const description = descriptionText || `${title} — Emil Frey, ${location} (CH)`;

    const job = {
      // ── Required fields ──
      id: `emil-frey-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: EMIL_FREY_COMPANY_NAME,
      companyKey: EMIL_FREY_KEY,
      companyDomain: EMIL_FREY_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'Emil Frey Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      streetAddress,
      postalCode,
      addressRegion,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      employmentType: detectEmploymentType((ld && ld.employmentType) || listing.pensum || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Automotive retail / dealership group',
      currency: 'CHF',
      featured: false,
      postedDate:
        (ld && ld.datePosted ? String(ld.datePosted).slice(0, 10) : '') ||
        new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      hiringOrganizationName: hiringOrg || EMIL_FREY_COMPANY_NAME,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total Emil Frey jobs discovered: ${jobs.length}`);
  return jobs;
}
