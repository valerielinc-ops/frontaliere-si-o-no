import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSync = vi.fn();
vi.mock('node:child_process', () => {
  const mock = { execFileSync: (...args: unknown[]) => execFileSync(...args) };
  return { ...mock, default: mock };
});

const {
  COVERAGE_GAP_ISSUE_KEY,
  DUPLICATE_ISSUE_KEY,
  STALE_SNAPSHOT_ISSUE_KEY,
  duplicateIssue,
  gapIssue,
  staleSnapshotIssue,
} = await import('../scripts/audit-duplicate-crawler-companies.mjs');
const { createGithubIssue } = await import('../scripts/lib/github-issue-creator.mjs');

function duplicatePairs(count: number): { keys: [string, string]; shared: string[] }[] {
  return Array.from({ length: count }, (_, index) => ({
    keys: [`keeper-${index}`, `witness-${index}`] as [string, string],
    shared: [`https://jobs.example/${index}`],
  }));
}

function coverageGaps(count: number) {
  return [{
    key: 'keeper',
    twin: 'witness',
    missing: Array.from({ length: count }, (_, index) => `https://jobs.example/${index}`),
  }];
}

function staleSnapshots(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    key: `witness-${index}`,
    twin: `keeper-${index}`,
    assembledAtMs: Date.now() - (72 + index) * 60 * 60 * 1000,
    ageMs: (72 + index) * 60 * 60 * 1000,
    maskedMissing: [`https://jobs.example/${index}`],
  }));
}

function ghCalls(): string[][] {
  return execFileSync.mock.calls
    .filter((call) => call[0] === 'gh')
    .map((call) => call[1] as string[]);
}

beforeEach(() => {
  execFileSync.mockReset();
  delete process.env.GH_REPO;
});

describe.each([
  {
    family: 'duplicate identity',
    issueNumber: 6759,
    key: DUPLICATE_ISSUE_KEY,
    olderLegacyTitle: '[duplicate-crawler] 21 coppie di crawler pubblicano le stesse vacancy sotto companyKey diverse',
    legacyTitle: '[duplicate-crawler] 18 coppie di crawler pubblicano le stesse vacancy sotto companyKey diverse',
    first: () => duplicateIssue(duplicatePairs(18)),
    second: () => duplicateIssue(duplicatePairs(17)),
    firstCount: '18 coppie di crawler',
    secondCount: '17 coppie di crawler',
  },
  {
    family: 'coverage gap',
    issueNumber: 6760,
    key: COVERAGE_GAP_ISSUE_KEY,
    olderLegacyTitle: '[crawler-coverage-gap] 160 vacancy viste da un crawler gemello e assenti dal crawler principale',
    legacyTitle: '[crawler-coverage-gap] 16 vacancy viste da un crawler gemello e assenti dal crawler principale',
    first: () => gapIssue(coverageGaps(16)),
    second: () => gapIssue(coverageGaps(6)),
    firstCount: '16 vacancy',
    secondCount: '6 vacancy',
  },
  {
    family: 'stale crawler snapshot',
    issueNumber: 6873,
    key: STALE_SNAPSHOT_ISSUE_KEY,
    olderLegacyTitle: '[crawler-snapshot-stale] 7 crawler witness senza snapshot aggiornato',
    legacyTitle: '[crawler-snapshot-stale] 3 crawler witness senza snapshot aggiornato',
    first: () => staleSnapshotIssue(staleSnapshots(3)),
    second: () => staleSnapshotIssue(staleSnapshots(2)),
    firstCount: '3 witness stale',
    secondCount: '2 witness stale',
  },
])('$family issue reporting', ({
  issueNumber,
  key,
  olderLegacyTitle,
  legacyTitle,
  first,
  second,
  firstCount,
  secondCount,
}) => {
  it('keeps title and search key stable across counts, migrating the legacy issue in place', async () => {
    let currentTitle = legacyTitle;
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        return JSON.stringify([
          {
            number: issueNumber - 102,
            title: olderLegacyTitle,
            url: `https://github.com/o/r/issues/${issueNumber - 102}`,
            state: 'OPEN',
          },
          {
            number: issueNumber,
            title: currentTitle,
            url: `https://github.com/o/r/issues/${issueNumber}`,
            state: 'OPEN',
          },
        ]);
      }
      if (args[0] === 'issue' && args[1] === 'edit' && args.includes('--title')) {
        currentTitle = args[args.indexOf('--title') + 1];
      }
      return '';
    });

    const runOne = first();
    const runTwo = second();
    expect(runOne.title).toBe(runTwo.title);
    expect(runOne.dedupKey).toBe(key);
    expect(runTwo.dedupKey).toBe(key);
    expect(runOne.description).toContain(firstCount);
    expect(runTwo.description).toContain(secondCount);

    const resultOne = await createGithubIssue({ ...runOne, labels: ['crawler'] });
    const resultTwo = await createGithubIssue({ ...runTwo, labels: ['crawler'] });

    expect(resultOne?.number).toBe(issueNumber);
    expect(resultTwo?.number).toBe(issueNumber);
    expect(currentTitle).toBe(runOne.title);
    expect(ghCalls().filter((args) => args[0] === 'issue' && args[1] === 'create')).toHaveLength(0);
    expect(ghCalls().filter((args) => args[0] === 'issue' && args[1] === 'comment')).toHaveLength(2);
    expect(ghCalls().filter((args) => args[0] === 'issue' && args[1] === 'edit')).toHaveLength(1);

    const searchKeys = ghCalls()
      .filter((args) => args[0] === 'issue' && args[1] === 'list' && args.includes('--search'))
      .map((args) => args[args.indexOf('--search') + 1]);
    expect(searchKeys).toEqual(Array(4).fill(`in:title "${key}"`));
  });
});

