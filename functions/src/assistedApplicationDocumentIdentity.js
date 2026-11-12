import { getAuth } from 'firebase-admin/auth';

const boundedEmail = (value) => {
  const email = String(value ?? '').trim();
  return email && email.length <= 320 ? email : '';
};

/**
 * Attach the order owner's Firebase Auth email for document rendering only.
 * The returned value is transient and must never be persisted or logged.
 */
export async function withRegisteredCandidateEmail(order, { auth = null } = {}) {
  if (!order || typeof order !== 'object' || Array.isArray(order)
    || boundedEmail(order.applicantEmail) || boundedEmail(order.documentAccountEmail)) return order;
  const userId = String(order.userId ?? '').trim();
  if (!userId || userId.length > 200) return order;
  try {
    const user = await (auth || getAuth()).getUser(userId);
    const documentAccountEmail = boundedEmail(user?.email);
    return documentAccountEmail ? { ...order, documentAccountEmail } : order;
  } catch {
    // An unavailable Auth record falls through to customerEmail, then the active
    // order alias in candidateDocumentIdentity. It must not fail a draft.
    return order;
  }
}
