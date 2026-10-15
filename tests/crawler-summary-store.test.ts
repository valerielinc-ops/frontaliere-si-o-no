import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  containsMergeConflictMarkers,
  createEmptyCrawlerSummaryStore,
  ensureLegacyPublicCrawlerSummaryCopyAbsent,
  parseCrawlerSummaryStoreText,
  readCrawlerSummaryStore,
  resolveLegacyPublicCrawlerSummaryPath,
  writeCrawlerSummaryStore,
} from '../scripts/lib/crawler-summary-store.mjs';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ft-crawler-summary-store-'));
}

describe('crawler summary store', () => {
  it('rejects git merge conflict markers before JSON parsing', () => {
    const conflicted = [
      '{',
      '<<<<<<< Updated upstream',
      '  "updatedAt": "2026-03-16T12:00:00.000Z",',
      '=======',
      '  "updatedAt": "2026-03-16T12:05:00.000Z",',
      '>>>>>>> Stashed changes',
      '}',
    ].join('\n');

    expect(containsMergeConflictMarkers(conflicted)).toBe(true);
    expect(() => parseCrawlerSummaryStoreText(conflicted, 'fixture')).toThrow(/merge conflict markers/i);
  });

  it('returns an empty store when the canonical file is missing and allowMissing is true', () => {
    const tempDir = makeTempDir();
    const missingPath = path.join(tempDir, 'data', 'jobs-crawler-summaries.json');

    expect(readCrawlerSummaryStore(missingPath, { allowMissing: true })).toEqual(createEmptyCrawlerSummaryStore());
  });

  it('writes and reads a valid canonical summary store', () => {
    const tempDir = makeTempDir();
    const canonicalPath = path.join(tempDir, 'data', 'jobs-crawler-summaries.json');
    const payload = {
      updatedAt: '2026-03-16T13:00:00.000Z',
      summaries: [
        {
          key: 'relewant',
          label: 'ReleWant',
          generatedAt: '2026-03-16T13:00:00.000Z',
          unchangedCount: 19,
          newJobs: [],
        },
      ],
    };

    writeCrawlerSummaryStore(canonicalPath, payload);

    expect(readCrawlerSummaryStore(canonicalPath)).toEqual(payload);
  });

  it('fails when the deprecated public summary copy is still present', () => {
    const tempDir = makeTempDir();
    const legacyPath = resolveLegacyPublicCrawlerSummaryPath(tempDir);

    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, '{}\n', 'utf8');

    expect(() => ensureLegacyPublicCrawlerSummaryCopyAbsent(tempDir)).toThrow(/must not exist anymore/i);
  });
});
