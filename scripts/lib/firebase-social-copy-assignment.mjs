import { createHash, randomInt as cryptoRandomInt, randomUUID } from 'node:crypto';
import { getFirestoreDb } from './firestore-admin.mjs';

export const SOCIAL_COPY_ASSIGNMENT_RETENTION_DAYS = 450;

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function safeCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function normalizedBlockContext(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('blockContext must be an object');
  }
  const keys = Object.keys(value).sort();
  if (keys.join('|') !== 'contentClass|weekday') throw new Error('blockContext has unsupported fields');
  const contentClass = String(value.contentClass || '').trim();
  const weekday = Number(value.weekday);
  if (!['article', 'job', 'event', 'digest', 'border', 'reel', 'video'].includes(contentClass)
    || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw new Error('blockContext must contain a supported contentClass and weekday');
  }
  return { contentClass, weekday };
}

function armCounts(value, arms) {
  return Object.fromEntries(arms.map((arm) => [arm, safeCount(value?.[arm])]));
}

function assignmentScope({ experimentId, packId, channel, slot, objective = '', registrationHash = '' }) {
  return registrationHash
    ? [experimentId, channel, slot, objective, registrationHash].join('|')
    : [experimentId, packId, channel, slot, objective, 'unregistered'].join('|');
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
  blockContext: suppliedBlockContext,
  registrationHash: suppliedRegistrationHash,
  templateIds,
  armIds,
  randomIntImpl = cryptoRandomInt,
} = {}) {
  const db = suppliedDb || await getFirestoreDb();
  const angleArms = Array.isArray(armIds);
  const arms = [...new Set((angleArms ? armIds : templateIds || []).map(String))].sort();
  const key = String(assignmentKey || '').trim();
  const blockContext = normalizedBlockContext(suppliedBlockContext);
  const registrationHash = String(suppliedRegistrationHash || '').trim();
  const attemptId = String(suppliedAttemptId || randomUUID()).trim();
  if (!attemptId || attemptId.length > 128) throw new Error('invalid attemptId');
  const attemptHash = digest(attemptId);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(experimentId || ''))) throw new Error('invalid experimentId');
  if (!/^[a-f0-9]{16}$/.test(String(packId || ''))) throw new Error('invalid packId');
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(String(channel || ''))) throw new Error('invalid channel');
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(String(slot || ''))) throw new Error('invalid slot');
  if (objective && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(String(objective))) throw new Error('invalid objective');
  if (registrationHash && !/^[a-f0-9]{64}$/.test(registrationHash)) throw new Error('invalid registrationHash');
  if (!key || key.length > 256) throw new Error('invalid assignmentKey');
  if (arms.length < 2 || arms.length > 12 || arms.some((arm) => !/^[a-z0-9][a-z0-9-]{0,31}$/.test(arm))) {
    throw new Error('templateIds must contain 2..12 valid template ids');
  }
  if (typeof randomIntImpl !== 'function') throw new TypeError('randomIntImpl must be a function');

  const scope = assignmentScope({ experimentId, packId, channel, slot, objective, registrationHash });
  const scopeId = digest(scope);
  const matchingBlockContext = blockContext && registrationHash
    ? { contentClass: blockContext.contentClass }
    : blockContext;
  const blockId = matchingBlockContext ? digest(scope + '\n' + JSON.stringify(matchingBlockContext)) : null;
  const assignmentId = digest(scope + '\n' + key);
  const scopeRef = db.collection('social_copy_assignment_scopes').doc(scopeId);
  const assignmentRef = db.collection('social_copy_assignment_records').doc(assignmentId);

  return db.runTransaction(async (transaction) => {
    const assignmentSnapshot = await transaction.get(assignmentRef);
    if (assignmentSnapshot.exists) {
      const assignment = assignmentSnapshot.data();
      if (assignment?.status !== 'released') {
        const assignedArmId = String(assignment?.armId || assignment?.templateId || '');
        if (!arms.includes(assignedArmId)) throw new Error('stored assignment is outside the current arm set');
        if (assignment?.status === 'active') {
          const attempts = { ...(assignment?.attempts || {}) };
          attempts[attemptHash] = 'active';
          transaction.set(assignmentRef, { attempts }, { merge: true });
        }
        return {
          templateId: assignedArmId,
          ...(angleArms ? { armId: assignedArmId } : {}),
          reused: true,
          attemptId,
          ...(assignment?.blockId ? { blockId: assignment.blockId } : {}),
          ...(Number.isSafeInteger(assignment?.blockCycle) ? { blockCycle: assignment.blockCycle } : {}),
          ...(assignment?.blockContext ? { blockContext: assignment.blockContext } : {}),
          ...(assignment?.registrationHash ? { registrationHash: assignment.registrationHash } : {}),
        };
      }
    }

    const scopeSnapshot = await transaction.get(scopeRef);
    const scopeData = scopeSnapshot.exists ? scopeSnapshot.data() : {};
    const priorCounts = scopeData?.counts;
    const blockCounts = { ...(scopeData?.blockCounts || {}) };
    const counts = blockId
      ? armCounts(blockCounts[blockId], arms)
      : armCounts(priorCounts, arms);
    const minimum = Math.min(...Object.values(counts));
    const available = arms.filter((arm) => counts[arm] === minimum);
    // Randomize among the least-used arms. This preserves a maximum count
    // difference of one while avoiding the content-key-hashed, predictable
    // arm assignment that would confound a copy experiment with post identity.
    const selectedIndex = randomIntImpl(available.length);
    if (!Number.isSafeInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= available.length) {
      throw new Error('randomIntImpl returned an invalid arm index');
    }
    const selectedArmId = available[selectedIndex];
    counts[selectedArmId] += 1;
    const aggregateCounts = armCounts(priorCounts, arms);
    aggregateCounts[selectedArmId] += 1;
    if (blockId) blockCounts[blockId] = counts;
    const now = new Date();

    transaction.set(assignmentRef, {
      ...(angleArms ? { armId: selectedArmId, armType: 'editorial-angle' } : { templateId: selectedArmId }),
      scopeId,
      status: 'active',
      attempts: { [attemptHash]: 'active' },
      ...(blockContext ? { blockContext, matchingBlockContext, blockId, blockCycle: minimum } : {}),
      ...(registrationHash ? { registrationHash } : {}),
      createdAt: now,
    });
    transaction.set(scopeRef, {
      experimentId,
      packId,
      channel,
      slot,
      ...(objective ? { objective } : {}),
      ...(registrationHash ? { registrationHash } : {}),
      allocationMethod: 'randomized-minimum-count-v1',
      counts: aggregateCounts,
      ...(blockId ? { blockCounts } : {}),
      updatedAt: now,
    }, { merge: true });

    return {
      templateId: selectedArmId,
      ...(angleArms ? { armId: selectedArmId } : {}),
      reused: false,
      attemptId,
      ...(blockContext ? { blockContext, matchingBlockContext, blockId, blockCycle: minimum } : {}),
      ...(registrationHash ? { registrationHash } : {}),
    };
  });
}

