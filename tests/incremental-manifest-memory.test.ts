import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildMinimalJobInput,
  createIncrementalManifestInputCache,
  IncrementalManifest,
} from '../build-plugins/shared/incrementalManifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BENCHMARK = path.join(ROOT, 'scripts/dev/bench-incremental-manifest-memory.mjs');

describe('incremental manifest registration memory', () => {
  it('keeps retained heap below the 100k-record budget', { timeout: 60_000 }, () => {
    const output = execFileSync(process.execPath, ['--expose-gc', BENCHMARK, '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        INCREMENTAL_MANIFEST: '1',
        MANIFEST_BENCH_RECORDS: '100000',
      },
    });
    const report = JSON.parse(output.trim());
    expect(report.recordCount).toBe(100_000);
    expect(report.relatedPerRecord).toBe(30);
    expect(report.cacheStats.inputCache.relatedProjectionListsByKey).toEqual({ entries: 0, estimatedBytes: 0 });
    expect(report.heapMB.retained).toBeLessThanOrEqual(report.budget.maxRetainedHeapMB);
    expect(report.budget.margin).toBe('20% over the 100 MB target');
  });

  it('preserves JSONL lines, order, metadata, and footer with per-id projection reuse', () => {
    const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'incremental-manifest-memory-jsonl-'));
    const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'incremental-manifest-memory-jsonl-'));
    try {
      const related = [
        {
          id: 'related-1',
          slugByLocale: { de: 'fachkraft-1' },
          titleByLocale: { de: 'Fachkraft 1' },
          updatedAt: 'fixture-v1',
          company: 'Company',
          description: 'Beschreibung',
        },
      ];
      const build = (root: string, cache: ReturnType<typeof createIncrementalManifestInputCache> | null) => {
        const manifest = new IncrementalManifest('de');
        manifest.setJobsSeoEmitterFingerprint({ 'active-job': 'test-fingerprint' });
        for (const [index, id] of ['job-zeta', 'job-alfa', 'job-beta'].entries()) {
          const job = {
            id,
            slug: `${id}-slug`,
            title: `Role ${id}`,
            updatedAt: 'fixture-v1',
            titleByLocale: { de: `Role ${id}` },
          };
          const input = buildMinimalJobInput(job, 'de', `${id}-slug`, related, cache);
          manifest.register(`de/jobs-im-tessin/${id}-slug/`, 'active-job', input);
          if (index === 1) {
            manifest.register(`de/jobs-im-tessin/${id}-alias/`, 'legacy-slug-bridge', {
              ...input,
              bridgeType: 'locale-slug',
              sourcePath: `de/jobs-im-tessin/${id}-slug/`,
              targetPath: `de/jobs-im-tessin/${id}-alias/`,
            });
          }
        }
        return manifest.write(root);
      };

      const cachedFile = build(firstRoot, createIncrementalManifestInputCache());
      const uncachedFile = build(secondRoot, null);
      expect(fs.readFileSync(cachedFile, 'utf8')).toBe(fs.readFileSync(uncachedFile, 'utf8'));
      const lines = fs.readFileSync(cachedFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(lines.at(-1)).toMatchObject({
        type: 'footer',
        counts: {
          total: 4,
          byKind: {
            'active-job': 3,
            'legacy-slug-bridge': 1,
          },
        },
        jobsSeoEmitterFingerprint: { 'active-job': 'test-fingerprint' },
      });
    } finally {
      fs.rmSync(firstRoot, { recursive: true, force: true });
      fs.rmSync(secondRoot, { recursive: true, force: true });
    }
  });
});
