import { CANTONS } from './config.mjs';
import {
  classifyStaffingEmployer,
  loadStaffingRegistry,
} from './seco-staffing-classifier.mjs';

/**
 * Queue order for the border cantons. The remaining cantons are appended in
 * the stable config order, so a new canton cannot silently change the border
 * sequence while still receiving capacity.
 */
export const FRONTIER_CANTONS = Object.freeze([
  'TI', 'GR', 'VS', 'GE', 'VD', 'BS', 'BL', 'JU', 'NE', 'SH', 'TG', 'SG',
]);
export const PROSPECTOR_CANTON_ORDER = Object.freeze([
  ...FRONTIER_CANTONS,
  ...CANTONS.filter((canton) => !FRONTIER_CANTONS.includes(canton)),
]);

/** Twenty percent (with a minimum of one) keeps non-border cantons alive. */
export const REST_CANTON_QUOTA = 0.20;
export const SECO_RECENT_DAYS = 30;
const SECO_RECENT_MS = SECO_RECENT_DAYS * 86_400_000;

const CANTON_RANK = new Map(PROSPECTOR_CANTON_ORDER.map((canton, index) => [canton, index]));
let staffingRegistry;

export function candidateCanton(value = {}) {
  return String(
    value?.canton
      || value?.addressRegion
      || value?.location?.addressRegion
      || '',
  ).trim().toUpperCase();
}

export function cantonPriority(value) {
  const canton = candidateCanton(value);
  return CANTON_RANK.get(canton) ?? PROSPECTOR_CANTON_ORDER.length;
}

export function isFrontierCanton(value) {
  return FRONTIER_CANTONS.includes(candidateCanton(value));
}

export function compareCantons(a, b) {
  return cantonPriority(a) - cantonPriority(b);
}

export function hasRecentSecoDemand(candidate, now = Date.now()) {
  if (!(Number(candidate?.adCount) > 0)) return false;
  const observedAt = Date.parse(String(candidate?.sourceSeenAt?.seco || ''));
  const age = now - observedAt;
  return Number.isFinite(observedAt) && age >= 0 && age <= SECO_RECENT_MS;
}

function staffingRegistryForPriority() {
  if (!staffingRegistry) staffingRegistry = loadStaffingRegistry();
  return staffingRegistry;
}

/**
 * Recompute the SECO staffing classification from the same classifier used by
 * the coverage metric. A candidate without an employer name stays unknown;
 * persisted labels cannot silently override the shared classifier.
 */
export function staffingClassificationForCandidate(candidate = {}) {
  const employer = String(
    candidate.secoEmployerName
      || candidate.employerName
      || candidate.name
      || '',
  ).trim();
  if (!employer) return 'unknown';
  return classifyStaffingEmployer(employer, staffingRegistryForPriority(), {
    offerCount: candidate.adCount ?? candidate.offerCount,
    cantonCount: candidate.cantonCount,
    cantons: candidate.cantons || (candidate.canton ? [candidate.canton] : undefined),
    employerDisclosed: candidate.employerDisclosed ?? candidate.secoEmployerDisclosed,
    undisclosedCount: candidate.undisclosedCount,
  }).classification;
}

/** Direct means the SECO employer is not classified as staffing by the shared classifier. */
export function isDirectRecentSeco(candidate, now = Date.now()) {
  const classification = staffingClassificationForCandidate(candidate);
  return classification === 'direct' && hasRecentSecoDemand(candidate, now);
}

/**
 * Add the cross-cutting priority signals without replacing a stage's own
 * evidence comparator. This function is intentionally neutral for candidates
 * without the new fields, preserving the existing queue order during rollout.
 */
export function compareCoveragePriority(a, b, now = Date.now(), baseCompare = () => 0) {
  const directRecent = Number(isDirectRecentSeco(b, now)) - Number(isDirectRecentSeco(a, now));
  if (directRecent) return directRecent;
  const canton = compareCantons(a, b);
  if (canton && (isFrontierCanton(a) || isFrontierCanton(b))) return canton;
  return baseCompare(a, b);
}

export function restQuotaSlots(limit, restCount) {
  const max = Math.max(0, Math.floor(Number(limit) || 0));
  if (!max || !restCount) return 0;
  return Math.min(restCount, Math.max(1, Math.ceil(max * REST_CANTON_QUOTA)));
}

/**
 * Select frontier work first while reserving a bounded slice for every other
 * canton. The final fill handles a short frontier queue without dropping
 * available work or producing duplicates.
 */
export function selectWithRestCantonQuota(items, limit, {
  compare = () => 0,
  cantonFor = candidateCanton,
  selectPool = (pool, budget) => [...pool].sort(compare).slice(0, budget),
} = {}) {
  const max = Math.max(0, Math.floor(Number(limit) || 0));
  if (!max) return [];
  const frontier = items.filter((item) => FRONTIER_CANTONS.includes(cantonFor(item)));
  const rest = items.filter((item) => !FRONTIER_CANTONS.includes(cantonFor(item)));
  if (!frontier.length || !rest.length) return selectPool(items, max).slice(0, max);

  const restSlots = restQuotaSlots(max, rest.length);
  const selectedFrontier = selectPool(frontier, Math.min(frontier.length, max - restSlots));
  const selectedRest = selectPool(rest, Math.min(rest.length, max - selectedFrontier.length));
  const selected = [...selectedFrontier, ...selectedRest];
  if (selected.length >= max) return selected.slice(0, max);

  const selectedSet = new Set(selected);
  const fill = selectPool(items.filter((item) => !selectedSet.has(item)), max - selected.length);
  return [...selected, ...fill].slice(0, max);
}
