#!/usr/bin/env node
/**
 * Kita Summervogel GmbH — official jobs page parser.
 *
 * The employer publishes openings on its own WordPress page rather than on an
 * ATS.  The parser deliberately reads only a semantically scoped job block or
 * a JobPosting JSON-LD record from kitasummervogel.ch.  Aggregator copies are
 * not an input and a page-wide address/footer is never a workplace fallback.
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { appendSlugDisambiguator, detectLang } from './dedicated-crawler-common.mjs';
import { fetchWithRetry, RETRYABLE_STATUS, slugify, stripHtml } from './crawler-template.mjs';
import { sourcePostingDateCandidatesFields } from './source-posting-date.mjs';
import { meetsSourceBodyFloor, sourceBodyWordCount } from './source-body-floor.mjs';
import {
  resolveSourceBackedSwissGeography,
  sourceBackedSwissGeographyFields,
} from './prospector/location-evidence.mjs';
import { normalizeSwissCantonCode } from './target-swiss-locations.mjs';
import { isAuthoritativeEmptySnapshot, markAuthoritativeEmptySnapshot } from './authoritative-empty-snapshot.mjs';

export const KITA_SUMMERVOGEL_KEY = 'kita-summervogel';
export const KITA_SUMMERVOGEL_COMPANY_NAME = 'Kita Summervogel GmbH';
export const KITA_SUMMERVOGEL_COMPANY_DOMAIN = 'kitasummervogel.ch';
export const KITA_SUMMERVOGEL_JOBS_URL = 'https://kitasummervogel.ch/jobs/';

const SOURCE_LANG = 'de';
const COMPANY_SECTOR = 'Educazione / Infanzia';
const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/2.0; +https://frontaliereticino.ch/)';
const TARGET_ROLE_RE = /\b(?:miterzieher(?:in)?|fachfrau(?:mann)?\s+betreuung\s+kind|fachperson\s+betreuung\s+kind|pädagog(?:ische|ischer)\s+fachperson|erzieher(?:in)?|gruppenleitung\s+(?:kita|kindertagesstätte)|betreuungsperson(?:\s+kita)?)\b/i;
const LOCATION_LABEL_RE = /^(?:arbeitsort|arbeitsplatz|einsatzort|standort|ort)\s*[:\-]?\s*(.*)$/i;
const DATE_LABEL_RE = /^(?:publiziert|veröffentlicht|online\s+seit|inseriert|datum|date)\s*[:\-]?\s*(.*)$/i;
const EMPTY_STATE_RE = /(?:zurzeit|derzeit|aktuell|momentan|zur\s+zeit)?\s*keine\s+(?:offenen?\s+)?(?:stellen|positionen|jobangebote|stellenangebote)\b/i;
const JOB_SECTION_HEADING_RE = /^jobangebote\s*:?$/i;
const JOB_LIST_SELECTOR = [
  '[data-job-list]',
  '[data-jobs-list]',
  '[data-vacancy-list]',
  '.jobs-page',
  '.jobs',
  '.job-list',
  '.job-offers',
  '.job-offer-list',
  '.vacancies',
  '.vacancy-list',
  '#jobs',
  '#job-list',
  '#vacancies',
].join(',');
const EMPTY_STATE_MARKER_SELECTOR = [
  '[data-empty-state]',
  '[data-jobs-empty]',
  '[data-no-jobs]',
].join(',');
const HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6';
const ELEMENTOR_HEADING_WIDGET_SELECTOR = '.elementor-widget-heading';
const ELEMENTOR_LOOP_GRID_WIDGET_SELECTOR = '.elementor-widget-loop-grid';
const ELEMENTOR_LOOP_GRID_EMPTY_STATE_SELECTOR = '.e-loop-nothing-found-message';
const SIDEBAR_SELECTOR = 'aside,[role="complementary"],.sidebar,.widget-area';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function fold(value = '') {
  return normalizeSpace(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function isTargetKitaSummervogelRole(title = '') {
  return TARGET_ROLE_RE.test(normalizeSpace(title));
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:'
      && (url.hostname === KITA_SUMMERVOGEL_COMPANY_DOMAIN
        || url.hostname.endsWith(`.${KITA_SUMMERVOGEL_COMPANY_DOMAIN}`));
  } catch {
    return false;
  }
}

export function isKitaSummervogelJob(job) {
  const key = fold(job?.companyKey || '');
  const company = fold(job?.company || '');
  return key === KITA_SUMMERVOGEL_KEY
    || company === fold(KITA_SUMMERVOGEL_COMPANY_NAME)
    || isTrustedDomain(job?.url || '');
}

function canonicalSourceUrl(rawUrl = '', pageUrl = KITA_SUMMERVOGEL_JOBS_URL) {
  try {
    const url = new URL(String(rawUrl || '').trim(), pageUrl);
    if (!isTrustedDomain(url.href)) return '';
    url.hash = '';
    url.search = '';
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.href;
  } catch {
    return '';
  }
}

function sourceTextFromNode(node) {
  if (!node) return '';
  const clone = node.cloneNode(true);
  clone.querySelectorAll?.('script,style,noscript,nav,footer,header,form').forEach((child) => child.remove());
  return stripHtml(clone.innerHTML || clone.textContent || '');
}

function sourceLines(value = '') {
  return String(value || '')
    .split(/\n+/)
    .map(normalizeSpace)
    .filter(Boolean);
}

function firstLabeledValue(lines, pattern) {
  for (let index = 0; index < lines.length; index += 1) {
    const match = pattern.exec(lines[index]);
    if (!match) continue;
    const inline = normalizeSpace(match[1] || '');
    if (inline) return inline;
    return normalizeSpace(lines[index + 1] || '');
  }
  return '';
}

function extractLocationText(text = '') {
  const lines = sourceLines(text);
  const labeled = firstLabeledValue(lines, LOCATION_LABEL_RE);
  if (labeled) return labeled;
  return lines.find((line) => (
    /\b\d{4}\b/.test(line)
    && /\b(?:SG|Zuzwil|Zuckenriet)\b/i.test(line)
  )) || '';
}

function extractDateText(text = '', timeElement = null) {
  const datetime = normalizeSpace(timeElement?.getAttribute?.('datetime') || '');
  if (datetime) return datetime;
  return firstLabeledValue(sourceLines(text), DATE_LABEL_RE);
}

function normalizeGermanDate(raw = '') {
  const value = normalizeSpace(raw);
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value);
  return match
    ? `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`
    : value;
}

function structuredText(value) {
  if (typeof value === 'string') return normalizeSpace(value);
  if (Array.isArray(value)) return structuredText(value[0]);
  if (value && typeof value === 'object') {
    return structuredText(value.name || value.value || value['@value'] || '');
  }
  return '';
}

function sourcePostingIdentityFromUrl(rawUrl, pageUrl, preserveBoardIdentity = false) {
  const value = normalizeSpace(rawUrl || '');
  if (!value) return '';
  try {
    const resolved = new URL(value, pageUrl);
    if (!isTrustedDomain(resolved.href)) return '';
    const canonical = canonicalSourceUrl(resolved.href, pageUrl);
    const listingPageUrl = canonicalSourceUrl(pageUrl, pageUrl);
    if (!preserveBoardIdentity && canonical === listingPageUrl && !resolved.search && !resolved.hash) return '';
    return resolved.href;
  } catch {
    return '';
  }
}

function sourcePostingIdentityFromRecord(source, pageUrl) {
  const raw = source?.identifier;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const identity = typeof value === 'object' && value !== null
    ? normalizeSpace(value.value || value.name || value.propertyID || '')
    : normalizeSpace(value || '');
  if (identity) {
    if (/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(identity)) {
      return sourcePostingIdentityFromUrl(identity, pageUrl, true);
    }
    return identity;
  }
  return sourcePostingIdentityFromUrl(source?.url, pageUrl);
}

function locationEvidenceFromRaw(raw = '') {
  const location = normalizeSpace(raw);
  if (!location) return null;
  const postalCode = location.match(/\b(?:CH[-\s]?)?(\d{4})\b/)?.[1] || '';
  const afterPostal = postalCode
    ? location.slice(location.indexOf(postalCode) + postalCode.length)
    : location;
  const addressLocality = normalizeSpace(afterPostal
    .replace(/^[,;\-\s]+/, '')
    .replace(/\b(?:SG|CH|Schweiz|Switzerland|Suisse|Svizzera)\b/gi, '')
    .split(/[,;|]/)[0]);
  const addressRegion = /(?:^|[\s,;/])SG(?:$|[\s,.;/])/i.test(location) ? 'SG' : '';
  // Keep the postal pair as its own evidence field. Passing a postal prefix
  // through the free-text `location` slot makes the shared resolver treat the
  // whole token as an ambiguous place; the locality/canton pair is the
  // source-backed identity and the CAP remains attached to it.
  const sourceLocation = [addressLocality, addressRegion].filter(Boolean).join(', ') || location;
  const evidence = {
    location: sourceLocation,
    ...(addressLocality ? { addressLocality } : {}),
    ...(addressRegion ? { addressRegion } : {}),
    ...(postalCode ? { postalCode } : {}),
    addressCountry: 'CH',
  };
  const resolved = resolveSourceBackedSwissGeography(evidence);
  return resolved?.canton === 'SG'
    ? sourceBackedSwissGeographyFields(evidence, resolved)
    : null;
}

function locationEvidenceFromStructured(place) {
  if (!place || typeof place !== 'object') return null;
  const address = place.address && typeof place.address === 'object' ? place.address : place;
  const addressLocality = structuredText(address.addressLocality);
  const rawAddressRegion = structuredText(address.addressRegion);
  const addressRegion = normalizeSwissCantonCode(rawAddressRegion);
  const addressCountry = structuredText(address.addressCountry);
  const location = normalizeSpace([
    addressLocality || structuredText(place.name),
    rawAddressRegion,
  ].filter(Boolean).join(', '));
  if (!location) return null;
  const evidence = {
    location,
    ...(addressLocality ? { addressLocality } : {}),
    ...(addressRegion ? { addressRegion } : {}),
    ...(addressCountry ? { addressCountry } : {}),
    ...(structuredText(address.postalCode) ? { postalCode: structuredText(address.postalCode) } : {}),
    ...(structuredText(address.streetAddress) ? { streetAddress: structuredText(address.streetAddress) } : {}),
  };
  const resolved = resolveSourceBackedSwissGeography(evidence);
  return resolved?.canton === 'SG'
    ? sourceBackedSwissGeographyFields(evidence, resolved)
    : null;
}

function jsonLdJobPostings(document) {
  const records = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
    if (types.some((type) => String(type || '').toLowerCase() === 'jobposting')) records.push(value);
    if (value['@graph']) visit(value['@graph']);
  };
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { visit(JSON.parse(script.textContent || '')); } catch { /* malformed unrelated JSON-LD */ }
  }
  return records;
}

