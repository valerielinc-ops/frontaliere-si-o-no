/** Retained server metadata about a cleared/revoked assertion, never the old answer. */
import { languageCodesIn } from './languageFacts.js';
import { qualificationCounterContextHash } from './qualificationCounterContext.js';

const SHA256 = /^[a-f0-9]{64}$/;
const sameRevisionOrUnknown = (marker, currentCvHash) => !(SHA256.test(marker.cvHash || '')
  && SHA256.test(currentCvHash || '') && marker.cvHash !== currentCvHash);

/** The caller supplies only retained conflicts already scoped to this candidate/job by the loader. */
export function languageAnswerSourceConflicts({ text = '', answerSourceConflicts = [], currentCvHash = '', languageCodes = null } = {}) {
  const codes = Array.isArray(languageCodes) ? languageCodes : languageCodesIn(text);
  return (Array.isArray(answerSourceConflicts) ? answerSourceConflicts : []).filter(marker => marker?.property === 'language_proficiency'
    && ['candidate', 'job'].includes(marker.scope) && codes.includes(marker.languageCode) && sameRevisionOrUnknown(marker, currentCvHash));
}

export function nativeAnswerSourceConflicts({ nativeFormContract, answerSourceConflicts = [], currentCvHash = '' } = {}) {
  const language = languageAnswerSourceConflicts({ text: `${nativeFormContract?.question || ''} ${nativeFormContract?.context || ''}`,
    answerSourceConflicts, currentCvHash });
  const property = `native_contract_sha256:${qualificationCounterContextHash(nativeFormContract)}`;
  const native = (Array.isArray(answerSourceConflicts) ? answerSourceConflicts : []).filter(marker => marker?.scope === 'job'
    && marker.property === property && sameRevisionOrUnknown(marker, currentCvHash));
  return [...new Set([...language, ...native])];
}
