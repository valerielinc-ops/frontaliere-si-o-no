import { existsSync, readFileSync, statSync } from 'node:fs';
import { Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it, vi } from 'vitest';
import {
  classifyOrder, ISSUE_TITLE, parseArgs, runReport, SLA_HOURS, SNAPSHOT_COLLECTION,
  summarizeOrders, timestampMs,
} from '../scripts/assisted-application/sla-report.mjs';

const HOUR = 3_600_000;
const now = Date.now();
const repo = 'synthetic-owner/synthetic-private';
const paid = (extra = {}) => ({ paymentStatus: 'paid', submissionStatus: 'in_progress', ...extra });
const baseLate = paid({ statusChangedAt: now - 13 * HOUR });
const ownerFlow = (state: string, age: number, heldBy: string[] = []) => ({
  state,
  heldBy,
  history: [
    { state: 'submitting', at: now - age - HOUR },
    { state, at: now - age },
    { state, at: now - 100 },
  ],
});

function fixture(orders: Record<string, unknown>[], flow?: ReturnType<typeof ownerFlow>) {
  const pages: number[] = [];
  const flowReads: string[] = [];
  const set = vi.fn();
  const docs = orders.map((order, index) => ({
    id: `synthetic-${index}`,
    data: () => order,
    ref: {
      collection: (name: string) => {
        expect(name).toBe('automation');
        flowReads.push(`synthetic-${index}`);
        return {
          where: (key: string, operator: string, value: string) => {
            expect([key, operator, value]).toEqual(['document-id', '==', 'flow']);
            return { select: (...fields: string[]) => {
              expect(fields).toEqual(['state', 'heldBy', 'history', 'withdrawnAt']);
              return { docs: flow ? [{ data: () => flow }] : [] };
            } };
          },
        };
      },
    },
  }));
  const query = {
    orderBy: vi.fn(() => query),
    select: vi.fn(() => query),
    startAfter: (cursor: typeof docs[number]) => {
      expect(docs.indexOf(cursor)).toBeGreaterThanOrEqual(0);
      return { limit: (size: number) => page(size, docs.indexOf(cursor) + 1) };
    },
    limit: (size: number) => page(size, 0),
  };
  function page(size: number, offset: number) {
    pages.push(size);
    return { docs: docs.slice(offset, offset + size) };
  }
  const where = vi.fn(() => query);
  const doc = vi.fn(() => ({ set }));
  const db = {
    collection: vi.fn((name: string) => {
      if (name === SNAPSHOT_COLLECTION) return { doc };
      expect(name).toBe('assisted_applications');
      return { where };
    }),
    runTransaction: async (fn: (transaction: { get: (value: unknown) => unknown }) => unknown, options: unknown) => {
      expect(options).toEqual({ readOnly: true });
      return fn({ get: value => value });
    },
  };
  return { db, documentId: 'document-id', pages, flowReads, set, doc, where, query };
}

function github(visibility: unknown, issues: { number: number; title: string }[] = [], nameWithOwner = repo) {
  const bodies: string[] = [];
  const paths: string[] = [];
  const gh = vi.fn((args: string[]) => {
    if (args[0] === 'repo') return JSON.stringify({ nameWithOwner, visibility });
    if (args[1] === 'list') return JSON.stringify(issues);
    const path = args[args.indexOf('--body-file') + 1];
    if (args.includes('--body-file')) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      paths.push(path);
      bodies.push(readFileSync(path, 'utf8'));
    }
    expect(args.join(' ')).not.toContain('synthetic-0');
    return '';
  });
  return { gh, bodies, paths };
}