function roleContainers(document, pageUrl) {
  const rows = [];
  const seen = new Set();
  for (const heading of document.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    const title = normalizeSpace(heading.textContent || '');
    if (!isTargetKitaSummervogelRole(title)) continue;
    let current = heading.parentElement;
    let container = null;
    while (current && current.tagName !== 'BODY') {
      const marker = `${current.id || ''} ${current.className || ''}`;
      const semantic = /(?:job|stelle|vacan|position|angebot|career|opening|inserat)/i.test(marker);
      const generic = /(?:list|grid|archive|overview|navigation|menu)/i.test(marker);
      if (current.tagName === 'ARTICLE' || current.tagName === 'LI' || (semantic && !generic)) {
        container = current;
        break;
      }
      current = current.parentElement;
    }
    container ||= heading.parentElement;
    if (!container || seen.has(container)) continue;
    seen.add(container);
    const text = sourceTextFromNode(container);
    const clone = container.cloneNode(true);
    clone.querySelectorAll?.('h1,h2,h3,h4,h5,h6').forEach((node) => {
      if (normalizeSpace(node.textContent || '') === title) node.remove();
    });
    const description = sourceTextFromNode(clone);
    const rawLink = [...container.querySelectorAll('a[href]')]
      .map((node) => normalizeSpace(node.getAttribute('href') || ''))
      .find((value) => canonicalSourceUrl(value, pageUrl)) || '';
    const link = canonicalSourceUrl(rawLink, pageUrl);
    rows.push({
      title,
      description,
      locationText: extractLocationText(text),
      dateText: extractDateText(text, container.querySelector('time[datetime]')),
      url: link,
      sourcePostingIdentity: sourcePostingIdentityFromUrl(rawLink, pageUrl),
    });
  }
  return rows;
}

