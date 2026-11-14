import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { iterateJsonArrayFile, parseLargeJsonArray, readJsonFile } from '../scripts/lib/read-large-json.mjs';

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

  it('iterates a large top-level array without retaining the array container', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iterate-large-json-'));
    const target = path.join(dir, 'jobs.json');
    const rows = [{ id: 1, title: 'café' }, { id: 2, nested: { ok: true } }];

    try {
      fs.writeFileSync(target, JSON.stringify(rows), 'utf8');
      // The iterator defaults to the item-wise path even for a small file:
      // callers use it specifically when the complete parsed array must not
      // overlap another build phase's retained corpus.
      expect([...iterateJsonArrayFile(target)]).toEqual(rows);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('iterates a jobs wrapper without retaining the wrapper or jobs array', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iterate-large-json-wrapper-'));
    const target = path.join(dir, 'jobs.json');
    const payload = {
      generatedAt: '2026-11-03T00:00:00.000Z',
      jobs: [{ id: 'x', title: 'café' }, { id: 'y', nested: { ok: true } }],
    };

    try {
      fs.writeFileSync(target, JSON.stringify(payload), 'utf8');
      expect([...iterateJsonArrayFile(target)]).toEqual(payload.jobs);
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
  const streamingReaders = [
    'build-plugins/jobBoardSeo.ts',
    'build-plugins/localeJobsSplitPlugin.ts',
    'build-plugins/shared/autoSectorHubPublicationData.ts',
    'build-plugins/staticPagesPlugin.ts',
    'build-plugins/weeklyEmployersPlugin.ts',
    'build-plugins/orphanQueryLandingPlugin.ts',
  ];
  const readers = [
    'build-plugins/careerJobsAggregate.ts',
    'build-plugins/cityJobsAggregate.ts',
    'build-plugins/jobMarketSnapshotPlugin.ts',
    'build-plugins/jobRecencyPagesPlugin.ts',
    'build-plugins/jobSectorPagesPlugin.ts',
    'build-plugins/jobsSeoPagesPlugin.ts',
    'build-plugins/companyHubBridgePlugin.ts',
    'build-plugins/jobOgImagesPlugin.ts',
    'build-plugins/nursingJobsAggregate.ts',
    'build-plugins/professionJobsAggregate.ts',
    'build-plugins/relatedSearchClustersPlugin.ts',
    'build-plugins/shared/loadDataJson.ts',
    'build-plugins/shared/reportJobPanel.ts',
    'scripts/build-employer-profiles.mjs',
    'scripts/audit-related-search-candidates.mjs',
    'scripts/migrate-all-known-job-slugs-canton-aware.mjs',
    'scripts/migrate-previous-slug-winners-add-canton.mjs',
    'scripts/migrate-slug-registry-add-canton.mjs',
    'scripts/monitor-sector-coverage.mjs',
    'scripts/refresh-weekly-employers-top-pairs.mjs',
    'scripts/snapshot-jobs-weekly.mjs',
    'scripts/sync-employer-contacts-to-firestore.mjs',
    // deploy prep (deploy 43171223798 died here after the build readers were fixed)
    'scripts/migrate-all-known-job-slugs-canton-aware.mjs',
    'scripts/migrate-slug-registry-add-canton.mjs',
    'scripts/migrate-previous-slug-winners-add-canton.mjs',
    'scripts/refresh-weekly-employers-top-pairs.mjs',
    'scripts/cleanup-jobs.mjs',
    'scripts/ci/prepare-job-og-cache-prewarm.ts',
    'scripts/send-job-alerts.mjs',
    'scripts/build-employer-insights.mjs',
    'scripts/backfill-bullet-normalization.mjs',
    'scripts/backfill-newsletter-job-context.mjs',
    'scripts/cleanup-redundant-previous-slugs.mjs',
    'scripts/discover-sector-hub-candidates.ts',
    'scripts/download-missing-company-logos.mjs',
    'scripts/enrich-compat-orphan-slugs.mjs',
    'scripts/flag-wrong-locale-descriptions.mjs',
    'scripts/generate-job-board-stats.mjs',
    'scripts/generate-health-facilities-jobs.mjs',
    'scripts/localize-vf-existing-jobs.mjs',
    'scripts/publish-jobs-fast.mjs',
    'scripts/profile-cluster-emission.mjs',
    'scripts/re-enrich-jobs.mjs',
    'scripts/re-localize-jobs.mjs',
    'scripts/reconcile-job-slugs.mjs',
    'scripts/repair-job-locales.mjs',
    'scripts/refresh-jobposting-address-cache.mjs',
    'scripts/scatter-jobs-to-slices.mjs',
    'scripts/post-to-telegram.mjs',
    'scripts/schedule-fb-jobs-daily.mjs',
    'scripts/schedule-reddit-jobs-daily.mjs',
    'scripts/validate-jobs-rich-results-sample.mjs',
    'scripts/lib/company-logo-audit.mjs',
    'scripts/lib/crawler-run-jobs.mjs',
    'scripts/lib/llms-txt-generator.mjs',
    'scripts/lib/shared-jobs-crawler.mjs',
    'scripts/lib/social-post-utils.mjs',
    'scripts/relocalize-pending-jobs.mjs',
  ];
  const wholeFileRead = /readFileSync\(\s*(jobsPath|abs|JOBS_PATH|DATA_JOBS|DATA_JOBS_PATH|EXPIRED_JOBS_PATH|np\.resolve\(rootDir, 'data\/jobs\.json'\)|path\.join\(rootDir, 'data\/jobs\.json'\))\s*,\s*'utf-?8'\s*\)/;

  // Deploy 43181176266 died in localeJobsSplitPlugin (`dataJobsPath`), a name
  // the per-file list above did not know. Scan every build plugin instead:
  // any JSON.parse of a whole jobs/expired-jobs file is a build-breaker once
  // the corpus crosses 512 MB, or silently empties pages where errors are caught.
  it('no build plugin parses a whole jobs or expired-jobs file', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (/\.(ts|mjs|js)$/.test(entry.name)) {
          const src = fs.readFileSync(abs, 'utf8');
          const rx = /JSON\.parse\(\s*(?:fs\.)?readFileSync\(\s*([^,()]*(?:[Jj]obs(?:Path|File|_PATH|JSON)?|[Ee]xpired[A-Za-z]*Path)[^,()]*|[^()]*'data\/(?:expired-)?jobs\.json'\))\s*,/g;
          for (const m of src.matchAll(rx)) offenders.push(`${path.relative(root, abs)}: ${m[1]}`);
        }
      }
    };
    walk(path.join(root, 'build-plugins'));
    expect(offenders).toEqual([]);
  });

  it('keeps memory-sensitive build readers on the item-wise iterator', () => {
    for (const rel of streamingReaders) {
      const src = fs.readFileSync(path.join(root, rel), 'utf8');
      expect(src).toContain('import { iterateJsonArrayFile } from ');
      expect(src).toContain('read-large-json.mjs');
      expect(src).toContain('iterateJsonArrayFile(');
      expect(src).not.toContain('readJsonFile(');
    }
  });

  it('keeps the iterator streaming by default even below the V8 string limit', () => {
    const src = fs.readFileSync(path.join(root, 'scripts/lib/read-large-json.mjs'), 'utf8');
    expect(src).toContain('{ maxInlineBytes = 0, maxItemBytes = DEFAULT_JSON_STRING_LIMIT }');
  });

  it.each(readers)('%s reads the corpus through readJsonFile', (rel) => {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    expect(src).toMatch(/import \{ readJsonFile \} from ['"](\.\.?\/)+(scripts\/)?(lib\/)?read-large-json\.mjs['"];?/);
    expect(src).toMatch(/readJsonFile\(/);
    expect(src).not.toMatch(wholeFileRead);
  });

  it('keeps git-commit-data job JSON reads on the large-file reader', () => {
    const src = fs.readFileSync(path.join(root, 'scripts/lib/git-commit-data.sh'), 'utf8');
    expect(src).toMatch(/import \{ readJsonFile \} from '\.\/scripts\/lib\/read-large-json\.mjs';/);
    expect(src).toMatch(/const jobs\s*=\s*readJsonFile\(filePath\)/);
    expect(src).toMatch(/jobs\s*=\s*readJsonFile\(dataJobsPath\)/);
    expect(src).toMatch(/const value\s*=\s*readJsonFile\(file\)/);
  });

  it('keeps dedicated DATA_JOBS readers on the large-file reader', () => {
    const scriptsDir = path.join(root, 'scripts');
    const offenders: string[] = [];
    for (const entry of fs.readdirSync(scriptsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/^update-.*-jobs\.mjs$/.test(entry.name)) continue;
      const rel = path.join('scripts', entry.name);
      const src = fs.readFileSync(path.join(root, rel), 'utf8');
      if (!src.includes('DATA_JOBS')) continue;
      if (!/JSON\.parse\(\s*(?:fs\.)?readFileSync\(\s*DATA_JOBS|readJson\(\s*DATA_JOBS/.test(src)) continue;
      expect(src, rel).toMatch(/import \{ readJsonFile \} from '\.\/lib\/read-large-json\.mjs';/);
      if (/JSON\.parse\(\s*(?:fs\.)?readFileSync\(\s*DATA_JOBS/.test(src)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
