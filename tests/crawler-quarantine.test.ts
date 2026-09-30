/**
 * Crawler quarantine (data/crawler-quarantine.json): the entry contract, the
 * tolerated verdict of the quarantine group, and both exits.
 *
 * Observer of the owner's requirement «il gruppo di quarantena non deve
 * risultare rosso per crawler gia' noti e tracciati: deve diventare rosso solo
 * per un fallimento nuovo o per una regressione», and of the exit criterion
 * (4 green waves back, 10 red waves or 7 days out).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import {
  QUARANTINE_OUTCOMES_NOTICE_TITLE,
  QUARANTINE_REJOIN_GREEN_WAVES,
  QUARANTINE_RETIRE_DAYS,
  QUARANTINE_RETIRE_RED_WAVES,
  applyQuarantineDecisions,
  assertQuarantineMembership,
  decideQuarantine,
  quarantineDeadline,
  toleratedQuarantineFailures,
  validateQuarantineRegistry,
  waveFromRunAnnotations,
} from '../scripts/lib/crawler-quarantine.mjs';
import { assignGroupsStable } from '../scripts/generate-crawler-group-workflows.mjs';
import {
  buildQuarantineReviewPrBody,
  collectWaves,
  isTransientGithubMutationError,
  withTransientGithubMutationRetry,
} from '../scripts/crawler-quarantine-review.mjs';
import { validatePrBody } from '../scripts/ci/pr-body-check-gate.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const REGISTRY_PATH = path.join(ROOT, 'data/crawler-quarantine.json');
const ASSIGNMENTS_PATH = path.join(ROOT, 'data/crawler-group-assignments.json');

const entry = (overrides: Record<string, any> = {}) => ({
  homeGroup: 13,
  enteredAt: '2026-09-20T00:00:00Z',
  failingSince: null,
  issue: null,
  ...overrides,
});

const registryOf = (members: Record<string, any>, retired: Record<string, any> = {}) => ({ schemaVersion: 1, group: 24, members, retired });

/** Waves newest-last helper: one wave every 12 hours from 2026-09-21. */
function waves(outcomesPerWave: Array<Record<string, string>>) {
  return outcomesPerWave.map((outcomes, index) => ({
    runId: 1000 + index,
    createdAt: new Date(Date.parse('2026-09-21T09:00:00Z') + index * 12 * 3600_000).toISOString(),
    source: 'notice',
    outcomes,
  }));
}

