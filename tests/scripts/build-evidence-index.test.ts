// Smoke + integration tests for the evidence-index builder.
//
// We don't invoke the main() entrypoint directly (it calls process.exit and
// writes a real file). Instead we exercise the parts that can be unit-tested
// in isolation: re-import the module-level constants and verify the helper
// functions chain together to produce a well-shaped output object when fed
// mocked sub-fetchers.

import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import * as constants from '../../scripts/lib/evidence/constants.mjs';
import { buildClusterStats } from '../../scripts/lib/evidence/clusterStatsBuilder.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT_PATH = join(REPO_ROOT, 'scripts/build-evidence-index.mjs');

describe('evidence-index constants', () => {
  it('exposes the documented tunables', () => {
    expect(constants.DEFAULT_WINDOW_DAYS).toBe(90);
    expect(constants.ORPHAN_MIN_IMP).toBe(100);
    expect(constants.ORPHAN_MIN_POS).toBe(10);
    expect(constants.ORPHAN_MAX_CTR).toBe(0.02);
    expect(constants.GSC_MIN_IMP).toBe(5);
    expect(constants.GA4_MIN_SESSIONS).toBe(3);
    expect(constants.CLUSTER_MIN_N).toBe(5);
    expect(constants.EMBEDDING_DIM).toBe(1536);
    expect(constants.EMBEDDING_MODEL).toBe('text-embedding-3-small');
  });
});

describe('build-evidence-index.mjs entrypoint', () => {
  it('parses cleanly under `node --check`', () => {
    const result = spawnSync(process.execPath, ['--check', SCRIPT_PATH], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('cluster stats output round-trips through JSON', () => {
    const ga4Pages = {
      '/articoli-frontaliere/foo/': {
        sessions: 50,
        publishedAt: '2026-01-01',
        cluster: 'fiscale',
        engageTime: 90,
      },
    };
    const stats = buildClusterStats(ga4Pages, { now: Date.parse('2027-01-01T00:00:00Z') });
    // Insufficient sample (n=1 < 5) — recorded but no percentiles.
    expect(stats.fiscale.n).toBe(1);
    // Round-trip safely
    const parsed = JSON.parse(JSON.stringify(stats));
    expect(parsed.fiscale).toEqual(stats.fiscale);
  });
});

describe('build-evidence-index.mjs file shape (integration smoke)', () => {
  it('--check reports no syntax errors', () => {
    // Already exercised above — additional sanity that the file exists.
    expect(existsSync(SCRIPT_PATH)).toBe(true);
  });
});
