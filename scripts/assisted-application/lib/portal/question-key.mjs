import { questionTopic } from './plan.mjs';

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
  let hash = 2166136261;
  for (const character of `${normalizedPortalContext(question)}\u0000${normalizedPortalContext(context)}`) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/** A stable answer id that keeps same-label fields in different fieldsets independent. */
export function portalQuestionId(question, context = '') {
  const label = typeof question === 'object' ? question?.question : question;
  const surrounding = typeof question === 'object' ? question?.context : context;
  const base = `portal_${slugId(label)}`;
  return normalizedPortalContext(surrounding) ? `${base}_${portalQuestionHash(label, surrounding)}` : base;
}

/** Dedupe reworded questions only when both their semantic topic and context match. */
export function portalQuestionKey(question, context = '') {
  const label = typeof question === 'object' ? question?.question : question;
  const surrounding = typeof question === 'object' ? question?.context : context;
  const topic = questionTopic(label, surrounding);
  return topic ? `${topic}|${normalizedPortalContext(surrounding)}` : portalQuestionId(label, surrounding);
}
