// Reader side of the CWV field attribution emitted by services/webVitalsAttribution.ts.
//
// The client re-emits a bounded summary of a not-good CLS/INP as a
// `ui_interaction` event (page = web_vitals, section = cls|inp, component =
// the bucket of the element that moved, action = load state / interaction
// type, details = `<selector>|ac<N>|cc<M>`). Those parameters are registered
// GA4 dimensions, so the Data API can say WHICH element shifts — the input
// every sweep on the field CLS regression (issues 8868 and 9815) lacked.
//
// A script cannot import the client's `.ts`, so the constants below are a copy
// that tests/cwv-attribution-report.test.ts compares with the client module.
// Changing either side without the other turns that test red on purpose.
import { runGa4Report, weightedQuantile } from './ga4-service-account.mjs';

export const ATTRIBUTION_PAGE = 'web_vitals';
export const ATTRIBUTION_SECTIONS = ['cls', 'inp'];
export const ATTRIBUTION_COMPONENTS = ['footer', 'auto_ad', 'manual_ad', 'rail', 'job_gate', 'main', 'other'];

export const ATTRIBUTION_EVENT = 'ui_interaction';
export const VITALS_EVENT = 'web_vitals';
export const JOBS_PATH_PREFIX = '/cerca-lavoro';
export const SELECTOR_LIMIT = 200;
export const TOP_SELECTORS = 5;
const TEMPLATE_LIMIT = 100000;
const TEMPLATE_METRICS = ['CLS', 'INP'];
const ALL_DEVICES = 'tutti';

function exact(fieldName, value) {
  return { filter: { fieldName, stringFilter: { value, matchType: 'EXACT' } } };
}

function beginsWith(fieldName, value) {
  return { filter: { fieldName, stringFilter: { value, matchType: 'BEGINS_WITH' } } };
}

const ATTRIBUTION_DIMENSIONS = [
  'pagePath',
  'customEvent:section',
  'customEvent:component',
  'customEvent:action',
];

function attributionFilter() {
  return {
    andGroup: {
      expressions: [
        exact('eventName', ATTRIBUTION_EVENT),
        exact('customEvent:page', ATTRIBUTION_PAGE),
        { orGroup: { expressions: [exact('pagePath', '/'), beginsWith('pagePath', JOBS_PATH_PREFIX)] } },
      ],
    },
  };
}

/** Request (a): events per page × section × component × action. */
export function attributionRequest({ startDate, endDate }) {
  return {
    dateRanges: [{ startDate, endDate }],
    dimensions: ATTRIBUTION_DIMENSIONS.map((name) => ({ name })),
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: attributionFilter(),
  };
}

/** Request (b): same as (a) plus the selector-bearing `details`, top rows only. */
export function selectorRequest({ startDate, endDate }) {
  return {
    dateRanges: [{ startDate, endDate }],
    dimensions: [...ATTRIBUTION_DIMENSIONS, 'customEvent:details'].map((name) => ({ name })),
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: attributionFilter(),
    orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
    limit: SELECTOR_LIMIT,
  };
}

/** Request (c): CLS/INP values per page template and device on the job board. */
export function templateRequest({ startDate, endDate }) {
  return {
    dateRanges: [{ startDate, endDate }],
    dimensions: [
      { name: 'customEvent:page_template' },
      { name: 'customEvent:metric_name' },
      { name: 'customEvent:metric_value' },
      { name: 'deviceCategory' },
    ],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: {
      andGroup: {
        expressions: [
          exact('eventName', VITALS_EVENT),
          { filter: { fieldName: 'customEvent:metric_name', inListFilter: { values: TEMPLATE_METRICS } } },
          beginsWith('pagePath', JOBS_PATH_PREFIX),
        ],
      },
    },
    limit: TEMPLATE_LIMIT,
  };
}

