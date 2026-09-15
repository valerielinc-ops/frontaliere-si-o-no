import { CREATE_ASSISTED_APPLICATION_CHECKOUT_URL } from './functionsBase';

export interface AssistedApplicationCheckoutInput {
  jobId: string;
  companyId: string;
  jobUrl: string;
  companyName: string;
  jobTitle: string;
  experimentVariant: 'control' | 'assisted_application';
  successUrl: string;
  cancelUrl: string;
  requestKey?: string;
}

export interface AssistedApplicationCheckoutResult {
  ok: true;
  url: string;
  orderId: string;
}

const REQUEST_KEY_STORAGE_PREFIX = 'frontaliere_assisted_application_checkout_v1';
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

function requestKeyStorageKey(input: AssistedApplicationCheckoutInput, user: { uid?: string }): string {
  const uid = encodeURIComponent(user.uid || 'anonymous');
  const jobId = encodeURIComponent(input.jobId);
  return `${REQUEST_KEY_STORAGE_PREFIX}:${uid}:${jobId}`;
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
  } catch {
    // Anonymous Auth may be disabled in a project; surface one stable caller
    // error so the UI can route the visitor to the existing sign-in flow.
    throw new Error('assisted_application_auth_required');
  }
}

export async function createAssistedApplicationCheckout(
  input: AssistedApplicationCheckoutInput,
  user: { uid?: string; getIdToken: () => Promise<string> },
): Promise<AssistedApplicationCheckoutResult> {
  const token = await user.getIdToken();
  if (!token) throw new Error('assisted_application_auth_required');

  const requestKey = persistentRequestKey(input, user);

  const response = await fetch(CREATE_ASSISTED_APPLICATION_CHECKOUT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ ...input, requestKey }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok || !data?.url || !data?.orderId) {
    throw new Error(`assisted_application_checkout_failed:${response.status}`);
  }
  return data as AssistedApplicationCheckoutResult;
}
