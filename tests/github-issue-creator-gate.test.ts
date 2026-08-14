import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock `gh` invocations. We route by the gh sub-command so a single mock can
// simulate "no open issue", "issue has N prior failure events", etc.
const execFileSync = vi.fn();
vi.mock('node:child_process', () => {
  const mock = { execFileSync: (...args: unknown[]) => execFileSync(...args) };
  return { ...mock, default: mock };
});

const { createGithubIssue } = await import('../scripts/lib/github-issue-creator.mjs');

/** Capture the args of the gh calls so tests can assert on create/edit labels. */
function ghCalls(): string[][] {
  return execFileSync.mock.calls
    .filter((c) => c[0] === 'gh')
    .map((c) => c[1] as string[]);
}

function createCallLabels(): string[] {
  const call = ghCalls().find((a) => a[0] === 'issue' && a[1] === 'create');
  if (!call) return [];
  const labels: string[] = [];
  for (let i = 0; i < call.length; i++) if (call[i] === '--label') labels.push(call[i + 1]);
  return labels;
}

const ISO = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString();

beforeEach(() => {
  execFileSync.mockReset();
  delete process.env.GH_REPO;
});

describe('github-issue-creator crawler-failure consecutive gate', () => {
  it('1st failure → ledger entry, NOT a per-crawler issue (#5139/#5137)', async () => {
    // No open issue, no recently-closed issue, no ledger yet.
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') return '[]'; // no dup, no ledger
      if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/42';
      return '';
    });

    const res = await createGithubIssue({
      title: 'Crawler Failure: Update Nestlé',
      description: 'fetch failed',
      priority: 2, // caller asks priority:high
      labels: ['Bug'],
      workflow: 'Update Nestlé',
    } as any);

    // The only issue created is the shared ledger — a lone blip must not mint
    // an issue of its own. 333 crawler-transient issues had been opened this way.
    const creates = ghCalls().filter((a) => a[0] === 'issue' && a[1] === 'create');
    expect(creates).toHaveLength(1);
    expect(creates[0][creates[0].indexOf('--title') + 1]).toBe('Crawler transient failures (rolling ledger)');
    expect(creates.some((c) => c.includes('Crawler Failure: Update Nestlé'))).toBe(false);

    // The failure is recorded as a ledger comment carrying the crawler's key.
    const comment = ghCalls().find((a) => a[0] === 'issue' && a[1] === 'comment');
    expect(comment?.[2]).toBe('42');
    expect(comment?.[comment.indexOf('--body') + 1]).toContain('transient-key: Crawler Failure: Update Nestlé');

    expect(res?.ledger).toBe(true);
    // Never escalates the caller's priority on a first blip.
    expect(createCallLabels()).not.toContain('priority:high');
  });

  it('reuses an existing ledger and escalates on the Nth failure', async () => {
    // Ledger #7 already holds 2 in-window entries for this crawler.
    const key = 'transient-key: Crawler Failure: Update Nestlé';
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        // Dedup lookup for the crawler title finds nothing; ledger lookup finds #7.
        const isLedgerLookup = args.some((a) => typeof a === 'string' && a.includes('Crawler transient failures'));
        return isLedgerLookup
          ? JSON.stringify([{ number: 7, title: 'Crawler transient failures (rolling ledger)', url: 'u', closedAt: null }])
          : '[]';
      }
      if (args[0] === 'issue' && args[1] === 'view') {
        return JSON.stringify({
          comments: [
            { createdAt: ISO(1), body: `x ${key}` },
            { createdAt: ISO(2), body: `x ${key}` },
            { createdAt: ISO(200), body: `x ${key}` }, // outside the 48h window
            { createdAt: ISO(1), body: 'transient-key: Crawler Failure: Update Other' },
          ],
        });
      }
      if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/77';
      return '';
    });

    const res = await createGithubIssue({
      title: 'Crawler Failure: Update Nestlé',
      description: 'fetch failed again',
      priority: 2,
      labels: ['Bug'],
      workflow: 'Update Nestlé',
    } as any);

    // 2 in-window entries + this run = 3 = threshold → a real, routable issue.
    expect(res?.number).toBe(77);
    expect(res?.ledger).toBeUndefined();
    const creates = ghCalls().filter((a) => a[0] === 'issue' && a[1] === 'create');
    expect(creates).toHaveLength(1);
    expect(creates[0][creates[0].indexOf('--title') + 1]).toBe('Crawler Failure: Update Nestlé');
    const labels = createCallLabels();
    expect(labels).toContain('priority:high');
    expect(labels).not.toContain('crawler-transient');
  });

  it('falls back to a per-crawler issue when the ledger cannot be written', async () => {
    // Ledger creation fails (gh error) → we must not lose the failure signal.
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') return '[]';
      if (args[0] === 'issue' && args[1] === 'create') {
        const title = args[args.indexOf('--title') + 1];
        if (String(title).startsWith('Crawler transient failures')) throw new Error('gh down');
        return 'https://github.com/o/r/issues/55';
      }
      return '';
    });

    const res = await createGithubIssue({
      title: 'Crawler Failure: Update Nestlé',
      description: 'fetch failed',
      priority: 2,
      labels: ['Bug'],
      workflow: 'Update Nestlé',
    } as any);

    expect(res?.number).toBe(55);
    const labels = createCallLabels();
    expect(labels).toContain('priority:low');
    expect(labels).toContain('crawler-transient');
  });

  it('Nth failure on an existing breadcrumb → escalates to caller priority', async () => {
    // An OPEN canonical issue exists with 2 prior in-window failure events
    // (creation + one 🔁 recurrence comment). This run is event #3 → escalate.
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        return JSON.stringify([
          { number: 7, title: 'Crawler Failure: Update Nestlé', url: 'u', state: 'OPEN' },
        ]);
      }
      if (args[0] === 'issue' && args[1] === 'view') {
        return JSON.stringify({
          createdAt: ISO(5),
          comments: [{ createdAt: ISO(2), body: '🔁 Recurrence on workflow run.' }],
        });
      }
      return '';
    });

    await createGithubIssue({
      title: 'Crawler Failure: Update Nestlé',
      description: 'fetch failed',
      priority: 2,
      labels: ['Bug'],
      workflow: 'Update Nestlé',
    } as any);

    // It must have edited the issue to add priority:high and remove crawler-transient.
    const editCalls = ghCalls().filter((a) => a[0] === 'issue' && a[1] === 'edit');
    const flat = editCalls.flat();
    expect(flat).toContain('priority:high');
    // remove-label priority:* (low/medium/urgent) on escalation
    expect(flat).toContain('--remove-label');
    expect(flat).toContain('crawler-transient');
  });

  it('non-crawler title is NOT gated (keeps caller priority on 1st run)', async () => {
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') return '[]';
      if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/99';
      return '';
    });

    await createGithubIssue({
      title: 'CI Failure: Refresh Job Popularity',
      description: 'boom',
      priority: 2,
      labels: ['Bug'],
    } as any);

    const labels = createCallLabels();
    expect(labels).toContain('priority:high');
    expect(labels).not.toContain('crawler-transient');
  });

  it('explicit --consecutive-gate negative opts a crawler title OUT of the gate', async () => {
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') return '[]';
      if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/5';
      return '';
    });

    await createGithubIssue({
      title: 'Crawler Failure: Update Nestlé',
      description: 'fetch failed',
      priority: 2,
      labels: ['Bug'],
      consecutiveGate: -1, // opt out
    } as any);

    const labels = createCallLabels();
    expect(labels).toContain('priority:high');
    expect(labels).not.toContain('crawler-transient');
  });

  it('dedup search prefix is sanitized — no unbalanced "(Dedicat" tail (long crawler names)', async () => {
    // Regression: `title.slice(0, 60)` cut long crawler titles mid-word, leaving
    // an unbalanced "(Dedicat" → GitHub `in:title "..."` returned ZERO → dedup
    // missed → a fresh duplicate issue every 12h run (SVAR opened 8 dups).
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') return '[]';
      if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/7';
      return '';
    });

    await createGithubIssue({
      title: 'Crawler Failure: Update SVAR Spitalverbund AR Jobs (Dedicated)',
      description: 'fetch failed',
      priority: 2,
      labels: ['Bug'],
    } as any);

    const listCall = ghCalls().find((a) => a[0] === 'issue' && a[1] === 'list');
    const searchArg = listCall?.[listCall.indexOf('--search') + 1] ?? '';
    // Must NOT carry the mid-word/unbalanced-paren fragment that breaks search.
    expect(searchArg).not.toContain('(Dedicat');
    // Keeps the whole-token, per-crawler discriminator.
    expect(searchArg).toContain('Update SVAR Spitalverbund AR Jobs');
  });

  it('dedup search prefix has NO unbalanced bracket — name with internal parenthetical', async () => {
    // Crawlers whose NAME carries a parenthetical (HIB, KSSG, CNP) get cut
    // mid-group by slice(0,60), leaving an unbalanced `(` that also voids the
    // phrase search. The sanitizer must drop the tail from the first unmatched
    // opener, keeping a clean, still-discriminating prefix.
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') return '[]';
      if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/8';
      return '';
    });

    await createGithubIssue({
      title: 'Crawler Failure: Update HIB (Hôpital Intercantonal de la Broye) Jobs (Dedicated)',
      description: 'fetch failed',
      priority: 2,
      labels: ['Bug'],
    } as any);

    const listCall = ghCalls().find((a) => a[0] === 'issue' && a[1] === 'list');
    const searchArg = listCall?.[listCall.indexOf('--search') + 1] ?? '';
    // Count of unmatched '(' inside the quoted phrase must be zero.
    const opens = (searchArg.match(/\(/g) || []).length;
    const closes = (searchArg.match(/\)/g) || []).length;
    expect(opens).toBe(closes); // balanced (here: both 0)
    expect(searchArg).toContain('Update HIB'); // discriminator retained
  });

  it('short (untruncated) title keeps its final token — no over-match', async () => {
    // The trailing-token strip must fire ONLY on real truncation. A short title
    // shorter than the slice ceiling must keep its last whole token as the
    // discriminator (else it degrades to a generic prefix that over-matches).
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') return '[]';
      if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/9';
      return '';
    });

    await createGithubIssue({
      title: 'Crawler Failure: Update Foo', // 27 chars, well under the ceiling
      description: 'fetch failed',
      priority: 2,
      labels: ['Bug'],
    } as any);

    const listCall = ghCalls().find((a) => a[0] === 'issue' && a[1] === 'list');
    const searchArg = listCall?.[listCall.indexOf('--search') + 1] ?? '';
    expect(searchArg).toContain('Update Foo'); // final token preserved
  });

  it('escalation title with space-free key keeps its bucket discriminator', async () => {
    // Regression: a space-free bucket key (e.g. reviewer-finding/workflow-scope-creds)
    // makes slice(0,60) land on the space BEFORE "ricorre" — a length-based strip
    // gate would drop the whole key and collapse the prefix to
    // "escalation(harvester)", deduping EVERY bucket onto one canonical. The cut
    // char (a space) means no word was split → key must be preserved.
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') return '[]';
      if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/10';
      return '';
    });

    await createGithubIssue({
      title: 'escalation(harvester): reviewer-finding/workflow-scope-creds ricorre nonostante regola',
      description: 'bucket recurs',
      priority: 2,
      labels: ['follow-up'],
    } as any);

    const listCall = ghCalls().find((a) => a[0] === 'issue' && a[1] === 'list');
    const searchArg = listCall?.[listCall.indexOf('--search') + 1] ?? '';
    expect(searchArg).toContain('workflow-scope-creds'); // bucket key preserved
    expect(searchArg).not.toBe('in:title "escalation(harvester)"'); // not collapsed
  });
});

