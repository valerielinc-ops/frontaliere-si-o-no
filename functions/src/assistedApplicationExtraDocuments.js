/**
 * Documents a posting requires besides the CV and the cover letter (Rolex,
 * 2026-10-02: «Vos bulletins des trois dernières années scolaires», the EVA
 * and GRI aptitude test results). Shared by the Functions, the runner
 * (scripts/assisted-application/lib/submit.mjs and lib/portal/) and the
 * owner's fill kit.
 *
 *   draft.requiredDocuments  what the posting asks for, as the draft read it:
 *     [{ id, label, kind, keywords, required, quote }]
 *   flow.requestedDocuments when requestedDocumentsOverride is true, the
 *     owner-curated list that the candidate sees in the review interface.
 *   flow.documents           uploaded or prepared material from the review page:
 *     { [id]: { preparedAt, files: [{ key, name, size, detectedType, uploadedAt, clientCheck }] } }
 *   localOnly                files held in browser memory for a postal packet; no file data is stored here.
 *
 * A required document is uploaded or the application waits (owner decision
 * 2026-10-08): what the posting demands cannot be skipped, and an application
 * sent without it only fails later, at the portal's upload or at the employer.
 * The «send without it» of 2026-10-02 is gone; a `waivedAt` an older flow
 * still holds is read by nothing.
 *
 * Uploaded files live in the order's own Storage folder (purged with it,
 * assistedApplicationRetention.js); a key outside it is never sent. Local-only
 * files never enter Storage or Firestore.
 */

import { safeFileStem } from './assistedApplicationAiDraftCore.js';
import { DOCUMENT_KINDS } from './assistedApplicationConstants.js';
import { isDegreeCertificateRequirement, isPhotoRequirement } from './lib/assistedApplicationDocumentKind.js';
import { detectCvFileType, isAssistedApplicationCvKey } from './assistedApplicationCvCheck.js';

export { DOCUMENT_KINDS };
// At most this many requested documents, and files per document.
// Keep enough slots for a posting's attachments plus live portal-only fields;
// dropping a ninth required file would let the runner send an incomplete application.
export const MAX_REQUIRED_DOCUMENTS = 16;
export const MAX_FILES_PER_DOCUMENT = 5;
// The form planner names a document by slot (a fixed enum for the model's
// schema): photo is reserved for portraits; extra_1..N keep the document order.
export const EXTRA_DOCUMENT_SLOTS = Object.freeze(['photo', ...Array.from({ length: MAX_REQUIRED_DOCUMENTS }, (_, index) => `extra_${index + 1}`)]);
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
// Portal photo inputs commonly enforce a much smaller image limit.
export const MAX_PORTAL_PHOTO_BYTES = 2 * 1024 * 1024;
// What the candidate's browser concluded about the file (owner decision
// 2026-10-02: a warning, never a block; recorded, never checked again).
export const CLIENT_CHECK_VERDICTS = Object.freeze(['match', 'mismatch', 'looks_like_cv', 'unreadable', 'unknown']);

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
  const version = Number(raw?.version);
  return { verdict, matched: text(raw?.matched, 60), ...(Number.isSafeInteger(version) && version > 0 && version < 100 ? { version } : {}) };
}

/** A file's id on the review page: the last part of its key (never the key's folder). */
export function documentFileId(key) {
  return String(key || '').split('/').pop();
}

/**
 * The review page's view of the requested documents: what the posting asks
 * and what the candidate gave (names and browser verdicts).
 */
