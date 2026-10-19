#!/usr/bin/env node
/**
 * Stiftung BACHTELEN — Grenchen (SO).
 *
 * Special-education + residential treatment foundation for children and
 * young adults in the canton of Solothurn (Kindertagesstätten, Tagesschulen,
 * Wohnangebote, individuelle Förderung, Therapie & Beratung).
 *
 * The former WP Job Manager endpoint was retired. The live career page now
 * renders its vacancy links server-side at `/arbeiten-bei-uns/`, with one
 * detail page per vacancy at `/stelle/{slug}/`.
 *
 * Source language is German. Location metadata is read from the short header
 * on each detail page when it is present; Grenchen (SO) remains the safe HQ
 * default for older or incomplete postings.
 */
import { sourcePostingDateCandidatesFields } from './source-posting-date.mjs';
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  htmlToText,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';
import { extractJobPostingLd } from './jsonld-jobposting.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

export const BACHTELEN_KEY = 'bachtelen';
export const BACHTELEN_COMPANY_NAME = 'Stiftung Bachtelen';
export const BACHTELEN_COMPANY_DOMAIN = 'bachtelen.ch';

const PUBLIC_CAREER_URL = 'https://www.bachtelen.ch/arbeiten-bei-uns/';
const SITE_ORIGIN = 'https://www.bachtelen.ch';
const DETAIL_DELAY_MS = 250;
const DETAIL_PATH_RE = /^\/stelle\/[^/?#]+\/?$/i;

const DEFAULT_CITY = 'Grenchen';
const DEFAULT_CANTON = 'SO';
const DEFAULT_POSTAL = '2540';

// These are locations currently exposed by Bachtelen's own vacancy header.
// Matching is deliberately limited to a location field/header, never to the
// full description, so an ordinary place mention cannot become an address.
const LOCATION_HINTS = [
  { name: 'Grenchen', canton: 'SO', postal: '2540' },
  { name: 'Hägendorf', canton: 'SO', postal: '4614' },
  { name: 'Solothurn', canton: 'SO', postal: '4500' },
];

function readAttribute(attributes, name) {
  const attributeRe = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    'i',
  );
  const match = String(attributes || '').match(attributeRe);
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? '').trim() : '';
}

function canonicalDetailUrl(rawUrl = '') {
  let parsed;
  try {
    parsed = new URL(rawUrl, PUBLIC_CAREER_URL);
  } catch {
    return '';
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== 'www.bachtelen.ch' && host !== 'bachtelen.ch') return '';
  if (!DETAIL_PATH_RE.test(parsed.pathname)) return '';
  parsed.search = '';
  parsed.hash = '';
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
  return `${SITE_ORIGIN}${parsed.pathname}`;
}

function locationParts(rawLocation = '') {
  const value = normalizeSpace(rawLocation)
    .replace(/[|•]/g, ' ')
    .replace(/\s*\(([A-Za-z]{2})\)\s*$/u, '')
    .trim();
  if (!value) return [];
  return value
    .split(/\s+(?:und|\/|,)\s+/i)
    .map((part) => normalizeSpace(part))
    .filter(Boolean);
}

function isKnownLocationLine(rawLine = '') {
  const parts = locationParts(rawLine);
  return parts.length > 0
    && parts.length <= 3
    && parts.every((part) => LOCATION_HINTS.some((hint) => hint.name.toLowerCase() === part.toLowerCase()));
}

function locationLineFromText(text = '') {
  return String(text || '')
    .split('\n')
    .map((line) => normalizeSpace(line))
    .find((line) => isKnownLocationLine(line)) || '';
}

function pickLocationHints(rawLocation = '') {
  const location = normalizeSpace(rawLocation);
  if (!location) return { city: DEFAULT_CITY, canton: DEFAULT_CANTON, postal: DEFAULT_POSTAL };

  const parts = locationParts(location);
  const matched = parts
    .map((part) => LOCATION_HINTS.find((hint) => hint.name.toLowerCase() === part.toLowerCase()))
    .filter(Boolean);
  const distinct = [...new Map(matched.map((hint) => [hint.name, hint])).values()];
  if (distinct.length === 1) {
    return { city: location, canton: distinct[0].canton, postal: distinct[0].postal };
  }
  if (distinct.length > 1) {
    return {
      city: location,
      canton: distinct.every((hint) => hint.canton === distinct[0].canton) ? distinct[0].canton : DEFAULT_CANTON,
      postal: '',
    };
  }

  // A short, explicit location field may grow a new municipality before this
  // parser's postal map does. The canton helper is safe here because the
  // caller supplied a location field, not arbitrary vacancy prose.
  const inferred = inferSwissTargetCanton(location);
  return inferred
    ? { city: location, canton: inferred, postal: '' }
    : { city: DEFAULT_CITY, canton: DEFAULT_CANTON, postal: DEFAULT_POSTAL };
}

export function isBachtelenJob(job) {
  const url = String(job?.url || '').toLowerCase();
  const key = String(job?.companyKey || '').toLowerCase();
  const company = String(job?.company || '').toLowerCase();
  return (
    key === BACHTELEN_KEY ||
    url.includes('bachtelen.ch') ||
    company.includes('bachtelen')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'bachtelen.ch' || host.endsWith('.bachtelen.ch');
  } catch {
    return false;
  }
}

