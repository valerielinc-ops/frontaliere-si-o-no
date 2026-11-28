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
export const CWV_ATTRIBUTION_COMPONENTS = ['footer', 'auto_ad', 'manual_ad', 'rail', 'job_gate', 'main', 'other', 'unknown'] as const;
export const CWV_ATTRIBUTION_PARAM_KEYS = ['page', 'section', 'component', 'action', 'cta_id', 'details'] as const;

export type CwvAttributionSection = (typeof CWV_ATTRIBUTION_SECTIONS)[number];
export type CwvAttributionComponent = (typeof CWV_ATTRIBUTION_COMPONENTS)[number];
export type CwvAttributionParams = Record<(typeof CWV_ATTRIBUTION_PARAM_KEYS)[number], string>;

export type CwvAttributionMetric = {
  name: string;
  rating: string;
  attribution?: unknown;
};

// Counted in the whole document: how many Auto Ads containers exist and how
// many `services/autoAdCollapse.ts` collapsed. The test pins both selectors to
// that module's constants.
const AUTO_AD_SELECTOR = '.google-auto-placed';
const AUTO_AD_COLLAPSED_SELECTOR = '[data-ft-autoad-collapsed]';

/**
 * First `closest()` match wins, so the order matters: an ad inside the footer
 * is an ad, the footer is only what is left; the most specific structural
 * container (main) beats the grid wrapper that contains it. Seven buckets keep `component`
 * far below GA4's 500 distinct values per day.
 */
const COMPONENT_CLASSIFIERS: ReadonlyArray<readonly [CwvAttributionComponent, string]> = [
  ['auto_ad', AUTO_AD_SELECTOR],
  ['manual_ad', 'ins.adsbygoogle'],
  ['footer', 'footer'],
  ['job_gate', '#job-auth-gate'],
  // `main` before `rail`: in production `#main-content` (and the static
  // `main.seo-static-content` fallback) is a CHILD of the rail grid wrapper, so
  // `closest()` on any main target would hit the wrapper first. The rail
  // `aside`s are siblings of main, never ancestors, hence only they stay `rail`.
  ['main', '#main-content, main.seo-static-content, main.cluster-seo-prose'],
  ['rail', '.ft-rail-grid, .ft-rail-grid-x'],
];
const FALLBACK_COMPONENT: CwvAttributionComponent = 'other';
const UNKNOWN_COMPONENT: CwvAttributionComponent = 'unknown';

const SELECTOR_MAX_LENGTH = 70;
// GA4 truncates event parameter values used as dimensions at 100 characters.
const PARAM_MAX_LENGTH = 100;
const UNKNOWN_ACTION = 'unknown';
export const CWV_ATTRIBUTION_DETAILS_PREFIX = 'cwv:';

function isSection(value: string): value is CwvAttributionSection {
  return (CWV_ATTRIBUTION_SECTIONS as readonly string[]).includes(value);
}

type ClosestCapable = { closest: (selector: string) => unknown };

/**
 * The element itself, or the parent element of a text node. Duck-typed on
 * `closest` so the module never references the `Element` global (node import).
 */
function toElement(node: unknown): ClosestCapable | null {
  if (!node || typeof node !== 'object') return null;
  if (typeof (node as Partial<ClosestCapable>).closest === 'function') return node as ClosestCapable;
  const parent = (node as { parentElement?: unknown }).parentElement;
  return parent && typeof (parent as Partial<ClosestCapable>).closest === 'function' ? parent as ClosestCapable : null;
}

/**
 * The node reference web-vitals keeps for the attributed element:
 * `largestShiftSource.node` for CLS, the best available processed event entry's
 * `target` for INP. Absent when the browser dropped every target.
 */
function attributedNode(a: Record<string, unknown>, isCls: boolean): unknown {
  if (isCls) return (a.largestShiftSource as { node?: unknown } | undefined)?.node;
  const entries = a.processedEventEntries;
  if (!Array.isArray(entries)) return undefined;
  let firstAvailable: unknown;
  for (const entry of entries) {
    const target = (entry as { target?: unknown } | undefined)?.target;
    const el = toElement(target);
    if (!el) continue;
    firstAvailable ??= target;
    try {
      if (classifyElement(el) !== FALLBACK_COMPONENT) return target;
    } catch {
      // Keep looking: buildCwvAttributionEvent must remain fail-open.
    }
  }
  return firstAvailable;
}

