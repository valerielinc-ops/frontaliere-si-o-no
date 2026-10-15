/**
 * SumUp Checkout for the one-off assisted-application payment.
 *
 * SumUp is deliberately isolated from the existing Stripe integrations. The
 * assisted-application endpoint selects it only when the owner explicitly
 * sets ASSISTED_APPLICATION_PAYMENT_PROVIDER=sumup in Remote Config; an absent
 * or invalid switch keeps the current Stripe path as the safe default, while
 * incomplete SumUp credentials fail closed before a payment checkout is created.
 */

import { getRemoteConfigValue } from './remoteConfigSecrets.js';
import { ASSISTED_APPLICATION_PRICE_EUR_CENTS } from './assistedApplicationConstants.js';

export const ASSISTED_APPLICATION_PAYMENT_PROVIDER_RC_KEY = 'ASSISTED_APPLICATION_PAYMENT_PROVIDER';
export const SUMUP_API_KEY_RC_KEY = 'SUMUP_API_KEY';
export const SUMUP_MERCHANT_CODE_RC_KEY = 'SUMUP_MERCHANT_CODE';
export const SUMUP_WEBHOOK_URL_RC_KEY = 'SUMUP_ASSISTED_APPLICATION_WEBHOOK_URL';
export const SUMUP_PAYMENT_PROVIDER = 'sumup';

const SUMUP_API_BASE_URL = 'https://api.sumup.com';

function boundedString(value, max) {
  const result = String(value ?? '').trim();
  return result && result.length <= max ? result : '';
}
export class SumUpApiError extends Error {
  constructor(status, message = 'sumup_api_request_failed') {
    super(message);
    this.name = 'SumUpApiError';
    this.status = status;
  }
}

async function sumUpCredentials(read = getRemoteConfigValue) {
  const [rawApiKey, rawMerchantCode] = await Promise.all([
    read(SUMUP_API_KEY_RC_KEY),
    read(SUMUP_MERCHANT_CODE_RC_KEY),
  ]);
  const apiKey = boundedString(rawApiKey, 500);
  const merchantCode = boundedString(rawMerchantCode, 100);
  if (!apiKey || !merchantCode) throw new Error('sumup_credentials_missing');
  return { apiKey, merchantCode };
}

async function sumUpConfig(read = getRemoteConfigValue) {
  const [{ apiKey, merchantCode }, webhookUrl] = await Promise.all([
    sumUpCredentials(read),
    read(SUMUP_WEBHOOK_URL_RC_KEY),
  ]);
  const normalizedWebhookUrl = boundedString(webhookUrl, 1000);
  if (!normalizedWebhookUrl || !/^https:\/\//.test(normalizedWebhookUrl)) {
    throw new Error('sumup_webhook_url_missing');
  }
  return { apiKey, merchantCode, webhookUrl: normalizedWebhookUrl };
}

/**
 * The provider switch is configuration, not an experiment. Stripe remains
 * the default until the owner explicitly activates the SumUp setup.
 */
export async function getAssistedApplicationPaymentProvider(read = getRemoteConfigValue) {
  const configured = String(await read(ASSISTED_APPLICATION_PAYMENT_PROVIDER_RC_KEY) || '')
    .trim()
    .toLowerCase();
  return configured === SUMUP_PAYMENT_PROVIDER ? SUMUP_PAYMENT_PROVIDER : 'stripe';
}

