/** A real concierge service owns an in-flight CV transfer until its publication commits. */
import { createHash, randomUUID } from 'node:crypto';
import { FieldPath } from 'firebase-admin/firestore';
import {
  APPLICATION_CONCIERGE_CONSENT_VERSION, APPLICATION_CONCIERGE_SERVICES_COLLECTION,
  APPLICATION_CONCIERGE_MAX_POSITIONS, acceptedPositionsCount, serviceIsActive, timestampMillis,
} from './applicationConciergeConstants.js';
import { uploadOwnedArtifact, ownedArtifactGeneration, deleteOwnedArtifactGeneration } from './lib/assistedApplicationArtifactRetention.js';

export const CONCIERGE_MAX_CV_BYTES = 5 * 1024 * 1024;
const COLLECTION = 'pending_material_copies';
const REQUESTS = 'material_copy_requests';
const OPERATION_MS = 60_000; // An operation lease, never a data-retention period.
const CLEANUP_PAGE_SIZE = 50;
const TYPES = new Set(['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
const ID = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
const revoked = value => !value || value.retentionPurgingAt != null || value.retentionPurgedAt != null
  || value.retentionPayloadPurgedAt != null || value.deletedAt != null || value.withdrawnAt != null
  || value.refundedAt != null || ['pending', 'completed', 'succeeded', 'refunded'].includes(value.refundStatus);
const sourceKeyValid = (serviceId, key) => typeof key === 'string' && key.length <= 600
  && key.startsWith(`application-concierge-uploads/${serviceId}/`)
  && /^[A-Za-z0-9._-]+$/.test(key.slice(`application-concierge-uploads/${serviceId}/`.length)) && !key.includes('..');
const freshConsent = (value, version, now) => value?.[version] === APPLICATION_CONCIERGE_CONSENT_VERSION
  && timestampMillis(value?.[version === 'consentVersion' ? 'consentedAt' : 'renewalConsentedAt']) > 0
  && timestampMillis(value?.[version === 'consentVersion' ? 'consentedAt' : 'renewalConsentedAt']) <= now;

// Project SDK Timestamp values before cloning or hashing: structuredClone strips their prototype.
function sourceRevision(service) {
  return hash([service?.userId ?? null, service?.cvStorageKey ?? null, timestampMillis(service?.cvUploadedAt),
    service?.consentVersion ?? null, timestampMillis(service?.consentedAt)]);
}
function proposalRevision(proposal) {
  return hash(['jobId', 'jobUrl', 'companyId', 'companyName', 'jobTitle', 'location', 'applyMode',
    'eligibilityStatus', 'eligibilityCvStorageKey'].map(key => proposal?.[key] ?? null));
}
function recordValid(record, writeId) {
  if (!record || record.writeId !== writeId || !ID(writeId) || !ID(record.serviceId) || !ID(record.sourceServiceId)
    || !ID(record.targetId) || !['proposal', 'renewal'].includes(record.purpose) || !ID(record.uid)
    || !(sourceKeyValid(record.sourceServiceId, record.sourceKey) || record.minimal === true && record.revokedAt > 0)
    || !Number.isFinite(record.expiresAt)
    || !/^[a-f0-9]{64}$/.test(record.sourceRevision || '')) return false;
  const prefix = record.purpose === 'proposal' ? `assisted-application-uploads/${record.targetId}/`
    : `application-concierge-uploads/${record.serviceId}/`;
  return record.key === `${prefix}${record.purpose === 'renewal' ? 'renewal-' : 'copy-'}${writeId}.${record.extension}`
    && ['pdf', 'doc', 'docx'].includes(record.extension)
    && (record.purpose === 'proposal' ? ID(record.proposalId) && record.sourceServiceId === record.serviceId
      && record.requestId === `proposal-${record.proposalId}` : record.targetId === record.serviceId && record.requestId === 'renewal');
}
function refsFor(db, record) {
  const service = db.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION).doc(record.serviceId);
  return { service, source: db.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION).doc(record.sourceServiceId),
    proposal: record.purpose === 'proposal' ? service.collection('proposals').doc(record.proposalId) : null,
    target: record.purpose === 'proposal' ? db.collection('assisted_applications').doc(record.targetId) : service,
    marker: service.collection(COLLECTION).doc(record.writeId),
    request: service.collection(REQUESTS).doc(record.requestId) };
}
async function contextInTransaction(tx, refs) {
  const [service, source, target, proposal] = await Promise.all([
    tx.get(refs.service), tx.get(refs.source), tx.get(refs.target), refs.proposal ? tx.get(refs.proposal) : null,
  ]);
  return { service: service.data(), source: source.data(), target: target.data(), proposal: proposal?.data() };
}
function published(record, context) {
  const target = context.target;
  return target?.cvStorageKey === record.key && target.cvMaterialCopyWriteId === record.writeId
    && (record.purpose === 'renewal' ? target.userId === record.uid && target.renewalOfServiceId === record.sourceServiceId
      : target.userId === record.uid && target.parentServiceId === record.serviceId && target.parentProposalId === record.proposalId
        && context.proposal?.status === 'accepted' && context.proposal.childApplicationId === record.targetId);
}
function allowed(record, context, now) {
  const { service, source, proposal, target } = context;
  if (!Number.isFinite(now) || now >= record.expiresAt || revoked(service) || revoked(source)
    || service?.userId !== record.uid || source?.userId !== record.uid || source.paymentStatus !== 'paid'
    || !serviceIsActive(service, now) || !freshConsent(source, 'consentVersion', now)
    || sourceRevision(source) !== record.sourceRevision || source.cvStorageKey !== record.sourceKey) return false;
  if (record.purpose === 'renewal') return service.renewalOfServiceId === record.sourceServiceId
    && freshConsent(service, 'renewalConsentVersion', now) && !target?.cvStorageKey && !service.renewalMaterialsCopiedAt;
  return record.sourceServiceId === record.serviceId && freshConsent(service, 'consentVersion', now)
    && !target && proposal?.status === 'proposed' && proposal.eligibilityStatus === 'compatible'
    && proposal.eligibilityCvStorageKey === source.cvStorageKey && proposalRevision(proposal) === record.proposalRevision
    && acceptedPositionsCount(service) < (Number(service.maxPositions) || APPLICATION_CONCIERGE_MAX_POSITIONS);
}
function revokedRecord(record, nowMs) {
  return { purpose: record.purpose, serviceId: record.serviceId, sourceServiceId: record.sourceServiceId,
    targetId: record.targetId, proposalId: record.proposalId, uid: record.uid, requestId: record.requestId,
    writeId: record.writeId, key: record.key, extension: record.extension, sourceRevision: record.sourceRevision,
    expiresAt: record.expiresAt, state: record.state, transportUnknown: record.transportUnknown === true,
    revokedAt: record.revokedAt || nowMs, minimal: true };
}

