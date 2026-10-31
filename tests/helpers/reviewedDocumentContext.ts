/** Give transport-only fixtures a real zero-positive document assessment.
 * Fixtures that model qualification claims must supply their own verified witness.
 */
import { createHash } from 'node:crypto';
import { qualificationSources, qualificationSourcesFingerprint, verifyQualificationEvidence } from '../../functions/src/lib/qualificationEvidence.js';

export async function reviewedDocumentContext(ctx: any) {
  const draft = ctx.draft;
  if (!draft || draft.entailment || draft.requirementsRaw || draft.qualificationMatch) return ctx;
  if (draft.matches?.some((row: any) => ['met', 'partial'].includes(row.status))) throw new Error('qualification fixture needs explicit witnessed claims');
  const requirements = { requirements: [] };
  const match = { matches: [] };
  const sources = qualificationSources({ sourceText: draft.factSources?.text || '', answerEvidence: ctx.answerEvidence || [] });
  const assessed = await verifyQualificationEvidence({ requirements, match, sources, preliminary: { status: 'unverified' },
    purpose: 'documents', generate: async () => { throw new Error('zero-positive fixture must not infer evidence'); } });
  return { ...ctx, draft: { ...draft, cvKey: ctx.order.cvStorageKey,
    sourceCvHash: createHash('sha256').update(ctx.cvBuffer).digest('hex'),
    requirementsRaw: requirements, qualificationMatch: match, entailment: assessed.verification,
    qualificationSourceFingerprint: qualificationSourcesFingerprint(sources) } };
}
