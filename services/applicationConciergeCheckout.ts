import {
  CREATE_APPLICATION_CONCIERGE_CHECKOUT_URL,
  SYNC_APPLICATION_CONCIERGE_META_CONSENT_URL,
} from './functionsBase';
import type { MetaAdsAttribution } from './metaPixel';

const metaConsentSyncs = new Map<string, Promise<void>>();

export interface ApplicationConciergeAuthUser {
  uid?: string;
  getIdToken?: (forceRefresh?: boolean) => Promise<string>;
}

export interface ApplicationConciergeCheckoutInput {
  successUrl: string;
  cancelUrl: string;
  locale: 'it' | 'en' | 'de' | 'fr';
  requestKey?: string;
  serviceId?: string;
  useSumUpForPaymentReminder?: boolean;
  renewalOfServiceId?: string;
  acceptRenewalTerms?: boolean;
  expectedAmountTotal?: number;
  houseAdAttribution?: ReturnType<typeof import('./houseAdAttribution').getHouseAdAttribution>;
  metaAttribution?: MetaAdsAttribution;
}

export type ApplicationConciergeCheckoutResult =
  | {
    ok: true;
    paymentProvider: 'sumup';
    amountTotal?: number;
    paymentComplete?: boolean;
    checkoutId: string;
    serviceId: string;
  }
  | {
    ok: true;
    paymentProvider: 'stripe';
    amountTotal?: number;
    paymentComplete?: boolean;
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

/** The server takes the recipient from the caller's verified account, never from this input. */
export async function createApplicationConciergeCheckout(
  input: ApplicationConciergeCheckoutInput,
  user: ApplicationConciergeAuthUser | null | undefined,
): Promise<ApplicationConciergeCheckoutResult> {
  if (!user?.getIdToken) throw new Error('application_concierge_auth_required');
  const token = await user.getIdToken();
  const { metaAttribution, ...checkoutInput } = input;
  const response = await fetch(CREATE_APPLICATION_CONCIERGE_CHECKOUT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      ...checkoutInput,
      ...(metaAttribution || {}),
      requestKey: input.requestKey || requestKey(),
    }),
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

/** Synchronize the newest local consent choice, retrying transient failures a bounded number of times. */
export async function syncApplicationConciergeMetaConsent(
  user: ApplicationConciergeAuthUser | null | undefined,
  decision: 'granted' | 'denied',
  decisionAtMs: number,
): Promise<void> {
  const userId = String(user?.uid || '');
  if (!userId || typeof user?.getIdToken !== 'function' || !Number.isFinite(decisionAtMs) || decisionAtMs <= 0) return;
  const requestKey = `${userId}:${decision}:${Math.floor(decisionAtMs)}`;
  const inFlight = metaConsentSyncs.get(requestKey);
  if (inFlight) return inFlight;

  const request = (async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response: Response;
      try {
        const token = await user.getIdToken();
        response = await fetch(SYNC_APPLICATION_CONCIERGE_META_CONSENT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ decision, decisionAtMs: Math.floor(decisionAtMs) }),
        });
      } catch (error) {
        lastError = error;
        if (attempt === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        continue;
      }
      if (response.ok) return;
      lastError = new Error('meta_ads_consent_sync_failed');
      if (response.status !== 429 && response.status < 500) break;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
    throw lastError || new Error('meta_ads_consent_sync_failed');
  })();
  metaConsentSyncs.set(requestKey, request);
  try {
    await request;
  } finally {
    metaConsentSyncs.delete(requestKey);
  }
}