function explicitEmptyState(document) {
  const jobListNodes = [...document.querySelectorAll(JOB_LIST_SELECTOR)];
  const leafJobListNodes = jobListNodes.filter((node) => (
    !jobListNodes.some((nested) => nested !== node && node.contains(nested))
  ));

  const markedEmptyState = leafJobListNodes.some((jobListNode) => {
    const emptyStateNodes = [
      jobListNode.matches?.(EMPTY_STATE_MARKER_SELECTOR) ? jobListNode : null,
      ...[...jobListNode.children].filter((node) => node.matches?.(EMPTY_STATE_MARKER_SELECTOR)),
    ].filter(Boolean);
    if (emptyStateNodes.some((node) => EMPTY_STATE_RE.test(normalizeSpace(node.textContent || '')))) {
      return true;
    }

    // A bare paragraph directly in the source's job-list node is the other
    // supported form used by the official page. Do not inspect arbitrary
    // descendants: footer/about/sidebar copy must not retire live listings.
    const directText = [...jobListNode.childNodes]
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent || '')
      .join(' ');
    if (EMPTY_STATE_RE.test(normalizeSpace(directText))) return true;
    return [...jobListNode.children]
      .filter((node) => node.tagName === 'P' && !node.id && !node.className)
      .some((node) => EMPTY_STATE_RE.test(normalizeSpace(node.textContent || '')));
  });
  if (markedEmptyState) return true;

  // The current official page renders the empty state in an Elementor
  // loop-grid widget immediately after the `Jobangebote:` heading widget.
  // Require those two widgets to be adjacent children of the same Elementor
  // container; page-wide heading order can otherwise borrow sidebar copy.
  for (const heading of document.querySelectorAll(
    `${ELEMENTOR_HEADING_WIDGET_SELECTOR} ${HEADING_SELECTOR}`,
  )) {
    if (!JOB_SECTION_HEADING_RE.test(normalizeSpace(heading.textContent || ''))) continue;
    if (heading.closest(SIDEBAR_SELECTOR)) continue;
    const headingWidget = heading.closest(ELEMENTOR_HEADING_WIDGET_SELECTOR);
    const container = headingWidget?.parentElement;
    if (!container?.matches('.e-con')) continue;

    const widgets = [...container.children];
    const headingWidgetIndex = widgets.indexOf(headingWidget);
    const loopGridWidget = widgets[headingWidgetIndex + 1];
    if (!loopGridWidget?.matches(ELEMENTOR_LOOP_GRID_WIDGET_SELECTOR)) continue;

    const emptyStateNodes = loopGridWidget.querySelectorAll(
      ELEMENTOR_LOOP_GRID_EMPTY_STATE_SELECTOR,
    );
    if ([...emptyStateNodes].some((node) => (
      !node.closest(SIDEBAR_SELECTOR)
      && EMPTY_STATE_RE.test(normalizeSpace(node.textContent || ''))
    ))) return true;
  }
  return false;
}

