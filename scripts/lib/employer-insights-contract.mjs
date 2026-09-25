export const EMPLOYER_INSIGHTS_SOURCES = Object.freeze(['posthog', 'ga4']);
export const EMPLOYER_INSIGHTS_COVERAGE_FLOOR = 0.9;

export function assertEmployerInsightsSource(source) {
  if (!EMPLOYER_INSIGHTS_SOURCES.includes(source)) {
    throw new Error(`source must be one of ${EMPLOYER_INSIGHTS_SOURCES.join(' or ')}`);
  }
  return source;
}
