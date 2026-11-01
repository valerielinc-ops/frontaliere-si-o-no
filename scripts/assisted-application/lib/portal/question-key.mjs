import { addressContextContract } from '../../../../functions/src/lib/addressContextContract.js';
import { questionTopic } from './plan.mjs';
export { portalAnswerForApplication, portalOptionMap } from '../../../../functions/src/lib/portalQuestionMapping.js';

export const PORTAL_CONTEXT_MAX_CHARS = 240;

export function boundedPortalContext(context) {
  return String(context || '').slice(0, PORTAL_CONTEXT_MAX_CHARS);
}

export function slugId(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'question';
}

export function normalizedPortalContext(context) {
  return boundedPortalContext(context).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function portalQuestionHash(question, context) {
  return questionHash(`${normalizedPortalContext(question)}\u0000${normalizedPortalContext(context)}`);
}

function questionHash(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

// A portal question has two labels once it crosses the candidate boundary:
// `question` is the readable candidate-language copy, while
// `applicationQuestion` is the exact label the ATS uses.  The latter is the
// stable anchor for generic questions whose semantic topic is not known.
function applicationLabel(question) {
  return typeof question === 'object'
    ? String(question?.applicationQuestion || question?.question || '')
    : question;
}

/** A stable answer id that keeps same-label fields in different fieldsets independent. */
export function portalQuestionId(question, context = '', section = '', autocomplete = '') {
  const label = applicationLabel(question);
  const surrounding = typeof question === 'object' ? question?.context : context;
  const heading = typeof question === 'object' ? question?.section : section;
  const fieldAutocomplete = typeof question === 'object' ? question?.autocomplete : autocomplete;
  const ownership = typeof question === 'object' ? addressContextContract(question) : undefined;
  // Keep ownership outside the flattened-context bound: a child owner near
  // the end of a long section must not disappear from the answer id.
  const ownerKey = ownership === undefined ? '' : `_${questionHash(JSON.stringify(ownership))}`;
  const base = `portal_${slugId(label)}${ownerKey}`;
  const metadata = [surrounding, heading, fieldAutocomplete].map(normalizedPortalContext).filter(Boolean).join('\u0000');
  return metadata ? `${base}_${portalQuestionHash(label, metadata)}` : base;
}

/** Dedupe reworded questions by a proven candidate fact; keep context when it selects which fact is meant. */
export function portalQuestionKey(question, context = '', section = '', autocomplete = '') {
  const label = applicationLabel(question);
  const surrounding = typeof question === 'object' ? question?.context : context;
  const heading = typeof question === 'object' ? question?.section : section;
  const fieldAutocomplete = typeof question === 'object' ? question?.autocomplete : autocomplete;
  const ownership = typeof question === 'object' ? addressContextContract(question) : undefined;
  if (ownership === null || ownership?.unknown) return '';
  const ownerKey = ownership === undefined ? '' : `|owner:${questionHash(JSON.stringify(ownership))}`;
  const metadata = { section: heading, autocomplete: fieldAutocomplete, ...(ownership === undefined ? {} : { addressContext: ownership }) };
  const topic = questionTopic(label, surrounding, metadata);
  if (!topic) return portalQuestionId(typeof question === 'object' ? question : label, surrounding, heading, fieldAutocomplete);
  const contextSensitive = /^(?:birth_date|address|address_street|address_house_number|residence_|phone_country$|current_school$|start_date_contextual$)/.test(topic);
  const normalizedContext = normalizedPortalContext(surrounding);
  const normalizedSection = normalizedPortalContext(heading);
  if (topic === 'start_date_contextual' && !normalizedContext) return portalQuestionId(typeof question === 'object' ? question : label, surrounding, heading, fieldAutocomplete);
  const contextKey = [normalizedContext, normalizedSection].filter(Boolean).join('|');
  return `${contextSensitive && contextKey ? `${topic}|${contextKey}` : topic}${ownerKey}`;
}
