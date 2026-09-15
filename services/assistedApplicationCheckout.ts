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
}

export interface AssistedApplicationCheckoutResult {
  ok: true;
  url: string;
  orderId: string;
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
  user: { getIdToken: () => Promise<string> },
): Promise<AssistedApplicationCheckoutResult> {
  const token = await user.getIdToken();
  if (!token) throw new Error('assisted_application_auth_required');

  const response = await fetch(CREATE_ASSISTED_APPLICATION_CHECKOUT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok || !data?.url || !data?.orderId) {
    throw new Error(`assisted_application_checkout_failed:${response.status}`);
  }
  return data as AssistedApplicationCheckoutResult;
}