function rowCount(row) {
  const count = Number(row?.metricValues?.[0]?.value || 0);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function dims(row) {
  return (row?.dimensionValues || []).map((d) => String(d?.value ?? ''));
}

function truncated(data, rows) {
  return Boolean(data?.metadata?.dataLossFromOtherRow)
    || (data?.rowCount != null && data.rowCount > rows.length);
}

/** Request (a) rows → [{ path, section, component, action, count }]. */
export function parseAttributionRows(data) {
  return (data?.rows || []).flatMap((row) => {
    const [path, section, component, action] = dims(row);
    const count = rowCount(row);
    return section && count ? [{ path, section, component, action, count }] : [];
  });
}

/**
 * `details` is `<selector>|ac<N>|cc<M>`: the selector is everything before the
 * first `|`, `ac`/`cc` are the Auto Ads containers present and collapsed.
 */
export function parseDetails(details) {
  const [selector = '', ...rest] = String(details ?? '').split('|');
  const pick = (prefix) => {
    const part = rest.find((p) => new RegExp(`^${prefix}\\d+$`).test(p));
    return part == null ? null : Number(part.slice(prefix.length));
  };
  return { selector, ac: pick('ac'), cc: pick('cc') };
}

/** Request (b) rows → [{ path, section, component, action, selector, ac, cc, count }]. */
export function parseSelectorRows(data) {
  return (data?.rows || []).flatMap((row) => {
    const [path, section, component, action, details] = dims(row);
    const count = rowCount(row);
    return section && count ? [{ path, section, component, action, ...parseDetails(details), count }] : [];
  });
}

/** Request (c) rows → [{ template, metric, value, device, count }] (CLS in units, INP in ms). */
export function parseTemplateRows(data) {
  return (data?.rows || []).flatMap((row) => {
    const [template, metric, rawValue, device] = dims(row);
    const raw = Number(rawValue);
    const count = rowCount(row);
    if (!template || !metric || rawValue === '' || !Number.isFinite(raw) || !count) return [];
    // services/webVitals.ts sends CLS in thousandths, like fetchGa4WebVitals reads it.
    return [{ template, metric, value: metric === 'CLS' ? raw / 1000 : raw, device: device.toLowerCase(), count }];
  });
}

/** section × component × action, summed over paths, most events first. */
export function summarizeAttribution(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.section}\u0000${row.component}\u0000${row.action}`;
    const entry = byKey.get(key) || { section: row.section, component: row.component, action: row.action, count: 0 };
    entry.count += row.count;
    byKey.set(key, entry);
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count
    || a.section.localeCompare(b.section) || a.component.localeCompare(b.component) || a.action.localeCompare(b.action));
}

function weightedMean(items, field) {
  const known = items.filter((item) => typeof item[field] === 'number');
  const total = known.reduce((sum, item) => sum + item.count, 0);
  return total ? known.reduce((sum, item) => sum + item[field] * item.count, 0) / total : null;
}

/** The CLS selectors with most events, with event-weighted mean `ac` and `cc`. */
export function topClsSelectors(rows, limit = TOP_SELECTORS) {
  const [cls] = ATTRIBUTION_SECTIONS;
  const bySelector = new Map();
  for (const row of rows) {
    if (row.section !== cls) continue;
    const key = row.selector || '(vuoto)';
    const list = bySelector.get(key) || [];
    list.push(row);
    bySelector.set(key, list);
  }
  return [...bySelector.entries()].map(([selector, items]) => {
    const components = new Map();
    for (const item of items) components.set(item.component, (components.get(item.component) || 0) + item.count);
    const [component] = [...components.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return {
      selector,
      component,
      count: items.reduce((sum, item) => sum + item.count, 0),
      ac: weightedMean(items, 'ac'),
      cc: weightedMean(items, 'cc'),
    };
  }).sort((a, b) => b.count - a.count || a.selector.localeCompare(b.selector)).slice(0, limit);
}

function p75(observations) {
  return { p75: weightedQuantile(observations, 0.75), n: observations.reduce((sum, o) => sum + o.count, 0) };
}

/**
 * Weighted p75 of CLS and INP per template, first over every device (`tutti`)
 * and then per device. Templates with the most CLS events come first.
 */
export function templateP75(rows) {
  const templates = [...new Set(rows.map((r) => r.template))];
  const out = [];
  for (const template of templates) {
    const ofTemplate = rows.filter((r) => r.template === template);
    const devices = [...new Set(ofTemplate.map((r) => r.device))].sort();
    for (const device of [ALL_DEVICES, ...devices]) {
      const scoped = device === ALL_DEVICES ? ofTemplate : ofTemplate.filter((r) => r.device === device);
      const cls = p75(scoped.filter((r) => r.metric === 'CLS'));
      const inp = p75(scoped.filter((r) => r.metric === 'INP'));
      out.push({ template, device, clsP75: cls.p75, clsN: cls.n, inpP75: inp.p75, inpN: inp.n });
    }
  }
  const clsTotal = new Map(out.filter((r) => r.device === ALL_DEVICES).map((r) => [r.template, r.clsN]));
  return out.sort((a, b) => (clsTotal.get(b.template) - clsTotal.get(a.template))
    || a.template.localeCompare(b.template)
    || (a.device === ALL_DEVICES ? -1 : b.device === ALL_DEVICES ? 1 : a.device.localeCompare(b.device)));
}

/** The dimension named by a Data API «Field X is not a valid dimension» error, if any. */
export function invalidDimension(message) {
  return /Field\s+([\w:.-]+)\s+is not a valid dimension/i.exec(String(message ?? ''))?.[1] ?? null;
}

/**
 * Runs the three GA4 requests. Any Data API error (4xx included) propagates:
 * an unregistered parameter must fail the run, not read as «no data».
 */
export async function fetchAttribution({ token, startDate, endDate, fetchImpl = fetch, propertyId } = {}) {
  const run = (body) => runGa4Report({ token, body, propertyId, fetchImpl });
  const range = { startDate, endDate };
  const attributionData = await run(attributionRequest(range));
  const selectorData = await run(selectorRequest(range));
  const templateData = await run(templateRequest(range));
  const attribution = parseAttributionRows(attributionData);
  const selectors = parseSelectorRows(selectorData);
  const templates = parseTemplateRows(templateData);
  return {
    window: range,
    attribution,
    selectors,
    templates,
    coverage: {
      attributionTruncated: truncated(attributionData, attributionData?.rows || []),
      selectorsTruncated: truncated(selectorData, selectorData?.rows || []),
      templatesTruncated: truncated(templateData, templateData?.rows || []),
    },
  };
}
