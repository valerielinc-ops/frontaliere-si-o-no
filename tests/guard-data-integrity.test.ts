import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Regression cover for #5524 (item 1): before the CLI guard, this module ran
// `main()` at import time (`process.exit(2)` with no argv, or a real `git`
// spawn otherwise) — importing it in a test executed it. No test could exist
// for the script that decides whether a data-truncation revert fires.

const execFileSync = vi.fn();
vi.mock('node:child_process', () => {
  const mock = { execFileSync: (...args: unknown[]) => execFileSync(...args) };
  return { ...mock, default: mock };
});

const gitCalls = () => execFileSync.mock.calls.map((c) => c[1] as string[]);

const isoDateFromToday = (offsetDays: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
};

function safeRewriteShards(date: string) {
  const previousShard = JSON.stringify({ entries: [{
    date,
    totalJobs: 10,
    added: 1,
    updated: 2,
    removed: 0,
    addedKeys: ['url:added'],
    updatedKeys: [],
    removedKeys: [],
    companyStats: [{
      key: 'company',
      name: 'Company',
      addedKeys: ['url:added'],
      updatedKeys: [],
      removedKeys: [],
      updatedCount: 2,
    }],
    locationStats: [{
      key: 'location',
      name: 'Location',
      addedKeys: [],
      updatedKeys: [],
      removedKeys: [],
      updatedCount: 2,
    }],
    titleStats: [{
      key: 'raw-title',
      name: 'Raw title',
      addedKeys: [],
      updatedKeys: [],
      removedKeys: [],
    }],
  }] });
  const nextShard = JSON.stringify({ entries: [{
    date,
    totalJobs: 10,
    added: 1,
    updated: 2,
    removed: 0,
    addedKeys: ['url:added'],
    updatedKeys: [],
    removedKeys: [],
    companyStats: [{
      key: 'company',
      name: 'Company',
      addedKeys: ['url:added'],
      updatedKeys: [],
      removedKeys: [],
      updatedCount: 2,
    }],
    locationStats: [{
      key: 'location',
      name: 'Location',
      addedKeys: [],
      updatedKeys: [],
      removedKeys: [],
      updatedCount: 2,
    }],
    titleStats: [{
      key: 'titolo-italiano',
      name: 'Titolo italiano',
      addedKeys: [],
      updatedKeys: [],
      removedKeys: [],
    }],
  }] });
  return { previousShard, nextShard };
}

