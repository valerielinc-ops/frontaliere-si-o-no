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

import { randomUUID } from 'node:crypto';
import { candidateWithEdits } from './assistedApplicationCandidateEdits.js';
import { buildInPlaceDocx, documentXmlOf } from './assistedApplicationDocxInPlace.js';
import { pdfRendererMode, renderCvPdf } from './assistedApplicationPdfRenderer.js';
import { applyCvLineChoices, cvChoicesOf, tailoredCvDocument } from './assistedApplicationTailoredCv.js';

export const PHOTO_TYPES = new Set(['jpg', 'png']);
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

/** Where the photo is customary: the advice the review page gives, by the posting's language. */
export function photoAdvice(language) {
  return language === 'de' ? 'recommended' : 'optional';
}

/**
 * Whether a JPG arrived whole: its segments chain from the start marker to a
 * frame with a size, and its scans run to the end marker. Typst copies a JPG's
 * data into the PDF as it is, so a file cut on the way still compiles and
 * prints half grey (a cut PNG fails the compile); its first bytes alone cannot
 * tell. A thumbnail inside a segment (EXIF) is skipped with the segment, and
 * what follows the end marker (some phones append data) is not the picture.
 */
export function jpegIsWhole(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return false;
  let frame = false;
  let scanned = false;
  let offset = 2;
  while (offset + 1 < buffer.length) {
    const marker = buffer[offset + 1];
    // Fill bytes (0xFF) and stray bytes between segments are skipped, as libjpeg does.
    if (buffer[offset] !== 0xff || marker === 0xff || marker === 0x00) {
      offset += 1;
      continue;
    }
    if (marker === 0xd9) return scanned;
    if (marker === 0xd8) return false;
    // TEM and the restart markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (offset + 4 > buffer.length) return false;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.length) return false;
    // A frame header (SOF0-15 but DHT, JPG and DAC), with a height and a width.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (length < 8 || !buffer.readUInt16BE(offset + 5) || !buffer.readUInt16BE(offset + 7)) return false;
      frame = true;
    }
    offset += 2 + length;
    if (marker !== 0xda) continue;
    if (!frame) return false;
    scanned = true;
    // The scan's data runs to the next marker: 0xFF 0x00 is a data byte, 0xFF 0xD0-0xD7 a restart.
    while (offset + 1 < buffer.length && (buffer[offset] !== 0xff || buffer[offset + 1] === 0x00 || (buffer[offset + 1] >= 0xd0 && buffer[offset + 1] <= 0xd7))) offset += 1;
  }
  return false;
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
 * Whether the tailored-CV PDF on the draft carries the candidate's photo. The
 * standard-font writer never printed one, whatever a record from before the
 * result was recorded says (it recorded that a photo was given).
 */
export function tailoredCvCarriesPhoto(draft) {
  return draft?.tailoredCv?.photo === true && draft.tailoredCv.renderer !== 'legacy';
}

/**
 * The draft's tailored-CV PDF when it carries the photo. Once a new PDF replaces
 * it (a rebuild on the review page, the next round's draft) no document names
 * it, and it is deleted after that commit: a photo the candidate takes back
 * does not stay in a superseded PDF until the purge.
 * @returns {string|null}
 */
export function supersededPhotoPdf(draft) {
  return tailoredCvCarriesPhoto(draft) ? draft.tailoredCv.pdfKey || null : null;
}

/**
 * @param {{bucket:object, order:object, orderId:string, draft:object, flow?:object, cv?:object, nowMs:number, mode?:string, log?:Function}} input
 *   cv: the tailored CV to print (default: the draft's)
 * @returns {Promise<{pdfKey:string, renderer:string, photo:boolean}|null>} photo: the PDF carries the candidate's photo;
 *   null when the draft has no tailored CV to rebuild
 */
export async function rebuildTailoredCvPdf({ bucket, order, orderId, draft, flow = {}, cv, nowMs, mode, log }) {
  const tailored = draft?.tailoredCv;
  const source = cv || tailored?.cv;
  if (tailored?.status !== 'ready' || !source || !bucket) return null;
  const { identity, profile } = candidateWithEdits({ order, draft, flow });
  // The candidate's line-by-line choices of this round hold through every rebuild (photo, corrected header).
  const document = tailoredCvDocument(applyCvLineChoices(source, cvChoicesOf(draft, flow), { profile }), { identity, profile });
  const { pdf, renderer, photo } = await renderCvPdf({ ...document, ...await candidatePhoto(flow, bucket) }, { mode: mode || await pdfRendererMode(), log });
  // A key of its own per rebuild: a request refused at its commit deletes its PDF, never the one another request published.
  const pdfKey = `assisted-application-uploads/${orderId}/ai-cv-r${draft.round || 1}-candidate-${nowMs}-${randomUUID().slice(0, 8)}.pdf`;
  await bucket.file(pdfKey).save(pdf, { contentType: 'application/pdf', resumable: false });
  return { pdfKey, renderer, photo };
}

/**
 * The candidate's own Word file after their line-by-line choices (phase 5).
 * The Cloud Functions have no LibreOffice to count pages, and a file whose
 * pages were not counted is never offered nor sent: the file stays offered
 * while the choices leave it as the runner verified it (the same
 * document.xml), and falls back to the template CV otherwise
 * (`needs_page_check`), until choices that match it again.
 * @returns {Promise<object|null>} the next `tailoredCv.inplace`, null when the draft has none to reconsider
 */
export async function rebuildInPlaceDocx({ bucket, order, draft, flow = {} }) {
  const inplace = draft?.tailoredCv?.inplace;
  const reconsider = inplace?.status === 'ready' || (inplace?.status === 'fallback' && inplace.reason === 'needs_page_check');
  if (!reconsider || !inplace.verifiedKey || !inplace.baseKey || !draft.tailoredCv.cv || !bucket) return null;
  const [[base], [verified]] = await Promise.all([bucket.file(inplace.baseKey).download(), bucket.file(inplace.verifiedKey).download()]);
  const { identity, profile } = candidateWithEdits({ order, draft, flow });
  const built = buildInPlaceDocx(Buffer.from(base), draft.tailoredCv.cv, { profile, identity, choices: cvChoicesOf(draft, flow) });
  const verifiedXml = documentXmlOf(Buffer.from(verified));
  const same = built.status === 'ready' && Boolean(verifiedXml) && documentXmlOf(built.docx) === verifiedXml;
  return same
    ? { ...inplace, status: 'ready', reason: null, docxKey: inplace.verifiedKey }
    : { ...inplace, status: 'fallback', reason: 'needs_page_check' };
}
