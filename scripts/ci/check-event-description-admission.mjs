#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import {
  assessEventDescriptionRewriteAdmission,
  EVENT_DESCRIPTION_REWRITE_BRANCH,
} from '../lib/event-description-admission.mjs';

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function readJson(pathname) {
  return JSON.parse(readFileSync(pathname, 'utf8'));
}

const result = assessEventDescriptionRewriteAdmission({
  currentRunId: argument('--current-run-id'),
  runs: readJson(argument('--runs-file')),
  dataPullRequests: readJson(argument('--pull-requests-file')),
  branch: argument('--branch', EVENT_DESCRIPTION_REWRITE_BRANCH),
});
function writeAdmissionOutput(outputPath, admission) {
  writeFileSync(outputPath, [
    `admitted=${admission.admitted}`,
    `admission_reason=${admission.reason}`,
    `admission_detail=${admission.detail}`,
    '',
  ].join('\n'));
}
if (argument('--github-output')) writeAdmissionOutput(argument('--github-output'), result);
console.log(JSON.stringify(result));