describe('the committed quarantine registry', () => {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const pins = JSON.parse(fs.readFileSync(ASSIGNMENTS_PATH, 'utf8'));

  it('is valid and describes exactly the quarantine group', () => {
    expect(() => validateQuarantineRegistry(registry, { groupCount: pins.groupCount })).not.toThrow();
    expect(() => assertQuarantineMembership(registry, pins.groups, new Set(pins.groups.flat()))).not.toThrow();
  });

  it('gives every known failure an issue and a deadline', () => {
    for (const [slug, member] of Object.entries<any>(registry.members)) {
      if (!member.failingSince) continue;
      expect(member.issue, slug).toBeGreaterThan(0);
      expect(quarantineDeadline(member), slug).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('validateQuarantineRegistry', () => {
  it('rejects a known failure without its tracking issue', () => {
    expect(() => validateQuarantineRegistry(registryOf({ x: entry({ failingSince: '2026-09-26T00:00:00Z' }) }), { groupCount: 24 }))
      .toThrow(/must name its tracking issue/);
  });

  it('rejects a home group equal to the quarantine group and a retirement without issue', () => {
    expect(() => validateQuarantineRegistry(registryOf({ x: entry({ homeGroup: 24 }) }), { groupCount: 24 }))
      .toThrow(/homeGroup/);
    expect(() => validateQuarantineRegistry(registryOf({}, { y: { retiredAt: '2026-09-28T00:00:00Z' } }), { groupCount: 24 }))
      .toThrow(/retirement must name the issue/);
  });
});

describe('assertQuarantineMembership', () => {
  const groups = Array.from({ length: 24 }, () => [] as string[]);

  it('rejects a crawler pinned in the quarantine group without an entry', () => {
    const pinned = groups.map((g, i) => (i === 23 ? ['stray'] : g));
    expect(() => assertQuarantineMembership(registryOf({}), pinned, new Set(['stray'])))
      .toThrow(/stray is pinned in the quarantine group 24 without an entry/);
  });

  it('rejects an entry whose crawler is pinned elsewhere, and ignores entries of crawlers gone from the manifest', () => {
    const pinned = groups.map((g, i) => (i === 0 ? ['moved'] : g));
    expect(() => assertQuarantineMembership(registryOf({ moved: entry() }), pinned, new Set(['moved'])))
      .toThrow(/moved has a quarantine entry but is not pinned in group 24/);
    expect(() => assertQuarantineMembership(registryOf({ gone: entry() }), groups, new Set()))
      .not.toThrow();
  });
});

describe('assignGroupsStable keeps new crawlers out of the quarantine group', () => {
  it('places a new crawler in the smallest NON-reserved group', () => {
    const crawler = (slug: string) => ({ slug, durationMs: 1000 });
    const pinned = [['a', 'b', 'c'], ['d', 'e'], []];
    const crawlers = ['a', 'b', 'c', 'd', 'e', 'new-one'].map(crawler);
    const free = assignGroupsStable(crawlers, pinned, 1000);
    expect(free.assignments[2]).toEqual(['new-one']);
    const reserved = assignGroupsStable(crawlers, pinned, 1000, { reservedGroupIndexes: [2] });
    expect(reserved.assignments[2]).toEqual([]);
    expect(reserved.assignments[1]).toEqual(['d', 'e', 'new-one']);
  });
});

describe('decideQuarantine', () => {
  const now = '2026-09-30T12:00:00Z';

  it(`sends a crawler back after ${QUARANTINE_REJOIN_GREEN_WAVES} consecutive green waves, not before`, () => {
    const registry = registryOf({ x: entry() });
    const three = decideQuarantine({ registry, waves: waves([{ x: 'failure' }, { x: 'success' }, { x: 'success' }, { x: 'success' }]), now });
    expect(three[0].action).toBe('observe');
    const four = decideQuarantine({ registry, waves: waves([{ x: 'success' }, { x: 'success' }, { x: 'success' }, { x: 'success' }]), now });
    expect(four[0]).toMatchObject({ action: 'rejoin', homeGroup: 13 });
  });

  it('turns a first red into a known failure starting at the first red wave of the streak', () => {
    const w = waves([{ x: 'success' }, { x: 'failure' }, { x: 'failure' }]);
    const [decision] = decideQuarantine({ registry: registryOf({ x: entry() }), waves: w, now });
    expect(decision).toMatchObject({ action: 'mark-failing', failingSince: w[1].createdAt });
  });

  it(`retires a known failure after ${QUARANTINE_RETIRE_RED_WAVES} red waves or ${QUARANTINE_RETIRE_DAYS} days, whichever first`, () => {
    const known = entry({ failingSince: '2026-09-29T00:00:00Z', issue: 42 });
    const nineRed = waves(Array.from({ length: 9 }, () => ({ x: 'failure' })));
    expect(decideQuarantine({ registry: registryOf({ x: known }), waves: nineRed, now })[0])
      .toMatchObject({ action: 'keep-failing', issue: 42, deadline: '2026-10-06' });
    const tenRed = waves(Array.from({ length: 10 }, () => ({ x: 'failure' })));
    expect(decideQuarantine({ registry: registryOf({ x: known }), waves: tenRed, now })[0].action).toBe('retire');
    const old = entry({ failingSince: '2026-09-23T11:00:00Z', issue: 42 });
    expect(decideQuarantine({ registry: registryOf({ x: old }), waves: waves([{ x: 'failure' }]), now })[0])
      .toMatchObject({ action: 'retire', reason: expect.stringMatching(/7 giorni/) });
  });

  it('drops the tolerance of a known failure that turned green', () => {
    const known = entry({ failingSince: '2026-09-29T00:00:00Z', issue: 42 });
    expect(decideQuarantine({ registry: registryOf({ x: known }), waves: waves([{ x: 'failure' }, { x: 'success' }]), now })[0].action)
      .toBe('mark-recovering');
  });

  it('ignores runner shutdowns, missing statuses and waves before the crawler entered', () => {
    const late = entry({ enteredAt: '2026-09-22T00:00:00Z' });
    const w = waves([{ x: 'failure' }, { x: 'failure' }, { x: 'success' }, { x: 'systemic' }, { x: 'success' }, { x: 'missing' }, { x: 'success' }, { x: 'success' }]);
    expect(decideQuarantine({ registry: registryOf({ x: late }), waves: w, now })[0]).toMatchObject({ action: 'rejoin', evidence: { streak: 4 } });
  });
});

describe('applyQuarantineDecisions', () => {
  it('moves a rejoining crawler to its home group, unpins a homeless one and retires with the announcing issue', () => {
    const registry = registryOf({
      back: entry({ homeGroup: 2 }),
      homeless: entry({ homeGroup: null }),
      dead: entry({ failingSince: '2026-09-20T00:00:00Z', issue: 7 }),
      fresh: entry(),
    });
    const assignments = [['a'], ['b'], ['back', 'homeless', 'dead', 'fresh']];
    const registry3 = { ...registry, group: 3 };
    const { registry: next, assignments: groups } = applyQuarantineDecisions({
      registry: registry3,
      assignments,
      now: '2026-09-30T00:00:00Z',
      issues: { dead: 99, fresh: 55 },
      decisions: [
        { slug: 'back', action: 'rejoin', homeGroup: 2 },
        { slug: 'homeless', action: 'rejoin', homeGroup: null },
        { slug: 'dead', action: 'retire', homeGroup: 13, reason: 'r' },
        { slug: 'fresh', action: 'mark-failing', failingSince: '2026-09-29T21:00:00Z' },
      ],
    });
    expect(groups).toEqual([['a'], ['b', 'back'], ['fresh']]);
    expect(Object.keys(next.members)).toEqual(['fresh']);
    expect(next.members.fresh).toMatchObject({ failingSince: '2026-09-29T21:00:00Z', issue: 55 });
    expect(next.retired.dead).toMatchObject({ issue: 99, retiredAt: '2026-09-30T00:00:00Z' });
    expect(registry3.members.back).toBeDefined();
  });

  it('refuses to tolerate or retire without an issue', () => {
    const registry = registryOf({ x: entry() });
    expect(() => applyQuarantineDecisions({ registry, assignments: Array.from({ length: 24 }, () => ['x']), now: 'n', decisions: [{ slug: 'x', action: 'mark-failing', failingSince: 'f' }] }))
      .toThrow(/tracking issue/);
  });
});

describe('waveFromRunAnnotations', () => {
  const run = { id: 1, createdAt: '2026-09-28T05:06:58Z' };

  it('reads the machine-readable notice first', () => {
    const wave = waveFromRunAnnotations({
      run: { ...run, conclusion: 'success' },
      annotations: [{ title: QUARANTINE_OUTCOMES_NOTICE_TITLE, message: '{"schemaVersion":1,"group":"24","outcomes":{"a":"success","b":"failure","c":"bogus"}}' }],
      memberSlugs: ['a', 'b', 'c'],
    });
    expect(wave).toMatchObject({ source: 'notice', outcomes: { a: 'success', b: 'failure' } });
  });

  it('reads the pre-notice runs from the aggregate annotations (run 36380490876 shape)', () => {
    const annotations = [
      { message: 'crawler group completed with 16 succeeded, 4 failed, 0 missing, 0 systemic; healthy siblings were preserved, but the group remains failed until incomplete crawlers are recovered' },
      { message: 'convit: crawler exited with status 1' },
      { message: 'knowledge-lab: crawler exited with status 1' },
      { message: 'lwphr: crawler exited with status 1' },
      { message: 'protectas: crawler exited with status 1' },
    ];
    const wave = waveFromRunAnnotations({ run: { ...run, conclusion: 'failure' }, annotations, memberSlugs: ['convit', 'afry', 'protectas'] });
    expect(wave?.outcomes).toEqual({ convit: 'failure', afry: 'success', protectas: 'failure' });
  });

  it('does not trust a failed run whose per-crawler errors do not add up, nor a run without a verdict', () => {
    const truncated = [{ message: 'crawler group completed with 5 succeeded, 12 failed, 0 missing, 0 systemic' }, { message: 'a: crawler exited with status 1' }];
    expect(waveFromRunAnnotations({ run: { ...run, conclusion: 'failure' }, annotations: truncated, memberSlugs: ['a'] })).toBeNull();
    expect(waveFromRunAnnotations({ run: { ...run, conclusion: 'failure' }, annotations: [], memberSlugs: ['a'] })).toBeNull();
    expect(waveFromRunAnnotations({ run: { ...run, conclusion: 'cancelled' }, annotations: [], memberSlugs: ['a'] })).toBeNull();
  });
});

describe('collectWaves', () => {
  it('reads annotations from the job check-run, not the job id', () => {
    const calls: string[] = [];
    const api = (args: string[]) => {
      const endpoint = args[1];
      calls.push(endpoint);
      if (endpoint.includes('/workflows/crawler-group-24.yml/runs')) {
        return { workflow_runs: [
          { id: 11, created_at: '2026-09-28T05:06:58Z', conclusion: 'success', html_url: 'u' },
          { id: 12, created_at: '2026-09-28T03:37:54Z', conclusion: 'cancelled', html_url: 'u' },
        ] };
      }
      if (endpoint.endsWith('/runs/11/jobs')) {
        return { jobs: [{ id: 123, check_run_url: 'https://api.github.com/repos/o/r/check-runs/987' }] };
      }
      if (endpoint.includes('/check-runs/987/annotations')) return [];
      throw new Error(`unexpected ${endpoint}`);
    };
    const result = collectWaves({ corpusRepo: 'o/r', group: 24, limit: 5, memberSlugs: ['a'], api });
    expect(result).toEqual([{ runId: 11, createdAt: '2026-09-28T05:06:58Z', source: 'legacy', outcomes: { a: 'success' }, url: 'u' }]);
    expect(calls).toContain('repos/o/r/check-runs/987/annotations?per_page=100');
    expect(calls.some((endpoint) => endpoint.includes('/check-runs/123/'))).toBe(false);
    expect(calls).toHaveLength(3);
  });
});

describe('the generated quarantine group verdict', () => {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const nn = String(registry.group).padStart(2, '0');
  const doc = YAML.parse(fs.readFileSync(path.join(ROOT, `.github/workflows/crawler-group-${nn}.yml`), 'utf8'));
  const steps = (Object.values(doc.jobs)[0] as any).steps;
  const aggregate = steps.find((step: any) => step.id === 'crawler_aggregate');
  const gate = steps.find((step: any) => step.name === 'Fail crawler group after all member outcomes');
  const members = [...aggregate.run.matchAll(/status_file="\$state_dir\/([a-z0-9-]+)\.status"/g)].map((m: RegExpMatchArray) => m[1]);
  const tolerated = [...toleratedQuarantineFailures(registry, members).entries()];

  function verdict(today: string, statuses: Record<string, number>) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quarantine-verdict-'));
    try {
      const stateDir = path.join(tmp, `crawler-generation/group-${nn}`);
      fs.mkdirSync(stateDir, { recursive: true });
      for (const slug of members) fs.writeFileSync(path.join(stateDir, `${slug}.status`), `${statuses[slug] ?? 0}\n`);
      const output = path.join(tmp, 'output');
      fs.writeFileSync(output, '');
      const stdout = execFileSync('bash', ['-c', aggregate.run], {
        env: { ...process.env, RUNNER_TEMP: tmp, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: path.join(tmp, 'summary'), CRAWLER_QUARANTINE_TODAY: today },
        encoding: 'utf8',
      });
      const counts = Object.fromEntries(fs.readFileSync(output, 'utf8').trim().split('\n').map((line) => line.split('=')));
      let gateExit = 0;
      try {
        execFileSync('bash', ['-c', gate.run], {
          env: {
            ...process.env,
            CRAWLER_AGGREGATE_OUTCOME: 'success',
            CRAWLER_AGGREGATE_SUCCESS: counts.success_count,
            CRAWLER_AGGREGATE_FAILURES: counts.failure_count,
            CRAWLER_AGGREGATE_MISSING: counts.missing_count,
            CRAWLER_AGGREGATE_SYSTEMIC: counts.systemic_count,
            CRAWLER_AGGREGATE_TOLERATED: counts.tolerated_count,
          },
          encoding: 'utf8',
        });
      } catch (error: any) {
        gateExit = error.status ?? 1;
      }
      const notice = stdout.split('\n').find((line) => line.startsWith(`::notice title=${QUARANTINE_OUTCOMES_NOTICE_TITLE}::`))!;
      const outcomes = JSON.parse(notice.slice(`::notice title=${QUARANTINE_OUTCOMES_NOTICE_TITLE}::`.length)).outcomes;
      return { counts, gateExit, outcomes };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it('wires the tolerated count into the gate', () => {
    expect(gate.env.CRAWLER_AGGREGATE_TOLERATED).toBe("${{ steps.crawler_aggregate.outputs.tolerated_count || '0' }}");
  });

  it('stays green when only known failures fail before their deadline', () => {
    if (tolerated.length === 0) return;
    const [[slug, { deadline }]] = tolerated;
    const result = verdict(deadline, Object.fromEntries(tolerated.map(([s]) => [s, 1])));
    expect(result.counts).toMatchObject({ failure_count: '0', tolerated_count: String(tolerated.length), wait_outcome: 'failure' });
    expect(result.gateExit).toBe(0);
    expect(result.outcomes[slug]).toBe('failure');
    expect(Object.keys(result.outcomes).sort()).toEqual([...members].sort());
  });

  it('turns red for a known failure past its deadline', () => {
    if (tolerated.length === 0) return;
    const [[slug, { deadline }]] = tolerated;
    const dayAfter = new Date(Date.parse(`${deadline}T00:00:00Z`) + 24 * 3600_000).toISOString().slice(0, 10);
    const result = verdict(dayAfter, { [slug]: 1 });
    expect(result.counts.failure_count).toBe('1');
    expect(result.gateExit).not.toBe(0);
  });

  it('turns red for a new failure or a regression of any other member', () => {
    const untracked = members.find((slug: string) => !tolerated.some(([s]) => s === slug));
    expect(untracked).toBeDefined();
    const result = verdict('2026-09-29', { [untracked!]: 1 });
    expect(result.counts).toMatchObject({ failure_count: '1', tolerated_count: '0' });
    expect(result.gateExit).not.toBe(0);
  });
});

describe('buildQuarantineReviewPrBody', () => {
  it('satisfies the repository PR body contract', () => {
    const registry = registryOf({ x: entry() });
    const evidence = { latest: 'success', streak: 4, streakStart: '2026-09-28T00:00:00Z', runs: [1, 2], observed: 6 };
    const body = buildQuarantineReviewPrBody({
      registry,
      issues: { dead: 12 },
      workflowPaths: ['.github/workflows/crawler-group-24.yml'],
      decisions: [
        { slug: 'x', action: 'rejoin', homeGroup: 13, evidence },
        { slug: 'dead', action: 'retire', reason: '10 ondate rosse consecutive (soglia 10)', evidence: { ...evidence, latest: 'failure', streak: 10 } },
        { slug: 'slow', action: 'keep-failing', issue: 9, deadline: '2026-10-03', evidence: { ...evidence, latest: 'failure', streak: 3 } },
      ],
    });
    expect(body).toContain('## Implementato');
    expect(body).toContain('## Non implementato (ancora)');
    const validation = validatePrBody(body, { diffPaths: ['.github/workflows/crawler-group-24.yml'] });
    expect(validation.violations ?? []).toEqual([]);
  });
});

describe('crawler quarantine GitHub mutation retry', () => {
  it('classifies the transient create/merge failures without retrying a real permission error', () => {
    expect(isTransientGithubMutationError('GraphQL: Something went wrong while executing your query')).toBe(true);
    expect(isTransientGithubMutationError('HTTP 503: Service Unavailable')).toBe(true);
    expect(isTransientGithubMutationError('request timeout')).toBe(true);
    expect(isTransientGithubMutationError('HTTP 403: Resource not accessible by integration')).toBe(false);
  });

  it('reuses a PR found after a transient create response instead of submitting create twice', () => {
    let attempts = 0;
    let lookups = 0;
    const existing = { number: 10429, url: 'https://github.com/example/repo/pull/10429', headRefName: 'crawler-quarantine/review-202609291425' };
    const result = withTransientGithubMutationRetry(() => {
      attempts += 1;
      throw Object.assign(new Error('gh failed'), { stderr: 'GraphQL: Something went wrong while executing your query' });
    }, {
      findExisting: () => {
        lookups += 1;
        return existing;
      },
      sleep: () => undefined,
    });

    expect(result).toEqual({ reused: true, value: existing, attempts: 1 });
    expect(attempts).toBe(1);
    expect(lookups).toBe(1);
  });

  it('uses bounded exponential backoff and exhausts after three transient attempts', () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const retries: Array<[number, number, number]> = [];
    const transient = Object.assign(new Error('gh failed'), { status: 502 });

    expect(() => withTransientGithubMutationRetry(() => {
      attempts += 1;
      throw transient;
    }, {
      delaysMs: [11, 22],
      findExisting: () => null,
      sleep: (delay: number) => sleeps.push(delay),
      onRetry: (next: number, limit: number, delay: number) => retries.push([next, limit, delay]),
    })).toThrow('gh failed');

    expect(attempts).toBe(3);
    expect(sleeps).toEqual([11, 22]);
    expect(retries).toEqual([[2, 3, 11], [3, 3, 22]]);
  });
});
