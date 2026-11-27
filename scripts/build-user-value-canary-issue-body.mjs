#!/usr/bin/env node
/** Build a status-only public issue body for the user-value canary. */

import process from 'node:process';

const lines = [
  '## User-value monitor alert',
  '',
  'The monitor detected a regression. Revenue, user metrics, dates and diagnostics are withheld from this public issue.',
  'Review the underlying measurements only in an authorized private analytics session.',
];

if (process.env.RUN_URL) lines.push('', `**Workflow run:** ${process.env.RUN_URL}`);

process.stdout.write(`${lines.join('\n')}\n`);
