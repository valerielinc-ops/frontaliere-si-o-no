/**
 * Documents a posting requires besides the CV and the cover letter (Rolex,
 * 2026-10-02: «Vos bulletins des trois dernières années scolaires», the EVA
 * and GRI aptitude test results). Shared by the Functions, the runner
 * (scripts/assisted-application/lib/submit.mjs and lib/portal/) and the
 * owner's fill kit.
 *
 *   draft.requiredDocuments  what the posting asks for, as the draft read it:
 *     [{ id, label, kind, keywords, required, quote }]
 *   flow.documents           what the candidate gave on the review page:
 *     { [id]: { files: [{ key, name, size, detectedType, uploadedAt, clientCheck }], waivedAt } }
 *
 * The files live in the order's own Storage folder (purged with it,
 * assistedApplicationRetention.js); a key outside it is never sent.
 */

import { safeFileStem } from './assistedApplicationAiDraftCore.js';
import { isAssistedApplicationCvKey } from './assistedApplicationCvCheck.js';

export const DOCUMENT_KINDS = Object.freeze([
  'school_report', 'aptitude_test', 'diploma', 'certificate', 'reference', 'work_permit', 'identity', 'portfolio', 'other',
]);
// At most this many requested documents, and files per document.
export const MAX_REQUIRED_DOCUMENTS = 8;
export const MAX_FILES_PER_DOCUMENT = 5;
// The form planner names a document by slot (a fixed enum for the model's
// schema): extra_1 is the first requested document, and so on.
export const EXTRA_DOCUMENT_SLOTS = Object.freeze(Array.from({ length: MAX_REQUIRED_DOCUMENTS }, (_, index) => `extra_${index + 1}`));
export const DOCUMENT_TYPES = Object.freeze(['pdf', 'docx', 'doc', 'jpg', 'png']);

const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const docId = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

/** The draft's requested documents, cleaned (unknown kind → other, no duplicate id). */
export function requiredDocumentsOf(draft) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(draft?.requiredDocuments) ? draft.requiredDocuments : []) {
    const id = docId(item?.id);
    const label = text(item?.label, 160);
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      label,
      kind: DOCUMENT_KINDS.includes(item.kind) ? item.kind : 'other',
      keywords: (Array.isArray(item.keywords) ? item.keywords : []).map((word) => text(word, 40)).filter(Boolean).slice(0, 12),
      required: item.required !== false,
      quote: text(item.quote, 300),
    });
    if (out.length >= MAX_REQUIRED_DOCUMENTS) break;
  }
  return out;
}

/** The files the candidate gave for one document, kept only inside the order's folder. */
export function documentFilesOf(flow, orderId, id) {
  const files = flow?.documents?.[id]?.files;
  return (Array.isArray(files) ? files : [])
    .filter((file) => isAssistedApplicationCvKey(orderId, file?.key) && DOCUMENT_TYPES.includes(file?.detectedType))
    .slice(0, MAX_FILES_PER_DOCUMENT);
}

/**
 * What leaves with the application besides the CV and the letter: every
 * requested document the candidate gave files for, with its form slot.
 * @returns {Array<{id:string, slot:string, label:string, kind:string, keywords:string[], files:Array<{key:string, name:string, detectedType:string}>}>}
 */
export function extraDocumentsToSend(draft, flow, orderId) {
  return requiredDocumentsOf(draft)
    .map((document, index) => ({ ...document, slot: EXTRA_DOCUMENT_SLOTS[index], files: documentFilesOf(flow, orderId, document.id) }))
    .filter((document) => document.files.length > 0)
    .map(({ quote, required, ...document }) => document);
}

/** "Bulletins_scolaires_2_Mario_Rossi.pdf": the document's label, its number when it has several files, the candidate. */
export function extraDocumentFileName({ label, index = 0, count = 1, name = '', type = 'pdf' }) {
  const ext = DOCUMENT_TYPES.includes(type) ? type : 'pdf';
  const part = count > 1 ? `_${index + 1}` : '';
  return `${safeFileStem(label).slice(0, 60)}${part}_${safeFileStem(name)}.${ext}`;
}
