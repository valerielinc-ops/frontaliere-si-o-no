/** A missing machine label is an extraction error, never a question for a person. */
export const PORTAL_QUESTION_PLACEHOLDERS = Object.freeze({
  it: 'Il portale richiede una risposta a questa domanda.',
  en: 'The portal requires an answer to this question.',
  de: 'Das Portal benötigt eine Antwort auf diese Frage.',
  fr: 'Le portail demande une réponse à cette question.',
});
const fold = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, ' ').trim();
const placeholders = new Set(Object.values(PORTAL_QUESTION_PLACEHOLDERS).map(fold));
export function readablePortalQuestionText(value) {
  const text = String(value || '').trim();
  return text && !placeholders.has(fold(text)) ? text : '';
}
export function portalQuestionText(question) {
  return readablePortalQuestionText(question?.question) || readablePortalQuestionText(question?.applicationQuestion)
    || readablePortalQuestionText(question?.portalQuestion);
}
export function hasPortalQuestionEvidence(question) {
  return question?.source === 'portal'
    || Object.hasOwn(question || {}, 'applicationQuestion')
    || Object.hasOwn(question || {}, 'portalQuestion');
}
export function unreadablePortalQuestion(question) {
  return hasPortalQuestionEvidence(question) && !portalQuestionText(question);
}
