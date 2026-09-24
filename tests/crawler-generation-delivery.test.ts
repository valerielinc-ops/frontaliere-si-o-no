import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  createCrawlerGenerationLedgerEntry,
  reportCrawlerGroupDelivery,
} from '../scripts/crawler-group-generation-finalizer.mjs';
import {
  classifyCrawlerDelivery,
  evaluateCrawlerGenerationDelivery,
  selectSettledGenerationToken,
} from '../scripts/lib/crawler-generation-delivery.mjs';
import { parseArgs, runCrawlerGenerationDeliveryCheck } from '../scripts/check-crawler-generation-delivery.mjs';

const HASH = `sha256:${'a'.repeat(64)}`;
const COMMIT = 'b'.repeat(40);
const GROUPS = ['01', '02', '03', '04'];
const HOUR = 60 * 60 * 1_000;

type Row = { group: string; token: string | null; reasons: string[]; at: string; runId?: string };

function entry({ group, token, reasons, at, runId = '100' }: Row) {
  return createCrawlerGenerationLedgerEntry({
    group,
    generationToken: token,
    callerRepository: 'nanakokyobashi-rgb/frontaliere-articles',
    callerRunId: runId,
    callerRunAttempt: 1,
    checkedAt: at,
    remote: { commit: COMMIT },
    digest: HASH,
    valid: reasons.length === 0,
    reasons,
  });
}

// Shape of wave 36010271578-1 on origin/main: group 07 concluded `success`
// on GitHub while its receipt commit lost the race to main.
const GREEN_UNDELIVERED = ['receipt_commit_not_ancestor', 'receipt_failed'];
const CRAWLER_FAILED = ['receipt_missing', 'wait_failed'];

describe('classifyCrawlerDelivery', () => {
  it('separates a green run without delivery from a failed crawl', () => {
    expect(classifyCrawlerDelivery({ generationToken: 't-1', valid: true, reasons: [] })).toBe('published');
    expect(classifyCrawlerDelivery({ generationToken: 't-1', valid: false, reasons: GREEN_UNDELIVERED })).toBe('green_undelivered');
    expect(classifyCrawlerDelivery({ generationToken: 't-1', valid: false, reasons: ['ledger_persistence_failed'] })).toBe('green_undelivered');
    expect(classifyCrawlerDelivery({ generationToken: 't-1', valid: false, reasons: CRAWLER_FAILED })).toBe('crawler_failed');
    expect(classifyCrawlerDelivery({ generationToken: null, valid: false, reasons: ['generation_token_missing'] })).toBe('token_missing');
    expect(classifyCrawlerDelivery(null)).toBe('not_persisted');
  });
});

describe('evaluateCrawlerGenerationDelivery', () => {
  const at = '2026-09-24T10:00:00.000Z';

  it('is delivered only when every expected group published', () => {
    const entries = GROUPS.map((group) => entry({ group, token: '500-1', reasons: [], at }));
    const report = evaluateCrawlerGenerationDelivery({ entries, generationToken: '500-1', expectedGroupIds: GROUPS });
    expect(report.delivered).toBe(true);
    expect(report.counts.published).toBe(4);
  });

  it('reports green-undelivered, failed and never-persisted groups separately', () => {
    const entries = [
      entry({ group: '01', token: '500-1', reasons: [], at }),
      entry({ group: '02', token: '500-1', reasons: GREEN_UNDELIVERED, at }),
      entry({ group: '03', token: '500-1', reasons: CRAWLER_FAILED, at }),
      entry({ group: '04', token: '499-1', reasons: [], at }),
    ];
    const report = evaluateCrawlerGenerationDelivery({ entries, generationToken: '500-1', expectedGroupIds: GROUPS });
    expect(report.delivered).toBe(false);
    expect(report.counts).toEqual({ published: 1, green_undelivered: 1, crawler_failed: 1, token_missing: 0, not_persisted: 1 });
    expect(report.groups['02'].reasons).toEqual(GREEN_UNDELIVERED);
    expect(report.groups['04'].state).toBe('not_persisted');
  });

  it('uses the newest record when a group was rerun', () => {
    const entries = [
      entry({ group: '01', token: '500-1', reasons: GREEN_UNDELIVERED, at: '2026-09-24T10:00:00.000Z' }),
      entry({ group: '01', token: '500-1', reasons: [], at: '2026-09-24T11:00:00.000Z', runId: '101' }),
    ];
    const report = evaluateCrawlerGenerationDelivery({ entries, generationToken: '500-1', expectedGroupIds: ['01'] });
    expect(report.groups['01']).toMatchObject({ state: 'published', callerRunId: '101' });
  });
});

describe('selectSettledGenerationToken', () => {
  const now = Date.parse('2026-09-24T20:00:00.000Z');
  const wave = (token: string, at: string) => GROUPS.map((group) => entry({ group, token, reasons: [], at }));

  it('skips a wave still finalizing and single-group manual runs', () => {
    const entries = [
      ...wave('400-1', '2026-09-24T10:00:00.000Z'),
      entry({ group: '01', token: '450-1', reasons: [], at: '2026-09-24T12:00:00.000Z' }),
      ...wave('500-1', '2026-09-24T19:30:00.000Z'),
    ];
    const selection = selectSettledGenerationToken(entries, { now, settleMs: 2 * HOUR, minGroups: 2 });
    expect(selection.token).toBe('400-1');
    expect(selection.skipped).toEqual([
      { token: '500-1', groups: 4, reason: 'unsettled' },
      { token: '450-1', groups: 1, reason: 'partial' },
    ]);
  });
});

