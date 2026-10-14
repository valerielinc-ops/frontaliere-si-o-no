import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { portalPassFrom, portalPassRecord } from '../scripts/assisted-application/lib/portal/stop-report.mjs';
import { readPortalPass, reportPortalOutcome } from '../scripts/assisted-application/report-portal-stop.mjs';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'assisted-application-portal-stop-'));
  tempDirs.push(dir);
  return dir;
}

function writeJson(file: string, value: unknown) {
  writeFileSync(file, JSON.stringify(value));
}

function pass(host: string, overrides: Record<string, unknown> = {}) {
  return {
    host,
    channel: 'successfactors',
    mode: 'submit',
    step: 7,
    stage: 'submitted',
    ...overrides,
  };
}

function stop(host: string) {
  return {
    host,
    path: '/career',
    reason: 'account',
    channel: 'successfactors',
    step: 3,
    buttons: [],
    fields: [],
    errors: [],
    agent: [],
  };
}

const runUrl = 'https://github.com/example/repo/actions/runs/123';

describe('recupero delle issue portal-stop', () => {
  it('emette il pass solo dopo il segnale del runner e lo scrive senza dati personali', () => {
    const submitted = portalPassFrom({
      applyUrl: 'https://career5.successfactors.eu/career/apply/123',
      channel: 'successfactors',
      event: { type: 'submit_succeeded' },
      evidence: { finalUrl: 'https://career5.successfactors.eu/confirmation', steps: [{}, {}, {}] },
      dryRun: false,
    });
    expect(submitted).toEqual({ host: 'career5.successfactors.eu', channel: 'successfactors', step: 3, stage: 'submitted' });
    expect(portalPassFrom({
      applyUrl: 'https://career5.successfactors.eu/career/apply/123',
      channel: 'successfactors',
      event: { type: 'dry_run_ready' },
      evidence: { finalButton: { label: 'Invia' }, steps: [{}, {}, {}, {}] },
      dryRun: true,
    })).toMatchObject({ host: 'career5.successfactors.eu', step: 4, stage: 'final_review' });
    expect(portalPassFrom({
      applyUrl: 'https://career5.successfactors.eu/career/apply/123',
      channel: 'successfactors',
      event: { type: 'submit_failed' },
      evidence: { steps: [{}, {}] },
      dryRun: false,
    })).toBeNull();

    const dir = fixture();
    const file = join(dir, 'portal-pass.json');
    writeFileSync(file, JSON.stringify(portalPassRecord(submitted, 'submit')));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ host: 'career5.successfactors.eu', channel: 'successfactors', mode: 'submit', step: 3, stage: 'submitted' });
    expect(readPortalPass(file)).toEqual(expect.objectContaining({ host: 'career5.successfactors.eu', mode: 'submit' }));
  });

  it('chiude la issue aperta dell’host dopo un pass senza stop report', async () => {
    const dir = fixture();
    const portalPass = join(dir, 'portal-pass.json');
    writeJson(portalPass, pass('career5.successfactors.eu'));
    const findOpenIssues = vi.fn(() => ([
      { number: 11914, title: '[portal-stop] career5.successfactors.eu: account del portale su /career', url: 'issue-url' },
    ]));
    const resolveIssueByNumber = vi.fn(() => ({ number: 11914, persisted: true }));

    await reportPortalOutcome({
      stopReportFile: join(dir, 'missing-stop.json'),
      portalPassFile: portalPass,
      runUrl,
      findOpenIssues,
      resolveIssueByNumber,
      createIssue: vi.fn(),
    });

    expect(findOpenIssues).toHaveBeenCalledWith('[portal-stop] career5.successfactors.eu:');
    expect(resolveIssueByNumber).toHaveBeenCalledWith(11914, expect.objectContaining({
      expectedTitle: '[portal-stop] career5.successfactors.eu: account del portale su /career',
      runUrl,
      preface: expect.stringContaining('career5.successfactors.eu'),
    }));
    expect(resolveIssueByNumber.mock.calls[0][1].preface).toContain('submit');
    expect(resolveIssueByNumber.mock.calls[0][1].preface).toContain('7');
  });

  it('non chiude l’host B quando il pass riguarda l’host A', async () => {
    const dir = fixture();
    const portalPass = join(dir, 'portal-pass.json');
    writeJson(portalPass, pass('host-a.example'));
    const resolveIssueByNumber = vi.fn(() => ({ persisted: true }));

    await reportPortalOutcome({
      stopReportFile: join(dir, 'missing-stop.json'),
      portalPassFile: portalPass,
      runUrl,
      findOpenIssues: vi.fn(() => [
        { number: 10, title: '[portal-stop] host-a.example: account su /apply' },
        { number: 11, title: '[portal-stop] host-b.example: account su /apply' },
      ]),
      resolveIssueByNumber,
      createIssue: vi.fn(),
    });

    expect(resolveIssueByNumber).toHaveBeenCalledTimes(1);
    expect(resolveIssueByNumber).toHaveBeenCalledWith(10, expect.any(Object));
  });

  it('non chiude lo stesso host quando la run ha prodotto uno stop report', async () => {
    const dir = fixture();
    const stopReport = join(dir, 'portal-stop.json');
    const portalPass = join(dir, 'portal-pass.json');
    writeJson(stopReport, stop('career5.successfactors.eu'));
    writeJson(portalPass, pass('career5.successfactors.eu'));
    const createIssue = vi.fn(async () => ({ number: 120, persisted: true }));
    const resolveIssueByNumber = vi.fn();

    await reportPortalOutcome({
      stopReportFile: stopReport,
      portalPassFile: portalPass,
      runUrl,
      findOpenIssues: vi.fn(),
      resolveIssueByNumber,
      createIssue,
    });

    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(resolveIssueByNumber).not.toHaveBeenCalled();
  });

  it('senza stop report né portal pass non effettua chiamate', async () => {
    const dir = fixture();
    const findOpenIssues = vi.fn();
    const resolveIssueByNumber = vi.fn();
    const createIssue = vi.fn();

    await reportPortalOutcome({
      stopReportFile: join(dir, 'missing-stop.json'),
      portalPassFile: join(dir, 'missing-pass.json'),
      runUrl,
      findOpenIssues,
      resolveIssueByNumber,
      createIssue,
    });

    expect(findOpenIssues).not.toHaveBeenCalled();
    expect(resolveIssueByNumber).not.toHaveBeenCalled();
    expect(createIssue).not.toHaveBeenCalled();
  });

  it('chiude tutte le issue aperte dello stesso host, non solo la più recente', async () => {
    const dir = fixture();
    const portalPass = join(dir, 'portal-pass.json');
    writeJson(portalPass, pass('career5.successfactors.eu', { mode: 'dry_run', stage: 'final_review', step: 9 }));
    const resolveIssueByNumber = vi.fn(() => ({ persisted: true }));
    const issues = [
      { number: 12092, title: '[portal-stop] career5.successfactors.eu: pagina non superata su /career' },
      { number: 11914, title: '[portal-stop] career5.successfactors.eu: account del portale su /career' },
    ];

    await reportPortalOutcome({
      stopReportFile: join(dir, 'missing-stop.json'),
      portalPassFile: portalPass,
      runUrl,
      findOpenIssues: vi.fn(() => issues),
      resolveIssueByNumber,
      createIssue: vi.fn(),
    });

    expect(resolveIssueByNumber).toHaveBeenCalledTimes(2);
    expect(resolveIssueByNumber.mock.calls.map(([number]) => number)).toEqual([12092, 11914]);
    for (const [, options] of resolveIssueByNumber.mock.calls) {
      expect(options.preface).toContain('dry_run');
      expect(options.preface).toContain('final_review');
      expect(options.preface).toContain('9');
    }
  });
});
