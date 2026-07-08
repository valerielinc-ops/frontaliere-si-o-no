#!/usr/bin/env node
/**
 * Riri Group job parser — Fetcher and job builder.
 *
 * Source: https://careers.oerlikon.com/search/?q=riri (RSS feed:
 * https://careers.oerlikon.com/services/rss/job/?locale=en_US&keywords=(riri))
 *
 * ── Root cause (#3797) ─────────────────────────────────────────────────
 * The old seed, https://www.rfriri.com/en/careers/, is NXDOMAIN — a typo
 * baked into the original seed (an extra "rf" prefix on the real, live
 * brand domain riri.com). Riri Group (luxury zipper manufacturer, HQ
 * Mendrisio TI) was acquired by Oerlikon and now recruits exclusively
 * through the parent group's SAP SuccessFactors Career Site Builder at
 * careers.oerlikon.com. That tenant exposes a classic jobs2web RSS 2.0
 * feed (one <item> per requisition, filterable via ?keywords=) — far more
 * reliable than scraping the JS-rendered search-results page (confirmed:
 * the page's own <link rel="alternate" type="application/rss+xml"> tag
 * advertises this exact feed URL for a "riri" keyword search).
 *
 * Confirmed live: the "riri" keyword feed returns 9 requisitions across
 * the wider Riri Group manufacturing network (Italy, France, Switzerland)
 * — only one is Swiss: "Customer Service Specialist - Riri Zippers" in
 * Mendrisio TI. Since this job board is Ticino/Switzerland-focused, we
 * filter to Swiss postings only.
 *
 * The feed carries no separate location field (unlike some other
 * jobs2web tenants in this codebase, e.g. Komax) — every title instead
 * ends in a "(City[, Region], CountryCode, Postal)" suffix, which we
 * parse to recover structured location + a Swiss/non-Swiss flag.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllRiriJobs()  — Fetch and parse all jobs
 *   - isRiriJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()   — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, buildJobSlug, stripHtml, normalizeSpace, fetchHtml } from './crawler-template.mjs';
import { decodeHtmlEntities } from './decode-html-entities.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const RIRI_KEY = 'riri';
export const RIRI_COMPANY_NAME = 'Riri Group';
// riri.com is the real, live brand domain (confirmed HTTP 200). The old
// seed's host, rfriri.com, is a typo (extra "rf" prefix) — NXDOMAIN, never
// a real Riri Group domain.
export const RIRI_COMPANY_DOMAIN = 'riri.com';

const CAREER_URL = 'https://careers.oerlikon.com/search/?q=riri';
const FEED_URL = 'https://careers.oerlikon.com/services/rss/job/?locale=en_US&keywords=(riri)';
const HQ = getCompanyDefaults('riri');

export const MIN_DESC_LENGTH = 100;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Riri Group.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isRiriJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === RIRI_KEY ||
    key.startsWith('riri') ||
    company.includes('riri group') ||
    url.includes('riri.com') ||
    // Riri's real postings are hosted on the parent Oerlikon Group's shared
    // ATS tenant — match only Oerlikon URLs that are actually Riri postings
    // (distinguishable by "riri" in the job-req slug), not every Oerlikon job.
    (url.includes('oerlikon.com') && url.includes('riri'))
  );
}

/**
 * Validate that a URL belongs to Riri Group's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    // Riri Group's own brand domain, plus the parent Oerlikon Group's shared
    // SuccessFactors ATS tenant, where the real job postings live.
    return (
      host === 'riri.com' || host.endsWith('.riri.com') ||
      host === 'oerlikon.com' || host.endsWith('.oerlikon.com')
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
  if (/\b(vendita|sales|verkauf|commerce|customer service|servizio clienti)/.test(t)) return 'Commerciale';
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

/* ── Feed Parsing ─────────────────────────────────────────── */

function extractTag(itemXml, tag) {
  const m = itemXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1] : '';
}

function extractCdataOrText(itemXml, tag) {
  const cdata = itemXml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, 'i'));
  if (cdata) return cdata[1];
  return extractTag(itemXml, tag);
}