/** Private server inputs only. No child document is fabricated to obtain upload authority. */
export function conciergeMaterialCopy({ db, bucket, serviceId, sourceServiceId = serviceId, proposalId = null,
  targetId, uid, source, proposal = null, purpose, now = Date.now, operationStartedAt = now() }) {
  if (![serviceId, sourceServiceId, targetId, uid].every(ID) || !['proposal', 'renewal'].includes(purpose)
    || !sourceKeyValid(sourceServiceId, source?.cvStorageKey) || purpose === 'proposal' && !ID(proposalId)
    || !Number.isFinite(operationStartedAt) || operationStartedAt <= 0) throw fail('material_copy_invalid');
  const startedAt = operationStartedAt, monotonicStart = performance.now();
  const clock = () => Math.max(now(), startedAt + Math.max(0, performance.now() - monotonicStart));
  const extension = /\.(pdf|docx|doc)$/i.exec(source.cvStorageKey)?.[1].toLowerCase();
  if (!extension) throw fail('material_copy_invalid');
  const seed = { serviceId, sourceServiceId, purpose, uid, proposalId, targetId,
    sourceKey: source.cvStorageKey, sourceRevision: sourceRevision(source), proposalRevision: proposalRevision(proposal),
    extension, requestId: purpose === 'proposal' ? `proposal-${proposalId}` : 'renewal' };
  const uploaderToken = randomUUID();
  let record, refs, generation, saveStarted = false, uploadStarted = false;

  async function recoverPublished() {
    if (!record) return false;
    return db.runTransaction(async tx => published(record, await contextInTransaction(tx, refs)));
  }
  async function abandon() {
    if (!record) return;
    await cleanOneCopy({ db, bucket, marker: refs.marker, nowMs: clock(), force: record.uploaderToken === uploaderToken });
  }
  return {
    async save() {
      if (saveStarted) throw fail('material_copy_save_repeated');
      saveStarted = true;
      try {
      const serviceRef = db.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION).doc(serviceId);
      const requestRef = serviceRef.collection(REQUESTS).doc(seed.requestId);
      record = await db.runTransaction(async tx => {
        const request = (await tx.get(requestRef)).data();
        const previousRef = request?.writeId && ID(request.writeId) ? serviceRef.collection(COLLECTION).doc(request.writeId) : null;
        const previous = previousRef ? (await tx.get(previousRef)).data() : null;
        const writeId = randomUUID();
        const next = { ...seed, writeId, uploaderToken, createdAt: startedAt, expiresAt: startedAt + OPERATION_MS, state: 'reserved',
          key: `${purpose === 'proposal' ? `assisted-application-uploads/${targetId}/copy-` : `application-concierge-uploads/${serviceId}/renewal-`}${writeId}.${extension}` };
        const previousLive = recordValid(previous, request?.writeId) && !previous.revokedAt && previous.expiresAt > clock();
        const candidate = previousLive
          && previous.sourceRevision === seed.sourceRevision && previous.proposalRevision === seed.proposalRevision ? previous : next;
        if (candidate === next && previousLive && (previous.state !== 'uploaded' || previous.transportUnknown)) {
          return { ...previous, inProgress: true };
        }
        const candidateRefs = refsFor(db, candidate);
        const context = await contextInTransaction(tx, candidateRefs);
        if (published(candidate, context)) return { ...candidate, alreadyPublished: true };
        if (!allowed(candidate, context, clock())) return null;
        if (candidate !== next && candidate.uploaderToken !== uploaderToken && candidate.state !== 'uploaded') return { ...candidate, inProgress: true };
        if (candidate === next) {
          if (previous && recordValid(previous, request?.writeId)) tx.set(previousRef, revokedRecord(previous, clock()));
          tx.set(candidateRefs.marker, next);
          tx.set(requestRef, { writeId, key: next.key, state: 'reserved' });
        }
        return candidate;
      });
      if (!record) return null;
      refs = refsFor(db, record);
      if (record.inProgress) throw fail('material_copy_in_progress');
      if (record.alreadyPublished) return { key: record.key, targetId: record.targetId, alreadyPublished: true };
      if (record.uploaderToken !== uploaderToken) {
        const [current] = await bucket.file(record.key).getMetadata();
        generation = ownedArtifactGeneration(current, record.writeId);
        if (!generation || current?.metadata?.materialCopySha256 !== record.sourceSha256) throw fail('material_copy_generation_unknown');
        return { key: record.key, targetId: record.targetId, writeId: record.writeId, generation };
      }
      let metadata;
      [metadata] = await bucket.file(record.sourceKey).getMetadata();
      const sourceGeneration = String(metadata.generation || '');
      if (!/^\d+$/.test(sourceGeneration) || !Number.isSafeInteger(Number(metadata.size)) || Number(metadata.size) <= 0
        || Number(metadata.size) > CONCIERGE_MAX_CV_BYTES || !TYPES.has(String(metadata.contentType).toLowerCase())) throw fail('material_copy_source_invalid');
      const pinned = await db.runTransaction(async tx => {
        const marker = (await tx.get(refs.marker)).data();
        const request = (await tx.get(refs.request)).data();
        const context = await contextInTransaction(tx, refs);
        if (!recordValid(marker, record.writeId) || marker.revokedAt || marker.uploaderToken !== uploaderToken
          || request?.writeId !== record.writeId || !allowed(record, context, clock())) return false;
        tx.set(refs.marker, { sourceGeneration, state: 'downloading' }, { merge: true }); return true;
      });
      if (!pinned) { await abandon(); return null; }
      const [buffer] = await bucket.file(record.sourceKey, { generation: sourceGeneration }).download({ start: 0, end: CONCIERGE_MAX_CV_BYTES });
      if (!Buffer.isBuffer(buffer) || buffer.length !== Number(metadata.size) || buffer.length > CONCIERGE_MAX_CV_BYTES) throw fail('material_copy_source_invalid');
      const sourceSha256 = createHash('sha256').update(buffer).digest('hex');
      const admitted = await db.runTransaction(async tx => {
        const marker = (await tx.get(refs.marker)).data();
        const request = (await tx.get(refs.request)).data();
        const context = await contextInTransaction(tx, refs);
        if (!recordValid(marker, record.writeId) || marker.revokedAt || request?.writeId !== record.writeId || !allowed(record, context, clock())) return false;
        if (marker.sourceGeneration !== sourceGeneration || marker.uploaderToken !== uploaderToken
          || marker.sourceSha256 && marker.sourceSha256 !== sourceSha256) return false;
        tx.set(refs.marker, { sourceGeneration, sourceSha256, state: 'uploading' }, { merge: true }); return true;
      });
      if (!admitted) { await abandon(); return null; }
      const acknowledged = () => db.runTransaction(async tx => {
        const marker = (await tx.get(refs.marker)).data();
        if (!recordValid(marker, record.writeId)) throw fail('material_copy_reservation_changed');
        tx.set(refs.marker, { state: 'uploaded', completedAt: clock() }, { merge: true });
      });
      const ownFile = bucket.file(record.key);
      try {
        uploadStarted = true;
        const upload = await uploadOwnedArtifact({ bucket, key: record.key, buffer, writeId: record.writeId,
          options: { contentType: String(metadata.contentType).toLowerCase(), metadata: { metadata: { materialCopySha256: sourceSha256 } } }, acknowledged });
        generation = upload?.generation;
      } catch (error) {
        // Metadata proves bytes, not that every SDK/server retry has finished.
        await db.runTransaction(async tx => {
          const marker = (await tx.get(refs.marker)).data();
          if (recordValid(marker, record.writeId)) tx.set(refs.marker, { transportUnknown: true }, { merge: true });
        });
        // A committed create-only write may lose its ACK, including the final 412.
        let current;
        try { [current] = await ownFile.getMetadata(); } catch (readError) { if (Number(readError.code) !== 404) throw readError; }
        generation = ownedArtifactGeneration(current, record.writeId);
        if (!generation || current?.metadata?.materialCopySha256 !== sourceSha256) {
          throw error;
        }
        await acknowledged();
      }
      if (!generation) throw fail('material_copy_generation_unknown');
      return { key: record.key, targetId: record.targetId, writeId: record.writeId, generation };
      } catch (error) {
        if (record?.uploaderToken === uploaderToken && !uploadStarted) {
          try { await abandon(); } catch { error.cleanupPending = true; }
        }
        throw error;
      }
    },
    async publish(write) {
      if (!record) return false;
      if (typeof write !== 'function' || write.constructor?.name === 'AsyncFunction') throw fail('material_copy_publication_async');
      try {
        return await db.runTransaction(async tx => {
          const marker = (await tx.get(refs.marker)).data();
          const request = (await tx.get(refs.request)).data();
          const context = await contextInTransaction(tx, refs);
          if (published(record, context)) return true;
          if (!generation || !recordValid(marker, record.writeId) || marker.revokedAt || marker.state !== 'uploaded'
            || request?.writeId !== record.writeId || !allowed(record, context, clock())) return false;
          const result = write(tx, { ...context, key: record.key, targetId: record.targetId, writeId: record.writeId, nowMs: clock() });
          if (result && typeof result.then === 'function') {
            Promise.resolve(result).catch(() => {});
            throw fail('material_copy_publication_async');
          }
          if (!allowed(record, context, clock())) throw fail('material_copy_expired');
          if (marker.transportUnknown) tx.set(refs.marker, revokedRecord(marker, clock()));
          else tx.delete(refs.marker);
          tx.set(refs.request, { writeId: record.writeId, key: record.key, state: 'published' });
          return true;
        });
      } catch (error) {
        // Never turn an unknown commit outcome into a destructive cleanup.
        if (await recoverPublished()) return true;
        throw error;
      }
    },
    abandon,
    recoverPublished,
  };
}

