/**
 * GA4 exclusion of the measured headless-Chrome fleet.
 *
 * Measured on GA4 2026-09-26 → 10-23 (28 days): 105,999 sessions had a
 * 1280x1200 screen, Windows, Chrome and an English UI from Singapore, with an
 * engagement rate of 6% and ZERO key events; 33 more sessions with the same
 * signature came from other countries and none from Italy or Switzerland. It
 * is 80% of the Direct channel (133k sessions) and half of the property.
 * The client recognises the fleet (`matchesAutomationScreenSignature` in
 * services/botPatterns.ts) for AdSense and PostHog, but GA4 still received it,
 * and every report window that reaches back to the burst contains it. A report
 * whose denominators are sessions therefore excludes the signature on the GA4
 * side. Used today by scripts/landing-value-report.mjs; any GA4 report can
 * import `withAutomationFleetExclusion` (body) or
 * `withAutomationFleetExclusionForFetch` (raw fetch options).
 *
 * The signature mirrors the client rule minus the time zone, which GA4 does
 * not expose: `screenResolution` exact 1280x1200 AND `operatingSystem`
 * Windows AND `browser` Chrome AND `language` English. 1280x1200 (16:15) is
 * not the CSS size of a shipping display, so the rule cannot reach the site's
 * audience. Kept byte-aligned with services/botPatterns.ts by
 * tests/ga4-automation-fleet.test.ts.
 */

export const AUTOMATION_FLEET_GA4_SIGNATURE = Object.freeze({
  screenResolution: '1280x1200',
  operatingSystem: 'Windows',
  browser: 'Chrome',
  language: 'English',
});

/**
 * Second fleet, found while measuring the first one (GA4 2026-09-26 → 10-23):
 * 10,946 Direct sessions with a 1600x1600 screen, Windows, Chrome, Chinese UI
 * from China — 6% engagement, ZERO key events, 140-690 sessions every day.
 * A square 1600x1600 CSS screen is again not a shipping display. The country
 * is part of the signature so the rule stays as narrow as the evidence: the
 * same screen from Hong Kong/Japan (~150 sessions) is left in. Report-side
 * only — the client has no rule for it (see docs/analytics/ga4-misura-affidabile.md).
 */
export const SQUARE_SCREEN_FLEET_GA4_SIGNATURE = Object.freeze({
  screenResolution: '1600x1600',
  operatingSystem: 'Windows',
  browser: 'Chrome',
  language: 'Chinese',
  country: 'China',
});

export const AUTOMATION_FLEET_GA4_SIGNATURES = Object.freeze([
  AUTOMATION_FLEET_GA4_SIGNATURE,
  SQUARE_SCREEN_FLEET_GA4_SIGNATURE,
]);

export const GA4_NESTED_DIMENSION_LIMIT = 9;

function signatureFilter(signature) {
  return {
    andGroup: {
      expressions: Object.keys(signature).map((fieldName) => ({
        filter: {
          fieldName,
          stringFilter: { matchType: 'EXACT', value: signature[fieldName] },
        },
      })),
    },
  };
}

/** GA4 FilterExpression that matches any measured fleet. */
export function buildAutomationFleetFilter() {
  return { orGroup: { expressions: AUTOMATION_FLEET_GA4_SIGNATURES.map((signature) => signatureFilter(signature)) } };
}

/** GA4 FilterExpression that removes every measured fleet. */
export function buildAutomationFleetExclusion() {
  return { notExpression: buildAutomationFleetFilter() };
}

function addFilterDimensionNames(filter, names) {
  if (!filter || typeof filter !== 'object') return;
  if (typeof filter.filter?.fieldName === 'string') names.add(filter.filter.fieldName);
  for (const group of ['andGroup', 'orGroup']) {
    for (const expression of filter[group]?.expressions || []) addFilterDimensionNames(expression, names);
  }
  addFilterDimensionNames(filter.notExpression, names);
}

function requestDimensionNames(body, filter) {
  const names = new Set(
    (body?.dimensions || [])
      .map((dimension) => dimension?.name)
      .filter((name) => typeof name === 'string'),
  );
  for (const orderBy of body?.orderBys || []) {
    const name = orderBy?.dimension?.dimensionName;
    if (typeof name === 'string') names.add(name);
  }
  addFilterDimensionNames(filter, names);
  return names;
}

function exclusionFitsRequest(body, current, exclusion) {
  const combined = current ? { andGroup: { expressions: [current, exclusion] } } : exclusion;
  return requestDimensionNames(body, combined).size
    <= GA4_NESTED_DIMENSION_LIMIT;
}

function hasAutomationFleetExclusion(filter) {
  const serialized = JSON.stringify(filter || '');
  return serialized.includes(JSON.stringify(buildAutomationFleetExclusion()));
}

/**
 * Return a copy of a runReport body whose dimensionFilter also excludes the
 * fleet. An existing filter is AND-ed, never replaced. Idempotent: a body that
 * already carries the exclusion is returned unchanged.
 */
export function withAutomationFleetExclusion(body) {
  if (!body || typeof body !== 'object') return body;
  const current = body.dimensionFilter;
  const fullExclusion = buildAutomationFleetExclusion();
  if (hasAutomationFleetExclusion(current)) {
    if (requestDimensionNames(body, current).size > GA4_NESTED_DIMENSION_LIMIT) {
      throw new Error(
        `GA4 request cannot carry the complete automation-fleet exclusion within the ${GA4_NESTED_DIMENSION_LIMIT}-dimension budget`,
      );
    }
    return body;
  }
  if (!exclusionFitsRequest(body, current, fullExclusion)) {
    throw new Error(
      `GA4 request cannot carry the complete automation-fleet exclusion within the ${GA4_NESTED_DIMENSION_LIMIT}-dimension budget`,
    );
  }
  return {
    ...body,
    dimensionFilter: current ? { andGroup: { expressions: [current, fullExclusion] } } : fullExclusion,
  };
}

/**
 * Same, for the raw fetch options of a GA4 Data API call: rewrites the JSON
 * body of `:runReport` and of every request of `:batchRunReports`. Any other
 * URL (Search Console, PageSpeed, Admin API) passes through untouched.
 */
export function withAutomationFleetExclusionForFetch(url, options = {}) {
  const href = String(url || '');
  if (!href.includes('analyticsdata.googleapis.com') || typeof options?.body !== 'string') return options;
  const isRun = /:runReport(?:$|\?)/.test(href);
  const isBatch = /:batchRunReports?(?:$|\?)/.test(href);
  if (!isRun && !isBatch) return options;
  let parsed;
  try {
    parsed = JSON.parse(options.body);
  } catch {
    return options;
  }
  const rewritten = isBatch && Array.isArray(parsed.requests)
    ? { ...parsed, requests: parsed.requests.map(withAutomationFleetExclusion) }
    : withAutomationFleetExclusion(parsed);
  return { ...options, body: JSON.stringify(rewritten) };
}

export const AUTOMATION_FLEET_EXCLUSION_NOTE = 'Esclusi i segmenti automatici 1280x1200 · Windows · Chrome · English (flotta headless Singapore) e 1600x1600 · Windows · Chrome · Chinese · China, entrambi a 0 key event: vedi docs/analytics/ga4-misura-affidabile.md';
