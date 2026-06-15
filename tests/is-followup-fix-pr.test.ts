import { describe, it, expect } from 'vitest';
import { fixIssueNumberFromBranch } from '../scripts/ci/is-followup-fix-pr.mjs';

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
