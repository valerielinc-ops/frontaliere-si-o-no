import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLargeJsonArray, readJsonFile } from '../scripts/lib/read-large-json.mjs';

describe('large JSON reader', () => {
  it('parses nested records when chunks split strings and objects', () => {
    const chunks = [
      '[{"id":1,"title":"caf',
      'é ","nested":{"ok":true}},',
      '{"id":2,"items":[1,{"value":"x"}]}]',
    ];

    expect(parseLargeJsonArray(chunks)).toEqual([
      { id: 1, title: 'café ', nested: { ok: true } },
      { id: 2, items: [1, { value: 'x' }] },
    ]);
  });

  it('switches to item-wise parsing before the inline threshold', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-large-json-'));
    const target = path.join(dir, 'jobs.json');
    const rows = [{ id: 1, title: 'café', description: 'a'.repeat(64) }, { id: 2, description: 'b'.repeat(64) }];

    try {
      fs.writeFileSync(target, JSON.stringify(rows), 'utf8');
      expect(readJsonFile(target, { maxInlineBytes: 1 })).toEqual(rows);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses a record larger than one read chunk without per-character buffering', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-large-json-record-'));
    const target = path.join(dir, 'jobs.json');
    const payload = [{ id: 'large', description: 'x'.repeat(2 * 1024 * 1024) }];

    try {
      fs.writeFileSync(target, JSON.stringify(payload), 'utf8');
      expect(readJsonFile(target, { maxInlineBytes: 1 })).toEqual(payload);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('streams the supported jobs wrapper when it crosses the inline threshold', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-large-json-wrapper-'));
    const target = path.join(dir, 'jobs.json');
    const payload = {
      generatedAt: '2026-11-03T00:00:00.000Z',
      jobs: [{ id: 'x', title: 'café', description: 'a'.repeat(64) }],
    };

    try {
      fs.writeFileSync(target, JSON.stringify(payload), 'utf8');
      expect(readJsonFile(target, { maxInlineBytes: 1 })).toEqual(payload);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a large root object instead of silently returning partial data', () => {
    expect(() => parseLargeJsonArray(['{"jobs":[]}'])).toThrow(/top-level array/);
  });

  it.each(['[,{}]', '[{},]', '[{},,{}]', '[{}{}]'])('rejects invalid separators: %s', (input) => {
    expect(() => parseLargeJsonArray([input])).toThrow();
  });
});

// data/jobs.json crossed V8's 512 MB string limit on 2026-11-12. Build and prep
// readers that swallow parse errors can silently emit empty data, so every
// reader of the assembled corpus in these paths goes through readJsonFile.
describe('data/jobs.json readers', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const readers = [
    'build-plugins/careerJobsAggregate.ts',
    'build-plugins/cityJobsAggregate.ts',
    'build-plugins/jobMarketSnapshotPlugin.ts',
    'build-plugins/jobRecencyPagesPlugin.ts',
    'build-plugins/jobSectorPagesPlugin.ts',
    'build-plugins/jobsSeoPagesPlugin.ts',
    'build-plugins/nursingJobsAggregate.ts',
    'build-plugins/professionJobsAggregate.ts',
    'build-plugins/relatedSearchClustersPlugin.ts',
    'build-plugins/shared/loadDataJson.ts',
    'build-plugins/shared/reportJobPanel.ts',
    'build-plugins/staticPagesPlugin.ts',
    'scripts/build-employer-profiles.mjs',
    'scripts/migrate-all-known-job-slugs-canton-aware.mjs',
    'scripts/refresh-weekly-employers-top-pairs.mjs',
    'scripts/sync-employer-contacts-to-firestore.mjs',
    // deploy prep (deploy 43171223798 died here after the build readers were fixed)
    'scripts/migrate-all-known-job-slugs-canton-aware.mjs',
    'scripts/migrate-slug-registry-add-canton.mjs',
    'scripts/migrate-previous-slug-winners-add-canton.mjs',
    'scripts/refresh-weekly-employers-top-pairs.mjs',
    'scripts/cleanup-jobs.mjs',
    'scripts/ci/prepare-job-og-cache-prewarm.ts',
    'scripts/send-job-alerts.mjs',
  ];
  const wholeFileRead = /readFileSync\(\s*(jobsPath|abs|JOBS_PATH|DATA_JOBS|DATA_JOBS_PATH|EXPIRED_JOBS_PATH|np\.resolve\(rootDir, 'data\/jobs\.json'\)|path\.join\(rootDir, 'data\/jobs\.json'\))\s*,\s*'utf-?8'\s*\)/;

  it.each(readers)('%s reads the corpus through readJsonFile', (rel) => {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    expect(src).toMatch(/import \{ readJsonFile \} from '(\.\.?\/)+(scripts\/)?lib\/read-large-json\.mjs';/);
    expect(src).toMatch(/readJsonFile\(/);
    expect(src).not.toMatch(wholeFileRead);
  });
});