function structuredLocationCandidates(record) {
  const values = Array.isArray(record?.jobLocation) ? record.jobLocation : [record?.jobLocation];
  return values.map(locationEvidenceFromStructured).filter(Boolean);
}

function employmentTypeFor(text = '') {
  const normalized = fold(text);
  if (/teilzeit|part[-\s]?time/.test(normalized)) return 'PART_TIME';
  if (/vollzeit|full[-\s]?time/.test(normalized)) return 'FULL_TIME';
  const percent = normalized.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || normalized.match(/(\d{2,3})\s*%/);
  if (percent) return Number(percent[2] || percent[1]) < 80 ? 'PART_TIME' : 'FULL_TIME';
  return 'OTHER';
}

function candidateFromSource(source, block, pageUrl) {
  const title = normalizeSpace(source?.title || block?.title);
  if (!isTargetKitaSummervogelRole(title)) return null;
  const descriptionCandidates = [
    block?.description || '',
    stripHtml(source?.description || ''),
  ].map(normalizeSpace).filter(meetsSourceBodyFloor).sort((a, b) => sourceBodyWordCount(b) - sourceBodyWordCount(a));
  const description = descriptionCandidates[0] || '';
  if (!description) return null;

  const geography = structuredLocationCandidates(source).find(Boolean)
    || locationEvidenceFromRaw(block?.locationText || '');
  if (!geography) return null;
  const url = canonicalSourceUrl(source?.url || block?.url || pageUrl, pageUrl);
  if (!url) return null;
  const sourcePostingIdentity = sourcePostingIdentityFromRecord(source, pageUrl)
    || normalizeSpace(source?.sourcePostingIdentity || block?.sourcePostingIdentity || '');
  const publication = sourcePostingDateCandidatesFields([
    normalizeGermanDate(source?.datePosted),
    normalizeGermanDate(block?.dateText),
  ]);
  const employmentText = [title, description, structuredText(source?.employmentType)].join(' ');
  return {
    title,
    description,
    url,
    ...geography,
    ...publication,
    employmentType: employmentTypeFor(employmentText),
    hiringOrganizationName: structuredText(source?.hiringOrganization?.name) || KITA_SUMMERVOGEL_COMPANY_NAME,
    ...(sourcePostingIdentity ? { sourcePostingIdentity } : {}),
  };
}

