import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { createCrawlerGenerationLedgerEntry } from '../scripts/crawler-group-generation-finalizer.mjs';
import { parseWorkflowData, validateWorkflowData } from '../scripts/ci/validate-workflow-data.mjs';

const NOW = new Date('2026-10-18T12:00:00.000Z');
const NOW_ISO = NOW.toISOString();

function ledgerEntry(checkedAt: string, group: string, runId: string) {
  return createCrawlerGenerationLedgerEntry({
    schemaVersion: 1,
    group,
    generationToken: '123456-1',
    callerRepository: 'owner/repo',
    callerRunId: runId,
    callerRunAttempt: 1,
    checkedAt,
    remote: { commit: 'a'.repeat(40) },
    digest: `sha256:${'b'.repeat(64)}`,
    valid: true,
    reasons: [],
  });
}

function healthState() {
  return {
    lastSuccessfulRunAt: NOW_ISO,
    lastNonZeroJobs: 4,
    consecutiveEmptyRuns: 0,
    consecutiveEmptyOkRuns: 0,
    advisory: false,
    advisoryReason: null,
    lastFailureReason: null,
    status: 'healthy',
    _lastObservedAt: NOW_ISO,
    _lastObservedJobs: 4,
    _lastObservedEmptyOk: false,
    _lastObservedFreshnessAt: NOW_ISO,
    _lastObservedFreshnessSource: 'summary',
    _lastObservedAssembledAt: NOW_ISO,
    _lastObservedGeneratedAt: NOW_ISO,
    _lastObservedDiscoveredCount: 4,
    _lastObservedWrittenCount: 4,
    _autoFilteredEmpty: false,
  };
}

function fixtures() {
  return {
    'crawler-generation-ledger': [
      ledgerEntry(NOW_ISO, '01', '1'),
      ledgerEntry('2026-10-17T12:00:00.000Z', '02', '2'),
    ],
    'crawler-health': {
      _lastCheckedAt: NOW_ISO,
      crawlers: { 'example-crawler': healthState() },
    },
    'evergreen-pool-history': {
      updatedAt: NOW_ISO,
      entries: [
        { date: '2026-10-17', sections: [{ section: 'frontaliere', poolTotal: 10, poolRemaining: 8, poolConsumedPct: 20 }] },
        { date: '2026-10-18', sections: [{ section: 'frontaliere', poolTotal: 10, poolRemaining: 7, poolConsumedPct: 30 }] },
      ],
    },
    'funnel-metrics-history': {
      updatedAt: NOW_ISO,
      entries: [
        {
          date: '2026-10-17',
          generatedAt: '2026-10-17T12:00:00.000Z',
          cls: null,
          gsc: null,
          adsense: null,
          sourcesOk: { cls: false, gsc: false, adsense: false },
          errors: [],
          warnings: [],
        },
        {
          date: '2026-10-18',
          generatedAt: NOW_ISO,
          cls: null,
          gsc: null,
          adsense: null,
          sourcesOk: { cls: false, gsc: false, adsense: false },
          errors: [],
          warnings: [],
        },
      ],
    },
    'telegram-member-count-history': [
      { date: '2026-10-17', count: 6 },
      { date: '2026-10-18', count: 7 },
    ],
    'pharmacy-google-usage-reservation': {
      schemaVersion: 1,
      month: '2026-10',
      googlePlaces: { requests: 7 },
    },
  } as const;
}

const KINDS = [
  'crawler-generation-ledger',
  'crawler-health',
  'evergreen-pool-history',
  'funnel-metrics-history',
  'telegram-member-count-history',
  'pharmacy-google-usage-reservation',
] as const;

