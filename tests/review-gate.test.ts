import { describe, expect, it } from 'vitest';
import {
  classifyReview,
  followupIssueBody,
  followupItemsFromBody,
  importantFindings,
} from '../scripts/ci/review-gate.mjs';

const DIFF_FILES = ['src/changed.mjs'];
const TREE_FILES = ['src/changed.mjs', 'scripts/legacy.mjs', 'scripts/other.mjs'];

const reviewFor = (path: string, prose: string) =>
  `## Findings (Important: 1, Nit: 0)\n\n\`${path}:L12\`: 🔴 Important: ${prose}\n\n## LGTM`;

describe('review gate: scope classification is fail-closed', () => {
  it('blocks when the file list is incomplete', () => {
    const result = classifyReview(reviewFor('scripts/legacy.mjs', 'old bug'), {
      files: DIFF_FILES,
      complete: false,
      repositoryPaths: TREE_FILES,
    });

    expect(result.blocking).toBe(true);
    expect(result.outside).toHaveLength(0);
    expect(result.unresolved).toHaveLength(1);
  });

  it('blocks when the file list is empty, even if complete is true', () => {
    const result = classifyReview(reviewFor('scripts/legacy.mjs', 'old bug'), {
      files: [],
      complete: true,
      repositoryPaths: TREE_FILES,
    });

    expect(result.blocking).toBe(true);
    expect(result.outside).toHaveLength(0);
    expect(result.unresolved[0]?.reason).toMatch(/diff non verificabile/i);
  });

  it('blocks when the repository tree cannot resolve an outside citation', () => {
    const result = classifyReview(reviewFor('scripts/legacy.mjs', 'old bug'), {
      files: DIFF_FILES,
      complete: true,
      repositoryPaths: null,
    });

    expect(result.blocking).toBe(true);
    expect(result.outside).toHaveLength(0);
    expect(result.unresolved[0]?.reason).toMatch(/non risolto|diff non verificabile/i);
  });

  it('blocks when the Important marker has no parseable file citation', () => {
    const result = classifyReview('## Findings\n\n🔴 Important: parser is unsafe\n\n## LGTM', {
      files: DIFF_FILES,
      complete: true,
      repositoryPaths: TREE_FILES,
    });

    expect(result.blocking).toBe(true);
    expect(result.outside).toHaveLength(0);
    expect(result.unresolved[0]?.reason).toMatch(/nessun file citato/i);
  });

  it.each(['nessuno dei due rami è coperto', '0 elementi passano il controllo', 'none of the branches are safe'])
    ('treats prose beginning with %s as a finding, not as a count row', (prose) => {
      const body = reviewFor('src/changed.mjs', prose);
      expect(importantFindings(body)).toHaveLength(1);

      const result = classifyReview(body, {
        files: DIFF_FILES,
        complete: true,
        repositoryPaths: TREE_FILES,
      });
      expect(result.inScope).toHaveLength(1);
      expect(result.blocking).toBe(true);
    });

  it('recognizes a bare zero only as the complete count form', () => {
    expect(importantFindings('🔴 Important: 0')).toHaveLength(0);
    expect(importantFindings(reviewFor('src/changed.mjs', '0 — the parser still drops jobs'))).toHaveLength(1);
  });

  it('does not let the last finding absorb a later H2 summary path', () => {
    const body = [
      '## Findings (Important: 1, Nit: 0)',
      '',
      '`src/changed.mjs:L12`: 🔴 Important: parser drops a valid job.',
      '',
      '## Adversarial check',
      '- `scripts/other.mjs:L44`: the edge case was not probed.',
      '',
      '## Summary',
      '- `scripts/legacy.mjs:L9` is mentioned only in the summary.',
      '',
      '## LGTM',
    ].join('\n');

    const [finding] = importantFindings(body);
    expect(finding?.text).not.toContain('scripts/other.mjs');
    expect(finding?.text).not.toContain('scripts/legacy.mjs');
    expect(finding?.citations.map((citation) => citation.path)).toEqual(['src/changed.mjs']);
  });

  it('stops an Important finding at the next finding, including a Nit', () => {
    const body = [
      '## Findings',
      '',
      '`scripts/legacy.mjs:L12`: 🔴 Important: old parser is unsafe.',
      '`scripts/other.mjs:L44`: 🟡 Nit: naming can be clearer.',
      '',
      '## LGTM',
    ].join('\n');

    const [finding] = importantFindings(body);
    expect(finding?.text).not.toContain('scripts/other.mjs');
    expect(finding?.citations.map((citation) => citation.path)).toEqual(['scripts/legacy.mjs']);
  });

  it('blocks when a severity marker has an ambiguous boundary instead of guessing', () => {
    const body = [
      '## Findings',
      '',
      '`scripts/legacy.mjs:L12`: 🔴 Important: old parser is unsafe.',
      'Reviewer note: 🟡 Nit: the wording is unclear.',
      '',
      '## LGTM',
    ].join('\n');
    const result = classifyReview(body, {
      files: DIFF_FILES,
      complete: true,
      repositoryPaths: TREE_FILES,
    });

    expect(result.blocking).toBe(true);
    expect(result.outside).toHaveLength(0);
    expect(result.unresolved[0]?.reason).toMatch(/ambigua/i);
  });

  it('declassifies an entirely out-of-diff finding and builds one follow-up item', () => {
    const result = classifyReview(reviewFor('scripts/legacy.mjs', 'the old parser is still unsafe'), {
      files: DIFF_FILES,
      complete: true,
      repositoryPaths: TREE_FILES,
    });

    expect(result.blocking).toBe(false);
    expect(result.outsideOnly).toBe(true);
    expect(result.outside).toHaveLength(1);

    const body = followupIssueBody({
      repo: 'valerielinc-ops/frontaliere-si-o-no',
      pr: 8123,
      prUrl: 'https://github.com/valerielinc-ops/frontaliere-si-o-no/pull/8123',
      findings: result.outside,
    });
    expect(body).toContain('## Origine');
    expect(body).toContain('## Item');
    expect(body).toContain('### 1.');
    expect(body).toContain('scripts/legacy.mjs');
    expect(body).toContain('Original text:');
  });

  it('requires every cited path to resolve outside before declassifying', () => {
    const body = [
      '## Findings',
      '',
      '`scripts/legacy.mjs:L12` and `scripts/other.mjs:L18`: 🔴 Important: both old parsers are unsafe.',
      '',
      '## LGTM',
    ].join('\n');
    const result = classifyReview(body, {
      files: DIFF_FILES,
      complete: true,
      repositoryPaths: TREE_FILES,
    });

    expect(result.outsideOnly).toBe(true);
    expect(result.outside[0]?.resolvedFiles).toEqual(['scripts/legacy.mjs', 'scripts/other.mjs']);
    expect(followupIssueBody({ repo: 'owner/repo', pr: 1, findings: result.outside }))
      .toContain('`scripts/legacy.mjs`, `scripts/other.mjs`');
  });

  it('aggregates into the existing body without duplicating or reopening an item', () => {
    const first = classifyReview(reviewFor('scripts/legacy.mjs', 'old parser is unsafe'), {
      files: DIFF_FILES,
      complete: true,
      repositoryPaths: TREE_FILES,
    }).outside[0];
    const existingBody = followupIssueBody({
      repo: 'valerielinc-ops/frontaliere-si-o-no',
      pr: 8123,
      findings: [first],
    });
    const second = {
      ...first,
      findingNumber: 2,
      text: '`scripts/other.mjs:L4`: 🔴 Important: other parser is unsafe.',
      line: '`scripts/other.mjs:L4`: 🔴 Important: other parser is unsafe.',
      resolvedFiles: ['scripts/other.mjs'],
    };
    const merged = followupIssueBody({
      repo: 'valerielinc-ops/frontaliere-si-o-no',
      pr: 8123,
      findings: [first, second],
      existingBody,
    });

    expect((merged.match(/^### \d+\./gmu) || [])).toHaveLength(2);
    expect(followupItemsFromBody(merged)).toHaveLength(2);
    expect(merged).toContain('scripts/other.mjs');
    expect(merged).toContain('OUT_OF_SCOPE_REVIEW_FOLLOWUP');
  });

  it('keeps an in-diff finding blocking even beside an out-of-diff finding', () => {
    const body = [
      '## Findings (Important: 2, Nit: 0)',
      '',
      '`scripts/legacy.mjs:L12`: 🔴 Important: old parser is unsafe.',
      '`src/changed.mjs:L20`: 🔴 Important: current diff breaks the funnel.',
      '',
      '## LGTM',
    ].join('\n');
    const result = classifyReview(body, {
      files: DIFF_FILES,
      complete: true,
      repositoryPaths: TREE_FILES,
    });

    expect(result.outside).toHaveLength(1);
    expect(result.inScope).toHaveLength(1);
    expect(result.blocking).toBe(true);
  });

  it('blocks an ambiguous basename instead of guessing a file', () => {
    const result = classifyReview(reviewFor('parser.mjs', 'ambiguous path'), {
      files: DIFF_FILES,
      complete: true,
      repositoryPaths: ['a/parser.mjs', 'b/parser.mjs', ...TREE_FILES],
    });

    expect(result.blocking).toBe(true);
    expect(result.unresolved[0]?.reason).toMatch(/ambiguo/i);
  });
});
