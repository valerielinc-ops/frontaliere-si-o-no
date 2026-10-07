import { CREATE_ASSISTED_APPLICATION_CHECKOUT_URL } from './functionsBase';

export interface AssistedApplicationCheckoutInput {
  jobId: string;
  companyId: string;
  jobUrl: string;
  companyName: string;
  jobTitle: string;
  /** `offerwall_fallback`: paid offer opened because the rewarded Offerwall could not load. */
  experimentVariant: 'control' | 'assisted_application' | 'offerwall_fallback';
  successUrl: string;
  cancelUrl: string;
  requestKey?: string;
}

export interface AssistedApplicationCheckoutResult {
  ok: true;
  url: string;
  orderId: string;
}

export interface AssistedApplicationCheckoutError extends Error {
  code?: string;
  status?: number;
}

const SAFE_ERROR_CODE_RE = /^[a-z][a-z0-9_.:/-]{0,63}$/;

function safeErrorCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim();
  return SAFE_ERROR_CODE_RE.test(code) ? code : null;
}

function httpErrorCode(value: unknown): string | null {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? `http_${status}` : null;
}

/** Return only bounded provider/function codes or a coarse HTTP/network code. */
export function getAssistedApplicationCheckoutErrorCode(error: unknown): string {
  const candidate = safeErrorCode((error as AssistedApplicationCheckoutError | null)?.code);
  if (candidate) return candidate;
  return httpErrorCode((error as AssistedApplicationCheckoutError | null)?.status) || 'unknown';
}

function checkoutError(code: string, status?: number): AssistedApplicationCheckoutError {
  const error = new Error(code) as AssistedApplicationCheckoutError;
  error.code = code;
  if (Number.isInteger(status) && status !== undefined && status >= 100 && status <= 599) error.status = status;
  return error;
}

const REQUEST_KEY_STORAGE_PREFIX = 'frontaliere_assisted_application_checkout_v2';
const LEGACY_REQUEST_KEY_STORAGE_PREFIX = 'frontaliere_assisted_application_checkout_v1';
const REQUEST_KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
const requestKeyMemory = new Map<string, string>();

function newRequestKey(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') return `assisted-${globalThis.crypto.randomUUID()}`;
  } catch {
    // Fall through for older browsers or restricted storage contexts.
  }
  return `assisted-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function canonicalRequestIdentity(input: AssistedApplicationCheckoutInput): string {
  // Job title and redirect URLs are presentation details: locale changes and
  // returning through a different route must not fork an already-paid order.
  // Keep the same immutable identity as the server-side checkout ledger.
  return JSON.stringify({
    jobId: input.jobId,
    companyId: input.companyId,
    jobUrl: input.jobUrl,
    companyName: input.companyName,
    experimentVariant: input.experimentVariant,
  });
}

function requestKeyStorageKey(input: AssistedApplicationCheckoutInput, user: { uid?: string }): string {
  const uid = encodeURIComponent(user.uid || 'anonymous');
  const identity = encodeURIComponent(canonicalRequestIdentity(input));
  return `${REQUEST_KEY_STORAGE_PREFIX}:${uid}:${identity}`;
}

function legacyRequestKeyStorageKey(input: AssistedApplicationCheckoutInput, user: { uid?: string }): string {
  const uid = encodeURIComponent(user.uid || 'anonymous');
  const jobId = encodeURIComponent(input.jobId);
  return `${LEGACY_REQUEST_KEY_STORAGE_PREFIX}:${uid}:${jobId}`;
}

function persistentRequestKey(
  input: AssistedApplicationCheckoutInput,
  user: { uid?: string },
): string {
  const storageKey = requestKeyStorageKey(input, user);
  const supplied = typeof input.requestKey === 'string' ? input.requestKey.trim() : '';
  if (REQUEST_KEY_RE.test(supplied)) {
    requestKeyMemory.set(storageKey, supplied);
    try {
      window.localStorage.setItem(storageKey, supplied);
    } catch {
      // The in-memory copy still deduplicates retries in this page.
    }
    return supplied;
  }

  const inMemory = requestKeyMemory.get(storageKey);
  if (inMemory && REQUEST_KEY_RE.test(inMemory)) return inMemory;
  try {
    const stored = window.localStorage.getItem(storageKey) || '';
    if (REQUEST_KEY_RE.test(stored)) {
      requestKeyMemory.set(storageKey, stored);
      return stored;
    }
    const legacyStored = window.localStorage.getItem(legacyRequestKeyStorageKey(input, user)) || '';
    if (REQUEST_KEY_RE.test(legacyStored)) {
      requestKeyMemory.set(storageKey, legacyStored);
      window.localStorage.setItem(storageKey, legacyStored);
      return legacyStored;
    }
  } catch {
    // Generate a key below when localStorage is unavailable.
  }

  const generated = newRequestKey();
  requestKeyMemory.set(storageKey, generated);
  try {
    window.localStorage.setItem(storageKey, generated);
  } catch {
    // The in-memory copy still deduplicates retries in this page.
  }
  return generated;
}

/**
 * The upload rules need a Firebase owner. Prefer the existing account; when
 * the visitor is anonymous, use Firebase Anonymous Auth only for this funnel.
 * If the provider is disabled in the project, the caller can fall back to the
 * normal sign-in route without ever creating an unowned paid order.
 */
export async function ensureAssistedApplicationAuth(): Promise<any | null> {
  if (typeof window === 'undefined') return null;

  const [{ getApp }, authModule] = await Promise.all([
    import('@/services/firebase'),
    import('firebase/auth'),
  ]);
  const auth = authModule.getAuth(await getApp());
  if (auth.currentUser) return auth.currentUser;

  if (typeof auth.authStateReady === 'function') await auth.authStateReady();
  if (auth.currentUser) return auth.currentUser;

  try {
    const result = await authModule.signInAnonymously(auth);
    return result?.user || null;
  } catch (error) {
    // Anonymous Auth may be disabled in a project; surface one stable caller
    // error so the UI can route the visitor to the existing sign-in flow.
    const code = getAssistedApplicationCheckoutErrorCode(error);
    throw checkoutError(code === 'unknown' ? 'assisted_application_auth_failed' : code);
  }
}

export async function createAssistedApplicationCheckout(
  input: AssistedApplicationCheckoutInput,
  user: { uid?: string; getIdToken: () => Promise<string> },
): Promise<AssistedApplicationCheckoutResult> {
  const token = await user.getIdToken();
  if (!token) throw checkoutError('assisted_application_auth_required');

  const requestKey = persistentRequestKey(input, user);

  let response: Response;
  try {
    response = await fetch(CREATE_ASSISTED_APPLICATION_CHECKOUT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ ...input, requestKey }),
    });
  } catch {
    throw checkoutError('network_error');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok || !data?.url || !data?.orderId) {
    const code = safeErrorCode(data?.error) || (httpErrorCode(response.status) || 'invalid_response');
    throw checkoutError(code, response.status);
  }
  return data as AssistedApplicationCheckoutResult;
}