/**
 * Recent-interaction buffer. web-vitals only fills `interactionTarget` when the
 * entry's `target` is still set at report time; on the job board a click
 * re-renders the list, the node is gone and ~77% of the INP events (GA4,
 * 20-26/11/2026) went out as `unknown`. Passive capture listeners (installed by
 * `services/webVitals.ts`) therefore remember the target of the last few
 * interactions at the moment they happen, and `buildCwvAttributionEvent` falls
 * back to the entry closest to `attribution.interactionTime`.
 *
 * Cost contract (INP must not get worse because of its own telemetry): O(1)
 * per event, bounded buffer, only `closest()` on the target and a string slice;
 * no I/O, no layout read, no `querySelector` on the document.
 */
export const INTERACTION_BUFFER_SIZE = 8;
/**
 * The INP `interactionTime` is the `startTime` of the first event of the
 * interaction (pointerdown/keydown), and the capture listener reads
 * `event.timeStamp` of the same event on the same timeline: they normally
 * coincide. 50 ms absorbs rounding and the pointerdown/click pairing without
 * reaching the neighbouring interaction (INP interactions are >= ~100 ms apart).
 */
export const INTERACTION_MATCH_TOLERANCE_MS = 50;
export const INTERACTION_EVENT_TYPES = ['pointerdown', 'keydown', 'click'] as const;
const BUFFER_SELECTOR_MAX_LENGTH = 60;

export type RecordedInteraction = {
  timeStamp: number;
  component: CwvAttributionComponent;
  selector: string;
  pagePath: string;
};

const interactionBuffer: RecordedInteraction[] = [];

/** Compact `tag#id.class.class` (first two classes), bounded; never throws. */
function compactSelector(node: unknown): string {
  const el = node as { tagName?: unknown; id?: unknown; classList?: ArrayLike<string> | undefined };
  const tag = typeof el?.tagName === 'string' ? el.tagName.toLowerCase() : '';
  if (!tag) return '';
  const id = typeof el.id === 'string' && el.id ? `#${el.id}` : '';
  const classes = el.classList ? Array.prototype.slice.call(el.classList, 0, 2).map((c: string) => `.${c}`).join('') : '';
  return `${tag}${id}${classes}`.slice(0, BUFFER_SELECTOR_MAX_LENGTH);
}

/** Passive capture listener body. Exported for the wiring and for tests. */
export function recordInteraction(event: { target?: unknown; timeStamp?: number }, pagePath = ''): void {
  try {
    const el = toElement(event?.target);
    if (!el || typeof event.timeStamp !== 'number') return;
    interactionBuffer.push({
      timeStamp: event.timeStamp,
      component: classifyElement(el),
      selector: compactSelector(el),
      pagePath,
    });
    if (interactionBuffer.length > INTERACTION_BUFFER_SIZE) interactionBuffer.shift();
  } catch {
    // Telemetry only: never interfere with the interaction being measured.
  }
}

export function getRecordedInteractions(): readonly RecordedInteraction[] {
  return interactionBuffer;
}

export function resetRecordedInteractions(): void {
  interactionBuffer.length = 0;
}

function nearestInteraction(time: unknown): RecordedInteraction | null {
  if (typeof time !== 'number' || !Number.isFinite(time)) return null;
  let best: RecordedInteraction | null = null;
  let bestDelta = INTERACTION_MATCH_TOLERANCE_MS + 1;
  for (const entry of interactionBuffer) {
    const delta = Math.abs(entry.timeStamp - time);
    if (delta < bestDelta) { best = entry; bestDelta = delta; }
  }
  return best;
}

/** `interactionTime`, else the start of the first processed event entry. */
function interactionStart(a: Record<string, unknown>): unknown {
  if (typeof a.interactionTime === 'number') return a.interactionTime;
  const entries = a.processedEventEntries;
  return Array.isArray(entries) ? (entries[0] as { startTime?: unknown } | undefined)?.startTime : undefined;
}

/** Newer web-vitals expose a WeakRef to the target; absent on older builds. */
function derefInteractionElement(a: Record<string, unknown>): unknown {
  try {
    return (a.interactionTargetElement as { deref?: () => unknown } | undefined)?.deref?.();
  } catch {
    return undefined;
  }
}

