/**
 * The letter PDF rebuilt after the draft: after the candidate's edits on the
 * review page, after the owner's edits, and at submission, when the documents
 * that leave with it are known. One place, so every rebuild prints the same
 * recipient (the posting's address kept on the draft; before, the rebuilds
 * printed only the contact person) and lists the enclosures that really leave.
 * letterBlocksFor gives the same blocks to the candidate's Word copy.
 */

import { letterEnclosures, letterPdfBlocks } from './assistedApplicationAiDraftCore.js';
import { candidateWithEdits } from './assistedApplicationCandidateEdits.js';
import { draftCandidateType } from './assistedApplicationCandidateType.js';
import { enclosedDocumentLabels } from './assistedApplicationExtraDocuments.js';
import { pdfRendererMode, renderLetterPdf } from './assistedApplicationPdfRenderer.js';

/**
 * The letter's blocks (letterPdfBlocks): what every rebuild prints, the PDF and the candidate's Word copy
 * alike (assistedApplicationDocx.js).
 * @param {{order:object, orderId:string, draft:object, flow?:object, letter?:object, nowMs:number}} input
 */
export function letterBlocksFor({ order, orderId, draft, flow = {}, letter, nowMs }) {
  const { identity, profile } = candidateWithEdits({ order, draft, flow });
  const language = draft?.language || 'it';
  return letterPdfBlocks({
    identity,
    profile,
    posting: draft?.letterAddress || { contactPerson: draft?.contactPerson || '' },
    companyName: order?.companyName,
    language,
    letter: letter || draft?.coverLetter || {},
    title: draft?.job?.title || order?.jobTitle || '',
    now: new Date(nowMs),
    enclosures: letterEnclosures(language, enclosedDocumentLabels(draft, flow, orderId)),
    // The apprenticeship's subject needs the type the draft was written for.
    type: draftCandidateType(draft),
  });
}

/**
 * @param {{order:object, orderId:string, draft:object, flow?:object, letter?:object, nowMs:number, mode?:string}} input
 * @returns {Promise<{pdf: Buffer, renderer: 'typst'|'legacy'}>} renderer: kept on the draft (`coverLetterRenderer`)
 */
export async function rebuildLetterPdf({ order, orderId, draft, flow = {}, letter, nowMs, mode }) {
  return renderLetterPdf(letterBlocksFor({ order, orderId, draft, flow, letter, nowMs }), { mode: mode || await pdfRendererMode() });
}
