/** Versioned browser rechecks of retained uploads. The server never reads document text. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { DOCUMENT_CHECK_VERSION } from './lib/assistedApplicationDocumentCheckVersion.js';
import { hasAssistedApplicationConsent } from './assistedApplicationConstants.js';
import { isAssistedApplicationCvKey } from './assistedApplicationCvCheck.js';
import { MAX_DOCUMENT_BYTES, documentFileId, requiredDocumentsOf, sanitizeClientCheck } from './assistedApplicationExtraDocuments.js';
import { retentionPurgeDueAt, talentPoolConsentActive } from './assistedApplicationRetention.js';

export class DocumentRecheckError extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new DocumentRecheckError(code, status); };
const digest = value => createHash('sha256').update(value).digest('hex');
const LIFETIME_MS = 120000;
const signature = (payload, secret) => createHmac('sha256', secret).update(`document-recheck:${payload}`).digest('base64url');

function retained(order, claims, nowMs) {
  if (claims.kind !== 'review' || claims.expiresAt <= nowMs) fail('link_expired', 403);
  if (!order || order.paymentStatus !== 'paid' || !hasAssistedApplicationConsent(order)
    || order.retentionPurgedAt != null || order.withdrawnAt != null) fail('not_allowed', 403);
  if (claims.consentBound && !talentPoolConsentActive(order)) fail('link_expired', 403);
  const due = retentionPurgeDueAt(order);
  if (!talentPoolConsentActive(order) && (due == null || due <= nowMs)) fail('link_expired', 403);
}

function sourceOf({ order, flow, draft }, claims, documentId, fileId, nowMs) {
  retained(order, claims, nowMs);
  if (!flow || Number(flow.round || 1) !== claims.round || Number(draft?.round) !== claims.round) fail('stale_link');
  if ((claims.consentBound && flow.state !== 'submitted') || ['withdrawn', 'refunded', 'cancelled'].includes(flow.state)) fail('not_allowed', 403);
  const document = requiredDocumentsOf(draft).find(item => item.id === documentId);
  const files = flow.documents?.[documentId]?.files;
  const file = document && Array.isArray(files) && files.find(item => documentFileId(item.key) === fileId);
  if (!file || !isAssistedApplicationCvKey(claims.orderId, file.key)) fail('invalid_file', 404);
  const contextSha256 = digest(JSON.stringify({ document, key: file.key, size: file.size, uploadedAt: file.uploadedAt, detectedType: file.detectedType }));
  return { document, file, files, contextSha256 };
}

function verifyDescriptor(value, secret, nowMs) {
  if (typeof value !== 'string' || value.length > 4096) fail('invalid_check', 400);
  const [payload, mac, extra] = value.split('.');
  const expected = signature(payload || '', secret);
  if (extra || !/^[A-Za-z0-9_-]{43}$/.test(mac || '') || mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) fail('invalid_check', 400);
  let descriptor;
  try { descriptor = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch { fail('invalid_check', 400); }
  if (!descriptor || typeof descriptor !== 'object' || !Number.isFinite(descriptor.expiresAt) || descriptor.expiresAt <= nowMs || descriptor.version !== DOCUMENT_CHECK_VERSION) fail('check_expired', 409);
  return descriptor;
}

/** Caller supplies claims verified by the existing review-token authorization. */
export async function recheckStoredDocument({ db, bucket, claims, documentId, fileId, secret, body = {}, now = Date.now }) {
  const base = db.collection('assisted_applications').doc(claims.orderId);
  const flowRef = base.collection('automation').doc('flow');
  const draftRef = base.collection('ai_drafts').doc('current');
  const refs = [base, flowRef, draftRef];
  const stateOf = snapshots => ({ order: snapshots[0].exists ? snapshots[0].data() : null, flow: snapshots[1].data(), draft: snapshots[2].data() });
  const load = () => Promise.all(refs.map(ref => ref.get())).then(stateOf);
  const initial = sourceOf(await load(), claims, documentId, fileId, now());
  // Old Word and images have no browser text extractor. Preserve their existing check.
  if (!['pdf', 'docx'].includes(initial.file.detectedType)) return { state: 'unsupported' };
  if (!bucket) fail('storage_unavailable', 503);
  const object = bucket.file(initial.file.key);
  const [metadata] = await object.getMetadata();
  const generation = String(metadata.generation || '');
  const size = Number(metadata.size);
  if (!/^\d+$/.test(generation) || !Number.isSafeInteger(size) || size <= 0 || size > MAX_DOCUMENT_BYTES || size !== initial.file.size) fail('invalid_file', 400);
  const md5Hash = String(metadata.md5Hash || '');
  if (!/^[A-Za-z0-9+/]{22}==$/.test(md5Hash)) fail('invalid_file', 400);
  const identity = { orderId: claims.orderId, round: claims.round, documentId, fileId, generation, md5Hash, size, contextSha256: initial.contextSha256, version: DOCUMENT_CHECK_VERSION };
  if (!body.descriptor) {
    const prior = initial.file.documentCheckProof;
    if (prior?.version === DOCUMENT_CHECK_VERSION && prior.generation === generation && prior.md5Hash === md5Hash
      && prior.contextSha256 === initial.contextSha256 && /^[a-f0-9]{64}$/.test(prior.sha256 || '')
      && initial.file.clientCheck?.version === DOCUMENT_CHECK_VERSION) {
      const latest = sourceOf(await load(), claims, documentId, fileId, now());
      if (latest.contextSha256 !== initial.contextSha256) fail('file_changed');
      return { state: 'unchanged', clientCheck: sanitizeClientCheck(initial.file.clientCheck) };
    }
    const expiresAt = Math.min(now() + LIFETIME_MS, claims.expiresAt, retentionPurgeDueAt((await load()).order) ?? Infinity);
    const [bytes] = await bucket.file(initial.file.key, { generation }).download({ start: 0, end: MAX_DOCUMENT_BYTES });
    if (bytes.length !== size || createHash('md5').update(bytes).digest('base64') !== md5Hash) fail('file_changed');
    const sha256 = digest(bytes);
    const [after] = await object.getMetadata();
    if (String(after.generation) !== generation || after.md5Hash !== md5Hash || Number(after.size) !== size) fail('file_changed');
    const [url] = await object.getSignedUrl({ version: 'v4', action: 'read', expires: expiresAt, queryParams: { generation } });
    const latest = sourceOf(await load(), claims, documentId, fileId, now());
    if (latest.contextSha256 !== initial.contextSha256 || expiresAt <= now()) fail('file_changed');
    const payload = Buffer.from(JSON.stringify({ ...identity, expiresAt, sha256 })).toString('base64url');
    return { state: 'ready', url, descriptor: `${payload}.${signature(payload, secret)}`, size, generation, md5Hash, sha256, version: DOCUMENT_CHECK_VERSION };
  }
  const descriptor = verifyDescriptor(body.descriptor, secret, now());
  if (Object.entries(identity).some(([key, value]) => descriptor[key] !== value)) fail('file_changed');
  if (body.clientCheck?.version !== DOCUMENT_CHECK_VERSION || !['match', 'mismatch', 'looks_like_cv', 'unreadable'].includes(body.clientCheck?.verdict)
    || !/^[a-f0-9]{64}$/.test(body.sha256 || '') || body.sha256 !== descriptor.sha256) fail('invalid_check', 400);
  const clientCheck = sanitizeClientCheck(body.clientCheck);
  const proof = { version: DOCUMENT_CHECK_VERSION, generation, md5Hash, sha256: descriptor.sha256, contextSha256: initial.contextSha256 };
  return db.runTransaction(async transaction => {
    const current = sourceOf(stateOf(await Promise.all(refs.map(ref => transaction.get(ref)))), claims, documentId, fileId, now());
    if (current.contextSha256 !== initial.contextSha256) fail('file_changed');
    if (descriptor.expiresAt <= now()) fail('check_expired');
    const [currentMetadata] = await object.getMetadata();
    if (String(currentMetadata.generation) !== generation || currentMetadata.md5Hash !== md5Hash || Number(currentMetadata.size) !== size) fail('file_changed');
    if (Number(current.file.clientCheck?.version || 0) > DOCUMENT_CHECK_VERSION) fail('check_version_changed');
    transaction.set(flowRef, { documents: { [documentId]: { files: current.files.map(file => file === current.file
      ? { ...file, clientCheck, documentCheckProof: proof } : file) } } }, { merge: true });
    return { state: 'checked', clientCheck };
  });
}
