const BRASSRING_HOME_WITH_PRELOAD_RE = /^\/tgnewui\/search\/home\/homewithpreload\/?$/i;

const BRASSRING_PROCESSING_MARKER = 'processing your personal data';
const BRASSRING_TRANSFER_MARKER = 'cross-border transfer of your personal data';
const BRASSRING_AGREE_MARKER = 'must agree to proceed';

const normalizeBrassRingText = value => String(value || '').normalize('NFKC')
  .replace(/\p{Cf}/gu, '').replace(/\s+/gu, ' ').trim();

const brassRingControlText = control => normalizeBrassRingText(
  control?.text || control?.label || control?.ariaLabel,
);

const mainFrame = value => value === undefined || value === null
  || (typeof value === 'number' && Number.isSafeInteger(value) && value === 0)
  || (typeof value === 'string' && /^\s*0\s*$/u.test(value));

const activeBrassRingField = field => field && !field.chrome && !field.disabled
  && !['hidden', 'submit', 'button', 'reset', 'image'].includes(String(field.inputType || '').toLowerCase());

const ownershipValue = value => String(value || '').trim();
const SURFACE_OWNERSHIP_KEYS = ['dialogId', 'applicationScopeId', 'roleFormId', 'sectionGroupId', 'formId'];
const hasSurfaceOwnership = value => SURFACE_OWNERSHIP_KEYS.some(key => ownershipValue(value?.[key]));
const brassRingOwnershipSignature = value => SURFACE_OWNERSHIP_KEYS
  .map(key => ownershipValue(value?.[key])).join('\u001f');
const hasSingleBrassRingOwnershipCluster = fields => {
  const entries = Array.isArray(fields) ? fields : [];
  const owned = entries.filter(hasSurfaceOwnership);
  if (!owned.length) return true;
  // A gate with mixed owned/unowned or multiple owned surfaces cannot prove
  // that its three consent controls belong to the same active application.
  return owned.length === entries.length
    && new Set(owned.map(brassRingOwnershipSignature)).size === 1;
};

const explicitFrame = (value) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : String(value).trim();
  const text = String(value).trim();
  return /^\d+$/u.test(text) ? Number(text) : text;
};

/**
 * A BrassRing control may share a page with stale fields from another popup
 * or form. Compare every ownership marker that either side exposes; a missing
 * counterpart is not proof that the control owns that field.
 */
export function brassRingControlOwnsField(control = {}, field = {}) {
  const controlFrame = explicitFrame(control.frame);
  const fieldFrame = explicitFrame(field.frame);
  if (controlFrame !== null && fieldFrame !== null && controlFrame !== fieldFrame) return false;
  for (const key of SURFACE_OWNERSHIP_KEYS) {
    const left = ownershipValue(control[key]);
    const right = ownershipValue(field[key]);
    if ((left || right) && (!left || !right || left !== right)) return false;
  }
  return true;
}

/** Return only active fields owned by the given UBS/BrassRing control. */
export function brassRingActiveFields(snapshot = {}, control = {}) {
  const controlHasSurfaceOwnership = hasSurfaceOwnership(control);
  const controlFrame = explicitFrame(control.frame);
  return (Array.isArray(snapshot.fields) ? snapshot.fields : [])
    .filter(activeBrassRingField)
    .filter((field) => {
      const fieldFrame = explicitFrame(field.frame);
      if (controlFrame !== null && fieldFrame !== null && controlFrame !== fieldFrame) return false;
      if (brassRingControlOwnsField(control, field)) return true;
      // An unowned field on the same frame may still be part of the active
      // surface. Keep it as ambiguity instead of promoting a fieldful page to
      // a fieldless application entry.
      return (controlHasSurfaceOwnership && !hasSurfaceOwnership(field))
        || (!controlHasSurfaceOwnership && hasSurfaceOwnership(field));
    });
}

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
  return text.includes(BRASSRING_PROCESSING_MARKER)
    && text.includes(BRASSRING_TRANSFER_MARKER)
    && text.includes(BRASSRING_AGREE_MARKER);
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

  const fieldText = field => [
    field?.label,
    field?.text,
    field?.name,
    field?.id,
    field?.context,
    field?.section,
    ...(Array.isArray(field?.labels) ? field.labels : []),
    ...(Array.isArray(field?.options) ? field.options.map(option => typeof option === 'string' ? option : option?.label) : []),
  ].filter(Boolean).map(normalizeBrassRingText).join(' ').toLowerCase();
  const agree = (snapshot.buttons || []).filter(button => !button?.chrome && !button?.disabled
    && mainFrame(button?.frame) && /^agree$/iu.test(brassRingControlText(button)));
  const validAgree = agree.filter((button) => {
    const fields = brassRingActiveFields(snapshot, button);
    if (!hasSingleBrassRingOwnershipCluster(fields)) return false;
    const choices = fields.filter(field => ['checkbox', 'radio'].includes(String(field?.kind || '').toLowerCase())
      || ['checkbox', 'radio'].includes(String(field?.inputType || '').toLowerCase()));
    const checkboxes = choices.filter(field => field?.kind === 'checkbox'
      || String(field?.inputType || '').toLowerCase() === 'checkbox');
    const radios = choices.filter(field => field?.kind === 'radio'
      || String(field?.inputType || '').toLowerCase() === 'radio');
    const checkboxText = checkboxes.map(fieldText).join(' ');
    const radioText = radios.map(fieldText).join(' ');
    return fields.length >= 3 && choices.length === fields.length && checkboxes.length >= 2 && radios.length >= 1
      && checkboxText.includes(BRASSRING_PROCESSING_MARKER)
      && checkboxText.includes(BRASSRING_TRANSFER_MARKER)
      && radioText.includes(BRASSRING_AGREE_MARKER);
  });
  return validAgree.length === 1 ? validAgree[0] : null;
}

export { BRASSRING_HOME_WITH_PRELOAD_RE };
