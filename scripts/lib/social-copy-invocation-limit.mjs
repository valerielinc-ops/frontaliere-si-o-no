export const SOCIAL_COPY_CODEX_INVOCATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const SOCIAL_COPY_CODEX_INVOCATION_LIMIT = 1;
export const SOCIAL_COPY_CODEX_INVOCATION_COLLECTION = 'socialAutomationLimits';
export const SOCIAL_COPY_CODEX_INVOCATION_DOCUMENT = 'social-copy-pack';

function asValidDate(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be a valid timestamp`);
  return date;
}

function normalizeReservations(value) {
  if (!Array.isArray(value)) throw new Error('social copy invocation limit state is malformed');
  return value.map((item) => {
    if (!item || typeof item.id !== 'string' || !item.id.trim()) {
      throw new Error('social copy invocation limit state is malformed');
    }
    const reservedAt = asValidDate(item.reservedAt, 'reservedAt');
    return { id: item.id, reservedAt: reservedAt.toISOString(), reservedAtMs: reservedAt.getTime() };
  });
}

/** Check the rolling window without consuming it; reserve atomically before generation. */
export async function checkSocialCopyCodexInvocation({
  db,
  invocationId,
  now = new Date(),
  limit = SOCIAL_COPY_CODEX_INVOCATION_LIMIT,
} = {}) {
  if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function') {
    throw new Error('Firestore is required to enforce the social-copy Codex invocation limit');
  }
  const id = String(invocationId || '').trim();
  if (!id || id.length > 240) throw new Error('invocationId must be a non-empty value of at most 240 characters');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
    throw new Error('limit must be an integer from 1 to 10');
  }

  const current = asValidDate(now, 'now');
  const cutoffMs = current.getTime() - SOCIAL_COPY_CODEX_INVOCATION_WINDOW_MS;
  const reference = db.collection(SOCIAL_COPY_CODEX_INVOCATION_COLLECTION)
    .doc(SOCIAL_COPY_CODEX_INVOCATION_DOCUMENT);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const state = snapshot.exists ? snapshot.data() : null;
    if (state && Number(state.schemaVersion) !== 1) {
      throw new Error('social copy invocation limit state has an unsupported schema');
    }
    if (state && !Array.isArray(state.reservations)) {
      throw new Error('social copy invocation limit state is malformed');
    }
    const active = normalizeReservations(state ? state.reservations : [])
      .filter((reservation) => reservation.reservedAtMs > cutoffMs)
      .map(({ id: reservationId, reservedAt }) => ({ id: reservationId, reservedAt }));
    const existing = active.find((reservation) => reservation.id === id);
    if (existing) {
      return {
        allowed: true,
        alreadyReserved: true,
        count: active.length,
        limit,
        windowEndsAt: new Date(new Date(existing.reservedAt).getTime() + SOCIAL_COPY_CODEX_INVOCATION_WINDOW_MS).toISOString(),
      };
    }
    if (active.length >= limit) {
      const windowEndsAt = new Date(
        Math.min(...active.map((reservation) => new Date(reservation.reservedAt).getTime()))
          + SOCIAL_COPY_CODEX_INVOCATION_WINDOW_MS,
      ).toISOString();
      return { allowed: false, alreadyReserved: false, count: active.length, limit, windowEndsAt };
    }
    return { allowed: true, alreadyReserved: false, count: active.length, limit, windowEndsAt: null };
  });
}

/** Atomically reserve the single Codex pack generation allowed per rolling seven days. */
export async function reserveSocialCopyCodexInvocation({
  db,
  invocationId,
  now = new Date(),
  limit = SOCIAL_COPY_CODEX_INVOCATION_LIMIT,
} = {}) {
  if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function') {
    throw new Error('Firestore is required to enforce the social-copy Codex invocation limit');
  }
  const id = String(invocationId || '').trim();
  if (!id || id.length > 240) throw new Error('invocationId must be a non-empty value of at most 240 characters');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
    throw new Error('limit must be an integer from 1 to 10');
  }

  const current = asValidDate(now, 'now');
  const currentMs = current.getTime();
  const cutoffMs = currentMs - SOCIAL_COPY_CODEX_INVOCATION_WINDOW_MS;
  const reference = db.collection(SOCIAL_COPY_CODEX_INVOCATION_COLLECTION)
    .doc(SOCIAL_COPY_CODEX_INVOCATION_DOCUMENT);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const state = snapshot.exists ? snapshot.data() : null;
    if (state && Number(state.schemaVersion) !== 1) {
      throw new Error('social copy invocation limit state has an unsupported schema');
    }
    if (state && !Array.isArray(state.reservations)) {
      throw new Error('social copy invocation limit state is malformed');
    }
    const previous = normalizeReservations(state ? state.reservations : []);
    const active = previous
      .filter((reservation) => reservation.reservedAtMs > cutoffMs)
      .map(({ id: reservationId, reservedAt }) => ({ id: reservationId, reservedAt }));

    const existing = active.find((reservation) => reservation.id === id);
    if (existing) {
      return {
        allowed: true,
        alreadyReserved: true,
        count: active.length,
        limit,
        windowEndsAt: new Date(new Date(existing.reservedAt).getTime() + SOCIAL_COPY_CODEX_INVOCATION_WINDOW_MS).toISOString(),
      };
    }

    if (active.length >= limit) {
      const windowEndsAt = new Date(
        Math.min(...active.map((reservation) => new Date(reservation.reservedAt).getTime()))
          + SOCIAL_COPY_CODEX_INVOCATION_WINDOW_MS,
      ).toISOString();
      if (active.length !== previous.length) {
        transaction.set(reference, {
          schemaVersion: 1,
          reservations: active,
          updatedAt: current.toISOString(),
        });
      }
      return { allowed: false, alreadyReserved: false, count: active.length, limit, windowEndsAt };
    }

    active.push({ id, reservedAt: current.toISOString() });
    transaction.set(reference, {
      schemaVersion: 1,
      reservations: active,
      updatedAt: current.toISOString(),
    });
    return {
      allowed: true,
      alreadyReserved: false,
      count: active.length,
      limit,
      windowEndsAt: new Date(currentMs + SOCIAL_COPY_CODEX_INVOCATION_WINDOW_MS).toISOString(),
    };
  });
}
