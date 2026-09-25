#!/usr/bin/env node
/**
 * Parse the bounded build-profile payload persisted by deploy.yml.
 *
 * The build emits several similarly-prefixed phase markers. Match only the
 * exact `[phase-timing]` form so recap lines (`[phase-timing-top]`,
 * `[phase-timing-hook]`, `[phase-timing-total]`) cannot become duplicate rows.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const TOP_N = 25;
const PROFILE_RE = /^\[profile-detail\]\s+(.+?)\s+wall_s=(\d+(?:\.\d+)?)\s+cpu_s=(\d+(?:\.\d+)?)\s*$/u;
const PHASE_RE = /^\[phase-timing\]\s+(\S+)\s+(\d+(?:\.\d+)?)ms\s+calls=\d+\s*$/u;

function descendingBy(value) {
  const tieKey = value === 'wall_s' ? 'plugin' : 'marker';
  return (a, b) => b[value] - a[value]
    || (a[tieKey] === b[tieKey] ? 0 : a[tieKey] < b[tieKey] ? -1 : 1);
}

export function parseBuildProfileMarkers(log) {
  const profile = [];
  const phases = [];

  for (const line of String(log).split(/\r?\n/u)) {
    const profileMatch = PROFILE_RE.exec(line);
    if (profileMatch) {
      profile.push({
        plugin: profileMatch[1].trim(),
        wall_s: Number(profileMatch[2]),
        cpu_s: Number(profileMatch[3]),
      });
    }

    const phaseMatch = PHASE_RE.exec(line);
    if (phaseMatch) {
      phases.push({ marker: phaseMatch[1], ms: Number(phaseMatch[2]) });
    }
  }

  return {
    profile: profile.sort(descendingBy('wall_s')).slice(0, TOP_N),
    phases: phases.sort(descendingBy('ms')).slice(0, TOP_N),
  };
}

function selfTest() {
  const sample = [
    '[profile-detail] fast-plugin                            wall_s=0.50 cpu_s=0.75',
    '[profile-detail] slow-plugin                            wall_s=2.50 cpu_s=3.75',
    '[phase-timing] fast-plugin:transform                    5ms calls=2',
    '[phase-timing] slow-plugin:closeBundle                  2500ms calls=1',
    '[phase-timing-top]  1. slow-plugin:closeBundle          2.50s (99.0%)',
  ].join('\n');

  assert.deepEqual(parseBuildProfileMarkers(sample), {
    profile: [
      { plugin: 'slow-plugin', wall_s: 2.5, cpu_s: 3.75 },
      { plugin: 'fast-plugin', wall_s: 0.5, cpu_s: 0.75 },
    ],
    phases: [
      { marker: 'slow-plugin:closeBundle', ms: 2500 },
      { marker: 'fast-plugin:transform', ms: 5 },
    ],
  });

  const many = Array.from({ length: TOP_N + 1 }, (_, index) => [
    `[profile-detail] p${index} wall_s=${index}.00 cpu_s=${index + 1}.00`,
    `[phase-timing] p${index}:closeBundle ${index}ms calls=1`,
  ].join('\n')).join('\n');
  const bounded = parseBuildProfileMarkers(many);
  assert.equal(bounded.profile.length, TOP_N);
  assert.equal(bounded.profile[0].wall_s, TOP_N);
  assert.equal(bounded.phases.length, TOP_N);
  assert.equal(bounded.phases[0].ms, TOP_N);
  console.log(`[parse-build-profile-markers] self-test passed (top ${TOP_N})`);
}

const input = process.argv[2];
if (input === '--self-test') {
  selfTest();
} else {
  const logPath = input || '/tmp/build.log';
  if (!existsSync(logPath)) {
    console.error(`[parse-build-profile-markers] log not found at ${logPath}`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(parseBuildProfileMarkers(readFileSync(logPath, 'utf8'))));
}
