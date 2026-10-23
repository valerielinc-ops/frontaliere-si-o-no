export const DEFAULT_WORKFLOW_EXPECTED_MINUTES = 30;
export const DEFAULT_WORKFLOW_EXPECTED_DURATION = `${DEFAULT_WORKFLOW_EXPECTED_MINUTES} min`;

const MIN_WORKFLOW_TIMEOUT_MS = 15 * 60_000;
const MAX_WORKFLOW_TIMEOUT_MS = 120 * 60_000;
const WORKFLOW_TIMEOUT_MULTIPLIER = 1.5;

export const WORKFLOW_EXPECTED_DURATION_PATTERN = /^\d+(?:\.\d+)?\s*(?:(?:-|–)\s*\d+(?:\.\d+)?\s*)?min$/i;

export function isExpectedWorkflowDuration(value: unknown): value is string {
  return typeof value === 'string' && WORKFLOW_EXPECTED_DURATION_PATTERN.test(value.trim());
}

export function expectedWorkflowTimeoutMs(expectedDuration: unknown): number {
  const text = typeof expectedDuration === 'string' ? expectedDuration : '';
  const rangeValues = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(?:-|–)\s*(\d+(?:\.\d+)?)\s*min/gi)]
    .flatMap((match) => [Number(match[1]), Number(match[2])])
    .filter((value) => Number.isFinite(value));
  const singleValues = [...text.matchAll(/(\d+(?:\.\d+)?)\s*min/gi)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));
  const expectedMinutes = Math.max(
    ...(rangeValues.length ? rangeValues : singleValues),
    DEFAULT_WORKFLOW_EXPECTED_MINUTES,
  );
  return Math.min(
    MAX_WORKFLOW_TIMEOUT_MS,
    Math.max(MIN_WORKFLOW_TIMEOUT_MS, Math.ceil(expectedMinutes * WORKFLOW_TIMEOUT_MULTIPLIER * 60_000)),
  );
}
