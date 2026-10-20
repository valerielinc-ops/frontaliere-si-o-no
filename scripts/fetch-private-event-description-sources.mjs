#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {
  downloadPrivateEventDescriptionSources,
  privateEventDescriptionBucket,
  writePrivateEventDescriptionOutput,
} from './lib/private-event-description-sources.mjs';

const index = process.argv.indexOf('--out');
const output = index === -1 ? '' : process.argv[index + 1];
if (!output || output.startsWith('--')) throw new Error('--out is required');
const target = path.resolve(output);
try {
  const bucket = await privateEventDescriptionBucket();
  const content = await downloadPrivateEventDescriptionSources(bucket);
  if (!content) throw new Error('private_event_description_backlog_missing');
  writePrivateEventDescriptionOutput(target, content);
  const records = content.toString('utf8').split('\n').filter(Boolean).length;
  console.log(JSON.stringify({ status: 'ready', records }));
} catch (error) {
  fs.rmSync(target, { force: true });
  console.log(JSON.stringify({ status: 'unavailable', error: error?.name || 'Error' }));
  process.exitCode = 1;
}
