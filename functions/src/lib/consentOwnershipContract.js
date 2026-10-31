/** Complete metadata captured from the checkbox's own labels/references. No consent policy or default. */
export const CONSENT_OWNERSHIP_FIELDS = ['ownConsentText', 'ownConsentQuestionLabels', 'ownConsentMetadataComplete', 'ownConsentQuestionOwned', 'ownConsentOwnerKey', 'consentOwnershipUnknown', 'ownConsentLinks'];
const clean = value => value.replace(/\s+/g, ' ').trim();
function boundedStrings(values, count, each, total) {
  return Array.isArray(values) && values.length <= count && new Set(values).size === values.length
    && values.every(value => typeof value === 'string' && value.length <= each && value === clean(value))
    && values.reduce((size, value) => size + value.length, 0) <= total;
}
export function consentOwnershipContract(question) {
  const source = question || {};
  if (!CONSENT_OWNERSHIP_FIELDS.some(field => Object.hasOwn(source, field))) return undefined;
  if (!CONSENT_OWNERSHIP_FIELDS.every(field => Object.hasOwn(source, field))) return null;
  if (!boundedStrings(source.ownConsentText, 64, 8000, 12000)
    || !boundedStrings(source.ownConsentQuestionLabels, 64, 8000, 12000)
    || source.ownConsentQuestionLabels.some(label => !source.ownConsentText.includes(label))
    || !boundedStrings(source.ownConsentLinks, 16, 2048, 8192)
    || source.ownConsentLinks.some(link => { try { return !new URL(link).protocol; } catch { return true; } })
    || typeof source.ownConsentOwnerKey !== 'string' || source.ownConsentOwnerKey.length > 4096
    || ['ownConsentMetadataComplete', 'ownConsentQuestionOwned', 'consentOwnershipUnknown'].some(field => typeof source[field] !== 'boolean')) return null;
  return Object.fromEntries(CONSENT_OWNERSHIP_FIELDS.map(field => [field, Array.isArray(source[field]) ? [...source[field]] : source[field]]));
}
