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

// ── Memory headroom ───────────────────────────────────────────────────────
// An OOM on a hosted runner arrives as a bare SIGTERM: "The runner has received
// a shutdown signal", exit 143, and nothing about memory. Run 30884117744 died
// that way with RSS at 12655 MB on a 16 GB runner, and the only way to see it
// coming was to parse `[profile-mem]` lines by hand afterwards.
//
// This reports the peak so it is in every build log, and warns while the build
// still SUCCEEDS — the point is to see the trend before the kill, not to fail a
// build that worked. It never fails the run: a memory ceiling that turns a
// green build red would just be a second way to lose a deploy.
const memLines = [...log.matchAll(/\[profile-mem\]\s+(\S+)\s+rss_mb=(\d+)\s+heapUsed_mb=(\d+)\s+heapTotal_mb=(\d+)/g)];
if (memLines.length > 0) {
  let peak = { step: '?', rss: 0, heapUsed: 0, heapTotal: 0 };
  for (const [, step, rss, heapUsed, heapTotal] of memLines) {
    if (Number(rss) > peak.rss) peak = { step, rss: Number(rss), heapUsed: Number(heapUsed), heapTotal: Number(heapTotal) };
  }
  // Clamped: RSS below heapTotal means V8 has reserved pages the OS has not
  // faulted in, and a negative 'non-heap' would read as a parse bug.
  const nonHeap = Math.max(0, peak.rss - peak.heapTotal);
  console.log(
    `[validate-build-profile-markers] peak RSS ${peak.rss} MB at ${peak.step} ` +
    `(heapUsed ${peak.heapUsed}, heapTotal ${peak.heapTotal}, non-heap ~${nonHeap} MB)`,
  );
  // 11 GB on a 16 GB runner: past this the margin for the OS and the runner
  // agent is thin enough that a slightly larger corpus tips it over.
  if (peak.rss > 11_000) {
    console.warn(
      `::warning::build peak RSS ${peak.rss} MB is within ~5 GB of a 16 GB runner — ` +
      'the previous OOM (run 30884117744) died at 12655 MB. Check MALLOC_ARENA_MAX ' +
      'and --max-old-space-size in build:ci before adding build-time page families.',
    );
  }
}
