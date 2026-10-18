import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { appendSlugDisambiguator, detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { mergeSourcePostingDates } from './source-posting-date.mjs';
import { copySpecFetchMetadata, loadSpec, runSpecInProduction } from './prospector/spec-crawler.mjs';
import { extractDetailFields } from './prospector/extract.mjs';
import { resolveSourceBackedSwissGeography } from './prospector/location-evidence.mjs';

export const RH_EXPERT_CH_KEY = 'rh-expert-ch';
export const RH_EXPERT_CH_COMPANY_NAME = 'RH-Expert';
export const RH_EXPERT_CH_COMPANY_DOMAIN = 'rh-expert.ch';

const CAREER_URL = 'https://rh-expert.ch/fr/offres-demploi';
const CTA_TITLE = /^en savoir plus$/i;

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
  return new JSDOM(removeHtmlBlocks(removeHtmlBlocks(html, 'style'), 'script')).window.document;
}

export function isRhExpertChJob(job) {
  const companyKey = normalizeSpace(job?.companyKey || '').toLowerCase();
  const company = normalizeSpace(job?.company || '').toLowerCase();
  let host = '';
  try { host = new URL(job?.url || '').hostname.toLowerCase(); } catch { /* invalid URL */ }
  return companyKey === RH_EXPERT_CH_KEY
    || company.includes('rh-expert')
    || host === 'rh-expert.ch'
    || host === 'www.rh-expert.ch';
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'rh-expert.ch' || host === 'www.rh-expert.ch';
  } catch {
    return false;
  }
}

/**
 * The RH-Expert index labels every detail link “En savoir plus”. On the
 * official detail page the H1 is the vacancy title, the .col-9 paragraphs or
 * list items are the vacancy body, and “Lieu de travail” is the authoritative workplace.
 * The adjacent .col-3/office address is intentionally not used as a fallback.
 */
export function extractRhExpertChDetailFields(html = '', pageUrl = '') {
  const base = extractDetailFields(html, pageUrl);
  const document = safeDocument(html);
  const container = document.querySelector('.page_emploi .col-9');
  const title = normalizeSpace(container?.querySelector('h1')?.textContent || base.title);
  if (!title || CTA_TITLE.test(title)) {
    return {
      ...base,
      title: '', description: '', location: '', canton: '', addressLocality: '',
      addressRegion: '', addressCountry: '', country: '', postalCode: '', streetAddress: '',
      locationCandidates: [],
    };
  }

  // RH-Expert has rendered the vacancy body as both paragraphs and list items
  // over time. Keep the selector inside the vacancy column so the office
  // sidebar cannot become source-backed job content or workplace evidence.
  const contentNodes = [...(container?.querySelectorAll('p, li') || [])]
    .filter((node) => node.tagName.toLowerCase() !== 'li' || !node.querySelector('li'));
  const content = contentNodes
    .map((node) => ({
      text: normalizeSpace(node.textContent),
      small: node.classList.contains('small'),
    }))
    .filter(({ text, small }) => text && !small
      && !/^(?:t[eé]l[eé]phone|mobile|e-?mail|contact)\s*:/i.test(text)
      && !/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(text)
      && !/lieu de travail\s*:/i.test(text))
    .map(({ text }) => text)
    .filter((text, index, all) => text.length >= 20 && all.indexOf(text) === index);
  const workplaceText = contentNodes
    .map((node) => normalizeSpace(node.textContent))
    .find((text) => /lieu de travail\s*:/i.test(text)) || '';
  const workplace = normalizeSpace(
    /lieu de travail\s*:\s*([^•;|\n]+)/i.exec(workplaceText)?.[1] || '',
  ).replace(/[.!?]+$/u, '').trim();
  const geography = workplace ? resolveSourceBackedSwissGeography(workplace) : null;
  const description = content.join('\n');

  return {
    ...base,
    title,
    description,
    location: geography?.location || '',
    canton: geography?.canton || '',
    addressLocality: '',
    addressRegion: geography?.canton || '',
    addressCountry: '',
    country: '',
    postalCode: '',
    streetAddress: '',
    locationCandidates: geography
      ? [{ location: geography.location, addressRegion: geography.canton }]
      : [],
  };
}

async function fetchJobListings(runtime = {}) {
  return runSpecInProduction(loadSpec(RH_EXPERT_CH_KEY), {
    ...runtime,
    detailExtractor: extractRhExpertChDetailFields,
  });
}

export async function fetchAllRhExpertChJobs(runtime = {}) {
  const listings = await fetchJobListings(runtime);
  const jobs = [];
  for (const listing of listings || []) {
    const title = normalizeSpace(listing.title);
    const description = stripHtml(listing.description || '');
    const url = normalizeSpace(listing.url);
    const geography = resolveSourceBackedSwissGeography(listing.locationCandidates?.[0]
      || listing.location
      || '');
    if (!title || CTA_TITLE.test(title) || !description || !meetsSourceBodyFloor(description)
      || !url || !geography || !isTrustedDomain(url)) continue;

    const sourceLang = detectLang(`${title} ${description}`, 'fr');
    const urlHash = createHash('sha1').update(url).digest('hex').slice(0, 12);
    const slugDisambiguator = urlHash.slice(0, 8);
    const slug = appendSlugDisambiguator(
      slugify(`${title} ${geography.location} rh expert ch`),
      slugDisambiguator,
    );
    jobs.push({
      id: `${RH_EXPERT_CH_KEY}-${urlHash}`,
      slug,
      slugByLocale: { [sourceLang]: slug },
      slugDisambiguator,
      company: RH_EXPERT_CH_COMPANY_NAME,
      companyKey: RH_EXPERT_CH_KEY,
      companyDomain: RH_EXPERT_CH_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: geography.location,
      canton: geography.canton,
      url,
      source: 'RH-Expert Official Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressRegion: geography.canton,
      ...(listing.addressCountry ? { addressCountry: listing.addressCountry, country: listing.addressCountry } : {}),
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

export { CAREER_URL as RH_EXPERT_CH_CAREER_URL };
