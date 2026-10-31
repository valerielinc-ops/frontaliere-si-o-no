/** The question originally presented for confirmation, including the worker's native snapshot when present. */
import { addressContextContract } from './addressContextContract.js';
import { consentOwnershipContract } from './consentOwnershipContract.js';
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
export const canonicalQuestionJson = value => JSON.stringify(canonical(value));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function boundedNativeContract(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const serialized = canonicalQuestionJson(value);
    if (serialized.length > 64000) return null;
    const copy = JSON.parse(serialized);
    if (typeof copy.question !== 'string' || copy.question.length > 8000 || typeof copy.kind !== 'string'
      || !Array.isArray(copy.options) || copy.options.length > 300 || copy.options.some(value => typeof value !== 'string')
      || ['questionOwned', 'metadataComplete', 'ownershipUnknown'].some(field => Object.hasOwn(copy, field) && typeof copy[field] !== 'boolean')
      || consentOwnershipContract(copy) === null || addressContextContract(copy) === null) return null;
    return copy;
  } catch { return null; }
}

export function answerQuestionDescriptor(question) {
  const q = object(question);
  const consent = consentOwnershipContract(q);
  if (consent === null) return null;
  const native = Object.hasOwn(q, 'originalNativeContract') ? boundedNativeContract(q.originalNativeContract) : undefined;
  if (native === null) return null;
  const optionalBooleans = ['questionOwned', 'metadataComplete', 'ownershipUnknown'];
  if (optionalBooleans.some(field => Object.hasOwn(q, field) && typeof q[field] !== 'boolean')) return null;
  const ownership = addressContextContract(q);
  if (ownership === null) return null;
  const fields = ['id', 'question', 'applicationQuestion', 'context', 'section', 'autocomplete', 'source', 'minDate', 'why'];
  if (fields.some(field => String(q[field] || '').length > (['question', 'applicationQuestion', 'why'].includes(field) ? 8000 : 1000)) || Array.isArray(q.options) && q.options.length > 300) return null;
  if (!['text', 'number', 'date', 'yes_no', 'choice', 'checkbox', 'multi_choice'].includes(q.type)
    || q.required != null && typeof q.required !== 'boolean') return null;
  const result = { ...Object.fromEntries(fields.map(field => [field, String(q[field] || '').trim()])),
    ...(ownership === undefined ? {} : { addressContext: ownership }),
    ...(consent === undefined ? {} : consent),
    ...(native === undefined ? {} : { originalNativeContract: native }),
    ...Object.fromEntries(optionalBooleans.filter(field => Object.hasOwn(q, field)).map(field => [field, q[field]])),
    required: Boolean(q.required), type: String(q.type || 'text'), options: Array.isArray(q.options) ? q.options : [], validation: object(q.validation) };
  try { return JSON.stringify(result).length <= 96000 ? result : null; } catch { return null; }
}