describe('reopenWithinHours + buildSha deploy-latency guard (#5539)', () => {
  const CLOSED_ISSUE = {
    number: 50,
    title: 'Validation Failure (dist): validate:internal-links',
    url: 'https://github.com/o/r/issues/50',
    closedAt: ISO(1),
  };

  function mockGh({ compareStatus }: { compareStatus: string }) {
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        const state = args[args.indexOf('--state') + 1];
        return state === 'closed' ? JSON.stringify([CLOSED_ISSUE]) : '[]';
      }
      if (args[0] === 'api' && String(args[1]).includes('/issues/50/events')) return 'closingSha123';
      if (args[0] === 'api' && String(args[1]).includes('/compare/')) return compareStatus;
      return '';
    });
  }

  it('build predates the closing commit → comments latency, does NOT reopen', async () => {
    mockGh({ compareStatus: 'ahead' }); // buildSha is an ancestor of the closing commit

    const res = await createGithubIssue({
      title: 'Validation Failure (dist): validate:internal-links',
      description: 'broken links',
      priority: 1,
      labels: ['Bug'],
      reopenWithinHours: 6,
      buildSha: 'staleBuildSha',
    } as any);

    expect(ghCalls().some((a) => a[0] === 'issue' && a[1] === 'reopen')).toBe(false);
    const comment = ghCalls().find((a) => a[0] === 'issue' && a[1] === 'comment');
    expect(comment?.[2]).toBe('50');
    expect(comment?.[comment.indexOf('--body') + 1]).toContain('precede la fix');
    expect(res?.number).toBe(50);
    expect((res as any)?.staleBuild).toBe(true);
  });

  it('build is at/after the closing commit → reopens as a real recurrence', async () => {
    mockGh({ compareStatus: 'behind' }); // buildSha is NOT an ancestor — already has the fix

    const res = await createGithubIssue({
      title: 'Validation Failure (dist): validate:internal-links',
      description: 'broken links again',
      priority: 1,
      labels: ['Bug'],
      reopenWithinHours: 6,
      buildSha: 'freshBuildSha',
    } as any);

    const reopenCall = ghCalls().find((a) => a[0] === 'issue' && a[1] === 'reopen');
    expect(reopenCall?.[2]).toBe('50');
    const comment = ghCalls().find((a) => a[0] === 'issue' && a[1] === 'comment');
    expect(comment?.[comment.indexOf('--body') + 1]).toContain('Reopened');
    expect(res?.number).toBe(50);
  });

  it('no buildSha supplied → skips the ancestor check, preserves pre-#5539 unconditional reopen', async () => {
    mockGh({ compareStatus: 'ahead' });

    await createGithubIssue({
      title: 'Validation Failure (dist): validate:internal-links',
      description: 'broken links',
      priority: 1,
      labels: ['Bug'],
      reopenWithinHours: 6,
    } as any);

    expect(ghCalls().some((a) => a[0] === 'api')).toBe(false); // no ancestor lookup at all
    const reopenCall = ghCalls().find((a) => a[0] === 'issue' && a[1] === 'reopen');
    expect(reopenCall?.[2]).toBe('50');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The #5539 guard shipped with ONE source for the closing commit — the `closed`
// event's `commit_id` — and this repo's automation never populates it: the bot
// closes with `gh issue close`, so GitHub records no keyword close. Measured
// 2026-08-13, all three reopens of that day came back null from it and reopened
// unconditionally on a build that could not contain their own fix:
//
//   #5729/#5786  run 31736768103 created 19:37:29Z on build 78a1f7ae
//                (committed 19:33:46Z); PR #5778 merged eb7eac6a at 19:40:32Z,
//                issues closed 19:40:34/35Z. Build predates the fix by 3 min.
//                `gh api .../compare/eb7eac6a...78a1f7ae` → "behind".
//   #5752        build 349fa50a committed 03:26:23Z; PR #5761 merged 03:52:30Z,
//                issue closed 03:52:32Z. Build predates the fix by 26 min.
//
// #5729 is recoverable by SHA (its timeline carries `referenced eb7eac6a` in the
// same second as the close); #5786 and #5752 carry no commit reference at all
// and are only reachable by timestamp. Hence two rungs — and each case below
// pins one, INCLUDING the ones that must still reopen, because a guard that
// abstains everywhere is just a disabled reopener.
// ─────────────────────────────────────────────────────────────────────────────
describe('reopen guard: closing commit recovered from the timeline, timestamp fallback', () => {
  const CLOSED_AT = ISO(1);
  const CLOSED_ISSUE = {
    number: 50,
    title: 'Validation Failure (dist): dist:quality-tests',
    url: 'https://github.com/o/r/issues/50',
    closedAt: CLOSED_AT,
  };
  const beforeClose = new Date(Date.parse(CLOSED_AT) - 3 * 60 * 1000).toISOString();
  const afterClose = new Date(Date.parse(CLOSED_AT) + 30 * 60 * 1000).toISOString();
  /** Far enough back to sit outside CLOSING_REFERENCE_WINDOW_MS (5 min). */
  const wayBeforeClose = new Date(Date.parse(CLOSED_AT) - 25 * 60 * 1000).toISOString();

  /**
   * @param eventsSha    what `/issues/50/events` yields ('' = the real-world null)
   * @param timeline     lines of "<iso>\t<sha>" from `/issues/50/timeline`
   * @param compare      status returned by `/compare/...`
   * @param commitDate   committer date for `/commits/<sha>` (null = lookup fails)
   */
  function mockGh({
    eventsSha = '', timeline = [] as string[], compare = 'diverged', commitDate = null as string | null,
  }) {
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        const state = args[args.indexOf('--state') + 1];
        return state === 'closed' ? JSON.stringify([CLOSED_ISSUE]) : '[]';
      }
      if (args[0] === 'api') {
        const path = String(args[1]);
        if (path.includes('/timeline')) return timeline.join('\n');
        if (path.includes('/events')) return eventsSha;
        if (path.includes('/compare/')) return compare;
        if (path.includes('/commits/')) {
          if (commitDate === null) throw new Error('404 Not Found'); // gh exits non-zero
          return commitDate;
        }
      }
      return '';
    });
  }

  const report = (buildSha: string) => createGithubIssue({
    title: 'Validation Failure (dist): dist:quality-tests',
    description: 'gate failed',
    priority: 1,
    labels: ['Bug'],
    reopenWithinHours: 6,
    buildSha,
  } as any);

  const reopened = () => ghCalls().some((a) => a[0] === 'issue' && a[1] === 'reopen');
  const commentBody = () => {
    const c = ghCalls().find((a) => a[0] === 'issue' && a[1] === 'comment');
    return c ? String(c[c.indexOf('--body') + 1]) : '';
  };

  // (a) — the run PREDATES the closing commit. Must NOT reopen.
  it('(a1) #5729 shape: closed event has no commit_id, timeline does → ancestor check fires, no reopen', async () => {
    mockGh({
      eventsSha: '',                                   // real-world: commit_id is null
      timeline: [`${CLOSED_AT}\teb7eac6a`],            // referenced in the same second as the close
      compare: 'ahead',                                // buildSha is an ancestor of eb7eac6a
    });

    const res = await report('78a1f7ae');

    expect(reopened()).toBe(false);
    expect(commentBody()).toContain('precede la fix');
    expect(commentBody()).toContain('eb7eac6a');
    expect((res as any)?.staleBuild).toBe(true);
  });

  it('(a2) #5752 shape: no closing commit anywhere → build committed before the close, no reopen', async () => {
    mockGh({ eventsSha: '', timeline: [], commitDate: beforeClose });

    const res = await report('349fa50a');

    expect(reopened()).toBe(false);
    expect(commentBody()).toContain('Riapertura saltata');
    expect(commentBody()).toContain(beforeClose);      // the evidence is named, not just asserted
    expect((res as any)?.staleBuild).toBe(true);
  });

  // (b) — a genuine recurrence AFTER the fix. Must reopen. Without these two the
  // guard could "pass" by never reopening anything at all.
  it('(b1) build already contains the fix (compare says not an ancestor) → reopens', async () => {
    mockGh({
      eventsSha: '',
      timeline: [`${CLOSED_AT}\teb7eac6a`],
      compare: 'behind',                               // buildSha is NOT an ancestor
      commitDate: beforeClose,                         // rung 2 would have abstained — must not be consulted
    });

    await report('freshBuildSha');

    expect(reopened()).toBe(true);
    expect(commentBody()).toContain('Reopened');
  });

  it('(b2) no closing commit, build committed AFTER the close → real recurrence, reopens', async () => {
    mockGh({ eventsSha: '', timeline: [], commitDate: afterClose });

    await report('freshBuildSha');

    expect(reopened()).toBe(true);
    expect(commentBody()).toContain('Reopened');
  });

  // (c) — ambiguity. Fail-safe is to REPORT, never to swallow.
  it('(c1) closing commit not recoverable and the commit lookup fails → reopens (fail-safe)', async () => {
    mockGh({ eventsSha: '', timeline: [], commitDate: null }); // /commits/<sha> throws

    await report('unknownSha');

    expect(reopened()).toBe(true);
  });

  it('(c2) issue closed with no closedAt at all → no timestamp to compare, reopens (fail-safe)', async () => {
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        const state = args[args.indexOf('--state') + 1];
        // closedAt present (the finder filters on it) but unparseable downstream.
        return state === 'closed' ? JSON.stringify([{ ...CLOSED_ISSUE, closedAt: ISO(1) }]) : '[]';
      }
      if (args[0] === 'api' && String(args[1]).includes('/commits/')) return 'not-a-date';
      return '';
    });

    await report('someSha');

    expect(reopened()).toBe(true);
  });

  // The trap that makes the timeline rung safe: #5729 also carried an unrelated
  // `referenced d72549e1` 25 minutes before the close, from a PR that merely
  // mentioned the issue. Attributing the close to it would judge staleness
  // against the wrong commit.
  it('ignores a referenced commit far from the close, then falls back to the timestamp', async () => {
    mockGh({
      eventsSha: '',
      timeline: [`${wayBeforeClose}\td72549e1`],
      compare: 'ahead',                                // would abstain if d72549e1 were used as closing sha
      commitDate: afterClose,                          // timestamp rung says: real recurrence
    });

    await report('freshBuildSha');

    expect(reopened()).toBe(true);
    expect(ghCalls().some((a) => a[0] === 'api' && String(a[1]).includes('/compare/'))).toBe(false);
  });

  it('prefers the closed event commit_id when GitHub does populate it', async () => {
    mockGh({ eventsSha: 'keywordSha', timeline: [`${CLOSED_AT}\totherSha`], compare: 'ahead' });

    await report('staleSha');

    expect(reopened()).toBe(false);
    expect(commentBody()).toContain('keywordSha');
    // The timeline is not even queried when the strong source answered.
    expect(ghCalls().some((a) => a[0] === 'api' && String(a[1]).includes('/timeline'))).toBe(false);
  });
});