/**
 * Oerlikon's jobs2web RSS feed appends a "(City[, Region], CountryCode,
 * [Postal])" suffix to every job title — e.g. "(Mendrisio, TI, CH, 6850)"
 * or "(Tirano, IT, 23037)". We use it to recover structured location data
 * and a reliable Swiss/non-Swiss flag, since the feed carries no separate
 * location field (unlike some other jobs2web tenants in this codebase,
 * e.g. Komax's <g:location>).
 */
function parseTitleLocation(rawTitle = '') {
  const m = rawTitle.match(/\(([^()]+)\)\s*$/);
  if (!m) return { title: rawTitle.trim(), city: '', canton: '', postalCode: '', isSwiss: false };
  const title = rawTitle.slice(0, m.index).trim() || rawTitle.trim();
  const parts = m[1].split(',').map((p) => p.trim()).filter(Boolean);
  const isSwiss = parts.some((p) => /^ch$/i.test(p));
  const city = parts[0] || '';
  const canton = parts.find((p) => /^[a-z]{2}$/i.test(p) && !/^ch$/i.test(p)) || '';
  const postalCode = parts.find((p) => /^\d[\d-]*$/.test(p)) || '';
  return { title, city, canton: canton.toUpperCase(), postalCode, isSwiss };
}

function parseFeedItems(xml = '') {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const itemXml = m[1];
    const rawTitle = decodeHtmlEntities(normalizeSpace(extractCdataOrText(itemXml, 'title')));
    const descriptionHtml = decodeHtmlEntities(extractCdataOrText(itemXml, 'description'));
    const url = decodeHtmlEntities(normalizeSpace(extractTag(itemXml, 'link')));
    const guid = decodeHtmlEntities(normalizeSpace(extractTag(itemXml, 'guid')));
    if (!rawTitle || !url) continue;
    items.push({ rawTitle, descriptionHtml, url, guid });
  }
  return items;
}

async function fetchJobListings() {
  const xml = await fetchHtml(FEED_URL, { headers: { Accept: 'application/rss+xml,text/xml,*/*' } });
  return parseFeedItems(xml);
}

/* ── Main fetch function ──────────────────────────────────── */

/**
 * Fetch all Riri Group jobs. Returns ParsedJob[] (source locale only).
 */
export async function fetchAllRiriJobs() {
  console.log(`  Fetching Riri Group jobs from ${FEED_URL}`);

  let listings = [];
  try {
    listings = await fetchJobListings();
  } catch (err) {
    console.warn(`  Failed to fetch ${FEED_URL}: ${err.message}`);
    return [];
  }
  console.log(`  Listings found (all Riri Group manufacturing sites): ${listings.length}`);
  if (!listings.length) return [];

  const jobs = [];
  for (const listing of listings) {
    const { title, city, canton: parsedCanton, postalCode: feedPostalCode, isSwiss } = parseTitleLocation(listing.rawTitle);
    // This job board is Ticino/Switzerland-focused — the "riri" keyword
    // feed also returns Riri Group's Italy/France manufacturing sites,
    // which we intentionally skip.
    if (!isSwiss) continue;
    if (!title || title.length < 3) continue;

    const descriptionText = stripHtml(listing.descriptionHtml || '');
    const location = city || HQ.city;
    const canton = parsedCanton || HQ.canton;
    const sourceLang = detectLang(title + ' ' + descriptionText, 'it');
    const jobSlug = buildJobSlug(`${title} ${location}`, 'riri');
    const urlHash = createHash('sha1').update(listing.url || listing.guid || title).digest('hex').slice(0, 12);

    jobs.push({
      id: `${RIRI_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: RIRI_COMPANY_NAME,
      companyKey: RIRI_KEY,
      companyDomain: RIRI_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — Riri Group`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — Riri Group` },
      location,
      canton,
      addressLocality: location,
      addressRegion: HQ.addressRegion,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: feedPostalCode || HQ.postalCode,
      category: detectCategory(title),
      sector: 'Manifatturiero / Moda',
      contract: detectEmploymentType(title + ' ' + descriptionText) === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: detectEmploymentType(title + ' ' + descriptionText),
      experienceLevel: detectExperienceLevel(title),
      featured: false,
      postedDate: new Date().toISOString().slice(0, 10),
      url: listing.url || CAREER_URL,
      applyUrl: listing.url || CAREER_URL,
      source: 'Riri Group Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
    });
  }

  console.log(`  Total Riri Group jobs discovered (Switzerland only): ${jobs.length}`);
  return jobs;
}
