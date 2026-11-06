import {
  CREATE_APPLICATION_CONCIERGE_CHECKOUT_URL,
  SYNC_APPLICATION_CONCIERGE_META_CONSENT_URL,
} from './functionsBase';
import type { MetaAdsAttribution } from './metaPixel';

const metaConsentSyncs = new Map<string, Promise<void>>();
const META_CONSENT_DEVICE_TOKEN_KEY = 'frontaliere_meta_ads_consent_device_token';
const META_CONSENT_PENDING_DECISION_KEY = 'frontaliere_meta_ads_consent_pending';

type PendingMetaConsent = { decision: 'granted' | 'denied'; decisionAtMs: number };

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

function metaConsentDeviceToken(): string {
  if (typeof window === 'undefined') return '';
  try {
    const existing = window.localStorage.getItem(META_CONSENT_DEVICE_TOKEN_KEY);
    if (existing && /^[a-f0-9]{64}$/i.test(existing)) return existing.toLowerCase();
    const bytes = window.crypto.getRandomValues(new Uint8Array(32));
    const token = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    window.localStorage.setItem(META_CONSENT_DEVICE_TOKEN_KEY, token);
    return token;
  } catch {
    return '';
  }
}

function parsePendingMetaConsent(value: unknown): PendingMetaConsent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const decision = candidate.decision;
  const decisionAtMs = candidate.decisionAtMs;
  const normalizedDecisionAtMs = typeof decisionAtMs === 'number' ? Math.floor(decisionAtMs) : 0;
  if ((decision !== 'granted' && decision !== 'denied')
    || typeof decisionAtMs !== 'number'
    || !Number.isFinite(decisionAtMs)
    || normalizedDecisionAtMs <= 0) return null;
  return { decision, decisionAtMs: normalizedDecisionAtMs };
}

function readPendingMetaConsent(): PendingMetaConsent | null {
  if (typeof window === 'undefined') return null;
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(META_CONSENT_PENDING_DECISION_KEY) || 'null');
    return parsePendingMetaConsent(value);
  } catch {
    return null;
  }
}

function writePendingMetaConsent(decision: PendingMetaConsent): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(META_CONSENT_PENDING_DECISION_KEY, JSON.stringify(decision)); } catch { /* the current request can still be attempted */ }
}

function clearPendingMetaConsent(decision: PendingMetaConsent): void {
  if (typeof window === 'undefined') return;
  const current = readPendingMetaConsent();
  if (current?.decision !== decision.decision || current.decisionAtMs !== decision.decisionAtMs) return;
  try { window.localStorage.removeItem(META_CONSENT_PENDING_DECISION_KEY); } catch { /* a later sync can safely replay this decision */ }
}

async function anonymousMetaConsentAppCheckToken(): Promise<string> {
  const firebaseModule = await import('./firebase');
  await firebaseModule.ensureAppCheck();
  const appCheck = firebaseModule.appCheck;
  if (!appCheck) throw new Error('meta_ads_consent_app_check_unavailable');
  const appCheckModule = await import('firebase/app-check');
  return (await appCheckModule.getToken(appCheck)).token;
}

/** The server takes the recipient from the caller's verified account, never from this input. */
export async function createApplicationConciergeCheckout(
  input: ApplicationConciergeCheckoutInput,
  user: ApplicationConciergeAuthUser | null | undefined,
): Promise<ApplicationConciergeCheckoutResult> {
  if (!user?.getIdToken) throw new Error('application_concierge_auth_required');
  const token = await user.getIdToken();
  const { metaAttribution, ...checkoutInput } = input;
  const metaConsentRevocationToken = metaConsentDeviceToken();
  const response = await fetch(CREATE_APPLICATION_CONCIERGE_CHECKOUT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      ...checkoutInput,
      ...(metaAttribution || {}),
      ...(metaConsentRevocationToken ? { metaConsentRevocationToken } : {}),
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
  const normalizedDecisionAtMs = Math.floor(decisionAtMs);
  if (!Number.isFinite(decisionAtMs) || normalizedDecisionAtMs <= 0) return;
  const pending = { decision, decisionAtMs: normalizedDecisionAtMs };
  writePendingMetaConsent(pending);
  return transmitApplicationConciergeMetaConsent(user, pending);
}

/** Retry the locally persisted decision after connectivity or authentication returns. */
export async function retryPendingApplicationConciergeMetaConsent(
  user: ApplicationConciergeAuthUser | null | undefined,
): Promise<void> {
  const pending = readPendingMetaConsent();
  if (!pending) return;
  return transmitApplicationConciergeMetaConsent(user, pending);
}

async function transmitApplicationConciergeMetaConsent(
  user: ApplicationConciergeAuthUser | null | undefined,
  pending: PendingMetaConsent,
): Promise<void> {
  const userId = typeof user?.getIdToken === 'function' ? String(user.uid || '') : '';
  if (pending.decision === 'granted' && !userId) return;
  const revocationToken = metaConsentDeviceToken();
  if (pending.decision === 'denied' && !userId && !revocationToken) return;
  const requestKey = `${userId || 'anonymous'}:${pending.decision}:${pending.decisionAtMs}`;
  const inFlight = metaConsentSyncs.get(requestKey);
  if (inFlight) return inFlight;

  const request = (async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response: Response;
      try {
        const appCheckToken = pending.decision === 'denied' && !userId
          ? await anonymousMetaConsentAppCheckToken()
          : '';
        const token = userId && user?.getIdToken ? await user.getIdToken() : '';
        response = await fetch(SYNC_APPLICATION_CONCIERGE_META_CONSENT_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(appCheckToken ? { 'X-Firebase-AppCheck': appCheckToken } : {}),
          },
          body: JSON.stringify({ ...pending, revocationToken }),
        });
      } catch (error) {
        lastError = error;
        if (attempt === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        continue;
      }
      if (response.ok) {
        clearPendingMetaConsent(pending);
        return;
      }
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
