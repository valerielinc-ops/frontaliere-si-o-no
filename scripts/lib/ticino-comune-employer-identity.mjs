/**
 * Employer identity for the `comuni-ticino` crawler family.
 *
 * `comuni-ticino` is the storage/crawler family, while the registry key is
 * the actual employer. Keep this boundary in one place so the crawler,
 * runtime logo resolver, audit and acquisition cannot silently disagree.
 */
export const TICINO_COMUNI_FAMILY_KEY = 'comuni-ticino';
export const TICINO_COMUNE_EMPLOYER_KEY_RE = /^comune-di-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function ticinoComuneEmployerKey(value) {
  const key = String(value || '').trim().toLowerCase();
  return TICINO_COMUNE_EMPLOYER_KEY_RE.test(key) ? key : '';
}

/**
 * Return the municipality-scoped employer key only when the job carries the
 * family key or already carries the same scoped key. An unrelated
 * `municipalityKey` must not reassign a job to a different employer.
 */
export function scopedEmployerKey(job) {
  const rawMunicipalityKey = String(job?.municipalityKey || '').trim();
  const municipalityKey = ticinoComuneEmployerKey(rawMunicipalityKey);
  const companyKey = String(job?.companyKey || '').trim().toLowerCase();

  if (municipalityKey) {
    if (companyKey === TICINO_COMUNI_FAMILY_KEY || companyKey === municipalityKey) {
      return municipalityKey;
    }
    return '';
  }

  // The family key is only a crawler/storage identity. Without a valid
  // municipality it must never become a logo/employer lookup key.
  if (companyKey === TICINO_COMUNI_FAMILY_KEY || rawMunicipalityKey) return '';
  return companyKey;
}

export function isTicinoComuneJob(job, validKeys = null) {
  const municipalityKey = ticinoComuneEmployerKey(job?.municipalityKey);
  const companyKey = String(job?.companyKey || '').trim().toLowerCase();
  if (!municipalityKey || (validKeys && !validKeys.has(municipalityKey))) return false;
  return companyKey === TICINO_COMUNI_FAMILY_KEY || companyKey === municipalityKey;
}

/**
 * Legacy records predate `companyDomainSource`, but their municipality key
 * and dedicated-parser source still prove the domain came from this crawler.
 * Keep that compatibility narrow: arbitrary companyDomain/url metadata is
 * never source-backed in audit mode.
 */
export function hasSourceBackedTicinoComuneDomain(job) {
  if (!isTicinoComuneJob(job)) return false;
  const domain = String(job?.companyDomain || '').trim();
  if (!domain) return false;
  if (String(job?.companyDomainSource || '').trim() === 'ticino-comuni-registry') return true;
  if (String(job?.sourceCrawler || job?.crawlerKey || job?.__crawlerKey || '').trim()
    === TICINO_COMUNI_FAMILY_KEY) return true;
  return String(job?.source || '').trim().endsWith(' Dedicated Parser (albo + PDF)');
}
