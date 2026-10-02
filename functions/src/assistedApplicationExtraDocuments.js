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
import { DOCUMENT_KINDS } from './assistedApplicationConstants.js';
import { detectCvFileType, isAssistedApplicationCvKey } from './assistedApplicationCvCheck.js';

export { DOCUMENT_KINDS };
// At most this many requested documents, and files per document.
export const MAX_REQUIRED_DOCUMENTS = 8;
export const MAX_FILES_PER_DOCUMENT = 5;
// The form planner names a document by slot (a fixed enum for the model's
// schema): extra_1 is the first requested document, and so on.
export const EXTRA_DOCUMENT_SLOTS = Object.freeze(Array.from({ length: MAX_REQUIRED_DOCUMENTS }, (_, index) => `extra_${index + 1}`));
export const DOCUMENT_TYPES = Object.freeze(['pdf', 'docx', 'doc', 'jpg', 'png']);
export const DOCUMENT_CONTENT_TYPES = Object.freeze({
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  jpg: 'image/jpeg',
  png: 'image/png',
});
// Per file: a scan of three school reports fits; the request stays far under the 32 MB limit in base64.
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
// What the candidate's browser concluded about the file (owner decision
// 2026-10-02: a warning, never a block; recorded, never checked again).
export const CLIENT_CHECK_VERDICTS = Object.freeze(['match', 'mismatch', 'looks_like_cv', 'unreadable']);

const IMAGE_SIGNATURES = [
  { type: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  { type: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
];

/** The file's real type from its first bytes: the CV's types, and a photo or scan (jpg, png). */
export function detectDocumentType(head) {
  const bytes = head instanceof Uint8Array ? head : new Uint8Array(head || []);
  const office = detectCvFileType(bytes);
  if (office) return office;
  return IMAGE_SIGNATURES.find((signature) => signature.bytes.every((value, index) => bytes[index] === value))?.type || null;
}

/** The browser's verdict as recorded: one of the known verdicts, the matched word bounded. */
export function sanitizeClientCheck(raw) {
  const verdict = CLIENT_CHECK_VERDICTS.includes(raw?.verdict) ? raw.verdict : 'unreadable';
  return { verdict, matched: text(raw?.matched, 60) };
}

/** A file's id on the review page: the last part of its key (never the key's folder). */
export function documentFileId(key) {
  return String(key || '').split('/').pop();
}

/**
 * The review page's view of the requested documents: what the posting asks,
 * what the candidate gave (names and browser verdicts), whether they chose to
 * send without it.
 */
export function documentsView(draft, flow) {
  return requiredDocumentsOf(draft).map((document) => {
    const given = flow?.documents?.[document.id] || {};
    return {
      ...document,
      files: (Array.isArray(given.files) ? given.files : []).map((file) => ({
        id: documentFileId(file.key),
        name: text(file.name, 120),
        size: Number(file.size) || 0,
        detectedType: file.detectedType || null,
        uploadedAt: Number(file.uploadedAt) || null,
        clientCheck: sanitizeClientCheck(file.clientCheck),
      })),
      waived: Boolean(given.waivedAt),
    };
  });
}

const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const docId = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

/**
 * The draft's documents from the requirements pass (requestedDocuments, quotes
 * already verified against the posting): an id from the wording, stable while
 * the posting is unchanged (the requirements are reused across rounds).
 */
export function requiredDocumentsFromRequirements(requirements) {
  const items = Array.isArray(requirements?.requestedDocuments) ? requirements.requestedDocuments : [];
  return requiredDocumentsOf({
    requiredDocuments: items.map((item, index) => {
      const slug = String(item?.document || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
      return { id: slug || `${item?.kind || 'document'}_${index + 1}`, label: item?.document, kind: item?.kind, keywords: item?.keywords, required: item?.required, quote: item?.quote };
    }),
  });
}

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

/**
 * The required documents the candidate has neither uploaded nor chosen to
 * send without (owner decision 2026-10-02: a warning, never a block, the
 * choice is theirs): they hold the send like an open question.
 * @returns {string[]} their ids
 */
export function openRequiredDocuments(draft, documents = {}) {
  return requiredDocumentsOf(draft)
    .filter((document) => document.required)
    .filter((document) => {
      const given = documents?.[document.id];
      return !(Array.isArray(given?.files) && given.files.length) && !given?.waivedAt;
    })
    .map((document) => document.id);
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
