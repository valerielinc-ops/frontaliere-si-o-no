import { CREATE_APPLICATION_CONCIERGE_CHECKOUT_URL } from './functionsBase';
import { ensureAssistedApplicationAuth } from './assistedApplicationCheckout';

export interface ApplicationConciergeCheckoutInput {
  successUrl: string;
  cancelUrl: string;
  locale: 'it' | 'en' | 'de' | 'fr';
  requestKey?: string;
}

export type ApplicationConciergeCheckoutResult =
  | {
    ok: true;
    paymentProvider: 'sumup';
    checkoutId: string;
    serviceId: string;
  }
  | {
    ok: true;
    paymentProvider: 'stripe';
    url: string;
    serviceId: string;
  };

function requestKey(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `concierge-${crypto.randomUUID()}`;
    }
  } catch {
    // Use the bounded fallback below when the browser crypto API is absent.
  }
  return `concierge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function errorCode(value: unknown): string {
  if (typeof value === 'string' && /^[a-z][a-z0-9_.:/-]{0,63}$/.test(value)) return value;
  return 'application_concierge_checkout_failed';
}

/** Anonymous Auth is enough to preserve ownership across the payment redirect. */
export async function createApplicationConciergeCheckout(
  input: ApplicationConciergeCheckoutInput,
  suppliedUser?: any | null,
): Promise<ApplicationConciergeCheckoutResult> {
  const user = suppliedUser?.getIdToken ? suppliedUser : await ensureAssistedApplicationAuth();
  if (!user?.getIdToken) throw new Error('application_concierge_auth_required');
  const token = await user.getIdToken();
  const response = await fetch(CREATE_APPLICATION_CONCIERGE_CHECKOUT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...input, requestKey: input.requestKey || requestKey() }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok || !data?.serviceId) {
    throw new Error(errorCode(data?.error));
  }
  if (data.paymentProvider === 'sumup' && data.checkoutId) {
    return data as ApplicationConciergeCheckoutResult;
  }
  if (data.url) {
    return { ...data, paymentProvider: 'stripe' } as ApplicationConciergeCheckoutResult;
  }
  throw new Error('application_concierge_checkout_failed');
}
