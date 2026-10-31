/** Pure rendering shared by the semantic gate and the actual text filler. */
import { formatPhoneForField, phoneDialCode } from '../../../../functions/src/lib/phoneNormalization.js';

export function fitToLength(text, max) {
  const value = String(text || '');
  if (!max || value.length <= max) return value;
  const cut = value.slice(0, max);
  let end = -1;
  for (const match of cut.matchAll(/[.!?…](?=\s|$)/g)) end = match.index + 1;
  if (end >= max * 0.5) return cut.slice(0, end).trim();
  const space = cut.lastIndexOf(' ');
  return (space > 0 ? cut.slice(0, space) : cut).replace(/[\s,;:–—-]+$/, '').trim();
}
const same = (a, b) => String(a || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
  === String(b || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

export function phonePrefixMetadata(field, fields, value, topicFor) {
  if (topicFor(field) !== 'phone') return {};
  const index = fields.indexOf(field);
  const sibling = fields.some((candidate, otherIndex) => topicFor(candidate) === 'phone_country'
    && (candidate.form === field.form || candidate.form == null || field.form == null)
    && (!candidate.section || !field.section || same(candidate.section, field.section))
    && (candidate.context && field.context && same(candidate.context, field.context) || index >= 0 && Math.abs(otherIndex - index) <= 2));
  return sibling ? { countryPrefix: phoneDialCode(value), separateCountryCode: true } : {};
}

export function renderedTextAction(field, action, fields, topicFor) {
  if (action._transportRendered === true || action.action !== 'fill'
    || !['text', 'textarea'].includes(field.kind) || field.widget === 'ui5-date') return action;
  const maximum = Object.hasOwn(field.validation || {}, 'maxlength') ? Number(field.validation.maxlength) : Number(field.maxLength) || 0;
  const limit = Number.isFinite(maximum) && maximum > 0 ? maximum : 0;
  let value = topicFor(field) === 'phone' ? formatPhoneForField(action.value,
    { maxLength: limit, ...phonePrefixMetadata(field, fields, action.value, topicFor) })
    : fitToLength(action.value, limit);
  if (field.kind !== 'textarea') value = String(value).replace(/[\r\n]+/g, ' ');
  return { ...action, value, _transportRendered: true };
}
