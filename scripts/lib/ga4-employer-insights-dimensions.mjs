import { ensureGa4CustomDimensions as ensureCustomDimensions } from './ga4-custom-dimensions.mjs';

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

export function ensureGa4CustomDimensions(options = {}) {
  return ensureCustomDimensions({
    dimensions: EMPLOYER_INSIGHTS_GA4_CUSTOM_DIMENSIONS,
    ...options,
  });
}