async function cleanOneCopy({ db, bucket, marker, nowMs, force = false }) {
  const cleanup = await db.runTransaction(async tx => {
    const snapshot = await tx.get(marker); const record = snapshot.data();
    if (!snapshot.exists) return null;
    if (!recordValid(record, snapshot.id)) throw fail('material_copy_reservation_invalid');
    const refs = refsFor(db, record); const context = await contextInTransaction(tx, refs);
    if (published(record, context)) {
      if (record.transportUnknown) tx.set(marker, revokedRecord(record, nowMs));
      else tx.delete(marker);
      return null;
    }
    if (!force && !record.revokedAt && allowed(record, context, Math.max(nowMs, Date.now()))) return null;
    // A transport-unknown marker keeps only cleanup identifiers, never the source CV path.
    const minimal = revokedRecord(record, nowMs);
    tx.set(marker, minimal); return minimal;
  });
  if (!cleanup) return;
  const file = bucket.file(cleanup.key); let metadata;
  try { [metadata] = await file.getMetadata(); }
  catch (error) { if (Number(error.code) !== 404) throw error; }
  const generation = ownedArtifactGeneration(metadata, cleanup.writeId);
  if (metadata && !generation) return; // A foreign object is never this operation's cleanup target.
  if (generation) await deleteOwnedArtifactGeneration(file, generation);
  if (!cleanup.transportUnknown && ['reserved', 'downloading', 'not_written', 'uploaded'].includes(cleanup.state)) {
    await db.runTransaction(async tx => {
      const current = (await tx.get(marker)).data();
      if (current?.writeId === cleanup.writeId && current.revokedAt) tx.delete(marker);
    });
  }
}

