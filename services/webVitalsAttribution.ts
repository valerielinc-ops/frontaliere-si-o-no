/**
 * CWV field attribution that GA4 can actually read.
 *
 * `services/webVitals.ts` already attaches the element behind a bad CLS/INP to
 * the `web_vitals` event (`largest_shift_target`, `inp_target`, …), but those
 * parameters are not registered custom dimensions, and the property sits at
 * 50 of 50 event-scoped dimensions: the Data API answers
 * `Field customEvent:largest_shift_target is not a valid dimension`. The field
 * CLS regression on `/cerca-lavoro-*` (issues 8868 and 9815) was chased blind
 * for that reason.
 *
 * This module re-emits a bounded summary of the same attribution as a
 * `ui_interaction` event, whose parameters (`page`, `section`, `component`,
 * `action`, `cta_id`, `details`) are already registered. Nothing new has to be
 * registered and no registered dimension changes meaning.
 *
 * The exported constants are a contract with the reader under `scripts/`
 * (it compares them in a test): renaming them or changing a value breaks it on
 * purpose. The module touches no DOM global at import time, so it can be
 * imported from a node environment.
 */

export const CWV_ATTRIBUTION_PAGE = 'web_vitals';
export const CWV_ATTRIBUTION_SECTIONS = ['cls', 'inp'] as const;
export const CWV_ATTRIBUTION_COMPONENTS = ['footer', 'auto_ad', 'manual_ad', 'rail', 'job_gate', 'main', 'other'] as const;
export const CWV_ATTRIBUTION_PARAM_KEYS = ['page', 'section', 'component', 'action', 'cta_id', 'details'] as const;

export type CwvAttributionSection = (typeof CWV_ATTRIBUTION_SECTIONS)[number];
export type CwvAttributionComponent = (typeof CWV_ATTRIBUTION_COMPONENTS)[number];
export type CwvAttributionParams = Record<(typeof CWV_ATTRIBUTION_PARAM_KEYS)[number], string>;

export type CwvAttributionMetric = {
  name: string;
  rating: string;
  attribution?: unknown;
};

/**
 * First `closest()` match wins, so the order matters: an ad inside the footer
 * is an ad, the footer is only what is left. Seven buckets keep `component`
 * far below GA4's 500 distinct values per day.
 */
const COMPONENT_CLASSIFIERS: ReadonlyArray<readonly [CwvAttributionComponent, string]> = [
  ['auto_ad', '.google-auto-placed'],
  ['manual_ad', 'ins.adsbygoogle'],
  ['footer', 'footer'],
  ['rail', '.ft-rail-grid, .ft-rail-grid-x'],
  ['job_gate', '#job-auth-gate'],
  ['main', '#main-content'],
];
const FALLBACK_COMPONENT: CwvAttributionComponent = 'other';

// Counted in the whole document: how many Auto Ads containers exist and how
// many `services/autoAdCollapse.ts` collapsed. The test pins the attribute to
// that module's constant.
const AUTO_AD_SELECTOR = '.google-auto-placed';
const AUTO_AD_COLLAPSED_SELECTOR = '[data-ft-autoad-collapsed]';

const SELECTOR_MAX_LENGTH = 70;
// GA4 truncates event parameter values used as dimensions at 100 characters.
const PARAM_MAX_LENGTH = 100;
const UNKNOWN_ACTION = 'unknown';

function isSection(value: string): value is CwvAttributionSection {
  return (CWV_ATTRIBUTION_SECTIONS as readonly string[]).includes(value);
}

function classifyTarget(selector: string, doc: Document): CwvAttributionComponent {
  if (!selector) return FALLBACK_COMPONENT;
  try {
    const node = doc.querySelector(selector);
    if (!node) return FALLBACK_COMPONENT;
    for (const [component, ancestor] of COMPONENT_CLASSIFIERS) {
      if (node.closest(ancestor)) return component;
    }
  } catch {
    // Invalid selector (web-vitals truncates long ones) or a document without
    // querySelector: the event still goes out, unattributed.
  }
  return FALLBACK_COMPONENT;
}

function countMatches(doc: Document, selector: string): number {
  try {
    return doc.querySelectorAll(selector).length;
  } catch {
    return 0;
  }
}

/** `loadState` for CLS, `interactionType` for INP: a handful of known tokens. */
function sanitizeAction(value: unknown): string {
  return typeof value === 'string' && /^[a-z-]{1,24}$/.test(value) ? value : UNKNOWN_ACTION;
}

/**
 * Returns the `ui_interaction` parameters for a CLS or INP that is not `good`,
 * or `null` for every other metric. Never throws: a telemetry failure must not
 * cost the `web_vitals` event it rides along with.
 */
export function buildCwvAttributionEvent(
  metric: CwvAttributionMetric,
  doc: Document = document,
): CwvAttributionParams | null {
  const section = String(metric?.name ?? '').toLowerCase();
  if (!isSection(section) || metric.rating === 'good') return null;

  const [clsSection] = CWV_ATTRIBUTION_SECTIONS;
  const a = (metric.attribution ?? {}) as Record<string, unknown>;
  const isCls = section === clsSection;
  const selector = String((isCls ? a.largestShiftTarget : a.interactionTarget) ?? '');
  const component = classifyTarget(selector, doc);
  const action = sanitizeAction(isCls ? a.loadState : a.interactionType);
  const autoAds = countMatches(doc, AUTO_AD_SELECTOR);
  const collapsedAutoAds = countMatches(doc, AUTO_AD_COLLAPSED_SELECTOR);

  return {
    page: CWV_ATTRIBUTION_PAGE,
    section,
    component,
    action,
    cta_id: `${CWV_ATTRIBUTION_PAGE}.${section}.${component}.${action}`,
    details: `${selector.slice(0, SELECTOR_MAX_LENGTH)}|ac${autoAds}|cc${collapsedAutoAds}`.slice(0, PARAM_MAX_LENGTH),
  };
}
