import { fetchRetry } from './ga4-service-account.mjs';

export const EMPLOYER_INSIGHTS_GA4_CUSTOM_DIMENSIONS = Object.freeze([
  Object.freeze({
    parameterName: 'employer_key',
    displayName: 'Employer Key',
    description: 'Stable employer key attached to job and employer-profile events',
  }),
  Object.freeze({
    parameterName: 'job_slug',
    displayName: 'Job Slug',
    description: 'Job ad slug attached to job detail and apply events',
  }),
  Object.freeze({
    parameterName: 'emission_id',
    displayName: 'Analytics Emission ID',
    description: 'Per-emission analytics identifier used to deduplicate employer-insights events',
  }),
]);

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
 * them. Creation is idempotent: existing dimensions and a concurrent 409 are
 * both treated as success. Non-409 failures are returned to strict callers so
 * the refresh can stop before producing an unqueryable D18 artifact.
 */
export async function ensureGa4CustomDimensions({
  propertyId,
  token,
  dimensions = EMPLOYER_INSIGHTS_GA4_CUSTOM_DIMENSIONS,
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
  const existing = new Set(
    (Array.isArray(listedBody.customDimensions) ? listedBody.customDimensions : [])
      .map((dimension) => dimension?.parameterName)
      .filter(Boolean),
  );
  const registered = [];
  const alreadyPresent = [];
  const raced = [];
  const failures = [];

  for (const dimension of dimensions) {
    if (existing.has(dimension.parameterName)) {
      alreadyPresent.push(dimension.parameterName);
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
      } else if (created.status === 409) {
        raced.push(dimension.parameterName);
      } else {
        failures.push(responseError(created, 'create GA4 custom dimension', dimension.parameterName));
      }
    } catch (error) {
      failures.push(`create GA4 custom dimension ${dimension.parameterName}: ${error?.message || error}`);
    }
  }

  return { registered, alreadyPresent, raced, failures };
}
