// Reader side of the CWV field attribution emitted by services/webVitalsAttribution.ts.
//
// The client re-emits a bounded summary of a not-good CLS/INP as a
// `ui_interaction` event (page = web_vitals, section = cls|inp, component =
// the bucket of the element that moved, action = load state / interaction
// type, details = `cwv:<section>:<component>:<action>:<selector>|ac<N>|cc<M>`).
// Those parameters are registered
// GA4 dimensions, so the Data API can say WHICH element shifts — the input
// every sweep on the field CLS regression (issues 8868 and 9815) lacked.
//
// A script cannot import the client's `.ts`, so the constants below are a copy
// that tests/cwv-attribution-report.test.ts compares with the client module.
// Changing either side without the other turns that test red on purpose.
import { runGa4ReportPaged, weightedQuantile } from './ga4-service-account.mjs';
import { withAutomationFleetExclusion } from './ga4-automation-fleet.mjs';
import { classifyAnalyticsPath } from './analytics-opportunity-utils.mjs';
import { SECTION_LEGACY_TI_PATH } from '../../build-plugins/shared/cantonResolvers.mjs';

export const ATTRIBUTION_PAGE = 'web_vitals';
export const ATTRIBUTION_SECTIONS = ['cls', 'inp'];
export const ATTRIBUTION_COMPONENTS = ['footer', 'auto_ad', 'manual_ad', 'rail', 'job_gate', 'main', 'other', 'unknown'];
export const ATTRIBUTION_DETAILS_PREFIX = 'cwv:';

export const ATTRIBUTION_EVENT = 'ui_interaction';
export const VITALS_EVENT = 'web_vitals';
export const JOBS_PATH_PREFIX = '/cerca-lavoro';
export const JOB_PAGE_TEMPLATES = Object.freeze([
  'jobs_index',
  'jobs_company',
  'jobs_search',
  'jobs_sector',
  'job_detail',
]);
export const SELECTOR_PAGE_SIZE = 200;
export const TOP_SELECTORS = 5;
export const TOP_VALUED_INP_TARGETS = 10;
export const PRIORITY_INP_PATH = SECTION_LEGACY_TI_PATH.it;
const TEMPLATE_LIMIT = 100000;
const TEMPLATE_METRICS = ['CLS', 'INP'];
const ALL_DEVICES = 'tutti';
const GA4_DEVICES = new Set(['desktop', 'mobile', 'tablet', 'smart tv']);

function exact(fieldName, value) {
  return { filter: { fieldName, stringFilter: { value, matchType: 'EXACT' } } };
}

function beginsWith(fieldName, value) {
  return { filter: { fieldName, stringFilter: { value, matchType: 'BEGINS_WITH' } } };
}

const ATTRIBUTION_DIMENSIONS = [
  'pagePath',
  'customEvent:section',
  // cta_id is `web_vitals.<section>.<component>.<action>` in the emitter.
  // Keeping the two values in one registered dimension leaves room for the
  // complete five-dimension automation-fleet exclusion (GA4 budget: nine).
  'customEvent:cta_id',
];

