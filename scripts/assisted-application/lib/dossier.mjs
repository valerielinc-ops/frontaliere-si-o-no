/**
 * One PDF "Bewerbungsdossier" for an e-mail application (study 2026-10-02,
 * report-cv-lettera §4-§5). The sources disagree: SECO asks qualified
 * candidates writing by e-mail for a single document of at most 5 pages and
 * 2 MB; SBB wants the CV apart; the cantonal career services tell apprentices
 * one PDF per kind of document. So the dossier is an option behind the Remote
 * Config switch ASSISTED_APPLICATION_DOSSIER_MODE ("single"; default
 * "separate", the files as they leave today), never for an apprentice, and it
 * falls back to the separate files whenever a part cannot be merged (a Word
 * CV) or the dossier would exceed SECO's limits.
 */

import { PDFDocument } from 'pdf-lib';

export const DOSSIER_KEY = 'ASSISTED_APPLICATION_DOSSIER_MODE';
export const DOSSIER_LIMITS = Object.freeze({ pages: 5, bytes: 2 * 1024 * 1024 });
const DOSSIER_LABEL = { de: 'Bewerbungsdossier', fr: 'Dossier_de_candidature', it: 'Dossier_di_candidatura', en: 'Application' };
const A4 = [595.28, 841.89];

/** "single" only when the switch says so: the default keeps the separate files. */
export function dossierMode(env = process.env) {
  return String(env[DOSSIER_KEY] || '').trim().toLowerCase() === 'single' ? 'single' : 'separate';
}

// The draft's type of application as a string, read in one place with the letter's rebuild.
export { draftCandidateType } from '../../../functions/src/assistedApplicationCandidateType.js';

/** Never for an apprentice, nor for a draft whose type is unknown. */
export function wantsDossier({ mode, channelType, candidateType }) {
  return mode === 'single' && channelType === 'email' && Boolean(candidateType) && candidateType !== 'apprentice';
}

const typeOf = (name = '') => (/\.([a-z0-9]+)$/i.exec(name)?.[1] || '').toLowerCase().replace('jpeg', 'jpg');

/**
 * The parts in order (letter, CV, documents) as one PDF, or null when a part is
 * not a PDF, a JPG or a PNG.
 * @param {Array<{buffer:Buffer, type:string}>} parts
 * @returns {Promise<{pdf:Buffer, pages:number}|null>}
 */
export async function mergeParts(parts) {
  const dossier = await PDFDocument.create();
  for (const part of parts) {
    if (part.type === 'pdf') {
      const source = await PDFDocument.load(part.buffer, { ignoreEncryption: false });
      for (const page of await dossier.copyPages(source, source.getPageIndices())) dossier.addPage(page);
    } else if (part.type === 'jpg' || part.type === 'png') {
      const image = part.type === 'jpg' ? await dossier.embedJpg(part.buffer) : await dossier.embedPng(part.buffer);
      const page = dossier.addPage(A4);
      const scale = Math.min((A4[0] - 56) / image.width, (A4[1] - 56) / image.height, 1);
      const width = image.width * scale;
      const height = image.height * scale;
      page.drawImage(image, { x: (A4[0] - width) / 2, y: (A4[1] - height) / 2, width, height });
    } else {
      return null;
    }
  }
  return { pdf: Buffer.from(await dossier.save()), pages: dossier.getPageCount() };
}

/**
 * The dossier attachment, or null when the separate files must leave instead.
 * @param {{language:string, stem:string, letter:Buffer, cv:{buffer:Buffer, type:string}, extras:Array<{files:Array<{fileName:string, buffer:Buffer}>}>}} input
 * @returns {Promise<{filename:string, content:string, pages:number}|null>}
 */
export async function dossierAttachment({ language, stem, letter, cv, extras = [] }) {
  const parts = [
    { buffer: letter, type: 'pdf' },
    { buffer: cv.buffer, type: cv.type },
    ...extras.flatMap((document) => document.files.map((file) => ({ buffer: file.buffer, type: typeOf(file.fileName) }))),
  ];
  let merged = null;
  try {
    merged = await mergeParts(parts);
  } catch {
    return null; // an encrypted or broken PDF: the separate files leave
  }
  if (!merged || merged.pages > DOSSIER_LIMITS.pages || merged.pdf.length > DOSSIER_LIMITS.bytes) return null;
  return { filename: `${DOSSIER_LABEL[language] || DOSSIER_LABEL.it}_${stem}.pdf`, content: merged.pdf.toString('base64'), pages: merged.pages };
}