function candidateRecordKey(candidate, pageUrl) {
  const listingPageUrl = canonicalSourceUrl(pageUrl, pageUrl);
  if (candidate.sourcePostingIdentity) return `source|${candidate.sourcePostingIdentity}`;
  if (candidate.url !== listingPageUrl) return `url|${candidate.url}`;
  return '';
}

function mergeCandidate(records, candidate, pageUrl) {
  const key = candidateRecordKey(candidate, pageUrl);
  if (!key) {
    // The jobs page URL identifies the board, not an individual posting. Keep
    // an unlabelled summary rather than inventing a title/location identity;
    // otherwise two same-title openings at one locality can be collapsed
    // before fetchAllKitaSummervogelJobs creates their URL-hash IDs.
    records.set(`summary|${records.size}`, candidate);
    return;
  }
  const before = records.get(key);

  if (before) {
    records.set(key, preferCandidate(before, candidate, pageUrl));
    return;
  }
  records.set(key, candidate);
}

function preferCandidate(before, candidate, pageUrl) {
  const listingPageUrl = canonicalSourceUrl(pageUrl, pageUrl);
  const candidateIsDetail = candidate.url !== listingPageUrl;
  const beforeIsDetail = before.url !== listingPageUrl;
  if (candidateIsDetail && !beforeIsDetail) return candidate;
  if (beforeIsDetail && !candidateIsDetail) return before;
  if (sourceBodyWordCount(candidate.description) > sourceBodyWordCount(before.description)) {
    return candidate;
  }
  return before;
}

export function parseKitaSummervogelJobs(html = '', pageUrl = KITA_SUMMERVOGEL_JOBS_URL) {
  const dom = new JSDOM(String(html || ''), { url: pageUrl });
  const document = dom.window.document;
  const blocks = roleContainers(document, pageUrl);
  const structured = jsonLdJobPostings(document);
  const records = new Map();

  for (const record of structured) {
    const block = blocks.find((row) => fold(row.title) === fold(record.title));
    const candidate = candidateFromSource(record, block, pageUrl);
    if (candidate) mergeCandidate(records, candidate, pageUrl);
  }
  for (const block of blocks) {
    const candidate = candidateFromSource({
      title: block.title,
      url: block.url,
      sourcePostingIdentity: block.sourcePostingIdentity,
      datePosted: block.dateText,
      employmentType: block.description,
    }, block, pageUrl);
    if (candidate) mergeCandidate(records, candidate, pageUrl);
  }

  const output = [...records.values()];
  Object.defineProperty(output, 'candidateCount', {
    value: structured.filter((record) => isTargetKitaSummervogelRole(record.title)).length + blocks.length,
    enumerable: false,
  });
  if (output.length === 0 && explicitEmptyState(document)) {
    return markAuthoritativeEmptySnapshot(output, 'official Kita Summervogel jobs page explicitly reports no open positions');
  }
  return output;
}

