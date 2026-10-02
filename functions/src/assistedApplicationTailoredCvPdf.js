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
import { pdfRendererMode, renderCvPdf } from './assistedApplicationPdfRenderer.js';
import { tailoredCvDocument } from './assistedApplicationTailoredCv.js';

export const PHOTO_TYPES = new Set(['jpg', 'png']);
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

/** Where the photo is customary: the advice the review page gives, by the posting's language. */
export function photoAdvice(language) {
  return language === 'de' ? 'recommended' : 'optional';
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
  const document = tailoredCvDocument(source, { identity, profile });
  let photo = null;
  if (flow?.photo?.key && PHOTO_TYPES.has(flow.photo.detectedType)) {
    const [buffer] = await bucket.file(flow.photo.key).download();
    photo = Buffer.from(buffer);
  }
  const { pdf, renderer } = await renderCvPdf(
    photo ? { ...document, photo, photoType: flow.photo.detectedType } : document,
    { mode: mode || await pdfRendererMode(), log },
  );
  const pdfKey = `assisted-application-uploads/${orderId}/ai-cv-r${draft.round || 1}-candidate-${nowMs}.pdf`;
  await bucket.file(pdfKey).save(pdf, { contentType: 'application/pdf', resumable: false });
  return { pdfKey, renderer };
}
