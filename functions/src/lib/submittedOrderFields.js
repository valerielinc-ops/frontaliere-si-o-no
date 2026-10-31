/** The existing mark_submitted order fields, shared with durable-receipt reconciliation. */
const SUBMITTABLE_STATUSES = new Set(['awaiting_upload', 'ready_for_manual_submission', 'in_progress']);
export function submittedOrderFields({ order, effect = {}, flow, timestamp }) {
  if (!SUBMITTABLE_STATUSES.has(order?.submissionStatus)) return null;
  const via = effect.by === 'candidate' ? 'il candidato dal portale (handoff)'
    : effect.by === 'owner' ? 'Valerie sul portale, dopo lo stop del robot'
      : `automazione (${flow.submittedVia || 'invio'})`;
  const notes = flow.submittedVia === 'whatsapp'
    ? 'Candidatura via WhatsApp: link e istruzioni inviati al candidato, che la completa dal proprio telefono.'
    : `Candidatura inviata da ${via}.`;
  return { submissionStatus: 'submitted', submittedAt: timestamp, statusChangedAt: timestamp, updatedAt: timestamp, submissionNotes: notes };
}
