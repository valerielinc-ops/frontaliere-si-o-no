#!/usr/bin/env node
/**
 * Deillon Delley Architectes SA — official French careers page parser.
 *
 * The employer publishes the open roles and their descriptions on one
 * WordPress detail page instead of giving each role a separate URL.  The
 * parser therefore treats the role headings as the vacancy identity and uses
 * a text fragment URL to keep the two source-backed offers distinct without
 * inventing an anchor the source does not expose.
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { sourcePostingDateFields } from './source-posting-date.mjs';
import {
  resolveSourceBackedSwissGeography,
  sourceBackedSwissGeographyFields,
} from './prospector/location-evidence.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { textFragmentUrl } from './text-fragment-url.mjs';
import {
  fetchHtml,
  normalizeSpace,
  slugify,
  stripHtml,
} from './crawler-template.mjs';

export const DEILLON_DELLEY_ARCHITECTES_KEY = 'deillon-delley-architectes';
export const DEILLON_DELLEY_ARCHITECTES_COMPANY_NAME = 'Deillon Delley Architectes SA';
export const DEILLON_DELLEY_ARCHITECTES_COMPANY_DOMAIN = 'deillondelley.ch';
export const DEILLON_DELLEY_ARCHITECTES_CAREERS_URL =
  'https://deillondelley.ch/emplois/details-emplois/';

const ARCHITECT_ROLE_RE = /^architecte\b/i;
const ARCHITECT_ROLE_DETAIL_RE = /\b(?:développement|developpement|responsable|projet|junior|senior)\b/i;
const SOURCE_ADDRESS_RE = /\b(rue\s+lécheretta\s+1)\s*\|\s*ch\s*[–—-]\s*(\d{4})\s+(bulle)\b/i;
const CONTENT_BLOCK_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,li';
const DESCRIPTION_NOISE_RE = /^(?:nos offres d['’]emploi(?: en détail)?|en détail|vous êtes:?|accueil|menu)$/i;

function cleanRoleTitle(value = '') {
  return normalizeSpace(value).replace(/\s*[:：]\s*$/, '').trim();
}

export function isArchitectRoleTitle(value = '') {
  const title = cleanRoleTitle(value);
  return title.length >= 10
    && title.length <= 160
    && ARCHITECT_ROLE_RE.test(title)
    && ARCHITECT_ROLE_DETAIL_RE.test(title);
}

function selectContentRoot(document) {
  const candidates = [
    ...document.querySelectorAll('main, article, .entry-content, .page-content, [role="main"]'),
  ];
  return candidates.find((node) => /architecte/i.test(node.textContent || '')) || document.body;
}

function contentBlocks(root) {
  const blocks = [];
  for (const node of root.querySelectorAll(CONTENT_BLOCK_SELECTOR)) {
    if (node.matches('p') && node.closest('li')) continue;
    if (node.matches('li') && node.parentElement?.closest('li')) continue;

    const text = normalizeSpace(node.textContent || '');
    if (!text) continue;

    const emphasized = normalizeSpace(node.querySelector('strong,b')?.textContent || '');
    if (emphasized && isArchitectRoleTitle(emphasized) && text !== emphasized) {
      blocks.push({ tag: node.tagName.toLowerCase(), text: cleanRoleTitle(emphasized), role: true });
      const remainder = normalizeSpace(text.slice(text.indexOf(emphasized) + emphasized.length));
      if (remainder) blocks.push({ tag: 'p', text: remainder, role: false });
      continue;
    }

    blocks.push({
      tag: node.tagName.toLowerCase(),
      text,
      role: isArchitectRoleTitle(text),
    });
  }
  return blocks;
}

/**
 * Read the business address printed by the official page.  No employer
 * default is used: without this exact source evidence the vacancy is not
 * publishable.
 */
export function extractOfficialLocationEvidence(html = '') {
  if (!html || typeof html !== 'string') return null;
  const { document } = new JSDOM(html).window;
  const sourceText = normalizeSpace(document.body?.textContent || '');
  const match = SOURCE_ADDRESS_RE.exec(sourceText);
  if (!match) return null;

  const evidence = {
    location: 'Bulle',
    addressLocality: 'Bulle',
    addressCountry: 'CH',
    postalCode: match[2],
    streetAddress: normalizeSpace(match[1]),
  };
  const resolved = resolveSourceBackedSwissGeography(evidence);
  return sourceBackedSwissGeographyFields(evidence, resolved);
}

function cloneSourceContent(html = '') {
  const { document } = new JSDOM(html).window;
  const root = selectContentRoot(document).cloneNode(true);
  root.querySelectorAll('script,style,noscript,nav,header,footer,form').forEach((node) => node.remove());
  return root;
}

function sourceDescriptionBlocks(blocks = []) {
  const seen = new Set();
  const kept = [];
  for (const block of blocks) {
    const text = normalizeSpace(block?.text || '');
    if (!text || DESCRIPTION_NOISE_RE.test(text)) continue;
    if (block?.tag === 'h1' && !block.role) continue;
    if (/@/.test(text) || /(?:téléphone|telephone|phone|\btél\.?\b)\s*:/i.test(text)) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    kept.push(text);
  }
  return kept;
}

/**
 * Extract all architect roles from the single official detail page.
 * Every returned description is assembled only from source blocks and is
 * rejected when it does not meet the shared 50-word source-body floor.
 */
