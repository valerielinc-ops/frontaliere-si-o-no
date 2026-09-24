import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { createCrawlerGenerationLedgerEntry } from '../scripts/crawler-group-generation-finalizer.mjs';
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

  it('surfaces a tokenless newest wave instead of silently falling back to an older generation', () => {
    const tokenless = ['generation_token_missing', 'receipt_missing'];
    const entries = [
      ...wave('400-1', '2026-09-24T10:00:00.000Z'),
      ...GROUPS.map((group) => entry({ group, token: null, reasons: tokenless, at: '2026-09-24T15:00:00.000Z' })),
      // Tokenless and older than the judged generation: history, not evidence against it.
      entry({ group: '01', token: null, reasons: tokenless, at: '2026-09-24T08:00:00.000Z' }),
    ];
    const selection = selectSettledGenerationToken(entries, { now, settleMs: 2 * HOUR, minGroups: 2 });
    expect(selection.token).toBe('400-1');
    expect(selection.tokenlessSince).toBe(Date.parse('2026-09-24T10:00:00.000Z'));
    expect(selection.skipped).toEqual([{ token: null, groups: 4, reason: 'token_missing' }]);
    const report = evaluateCrawlerGenerationDelivery({
      entries,
      generationToken: selection.token,
      expectedGroupIds: GROUPS,
      tokenlessSince: selection.tokenlessSince,
    });
    expect(report.delivered).toBe(false);
    expect(report.counts).toMatchObject({ published: 0, token_missing: 4 });
  });

  it('bounds tokenless evidence to -Infinity when nothing is judged', () => {
    const entries = [entry({ group: '01', token: null, reasons: ['generation_token_missing'], at: '2026-09-24T01:00:00.000Z' })];
    const selection = selectSettledGenerationToken(entries, { now, settleMs: 2 * HOUR, minGroups: 2 });
    expect(selection).toEqual({
      token: null,
      firstAt: null,
      tokenlessSince: -Infinity,
      skipped: [{ token: null, groups: 1, reason: 'token_missing' }],
    });
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

  it('does not let tokenless records of a newer wave hide behind an older published generation', () => {
    const files = fixture([
      ...GROUPS.map((group) => entry({ group, token: '500-1', reasons: [], at })),
      entry({ group: '02', token: null, reasons: ['generation_token_missing', 'receipt_missing'], at: '2026-09-24T15:00:00.000Z', runId: '600' }),
      entry({ group: '03', token: null, reasons: ['generation_token_missing', 'receipt_missing'], at: '2026-09-24T15:05:00.000Z', runId: '601' }),
    ]);
    let out = '';
    const result = runCrawlerGenerationDeliveryCheck(
      parseArgs(['--ledger', files.ledger, '--roster', files.roster, '--now', now]),
      { stdout: (text: string) => { out += text; }, summaryPath: files.summary },
    );
    expect(result.generationToken).toBe('500-1');
    expect(result.delivered).toBe(false);
    expect(result.counts).toMatchObject({ published: 2, token_missing: 2 });
    expect(result.groups['02']).toMatchObject({ state: 'token_missing', callerRunId: '600' });
    expect(out).toContain('token_missing=2');
  });

  it('lets a newer token-bound rerun supersede an older tokenless record', () => {
    const files = fixture([
      entry({ group: '01', token: null, reasons: ['generation_token_missing', 'receipt_missing'], at: '2026-09-24T09:00:00.000Z' }),
      ...GROUPS.map((group) => entry({ group, token: '500-1', reasons: [], at })),
    ]);
    const result = runCrawlerGenerationDeliveryCheck(
      parseArgs(['--ledger', files.ledger, '--roster', files.roster, '--token', '500-1']),
      { stdout: () => {}, summaryPath: files.summary },
    );
    expect(result.delivered).toBe(true);
  });

  it('judges an explicit --token without records as not persisted, not by unrelated tokenless history', () => {
    const files = fixture([
      ...GROUPS.map((group) => entry({ group, token: '500-1', reasons: [], at })),
    ]);
    const result = runCrawlerGenerationDeliveryCheck(
      parseArgs(['--ledger', files.ledger, '--roster', files.roster, '--token', '999-1']),
      { stdout: () => {}, summaryPath: files.summary },
    );
    expect(result.delivered).toBe(false);
    expect(result.counts).toMatchObject({ published: 0, not_persisted: 4 });
  });

  it('surfaces the tokenless wave in skippedTokens', () => {
    const files = fixture([
      ...GROUPS.map((group) => entry({ group, token: '500-1', reasons: [], at })),
      ...GROUPS.map((group) => entry({ group, token: null, reasons: ['generation_token_missing', 'receipt_missing'], at: '2026-09-24T15:00:00.000Z' })),
    ]);
    const result = runCrawlerGenerationDeliveryCheck(
      parseArgs(['--ledger', files.ledger, '--roster', files.roster, '--now', now]),
      { stdout: () => {}, summaryPath: files.summary },
    );
    expect(result.delivered).toBe(false);
    expect(result.counts).toMatchObject({ published: 0, token_missing: 4 });
    expect(result.skippedTokens).toContainEqual({ token: null, groups: 4, reason: 'token_missing' });
  });

  it('counts tokenless records when no settled generation exists', () => {
    const files = fixture([
      entry({ group: '01', token: null, reasons: ['generation_token_missing', 'receipt_missing'], at }),
    ]);
    const result = runCrawlerGenerationDeliveryCheck(
      parseArgs(['--ledger', files.ledger, '--roster', files.roster, '--now', now]),
      { stdout: () => {}, summaryPath: files.summary },
    );
    expect(result.generationToken).toBeNull();
    expect(result.counts).toMatchObject({ token_missing: 1, not_persisted: 3 });
  });

  it('keeps --json stdout parseable and routes the marker to stderr', () => {
    const files = fixture([entry({ group: '01', token: '500-1', reasons: GREEN_UNDELIVERED, at })]);
    let out = '';
    let err = '';
    runCrawlerGenerationDeliveryCheck(
      parseArgs(['--ledger', files.ledger, '--roster', files.roster, '--token', '500-1', '--json']),
      { stdout: (text: string) => { out += text; }, stderr: (text: string) => { err += text; }, summaryPath: files.summary },
    );
    expect(JSON.parse(out).counts.green_undelivered).toBe(1);
    expect(err).toContain('CRAWLER_GENERATION_DELIVERY:');
  });

  it('judges a missing ledger as undelivered instead of crashing', () => {
    const files = fixture([]);
    fs.rmSync(files.ledger);
    const result = runCrawlerGenerationDeliveryCheck(
      parseArgs(['--ledger', files.ledger, '--roster', files.roster, '--now', now]),
      { stdout: () => {}, summaryPath: files.summary },
    );
    expect(result).toMatchObject({ delivered: false, generationToken: null });
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

describe('finalizer import closure', () => {
  // Corpus artifacts pin the finalizer closure path by path; a new import
  // would be missing from the corpus caller until the next mirror sync.
  it('leaves the finalizer free of the delivery module', () => {
    const source = fs.readFileSync(path.resolve('scripts/crawler-group-generation-finalizer.mjs'), 'utf8');
    expect(source).not.toContain('crawler-generation-delivery');
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
