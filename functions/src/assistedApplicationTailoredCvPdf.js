/**
 * The tailored CV rebuilt after the draft, in the Cloud Functions: when the
 * candidate adds or removes a photo, corrects the name, the phone or the
 * place, or (phase 4) accepts or rejects a rewritten line. The draft keeps
 * the sanitized tailored CV (`tailoredCv.cv`); every fact is still copied from
 * the profile, the candidate's corrections win (candidateWithEdits), and the
 * PDF goes through the same Typst renderer as the runner's.
 *
 * The photo (study 2026-10-02, report-cv-lettera §4): optional, never taken
 * from the candidate's CV, given on the review page. Customary in German-
 * speaking Switzerland, optional in Romandy and Ticino (SDBB/CSFO templates).
 */

import { candidateWithEdits } from './assistedApplicationCandidateEdits.js';
import { DOCX_CONTENT_TYPE, buildInPlaceDocx } from './assistedApplicationDocxInPlace.js';
import { pdfRendererMode, renderCvPdf } from './assistedApplicationPdfRenderer.js';
import { applyCvLineChoices, cvChoicesOf, tailoredCvDocument } from './assistedApplicationTailoredCv.js';

export const PHOTO_TYPES = new Set(['jpg', 'png']);
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

/** Where the photo is customary: the advice the review page gives, by the posting's language. */
export function photoAdvice(language) {
  return language === 'de' ? 'recommended' : 'optional';
}

/**
 * The photo the candidate gave on the review page, ready for the renderer:
 * `{ photo, photoType }`, or `{}` without one. The runner's next round reads
 * it too, so a new tailored CV keeps the photo the page says it has.
 */
export async function candidatePhoto(flow, bucket) {
  if (!bucket || !flow?.photo?.key || !PHOTO_TYPES.has(flow.photo.detectedType)) return {};
  const [buffer] = await bucket.file(flow.photo.key).download();
  return { photo: Buffer.from(buffer), photoType: flow.photo.detectedType };
}

/**
 * @param {{bucket:object, order:object, orderId:string, draft:object, flow?:object, cv?:object, nowMs:number, mode?:string, log?:Function}} input
 *   cv: the tailored CV to print (default: the draft's)
 * @returns {Promise<{pdfKey:string, renderer:string}|null>} null when the draft has no tailored CV to rebuild
 */
export async function rebuildTailoredCvPdf({ bucket, order, orderId, draft, flow = {}, cv, nowMs, mode, log }) {
  const tailored = draft?.tailoredCv;
  const source = cv || tailored?.cv;
  if (tailored?.status !== 'ready' || !source || !bucket) return null;
  const { identity, profile } = candidateWithEdits({ order, draft, flow });
  // The candidate's line-by-line choices of this round hold through every rebuild (photo, corrected header).
  const document = tailoredCvDocument(applyCvLineChoices(source, cvChoicesOf(draft, flow), { profile }), { identity, profile });
  const { pdf, renderer } = await renderCvPdf({ ...document, ...await candidatePhoto(flow, bucket) }, { mode: mode || await pdfRendererMode(), log });
  const pdfKey = `assisted-application-uploads/${orderId}/ai-cv-r${draft.round || 1}-candidate-${nowMs}.pdf`;
  await bucket.file(pdfKey).save(pdf, { contentType: 'application/pdf', resumable: false });
  return { pdfKey, renderer };
}

/**
 * The candidate's own Word file again with their line-by-line choices (phase
 * 5): same base, same locks and budgets as the runner's first build. Without
 * LibreOffice here the length budget alone keeps the page count.
 * @returns {Promise<object|null>} the next `tailoredCv.inplace`, null when the draft has none ready
 */
export async function rebuildInPlaceDocx({ bucket, order, orderId, draft, flow = {}, nowMs }) {
  const inplace = draft?.tailoredCv?.inplace;
  if (inplace?.status !== 'ready' || !inplace.baseKey || !draft.tailoredCv.cv || !bucket) return null;
  const [base] = await bucket.file(inplace.baseKey).download();
  const { identity, profile } = candidateWithEdits({ order, draft, flow });
  const built = buildInPlaceDocx(Buffer.from(base), draft.tailoredCv.cv, { profile, identity, choices: cvChoicesOf(draft, flow) });
  if (built.status !== 'ready') return { ...inplace, status: 'fallback', reason: built.reason };
  const docxKey = `assisted-application-uploads/${orderId}/ai-cv-inplace-r${draft.round || 1}-candidate-${nowMs}.docx`;
  await bucket.file(docxKey).save(built.docx, { contentType: DOCX_CONTENT_TYPE, resumable: false });
  return { ...inplace, docxKey, patched: built.patched, skipped: built.skipped, pageCheck: 'budget' };
}