describe('stable family election across OPEN and CLOSED generations', () => {
  it('reopens newer #6760 instead of attaching two different counts to legacy OPEN #6658', async () => {
    const legacyOpen = {
      number: 6658,
      title: '[crawler-coverage-gap] 160 vacancy viste da un crawler gemello e assenti dal crawler principale',
      url: 'https://github.com/o/r/issues/6658',
      state: 'OPEN',
    };
    const first = gapIssue(coverageGaps(16));
    const second = gapIssue(coverageGaps(6));
    let canonicalIsOpen = false;

    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        const state = args[args.indexOf('--state') + 1];
        if (state === 'open') {
          return JSON.stringify(canonicalIsOpen
            ? [legacyOpen, {
                number: 6760,
                title: first.title,
                url: 'https://github.com/o/r/issues/6760',
                state: 'OPEN',
              }]
            : [legacyOpen]);
        }
        if (state === 'closed' && !canonicalIsOpen) {
          return JSON.stringify([
            {
              // Older generation, but closed more recently: closedAt must not
              // outrank the immutable creation order encoded by issue number.
              number: 6635,
              title: '[crawler-coverage-gap] 103 vacancy viste da un crawler gemello e assenti dal crawler principale',
              url: 'https://github.com/o/r/issues/6635',
              state: 'CLOSED',
              stateReason: 'COMPLETED',
              closedAt: new Date().toISOString(),
              labels: [],
            },
            {
              number: 6760,
              title: first.title,
              url: 'https://github.com/o/r/issues/6760',
              state: 'CLOSED',
              stateReason: 'COMPLETED',
              closedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
              labels: [],
            },
          ]);
        }
        return '[]';
      }
      if (args[0] === 'issue' && args[1] === 'reopen' && args[2] === '6760') {
        canonicalIsOpen = true;
      }
      return '';
    });

    const resultOne = await createGithubIssue({ ...first, labels: ['crawler'] });
    const resultTwo = await createGithubIssue({ ...second, labels: ['crawler'] });

    expect(resultOne).toMatchObject({ number: 6760, title: first.title, reopened: true });
    expect(resultTwo).toMatchObject({ number: 6760, title: first.title });
    expect(ghCalls().filter((args) => args[0] === 'issue' && args[1] === 'reopen'))
      .toEqual([expect.arrayContaining(['6760'])]);
    expect(ghCalls().filter((args) => args[0] === 'issue' && args[1] === 'create')).toHaveLength(0);
    // Correctness does not depend on mutating the older tracker. Closing #6658
    // is safe post-merge cleanup; family election must work while it stays OPEN.
    expect(ghCalls().filter((args) => args[0] === 'issue' && args[1] === 'close')).toHaveLength(0);

    const comments = ghCalls().filter((args) => args[0] === 'issue' && args[1] === 'comment');
    expect(comments.map((args) => args[2])).toEqual(['6760', '6760']);
    expect(comments[0][comments[0].indexOf('--body') + 1]).toContain('16 vacancy');
    expect(comments[1][comments[1].indexOf('--body') + 1]).toContain('6 vacancy');

    const searchKeys = ghCalls()
      .filter((args) => args[0] === 'issue' && args[1] === 'list' && args.includes('--search'))
      .map((args) => args[args.indexOf('--search') + 1]);
    expect(searchKeys).toEqual(Array(4).fill(`in:title "${COVERAGE_GAP_ISSUE_KEY}"`));
  });
});
