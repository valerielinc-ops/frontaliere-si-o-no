#!/usr/bin/env node
/** Read-only by default. --provision explicitly registers the categorical dimension. */
import { pathToFileURL } from 'node:url';
import { DEFAULT_GA4_PROPERTY_ID, GA4_READONLY_SCOPE, getServiceAccountToken, ga4DateRange, runGa4Report } from './lib/ga4-service-account.mjs';
import { ensureGa4CustomDimensions } from './lib/ga4-employer-insights-dimensions.mjs';
import { JOB_JOURNEY_GA4_DIMENSIONS } from './lib/ga4-job-journey-dimensions.mjs';

export const FUNNEL_DIMENSIONS = ['customEvent:journey_context', 'deviceCategory', 'customEvent:employer_key'];
const TRANSITIONS = [['list_select', 'detail_view'], ['detail_view', 'gate_view'], ['gate_view', 'auth_success'], ['auth_success', 'apply_click'], ['apply_click', 'handoff'], ['detail_view', 'handoff']];

/** Each stage is emitted once per journey, so eventCount is a stage denominator.
 * The numerator must carry its predecessor in the SAME observed journey path.
 * Never divide unrelated legacy job_apply and job_apply_handoff totals. */
const PATH_CODES = { l: 'list_select', d: 'detail_view', g: 'gate_view', a: 'auth_success', c: 'apply_click', h: 'handoff' };
const STEPS = new Set([...Object.values(PATH_CODES), 'auth_start', 'auth_error', 'gate_dismiss', 'handoff_error']);
export function decodeJourneyContext(context) {
 if (typeof context !== 'string' || context.length > 100) return null;
 const parts = context.split('|');
 if (parts.length !== 5) return null;
 const [cohort, source, entry, step, codes] = parts;
 if (!/^\d{4}-\d{2}-\d{2}$/.test(cohort) || !['job_alert', 'newsletter', 'email', 'search', 'internal', 'referral', 'direct'].includes(source)
  || !['list', 'direct'].includes(entry) || !STEPS.has(step)) return null;
 const path = codes ? codes.split('>') : [];
 if (path.some((code) => !Object.hasOwn(PATH_CODES, code)) || new Set(path).size !== path.length) return null;
 return { cohort, source, entry, step, path: path.map((code) => PATH_CODES[code]).join('>') };
}

export function summarizeJourneyRows(rows) {
 const segments = new Map();
 let excluded = 0;
 for (const row of rows) {
  const [context, device, employer] = row.dimensionValues.map((v) => v.value);
  const decoded = decodeJourneyContext(context);
  const count = Number(row.metricValues[0]?.value) || 0;
  if (!decoded) { excluded += count; continue; }
  const { step, path, cohort, source, entry } = decoded;
  const key = JSON.stringify([cohort, source, entry, device, employer]);
  const segment = segments.get(key) || { cohort, source, entry, device, employer, stages: {}, transitions: {} };
  segment.stages[step] = (segment.stages[step] || 0) + count;
  const observed = path.split('>');
  for (const [from, to] of TRANSITIONS) {
   const id = `${from}→${to}`;
   const metric = segment.transitions[id] ||= { denominator: 0, numerator: 0, rate: null };
   if (step === from) metric.denominator += count;
   if (step === to && observed.indexOf(from) >= 0 && observed.indexOf(from) < observed.indexOf(to)) metric.numerator += count;
  }
  segments.set(key, segment);
 }
 const incompleteTransitions = [];
 for (const segment of segments.values()) for (const [transition, metric] of Object.entries(segment.transitions)) {
  if (metric.numerator > metric.denominator) {
   // GA4 can retain the later event's cumulative path while the separate
   // predecessor event is absent from the report (or lands in another
   // dimension bucket). Preserve the observed counts, but never manufacture
   // a conversion rate from an incomplete denominator.
   metric.rate = null;
   incompleteTransitions.push({
    cohort: segment.cohort,
    source: segment.source,
    entry: segment.entry,
    device: segment.device,
    employer: segment.employer,
    transition,
    numerator: metric.numerator,
    denominator: metric.denominator,
   });
  } else {
   metric.rate = metric.denominator ? metric.numerator / metric.denominator : null;
  }
 }
 return {
  segments: [...segments.values()],
  excludedEvents: excluded,
  quality: incompleteTransitions.length ? 'partial' : 'complete',
  incompleteTransitions,
 };
}

export function journeyReportRequest(startDate, endDate, offset = 0) {
 const cohorts = [];
 for (let day = Date.parse(startDate); day <= Date.parse(endDate); day += 86_400_000) cohorts.push(new Date(day).toISOString().slice(0, 10));
 if (!cohorts.length || cohorts.length > 90) throw new Error('Expected a valid cohort range of 1–90 days');
 // GA4 uses the property timezone; widening dates also includes journeys that
 // cross midnight. Cohort filtering, not event date, defines the population.
 const shifted = (date, days) => new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);
 return {
  dateRanges: [{ startDate: shifted(startDate, -1), endDate: shifted(endDate, 1) }],
  dimensions: FUNNEL_DIMENSIONS.map((name) => ({ name })), metrics: [{ name: 'eventCount' }],
  dimensionFilter: { andGroup: { expressions: [
   { filter: { fieldName: 'eventName', stringFilter: { value: 'job_application_journey', matchType: 'EXACT' } } },
   { filter: { fieldName: 'hostName', stringFilter: { value: 'frontaliereticino.ch', matchType: 'EXACT' } } },
   { orGroup: { expressions: cohorts.map((cohort) => ({ filter: { fieldName: 'customEvent:journey_context', stringFilter: { matchType: 'BEGINS_WITH', value: `${cohort}|` } } })) } },
  ] } },
  orderBys: FUNNEL_DIMENSIONS.map((dimensionName) => ({ dimension: { dimensionName } })),
  limit: 10000, offset,
 };
}

async function main() {
 const provision = process.argv.includes('--provision');
 const token = await getServiceAccountToken(provision ? [GA4_READONLY_SCOPE, 'https://www.googleapis.com/auth/analytics.edit'] : [GA4_READONLY_SCOPE]);
 if (!token) throw new Error('GA4 service-account credentials unavailable');
 const propertyId = process.env.GA4_PROPERTY_ID || DEFAULT_GA4_PROPERTY_ID;
 if (provision) {
  const result = await ensureGa4CustomDimensions({ propertyId, token, dimensions: JOB_JOURNEY_GA4_DIMENSIONS });
  if (result.failures.length) throw new Error(result.failures.join(' | '));
  console.log(JSON.stringify(result));
  return;
 }
 const range = ga4DateRange(7, 2);
 const rows = [];
 let total = 0;
 do {
  const report = await runGa4Report({ token, propertyId, body: journeyReportRequest(range.startDate, range.endDate, rows.length) });
  if (report.metadata?.subjectToThresholding || report.metadata?.dataLossFromOtherRow || report.metadata?.samplingMetadatas?.length) throw new Error('GA4 returned thresholded, sampled or other-row data; cannot claim cohort completeness');
  total = report.rowCount || 0;
  const page = report.rows || [];
  if (!page.length && rows.length < total) throw new Error('Truncated GA4 cohort report');
  rows.push(...page);
 } while (rows.length < total);
 console.log(JSON.stringify({ schemaVersion: 1, event: 'job_application_journey', range, rowCount: total, ...summarizeJourneyRows(rows), note: 'Observed analytics-consented journeys; handoff means external navigation attempted, not an application submitted. Historical events are not backfilled.' }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