export function parseDeillonDelleyListing(html = '') {
  if (!html || typeof html !== 'string') return [];
  const locationEvidence = extractOfficialLocationEvidence(html);
  if (!locationEvidence) return [];

  const blocks = contentBlocks(cloneSourceContent(html));
  const roleIndexes = blocks
    .map((block, index) => (block.role ? index : -1))
    .filter((index) => index >= 0);
  if (!roleIndexes.length) return [];

  const preamble = sourceDescriptionBlocks(blocks.slice(0, roleIndexes[0]));
  const lastRoleIndex = roleIndexes.at(-1);
  const common = sourceDescriptionBlocks(blocks.slice(lastRoleIndex + 1));
  const listings = [];

  for (let i = 0; i < roleIndexes.length; i += 1) {
    const roleIndex = roleIndexes[i];
    const nextRoleIndex = roleIndexes[i + 1] ?? blocks.length;
    const specific = sourceDescriptionBlocks(blocks.slice(roleIndex + 1, nextRoleIndex));
    const description = [...preamble, ...specific, ...common].join('\n');
    if (!meetsSourceBodyFloor(description)) continue;

    const title = cleanRoleTitle(blocks[roleIndex].text);
    listings.push({
      title,
      description,
      url: textFragmentUrl(DEILLON_DELLEY_ARCHITECTES_CAREERS_URL, title),
      sourceLocation: locationEvidence,
    });
  }
  return listings;
}

export function isDeillonDelleyArchitectesJob(job = {}) {
  const key = String(job?.companyKey || '').trim().toLowerCase();
  const company = String(job?.company || '').trim().toLowerCase();
  const url = String(job?.url || '');
  return key === DEILLON_DELLEY_ARCHITECTES_KEY
    || company.includes('deillon delley architectes')
    || isTrustedDomain(url);
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === DEILLON_DELLEY_ARCHITECTES_COMPANY_DOMAIN
      || host.endsWith(`.${DEILLON_DELLEY_ARCHITECTES_COMPANY_DOMAIN}`);
  } catch {
    return false;
  }
}

export function deillonDelleyArchitectesMatchKey(job = {}) {
  return String(job?.id || job?.url || '').trim();
}

function experienceLevel(title = '') {
  if (/\bjunior\b/i.test(title)) return 'junior';
  if (/\b(?:senior|responsable)\b/i.test(title)) return 'senior';
  return 'mid';
}

export function buildDeillonDelleyArchitectesJobs(listings = []) {
  const jobs = [];
  for (const listing of Array.isArray(listings) ? listings : []) {
    const title = cleanRoleTitle(listing?.title || '');
    const description = stripHtml(String(listing?.description || '')).trim();
    if (!isArchitectRoleTitle(title) || !meetsSourceBodyFloor(description)) continue;

    const sourceEvidence = listing?.sourceLocation;
    const resolved = resolveSourceBackedSwissGeography(sourceEvidence);
    const locationFields = sourceBackedSwissGeographyFields(sourceEvidence, resolved);
    if (!locationFields) continue;

    const stableHash = createHash('sha1')
      .update(`${DEILLON_DELLEY_ARCHITECTES_KEY}:${title.toLowerCase()}`)
      .digest('hex')
      .slice(0, 12);
    const sourceLang = 'fr';
    const baseSlug = slugify(`${title} ${DEILLON_DELLEY_ARCHITECTES_KEY} ${locationFields.location}`);
    const jobSlug = baseSlug;
    const url = String(listing?.url || textFragmentUrl(DEILLON_DELLEY_ARCHITECTES_CAREERS_URL, title));

    jobs.push({
      id: `${DEILLON_DELLEY_ARCHITECTES_KEY}-${stableHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: DEILLON_DELLEY_ARCHITECTES_COMPANY_NAME,
      companyKey: DEILLON_DELLEY_ARCHITECTES_KEY,
      companyDomain: DEILLON_DELLEY_ARCHITECTES_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: locationFields.location,
      canton: locationFields.canton,
      addressLocality: locationFields.addressLocality,
      addressRegion: locationFields.addressRegion,
      addressCountry: locationFields.addressCountry,
      country: locationFields.addressCountry,
      postalCode: locationFields.postalCode,
      streetAddress: locationFields.streetAddress,
      category: 'Ingegneria',
      contract: 'other',
      employmentType: 'OTHER',
      experienceLevel: experienceLevel(title),
      sector: 'Architettura / Edilizia',
      currency: 'CHF',
      featured: false,
      ...sourcePostingDateFields(''),
      url,
      applyUrl: url,
      source: 'Deillon Delley Architectes SA Dedicated Parser (official site)',
      sourceLang,
      crawledAt: new Date().toISOString(),
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }
  return jobs;
}

export async function fetchAllDeillonDelleyArchitectesJobs({ fetchPage = fetchHtml } = {}) {
  console.log(`🏛️ Fetching ${DEILLON_DELLEY_ARCHITECTES_COMPANY_NAME} jobs`);
  const html = await fetchPage(DEILLON_DELLEY_ARCHITECTES_CAREERS_URL);
  const listings = parseDeillonDelleyListing(html);
  const jobs = buildDeillonDelleyArchitectesJobs(listings);
  console.log(`  ✓ ${jobs.length} source-backed architect role(s) parsed`);
  return jobs;
}
