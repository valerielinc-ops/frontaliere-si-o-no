/** Candidate-visible employer updates, independent of the submission guard. */
export const EMPLOYER_RESPONSE_CATEGORIES = new Set([
  'auto_acknowledgement', 'interview_invite', 'rejection', 'documents_request', 'question', 'assessment', 'offer',
]);
const millis = value => {
  const number = typeof value?.toMillis === 'function' ? value.toMillis()
    : value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(String(value || ''));
  return Number.isFinite(number) && number > 0 && !Number.isNaN(new Date(number).getTime()) ? number : null;
};
function response(value) {
  if (!EMPLOYER_RESPONSE_CATEGORIES.has(value?.category)) return null;
  const receivedAt = millis(value.receivedAt);
  if (!receivedAt) return null;
  return { category: value.category, receivedAt, needsReply: value.needsReply === true,
    messageId: typeof value.messageId === 'string' ? value.messageId.slice(0, 200) : '' };
}
export function employerResponseOf(order) {
  return response(order?.employerResponse) || response({ category: order?.lastEmployerReplyCategory, receivedAt: order?.lastEmployerReplyAt });
}
export function employerResponseView(value) {
  const valid = response(value);
  return valid ? { category: valid.category, receivedAt: valid.receivedAt, needsReply: valid.needsReply } : null;
}

/** An acknowledgement cannot erase an interview, request or outcome. */
export function mergeEmployerResponse(previous, event) {
  const before = response(previous); const next = response(event);
  if (!next) return before;
  if (!before) return next;
  if (before.category !== 'auto_acknowledgement' && next.category === 'auto_acknowledgement') return before;
  if (before.category === 'auto_acknowledgement' && next.category !== 'auto_acknowledgement') return next;
  return next.receivedAt > before.receivedAt || (next.receivedAt === before.receivedAt && next.messageId > before.messageId) ? next : before;
}

/** Legacy orders already have the classified inbox; never require another email. */
export async function loadEmployerResponse(orderRef, order) {
  const stored = response(order?.employerResponse);
  if (stored) return stored;
  const legacy = employerResponseOf(order);
  if (!legacy && !(Number(order?.employerReplies) > 0)) return null;
  const inbox = await orderRef.collection('inbox').where('status', '==', 'processed').get();
  return (inbox.docs || []).reduce((current, doc) => mergeEmployerResponse(current, { ...doc.data(), messageId: doc.id }), legacy);
}
