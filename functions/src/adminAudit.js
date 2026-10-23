import { FieldValue } from 'firebase-admin/firestore';

export const ADMIN_AUDIT_COLLECTION = 'admin_audit_log';
const SENSITIVE_KEY = /(?:body|html|text|cv|email|recipient|credential|secret|token|password|private|authorization|api[-_]?key|access[-_]?key)/iu;
const SENSITIVE_VALUE = /(?:sk[-_]|gh[pousr]_|AIza|Bearer\s+|-----BEGIN|eyJ[a-zA-Z0-9_-]{16,})/iu;
const EMAIL_VALUE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const MAX_STRING_LENGTH = 240;

function safeValue(value, key = '', depth = 0) {
  if (SENSITIVE_KEY.test(key)) return undefined;
  if (depth > 2) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (EMAIL_VALUE.test(trimmed) || SENSITIVE_VALUE.test(trimmed)) return undefined;
    return trimmed.slice(0, MAX_STRING_LENGTH);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => safeValue(item, key, depth + 1)).filter((item) => item !== undefined);
  }
  if (typeof value === 'object') {
    const output = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const safe = safeValue(childValue, childKey, depth + 1);
      if (safe !== undefined) output[childKey.slice(0, 80)] = safe;
    }
    return output;
  }
  return undefined;
}

export function sanitizeAdminAuditDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {};
  return safeValue(details) || {};
}

/**
 * Best-effort audit write. A missing audit collection or a transient Firestore
 * error must never turn a completed owner mutation into a failed mutation.
 */
export async function writeAdminAuditLog({ db, auth, action, target, status, details = {}, legacyFields = {} }) {
  if (!db?.collection || !auth) return null;
  try {
    const collection = db.collection(ADMIN_AUDIT_COLLECTION);
    if (!collection?.add) return null;
    return await collection.add({
      at: FieldValue.serverTimestamp(),
      uid: String(auth.uid || ''),
      action: String(action || '').slice(0, 100),
      target: String(target || '').slice(0, 240),
      status: typeof status === 'number' ? status : String(status || '').slice(0, 80),
      details: sanitizeAdminAuditDetails(details),
      ...sanitizeAdminAuditDetails(legacyFields),
    });
  } catch (error) {
    console.error('admin audit write failed', error);
    return null;
  }
}

export async function updateAdminAuditStatus(ref, status) {
  if (!ref) return;
  try {
    if (typeof ref.update === 'function') await ref.update({ status });
    else if (typeof ref.set === 'function') await ref.set({ status }, { merge: true });
  } catch (error) {
    console.error('admin audit status update failed', error);
  }
}