export function documentsView(draft, flow, fileUrls = {}) {
  return requiredDocumentsFor(draft, flow).map((document) => {
    const given = flow?.documents?.[document.id] || {};
    return {
      ...document,
      files: flow?.postalSubmission?.enabled === true && document.localOnly
        ? []
        : (Array.isArray(given.files) ? given.files : []).map((file) => ({
        id: documentFileId(file.key),
        name: text(file.name, 120),
        url: fileUrls[documentFileId(file.key)] || null,
        size: Number(file.size) || 0,
        detectedType: file.detectedType || null,
        uploadedAt: Number(file.uploadedAt) || null,
        clientCheck: sanitizeClientCheck(file.clientCheck),
      })),
      preparedAt: Number(given.preparedAt) || null,
      exemption: (document.exemptions || []).includes(given.exemption) ? given.exemption : null,
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
    const instructions = text(item.instructions, 500);
    const delivery = item.delivery === 'offline' ? 'offline'
      : item.delivery === 'service' && id === 'curriculum_vitae' ? 'service' : null;
    const exemptions = [...new Set((Array.isArray(item.exemptions) ? item.exemptions : [])
      .filter((reason) => ['municipal_resident', 'municipal_employee'].includes(reason)))].slice(0, 2);
    out.push({
      id,
      label,
      kind: isPhotoRequirement(label, item.kind) ? 'photo'
        : isDegreeCertificateRequirement(label) ? 'diploma'
          : DOCUMENT_KINDS.includes(item.kind) && item.kind !== 'photo' ? item.kind : 'other',
      keywords: (Array.isArray(item.keywords) ? item.keywords : []).map((word) => text(word, 40)).filter(Boolean).slice(0, 12),
      required: item.required !== false,
      quote: text(item.quote, 300),
      ...(isPhotoRequirement(label, item.kind) && typeof item.accept === 'string' && item.accept.length <= 240
        ? { accept: text(item.accept, 240) } : {}),
      ...(isPhotoRequirement(label, item.kind) && Number.isSafeInteger(item.maxBytes) && item.maxBytes > 0
        ? { maxBytes: Math.min(item.maxBytes, MAX_DOCUMENT_BYTES) } : {}),
      // Files for these requirements stay in browser memory and are appended
      // to the postal PDF locally; their contents never reach Storage or the
      // document-text checker (health and criminal-record documents).
      ...(item.localOnly === true ? { localOnly: true } : {}),
      // Official or sensitive records can be requested in the interface as
      // a paper task. Their contents stay with the candidate and are not
      // uploaded to the service.
      ...(instructions ? { instructions } : {}),
      ...(delivery ? { delivery } : {}),
      ...(exemptions.length ? { exemptions } : {}),
    });
    if (out.length >= MAX_REQUIRED_DOCUMENTS) break;
  }
  return out;
}

/** The operator's list replaces extracted requirements for this order only. */
export function requiredDocumentsFor(draft, flow) {
  if (flow?.requestedDocumentsOverride !== true) return requiredDocumentsOf(draft);
  return requiredDocumentsOf({ ...(draft || {}), requiredDocuments: flow.requestedDocuments });
}

/** Whether a stored candidate image satisfies the live photo field constraints. */
export function photoFileAccepted(document, file) {
  if (!['jpg', 'png'].includes(file?.detectedType)) return false;

  const tokens = String(document?.accept || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
  const acceptedTypes = new Set();
  if (!tokens.length || tokens.includes('image/*')) {
    acceptedTypes.add('jpg');
    acceptedTypes.add('png');
  }
  for (const token of tokens) {
    if (['.jpg', '.jpeg', '.jpe', 'jpg', 'jpeg', 'jpe', 'image/jpeg', 'image/jpg'].includes(token)) acceptedTypes.add('jpg');
    if (['.png', 'png', 'image/png'].includes(token)) acceptedTypes.add('png');
  }
  if (!acceptedTypes.has(file.detectedType)) return false;

  const maxBytes = Math.min(MAX_PORTAL_PHOTO_BYTES,
    Number.isSafeInteger(document?.maxBytes) && document.maxBytes > 0 ? document.maxBytes : MAX_PORTAL_PHOTO_BYTES);
  return Number.isSafeInteger(file.size) && file.size > 0 && file.size <= maxBytes;
}

const GENERIC_DOCUMENT_LABEL_WORDS = new Set([
  'add', 'allegare', 'allegato', 'allegati', 'attach', 'attachment', 'attachments', 'carica', 'caricare',
  'document', 'documents', 'dokument', 'dokumente', 'fichier', 'fichiers', 'hochladen', 'hochzuladen',
  'join', 'joints', 'other', 'upload', 'uploads',
]);

/** A document label without upload instructions, accents or word order. */
export function requiredDocumentLabelKey(label) {
  if (isPhotoRequirement(label)) return 'photo';
  const tokens = String(label || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').split(' ').filter((token) => token && !GENERIC_DOCUMENT_LABEL_WORDS.has(token));
  return [...new Set(tokens)].sort().join(' ');
}

/**
 * Merge document requirements found in different evidence sources (the
 * posting and the live application form). A portal often repeats a posting's
 * document with a slightly different id; the label is the stronger identity
 * here, while the posting's order is kept before a portal-only requirement.
 */
export function mergeRequiredDocuments(...sources) {
  const merged = [];
  for (const [sourceIndex, source] of sources.entries()) {
    for (const item of Array.isArray(source) ? source : []) {
      const document = requiredDocumentsOf({ requiredDocuments: [item] })[0];
      if (!document) continue;
      const foldedLabel = document.label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/\s+/g, ' ').trim();
      const normalizedLabel = requiredDocumentLabelKey(document.label);
      const existing = merged.find((candidate) => candidate.document.id === document.id
        || (candidate.sourceIndex !== sourceIndex && normalizedLabel && requiredDocumentLabelKey(candidate.document.label) === normalizedLabel)
        || (candidate.sourceIndex !== sourceIndex && candidate.document.label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim() === foldedLabel));
      if (!existing) {
        merged.push({ document: { ...document }, sourceIndex });
        continue;
      }
      existing.document.required = existing.document.required || document.required;
      if (!existing.document.quote && document.quote) existing.document.quote = document.quote;
      if (document.kind === 'photo') {
        if (!existing.document.accept && document.accept) existing.document.accept = document.accept;
        if (document.maxBytes) existing.document.maxBytes = Math.min(existing.document.maxBytes || document.maxBytes, document.maxBytes);
      }
      existing.document.keywords = [...new Set([...existing.document.keywords, ...document.keywords])].slice(0, 12);
    }
  }
  return requiredDocumentsOf({ requiredDocuments: merged.map(({ document }) => document) });
}

/**
 * The required documents the candidate has not uploaded: they hold the send
 * like an open question, and nothing but a file lifts the hold (owner
 * decision 2026-10-08, see the head of this file).
 * @returns {string[]} their ids
 */
export function openRequiredDocuments(draft, documents = {}, flow = null) {
  return requiredDocumentsFor(draft, flow)
    .filter((document) => document.required)
    .filter((document) => {
      const given = documents?.[document.id] || (document.kind === 'photo' ? documents?.photo : null);
      if (given?.exemption && (document.exemptions || []).includes(given.exemption)) return false;
      if (flow?.postalSubmission?.enabled === true && document.localOnly) return false;
      if (flow?.postalSubmission?.enabled === true && document.delivery === 'offline') {
        return !(Array.isArray(given?.files) && given.files.length);
      }
      if (document.delivery === 'offline') return !Number(given?.preparedAt);
      if (document.delivery === 'service') return false;
      const files = Array.isArray(given?.files) ? given.files : [];
      if (document.kind !== 'photo') return files.length === 0;
      const sharedPhotoFiles = Array.isArray(documents?.photo?.files) ? documents.photo.files : [];
      const profilePhoto = flow?.photo && typeof flow.photo === 'object' ? [{
        key: flow.photo.key,
        name: `photo.${flow.photo.detectedType || ''}`,
        size: flow.photo.size,
        detectedType: flow.photo.detectedType,
        uploadedAt: flow.photo.uploadedAt,
      }] : [];
      return ![...files, ...sharedPhotoFiles, ...profilePhoto].some((file) => photoFileAccepted(document, file));
    })
    .map((document) => document.id);
}

/** The files the candidate gave for one document, kept only inside the order's folder. */
export function documentFilesOf(flow, orderId, id) {
  const files = flow?.documents?.[id]?.files;
  const prefix = `assisted-application-uploads/${orderId}/doc-${String(id || '').slice(0, 30)}-`;
  const orderPrefix = `assisted-application-uploads/${orderId}/`;
  return (Array.isArray(files) ? files : [])
    .filter((file) => {
      const key = String(file?.key || '');
      const name = key.startsWith(orderPrefix) ? key.slice(orderPrefix.length) : '';
      const slotSpecificName = /^doc-[a-z0-9_]+-\d+-[a-f0-9]{8}\./i.test(name);
      // New uploads include their document id in the filename, so they cannot
      // be reassigned between slots. Older files used a plain basename; keep
      // those readable for existing flows while rejecting nested paths and
      // another slot's new-style key.
      const belongsToDocument = key.startsWith(prefix) || (name && !name.includes('/') && !slotSpecificName);
      return isAssistedApplicationCvKey(orderId, key)
        && belongsToDocument
        && DOCUMENT_TYPES.includes(file?.detectedType);
    })
    .slice(0, MAX_FILES_PER_DOCUMENT);
}

/** Only candidate images that satisfy a photo field's live constraints. */
export function photoFilesOf(flow, orderId, document) {
  const files = documentFilesOf(flow, orderId, document?.id).filter((file) => photoFileAccepted(document, file));
  if (files.length) return files;
  const sharedSlotFiles = document?.id === 'photo' ? [] : documentFilesOf(flow, orderId, 'photo');
  const sharedPhotoFiles = sharedSlotFiles.filter((file) => photoFileAccepted(document, file));
  if (sharedPhotoFiles.length) return sharedPhotoFiles;
  const profilePhoto = flow?.photo && typeof flow.photo === 'object' ? {
    key: flow.photo.key,
    name: `photo.${flow.photo.detectedType || ''}`,
    size: flow.photo.size,
    detectedType: flow.photo.detectedType,
    uploadedAt: flow.photo.uploadedAt,
  } : null;
  return profilePhoto?.key && isAssistedApplicationCvKey(orderId, profilePhoto.key)
    && photoFileAccepted(document, profilePhoto) ? [profilePhoto] : [];
}

/**
 * What leaves with the application besides the CV and the letter: every
 * requested document the candidate gave files for, with its form slot.
 * @returns {Array<{id:string, slot:string, label:string, kind:string, keywords:string[], files:Array<{key:string, name:string, detectedType:string}>}>}
 */
export function extraDocumentsToSend(draft, flow, orderId) {
  let nextExtraSlot = 0;
  let photoSlotAssigned = false;
  return requiredDocumentsFor(draft, flow)
    .map((document) => {
      let slot;
      if (document.kind === 'photo' && !photoSlotAssigned) {
        photoSlotAssigned = true;
        slot = 'photo';
      } else {
        nextExtraSlot += 1;
        slot = `extra_${nextExtraSlot}`;
      }
      let files = documentFilesOf(flow, orderId, document.id);
      if (document.kind === 'photo') files = photoFilesOf(flow, orderId, document);
      return { ...document, slot, files };
    })
    .filter((document) => document.files.length > 0)
    .map(({ quote, required, ...document }) => document);
}

/**
 * The documents the letter lists under Beilagen/Annexes/Allegati. With the
 * candidate's flow (review page, owner edits, submission): exactly the
 * documents that leave with the application, so one with no file is not listed.
 * Without it (the draft's first letter): the documents the posting requires.
 */
export function enclosedDocumentLabels(draft, flow, orderId) {
  if (flow?.postalSubmission?.enabled) {
    return requiredDocumentsFor(draft, flow)
      .filter((document) => {
        const given = flow?.documents?.[document.id] || {};
        if (given.exemption && (document.exemptions || []).includes(given.exemption)) return false;
        return document.required || given.preparedAt || (Array.isArray(given.files) && given.files.length > 0);
      })
      .map((document) => document.label);
  }
  if (flow) return extraDocumentsToSend(draft, flow, orderId).map((document) => document.label);
  return requiredDocumentsOf(draft).filter((document) => document.required).map((document) => document.label);
}

/** "Bulletins_scolaires_2_Mario_Rossi.pdf": the document's label, its number when it has several files, the candidate. */
export function extraDocumentFileName({ label, index = 0, count = 1, name = '', type = 'pdf' }) {
  const ext = DOCUMENT_TYPES.includes(type) ? type : 'pdf';
  const part = count > 1 ? `_${index + 1}` : '';
  return `${safeFileStem(label).slice(0, 60)}${part}_${safeFileStem(name)}.${ext}`;
}
