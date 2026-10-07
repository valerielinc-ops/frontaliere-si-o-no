/**
 * Dependency-free contract shared by the Cloud Function dispatcher and the
 * workflow-side observer. Keeping the table free of firebase-admin imports
 * lets the observer validate the same entries on a GitHub runner.
 */

const entries = [
  { id: 'site-triage-pending', repo: 'site', workflow: 'issue-triage.yml', everyMinutes: 10, condition: 'untriaged-issues' },
  { id: 'site-triage-sweep', repo: 'site', workflow: 'issue-triage.yml', everyMinutes: 240 },
  { id: 'site-closer', repo: 'site', workflow: 'close-recovered-failure-issues.yml', everyMinutes: 60 },
  { id: 'site-retry-automerge', repo: 'site', workflow: 'retry-native-automerge.yml', everyMinutes: 20 },
  { id: 'site-production-canary', repo: 'site', workflow: 'production-canary.yml', everyMinutes: 15 },
  // This entry joined an already-running clock. The observer uses the
  // introduction time for its first warm-up window; the dispatcher ignores
  // this observer-only field.
  {
    id: 'site-revenue-signal-monitor',
    repo: 'site',
    workflow: 'revenue-signal-monitor.yml',
    everyMinutes: 60,
    introducedAt: '2026-10-07T16:50:03Z',
  },
  // `mode: failures`: a bare dispatch defaults to `both`, and the dormant pass
  // (one Actions call per scheduled workflow) is budgeted once a day on the
  // native cron of that workflow, not once an hour.
  { id: 'site-unreported-failures', repo: 'site', workflow: 'unreported-failure-issues.yml', everyMinutes: 60, inputs: { mode: 'failures' } },
  { id: 'corpus-triage-pending', repo: 'corpus', workflow: 'issue-triage.yml', everyMinutes: 10, condition: 'untriaged-issues' },
  { id: 'corpus-triage-sweep', repo: 'corpus', workflow: 'issue-triage.yml', everyMinutes: 240 },
  { id: 'corpus-closer', repo: 'corpus', workflow: 'close-recovered-failure-issues.yml', everyMinutes: 60 },
  { id: 'site-loop-clock-observer', repo: 'site', workflow: 'orchestrator-heartbeat.yml', everyMinutes: 30 },
];

export const LOOP_CLOCK_ENTRIES = Object.freeze(
  entries.map((entry) => Object.freeze(
    entry.inputs ? { ...entry, inputs: Object.freeze({ ...entry.inputs }) } : entry,
  )),
);

/** Repository the `corpus` entries dispatch to and the observer reads. */
export const LOOP_CLOCK_CORPUS_REPOSITORY = 'nanakokyobashi-rgb/frontaliere-articles';

/**
 * Every workflow in the table derives its run-name from this dispatch input:
 * `<workflow name> [loop-clock <entry id>@<slot>]`. The marker is the only
 * thing that tells a clock dispatch from a manual, event-driven or native-cron
 * run of the same workflow, and one entry from another that shares it. Same
 * idiom as the crawler wave (`[cloud-scheduler <slot>]`, orchestrate-crawlers.yml).
 */
export const LOOP_CLOCK_INPUT = 'loop_clock';
export const LOOP_CLOCK_RUN_MARKER_PREFIX = '[loop-clock ';

function entryId(entry) {
  const id = entry?.id;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new TypeError('loop clock entry id must be a lowercase slug');
  }
  return id;
}

/** Value of the dispatch input: `<entry id>@<slot, UTC minute>`. */
export function loopClockInputValue(entry, slot) {
  const date = slot instanceof Date ? slot : new Date(slot);
  if (!Number.isFinite(date.getTime())) throw new TypeError('loop clock slot must be a valid date');
  return `${entryId(entry)}@${date.toISOString().slice(0, 16)}Z`;
}

/** What the run-name of a dispatch of this entry contains, whatever the slot. */
export function loopClockRunMarker(entry) {
  return `${LOOP_CLOCK_RUN_MARKER_PREFIX}${entryId(entry)}@`;
}
