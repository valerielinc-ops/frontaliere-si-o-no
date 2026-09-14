#!/usr/bin/env node

/**
 * Rebuild the files identified by guard-data-integrity on the latest main tip.
 *
 * The shared main-push helper invokes this after aborting a conflicting rebase.
 * BEFORE and VIOLATIONS are supplied by the guard workflow and deliberately
 * remain environment variables so the JSON is not reparsed by shell quoting.
 */

import { execFileSync } from 'node:child_process';

const before = process.env.BEFORE;
const violationsText = process.env.VIOLATIONS;
if (!before || !violationsText) {
  throw new Error('BEFORE and VIOLATIONS are required to rebuild data-integrity files');
}

const violations = JSON.parse(violationsText);
if (!Array.isArray(violations) || violations.length === 0) {
  throw new Error('VIOLATIONS must be a non-empty JSON array');
}

for (const violation of violations) {
  if (!violation || typeof violation.file !== 'string' || violation.file.length === 0) {
    throw new Error('Every data-integrity violation must contain a file path');
  }
  execFileSync('git', ['checkout', before, '--', violation.file], { stdio: 'inherit' });
  execFileSync('git', ['add', '--', violation.file], { stdio: 'inherit' });
}
