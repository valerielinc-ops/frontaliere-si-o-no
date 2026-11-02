import { createHash, randomUUID } from 'node:crypto';
import { getFirestoreDb } from './firestore-admin.mjs';

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function stableIndex(value, count) {
  const bytes = createHash('sha256').update(String(value)).digest();
  return bytes.readUInt32BE(0) % count;
}

function safeCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

/**
 * Allocate one stable, near-even copy arm per public social content identity.
 * Firestore transactions serialize concurrent publishers; retries read the
 * existing assignment and never consume another slot.
 */
export async function assignBalancedSocialCopy({
  db: suppliedDb,
  experimentId,
  packId,
  channel,
  slot,
  objective = '',
  assignmentKey,
  attemptId: suppliedAttemptId,
  templateIds,
} = {}) {
  const db = suppliedDb || await getFirestoreDb();
  const arms = [...new Set((Array.isArray(templateIds) ? templateIds : []).map(String))].sort();
  const key = String(assignmentKey || '').trim();
  const attemptId = String(suppliedAttemptId || randomUUID()).trim();
  if (!attemptId || attemptId.length > 128) throw new Error('invalid attemptId');
  const attemptHash = digest(attemptId);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(experimentId || ''))) throw new Error('invalid experimentId');
  if (!/^[a-f0-9]{16}$/.test(String(packId || ''))) throw new Error('invalid packId');
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(String(channel || ''))) throw new Error('invalid channel');
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(String(slot || ''))) throw new Error('invalid slot');
  if (objective && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(String(objective))) throw new Error('invalid objective');
  if (!key || key.length > 256) throw new Error('invalid assignmentKey');
  if (arms.length < 2 || arms.length > 12 || arms.some((arm) => !/^[a-z0-9][a-z0-9-]{0,31}$/.test(arm))) {
    throw new Error('templateIds must contain 2..12 valid template ids');
  }

  const scope = [experimentId, packId, channel, slot, objective].join('|');
  const scopeId = digest(scope);
  const assignmentId = digest(scope + '\n' + key);
  const scopeRef = db.collection('social_copy_assignment_scopes').doc(scopeId);
  const assignmentRef = db.collection('social_copy_assignment_records').doc(assignmentId);

  return db.runTransaction(async (transaction) => {
    const assignmentSnapshot = await transaction.get(assignmentRef);
    if (assignmentSnapshot.exists) {
      const assignment = assignmentSnapshot.data();
      if (assignment?.status !== 'released') {
        const assignedTemplateId = assignment?.templateId;
        if (!arms.includes(assignedTemplateId)) throw new Error('stored assignment is outside the current template set');
        if (assignment?.status === 'active') {
          const attempts = { ...(assignment?.attempts || {}) };
          attempts[attemptHash] = 'active';
          transaction.set(assignmentRef, { attempts }, { merge: true });
        }
        return { templateId: assignedTemplateId, reused: true, attemptId };
      }
    }

    const scopeSnapshot = await transaction.get(scopeRef);
    const priorCounts = scopeSnapshot.exists ? scopeSnapshot.data()?.counts : {};
    const counts = Object.fromEntries(arms.map((arm) => [arm, safeCount(priorCounts?.[arm])]));
    const minimum = Math.min(...Object.values(counts));
    const available = arms.filter((arm) => counts[arm] === minimum);
    const templateId = available[stableIndex(assignmentId, available.length)];
    counts[templateId] += 1;
    const now = new Date();

    transaction.set(assignmentRef, {
      templateId,
      scopeId,
      status: 'active',
      attempts: { [attemptHash]: 'active' },
      createdAt: now,
    });
    transaction.set(scopeRef, {
      experimentId,
      packId,
      channel,
      slot,
      ...(objective ? { objective } : {}),
      counts,
      updatedAt: now,
    }, { merge: true });

    return { templateId, reused: false, attemptId };
  });
}

