/** Give transport-only fixtures a real zero-positive document assessment.
 * Fixtures that model qualification claims must supply their own verified witness.
 */
import { transportSourceGuard } from './submissionSourceGuard';
import { createMemoryFirestore } from './memoryFirestore';
import { submissionGuard } from '../../functions/src/assistedApplicationSubmissionGuard.js';
import { createHash } from 'node:crypto';
import { qualificationSources, qualificationCounterContext, qualificationSourcesFingerprint, verifyQualificationEvidence } from '../../functions/src/lib/qualificationEvidence.js';

export async function reviewedDocumentContext(ctx: any) {
  const orderId = ctx.orderId || 'transport-fixture';
  const round = Number(ctx.flow?.round || ctx.draft?.round) || 1;
  if (!Object.hasOwn(ctx, 'answerSourceGuard')) ctx = { ...ctx, answerSourceGuard: transportSourceGuard() };
  if (!ctx.submissionGuard) {
    const base = `assisted_applications/${orderId}`;
    const store = createMemoryFirestore({ [base]: { cvUploadedAt: Date.now(), ...ctx.order },
      [`${base}/automation/flow`]: { round, state: 'submitting', dispatch: { mode: 'submit', round }, ...ctx.flow } });
    ctx = { ...ctx, submissionGuard: submissionGuard(store.db, orderId, round) };
  }
  const draft = ctx.draft;
  if (!draft || draft.entailment || draft.requirementsRaw || draft.qualificationMatch) return ctx;
  if (draft.matches?.some((row: any) => ['met', 'partial'].includes(row.status))) throw new Error('qualification fixture needs explicit witnessed claims');
  const requirements = { requirements: [] };
  const match = { matches: [] };
  const sources = qualificationSources({ sourceText: draft.factSources?.text || '', answerEvidence: ctx.answerEvidence || [] });
  const assessed = await verifyQualificationEvidence({ requirements, match, sources, preliminary: { status: 'unverified' },
    purpose: 'documents', unverifiedContext: qualificationCounterContext(ctx), generate: async () => { throw new Error('zero-positive fixture must not infer evidence'); } });
  return { ...ctx, draft: { ...draft, cvKey: ctx.order.cvStorageKey,
    sourceCvHash: createHash('sha256').update(ctx.cvBuffer).digest('hex'),
    requirementsRaw: requirements, qualificationMatch: match, entailment: assessed.verification,
    qualificationSourceFingerprint: qualificationSourcesFingerprint(sources) } };
}
