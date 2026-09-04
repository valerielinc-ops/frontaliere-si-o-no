#!/usr/bin/env node
/**
 * lepatron job parser — Fetcher and job builder.
 *
 * Source: https://careers.orior.ch/go/Le-Patron/4574301/
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllCareersJobs()  — Fetch and parse all jobs
 *   - isCareersJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { detectLang } from './dedicated-crawler-common.mjs';
import { fetchHtml, slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { assertRssChannelItems } from './assert-json-list-shape.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const CAREERS_KEY = 'careers';
export const CAREERS_COMPANY_NAME = 'lepatron';
export const CAREERS_COMPANY_DOMAIN = 'careers.orior.ch';

const CAREERS_RSS_URL = 'https://careers.orior.ch/services/rss/category/?catid=4574301';
const MAX_ITEM_DROP_RATIO = 0.5;
const RSS_ITEM_STATS = Symbol('careersRssItemStats');
const CAREERS_EMPTY_RSS_CHANNEL_KEYS = new Set([
  '#text',
  'atom:link',
  'description',
  'image',
  'language',
  'lastBuildDate',
  'link',
  'title',
  'ttl',
]);

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to lepatron.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isCareersJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === CAREERS_KEY ||
    key.startsWith('careers') ||
    company.includes('lepatron') ||
    url.includes('careers.orior.ch')
  );
}

/**
 * Validate that a URL belongs to lepatron's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'careers.orior.ch' || host.endsWith('.careers.orior.ch');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mechan|mecanic|elektr|install|instandhalt)/.test(t)) return 'Tecnica';
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
  const percentage = t.match(/\b(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?\s*%/);
  if (percentage) {
    const maximum = Number(percentage[2] || percentage[1]);
    return maximum >= 80 ? 'FULL_TIME' : 'PART_TIME';
  }
  return 'OTHER';
}

/* ── Official ORIOR RSS feed ────────────────────────────────── */

