/**
 * PageExecutive vacancy-detail extraction.
 *
 * The generic Prospector deliberately recognises only cross-platform semantic
 * containers. PageExecutive splits one authoritative description across four
 * exact vacancy blocks and publishes the workplace in an exact `job-location`
 * span. Selecting only those vendor-owned containers preserves headings and
 * bullets without admitting navigation, related-job cards or footer copy.
 */
import { readAttr, scanHtmlTags } from '../html-attr.mjs';
import { decodeEntities } from './entities.mjs';
import { extractDetailFields } from './extract.mjs';

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

const DESCRIPTION_SECTIONS = [
  ['job_advert__job-desc-company', 'About Our Client'],
  ['job_advert__job-desc-role', 'Job Description'],
  ['job_advert__job-desc-candidate', 'The Successful Applicant'],
  ['job_advert__job-desc-deal', "What's on Offer"],
];

/** @param {string} raw */
function classTokens(raw = '') {
  return readAttr(raw, 'class').toLowerCase().split(/\s+/).filter(Boolean);
}

/** @param {string} html */
function indexContainers(html = '') {
  const tags = scanHtmlTags(html);
  const pending = new Map();
  const bounds = new Map();
  for (const tag of tags) {
    if (!tag.closing) {
      if (!tag.selfClosing && !VOID_TAGS.has(tag.name)) {
        if (!pending.has(tag.name)) pending.set(tag.name, []);
        pending.get(tag.name).push(tag);
      }
      continue;
    }
    const opening = pending.get(tag.name)?.pop();
    if (opening) bounds.set(opening.index, { contentEnd: tag.index, end: tag.end });
  }
  return { tags: tags.filter((tag) => !tag.closing), bounds };
}

/**
 * @param {string} html
 * @param {ReturnType<typeof indexContainers>} index
 * @param {(tag: any) => boolean} predicate
 */
function firstContainerInnerHtml(html, index, predicate) {
  const tag = index.tags.find((candidate) => predicate(candidate));
  const bound = tag ? index.bounds.get(tag.index) : null;
  return tag && bound ? html.slice(tag.end, bound.contentEnd) : '';
}

/** Preserve semantic line breaks and list bullets while dropping markup. */
function structuredText(html = '') {
  return decodeEntities(String(html || '')
    .replace(/<(?:script|style|template)\b[\s\S]*?<\/(?:script|style|template)\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/(?:p|li|div|section|article|h[1-6]|ul|ol)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

/** @param {string} value */
function pageExecutiveLocationCandidate(value = '') {
  const location = decodeEntities(String(value || '')).replace(/\s+/g, ' ').trim();
  if (!location) return null;
  const swiss = /,\s*(?:switzerland|schweiz|suisse|svizzera|svizra)\s*$/i.test(location);
  const withoutCountry = location
    .replace(/,\s*(?:switzerland|schweiz|suisse|svizzera|svizra)\s*$/i, '')
    .trim();
  const parts = withoutCountry.split(',').map((part) => part.trim()).filter(Boolean);
  const addressLocality = parts[0] || withoutCountry;
  const addressRegion = !swiss && parts.length === 2 ? parts[1] : '';
  return {
    location,
    addressLocality,
    addressRegion,
    addressCountry: swiss ? 'CH' : '',
    postalCode: '',
    streetAddress: '',
  };
}

/**
 * Merge the generic structured-data fields with PageExecutive's exact vacancy
 * blocks. The vendor-specific evidence wins only on this platform boundary;
 * generic title/date/employment metadata and negative-evidence flags remain.
 *
 * @param {string} html
 * @param {string} pageUrl
 */
export function extractPageExecutiveDetailFields(html = '', pageUrl = '') {
  const source = String(html || '');
  const base = extractDetailFields(source, pageUrl);
  if (!source) return base;
  const index = indexContainers(source);

  const sections = DESCRIPTION_SECTIONS.flatMap(([className, heading]) => {
    const body = structuredText(firstContainerInnerHtml(
      source,
      index,
      (tag) => classTokens(tag.raw).includes(className),
    ));
    return body ? [`${heading}\n${body}`] : [];
  });

  const rawLocation = structuredText(firstContainerInnerHtml(
    source,
    index,
    // The primary hero is a span. Related-job cards reuse `job-location` on
    // divs later in the page (and may move ahead under experiments), so class
    // membership alone is not authoritative vacancy evidence.
    (tag) => tag.name === 'span' && classTokens(tag.raw).includes('job-location'),
  ));
  const candidate = pageExecutiveLocationCandidate(rawLocation);
  return {
    ...base,
    // Never fall back to the generic whole-page candidate for this platform:
    // on PageExecutive that candidate contains navigation and related cards.
    // A missing vendor block is a source-shape failure and must stay empty.
    description: sections.join('\n\n'),
    location: candidate?.location || '',
    addressLocality: candidate?.addressLocality || '',
    addressRegion: candidate?.addressRegion || '',
    addressCountry: candidate?.addressCountry || '',
    locationCandidates: candidate ? [candidate] : [],
  };
}
