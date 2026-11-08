import { JSDOM } from 'jsdom';

// Empty-state proof must fail closed when a source keeps a no-open message but
// moves the live posting into a markup shape the current listing extractor does
// not know yet. These names cover the data attributes used by the source and
// the common URL/card shapes without treating an empty `job-list` container as
// a posting by itself.
const JOB_DATA_ATTRIBUTE_RE = /(?:^|[-_:])(?:job|jobs|position|positions|vacancy|vacancies|opening|openings|posting|postings|offer|offers|emploi|emplois|stelle|stellen)(?:[-_:](?:id|url|href|link|key|slug|uuid|ref|value))?$/i;
const JOB_CARD_TOKEN_RE = /\b(?:job|jobs|position|positions|vacancy|vacancies|opening|openings|posting|postings|offer|offers|emploi|emplois|stelle|stellen)[-_ ](?:card|item|tile|row|result|link|posting)\b/i;
// Source templates can move a detail route between data-href, data-url,
// data-path, data-route, and other data-* attributes without changing the
// visible card. Treat every data-* attribute as URL-capable; only values that
// match the source-specific detail-route grammar veto an empty proof.
const URL_ATTRIBUTE_RE = /^(?:href|src|action|onclick|data-[\w:-]+)$/i;
const NON_EMPTY_JOB_COLLECTION_RE = /\\?"(?:initialJobs|jobs|positions|vacancies|openings|jobListings)\\?"\s*:\s*(?:\[\s*[^\]\s]|\{\s*[^}])/i;

function decodeNumericEntities(value = '') {
  return String(value || '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)));
}

function normalizeMarkupValue(value = '') {
  return decodeNumericEntities(String(value || ''))
    .replace(/&amp;/gi, '&')
    .replace(/\\u002f/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/%2f/gi, '/');
}

function isJobCloudDetailReference(value) {
  return /\/[a-z]{2}\/(?:jobs?|job-detail|positions?|vacancies?|offers?|emplois|stellen)(?:\/|[?#]|$)/i
    .test(normalizeMarkupValue(value));
}

function isJobupDetailReference(value) {
  return /\/(?:fr\/(?:emplois|jobs|job-detail)|en\/(?:jobs|job-detail))\/(?:detail\/)?[^/?#"'\\]+/i
    .test(normalizeMarkupValue(value));
}

function hasDetailReference(value, sourceKind) {
  return sourceKind === 'jobup'
    ? isJobupDetailReference(value)
    : isJobCloudDetailReference(value);
}

/**
 * Detect job evidence that a source-specific listing extractor might miss.
 * This is deliberately conservative: any ambiguous job-bearing URL, data
 * attribute, card token, or non-empty collection payload vetoes an
 * authoritative empty snapshot.
 */
export function hasPotentialJobData(html = '', sourceKind = 'jobcloud') {
  const source = String(html || '');
  if (!source) return false;
  if (NON_EMPTY_JOB_COLLECTION_RE.test(normalizeMarkupValue(source))) return true;

  const dom = new JSDOM(source);
  try {
    const { document } = dom.window;
    for (const element of document.querySelectorAll('*')) {
      const identity = [
        element.getAttribute('class'),
        element.getAttribute('id'),
        element.getAttribute('data-testid'),
        element.getAttribute('data-cy'),
      ].filter(Boolean).join(' ');
      if (JOB_CARD_TOKEN_RE.test(identity)) return true;

      for (const attribute of element.attributes) {
        const name = attribute.name.toLowerCase();
        const value = normalizeMarkupValue(attribute.value);
        if (JOB_DATA_ATTRIBUTE_RE.test(name) && (value || name === 'data-job')) return true;
        if (URL_ATTRIBUTE_RE.test(name) && hasDetailReference(value, sourceKind)) return true;
      }
    }
    return false;
  } finally {
    dom.window.close();
  }
}
