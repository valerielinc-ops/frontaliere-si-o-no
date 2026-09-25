import {
  DEFAULT_GA4_PROPERTY_ID,
  fetchRetry,
  getServiceAccountToken,
} from './ga4-service-account.mjs';

export const GA4_ADMIN_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/analytics.edit',
  'https://www.googleapis.com/auth/analytics.readonly',
]);

export const EMPLOYER_INSIGHTS_CUSTOM_DIMS = Object.freeze([
  {
    parameterName: 'employer_key',
    displayName: 'Employer Key',
    description: 'Stable employer key attached to job and employer-profile events',
  },
  {
    parameterName: 'job_slug',
    displayName: 'Job Slug',
    description: 'Job ad slug attached to job detail and apply events',
  },
  {
    parameterName: 'emission_id',
    displayName: 'Analytics Emission ID',
    description: 'Per-emission analytics identifier used to deduplicate employer-insights events',
  },
]);

function normalizePropertyId(rawPropertyId) {
  const value = String(rawPropertyId || '').trim();
  if (!value || value === 'properties/XXXXXXXX') return null;
  return value.startsWith('properties/') ? value : `properties/${value}`;
}

async function responseText(response) {
  return (await response.text().catch(() => '')).slice(0, 500);
}

/**
 * Ensure event-scoped GA4 custom dimensions exist before a fail-closed
 * consumer queries them. The operation is idempotent and deliberately strict
 * by default: a refresh must stop before querying if Admin API provisioning is
 * unavailable or a dimension cannot be created.
 */
export async function ensureGa4CustomDimensions({
  propertyId = process.env.GA4_PROPERTY_ID || DEFAULT_GA4_PROPERTY_ID,
  dimensions = EMPLOYER_INSIGHTS_CUSTOM_DIMS,
  token = null,
  getToken = getServiceAccountToken,
  fetchImpl = globalThis.fetch,
  strict = true,
  logInfo = () => {},
  logWarning = () => {},
} = {}) {
  const property = normalizePropertyId(propertyId);
  if (!property) throw new Error('GA4_PROPERTY_ID is missing or invalid');
  if (!Array.isArray(dimensions) || dimensions.length === 0) {
    throw new Error('at least one GA4 custom dimension is required');
  }
  if (typeof fetchImpl !== 'function') throw new Error('fetch is required');

  const accessToken = token || await getToken(GA4_ADMIN_SCOPES, {
    logInfo,
    logError: logWarning,
  });
  if (!accessToken) throw new Error('GA4 Admin API service-account token is unavailable');

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
  const endpoint = `https://analyticsadmin.googleapis.com/v1beta/${property}/customDimensions`;
  const listResponse = fetchImpl === globalThis.fetch
    ? await fetchRetry(`${endpoint}?pageSize=200`, { headers })
    : await fetchImpl(`${endpoint}?pageSize=200`, { headers });

  if (!listResponse.ok) {
    const message = `list customDimensions ${listResponse.status}: ${await responseText(listResponse)}`;
    if (strict) throw new Error(message);
    logWarning(message);
    return { property, created: [], skipped: [], failed: dimensions.map((dim) => dim.parameterName) };
  }

  const existing = new Set(
    ((await listResponse.json()).customDimensions || [])
      .map((dimension) => dimension.parameterName)
      .filter(Boolean),
  );
  const created = [];
  const skipped = [];
  const failed = [];

  for (const dimension of dimensions) {
    if (!dimension?.parameterName || !dimension.displayName || !dimension.description) {
      throw new Error('GA4 custom dimension metadata is incomplete');
    }
    if (existing.has(dimension.parameterName)) {
      skipped.push(dimension.parameterName);
      continue;
    }

    const createResponse = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        parameterName: dimension.parameterName,
        displayName: dimension.displayName,
        description: dimension.description,
        scope: 'EVENT',
      }),
    });
    if (createResponse.ok) {
      created.push(dimension.parameterName);
      existing.add(dimension.parameterName);
      logInfo(`Registered GA4 custom dimension: ${dimension.parameterName}`);
      continue;
    }

    // A concurrent registrar may win between the list and POST calls.
    if (createResponse.status === 409) {
      skipped.push(dimension.parameterName);
      existing.add(dimension.parameterName);
      continue;
    }

    const message = `create ${dimension.parameterName} ${createResponse.status}: ${await responseText(createResponse)}`;
    failed.push(dimension.parameterName);
    logWarning(message);
    if (strict) throw new Error(message);
  }

  return { property, created, skipped, failed };
}
