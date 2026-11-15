/**
 * Telemetria generica dei sender (perf-plan email senders, A1): stessa
 * meccanica della jobalert, tag e fasi dichiarati da ogni sender; il contatore
 * Firestore conta anche `count()` (AggregateQuery.get).
 */
import { describe, expect, it } from 'vitest';
import {
  createSenderMetrics,
  emitSenderMetrics,
  formatSenderMetricsLine,
  formatSenderMetricsMarkdown,
} from '../scripts/lib/sender-metrics.mjs';
import { createJobAlertMetrics, formatJobAlertMetricsLine } from '../scripts/lib/job-alert-metrics.mjs';
import { installFirestoreOpCounter } from '../scripts/lib/firestore-op-counter.mjs';

const COMPANY_PHASES = ['load_jobs', 'load_alerts', 'planning', 'consent', 'send', 'persist'] as const;

function clock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('createSenderMetrics', () => {
  it('ordina le fasi dichiarate e somma le fasi alternate', () => {
    const c = clock();
    const metrics = createSenderMetrics({ tag: 'COMPANYALERT', phases: COMPANY_PHASES, now: c.now, memory: () => ({ heapUsed: 1, rss: 2 }) });
    metrics.enter('send'); c.advance(30);
    metrics.enter('planning'); c.advance(20);
    metrics.enter('send'); c.advance(10);
    metrics.enter('mystery'); c.advance(5);
    const snapshot = metrics.snapshot({ date: '2026-11-15', mode: 'DRY RUN' });
    expect(Object.keys(snapshot.phases)).toEqual(['planning', 'send', 'other', 'mystery'].sort((a, b) => {
      const order = [...COMPANY_PHASES, 'other', 'mystery'];
      return order.indexOf(a as any) - order.indexOf(b as any);
    }).filter((name) => name in snapshot.phases));
    expect(snapshot.phases.send.ms).toBe(40);
    expect(snapshot.phases.planning.ms).toBe(20);
    expect(snapshot.totals.ms).toBe(65);
    expect(snapshot).toMatchObject({ v: 1, date: '2026-11-15', mode: 'DRY RUN' });
  });

  it('attribuisce letture/scritture alla fase corrente e non porta mai id di documento', () => {
    const metrics = createSenderMetrics({ tag: 'X', phases: ['a', 'b'], now: () => 0, memory: () => ({ heapUsed: 0, rss: 0 }) });
    metrics.enter('a');
    metrics.recordRead('newsletter_subscribers', 5);
    metrics.enter('b');
    metrics.recordWrite('alerts', 2);
    metrics.recordWrite('alerts', 0);
    metrics.count('emailsSent', 3);
    metrics.set('mode', 'x');
    const snapshot = metrics.snapshot();
    expect(snapshot.phases.a.readsByCollection).toEqual({ newsletter_subscribers: 5 });
    expect(snapshot.phases.b.writesByCollection).toEqual({ alerts: 2 });
    expect(snapshot.counters).toEqual({ emailsSent: 3, mode: 'x' });
    expect(snapshot.totals).toMatchObject({ reads: 5, writes: 2 });
  });

  it('formatta riga <TAG>_METRICS e tabella con i contatori', () => {
    const metrics = createSenderMetrics({ tag: 'NEWSLETTER', phases: ['send'], now: () => 0, memory: () => ({ heapUsed: 1, rss: 1 }) });
    metrics.enter('send');
    metrics.count('emailsSent', 12);
    const snapshot = metrics.snapshot({ date: '2026-11-15', mode: 'LIVE' });
    const line = formatSenderMetricsLine('NEWSLETTER', snapshot);
    expect(line.startsWith('📊 NEWSLETTER_METRICS {')).toBe(true);
    expect(line).not.toContain('\n');
    expect(JSON.parse(line.replace('📊 NEWSLETTER_METRICS ', '')).counters.emailsSent).toBe(12);
    const markdown = formatSenderMetricsMarkdown(snapshot);
    expect(markdown).toContain('| emailsSent | 12 |');
    expect(markdown).toContain('| send |');
  });

  it('emitSenderMetrics scrive la riga e il Job Summary, e non lancia mai', () => {
    const metrics = createSenderMetrics({ tag: 'WINBACK', phases: ['send'], now: () => 0, memory: () => ({ heapUsed: 1, rss: 1 }) });
    metrics.enter('send');
    const logs: string[] = [];
    const appended: string[] = [];
    const snapshot = emitSenderMetrics(metrics, {
      date: '2026-11-15', mode: 'DRY RUN', log: (line: string) => logs.push(line),
      env: { GITHUB_STEP_SUMMARY: '/dev/null/summary.md' }, append: (_t: string, text: string) => appended.push(text),
    });
    expect(snapshot?.mode).toBe('DRY RUN');
    expect(logs[0]).toMatch(/^📊 WINBACK_METRICS \{/);
    expect(appended[0]).toContain('Metriche per fase');

    const warnings: string[] = [];
    const broken = { snapshot() { throw new Error('boom user@example.test'); } };
    expect(emitSenderMetrics(broken, { tag: 'WINBACK', log: () => {}, warn: (line: string) => warnings.push(line) })).toBeNull();
    expect(warnings[0]).toContain('WINBACK_METRICS non emesse');
    expect(warnings[0]).not.toContain('user@example.test');
  });

  it('il wrapper della jobalert mantiene API e riga JOBALERT_METRICS', () => {
    const metrics = createJobAlertMetrics({ now: () => 0, memory: () => ({ heapUsed: 1, rss: 1 }) });
    metrics.enter('planning');
    const snapshot = metrics.snapshot({ date: '2026-11-15', mode: 'LIVE', indexMode: 'on' });
    expect(Object.keys(snapshot).slice(0, 4)).toEqual(['v', 'date', 'mode', 'indexMode']);
    expect(formatJobAlertMetricsLine(snapshot).startsWith('📊 JOBALERT_METRICS {')).toBe(true);
  });
});

describe('contatore operazioni: AggregateQuery.get (count())', () => {
  class WriteBatch { set() { return this; } update() { return this; } create() { return this; } delete() { return this; } }
  class Firestore { async getAll() { return []; } }
  class Query { async get() { return { docs: [] }; } }
  class Transaction { async get() { return {}; } async getAll() { return []; } }
  class AggregateQuery {
    constructor(public _query: any, public total: number) {}
    async get() { return { data: () => ({ count: this.total }) }; }
  }

  it('conta una count() come 1 lettura ogni 1.000 voci (minimo 1) e come aggregateQueries', async () => {
    const metrics = createSenderMetrics({ tag: 'X', phases: ['audience'], now: () => 0, memory: () => ({ heapUsed: 0, rss: 0 }) });
    const uninstall = installFirestoreOpCounter(metrics, { Firestore, Query, Transaction, WriteBatch, AggregateQuery } as any);
    try {
      metrics.enter('audience');
      const q = { _queryOptions: { collectionId: 'newsletter_subscribers' } };
      await new AggregateQuery({ ...q, _queryOptions: q._queryOptions }, 17_400).get();
      await new AggregateQuery({ _queryOptions: { collectionId: 'articles' } }, 0).get();
      const snapshot = metrics.snapshot();
      expect(snapshot.phases.audience.readsByCollection).toEqual({ newsletter_subscribers: 18, articles: 1 });
      expect(snapshot.counters.aggregateQueries).toBe(2);
    } finally { uninstall(); }
  });

  it('non aggancia due volte e riconosce il marcatore storico', () => {
    const metrics = createSenderMetrics({ tag: 'X', phases: [], now: () => 0, memory: () => ({ heapUsed: 0, rss: 0 }) });
    class Legacy { set() { return this; } }
    (Legacy.prototype.set as any).__jobAlertOpCounter = true;
    const noop = installFirestoreOpCounter(metrics, { WriteBatch: Legacy } as any);
    expect((Legacy.prototype.set as any).__senderOpCounter).toBeUndefined();
    noop();
    const uninstall = installFirestoreOpCounter(metrics, { Firestore, Query, Transaction, WriteBatch, AggregateQuery } as any);
    const second = installFirestoreOpCounter(metrics, { Firestore, Query, Transaction, WriteBatch, AggregateQuery } as any);
    second();
    uninstall();
  });
});
