import { describe, expect, it, vi } from 'vitest';
import {
  MISSING_LOGOS_ISSUE_TITLE,
  reportIssue,
} from '../scripts/audit-missing-company-logos.mjs';

// The weekly logo audit opened/updated the issue when companies lacked a logo,
// but at 0 anomalies it only logged "nessuna issue da aprire" and left the
// issue open forever (issue 6504): the mirror of the open path was missing.

function report(affectedCompanies: Array<Record<string, unknown>>) {
  return {
    source: { path: 'data/jobs.json', jobCount: 1200 },
    affectedCompanies,
    missing: affectedCompanies.length,
    missingJobCount: affectedCompanies.length,
    broken: 0,
    brokenJobCount: 0,
    partial: 0,
    partialJobCount: 0,
    lowQuality: 0,
    lowQualityJobCount: 0,
    qualityUnverified: 0,
    qualityUnverifiedJobCount: 0,
    unverified: 0,
    unverifiedJobCount: 0,
  };
}

const company = {
  companyKey: 'yellowshark',
  companyName: 'yellowshark AG',
  status: 'missing',
  affectedJobCount: 3,
  examples: { missing: 'https://jobs.example.ch/job/1', broken: null, lowQuality: null, qualityUnverified: null },
};

describe('audit-missing-company-logos reportIssue', () => {
  it('resolves the canonical issue when the audit finds 0 anomalies', async () => {
    const createIssue = vi.fn();
    const resolveIssue = vi.fn(() => null);

    const outcome = await reportIssue(report([]), {
      createIssue,
      resolveIssue,
      runUrl: 'https://github.com/o/r/actions/runs/1',
    });

    expect(createIssue).not.toHaveBeenCalled();
    expect(resolveIssue).toHaveBeenCalledTimes(1);
    expect(resolveIssue).toHaveBeenCalledWith(MISSING_LOGOS_ISSUE_TITLE, {
      workflow: 'audit-missing-company-logos',
      runUrl: 'https://github.com/o/r/actions/runs/1',
    });
    expect(outcome).toBe('resolved');
  });

  it('opens/updates the same issue, without resolving, while anomalies remain', async () => {
    const createIssue = vi.fn();
    const resolveIssue = vi.fn();

    const outcome = await reportIssue(report([company]), { createIssue, resolveIssue });

    expect(resolveIssue).not.toHaveBeenCalled();
    expect(createIssue).toHaveBeenCalledTimes(1);
    const [args] = createIssue.mock.calls[0];
    expect(args.title).toBe(MISSING_LOGOS_ISSUE_TITLE);
    expect(args.workflow).toBe('audit-missing-company-logos');
    expect(args.description).toContain('`yellowshark`');
    expect(outcome).toBe('reported');
  });

  it('does not swallow a close that GitHub refused', async () => {
    const refused = Object.assign(new Error('could not close'), { persisted: false });
    const resolveIssue = vi.fn(() => { throw refused; });

    await expect(reportIssue(report([]), { createIssue: vi.fn(), resolveIssue })).rejects.toBe(refused);
  });
});