/** Extract the server-rendered `/stelle/` detail links from the career page. */
export function parseListingPage(html = '') {
  const out = [];
  const seen = new Set();
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(String(html || ''))) !== null) {
    const url = canonicalDetailUrl(readAttribute(match[1], 'href'));
    if (!url || seen.has(url)) continue;
    seen.add(url);

    // The listing card places its heading and location immediately before the
    // "Weitere Infos" anchor. Keep them as a fallback if the detail page is
    // missing those optional header fields.
    const before = String(html || '').slice(Math.max(0, match.index - 2200), match.index);
    const headings = [...before.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)];
    const heading = headings.at(-1)?.[1] || '';
    const headingTitle = normalizeSpace(htmlToText(heading));
    const headingStart = headings.at(-1)?.index ?? 0;
    const nearbyText = htmlToText(before.slice(headingStart));
    out.push({
      url,
      title: headingTitle,
      location: locationLineFromText(nearbyText),
    });
  }
  return out;
}

function cleanPageHtml(html = '') {
  return String(html || '')
    .replace(/<header\b[\s\S]*?<\/header>/gi, '')
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, '')
    .replace(/<form\b[\s\S]*?<\/form>/gi, '')
    .replace(/<aside\b[\s\S]*?<\/aside>/gi, '');
}

function findGenericSectionStart(html, fromIndex) {
  const headingRe = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi;
  headingRe.lastIndex = fromIndex;
  let match;
  while ((match = headingRe.exec(html)) !== null) {
    const heading = normalizeSpace(htmlToText(match[1]));
    if (/^(?:unsere benefits|weitere stellen|datenschutz(?:-|\u00a0)?übersicht)/i.test(heading)) {
      return match.index;
    }
  }
  return html.length;
}

/** Extract the title, source body, location header and optional JSON-LD date. */
export function parseJobDetail(html = '') {
  const original = String(html || '');
  const stripped = original
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
  const cleaned = cleanPageHtml(stripped);
  const titleMatch = cleaned.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  let title = titleMatch ? normalizeSpace(htmlToText(titleMatch[1])) : '';
  if (!title) {
    const documentTitle = cleaned.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    title = documentTitle
      ? normalizeSpace(htmlToText(documentTitle[1])).replace(/\s*[|–-]\s*Bachtelen\s*$/i, '')
      : '';
  }
  if (!titleMatch) return { title, description: '', location: '', publication: sourcePostingDateCandidatesFields([]) };

  const bodyStart = titleMatch.index + titleMatch[0].length;
  const bodyEnd = findGenericSectionStart(cleaned, bodyStart);
  const bodyHtml = cleaned.slice(bodyStart, bodyEnd);
  const description = htmlToText(bodyHtml);
  const location = locationLineFromText(description.split('\n').slice(0, 12).join('\n'));
  const posting = extractJobPostingLd(original);
  const publication = sourcePostingDateCandidatesFields([posting?.datePosted]);
  return { title, description, location, publication };
}

export async function fetchAllBachtelenJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  console.log(`🏫 Fetching ${BACHTELEN_COMPANY_NAME} jobs`);
  console.log(`   Source: ${PUBLIC_CAREER_URL} (server-rendered career page)\n`);

  const listingHtml = await fetchHtml(PUBLIC_CAREER_URL, { timeoutMs });
  const listings = parseListingPage(listingHtml);
  console.log(`  📋 ${listings.length} job detail links from career page\n`);
  if (!listings.length) {
    throw new Error(`No Bachtelen job detail links found at ${PUBLIC_CAREER_URL}`);
  }

  const jobs = [];
  for (let index = 0; index < listings.length; index += 1) {
    const listing = listings[index];
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, DETAIL_DELAY_MS));

    let parsed;
    try {
      parsed = parseJobDetail(await fetchHtml(listing.url, { timeoutMs }));
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed for ${listing.url}: ${err?.message || err}`);
      continue;
    }
    if (!parsed.title || !meetsSourceBodyFloor(parsed.description)) {
      console.warn(`  ⚠️ Skip thin or incomplete Bachtelen posting: ${listing.url}`);
      continue;
    }

    const location = parsed.location || listing.location;
    const hints = pickLocationHints(location);
    const sourceLang = detectLang(parsed.description || parsed.title, 'de');
    const jobSlug = slugify(`${parsed.title} ${BACHTELEN_KEY} ${hints.city}`);
    const urlHash = createHash('sha1').update(listing.url).digest('hex').slice(0, 12);
    const employmentType = detectHealthcareEmploymentType(`${parsed.title}\n${parsed.description}`);

    jobs.push({
      id: `${BACHTELEN_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: BACHTELEN_COMPANY_NAME,
      companyKey: BACHTELEN_KEY,
      companyDomain: BACHTELEN_COMPANY_DOMAIN,
      title: parsed.title,
      titleByLocale: { [sourceLang]: parsed.title },
      description: parsed.description,
      descriptionByLocale: { [sourceLang]: parsed.description },
      needsRetranslation: true,
      location: hints.city,
      canton: hints.canton,
      url: listing.url,
      source: 'Bachtelen Dedicated Parser (server-rendered career pages)',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: hints.city,
      addressRegion: hints.canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: hints.postal || DEFAULT_POSTAL,
      category: detectHealthcareCategory(`${parsed.title} ${parsed.description}`),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectHealthcareExperienceLevel(`${parsed.title} ${parsed.description}`),
      sector: 'Sociale / Educazione',
      currency: 'CHF',
      featured: false,
      ...parsed.publication,
      applyUrl: listing.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
    console.log(`  ✅ ${parsed.title.substring(0, 70)} → ${hints.city} (${hints.canton})`);
  }

  if (!jobs.length) {
    throw new Error(`Bachtelen career page exposed ${listings.length} links but no valid job detail could be parsed`);
  }
  console.log(`\n📋 Total ${BACHTELEN_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { PUBLIC_CAREER_URL };
