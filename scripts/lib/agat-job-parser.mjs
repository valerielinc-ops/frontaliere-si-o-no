import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang, appendSlugDisambiguator } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { mergeSourcePostingDates } from './source-posting-date.mjs';
import { copySpecFetchMetadata, loadSpec, runSpecInProduction } from './prospector/spec-crawler.mjs';
import { bodyTextOf, extractDetailFields } from './prospector/extract.mjs';
import { resolveSourceBackedSwissGeography } from './prospector/location-evidence.mjs';

export const AGAT_KEY = 'agat';
export const AGAT_COMPANY_NAME = 'AGAT ! Placements fixes et temporaires SA';
export const AGAT_COMPANY_DOMAIN = 'agat-job.com';

const CAREER_URL = 'https://www.agat-job.com/blog';
const AGAT_WORKPLACE_RE = /(?:situ[ée]e?\s+dans\s+la\s+r[ée]gion\s+de\s+|r[ée]gion\s+de\s+)(Sion|Monthey|Vevey|Martigny)\b/i;

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function removeHtmlBlocks(source, tagName) {
  const openTag = `<${tagName}`;
  const closeTag = `</${tagName}`;
  let html = String(source || '');
  let lower = html.toLowerCase();
  let cursor = 0;
  while ((cursor = lower.indexOf(openTag, cursor)) >= 0) {
    const openEnd = html.indexOf('>', cursor);
    if (openEnd < 0) break;
    const closeStart = lower.indexOf(closeTag, openEnd + 1);
    if (closeStart < 0) break;
    const closeEnd = html.indexOf('>', closeStart);
    if (closeEnd < 0) break;
    html = html.slice(0, cursor) + html.slice(closeEnd + 1);
    lower = html.toLowerCase();
  }
  return html;
}

function safeDocument(html = '') {
  const withoutStyles = removeHtmlBlocks(html, 'style');
  const withoutScripts = removeHtmlBlocks(withoutStyles, 'script');
  return new JSDOM(withoutScripts).window.document;
}

export function isAgatJob(job) {
  const companyKey = normalizeSpace(job?.companyKey || '').toLowerCase();
  const company = normalizeSpace(job?.company || '').toLowerCase();
  let host = '';
  try { host = new URL(job?.url || '').hostname.toLowerCase(); } catch { /* invalid URL */ }
  return companyKey === AGAT_KEY
    || company.includes('agat')
    || host === 'agat-job.com'
    || host === 'www.agat-job.com';
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'agat-job.com' || host === 'www.agat-job.com';
  } catch {
    return false;
  }
}

/** The official Wix listing's post-card title is the nested H2, not button text. */
export function extractAgatListingRows(html = '', pageUrl = CAREER_URL) {
  const document = safeDocument(html);
  const rows = new Map();
  for (const anchor of document.querySelectorAll('a[href]')) {
    let url;
    try { url = new URL(anchor.getAttribute('href'), pageUrl).href; } catch { continue; }
    if (!isTrustedDomain(url) || !new URL(url).pathname.startsWith('/post/')) continue;
    const title = normalizeSpace(anchor.querySelector('h2, h3')?.textContent || '');
    if (!title || /^en savoir plus$/i.test(title)) continue;
    rows.set(url, { title, url });
  }
  return [...rows.values()];
}

/**
 * AGAT's official detail body states the workplace as a region (e.g. “région
 * de Sion”). We use only that vacancy-body evidence; the agency's office or
 * the blog's navigation categories are never a workplace fallback.
 */
export function extractAgatDetailFields(html = '', pageUrl = '') {
  const base = extractDetailFields(html, pageUrl);
  const document = safeDocument(html);
  const article = document.querySelector('main article') || document.querySelector('article');
  if (!article) return {
    ...base, title: '', description: '', location: '', canton: '', addressLocality: '',
    addressRegion: '', addressCountry: '', country: '', postalCode: '', streetAddress: '',
    locationCandidates: [],
  };
  for (const node of article.querySelectorAll('script, style, nav, footer, form')) node.remove();
  const articleHtml = article.innerHTML;
  const articleText = bodyTextOf(articleHtml);
  const title = normalizeSpace(
    article.querySelector('h1, h2, h3')?.textContent
      || base.title
      || document.title,
  );
  const workplaceMatch = AGAT_WORKPLACE_RE.exec(articleText);
  const workplace = workplaceMatch ? `région de ${workplaceMatch[1]}` : '';
  const geography = workplace ? resolveSourceBackedSwissGeography(workplace) : null;
  if (!geography) {
    return {
      ...base,
      title,
      description: articleText,
      location: '',
      canton: '',
      addressLocality: '',
      addressRegion: '',
      addressCountry: '',
      country: '',
      postalCode: '',
      streetAddress: '',
      locationCandidates: [],
    };
  }
  return {
    ...base,
    title,
    description: articleText,
    location: geography.location,
    canton: geography.canton,
    addressLocality: '',
    addressRegion: geography.canton,
    addressCountry: '',
    country: '',
    postalCode: '',
    streetAddress: '',
    locationCandidates: [{ location: geography.location, addressRegion: geography.canton }],
  };
}

async function fetchJobListings(runtime = {}) {
  return runSpecInProduction(loadSpec(AGAT_KEY), {
    ...runtime,
    detailExtractor: extractAgatDetailFields,
  });
}

export async function fetchAllAgatJobs(runtime = {}) {
  const listings = await fetchJobListings(runtime);
  const jobs = [];
  for (const listing of listings || []) {
    const title = normalizeSpace(listing.title);
    const description = stripHtml(listing.description || '');
    const url = normalizeSpace(listing.url);
    const geography = resolveSourceBackedSwissGeography(listing.locationCandidates?.[0]
      || listing.location
      || '');
    if (title.length < 3 || !description || !url || !geography || !isTrustedDomain(url)) continue;

    const sourceLang = detectLang(`${title} ${description}`, 'fr');
    const urlHash = createHash('sha1').update(url).digest('hex').slice(0, 12);
    const slugDisambiguator = urlHash.slice(0, 8);
    const slug = appendSlugDisambiguator(
      slugify(`${title} ${geography.location} agat ch`),
      slugDisambiguator,
    );
    jobs.push({
      id: `${AGAT_KEY}-${urlHash}`,
      slug,
      slugByLocale: { [sourceLang]: slug },
      slugDisambiguator,
      company: AGAT_COMPANY_NAME,
      companyKey: AGAT_KEY,
      companyDomain: AGAT_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: geography.location,
      canton: geography.canton,
      url,
      source: 'AGAT ! Official Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressRegion: geography.canton,
      employmentType: listing.employmentType || 'OTHER',
      contract: 'other',
      experienceLevel: 'mid',
      sector: 'Altro',
      currency: 'CHF',
      featured: false,
      ...mergeSourcePostingDates({}, listing),
      applyUrl: url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }
  return copySpecFetchMetadata(jobs, listings || []);
}

export { CAREER_URL as AGAT_CAREER_URL };
