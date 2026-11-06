import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { shouldApplyApplicationRecovery } from './application-recovery-marker.mjs';

const { GITHUB_EVENT_NAME: eventName, GITHUB_SHA: sha, GITHUB_OUTPUT: outputPath } = process.env;
if (!eventName || !/^[a-f0-9]{40}$/u.test(sha || '') || !outputPath) {
  throw new Error('GitHub event, selected SHA and output path are required');
}

const selectedRevisionMessage = execFileSync('git', ['show', '-s', '--format=%B', sha], { encoding: 'utf8' });
const apply = shouldApplyApplicationRecovery({ eventName, selectedRevisionMessage });
appendFileSync(outputPath, `apply=${apply}\n`);
