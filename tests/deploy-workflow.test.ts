import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Guards for the parallel SEO audit-gate block in
 * .github/workflows/post-deploy-validate-dist.yml (gates were moved here from
 * deploy.yml in commit a2a7283f3c to avoid extending the critical deploy path)
 * and the tuned default flush concurrency in build-plugins/batchWrite.ts.
 *
 * These tests catch the most likely regression vectors:
 *   1) A new audit script is added to package.json but never wired into CI.
 *   2) A gate is moved out of the parallel block into a serial step (regressing
 *      validation time) without updating these assertions.
 *   3) The spawn_capped helper is replaced with serial execution.
 *   4) batchWrite default concurrency is downgraded below the tuned floor.
 */

const ROOT = resolve(import.meta.dirname, '..');
const VALIDATION_YML = readFileSync(resolve(ROOT, '.github/workflows/post-deploy-validate-dist.yml'), 'utf-8');
const PACKAGE_JSON = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
const BATCH_WRITE = readFileSync(resolve(ROOT, 'build-plugins/batchWrite.ts'), 'utf-8');

// `audit:title-uniqueness` was moved to a separate weekly workflow because it
// OOM-killed the parallel block (see commit history in
// post-deploy-validate-dist.yml). All remaining gates must stay in the parallel
// block.
const AUDIT_SCRIPTS_IN_PARALLEL_BLOCK = [
  'audit:hreflang',
  'audit:content-duplicates',
  'audit:page-weight',
  'audit:text-html-ratio',
  'audit:h1-title-duplicates',
  'audit:title-length',
] as const;

describe('post-deploy-validate-dist.yml — parallel SEO audit gates', () => {
  it('every gate in the parallel block is defined in package.json', () => {
    const scripts = PACKAGE_JSON.scripts || {};
    for (const name of AUDIT_SCRIPTS_IN_PARALLEL_BLOCK) {
      expect(scripts[name], `missing npm script "${name}" referenced by post-deploy-validate-dist.yml`).toBeDefined();
    }
  });

  it('every gate is invoked in post-deploy-validate-dist.yml', () => {
    for (const name of AUDIT_SCRIPTS_IN_PARALLEL_BLOCK) {
      const re = new RegExp(`npm run ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
      const matches = VALIDATION_YML.match(re) || [];
      expect(
        matches.length,
        `"${name}" should appear in post-deploy-validate-dist.yml; found ${matches.length}`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it('parallel block uses spawn_capped for background execution', () => {
    expect(
      VALIDATION_YML,
      'spawn_capped helper missing from post-deploy-validate-dist.yml — parallel execution regressed',
    ).toContain('spawn_capped()');
  });

  it('any new audit:* script added to package.json must be wired into post-deploy-validate-dist.yml', () => {
    // Gates intentionally NOT in the dist-validate parallel block:
    // - `:rebaseline` variants mutate the checked-in baseline; never CI.
    // - `audit:title-uniqueness` runs on a separate weekly workflow because it
    //   OOM-killed the parallel block.
    // - `audit:dist-multi*` are aggregators that call other audits — adding
    //   them would double-run every gate they wrap.
    // - `audit:faqpage-validity` runs from scripts/lib/post-build-tasks.sh on
    //   the build job itself (not post-deploy).
    // - `audit:parser-quality` is a developer self-test, not gated in CI.
    const GATES_NOT_IN_DIST_PARALLEL = new Set([
      'audit:title-uniqueness',
      'audit:dist-multi',
      'audit:faqpage-validity',
      'audit:parser-quality',
    ]);
    const allAuditScripts = Object.keys(PACKAGE_JSON.scripts || {}).filter((k) => {
      return /^audit:/.test(k) && !/:rebaseline$/.test(k) && !GATES_NOT_IN_DIST_PARALLEL.has(k);
    });
    for (const name of allAuditScripts) {
      expect(
        VALIDATION_YML.includes(`npm run ${name}`),
        `package.json defines "${name}" but post-deploy-validate-dist.yml never invokes it — gate would never run`,
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