async function fetchOfficialJobsPage(runtime = {}) {
  const fetchImpl = runtime.fetchImpl || globalThis.fetch;
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  return fetchWithRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(KITA_SUMMERVOGEL_JOBS_URL, {
        headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': USER_AGENT },
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} from ${KITA_SUMMERVOGEL_JOBS_URL}`);
        error.status = response.status;
        error.retryable = RETRYABLE_STATUS.has(response.status);
        throw error;
      }
      const finalUrl = response.url || KITA_SUMMERVOGEL_JOBS_URL;
      if (!isTrustedDomain(finalUrl)) throw new Error(`official page redirected to an untrusted host: ${finalUrl}`);
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }, { label: `${KITA_SUMMERVOGEL_COMPANY_NAME} official jobs page` });
}

export async function fetchAllKitaSummervogelJobs(runtime = {}) {
  console.log(`Fetching ${KITA_SUMMERVOGEL_COMPANY_NAME} jobs`);
  console.log(`   Source: ${KITA_SUMMERVOGEL_JOBS_URL}`);
  const html = await fetchOfficialJobsPage(runtime);
  const listings = parseKitaSummervogelJobs(html, KITA_SUMMERVOGEL_JOBS_URL);
  if (isAuthoritativeEmptySnapshot(listings)) return listings;

  const now = new Date().toISOString();
  const jobs = listings.map((listing) => {
    const sourceLang = detectLang(`${listing.title} ${listing.description}`, SOURCE_LANG);
    const hashInput = listing.sourcePostingIdentity
      ? `${listing.sourcePostingIdentity}|${listing.url}|${listing.title}`
      : `${listing.url}|${listing.title}`;
    const urlHash = createHash('sha1').update(hashInput).digest('hex').slice(0, 12);
    const slugDisambiguator = listing.sourcePostingIdentity ? urlHash.slice(0, 8) : '';
    const slug = appendSlugDisambiguator(
      slugify(`${listing.title} ${KITA_SUMMERVOGEL_KEY} ${listing.addressLocality || listing.location}`),
      slugDisambiguator,
    );
    return {
      id: `${KITA_SUMMERVOGEL_KEY}-${urlHash}`,
      slug,
      slugByLocale: { [sourceLang]: slug },
      ...(slugDisambiguator ? { slugDisambiguator } : {}),
      company: KITA_SUMMERVOGEL_COMPANY_NAME,
      companyKey: KITA_SUMMERVOGEL_KEY,
      companyDomain: KITA_SUMMERVOGEL_COMPANY_DOMAIN,
      title: listing.title,
      titleByLocale: { [sourceLang]: listing.title },
      description: listing.description,
      descriptionByLocale: { [sourceLang]: listing.description },
      needsRetranslation: true,
      location: listing.location,
      canton: 'SG',
      url: listing.url,
      applyUrl: listing.url,
      source: `${KITA_SUMMERVOGEL_COMPANY_NAME} Dedicated Parser (official jobs page)`,
      sourceLang,
      crawledAt: now,
      addressLocality: listing.addressLocality,
      addressRegion: 'SG',
      addressCountry: listing.addressCountry || 'CH',
      country: listing.addressCountry || 'CH',
      postalCode: listing.postalCode || '',
      streetAddress: listing.streetAddress || '',
      hiringOrganizationName: listing.hiringOrganizationName || KITA_SUMMERVOGEL_COMPANY_NAME,
      category: 'Educazione',
      sector: COMPANY_SECTOR,
      contract: listing.employmentType === 'FULL_TIME' ? 'full-time' : listing.employmentType === 'PART_TIME' ? 'part-time' : 'other',
      employmentType: listing.employmentType,
      experienceLevel: 'mid',
      currency: 'CHF',
      featured: false,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
      datePosted: listing.datePosted,
      postedDate: listing.postedDate,
      postingDateSource: listing.postingDateSource,
    };
  });
  Object.defineProperties(jobs, {
    discoveredCount: { value: Number.isFinite(listings.candidateCount) ? listings.candidateCount : listings.length, enumerable: false },
    fetchOutcome: { value: jobs.length > 0 ? 'ok' : (listings.candidateCount > 0 ? 'filtered_empty' : 'selector_miss'), enumerable: false },
  });
  console.log(`   Official educator listings: ${jobs.length}`);
  return jobs;
}
