/** Private original-source context shared by the server proof route and the Node portal runner. */
import { createHash } from 'node:crypto';
import { qualificationSources, qualificationSourcesFingerprint, hasCurrentQualificationDocuments } from './qualificationEvidence.js';
import { qualificationCounterContext, qualificationCounterContextHash, qualificationAnswerOriginContext } from './qualificationCounterContext.js';
const digest = value => createHash('sha256').update(value).digest('hex');

/** The source was extracted for this exact approved CV, not its tailored replacement. */
export function nativeQualificationContext({ order = {}, orderId = '', draft = {}, cvBuffer, answerEvidence = [], localAnswerEvidence = [], answerCounterContext = [], answerSourceConflicts = [], rawCounterContext, intake = null, applicationIdentity = null, docsManifest = [], policyAuthority = null, flow = {} }) {
  const currentHash = Buffer.isBuffer(cvBuffer) ? digest(cvBuffer) : '';
  const sameCv = Boolean(currentHash && draft.cvKey && draft.cvKey === order.cvStorageKey
    && draft.sourceCvHash === currentHash);
  const sourceText = sameCv && typeof draft.factSources?.text === 'string' ? draft.factSources.text : '';
  const counterContext = qualificationCounterContext({ order, flow, intake, answerCounterContext, rawCounterContext });
  const documentSourceFingerprint = qualificationSourcesFingerprint(qualificationSources({ sourceText, answerEvidence }));
  return {
    // Only server-validated actual identity scalars/manifest are supplied by the caller.
    applicationIdentity: applicationIdentity && typeof applicationIdentity === 'object' ? Object.fromEntries(
      ['firstName', 'lastName', 'fullName', 'email', 'phone', 'linkedin'].filter(key => typeof applicationIdentity[key] === 'string')
        .map(key => [key, applicationIdentity[key]])) : null,
    docsManifest: structuredClone(docsManifest),
    policyAuthority: structuredClone(policyAuthority),
    documentsCurrent: hasCurrentQualificationDocuments({ draft, sourceCvHash: sameCv ? currentHash : null, sourceFingerprint: documentSourceFingerprint, counterContext }),
    sources: qualificationSources({ sourceText, answerEvidence, localAnswerEvidence, policyAuthority, purpose: 'native_form' }),
    documentSourceFingerprint,
    localAnswerCounterHash: qualificationCounterContextHash(qualificationAnswerOriginContext({ order, flow, intake })),
    answerEvidence,
    approvedDocumentTexts: { coverLetter: typeof draft.coverLetter?.text === 'string' ? draft.coverLetter.text : '',
      motivation: typeof draft.formAnswers?.motivationShort === 'string' ? draft.formAnswers.motivationShort : '',
      whyCompany: typeof draft.formAnswers?.whyCompany === 'string' ? draft.formAnswers.whyCompany : '' },
    // Local declarations stay job/round scoped; native proofs enforce the exact original contract.
    localAnswerEvidence,
    scope: { orderId, jobId: order.jobId || null, jobTitle: order.jobTitle || draft.job?.title || '', round: Number.isSafeInteger(Number(draft.round)) && Number(draft.round) > 0 ? Number(draft.round) : null, jobUrl: order.jobUrl || draft.job?.applyUrl || '',
      sourceCvHash: currentHash || null, sourceUnbound: !sameCv, cvLanguageProfile: sameCv ? draft.qualificationCvLanguageProfile : null, answerSourceConflicts: structuredClone(answerSourceConflicts) },
    // These are counter-evidence only. They never create a citable fact.
    unverifiedContext: { ...counterContext,
      historicalContext: draft.factSources?.answers || '' },
  };
}