function attributionFilter() {
  return {
    andGroup: {
      expressions: [
        beginsWith('customEvent:cta_id', `${ATTRIBUTION_PAGE}.`),
        { filter: { fieldName: 'customEvent:section', inListFilter: { values: ATTRIBUTION_SECTIONS } } },
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

/** Request (b): same as (a) plus the selector-bearing `details`, read page by page. */
export function selectorRequest({ startDate, endDate }) {
  return {
    dateRanges: [{ startDate, endDate }],
    dimensions: [...ATTRIBUTION_DIMENSIONS, 'customEvent:details'].map((name) => ({ name })),
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: attributionFilter(),
    limit: SELECTOR_PAGE_SIZE,
  };
}

/**
 * Request (d): value-bearing attribution per page, selector and GA4 device.
 *
 * Four selected dimensions plus the five report-side fleet dimensions exactly
 * fill GA4's nine-dimension budget. The producer marker in `details` makes
 * eventName/section/cta_id filters unnecessary; section/component/action are
 * parsed from that marker. Historical unmarked rows stay on request (b).
 */
export function valuedSelectorRequest({ startDate, endDate }) {
  return {
    dateRanges: [{ startDate, endDate }],
    dimensions: [
      { name: 'pagePath' },
      { name: 'customEvent:details' },
      { name: 'customEvent:metric_value' },
      { name: 'deviceCategory' },
    ],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: {
      andGroup: {
        expressions: [
          beginsWith('customEvent:details', ATTRIBUTION_DETAILS_PREFIX),
          { orGroup: { expressions: [exact('pagePath', '/'), beginsWith('pagePath', JOBS_PATH_PREFIX)] } },
        ],
      },
    },
    limit: SELECTOR_PAGE_SIZE,
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
          // metric_name is emitted only by services/webVitals.ts. Filtering
          // the registered page-template dimension keeps this query within
          // the same nine-dimension budget as the full fleet exclusion.
          { filter: { fieldName: 'customEvent:page_template', inListFilter: { values: JOB_PAGE_TEMPLATES } } },
          { filter: { fieldName: 'customEvent:metric_name', inListFilter: { values: TEMPLATE_METRICS } } },
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

function normalizedGa4Device(value) {
  const device = String(value ?? '').trim().toLowerCase();
  return GA4_DEVICES.has(device) ? device : '';
}

function truncated(data, rows) {
  return data?.complete === false
    || Boolean(data?.metadata?.dataLossFromOtherRow)
    || (data?.rowCount != null && data.rowCount > rows.length);
}

function parseAttributionCtaId(value, section) {
  const [page, ctaSection, component, action] = String(value ?? '').split('.');
  if (page !== ATTRIBUTION_PAGE || ctaSection !== section
    || !ATTRIBUTION_COMPONENTS.includes(component)
    || !/^[a-z-]{1,24}$/.test(action || '')) return null;
  return { component, action };
}

/** Request (a) rows → [{ path, section, component, action, count }]. */
export function parseAttributionRows(data) {
  return (data?.rows || []).flatMap((row) => {
    const [path, section, ctaId] = dims(row);
    const count = rowCount(row);
    const attribution = parseAttributionCtaId(ctaId, section);
    return attribution && count ? [{ path, section, ...attribution, count }] : [];
  });
}

/**
 * `details` is either the historical `<selector>|ac<N>|cc<M>` or the current
 * `cwv:<section>:<component>:<action>:<selector>|ac<N>|cc<M>`. `ac`/`cc` are
 * the Auto Ads containers present and collapsed.
 */
export function parseDetails(details) {
  const [selector = '', ...rest] = String(details ?? '').split('|');
  const pick = (prefix) => {
    const part = rest.find((p) => new RegExp(`^${prefix}\\d+$`).test(p));
    return part == null ? null : Number(part.slice(prefix.length));
  };
  const marker = /^cwv:(cls|inp):([^:]+):([^:]+):(.*)$/u.exec(selector);
  return {
    selector: marker ? marker[4] : selector,
    embedded: marker ? {
      section: marker[1],
      component: marker[2],
      action: marker[3],
    } : null,
    ac: pick('ac'),
    cc: pick('cc'),
  };
}

/** Request (b) rows → [{ path, section, component, action, selector, ac, cc, count }]. */
export function parseSelectorRows(data) {
  return (data?.rows || []).flatMap((row) => {
    const [path, section, ctaId, details] = dims(row);
    const count = rowCount(row);
    const attribution = parseAttributionCtaId(ctaId, section);
    if (!attribution || !count) return [];
    const parsed = parseDetails(details);
    if (section === ATTRIBUTION_SECTIONS[1] && !parsed.selector) parsed.selector = 'unknown';
    return [{
      path,
      section,
      ...attribution,
      selector: parsed.selector,
      ac: parsed.ac,
      cc: parsed.cc,
      count,
    }];
  });
}

/** Request (d) rows -> value-linked selector attribution. */
export function parseValuedSelectorRows(data) {
  return (data?.rows || []).flatMap((row) => {
    const [path, details, rawValue, rawDevice] = dims(row);
    const parsed = parseDetails(details);
    const embedded = parsed.embedded;
    const valueText = String(rawValue ?? '').trim();
    const raw = Number(rawValue);
    const device = normalizedGa4Device(rawDevice);
    const count = rowCount(row);
    if (!path || !embedded || !ATTRIBUTION_SECTIONS.includes(embedded.section)
      || !ATTRIBUTION_COMPONENTS.includes(embedded.component)
      || !/^[a-z-]{1,24}$/u.test(embedded.action)
      || valueText === '' || !Number.isFinite(raw) || !device || !count) return [];
    return [{
      path,
      section: embedded.section,
      component: embedded.component,
      action: embedded.action,
      selector: parsed.selector,
      ac: parsed.ac,
      cc: parsed.cc,
      value: embedded.section === ATTRIBUTION_SECTIONS[0] ? raw / 1000 : raw,
      device,
      count,
    }];
  });
}

/**
 * Number of fetched INP buckets that cannot participate in a device-scoped
 * p75 because GA4 did not return a finite value or a known, non-empty device.
 * Keep this separate from the parsed rows: silently dropping one bad bucket
 * would otherwise let a partially attributed report pass when another bucket
 * is valid.
 */
export function incompleteValuedInpRowCount(data) {
  return (data?.rows || []).reduce((total, row) => {
    const [, details, rawValue, rawDevice] = dims(row);
    if (parseDetails(details).embedded?.section !== ATTRIBUTION_SECTIONS[1]) return total;
    const valueText = String(rawValue ?? '').trim();
    const raw = Number(rawValue);
    const incomplete = valueText === ''
      || !Number.isFinite(raw)
      || !normalizedGa4Device(rawDevice);
    return total + (incomplete ? 1 : 0);
  }, 0);
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

/** The selectors for one metric with most events, with weighted `ac`/`cc`. */
function topSelectors(rows, section, limit = TOP_SELECTORS) {
  const bySelector = new Map();
  for (const row of rows) {
    if (row.section !== section) continue;
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

/** The CLS selectors with most events. */
export function topClsSelectors(rows, limit = TOP_SELECTORS) {
  return topSelectors(rows, ATTRIBUTION_SECTIONS[0], limit);
}

/** The INP interaction targets with most events. */
export function topInpSelectors(rows, limit = TOP_SELECTORS) {
  return topSelectors(rows, ATTRIBUTION_SECTIONS[1], limit);
}

/** Number of INP events whose target is explicitly unknown (or legacy-empty). */
export function missingInpSelectorCount(rows) {
  return rows
    .filter((row) => row.section === ATTRIBUTION_SECTIONS[1] && (!row.selector || row.selector === 'unknown'))
    .reduce((sum, row) => sum + row.count, 0);
}

/**
 * Page template of a GA4 `pagePath`, derived with the same classifier the
 * client uses for `page_template` (analytics-opportunity-utils mirrors
 * services/analyticsPageContext.ts). The INP attribution event carries no
 * template dimension (GA4 is at its dimension budget), so it is joined by path.
 */
export function templateOfPath(path) {
  try {
    return classifyAnalyticsPath(String(path || '')).pageTemplate || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Share of INP attribution events whose target is still `unknown`. */
export function inpUnknownShare(rows) {
  const inp = rows.filter((row) => row.section === ATTRIBUTION_SECTIONS[1]);
  const total = inp.reduce((sum, row) => sum + row.count, 0);
  const unknown = missingInpSelectorCount(rows);
  return { unknown, total, share: total ? unknown / total : 0 };
}

/** selector x template x device, p75 and events (INP rows with value and device only). */
export function inpTargetsByTemplate(rows, limit = 15) {
  const grouped = new Map();
  for (const row of rows) {
    if (row.section !== ATTRIBUTION_SECTIONS[1]) continue;
    const template = templateOfPath(row.path);
    const selector = row.selector || 'unknown';
    const key = [selector, template, row.device].join('\u0000');
    const group = grouped.get(key) || { selector, template, device: row.device, observations: [] };
    group.observations.push({ value: row.value, count: row.count });
    grouped.set(key, group);
  }
  return [...grouped.values()].map(({ observations, ...group }) => ({
    ...group,
    inpP75: weightedQuantile(observations, 0.75),
    count: observations.reduce((sum, o) => sum + o.count, 0),
  })).sort((a, b) => b.count - a.count || a.selector.localeCompare(b.selector)
    || a.template.localeCompare(b.template) || a.device.localeCompare(b.device)).slice(0, limit);
}

/** Slowest INP targets, now carrying their own p75, count and GA4 device. */
export function valuedInpTargets(rows, limit = TOP_VALUED_INP_TARGETS) {
  const grouped = new Map();
  for (const row of rows) {
    if (row.section !== ATTRIBUTION_SECTIONS[1]) continue;
    const key = [row.path, row.device, row.selector || 'unknown', row.component, row.action].join('\u0000');
    const group = grouped.get(key) || {
      path: row.path,
      device: row.device,
      selector: row.selector || 'unknown',
      component: row.component,
      action: row.action,
      observations: [],
    };
    group.observations.push({ value: row.value, count: row.count });
    grouped.set(key, group);
  }
  return [...grouped.values()].map(({ observations, ...group }) => ({
    ...group,
    inpP75: weightedQuantile(observations, 0.75),
    count: observations.reduce((sum, observation) => sum + observation.count, 0),
  })).sort((a, b) => {
    const aPriority = a.path === PRIORITY_INP_PATH && a.device === 'desktop' ? 1 : 0;
    const bPriority = b.path === PRIORITY_INP_PATH && b.device === 'desktop' ? 1 : 0;
    return bPriority - aPriority || b.inpP75 - a.inpP75 || b.count - a.count
      || a.path.localeCompare(b.path) || a.selector.localeCompare(b.selector);
  }).slice(0, limit);
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
 * Runs the four GA4 requests. Any Data API error (4xx included) propagates:
 * an unregistered parameter must fail the run, not read as «no data».
 */
export async function fetchAttribution({ token, startDate, endDate, fetchImpl = fetch, propertyId } = {}) {
  // Tutte e quattro sono popolazioni intere: paginate fino a rowCount, altrimenti
  // un limit fisso senza offset le dichiara troncate (issue 11423).
  // The measured automation fleets emit web_vitals/ui_interaction too (8% and
  // 15% of those events over 28 days): excluded from all four populations.
  const runAll = (body) => runGa4ReportPaged({ token, body: withAutomationFleetExclusion(body), propertyId, fetchImpl });
  const range = { startDate, endDate };
  const attributionData = await runAll(attributionRequest(range));
  const selectorData = await runAll(selectorRequest(range));
  const templateData = await runAll(templateRequest(range));
  const valuedSelectorData = await runAll(valuedSelectorRequest(range));
  const attribution = parseAttributionRows(attributionData);
  const selectors = parseSelectorRows(selectorData);
  const templates = parseTemplateRows(templateData);
  const valuedSelectors = parseValuedSelectorRows(valuedSelectorData);
  return {
    window: range,
    attribution,
    selectors,
    templates,
    valuedSelectors,
    coverage: {
      attributionTruncated: truncated(attributionData, attributionData?.rows || []),
      selectorsTruncated: truncated(selectorData, selectorData?.rows || []),
      templatesTruncated: truncated(templateData, templateData?.rows || []),
      valuedSelectorsTruncated: truncated(valuedSelectorData, valuedSelectorData?.rows || []),
      valuedInpIncompleteRows: incompleteValuedInpRowCount(valuedSelectorData),
    },
  };
}
