import { createHash } from 'node:crypto';

const MAX_COMPANY_NAME_LENGTH = 140;
const MAX_LOCATION_LENGTH = 140;
const GENERIC_COMPANY_NAME = /^(?:company|entreprise|unternehmen|firma|unknown|anonymous|anonimo|anonima|azienda|impresa|test|prova|none|null|n\/a|na)$/iu;

function clean(value, maxLength) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f]/gu, ' ');
  return maxLength ? normalized.slice(0, maxLength) : normalized;
}

function officialWebsite(candidate) {
  const candidates = [
    candidate?.careersUrl,
    ...(Array.isArray(candidate?.careersUrls) ? candidate.careersUrls : []),
    candidate?.website,
    candidate?.domain ? `https://${candidate.domain}/` : '',
  ];
  for (const value of candidates) {
    try {
      const url = new URL(String(value || '').trim());
      if (url.protocol !== 'https:' || !url.hostname) continue;
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
      return url.toString();
    } catch {
      // A malformed candidate is not a public employer signal.
    }
  }
  return '';
}

function stableId(companyName, website) {
  return `prospector-${createHash('sha256').update(`${companyName.toLowerCase()}\u0000${website}`).digest('hex').slice(0, 24)}`;
}

function candidateEntries(source) {
  if (Array.isArray(source)) return source;
  if (source && typeof source === 'object' && source.candidates && typeof source.candidates === 'object') {
    return Object.values(source.candidates);
  }
  return [];
}

/**
 * Project only the prospector's explicit permanent-application signal into a
 * public-safe list. The full candidate store contains operational fields and
 * never crosses the build/runtime boundary.
 */
export function projectPermanentEmployerCandidates(source) {
  const byWebsite = new Map();
  for (const candidate of candidateEntries(source)) {
    const marked = candidate?.permanentApplicationOnly === true
      || (Array.isArray(candidate?.permanentApplications) && candidate.permanentApplications.length > 0);
    if (!marked) continue;
    const companyName = clean(candidate?.name, MAX_COMPANY_NAME_LENGTH);
    const website = officialWebsite(candidate);
    if (!companyName || companyName.length < 2 || GENERIC_COMPANY_NAME.test(companyName) || !website) continue;
    const record = {
      id: stableId(companyName, website),
      companyName,
      website,
      locationLabel: clean(candidate?.city || candidate?.canton, MAX_LOCATION_LENGTH) || undefined,
    };
    const key = website.toLowerCase();
    const existing = byWebsite.get(key);
    if (!existing || record.companyName.length > existing.companyName.length) byWebsite.set(key, record);
  }
  return [...byWebsite.values()].sort((left, right) => left.companyName.localeCompare(right.companyName, 'it'));
}

export function projectPermanentEmployerFeed(source, { generatedAt } = {}) {
  return {
    version: 1,
    generatedAt: generatedAt || source?.updatedAt || null,
    employers: projectPermanentEmployerCandidates(source),
  };
}
