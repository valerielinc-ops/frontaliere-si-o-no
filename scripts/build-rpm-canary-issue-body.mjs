#!/usr/bin/env node
/** Build a status-only public issue body for the RPM canary. */

import process from 'node:process';

const lines = [
  '## AdSense RPM monitor alert',
  '',
  'The monitor detected a regression. Financial measurements, dates and diagnostics are withheld from this public issue.',
  'Review the underlying measurements only in an authorized private analytics session.',
];

if (process.env.RUN_URL) lines.push('', `**Workflow run:** ${process.env.RUN_URL}`);

process.stdout.write(`${lines.join('\n')}\n`);