/** A bounded rotating page includes refunded/deleted parents, not only paid services. */
export async function cleanupConciergeMaterialCopies({ db, bucket = null, getBucket = null, nowMs = Date.now() }) {
  const cursorRef = db.collection('application_concierge_maintenance').doc('material_copy_cleanup');
  const claimId = randomUUID();
  const state = await db.runTransaction(async tx => {
    const state = (await tx.get(cursorRef)).data();
    if (Number(state?.leaseUntil) > nowMs) return null;
    tx.set(cursorRef, { claimId, leaseUntil: nowMs + OPERATION_MS }, { merge: true }); return state || {};
  });
  if (!state) return { scanned: 0, failed: 0 };
  const cursor = state.cursor;
  let query = db.collectionGroup(COLLECTION).orderBy(FieldPath.documentId()).limit(CLEANUP_PAGE_SIZE);
  if (typeof cursor === 'string' && cursor) query = query.startAfter(cursor);
  const snapshot = await query.get();
  const storage = snapshot.docs.length ? bucket || getBucket?.() : null;
  if (snapshot.docs.length && !storage) throw fail('material_copy_bucket_missing');
  let failed = 0;
  for (const document of snapshot.docs) {
    try { await cleanOneCopy({ db, bucket: storage, marker: document.ref, nowMs }); }
    catch (error) { failed += 1; console.error('[conciergeMaterialCopyCleanup]', error?.code || error?.name || 'unknown'); }
  }
  await db.runTransaction(async tx => {
    const current = (await tx.get(cursorRef)).data();
    if (current?.claimId === claimId) tx.set(cursorRef, {
      cursor: snapshot.docs.length === CLEANUP_PAGE_SIZE ? snapshot.docs.at(-1).ref.path : null,
      leaseUntil: 0, updatedAt: nowMs,
    }, { merge: true });
  });
  return { scanned: snapshot.docs.length, failed };
}
