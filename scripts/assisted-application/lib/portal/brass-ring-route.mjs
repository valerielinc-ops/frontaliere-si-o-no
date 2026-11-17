const BRASSRING_HOME_WITH_PRELOAD_RE = /^\/tgnewui\/search\/home\/homewithpreload\/?$/i;

const BRASSRING_PROCESSING_LABEL = 'ubs processing your personal data in the context of your application as outlined above';
const BRASSRING_TRANSFER_LABEL = 'the cross-border transfer of your personal data to above mentioned service providers to carry out the purpose of recruit';
const BRASSRING_AGREE_NOTICE = 'thank you for your interest in a job at ubs note: you must agree to proceed.';

const normalizeBrassRingText = value => String(value || '').normalize('NFKC')
  .replace(/\p{Cf}/gu, '').replace(/\s+/gu, ' ').trim();

const brassRingControlText = control => normalizeBrassRingText(
  control?.text || control?.label || control?.ariaLabel,
);
const brassRingLabelMatches = (value, expected) => normalizeBrassRingText(value).toLowerCase() === expected;

const mainFrame = value => value === undefined || value === null
  || (typeof value === 'number' && Number.isSafeInteger(value) && value === 0)
  || (typeof value === 'string' && /^\s*0\s*$/u.test(value));

function brassRingQueryParams(url) {
  const params = new Map();
  const duplicateIdentityKeys = new Set();
  for (const [key, value] of url.searchParams.entries()) {
    const normalizedKey = String(key || '').toLowerCase();
    if (params.has(normalizedKey)) {
      if (normalizedKey === 'jobid' || normalizedKey === 'partnerid') duplicateIdentityKeys.add(normalizedKey);
      continue;
    }
    const normalizedValue = String(value || '').trim();
    params.set(normalizedKey, normalizedKey === 'jobid' || normalizedKey === 'partnerid'
      ? normalizedValue
      : normalizedValue.toLowerCase());
  }
  return { params, duplicateIdentityKeys };
}

/** BrassRing may canonicalize siteid, parameter case, and query order on this detail route. */
export function sameBrassRingPostingAddress(firstUrl, secondUrl) {
  try {
    const first = new URL(String(firstUrl || ''));
    const second = new URL(String(secondUrl || ''));
    if (first.protocol !== 'https:' || second.protocol !== 'https:'
      || first.origin !== 'https://jobs.ubs.com' || second.origin !== first.origin
      || first.username || first.password || second.username || second.password
      || !BRASSRING_HOME_WITH_PRELOAD_RE.test(first.pathname)
      || !BRASSRING_HOME_WITH_PRELOAD_RE.test(second.pathname)
      || first.pathname.replace(/\/+$/u, '').toLowerCase() !== second.pathname.replace(/\/+$/u, '').toLowerCase()) {
      return false;
    }
    const firstQuery = brassRingQueryParams(first);
    const secondQuery = brassRingQueryParams(second);
    if (firstQuery.duplicateIdentityKeys.size || secondQuery.duplicateIdentityKeys.size) return false;
    const firstJobId = firstQuery.params.get('jobid') || '';
    const secondJobId = secondQuery.params.get('jobid') || '';
    if (!firstJobId || firstJobId !== secondJobId) return false;
    const firstPartner = firstQuery.params.get('partnerid') || '';
    const secondPartner = secondQuery.params.get('partnerid') || '';
    if ((firstPartner || secondPartner) && firstPartner !== secondPartner) return false;
    const firstType = firstQuery.params.get('pagetype') || 'jobdetails';
    const secondType = secondQuery.params.get('pagetype') || 'jobdetails';
    return firstType === 'jobdetails' && secondType === 'jobdetails';
  } catch {
    return false;
  }
}

/** The UBS privacy gate is a portal-owned intermediate page, not a candidate fact. */
export function isBrassRingPrivacyGateText(value) {
  const text = normalizeBrassRingText(value).toLowerCase();
  return text.includes(BRASSRING_PROCESSING_LABEL)
    && text.includes(BRASSRING_TRANSFER_LABEL)
    && text.includes(BRASSRING_AGREE_NOTICE);
}

/**
 * Recognize only the known UBS intermediate privacy gate. Its fields remain
 * available to the planner; this helper only authorizes the portal's Agree
 * transition after the selected, query-bound application entry was proved.
 */
export function brassRingPrivacyGateControl(snapshot, {
  applyUrl = '',
  postingUrl = '',
  applicationEntryProven = false,
} = {}) {
  if (applicationEntryProven !== true || !snapshot?.url) return null;
  const routeUrls = [applyUrl, postingUrl].map(value => String(value || '').trim()).filter(Boolean);
  if (!routeUrls.length || !routeUrls.every(value => sameBrassRingPostingAddress(snapshot.url, value))) return null;

  const fields = (snapshot.fields || []).filter(field => !field?.chrome && !field?.disabled
    && !['hidden', 'submit', 'button', 'reset', 'image'].includes(String(field?.inputType || '').toLowerCase()));
  const checkboxes = fields.filter(field => field?.kind === 'checkbox' || String(field?.inputType || '').toLowerCase() === 'checkbox');
  const radios = fields.filter(field => field?.kind === 'radio' || String(field?.inputType || '').toLowerCase() === 'radio');
  if (fields.length !== 3 || checkboxes.length !== 2 || radios.length !== 1
    || !checkboxes.some(field => brassRingLabelMatches(field?.label, BRASSRING_PROCESSING_LABEL))
    || !checkboxes.some(field => brassRingLabelMatches(field?.label, BRASSRING_TRANSFER_LABEL))
    || !brassRingLabelMatches(radios[0]?.label, BRASSRING_AGREE_NOTICE)) return null;

  const agree = (snapshot.buttons || []).filter(button => !button?.chrome && !button?.disabled
    && mainFrame(button?.frame) && /^agree$/iu.test(brassRingControlText(button)));
  return agree.length === 1 ? agree[0] : null;
}

export { BRASSRING_HOME_WITH_PRELOAD_RE };
