/**
 * The letter PDF rebuilt after the draft: after the candidate's edits on the
 * review page, after the owner's edits, and at submission, when the documents
 * that leave with it are known. One place, so every rebuild prints the same
 * recipient (the posting's address kept on the draft; before, the rebuilds
 * printed only the contact person) and lists the enclosures that really leave.
 */

import { buildCoverLetterPdf } from './assistedApplicationAiDocuments.js';
import { letterEnclosures, letterPdfBlocks } from './assistedApplicationAiDraftCore.js';
import { candidateWithEdits } from './assistedApplicationCandidateEdits.js';
import { enclosedDocumentLabels } from './assistedApplicationExtraDocuments.js';

/**
 * @param {{order:object, orderId:string, draft:object, flow?:object, letter?:object, nowMs:number}} input
 * @returns {Buffer}
 */
export function rebuildLetterPdf({ order, orderId, draft, flow = {}, letter, nowMs }) {
  const { identity, profile } = candidateWithEdits({ order, draft, flow });
  const language = draft?.language || 'it';
  return buildCoverLetterPdf(letterPdfBlocks({
    identity,
    profile,
    posting: draft?.letterAddress || { contactPerson: draft?.contactPerson || '' },
    companyName: order?.companyName,
    language,
    letter: letter || draft?.coverLetter || {},
    title: draft?.job?.title || order?.jobTitle || '',
    now: new Date(nowMs),
    enclosures: letterEnclosures(language, enclosedDocumentLabels(draft, flow, orderId)),
  }));
}
