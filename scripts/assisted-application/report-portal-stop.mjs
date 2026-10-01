#!/usr/bin/env node
/**
 * Opens (or updates) the fix issue for a portal the runner could not
 * get through (self-correction, level 3; lib/portal/stop-report.mjs). Run by
 * assisted-application-agent.yml after the agent, with GH_TOKEN: the agent
 * wrote the report, already stripped of the candidate's values, to
 * $STOP_REPORT. No report, nothing to do.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createGithubIssue } from '../lib/github-issue-creator.mjs';
import { redactStopReport, stopIssue } from './lib/portal/stop-report.mjs';

const file = process.env.STOP_REPORT || '';
if (!file || !existsSync(file)) {
  console.log('[report-portal-stop] no stop report');
} else {
  // Struck again here: the e-mail and phone patterns cost nothing twice.
  const report = redactStopReport(JSON.parse(readFileSync(file, 'utf8')));
  const { title, description, dedupKey } = stopIssue(report, process.env.RUN_URL || '');
  // agent:fix-queued, not agent:fix: a label set with GITHUB_TOKEN triggers no
  // workflow; the follow-up drainer promotes it with its PAT (~20 min).
  await createGithubIssue({ title, description, dedupKey, priority: 2, labels: ['agent:fix-queued'], workflow: 'Assisted application agent' });
  console.log('[report-portal-stop] issue', title);
}