beforeEach(() => {
  execFileSync.mockReset();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('guard-data-integrity — import-time safety', () => {
  it('importing the module does not spawn git or exit the process', async () => {
    await import('../scripts/ci/guard-data-integrity.mjs');
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('exports a callable main() distinct from the CLI entrypoint', async () => {
    const mod = await import('../scripts/ci/guard-data-integrity.mjs');
    expect(typeof mod.main).toBe('function');
  });
});

describe('guard-data-integrity — main() detects a catastrophic shrink', () => {
  const BEFORE = 'aaa0000';
  const AFTER = 'bbb1111';
  const BIG_FILE = 'data/seo-404-compat-paths.json';

  beforeEach(() => {
    process.argv[2] = BEFORE;
    process.argv[3] = AFTER;
  });

  afterEach(() => {
    process.argv.length = 2;
  });

  it('flags a >70% shrink on a >1MB file as a violation', async () => {
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'merge-base') return '';
      if (args[0] === 'diff') return `${BIG_FILE}\n`;
      if (args[0] === 'cat-file') {
        const ref = args[2].split(':')[0];
        return ref === BEFORE ? '2000000' : '100000'; // 95% shrink
      }
      return '';
    });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { main } = await import('../scripts/ci/guard-data-integrity.mjs');
    main();

    const written = writeSpy.mock.calls.map((c) => c[0]).join('');
    const violations = JSON.parse(written);
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe(BIG_FILE);
    writeSpy.mockRestore();
  });

  it('ignores a shrink under the byte floor (not an accumulator)', async () => {
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'merge-base') return '';
      if (args[0] === 'diff') return 'data/small.json\n';
      if (args[0] === 'cat-file') {
        const ref = args[2].split(':')[0];
        return ref === BEFORE ? '500000' : '1000'; // big % shrink, but small file
      }
      return '';
    });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { main } = await import('../scripts/ci/guard-data-integrity.mjs');
    main();

    const written = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(JSON.parse(written)).toEqual([]);
    writeSpy.mockRestore();
  });

  it('ignores a proven-safe historical job-stats locale rewrite', async () => {
    const historicalDate = isoDateFromToday(-2);
    const jobStatsFile = `data/jobs-stats-history/${historicalDate}.json`;
    const { previousShard, nextShard } = safeRewriteShards(historicalDate);

    process.argv[2] = BEFORE;
    process.argv[3] = AFTER;
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'merge-base') return '';
      if (args[0] === 'diff') return `${jobStatsFile}\n`;
      if (args[0] === 'cat-file' && args[1] === '-s') {
        const ref = args[2].split(':')[0];
        return ref === BEFORE ? '8451534' : '2086213';
      }
      if (args[0] === 'cat-file' && args[1] === 'blob') {
        const ref = args[2].split(':')[0];
        return ref === BEFORE ? previousShard : nextShard;
      }
      return '';
    });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { main } = await import('../scripts/ci/guard-data-integrity.mjs');
    main();

    const written = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(JSON.parse(written)).toEqual([]);
    writeSpy.mockRestore();
  });

  it('flags a proven-safe-looking rewrite of the current job-stats shard', async () => {
    const currentDate = isoDateFromToday(0);
    const jobStatsFile = `data/jobs-stats-history/${currentDate}.json`;
    const { previousShard, nextShard } = safeRewriteShards(currentDate);

    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'merge-base') return '';
      if (args[0] === 'diff') return `${jobStatsFile}\n`;
      if (args[0] === 'cat-file' && args[1] === '-s') {
        const ref = args[2].split(':')[0];
        return ref === BEFORE ? '8451534' : '2086213';
      }
      if (args[0] === 'cat-file' && args[1] === 'blob') {
        const ref = args[2].split(':')[0];
        return ref === BEFORE ? previousShard : nextShard;
      }
      return '';
    });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { main } = await import('../scripts/ci/guard-data-integrity.mjs');
    main();

    const written = writeSpy.mock.calls.map((c) => c[0]).join('');
    const violations = JSON.parse(written);
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe(jobStatsFile);
    writeSpy.mockRestore();
  });

  it('ignores the proven Swiss Re foreign-listing prune', async () => {
    const swissReFile = 'data/jobs/by-crawler/swiss-re.json';
    const previous = JSON.stringify([
      { url: 'https://jobs.swissre.com/bratislava', companyKey: 'swiss-re', location: 'Bratislava, SK' },
      { url: 'https://jobs.swissre.com/mexico-city', companyKey: 'swiss-re', location: 'Mexico City, MX' },
    ]);
    const next = JSON.stringify([
      { url: 'https://jobs.swissre.com/zurich', companyKey: 'swiss-re', location: 'Zurich, CH' },
    ]);

    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'merge-base') return '';
      if (args[0] === 'diff') return `${swissReFile}\n`;
      if (args[0] === 'cat-file' && args[1] === '-s') {
        const ref = args[2].split(':')[0];
        return ref === BEFORE ? '2000000' : '100000';
      }
      if (args[0] === 'cat-file' && args[1] === 'blob') {
        const ref = args[2].split(':')[0];
        return ref === BEFORE ? previous : next;
      }
      return '';
    });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { main } = await import('../scripts/ci/guard-data-integrity.mjs');
    main();

    const written = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(JSON.parse(written)).toEqual([]);
    writeSpy.mockRestore();
  });

  it('does not exempt an unsafe Swiss Re slice shrink', async () => {
    const swissReFile = 'data/jobs/by-crawler/swiss-re.json';
    const previous = JSON.stringify([
      { url: 'https://jobs.swissre.com/zurich-1', companyKey: 'swiss-re', location: 'Zurich, CH' },
      { url: 'https://jobs.swissre.com/zurich-2', companyKey: 'swiss-re', location: 'Zurich, CH' },
    ]);
    const next = JSON.stringify([
      { url: 'https://jobs.swissre.com/zurich-1', companyKey: 'swiss-re', location: 'Zurich, CH' },
    ]);

    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'merge-base') return '';
      if (args[0] === 'diff') return `${swissReFile}\n`;
      if (args[0] === 'cat-file' && args[1] === '-s') {
        const ref = args[2].split(':')[0];
        return ref === BEFORE ? '2000000' : '100000';
      }
      if (args[0] === 'cat-file' && args[1] === 'blob') {
        const ref = args[2].split(':')[0];
        return ref === BEFORE ? previous : next;
      }
      return '';
    });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { main } = await import('../scripts/ci/guard-data-integrity.mjs');
    main();

    const written = writeSpy.mock.calls.map((c) => c[0]).join('');
    const violations = JSON.parse(written);
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe(swissReFile);
    writeSpy.mockRestore();
  });
});