/** web-vitals builds selectors from the raw classList: escape what CSS rejects. */
function escapeTailwindSelector(selector: string): string {
  return selector.replace(/[:/[\]%@!()]/g, (ch) => (typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(ch) : `\\${ch}`));
}

function classifyElement(el: ClosestCapable): CwvAttributionComponent {
  for (const [component, ancestor] of COMPONENT_CLASSIFIERS) {
    if (el.closest(ancestor)) return component;
  }
  return FALLBACK_COMPONENT;
}

function classifyTarget(
  node: unknown,
  selector: string,
  doc: Document,
  unavailableComponent: CwvAttributionComponent = FALLBACK_COMPONENT,
): CwvAttributionComponent {
  try {
    const el = toElement(node);
    if (el) return classifyElement(el);
    // Fallback only: web-vitals builds the selector from the raw, sorted
    // classList and escapes nothing, so on this Tailwind site it is often not
    // valid CSS (`md:pb-8`, `py-0.5`, `w-1/2`) and querySelector throws or
    // matches nothing. It is also anchored at the nearest id ancestor and can
    // point elsewhere after an SPA navigation. Hence the node reference first.
    if (!selector) return unavailableComponent;
    let found = null;
    try {
      found = toElement(doc.querySelector(selector));
    } catch {
      // Unescaped Tailwind token (`md:pb-8`): retry once with CSS escapes.
    }
    if (!found) found = toElement(doc.querySelector(escapeTailwindSelector(selector)));
    return found ? classifyElement(found) : unavailableComponent;
  } catch {
    // Invalid selector, or a document without querySelector: the event still
    // goes out, unattributed.
    return unavailableComponent;
  }
}

function countMatches(doc: Document, selector: string): number {
  try {
    return doc.querySelectorAll(selector).length;
  } catch {
    return 0;
  }
}

function buildDetails(
  section: CwvAttributionSection,
  component: CwvAttributionComponent,
  action: string,
  selector: string,
  autoAds: number,
  collapsedAutoAds: number,
): string {
  const prefix = `${CWV_ATTRIBUTION_DETAILS_PREFIX}${section}:${component}:${action}:`;
  const suffix = `|ac${Math.min(autoAds, 9999)}|cc${Math.min(collapsedAutoAds, 9999)}`;
  const selectorBudget = Math.max(0, Math.min(SELECTOR_MAX_LENGTH, PARAM_MAX_LENGTH - prefix.length - suffix.length));
  return `${prefix}${selector.slice(0, selectorBudget)}${suffix}`;
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
  const rawSelector = String((isCls ? a.largestShiftTarget : a.interactionTarget) ?? '');
  let selector = rawSelector || (isCls ? '' : UNKNOWN_COMPONENT);
  let component = classifyTarget(
    attributedNode(a, isCls),
    rawSelector,
    doc,
    isCls ? FALLBACK_COMPONENT : UNKNOWN_COMPONENT,
  );
  if (!isCls && (component === UNKNOWN_COMPONENT || !rawSelector)) {
    // The target node was gone at report time: use what the capture listeners
    // saw, then the WeakRef, and keep `unknown` only if both are missing.
    const recorded = nearestInteraction(interactionStart(a));
    const dereferenced = recorded ? null : toElement(derefInteractionElement(a));
    if (component === UNKNOWN_COMPONENT) {
      if (recorded) component = recorded.component;
      else if (dereferenced) component = classifyElement(dereferenced);
    }
    if (!rawSelector) {
      selector = recorded?.selector
        || (dereferenced ? compactSelector(dereferenced) : '')
        || UNKNOWN_COMPONENT;
    }
  }
  const action = sanitizeAction(isCls ? a.loadState : a.interactionType);
  const autoAds = countMatches(doc, AUTO_AD_SELECTOR);
  const collapsedAutoAds = countMatches(doc, AUTO_AD_COLLAPSED_SELECTOR);

  return {
    page: CWV_ATTRIBUTION_PAGE,
    section,
    component,
    action,
    cta_id: `${CWV_ATTRIBUTION_PAGE}.${section}.${component}.${action}`,
    // The marker lets the reader select only value-bearing CWV attribution
    // events without spending another GA4 dimension on eventName/cta_id. The
    // selector remains bounded and the suffix keeps the existing ad context.
    details: buildDetails(section, component, action, selector, autoAds, collapsedAutoAds),
  };
}