describe('assisted application SLA classification', () => {
  it('uses each base threshold and keeps the exact limit in SLA', () => {
    for (const state of ['awaiting_upload', 'blocked', 'in_progress', 'ready_for_manual_submission'] as const) {
      const limit = SLA_HOURS[state] * HOUR;
      const rows = [limit, limit + 1].map((age, index) => ({
        id: `synthetic-${index}`, flow: undefined,
        order: paid({ submissionStatus: state, statusChangedAt: now - age }),
      }));
      expect(summarizeOrders(rows, now).report.states[state])
        .toEqual({ total: 2, overdue: 1, unknownAge: 0, maxAgeMs: limit + 1 });
    }
  });

  it('uses owner state and continuous entry even after a same-state update', () => {
    for (const [state, heldBy, bucket] of [
      ['owner_review', [], 'owner_review'],
      ['owner_takeover', ['owner'], 'owner_takeover'],
      ['owner_takeover', ['portal:captcha_required'], 'captcha_requires_owner'],
    ] as const) {
      const ageMs = SLA_HOURS[bucket] * HOUR + 1;
      const flow = ownerFlow(state, ageMs, [...heldBy]);
      const order = paid({ automationState: state, automationUpdatedAt: now - 100 });
      expect(classifyOrder(order, flow, now)).toEqual({ state: bucket, ageMs });
      const result = summarizeOrders([{ id: 'synthetic-0', order, flow }], now);
      expect(result.report.states[bucket].overdue).toBe(1);
      expect(result.overdue).toEqual([{ id: 'synthetic-0', state: bucket }]);
      const exact = ownerFlow(state, SLA_HOURS[bucket] * HOUR, [...heldBy]);
      expect(summarizeOrders([{ id: 'synthetic-0', order, flow: exact }], now).report.overdue).toBe(0);
    }
  });

  it('preserves unknown ages when the history is truncated, misordered or inconsistent', () => {
    const flow = ownerFlow('owner_review', HOUR);
    const order = paid({ automationState: 'owner_review' });
    expect(classifyOrder(order, { ...flow, history: flow.history.slice(1) }, now))
      .toEqual({ state: 'owner_review', ageMs: null });
    expect(classifyOrder(order, { ...flow, history: [...flow.history].reverse() }, now))
      .toEqual({ state: 'owner_review', ageMs: null });
    expect(classifyOrder(order, {
      ...flow, history: [{ state: 'owner_review', at: now - 10 * HOUR }, ...flow.history],
    }, now)?.ageMs).toBe(HOUR);
    expect(classifyOrder(order, ownerFlow('owner_takeover', HOUR), now))
      .toEqual({ state: 'unknown', ageMs: null });
  });

  it('excludes terminal, withdrawn, cancelling and refunding orders and retains unknown states', () => {
    for (const extra of [
      { submissionStatus: 'submitted' }, { submissionStatus: 'cancelled' }, { automationState: 'failed' },
      { automationState: 'withdrawn' }, { withdrawnAt: now }, { retentionPurgingAt: now },
      { refundStatus: 'pending' }, { refundStatus: 'completed' }, { automationRefundDueAt: now },
      { paymentStatus: 'unpaid' },
    ]) expect(classifyOrder(paid(extra), undefined, now)).toBeNull();
    for (const extra of [{ submissionStatus: 'unrecognized' }, { automationState: 'owner_approve' }]) {
      expect(classifyOrder(paid(extra), undefined, now)).toEqual({ state: 'unknown', ageMs: null });
    }
  });

  it('normalizes supported clocks and rejects invalid timestamps', () => {
    const createdAt = now - HOUR;
    for (const value of [createdAt, new Date(createdAt), Timestamp.fromMillis(createdAt)]) {
      expect(timestampMs(value, now)).toBe(createdAt);
    }
    for (const value of [undefined, String(createdAt), new Date(NaN), now + 1, createdAt + 0.5]) {
      expect(timestampMs(value, now)).toBeNull();
    }
  });

  it.each(['stripe', 'sumup', undefined])('uses checkout paidAt for provider %s', paymentProvider => {
    const order = paid({
      submissionStatus: 'awaiting_upload', paymentProvider,
      createdAt: now - 3 * HOUR, paidAt: now - 2 * HOUR, updatedAt: now - HOUR,
    });
    expect(classifyOrder(order, undefined, now)).toEqual({ state: 'awaiting_upload', ageMs: 2 * HOUR });
  });

  it('keeps checkout age unknown when the provider, chronology or transition evidence is inconclusive', () => {
    const order = paid({
      submissionStatus: 'awaiting_upload', paymentProvider: 'stripe',
      createdAt: now - 2 * HOUR, paidAt: now - HOUR,
    });
    for (const extra of [
      { paymentProvider: 'unrecognized' }, { paymentProvider: 'Stripe' }, { paymentProvider: 'parent_service' },
      { paidAt: now - 3 * HOUR }, { paidAt: now + 1 }, { createdAt: now + 1 },
      { statusChangedAt: 'invalid' }, { statusChangedAt: now + 1 }, { automationState: 'submitting' },
    ]) {
      expect(classifyOrder({ ...order, ...extra }, undefined, now))
        .toEqual({ state: 'awaiting_upload', ageMs: null });
    }
  });

  it('uses creation for a concierge child after edits and requires both billing markers', () => {
    const child = paid({
      submissionStatus: 'awaiting_upload', billingMode: 'application_concierge', paymentProvider: 'parent_service',
      createdAt: now - 2 * HOUR, updatedAt: now - HOUR,
    });
    expect(classifyOrder(child, undefined, now)?.ageMs).toBe(2 * HOUR);
    for (const extra of [
      { billingMode: undefined }, { paymentProvider: undefined }, { paymentProvider: 'stripe', paidAt: now },
      { paidAt: now }, { createdAt: now + 1 }, { statusChangedAt: now + 1 },
    ]) expect(classifyOrder({ ...child, ...extra }, undefined, now)?.ageMs).toBeNull();
  });
});

