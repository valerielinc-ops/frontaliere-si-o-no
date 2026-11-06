import { RESUME_ASSISTED_APPLICATION_PAYMENT_URL } from './functionsBase';
import { withAssistedPaymentResponseShape } from './assistedApplicationResponseShape';

export interface AssistedApplicationPaymentRecoveryStripeResult {
  ok: true;
  status: 'open' | 'paid';
  paymentProvider?: 'stripe';
  orderId: string;
  url?: string;
}

export interface AssistedApplicationPaymentRecoverySumUpResult {
  ok: true;
  status: 'open' | 'paid';
  paymentProvider?: 'sumup';
  orderId: string;
  checkoutId?: string;
  url?: string;
}

export type AssistedApplicationPaymentRecoveryResult =
  | AssistedApplicationPaymentRecoveryStripeResult
  | AssistedApplicationPaymentRecoverySumUpResult;

export interface AssistedApplicationPaymentRecoveryError extends Error {
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

function recoveryError(code: string, status?: number): AssistedApplicationPaymentRecoveryError {
  const error = new Error(code) as AssistedApplicationPaymentRecoveryError;
  error.code = code;
  if (Number.isInteger(status) && status !== undefined && status >= 100 && status <= 599) error.status = status;
  return error;
}

/** Return only a bounded server code or a coarse HTTP/network code. */
export function getAssistedApplicationPaymentRecoveryErrorCode(error: unknown): string {
  const candidate = safeErrorCode((error as AssistedApplicationPaymentRecoveryError | null)?.code);
  if (candidate) return candidate;
  return httpErrorCode((error as AssistedApplicationPaymentRecoveryError | null)?.status) || 'unknown';
}

export async function resumeAssistedApplicationPayment(
  orderId: string,
  user: { getIdToken: () => Promise<string> },
): Promise<AssistedApplicationPaymentRecoveryResult> {
  const normalizedOrderId = String(orderId || '').trim();
  if (!normalizedOrderId) throw recoveryError('order_id_missing');
  const token = await user?.getIdToken?.();
  if (!token) throw recoveryError('assisted_application_auth_required');

  let response: Response;
  try {
    response = await fetch(RESUME_ASSISTED_APPLICATION_PAYMENT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ orderId: normalizedOrderId }),
    });
  } catch {
    throw recoveryError('network_error');
  }

  const data = await response.json().catch(() => ({}));
  const isPaid = data?.status === 'paid' && data?.ok && data?.orderId;
  const isStripeOpen = data?.status === 'open'
    && data?.paymentProvider !== 'sumup'
    && typeof data?.url === 'string'
    && data.url.length > 0;
  const isSumUpOpen = data?.status === 'open'
    && data?.paymentProvider === 'sumup'
    && typeof data?.checkoutId === 'string'
    && data.checkoutId.length > 0;
  if (!response.ok || !data?.ok || !data?.orderId || (!isStripeOpen && !isSumUpOpen && !isPaid)) {
    const code = safeErrorCode(data?.error) || httpErrorCode(response.status) || 'invalid_response';
    throw withAssistedPaymentResponseShape(recoveryError(code, response.status), response.status, data);
  }
  return data as AssistedApplicationPaymentRecoveryResult;
}