describe('validate-workflow-data', () => {
  it.each(KINDS)('accepts a valid %s artifact', async (kind) => {
    expect(await validateWorkflowData(kind, fixtures()[kind], { now: NOW })).toEqual([]);
  });

  it.each([
    ['crawler-generation-ledger', (value: any) => delete value[0].digest],
    ['crawler-health', (value: any) => delete value.crawlers['example-crawler']._lastObservedAt],
    ['evergreen-pool-history', (value: any) => delete value.entries[0].sections],
    ['funnel-metrics-history', (value: any) => delete value.entries[0].sourcesOk],
    ['telegram-member-count-history', (value: any) => delete value[0].count],
    ['pharmacy-google-usage-reservation', (value: any) => delete value.googlePlaces.requests],
  ] as const)('rejects a %s artifact with a missing required field', async (kind, removeField) => {
    const value: any = structuredClone(fixtures()[kind]);
    removeField(value);
    expect((await validateWorkflowData(kind, value, { now: NOW })).length).toBeGreaterThan(0);
  });

  it('rejects an ISO timestamp beyond the five-minute future tolerance', async () => {
    const value: any = structuredClone(fixtures()['crawler-health']);
    value.crawlers['example-crawler']._lastObservedAt = '2026-10-18T12:06:00.000Z';
    expect((await validateWorkflowData('crawler-health', value, { now: NOW })).join('\n'))
      .toContain('futuro oltre');
  });

  it('rejects an ISO timestamp with an impossible calendar date', async () => {
    const value: any = structuredClone(fixtures()['crawler-health']);
    value.crawlers['example-crawler']._lastObservedAt = '2026-02-29T12:00:00.000Z';
    expect((await validateWorkflowData('crawler-health', value, { now: NOW })).join('\n'))
      .toContain('timestamp ISO non valido');
  });

  it.each([
    ['crawler-generation-ledger', (value: any) => { value[0].checkedAt = 'not-an-iso'; }],
    ['crawler-health', (value: any) => { value._lastCheckedAt = 'not-an-iso'; }],
    ['evergreen-pool-history', (value: any) => { value.updatedAt = 'not-an-iso'; }],
    ['funnel-metrics-history', (value: any) => { value.entries[1].generatedAt = 'not-an-iso'; }],
    ['telegram-member-count-history', (value: any) => { value[0].date = 'not-a-date'; }],
    ['pharmacy-google-usage-reservation', (value: any) => { value.month = '2026-13'; }],
  ] as const)('rejects a %s artifact with an invalid timestamp/date field', async (kind, corruptTimestamp) => {
    const value: any = structuredClone(fixtures()[kind]);
    corruptTimestamp(value);
    expect((await validateWorkflowData(kind, value, { now: NOW })).length).toBeGreaterThan(0);
  });

  it.each([
    'crawler-generation-ledger',
    'evergreen-pool-history',
    'funnel-metrics-history',
    'telegram-member-count-history',
  ] as const)('rejects a shortened append-only %s history', async (kind) => {
    const baseline: any = structuredClone(fixtures()[kind]);
    const value: any = structuredClone(baseline);
    if (Array.isArray(value)) value.pop();
    else value.entries.pop();
    expect((await validateWorkflowData(kind, value, { baselineValue: baseline, now: NOW })).join('\n'))
      .toContain('storico accorciato');
  });

  it.each(['crawler-generation-ledger', 'telegram-member-count-history'] as const)(
    'rejects a broken JSONL line in %s',
    (kind) => {
      const line = kind === 'crawler-generation-ledger'
        ? JSON.stringify(fixtures()[kind][0])
        : JSON.stringify(fixtures()[kind][0]);
      const parsed = parseWorkflowData(kind, `${line}\n{broken-json}\n`);
      expect(parsed.errors.length).toBeGreaterThan(0);
    },
  );

  it('returns non-zero from the CLI for an invalid artifact and zero for a valid one', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-workflow-data-'));
    try {
      const file = path.join(temp, 'funnel.json');
      const baseline = path.join(temp, 'baseline.json');
      const valid = fixtures()['funnel-metrics-history'];
      fs.writeFileSync(file, `${JSON.stringify(valid)}\n`);
      fs.writeFileSync(baseline, `${JSON.stringify(valid)}\n`);
      const args = [
        'scripts/ci/validate-workflow-data.mjs',
        '--kind', 'funnel-metrics-history',
        '--file', file,
        '--baseline-file', baseline,
      ];
      const passed = spawnSync(process.execPath, args, { cwd: path.resolve(import.meta.dirname, '..') });
      expect(passed.status).toBe(0);

      const invalid = structuredClone(valid);
      delete invalid.entries[0].sourcesOk;
      fs.writeFileSync(file, `${JSON.stringify(invalid)}\n`);
      const failed = spawnSync(process.execPath, args, { cwd: path.resolve(import.meta.dirname, '..') });
      expect(failed.status).not.toBe(0);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