function fixture(entries: object[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-delivery-'));
  const ledger = path.join(dir, 'ledger.jsonl');
  const roster = path.join(dir, 'roster.json');
  const summary = path.join(dir, 'summary.md');
  fs.writeFileSync(ledger, entries.map((item) => `${JSON.stringify(item)}\n`).join(''));
  fs.writeFileSync(roster, JSON.stringify({ groups: Object.fromEntries(GROUPS.map((group) => [group, ['x']])) }));
  return { ledger, roster, summary };
}

describe('check-crawler-generation-delivery CLI', () => {
  const at = '2026-09-24T10:00:00.000Z';
  const now = '2026-09-24T20:00:00.000Z';

  it('fails a generation whose green runs did not publish and names them', () => {
    const files = fixture([
      entry({ group: '01', token: '500-1', reasons: [], at }),
      entry({ group: '02', token: '500-1', reasons: GREEN_UNDELIVERED, at }),
      entry({ group: '03', token: '500-1', reasons: [], at }),
      entry({ group: '04', token: '500-1', reasons: [], at }),
    ]);
    let out = '';
    const result = runCrawlerGenerationDeliveryCheck(
      parseArgs(['--ledger', files.ledger, '--roster', files.roster, '--now', now]),
      { stdout: (text: string) => { out += text; }, summaryPath: files.summary },
    );
    expect(result.delivered).toBe(false);
    expect(out).toContain('CRAWLER_GENERATION_DELIVERY: token=500-1 published=3/4 green_undelivered=1');
    expect(out).toContain('verdict=undelivered');
    expect(out).toContain('::error title=Crawler generation not delivered::');
    expect(out).toMatch(/\| 02 \| green_undelivered \| receipt_commit_not_ancestor, receipt_failed \|/);
    expect(fs.readFileSync(files.summary, 'utf8')).toContain('Green but undelivered: **1**');
  });

  it('passes only at N/N published', () => {
    const files = fixture(GROUPS.map((group) => entry({ group, token: '500-1', reasons: [], at })));
    let out = '';
    const result = runCrawlerGenerationDeliveryCheck(
      parseArgs(['--ledger', files.ledger, '--roster', files.roster, '--now', now]),
      { stdout: (text: string) => { out += text; }, summaryPath: files.summary },
    );
    expect(result.delivered).toBe(true);
    expect(out).toContain('published=4/4');
    expect(out).not.toContain('::error');
  });

  it('fails closed when no settled generation exists', () => {
    const files = fixture([entry({ group: '01', token: '500-1', reasons: [], at: '2026-09-24T19:50:00.000Z' })]);
    const result = runCrawlerGenerationDeliveryCheck(
      parseArgs(['--ledger', files.ledger, '--roster', files.roster, '--now', now]),
      { stdout: () => {}, summaryPath: files.summary },
    );
    expect(result.delivered).toBe(false);
    expect(result.generationToken).toBeNull();
  });

  it('rejects a tampered ledger record instead of judging it', () => {
    const tampered = { ...entry({ group: '01', token: '500-1', reasons: GREEN_UNDELIVERED, at }), valid: true, reasons: [] };
    const files = fixture([tampered]);
    expect(() => runCrawlerGenerationDeliveryCheck(
      parseArgs(['--ledger', files.ledger, '--roster', files.roster, '--token', '500-1']),
      { stdout: () => {}, summaryPath: files.summary },
    )).toThrow(/digest_mismatch/);
  });
});

describe('finalizer delivery annotation', () => {
  it('annotates a green group run that published nothing', () => {
    let out = '';
    const summary = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-delivery-')), 'summary.md');
    const outcome = reportCrawlerGroupDelivery(
      { group: '07', generationToken: '36010271578-1', valid: false, reasons: GREEN_UNDELIVERED },
      { stdout: (text: string) => { out += text; }, summaryPath: summary },
    );
    expect(outcome).toBe('green_undelivered');
    expect(out).toContain('CRAWLER_DELIVERY_OUTCOME: green_undelivered');
    expect(out).toContain('::error title=Crawler group delivery not published::group 07');
    expect(fs.readFileSync(summary, 'utf8')).toContain('green run without published delivery');
  });

  it('stays quiet on a published group and on an already-red crawl', () => {
    for (const [reasons, expected] of [[[], 'published'], [CRAWLER_FAILED, 'crawler_failed']] as const) {
      let out = '';
      const outcome = reportCrawlerGroupDelivery(
        { group: '01', generationToken: '1-1', valid: reasons.length === 0, reasons: [...reasons] },
        { stdout: (text: string) => { out += text; }, summaryPath: '' },
      );
      expect(outcome).toBe(expected);
      expect(out).not.toContain('::error');
    }
  });
});

describe('crawler-generation-delivery-gate workflow', () => {
  const workflow = YAML.parse(fs.readFileSync(path.resolve('.github/workflows/crawler-generation-delivery-gate.yml'), 'utf8'));
  const steps = workflow.jobs.gate.steps as Array<Record<string, unknown>>;
  const gate = steps.find((step) => String(step.run ?? '').includes('check-crawler-generation-delivery.mjs'));

  it('runs the gate on a schedule and lets it turn the run red', () => {
    expect(workflow.on.schedule.length).toBeGreaterThan(0);
    expect(gate).toBeDefined();
    expect(gate?.['continue-on-error']).toBeUndefined();
    expect(String(gate?.run)).not.toMatch(/\|\|\s*(true|echo|exit 0)/);
  });

  it('keeps the ledger and roster in the sparse checkout', () => {
    const sparse = String(steps[0].with && (steps[0].with as Record<string, unknown>)['sparse-checkout']);
    expect(sparse).not.toMatch(/!\/data\/crawler-generation-ledger/);
    expect(sparse).not.toMatch(/!\/scripts\//);
  });
});
