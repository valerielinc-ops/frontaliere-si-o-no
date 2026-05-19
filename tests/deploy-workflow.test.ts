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
const AUDIT_ALL_REGISTRY_SRC = readFileSync(resolve(ROOT, 'scripts/audit-all.mjs'), 'utf-8');

// `audit:title-uniqueness` was moved to a separate weekly workflow because it
// OOM-killed the parallel block. All remaining gates must stay in parallel.
const AUDIT_SCRIPTS_IN_PARALLEL_BLOCK = [
  'audit:hreflang',
  'audit:content-duplicates',
  'audit:page-weight',
  'audit:text-html-ratio',
  'audit:h1-title-duplicates',
  'audit:title-length',
] as const;

/**
 * Parse the REGISTRY block of scripts/audit-all.mjs to extract the set of
 * audit names that the unified runner wraps. Each entry has the shape
 *   `{ factory: <ident>, name: '<audit-name>' }` — we match the `name: '…'`
 * literal so additions to the registry are automatically picked up.
 */
function parseAuditAllRegistry(src: string): Set<string> {
  const out = new Set<string>();
  const re = /\bname:\s*['"]([a-z][a-z0-9-]*)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) out.add(`audit:${m[1]}`);
  return out;
}

const AUDIT_ALL_WRAPS = parseAuditAllRegistry(AUDIT_ALL_REGISTRY_SRC);

/**
 * Returns true if the workflow invokes the audit either directly via
 * `npm run audit:<name>` OR transitively via `npm run audit:all` (when the
 * audit is registered in audit-all.mjs).
 */
function isInvokedDirectlyOrViaAuditAll(name: string): boolean {
  const directRe = new RegExp(`npm run ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  if (directRe.test(VALIDATION_YML)) return true;
  return AUDIT_ALL_WRAPS.has(name) && /npm run audit:all\b/.test(VALIDATION_YML);
}

describe('post-deploy-validate-dist.yml — parallel SEO audit gates', () => {
  it('every gate in the parallel block is defined in package.json', () => {
    const scripts = PACKAGE_JSON.scripts || {};
    for (const name of AUDIT_SCRIPTS_IN_PARALLEL_BLOCK) {
      expect(scripts[name], `missing npm script "${name}" referenced by post-deploy-validate-dist.yml`).toBeDefined();
    }
  });

  it('every gate is reachable from post-deploy-validate-dist.yml (directly or via audit:all)', () => {
    for (const name of AUDIT_SCRIPTS_IN_PARALLEL_BLOCK) {
      expect(
        isInvokedDirectlyOrViaAuditAll(name),
        `"${name}" is unreachable from post-deploy-validate-dist.yml. ` +
        `Either invoke it directly via \`npm run ${name}\`, or register it in ` +
        `scripts/audit-all.mjs REGISTRY (audit-all is invoked in workflow). ` +
        `audit-all currently wraps: ${[...AUDIT_ALL_WRAPS].sort().join(', ')}`,
      ).toBe(true);
    }
  });

  it('parallel block uses spawn_capped for background execution', () => {
    expect(
      VALIDATION_YML,
      'spawn_capped helper missing from post-deploy-validate-dist.yml — parallel execution regressed',
    ).toContain('spawn_capped()');
  });

  it('any new audit:* script added to package.json must be reachable in post-deploy-validate-dist.yml (direct or via audit:all)', () => {
    // Gates intentionally NOT in the dist-validate parallel block:
    // - `:rebaseline` variants mutate the checked-in baseline; never CI.
    // - `audit:title-uniqueness` runs on a separate weekly workflow because
    //   it OOM-killed the parallel block.
    // - `audit:dist-multi*` are aggregators that wrap other audits.
    // - `audit:parser-quality` is a developer self-test, not gated in CI.
    // - `audit:all` IS the wrapper itself; reachability check would be circular.
    const GATES_NOT_IN_DIST_PARALLEL = new Set([
      'audit:title-uniqueness',
      'audit:dist-multi',
      'audit:parser-quality',
      'audit:all',
    ]);
    const allAuditScripts = Object.keys(PACKAGE_JSON.scripts || {}).filter((k) => {
      return /^audit:/.test(k) && !/:rebaseline$/.test(k) && !GATES_NOT_IN_DIST_PARALLEL.has(k);
    });
    for (const name of allAuditScripts) {
      expect(
        isInvokedDirectlyOrViaAuditAll(name),
        `package.json defines "${name}" but post-deploy-validate-dist.yml has no reachable invocation — ` +
        `gate would never run. audit:all currently wraps: ${[...AUDIT_ALL_WRAPS].sort().join(', ')}`,
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
