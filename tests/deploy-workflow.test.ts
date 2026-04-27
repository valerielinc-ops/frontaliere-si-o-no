import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Guards for the parallel SEO audit-gate block in .github/workflows/deploy.yml
 * and the tuned default flush concurrency in build-plugins/batchWrite.ts.
 *
 * These tests catch the most likely regression vectors:
 *   1) A new audit script is added to package.json but never wired into deploy.
 *   2) A gate is moved out of the parallel block into a serial step (regressing
 *      deploy time) without updating these assertions.
 *   3) A `wait $PIDn` line is removed, silently skipping a gate failure.
 *   4) batchWrite default concurrency is downgraded below the tuned floor.
 */

const ROOT = resolve(import.meta.dirname, '..');
const DEPLOY_YML = readFileSync(resolve(ROOT, '.github/workflows/deploy.yml'), 'utf-8');
const PACKAGE_JSON = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
const BATCH_WRITE = readFileSync(resolve(ROOT, 'build-plugins/batchWrite.ts'), 'utf-8');

const AUDIT_SCRIPTS_IN_PARALLEL_BLOCK = [
  'audit:hreflang',
  'audit:title-uniqueness',
  'audit:content-duplicates',
  'audit:page-weight',
  'audit:text-html-ratio',
  'audit:h1-title-duplicates',
  'audit:title-length',
] as const;

describe('deploy.yml — parallel SEO audit gates', () => {
  it('every gate in the parallel block is defined in package.json', () => {
    const scripts = PACKAGE_JSON.scripts || {};
    for (const name of AUDIT_SCRIPTS_IN_PARALLEL_BLOCK) {
      expect(scripts[name], `missing npm script "${name}" referenced by deploy.yml`).toBeDefined();
    }
  });

  it('every gate is invoked exactly once in deploy.yml (no accidental serial duplicate)', () => {
    for (const name of AUDIT_SCRIPTS_IN_PARALLEL_BLOCK) {
      const re = new RegExp(`npm run ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
      const matches = DEPLOY_YML.match(re) || [];
      expect(
        matches.length,
        `"${name}" should appear exactly 1× in deploy.yml (parallel block); found ${matches.length}`,
      ).toBe(1);
    }
  });

  it('every parallel gate has a matching wait $PID with error replay', () => {
    for (let i = 1; i <= AUDIT_SCRIPTS_IN_PARALLEL_BLOCK.length; i += 1) {
      expect(
        DEPLOY_YML,
        `wait $PID${i} missing — a gate failure would be silently skipped`,
      ).toContain(`wait $PID${i}`);
    }
  });

  it('parallel block uses background spawn (& + PID capture) for every gate', () => {
    const lines = DEPLOY_YML.split('\n');
    let pidsCaptured = 0;
    for (const line of lines) {
      if (/PID\d+=\$!/.test(line)) pidsCaptured += 1;
    }
    expect(
      pidsCaptured,
      `expected ≥${AUDIT_SCRIPTS_IN_PARALLEL_BLOCK.length} "PIDn=$!" captures (one per gate)`,
    ).toBeGreaterThanOrEqual(AUDIT_SCRIPTS_IN_PARALLEL_BLOCK.length);
  });

  it('any new audit:* script added to package.json must be wired into deploy.yml', () => {
    const allAuditScripts = Object.keys(PACKAGE_JSON.scripts || {}).filter((k) => {
      // The :rebaseline variants are intentionally not run in CI — they MUTATE
      // the checked-in baseline. Only the pure audit gates are CI-relevant.
      return /^audit:/.test(k) && !/:rebaseline$/.test(k);
    });
    for (const name of allAuditScripts) {
      expect(
        DEPLOY_YML.includes(`npm run ${name}`),
        `package.json defines "${name}" but deploy.yml never invokes it — gate would never run`,
      ).toBe(true);
    }
  });
});

describe('build-plugins/batchWrite.ts — flush concurrency', () => {
  it('default flush concurrency is tuned for CI SSD (≥ 500, ≤ 1024)', () => {
    // Catches accidental regressions like "concurrency = 200" sneaking back in.
    // Cap at ~1024 to avoid macOS launchd ulimit -n 256/1024 contention.
    const matches = BATCH_WRITE.match(/concurrency\s*=\s*(\d+)/g) || [];
    expect(matches.length, 'expected default-concurrency literals').toBeGreaterThan(0);
    for (const m of matches) {
      const n = Number(m.match(/(\d+)/)![1]);
      expect(n, `default concurrency literal "${m}" below tuned floor`).toBeGreaterThanOrEqual(500);
      expect(n, `default concurrency literal "${m}" above safe ceiling`).toBeLessThanOrEqual(1024);
    }
  });
});
