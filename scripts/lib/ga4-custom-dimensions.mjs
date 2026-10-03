import { fetchRetry } from './ga4-service-account.mjs';
import {
  findGa4CustomDimension,
  ga4EventDimensionContractMismatch,
} from './ga4-event-dimension-contract.mjs';

function normalizePropertyId(propertyId) {
  const raw = String(propertyId || '').trim();
  if (!raw) throw new Error('GA4_PROPERTY_ID is required');
  return raw.startsWith('properties/') ? raw : `properties/${raw}`;
}

/**
 * A standard GA4 property accepts at most 50 EVENT-scoped custom dimensions.
 * The Admin API answers a create past the cap with a bare 400, so the cap is
 * checked locally and named in the failure instead of being left to a status
 * code. Analytics 360 callers can raise it through `eventDimensionLimit`.
 */
export const GA4_STANDARD_EVENT_DIMENSION_LIMIT = 50;

const RESPONSE_DETAIL_MAX_LENGTH = 300;

/** Read the API's own explanation, bounded and without bearer material. */
async function responseDetail(response) {
  if (typeof response?.text !== 'function') return '';
  let raw = '';
  try {
    raw = String(await response.text() || '');
  } catch {
    return '';
  }
  let detail = raw;
  try {
    const error = JSON.parse(raw)?.error;
    if (error && typeof error.message === 'string' && error.message.trim()) {
      detail = error.status ? `${error.status}: ${error.message}` : error.message;
    }
  } catch {
    // Not JSON: keep the raw text.
  }
  detail = detail
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/ya29\.[\w.-]+/gu, '[redacted]')
    .replace(/\s+/gu, ' ')
    .trim();
  return detail.length > RESPONSE_DETAIL_MAX_LENGTH
    ? `${detail.slice(0, RESPONSE_DETAIL_MAX_LENGTH)}…`
    : detail;
}

async function responseError(response, action, parameterName = '') {
  const label = parameterName ? ` ${parameterName}` : '';
  const status = `${action}${label}: HTTP ${response.status} ${response.statusText || ''}`.trim();
  const detail = await responseDetail(response);
  return detail ? `${status} — ${detail}` : status;
}

/**
 * Ensure EVENT-scoped GA4 custom dimensions exist before a Data API query uses
 * them. Existing dimensions and concurrent 409s count as success only when
 * their scope and display name match the requested contract. Contract
 * mismatches are returned to strict callers before any missing dimensions are
 * created, so the caller cannot produce an unqueryable artifact. A missing
 * dimension is never requested once the property has no EVENT slot left: the
 * failure names the cap instead of spending an Admin API call on a 400.
 */
export async function ensureGa4CustomDimensions({
  propertyId,
  token,
  dimensions = [],
  fetchImpl = fetchRetry,
  eventDimensionLimit = GA4_STANDARD_EVENT_DIMENSION_LIMIT,
} = {}) {
  if (!token) throw new Error('GA4 Admin API access token is required');
  const property = normalizePropertyId(propertyId);
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  const listUrl = `https://analyticsadmin.googleapis.com/v1beta/${property}/customDimensions?pageSize=200`;
  const listed = await fetchImpl(listUrl, { headers });
  if (!listed.ok) throw new Error(await responseError(listed, 'list GA4 custom dimensions'));
  const listedBody = await listed.json();
  const listedDimensions = Array.isArray(listedBody.customDimensions) ? listedBody.customDimensions : [];
  let eventDimensionCount = listedDimensions.filter((dimension) => dimension?.scope === 'EVENT').length;
  const existing = new Map(
    listedDimensions
      .filter((dimension) => dimension?.parameterName)
      .map((dimension) => [dimension.parameterName, dimension]),
  );
  const registered = [];
  const alreadyPresent = [];
  const raced = [];
  const failures = [];
  const missing = [];

  for (const dimension of dimensions) {
    const existingDimension = existing.get(dimension.parameterName);
    if (existingDimension) {
      const mismatch = ga4EventDimensionContractMismatch(dimension, existingDimension);
      if (mismatch) failures.push(mismatch);
      else alreadyPresent.push(dimension.parameterName);
      continue;
    }
    missing.push(dimension);
  }

  if (failures.length) return { registered, alreadyPresent, raced, failures };

  for (const dimension of missing) {
    if (eventDimensionCount >= eventDimensionLimit) {
      failures.push(
        `${property} is at the cap of ${eventDimensionLimit} event-scoped GA4 custom dimensions `
        + `(${eventDimensionCount} registered): cannot create ${dimension.parameterName}`,
      );
      continue;
    }
    try {
      const created = await fetchImpl(
        `https://analyticsadmin.googleapis.com/v1beta/${property}/customDimensions`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            parameterName: dimension.parameterName,
            displayName: dimension.displayName,
            description: dimension.description,
            scope: 'EVENT',
          }),
        },
      );
      if (created.ok) {
        registered.push(dimension.parameterName);
        eventDimensionCount += 1;
      } else if (created.status === 409) {
        const verified = await fetchImpl(listUrl, { headers });
        if (!verified.ok) {
          failures.push(await responseError(verified, 'verify concurrent GA4 custom dimension', dimension.parameterName));
          continue;
        }
        const verifiedBody = await verified.json();
        const concurrentDimension = findGa4CustomDimension(verifiedBody.customDimensions, dimension.parameterName);
        const mismatch = ga4EventDimensionContractMismatch(dimension, concurrentDimension);
        if (mismatch) failures.push(mismatch);
        else {
          raced.push(dimension.parameterName);
          eventDimensionCount += 1;
        }
      } else {
        failures.push(await responseError(created, 'create GA4 custom dimension', dimension.parameterName));
      }
    } catch (error) {
      failures.push(`ensure GA4 custom dimension ${dimension.parameterName}: ${error?.message || error}`);
    }
  }

  return { registered, alreadyPresent, raced, failures };
}
