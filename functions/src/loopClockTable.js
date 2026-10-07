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
  { id: 'site-unreported-failures', repo: 'site', workflow: 'unreported-failure-issues.yml', everyMinutes: 60 },
  { id: 'corpus-triage-pending', repo: 'corpus', workflow: 'issue-triage.yml', everyMinutes: 10, condition: 'untriaged-issues' },
  { id: 'corpus-triage-sweep', repo: 'corpus', workflow: 'issue-triage.yml', everyMinutes: 240 },
  { id: 'corpus-closer', repo: 'corpus', workflow: 'close-recovered-failure-issues.yml', everyMinutes: 60 },
  { id: 'site-loop-clock-observer', repo: 'site', workflow: 'orchestrator-heartbeat.yml', everyMinutes: 30 },
];

export const LOOP_CLOCK_ENTRIES = Object.freeze(
  entries.map((entry) => Object.freeze(entry)),
);
