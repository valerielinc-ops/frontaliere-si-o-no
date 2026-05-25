#!/usr/bin/env node
/**
 * Deploy guardrail: a production build must not be considered successful when
 * the late SEO plugins silently failed to run. This catches sequential
 * closeBundle deadlocks where Vite exits after a partial plugin chain.
 */
import { existsSync, readFileSync } from 'node:fs';

const logPath = process.argv[2] || '/tmp/build.log';

if (!existsSync(logPath)) {
  console.error(`[validate-build-profile-markers] FAIL: build log not found at ${logPath}`);
  process.exit(1);
}

const log = readFileSync(logPath, 'utf-8');

const requiredMarkers = [
  {
    label: 'related-search closeBundle profile',
    pattern: /\[profile\]\s+related-search-clusters\s+\d+(?:\.\d+)?s/,
  },
  {
    label: 'related-search internal profile total',
    pattern: /\[related-search-profile\]\s+TOTAL\s+\d+\s+\d+(?:\.\d+)?/,
  },
  {
    label: 'post-walk coordinator profile',
    pattern: /\[profile\]\s+post-walk-coordinator\s+\d+(?:\.\d+)?s/,
  },
  {
    label: 'post-walk coordinator completion log',
    pattern: /\[post-walk-coordinator\]\x1b\[0m scanned \d+ files in \d+(?:\.\d+)?s|\[post-walk-coordinator\] scanned \d+ files in \d+(?:\.\d+)?s/,
  },
  {
    label: 'profile total',
    pattern: /\[profile-total\] closeBundle phase total: \d+(?:\.\d+)?s across \d+ plugins/,
  },
];

const missing = requiredMarkers.filter(({ pattern }) => !pattern.test(log));

if (missing.length > 0) {
  console.error('[validate-build-profile-markers] FAIL: required build profile markers missing:');
  for (const marker of missing) console.error(`  - ${marker.label}`);
  console.error(
    '\nA deploy build without these markers is not a valid performance sample and may be missing static SEO output.',
  );
  process.exit(1);
}

console.log(`[validate-build-profile-markers] PASS: ${requiredMarkers.length} required build profile markers present`);