/** Release a reserved copy arm when its assigned format cannot be published. */
export async function releaseBalancedSocialCopyAssignment({
  db: suppliedDb,
  experimentId,
  packId,
  channel,
  slot,
  objective = '',
  assignmentKey,
  attemptId,
} = {}) {
  const db = suppliedDb || await getFirestoreDb();
  const key = String(assignmentKey || '').trim();
  const attempt = String(attemptId || '').trim();
  if (!attempt || attempt.length > 128) throw new Error('invalid attemptId');
  const attemptHash = digest(attempt);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(experimentId || ''))) throw new Error('invalid experimentId');
  if (!/^[a-f0-9]{16}$/.test(String(packId || ''))) throw new Error('invalid packId');
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(String(channel || ''))) throw new Error('invalid channel');
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(String(slot || ''))) throw new Error('invalid slot');
  if (objective && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(String(objective))) throw new Error('invalid objective');
  if (!key || key.length > 256) throw new Error('invalid assignmentKey');

  const scope = [experimentId, packId, channel, slot, objective].join('|');
  const scopeId = digest(scope);
  const assignmentId = digest(scope + '\n' + key);
  const scopeRef = db.collection('social_copy_assignment_scopes').doc(scopeId);
  const assignmentRef = db.collection('social_copy_assignment_records').doc(assignmentId);

  return db.runTransaction(async (transaction) => {
    const assignmentSnapshot = await transaction.get(assignmentRef);
    if (!assignmentSnapshot.exists) return false;
    const assignment = assignmentSnapshot.data();
    if (assignment?.status === 'released') return true;
    // Another concurrent attempt may have been accepted or ended with an
    // ambiguous transport response. Either outcome must keep the reservation.
    if (assignment?.status !== 'active') return true;
    const attempts = { ...(assignment?.attempts || {}) };
    if (attempts[attemptHash] === 'not-sent') return true;
    if (attempts[attemptHash] !== 'active') return false;
    attempts[attemptHash] = 'not-sent';
    const otherAttemptStillOpen = Object.values(attempts).some((status) => status === 'active');
    if (otherAttemptStillOpen) {
      transaction.set(assignmentRef, { attempts }, { merge: true });
      return true;
    }
    const scopeSnapshot = await transaction.get(scopeRef);
    const counts = { ...(scopeSnapshot.exists ? scopeSnapshot.data()?.counts : {}) };
    const assignedTemplateId = String(assignment?.templateId || '');
    if (assignedTemplateId && Object.hasOwn(counts, assignedTemplateId)) {
      counts[assignedTemplateId] = Math.max(0, safeCount(counts[assignedTemplateId]) - 1);
    }
    const now = new Date();
    transaction.set(scopeRef, { counts, updatedAt: now }, { merge: true });
    transaction.set(assignmentRef, { attempts, status: 'released', releasedAt: now }, { merge: true });
    return true;
  });
}

/** Delete old hashed assignment records and counters; no content identity is stored. */
export async function pruneExpiredSocialCopyAssignments({
  db: suppliedDb,
  now = new Date(),
  retentionDays = 90,
  pageSize = 250,
} = {}) {
  const db = suppliedDb || await getFirestoreDb();
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 45) {
    throw new Error('retentionDays must be a safe integer of at least 45');
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 400) {
    throw new Error('pageSize must be between 1 and 400');
  }
  const current = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(current.getTime())) throw new Error('now must be a valid date');
  const cutoff = new Date(current.getTime() - retentionDays * 86400000);
  let deleted = 0;

  for (const collectionName of ['social_copy_assignment_records', 'social_copy_assignment_scopes']) {
    const collection = db.collection(collectionName);
    while (true) {
      const snapshot = await collection
        .where(collectionName.endsWith('_records') ? 'createdAt' : 'updatedAt', '<', cutoff)
        .orderBy(collectionName.endsWith('_records') ? 'createdAt' : 'updatedAt')
        .limit(pageSize)
        .get();
      if (snapshot.empty) break;
      const batch = db.batch();
      for (const document of snapshot.docs) batch.delete(document.ref);
      await batch.commit();
      deleted += snapshot.size;
      if (snapshot.size < pageSize) break;
    }
  }

  return { deleted, cutoff: cutoff.toISOString() };
}