/** Mark an accepted platform post so only delivered assignments enter evaluation. */
export async function markBalancedSocialCopyAssignmentPublished({
  db: suppliedDb,
  experimentId,
  packId,
  channel,
  slot,
  objective = '',
  registrationHash: suppliedRegistrationHash,
  assignmentKey,
  attemptId,
  postId,
  publishedAt = new Date(),
} = {}) {
  const db = suppliedDb || await getFirestoreDb();
  const key = String(assignmentKey || '').trim();
  const attempt = String(attemptId || '').trim();
  const id = String(postId || '').trim();
  const registrationHash = String(suppliedRegistrationHash || '').trim();
  const published = publishedAt instanceof Date ? publishedAt : new Date(publishedAt);
  if (!attempt || attempt.length > 128) throw new Error('invalid attemptId');
  if (!id || id.length > 200 || /[\r\n]/u.test(id)) throw new Error('invalid postId');
  if (!Number.isFinite(published.getTime())) throw new Error('invalid publishedAt');
  const attemptHash = digest(attempt);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(experimentId || ''))) throw new Error('invalid experimentId');
  if (!/^[a-f0-9]{16}$/.test(String(packId || ''))) throw new Error('invalid packId');
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(String(channel || ''))) throw new Error('invalid channel');
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(String(slot || ''))) throw new Error('invalid slot');
  if (objective && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(String(objective))) throw new Error('invalid objective');
  if (!/^[a-f0-9]{64}$/.test(registrationHash)) throw new Error('invalid registrationHash');
  if (!key || key.length > 256) throw new Error('invalid assignmentKey');

  const scope = assignmentScope({ experimentId, packId, channel, slot, objective, registrationHash });
  const assignmentId = digest(scope + '\n' + key);
  const assignmentRef = db.collection('social_copy_assignment_records').doc(assignmentId);
  const postIdHash = digest(`${channel}\u0000${id}`);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(assignmentRef);
    if (!snapshot.exists) throw new Error('social copy assignment record is missing');
    const assignment = snapshot.data();
    if (assignment?.status === 'published') {
      if (assignment.postIdHash !== postIdHash) throw new Error('social copy assignment already points to another post');
      return true;
    }
    if (assignment?.status !== 'active') throw new Error('social copy assignment is not active');
    const attempts = { ...(assignment?.attempts || {}) };
    if (attempts[attemptHash] !== 'active') throw new Error('social copy assignment attempt is not active');
    attempts[attemptHash] = 'published';
    transaction.set(assignmentRef, {
      attempts,
      status: 'published',
      postIdHash,
      publishedAt: published.toISOString(),
      markedPublishedAt: new Date(),
    }, { merge: true });
    return true;
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
  registrationHash: suppliedRegistrationHash,
  assignmentKey,
  attemptId,
} = {}) {
  const db = suppliedDb || await getFirestoreDb();
  const key = String(assignmentKey || '').trim();
  const attempt = String(attemptId || '').trim();
  const registrationHash = String(suppliedRegistrationHash || '').trim();
  if (!attempt || attempt.length > 128) throw new Error('invalid attemptId');
  const attemptHash = digest(attempt);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(experimentId || ''))) throw new Error('invalid experimentId');
  if (!/^[a-f0-9]{16}$/.test(String(packId || ''))) throw new Error('invalid packId');
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(String(channel || ''))) throw new Error('invalid channel');
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(String(slot || ''))) throw new Error('invalid slot');
  if (objective && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(String(objective))) throw new Error('invalid objective');
  if (registrationHash && !/^[a-f0-9]{64}$/.test(registrationHash)) throw new Error('invalid registrationHash');
  if (!key || key.length > 256) throw new Error('invalid assignmentKey');

  const scope = assignmentScope({ experimentId, packId, channel, slot, objective, registrationHash });
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
    const scopeData = scopeSnapshot.exists ? scopeSnapshot.data() : {};
    const counts = { ...(scopeData?.counts || {}) };
    const assignedArmId = String(assignment?.armId || assignment?.templateId || '');
    if (assignedArmId && Object.hasOwn(counts, assignedArmId)) {
      counts[assignedArmId] = Math.max(0, safeCount(counts[assignedArmId]) - 1);
    }
    const now = new Date();
    const update = { counts, updatedAt: now };
    const blockId = String(assignment?.blockId || '');
    if (blockId && scopeData?.blockCounts && Object.hasOwn(scopeData.blockCounts, blockId)) {
      const blockCounts = { ...scopeData.blockCounts };
      const block = { ...blockCounts[blockId] };
      if (assignedArmId && Object.hasOwn(block, assignedArmId)) {
        block[assignedArmId] = Math.max(0, safeCount(block[assignedArmId]) - 1);
      }
      blockCounts[blockId] = block;
      update.blockCounts = blockCounts;
    }
    transaction.set(scopeRef, update, { merge: true });
    transaction.set(assignmentRef, { attempts, status: 'released', releasedAt: now }, { merge: true });
    return true;
  });
}

/** Delete old hashed assignment records and counters; no content identity is stored. */
export async function pruneExpiredSocialCopyAssignments({
  db: suppliedDb,
  now = new Date(),
  retentionDays = SOCIAL_COPY_ASSIGNMENT_RETENTION_DAYS,
  pageSize = 250,
} = {}) {
  const db = suppliedDb || await getFirestoreDb();
  if (!Number.isSafeInteger(retentionDays) || retentionDays < SOCIAL_COPY_ASSIGNMENT_RETENTION_DAYS) {
    throw new Error('retentionDays must cover the maximum social-experiment duration and outcome window');
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
