/**
 * The letter PDF rebuilt after the draft: after the candidate's edits on the
 * review page, after the owner's edits, and at submission, when the documents
 * that leave with it are known. One place, so every rebuild prints the same
 * recipient (the posting's address kept on the draft; before, the rebuilds
 * printed only the contact person) and lists the enclosures that really leave.
 */

import { letterEnclosures, letterPdfBlocks } from './assistedApplicationAiDraftCore.js';
import { candidateWithEdits } from './assistedApplicationCandidateEdits.js';
import { enclosedDocumentLabels } from './assistedApplicationExtraDocuments.js';
import { pdfRendererMode, renderLetterPdf } from './assistedApplicationPdfRenderer.js';

/**
 * @param {{order:object, orderId:string, draft:object, flow?:object, letter?:object, nowMs:number, mode?:string}} input
 * @returns {Promise<{pdf: Buffer, renderer: 'typst'|'legacy'}>} renderer: kept on the draft (`coverLetterRenderer`)
 */
export async function rebuildLetterPdf({ order, orderId, draft, flow = {}, letter, nowMs, mode }) {
  const { identity, profile } = candidateWithEdits({ order, draft, flow });
  const language = draft?.language || 'it';
  const blocks = letterPdfBlocks({
    identity,
    profile,
    posting: draft?.letterAddress || { contactPerson: draft?.contactPerson || '' },
    companyName: order?.companyName,
    language,
    letter: letter || draft?.coverLetter || {},
    title: draft?.job?.title || order?.jobTitle || '',
    now: new Date(nowMs),
    enclosures: letterEnclosures(language, enclosedDocumentLabels(draft, flow, orderId)),
  });
  return renderLetterPdf(blocks, { mode: mode || await pdfRendererMode() });
}