async function sumUpRequest(path, { apiKey, method = 'GET', body } = {}) {
  const headers = { Authorization: `Bearer ${apiKey}` };
  const init = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${SUMUP_API_BASE_URL}${path}`, init);
  if (response.status === 204) return { status: 204 };
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new SumUpApiError(response.status);
  }
  return payload || {};
}

async function findSumUpCheckoutByReference(
  checkoutReference,
  apiKey,
  { amountCents = ASSISTED_APPLICATION_PRICE_EUR_CENTS, currency = 'EUR' } = {},
) {
  const result = await sumUpRequest(
    `/v0.1/checkouts?checkout_reference=${encodeURIComponent(checkoutReference)}`,
    { apiKey },
  );
  const checkouts = Array.isArray(result)
    ? result
    : Array.isArray(result?.data) ? result.data : [];
  const candidate = checkouts.find((checkout) => (
    boundedString(checkout?.checkout_reference, 64) === checkoutReference
    && Math.round(Number(checkout?.amount) * 100) === amountCents
    && String(checkout?.currency || '').toUpperCase() === String(currency).toUpperCase()
    && boundedString(checkout?.id, 200)
    && String(checkout?.status || '').toUpperCase() !== 'EXPIRED'
  ));
  if (!candidate) return null;
  return sumUpRequest(`/v0.1/checkouts/${encodeURIComponent(candidate.id)}`, { apiKey });
}

async function createSumUpCheckout(
  {
    checkoutReference,
    redirectUrl,
    amountCents = ASSISTED_APPLICATION_PRICE_EUR_CENTS,
    description = 'Candidatura assistita',
    hostedCheckout = false,
  },
  read = getRemoteConfigValue,
) {
  const { apiKey, merchantCode, webhookUrl } = await sumUpConfig(read);
  const reference = boundedString(checkoutReference, 64);
  if (!reference) throw new Error('sumup_checkout_reference_invalid');
  const normalizedAmount = Number(amountCents);
  if (!Number.isSafeInteger(normalizedAmount) || normalizedAmount <= 0) {
    throw new Error('sumup_checkout_amount_invalid');
  }
  let result;
  try {
    result = await sumUpRequest('/v0.1/checkouts', {
      apiKey,
      method: 'POST',
      body: {
        amount: normalizedAmount / 100,
        checkout_reference: reference,
        currency: 'EUR',
        description: boundedString(description, 200) || 'Candidatura assistita',
        merchant_code: merchantCode,
        ...(redirectUrl ? { redirect_url: redirectUrl } : {}),
        return_url: webhookUrl,
        ...(hostedCheckout ? { hosted_checkout: { enabled: true } } : {}),
      },
    });
  } catch (error) {
    // SumUp rejects a second checkout with the same reference. Recover the
    // already-created checkout so a retry cannot strand the customer.
    if (!(error instanceof SumUpApiError) || error.status !== 409) throw error;
    result = await findSumUpCheckoutByReference(reference, apiKey, { amountCents: normalizedAmount });
    if (!result) throw error;
  }
  const id = boundedString(result.id, 200);
  const url = boundedString(result.hosted_checkout_url, 1000);
  if (!id || (hostedCheckout && !url)) throw new Error('sumup_checkout_response_invalid');
  return { id, ...(url ? { url } : {}) };
}

export async function createSumUpHostedCheckout(
  options,
  read = getRemoteConfigValue,
) {
  return createSumUpCheckout({ ...options, hostedCheckout: true }, read);
}

export async function createSumUpAssistedApplicationCheckout(
  { orderId, redirectUrl },
  read = getRemoteConfigValue,
) {
  return createSumUpCheckout({
    checkoutReference: orderId,
    redirectUrl,
    amountCents: ASSISTED_APPLICATION_PRICE_EUR_CENTS,
    description: 'Candidatura assistita',
    // The assisted flow renders SumUp's Payment Widget on our page. Keeping
    // this false is what prevents the hosted page's manual “Return to
    // merchant” button from being shown.
    hostedCheckout: false,
  }, read);
}

export async function retrieveSumUpCheckout(
  checkoutId,
  read = getRemoteConfigValue,
) {
  const { apiKey } = await sumUpCredentials(read);
  const id = boundedString(checkoutId, 200);
  if (!id) throw new Error('sumup_checkout_id_missing');
  return sumUpRequest(`/v0.1/checkouts/${encodeURIComponent(id)}`, { apiKey });
}

export async function refundSumUpTransaction(
  transactionId,
  read = getRemoteConfigValue,
) {
  const { apiKey } = await sumUpCredentials(read);
  const id = boundedString(transactionId, 200);
  if (!id) throw new Error('sumup_transaction_id_missing');
  return sumUpRequest(
    `/v0.1/me/refund/${encodeURIComponent(id)}`,
    { apiKey, method: 'POST' },
  );
}