describe('assisted application SLA report I/O', () => {
  it('pages projected paid documents, only reads relevant flows and keeps dry run aggregate-only', async () => {
    const dependencies = fixture(
      [...Array.from({ length: 200 }, () => baseLate), paid({ automationState: 'owner_review' }),
        paid({ submissionStatus: 'submitted', automationState: 'owner_review' })],
      ownerFlow('owner_review', HOUR),
    );
    const gh = vi.fn();
    const report = await runReport(parseArgs(['--json'], {}), { ...dependencies, nowMs: now, gh });
    expect(dependencies.where).toHaveBeenCalledWith('paymentStatus', '==', 'paid');
    expect(dependencies.query.orderBy).toHaveBeenCalledWith('document-id');
    const fields = dependencies.query.select.mock.calls.flat();
    expect(fields).toContain('paymentProvider');
    for (const forbidden of ['customerEmail', 'applicantName', 'cvStorageKey', 'amountTotal', 'companyName', 'updatedAt']) {
      expect(fields).not.toContain(forbidden);
    }
    expect(dependencies.pages).toEqual([200, 200]);
    expect(dependencies.flowReads).toEqual(['synthetic-200']);
    expect(report).toMatchObject({ total: 201, overdue: 200, unknownAge: 0 });
    expect(JSON.stringify(report)).not.toContain('synthetic-');
    expect(dependencies.set).not.toHaveBeenCalled();
    expect(gh).not.toHaveBeenCalled();
  });

  it('probes the cap and aborts before any side effects on truncation', async () => {
    const gh = vi.fn();
    const options = parseArgs(['--record', '--notify', '--private-repo', repo], {});
    const tooMany = fixture(Array.from({ length: 2_001 }, () => baseLate));
    await expect(runReport(options, { ...tooMany, gh })).rejects.toThrow('exceeds cap');
    expect(tooMany.pages).toEqual([...Array(10).fill(200), 1]);
    expect(tooMany.set).not.toHaveBeenCalled();
    expect(gh).not.toHaveBeenCalled();
    const exact = fixture(Array.from({ length: 2_000 }, () => baseLate));
    await expect(runReport(parseArgs([], {}), { ...exact, nowMs: now })).resolves.toMatchObject({ total: 2_000 });
  });

  it('records only the aggregate in the hourly UTC document', async () => {
    const dependencies = fixture([baseLate]);
    const report = await runReport(parseArgs(['--record'], {}), { ...dependencies, nowMs: now });
    expect(dependencies.doc).toHaveBeenCalledWith(new Date(Math.floor(now / HOUR) * HOUR).toISOString());
    expect(dependencies.set).toHaveBeenCalledExactlyOnceWith(report);
    expect(JSON.stringify(report)).not.toContain('synthetic-');
  });

  it('fails closed for CI, public, internal, missing or mismatched visibility evidence', async () => {
    const args = ['--notify', '--private-repo', repo];
    expect(() => parseArgs(args, { GITHUB_ACTIONS: 'true' })).toThrow('GitHub Actions');
    expect(() => parseArgs(['--notify'], {})).toThrow('OWNER/NAME');
    const options = parseArgs(args, {});
    for (const [visibility, slug] of [
      ['PUBLIC', repo], ['INTERNAL', repo], [undefined, repo], ['PRIVATE', 'synthetic-owner/different'],
    ] as const) {
      const { gh } = github(visibility, [], slug);
      await expect(runReport(options, { ...fixture([baseLate]), env: {}, gh })).rejects.toThrow('PRIVATE');
      expect(gh).toHaveBeenCalledTimes(1);
    }
  });

  it('checks visibility again before a write and rejects duplicate exact titles', async () => {
    const options = parseArgs(['--notify', '--private-repo', repo], {});
    const dependencies = { ...fixture([baseLate]), nowMs: now, env: {} };
    const { gh } = github('PUBLIC');
    gh.mockReturnValueOnce(JSON.stringify({ nameWithOwner: repo, visibility: 'PRIVATE' }));
    await expect(runReport(options, { ...dependencies, gh })).rejects.toThrow('PRIVATE');
    expect(gh.mock.calls.map(([args]) => args[1])).toEqual(['view', 'list', 'view']);

    const duplicate = github('PRIVATE', [
      { number: 23, title: ISSUE_TITLE }, { number: 24, title: ISSUE_TITLE },
    ]);
    await expect(runReport(options, { ...dependencies, gh: duplicate.gh })).rejects.toThrow('Multiple open');
    expect(duplicate.gh).toHaveBeenCalledTimes(2);
  });

  it('creates or updates the exact issue, and closes only a fully healthy report', async () => {
    const options = parseArgs(['--notify', '--private-repo', repo], {});
    const target = { number: 23, title: ISSUE_TITLE };
    const similar = { number: 24, title: `${ISSUE_TITLE} (archived)` };
    for (const issues of [[similar], [similar, target]]) {
      const { gh, bodies, paths } = github('PRIVATE', issues);
      const report = await runReport(options, { ...fixture([baseLate]), nowMs: now, env: {}, gh });
      expect(bodies).toEqual(['- `synthetic-0` — `in_progress`']);
      expect(existsSync(paths[0])).toBe(false);
      expect(JSON.stringify(report)).not.toContain('synthetic-0');
      expect(gh.mock.calls.at(-2)?.[0].slice(0, 2)).toEqual(['repo', 'view']);
      expect(gh.mock.calls.at(-1)?.[0].slice(0, 3))
        .toEqual(issues.includes(target) ? ['issue', 'edit', '23'] : ['issue', 'create', '--title']);
    }
    const { gh } = github('PRIVATE', [target]);
    await runReport(options, { ...fixture([paid()]), nowMs: now, env: {}, gh });
    expect(gh.mock.calls.some(([args]) => args[1] === 'close')).toBe(false);
    await runReport(options, { ...fixture([]), nowMs: now, env: {}, gh });
    expect(gh.mock.calls.at(-1)?.[0]).toEqual(['issue', 'close', '23', '--repo', `github.com/${repo}`]);
  });
});
