import { portalOptionMap } from './portalQuestionMapping.js';
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
      || ['context', 'section'].some(field => Object.hasOwn(copy, field) && typeof copy[field] !== 'string')
      || !Array.isArray(copy.options) || copy.options.length > 300 || copy.options.some(value => typeof value !== 'string')
      || ['questionOwned', 'metadataComplete', 'ownershipUnknown'].some(field => Object.hasOwn(copy, field) && typeof copy[field] !== 'boolean')
      || consentOwnershipContract(copy) === null || addressContextContract(copy) === null) return null;
    return copy;
  } catch { return null; }
}

/** Complete option disclosure; only proven native placeholders are excluded from the answer mapping. */
export function nativeQuestionOptionsView(question) {
  const native = question?.originalNativeContract;
  if (!native) return { originalQuestionOptions: [], originalQuestionOptionMap: [] };
  if (!Array.isArray(native.options) || native.options.length > 300) return null;
  const source = Object.hasOwn(native, 'optionValues') ? native.optionValues : native.options.map(label => ({ label }));
  if (!Array.isArray(source) || source.length !== native.options.length || source.length > 300) return null;
  const originalQuestionOptions = [];
  for (let index = 0; index < source.length; index++) {
    const option = source[index];
    if (!option || typeof option !== 'object' || Array.isArray(option)
      || Object.keys(option).some(key => !['label', 'value', 'placeholder'].includes(key))
      || typeof option.label !== 'string' || option.label.length > 8000 || option.label !== native.options[index]
      || !option.label && option.placeholder !== true
      || Object.hasOwn(option, 'value') && (typeof option.value !== 'string' || option.value.length > 8000)
      || Object.hasOwn(option, 'placeholder') && typeof option.placeholder !== 'boolean') return null;
    originalQuestionOptions.push({ ...option });
  }
  const labels = originalQuestionOptions.filter(option => option.placeholder !== true).map(option => option.label);
  if (new Set(labels).size !== labels.length) return null;
  if (!labels.length) return question.type === 'choice' ? null : { originalQuestionOptions, originalQuestionOptionMap: [] };
  const candidates = question.options || [];
  const applications = question.applicationOptions || labels;
  if (!Array.isArray(candidates) || !Array.isArray(applications) || applications.length !== labels.length
    || candidates.some(option => typeof option !== 'string') || applications.some(option => typeof option !== 'string')
    || new Set(candidates).size !== candidates.length || new Set(applications).size !== applications.length
    || applications.some(option => !labels.includes(option))) return null;
  const map = portalOptionMap({ options: candidates, applicationOptions: applications, optionMap: question.optionMap });
  if (map.length !== candidates.length || map.length !== labels.length
    || map.some(pair => !candidates.includes(pair.candidate) || !labels.includes(pair.application))
    || candidates.some(option => map.filter(pair => pair.candidate === option).length !== 1)
    || labels.some(option => map.filter(pair => pair.application === option).length !== 1)) return null;
  return { originalQuestionOptions, originalQuestionOptionMap: map };
}

export function answerQuestionDescriptor(question) {
  const q = object(question);
  const consent = consentOwnershipContract(q);
  if (consent === null) return null;
  const native = Object.hasOwn(q, 'originalNativeContract') ? boundedNativeContract(q.originalNativeContract) : undefined;
  if (['applicationOptions', 'optionMap'].some(field => Object.hasOwn(q, field) && (!Array.isArray(q[field]) || q[field].length > 300))
    || q.applicationOptions?.some(option => typeof option !== 'string' || option.length > 8000)
    || q.optionMap?.some(pair => !pair || typeof pair !== 'object' || Array.isArray(pair) || Object.keys(pair).some(key => !['candidate', 'application'].includes(key))
      || ['candidate', 'application'].some(field => typeof pair[field] !== 'string' || pair[field].length > 8000))) return null;
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
    ...Object.fromEntries(['applicationOptions', 'optionMap'].filter(field => Object.hasOwn(q, field)).map(field => [field, structuredClone(q[field])])),
    ...Object.fromEntries(optionalBooleans.filter(field => Object.hasOwn(q, field)).map(field => [field, q[field]])),
    required: Boolean(q.required), type: String(q.type || 'text'), options: Array.isArray(q.options) ? q.options : [], validation: object(q.validation) };
  try { return JSON.stringify(result).length <= 96000 && nativeQuestionOptionsView(result) !== null ? result : null; } catch { return null; }
}
