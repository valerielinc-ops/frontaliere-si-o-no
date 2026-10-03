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

function responseError(response, action, parameterName = '') {
  const label = parameterName ? ` ${parameterName}` : '';
  return `${action}${label}: HTTP ${response.status} ${response.statusText || ''}`.trim();
}

/**
 * Ensure EVENT-scoped GA4 custom dimensions exist before a Data API query uses
 * them. Existing dimensions and concurrent 409s count as success only when
 * their scope and display name match the requested contract. Contract
 * mismatches are returned to strict callers before any missing dimensions are
 * created, so the caller cannot produce an unqueryable artifact.
 */
export async function ensureGa4CustomDimensions({
  propertyId,
  token,
  dimensions = [],
  fetchImpl = fetchRetry,
} = {}) {
  if (!token) throw new Error('GA4 Admin API access token is required');
  const property = normalizePropertyId(propertyId);
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  const listUrl = `https://analyticsadmin.googleapis.com/v1beta/${property}/customDimensions?pageSize=200`;
  const listed = await fetchImpl(listUrl, { headers });
  if (!listed.ok) throw new Error(responseError(listed, 'list GA4 custom dimensions'));
  const listedBody = await listed.json();
  const existing = new Map(
    (Array.isArray(listedBody.customDimensions) ? listedBody.customDimensions : [])
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
      } else if (created.status === 409) {
        const verified = await fetchImpl(listUrl, { headers });
        if (!verified.ok) {
          failures.push(responseError(verified, 'verify concurrent GA4 custom dimension', dimension.parameterName));
          continue;
        }
        const verifiedBody = await verified.json();
        const concurrentDimension = findGa4CustomDimension(verifiedBody.customDimensions, dimension.parameterName);
        const mismatch = ga4EventDimensionContractMismatch(dimension, concurrentDimension);
        if (mismatch) failures.push(mismatch);
        else raced.push(dimension.parameterName);
      } else {
        failures.push(responseError(created, 'create GA4 custom dimension', dimension.parameterName));
      }
    } catch (error) {
      failures.push(`ensure GA4 custom dimension ${dimension.parameterName}: ${error?.message || error}`);
    }
  }

  return { registered, alreadyPresent, raced, failures };
}