function canonicalizeCareersRssUrl(rawUrl = '') {
  try {
    const url = new URL(stripHtml(rawUrl));
    if (!isTrustedDomain(url.toString()) || !/^\/job\/[^/]+\/\d+\/?$/.test(url.pathname)) return '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

class CareersRssItemError extends Error {}

function readCareersRssScalar(item, field, itemNumber) {
  const value = item?.[field];
  if (typeof value !== 'string') {
    throw new CareersRssItemError(
      `Le Patron RSS item ${itemNumber} ${field} must be a single scalar string`,
    );
  }
  return value;
}

function assertDropRatioWithinLimit(total, dropped) {
  if (!dropped || total <= 0 || dropped / total <= MAX_ITEM_DROP_RATIO) return;
  const percentage = Math.round((dropped / total) * 100);
  throw new Error(
    `[careers-rss-drop-ratio] dropped ${dropped}/${total} eligible items (${percentage}%, max 50%)`,
  );
}

function isGenericCareersApplication(title = '') {
  return /^(?:spontanbewerbung|initiativbewerbung|candidature spontan(?:e|ée)|candidatura spontanea|unsolicited application|general application|generic application)(?:$|\s*[-:–—])/u
    .test(normalize(title));
}

/**
 * Parse the official SuccessFactors RSS feed.
 *
 * ORIOR publishes the source location in the title suffix and the full job
 * description in each item. Keeping those fields here avoids the fabricated
 * Lugano/TI fallback that previously misclassified every Le Patron vacancy.
 */
export function parseCareersRss(xml = '') {
  if (typeof xml !== 'string') {
    throw new Error('Le Patron RSS feed must be an XML string');
  }
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    const detail = validation?.err?.msg || validation?.err?.code || 'invalid XML';
    throw new Error(`Le Patron RSS feed is not well-formed XML: ${detail}`);
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseTagValue: false,
    trimValues: false,
    processEntities: false,
  });

  let parsed;
  try {
    parsed = parser.parse(xml);
  } catch (err) {
    throw new Error(`Le Patron RSS feed failed to parse as XML: ${err?.message || err}`);
  }
  if (parsed?.rss?.channel == null) {
    throw new Error('Le Patron RSS feed is missing the rss.channel envelope');
  }

  const channels = Array.isArray(parsed.rss.channel) ? parsed.rss.channel : [parsed.rss.channel];
  channels.forEach((channel, index) => {
    if (channel === '') return;
    if (channel == null || typeof channel !== 'object' || Array.isArray(channel)) {
      throw new Error(`Le Patron RSS channel ${index + 1} must be an object`);
    }

    if (Object.prototype.hasOwnProperty.call(channel, 'item')) {
      const item = channel.item;
      if (item == null || typeof item !== 'object') {
        throw new Error(
          `Le Patron RSS channel ${index + 1} rss.channel.item must be an object or array`,
        );
      }
      return;
    }

    const unexpectedKeys = Object.keys(channel).filter(
      (key) => !CAREERS_EMPTY_RSS_CHANNEL_KEYS.has(key),
    );
    if (unexpectedKeys.length) {
      throw new Error(
        `Le Patron RSS feed has unexpected channel element: ${unexpectedKeys.join(', ')}`,
      );
    }
  });

  const items = assertRssChannelItems(parsed, { source: CAREERS_KEY });
  let ignoredItems = 0;
  let malformedItems = 0;
  const validItems = items.map((item, index) => {
    const itemNumber = index + 1;
    try {
      const rawTitle = normalizeSpace(stripHtml(readCareersRssScalar(item, 'title', itemNumber)));
      const parsedTitleLocation = rawTitle.match(/^(.*?)\s+\(([^,()]+),\s*([A-Z]{2})\)\s*$/u);
      const title = normalizeSpace(parsedTitleLocation?.[1] || rawTitle);
      if (isGenericCareersApplication(title)) {
        ignoredItems++;
        return null;
      }

      const location = normalizeSpace(parsedTitleLocation?.[2] || '');
      const locationWithRegion = `${location}, ${parsedTitleLocation?.[3] || ''}`;
      const canton = inferSwissTargetCanton(locationWithRegion) || '';
      const url = canonicalizeCareersRssUrl(readCareersRssScalar(item, 'link', itemNumber));
      const description = stripHtml(readCareersRssScalar(item, 'description', itemNumber));
      const posted = new Date(normalizeSpace(readCareersRssScalar(item, 'pubDate', itemNumber)));
      const postedDate = Number.isNaN(posted.getTime()) ? '' : posted.toISOString().slice(0, 10);

      const missing = [
        !title && 'title',
        !url && 'canonical URL',
        !location && 'location',
        !canton && 'Swiss canton',
        !description && 'description',
        !postedDate && 'publication date',
      ].filter(Boolean);
      if (missing.length) {
        throw new CareersRssItemError(`Le Patron RSS item ${itemNumber} is missing ${missing.join(', ')}`);
      }

      return { title, url, location, canton, description, postedDate };
    } catch (err) {
      // Only declared item-data failures are recoverable. Unexpected code or
      // parser errors must still abort the feed instead of dropping every row.
      if (!(err instanceof CareersRssItemError)) throw err;
      malformedItems++;
      // Per-item fail-closed guard (data-quality invariant), NOT a feed-shape
      // guard: a single degenerate item (e.g. a Spontanbewerbung variant that
      // drops the `(City, XX)` suffix) must not zero out every other valid
      // vacancy in the channel. Feed-shape drift (missing envelope, malformed
      // XML, renamed elements) still throws above, before this map.
      console.warn(`⚠️ Le Patron RSS item ${itemNumber} skipped: ${err?.message || err}`);
      return null;
    }
  }).filter(Boolean);

  Object.defineProperty(validItems, RSS_ITEM_STATS, {
    value: { total: items.length - ignoredItems, dropped: malformedItems },
  });
  return validItems;
}

async function fetchJobListings() {
  const xml = await fetchHtml(CAREERS_RSS_URL, {
    headers: { Accept: 'application/rss+xml,application/xml,text/xml,*/*' },
  });
  return parseCareersRss(xml);
}

/**
 * Fetch all lepatron jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllCareersJobs() {
  console.log(`🔍 Fetching lepatron jobs`);
  console.log(`   Source: ${CAREERS_RSS_URL}\n`);

  const listings = await fetchJobListings();
  const rssItemStats = listings?.[RSS_ITEM_STATS];
  if (rssItemStats) assertDropRatioWithinLimit(rssItemStats.total, rssItemStats.dropped);
  if (!listings || listings.length === 0) {
    console.warn('⚠️ The valid Le Patron RSS channel currently has no job items.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const location = listing.location;
    const canton = listing.canton;
    const descriptionHtml = listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} careers ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `careers-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CAREERS_COMPANY_NAME,
      companyKey: CAREERS_KEY,
      companyDomain: CAREERS_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'lepatron Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(`${title} ${descriptionText}`),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Alimentare',
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedDate,
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total lepatron jobs discovered: ${jobs.length}`);
  return jobs;
}
