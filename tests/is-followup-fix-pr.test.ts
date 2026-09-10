import { describe, it, expect } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  addressedFollowupNumbers,
  fixIssueNumberFromBranch,
  followupItemMarkerIds,
  isPartialDailyFollowupFix,
} from '../scripts/ci/is-followup-fix-pr.mjs';

const FIX_GATE = fileURLToPath(new URL('../scripts/ci/is-followup-fix-pr.mjs', import.meta.url));

// The grandchild-suppression gate (post-merge-followup) anchors on the fixer BRANCH,
// not the PR body, so a prose "closes #N" can never false-positive (regression PR #2214).
// fixIssueNumberFromBranch is the pure core: branch name → fixed issue number | null.
describe('fixIssueNumberFromBranch', () => {
  it('extracts N from the canonical fixer branch `fix/issue-<N>`', () => {
    expect(fixIssueNumberFromBranch('fix/issue-2210')).toBe(2210);
  });

  it('extracts N when the branch carries a descriptive `-slug` suffix', () => {
    expect(fixIssueNumberFromBranch('fix/issue-2177-staticoverlay-hreflang')).toBe(2177);
  });

  it('returns null for an organic feature branch (no prose false-positive)', () => {
    expect(fixIssueNumberFromBranch('break-followup-selffeed')).toBeNull();
    expect(fixIssueNumberFromBranch('feat/per-canton-salary')).toBeNull();
    expect(fixIssueNumberFromBranch('fix/unify-jobtojsonld-listitem')).toBeNull();
  });

  it('does not match a near-miss prefix (must be `fix/issue-` exactly)', () => {
    expect(fixIssueNumberFromBranch('fix/issues-123')).toBeNull();
    expect(fixIssueNumberFromBranch('hotfix/issue-123')).toBeNull();
    expect(fixIssueNumberFromBranch('fix/issue-abc')).toBeNull();
  });

  it('returns null on empty / non-string input (proceed-safe)', () => {
    expect(fixIssueNumberFromBranch('')).toBeNull();
    expect(fixIssueNumberFromBranch(null as unknown as string)).toBeNull();
    expect(fixIssueNumberFromBranch(undefined as unknown as string)).toBeNull();
  });

  it('tolerates surrounding whitespace', () => {
    expect(fixIssueNumberFromBranch('  fix/issue-99  ')).toBe(99);
  });
});

describe('partial daily follow-up PR markers', () => {
  it('reads stable item markers and de-duplicates them case-insensitively', () => {
    expect(
      followupItemMarkerIds(
        'Follow-up item: fu-2026-09-09-001\nFollow-up item: FU-2026-09-09-001\nFollow-up item: FU-2026-09-09-002',
      ),
    ).toEqual(['FU-2026-09-09-001', 'FU-2026-09-09-002']);
  });

  it('accepts only explicit Addresses #N parent references', () => {
    expect(addressedFollowupNumbers('Addresses #123 and addresses #456; related #789')).toEqual([123, 456]);
    expect(addressedFollowupNumbers('Closes #123')).toEqual([]);
  });

  it('requires both marker and Addresses before allowing parent-bucket triage', () => {
    expect(isPartialDailyFollowupFix('Follow-up item: FU-2026-09-09-001\nAddresses #123')).toBe(true);
    expect(isPartialDailyFollowupFix('Follow-up item: FU-2026-09-09-001')).toBe(false);
    expect(isPartialDailyFollowupFix('Addresses #123')).toBe(false);
  });

  it('rejects a closing keyword for the addressed bucket', () => {
    expect(isPartialDailyFollowupFix(
      'Follow-up item: FU-2026-09-09-001\nAddresses #123\nCloses #123',
    )).toBe(false);
  });

  it('rejects a multi-item or multi-parent body at the partial-fix gate', () => {
    expect(isPartialDailyFollowupFix(
      'Follow-up item: FU-2026-09-09-001\nFollow-up item: FU-2026-09-09-002\nAddresses #123',
    )).toBe(false);
    expect(isPartialDailyFollowupFix(
      'Follow-up item: FU-2026-09-09-001\nAddresses #123\nAddresses #456',
    )).toBe(false);
  });

  it('riconosce un branch descrittivo quando Addresses e marker identificano il bucket', () => {
    const dir = mkdtempSync(join(tmpdir(), 'followup-fix-gate-'));
    const ghPath = join(dir, 'gh');
    const outputPath = join(dir, 'github-output');
    const marker = 'FU-2026-09-09-001';
    writeFileSync(ghPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({ headRefName: 'fix/daily-seo', title: 'fix daily item', body: 'Addresses #900\\nFollow-up item: ${marker}' }));
} else if (args[0] === 'issue' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({ labels: [{ name: 'follow-up' }], title: 'follow-up(daily:2026-09-09): 1 item — owner/repo', body: '### ${marker} — item' }));
} else {
  process.stdout.write('{}');
}
`);
    chmodSync(ghPath, 0o755);
    const result = spawnSync('node', [FIX_GATE], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH || ''}`,
        PR_NUMBER: '42',
        GH_REPO: 'owner/repo',
        GITHUB_OUTPUT: outputPath,
      },
    });
    const output = readFileSync(outputPath, 'utf8');
    rmSync(dir, { recursive: true, force: true });
    expect(result.status).toBe(0);
    expect(output).toContain('is_followup_fix=true');
    expect(output).toContain('followup_partial=true');
    expect(output).toContain('followup_parent_issues=900');
  });
});
