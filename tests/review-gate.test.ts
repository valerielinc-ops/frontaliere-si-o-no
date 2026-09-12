import { describe, expect, it, vi } from 'vitest';
import {
  classifyReview,
  citationConfirmed,
  auditHistoricalCitations,
  followupIssueBody,
  followupItemsFromBody,
  findingKey,
  extractFileCitations,
  historicalImportantFindings,
  importantFindings,
  logClassification,
  CODEX_REVIEW_MARKER,
  normalizeReviewBody,
  runReviewGate,
} from '../scripts/ci/review-gate.mjs';

const DIFF_FILES = ['src/changed.mjs'];
const TREE_FILES = ['src/changed.mjs', 'scripts/legacy.mjs', 'scripts/other.mjs'];

const reviewFor = (path: string, prose: string) =>
  `## Findings (Important: 1, Nit: 0)\n\n\`${path}:L12\`: 🔴 Important: ${prose}\n\n## LGTM`;

const HEAD_SHA = 'a'.repeat(40);
const PRIOR_SHA = 'b'.repeat(40);
const approvingBotReview = {
  user: { type: 'Bot', login: 'claude[bot]' },
  body: '## Findings (Important: 0, Nit: 0)\n\n## LGTM',
  commit_id: PRIOR_SHA,
};

const historicalImportantReview = {
  user: { type: 'Bot', login: 'frontaliere-automation[bot]' },
  body: reviewFor('src/changed.mjs', 'the unsafe branch is still present'),
  commit_id: PRIOR_SHA,
};

const unanchoredImportantReview = {
  user: { type: 'Bot', login: 'frontaliere-automation[bot]' },
  body: '## Findings (Important: 1, Nit: 0)\n\n🔴 Important: process contract remains unresolved\n\n## LGTM',
  commit_id: PRIOR_SHA,
};

const alignmentLgtmReview = {
  user: { type: 'Bot', login: 'frontaliere-automation[bot]' },
  body: '## Findings (Important: 0, Nit: 1)\n\nThe alignment changed no cited code.\n\n## LGTM',
  commit_id: HEAD_SHA,
};

const classifyCurrentDiff = async (body: string) => classifyReview(body, {
  files: DIFF_FILES,
  complete: true,
  repositoryPaths: TREE_FILES,
});

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

  it('ignores a negative Important summary inside the LGTM section', () => {
    const body = [
      '## Findings (Important: 0, Nit: 2)',
      '',
      '## LGTM',
      'Nessun 🔴 Important: le modifiche sono coerenti e i nit non sono funnel-critical.',
    ].join('\n');

    expect(importantFindings(body)).toHaveLength(0);
    expect(classifyReview(body, {
      files: DIFF_FILES,
      complete: true,
      repositoryPaths: TREE_FILES,
    }).blocking).toBe(false);
  });

  it('does not ignore a real Important marker whose prose starts with No', () => {
    const body = [
      '## Findings (Important: 1, Nit: 0)',
      '',
      '`src/changed.mjs:L12`: 🔴 Important: No safe branch is present.',
      '',
      '## LGTM',
    ].join('\n');

    expect(importantFindings(body)).toHaveLength(1);
    expect(classifyReview(body, {
      files: DIFF_FILES,
      complete: true,
      repositoryPaths: TREE_FILES,
    }).inScope).toHaveLength(1);
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

describe('review gate: unresolvable head verdicts are blocking', () => {
  it('renders the only previous review as historical context before the next review exists', () => {
    expect(historicalImportantFindings([[historicalImportantReview]])).toHaveLength(0);
    expect(historicalImportantFindings([[historicalImportantReview]], { includeLatest: true }))
      .toHaveLength(1);
  });

  it('does not let a re-alignment LGTM erase an Important finding on the same code', async () => {
    const result = await runReviewGate({
      repo: 'owner/repo',
      pr: 1,
      headSha: HEAD_SHA,
      reviews: [[historicalImportantReview, alignmentLgtmReview]],
      classifyAndMintReviewFn: classifyCurrentDiff,
      mutate: false,
    });

    expect(result.approved).toBe(false);
    expect(result.classification.inScope).toHaveLength(1);
  });

  it('allows the later LGTM only after the cited anchor has an explicit fix confirmation', async () => {
    const fixedReview = {
      ...alignmentLgtmReview,
      body: '## Findings (Important: 0, Nit: 0)\n\nFix di `src/changed.mjs:L12`: ok. Il delta ha corretto il ramo.\n\n## LGTM',
    };
    const result = await runReviewGate({
      repo: 'owner/repo',
      pr: 1,
      headSha: HEAD_SHA,
      reviews: [[historicalImportantReview, fixedReview]],
      classifyAndMintReviewFn: classifyCurrentDiff,
      mutate: false,
    });

    expect(result.approved).toBe(true);
    expect(result.classification.findings).toHaveLength(0);
  });

  it('does not let a legacy line-only confirmation close an anchor on another file', async () => {
    const legacyConfirmation = {
      ...alignmentLgtmReview,
      body: '## Findings (Important: 0, Nit: 0)\n\nFix di L12: ok.\n\n## LGTM',
    };
    const result = await runReviewGate({
      repo: 'owner/repo',
      pr: 1,
      headSha: HEAD_SHA,
      reviews: [[historicalImportantReview, legacyConfirmation]],
      classifyAndMintReviewFn: classifyCurrentDiff,
      mutate: false,
    });

    expect(result.approved).toBe(false);
    expect(result.classification.inScope).toHaveLength(1);
  });

  it('keeps an Important without a file citation until its text has an explicit confirmation', async () => {
    const result = await runReviewGate({
      repo: 'owner/repo',
      pr: 1,
      headSha: HEAD_SHA,
      reviews: [[unanchoredImportantReview, alignmentLgtmReview]],
      classifyAndMintReviewFn: classifyCurrentDiff,
      mutate: false,
    });

    expect(result.approved).toBe(false);
    expect(result.classification.unresolved).toHaveLength(1);
  });

  it('emits the exact normalized key for an unresolved unanchored Important', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      logClassification(await classifyCurrentDiff(unanchoredImportantReview.body));

      expect(log).toHaveBeenCalledWith(
        'review-gate: BLOCKING finding=1 reason=nessun file citato expectedKey="🔴 Important: process contract remains unresolved"',
      );
    } finally {
      log.mockRestore();
    }
  });

  it('allows an unanchored Important after its normalized text has an explicit confirmation', async () => {
    const fixedReview = {
      ...alignmentLgtmReview,
      body: '## Findings (Important: 0, Nit: 0)\n\nFix di `🔴 Important: process contract remains unresolved`: ok.\n\n## LGTM',
    };
    const result = await runReviewGate({
      repo: 'owner/repo',
      pr: 1,
      headSha: HEAD_SHA,
      reviews: [[unanchoredImportantReview, fixedReview]],
      classifyAndMintReviewFn: classifyCurrentDiff,
      mutate: false,
    });

    expect(result.approved).toBe(true);
    expect(result.classification.findings).toHaveLength(0);
  });

  it('resolves a PR body finding only with an explicit matching metadata line', () => {
    const opened = { ...historicalImportantReview, body: 'PR body:L4: 🔴 Important: runner measurements missing.' };
    const review = (confirmation: string) => ({
      ...alignmentLgtmReview,
      body: `## Findings (Important: 0, Nit: 0)\n${confirmation}\n## LGTM`,
    });
    for (const confirmation of ['', 'Fix di `PR body:L5`: ok.', 'Fix di `docs/PR.md:L4`: ok.']) {
      expect(historicalImportantFindings([opened, review(confirmation)], { includeLatest: true })).toHaveLength(1);
    }
    expect(historicalImportantFindings([opened, review('Fix di `PR body:L4`: ok.')], { includeLatest: true })).toHaveLength(0);
    // Metadata is never classified as an outside-diff file.
    expect(importantFindings(opened.body)[0].citations).toEqual([]);
  });

  it('does not let a body confirmation resolve accompanying code citations', () => {
    const opened = { ...historicalImportantReview, body: 'PR body:L4: 🔴 Important: `src/changed.mjs:L12` still breaks.' };
    const confirmed = { ...alignmentLgtmReview, body: 'Fix di `PR body:L4`: ok.\n## LGTM' };
    expect(historicalImportantFindings([opened, confirmed], { includeLatest: true })).toHaveLength(1);
  });

  it('reuses the existing outside-diff declassification for inherited findings', async () => {
    const outsideReview = {
      ...historicalImportantReview,
      body: reviewFor('scripts/legacy.mjs', 'the old parser is still unsafe'),
    };
    const result = await runReviewGate({
      repo: 'owner/repo',
      pr: 1,
      headSha: HEAD_SHA,
      reviews: [[outsideReview, alignmentLgtmReview]],
      classifyAndMintReviewFn: classifyCurrentDiff,
      mutate: false,
    });

    expect(result.approved).toBe(true);
    expect(result.classification.outside).toHaveLength(1);
    expect(result.classification.blocking).toBe(false);
  });

  it('approves an applicable outside-only Important without requiring an LGTM', async () => {
    const outsideOnlyReview = {
      ...historicalImportantReview,
      body: reviewFor('scripts/legacy.mjs', 'the old parser is still unsafe').replace(/\n## LGTM$/u, ''),
      commit_id: HEAD_SHA,
    };
    const result = await runReviewGate({
      repo: 'owner/repo',
      pr: 1,
      headSha: HEAD_SHA,
      reviews: [[outsideOnlyReview]],
      classifyAndMintReviewFn: classifyCurrentDiff,
      mutate: false,
    });

    expect(result.approved).toBe(true);
    expect(result.classification.outsideOnly).toBe(true);
    expect(result.classification.blocking).toBe(false);
  });

  it('requires an LGTM when an outside-only review leaves a funnel question unresolved', async () => {
    const outsideOnlyReview = {
      ...historicalImportantReview,
      body: [
        reviewFor('scripts/legacy.mjs', 'the old parser is still unsafe').replace(/\n## LGTM$/u, ''),
        '- `scripts/ci/review-gate.mjs:L36`: ❓ q: the funnel-critical fallback may still regress.',
      ].join('\n'),
      commit_id: HEAD_SHA,
    };
    const result = await runReviewGate({
      repo: 'owner/repo',
      pr: 1,
      headSha: HEAD_SHA,
      reviews: [[outsideOnlyReview]],
      classifyAndMintReviewFn: classifyCurrentDiff,
      mutate: false,
    });

    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/manca ## LGTM/i);
    expect(result.classification.outsideOnly).toBe(true);
  });

  it('allows an explicitly non-funnel question beside an outside-only finding', async () => {
    const outsideOnlyReview = {
      ...historicalImportantReview,
      body: [
        reviewFor('scripts/legacy.mjs', 'the old parser is still unsafe').replace(/\n## LGTM$/u, ''),
        '- ❓ q: rischio operativo solo diagnostico — deferred, non funnel-critical.',
      ].join('\n'),
      commit_id: HEAD_SHA,
    };
    const result = await runReviewGate({
      repo: 'owner/repo',
      pr: 1,
      headSha: HEAD_SHA,
      reviews: [[outsideOnlyReview]],
      classifyAndMintReviewFn: classifyCurrentDiff,
      mutate: false,
    });

    expect(result.approved).toBe(true);
    expect(result.classification.outsideOnly).toBe(true);
  });

  it('does not treat funnel words inside the question as an explicit disposition', async () => {
    const outsideOnlyReview = {
      ...historicalImportantReview,
      body: [
        reviewFor('scripts/legacy.mjs', 'the old parser is still unsafe').replace(/\n## LGTM$/u, ''),
        '- `scripts/redirects.mjs:L41`: ❓ q: the canonical redirect remains deferred until the post-merge sweep; can it alter funnel routing?',
      ].join('\n'),
      commit_id: HEAD_SHA,
    };
    const result = await runReviewGate({
      repo: 'owner/repo',
      pr: 1,
      headSha: HEAD_SHA,
      reviews: [[outsideOnlyReview]],
      classifyAndMintReviewFn: classifyCurrentDiff,
      mutate: false,
    });

    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/manca ## LGTM/i);
    expect(result.classification.outsideOnly).toBe(true);
  });

  it('does not infer report-only disposition from prose inside an adversarial question', async () => {
    const outsideOnlyReview = {
      ...historicalImportantReview,
      body: [
        reviewFor('scripts/legacy.mjs', 'the old parser is still unsafe').replace(/\n## LGTM$/u, ''),
        '## Adversarial check',
        '- ❓ q: runtime behavior is report-only; non-funnel-critical remains unverified.',
      ].join('\n'),
      commit_id: HEAD_SHA,
    };
    const result = await runReviewGate({
      repo: 'owner/repo',
      pr: 1,
      headSha: HEAD_SHA,
      reviews: [[outsideOnlyReview]],
      classifyAndMintReviewFn: classifyCurrentDiff,
      mutate: false,
    });

    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/manca ## LGTM/i);
    expect(result.classification.outsideOnly).toBe(true);
  });

  it('still blocks an in-scope Important without an LGTM', async () => {
    const inScopeReview = {
      ...historicalImportantReview,
      body: reviewFor('src/changed.mjs', 'the current parser is still unsafe').replace(/\n## LGTM$/u, ''),
      commit_id: HEAD_SHA,
    };
    const result = await runReviewGate({
      repo: 'owner/repo',
      pr: 1,
      headSha: HEAD_SHA,
      reviews: [[inScopeReview]],
      classifyAndMintReviewFn: classifyCurrentDiff,
      mutate: false,
    });

    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/manca ## LGTM/i);
    expect(result.classification.inScope).toHaveLength(1);
  });

  it('blocks with zero bot reviews on the HEAD and no carry-forward', async () => {
    const result = await runReviewGate({
      repo: 'owner/repo',
      pr: 1,
      headSha: HEAD_SHA,
      reviews: [[]],
      mutate: false,
    });

    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/nessuna review Claude/i);
  });

  it('approves an identical-fingerprint review from a previous SHA', async () => {
    const result = await runReviewGate({
      repo: 'owner/repo',
      pr: 1,
      headSha: HEAD_SHA,
      reviews: [[approvingBotReview]],
      fingerprintFn: () => 'same-contribution',
      mutate: false,
    });

    expect(result).toMatchObject({
      approved: true,
      reviewCommit: PRIOR_SHA,
    });
  });

  it('carries a prior LGTM across a fallback that repeats unchanged confirmed findings', async () => {
    const fixedReview = {
      ...approvingBotReview,
      body: [
        '## Findings (Important: 0, Nit: 0)',
        '',
        'Fix di `src/changed.mjs:L12`: ok.',
        '',
        '## LGTM',
      ].join('\n'),
    };
    const staleReview = {
      ...historicalImportantReview,
      body: `${CODEX_REVIEW_MARKER}\n${historicalImportantReview.body.replace(/\n## LGTM$/u, '')}`,
      commit_id: HEAD_SHA,
    };
    const result = await runReviewGate({
      repo: 'owner/repo',
      pr: 1,
      headSha: HEAD_SHA,
      reviews: [[historicalImportantReview, fixedReview, staleReview]],
      classifyAndMintReviewFn: classifyCurrentDiff,
      changedPathsFn: () => [],
      mutate: false,
    });

    expect(result.approved).toBe(true);
    expect(result.reason).toMatch(/stale fallback/i);
  });

  it('keeps a repeated fallback blocking when one cited file changed afterwards', async () => {
    const fixedReview = {
      ...approvingBotReview,
      body: [
        '## Findings (Important: 0, Nit: 0)',
        '',
        'Fix di `src/changed.mjs:L12`: ok.',
        '',
        '## LGTM',
      ].join('\n'),
    };
    const staleReview = {
      ...historicalImportantReview,
      body: `${CODEX_REVIEW_MARKER}\n${historicalImportantReview.body.replace(/\n## LGTM$/u, '')}`,
      commit_id: HEAD_SHA,
    };
    const result = await runReviewGate({
      repo: 'owner/repo',
      pr: 1,
      headSha: HEAD_SHA,
      reviews: [[historicalImportantReview, fixedReview, staleReview]],
      classifyAndMintReviewFn: classifyCurrentDiff,
      changedPathsFn: () => ['src/changed.mjs'],
      mutate: false,
    });

    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/manca ## LGTM/i);
    expect(result.classification.inScope).toHaveLength(1);
  });

  it('does not hide an Important introduced between the prior LGTM and fallback', async () => {
    const fixedReview = {
      ...approvingBotReview,
      body: [
        '## Findings (Important: 0, Nit: 0)',
        '',
        'Fix di `src/changed.mjs:L12`: ok.',
        '',
        '## LGTM',
      ].join('\n'),
    };
    const intermediateReview = {
      ...historicalImportantReview,
      body: [
        '## Findings (Important: 1, Nit: 0)',
        '',
        '`scripts/ci/review-gate.mjs:L881`: 🔴 Important: a new gate flaw remains.',
      ].join('\n'),
      commit_id: HEAD_SHA,
    };
    const staleReview = {
      ...historicalImportantReview,
      body: `${CODEX_REVIEW_MARKER}\n${historicalImportantReview.body.replace(/\n## LGTM$/u, '')}`,
      commit_id: HEAD_SHA,
    };
    const result = await runReviewGate({
      repo: 'owner/repo',
      pr: 1,
      headSha: HEAD_SHA,
      reviews: [[historicalImportantReview, fixedReview, intermediateReview, staleReview]],
      classifyAndMintReviewFn: classifyCurrentDiff,
      changedPathsFn: () => [],
      mutate: false,
    });

    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/manca ## LGTM/i);
    expect(result.classification.blocking).toBe(true);
  });

  it('accepts a post-LGTM finding explicitly closed before the stale fallback', async () => {
    const fixedReview = {
      ...approvingBotReview,
      body: [
        '## Findings (Important: 0, Nit: 0)',
        '',
        'Fix di `src/changed.mjs:L12`: ok.',
        '',
        '## LGTM',
      ].join('\n'),
    };
    const intermediateReview = {
      ...historicalImportantReview,
      body: [
        '## Findings (Important: 1, Nit: 0)',
        '',
        '`scripts/ci/review-gate.mjs:L881`: 🔴 Important: a new gate flaw remains.',
      ].join('\n'),
      commit_id: HEAD_SHA,
    };
    const closingReview = {
      ...historicalImportantReview,
      body: [
        '## Findings (Important: 0, Nit: 0)',
        '',
        'Fix di `scripts/ci/review-gate.mjs:L881`: ok.',
      ].join('\n'),
      commit_id: HEAD_SHA,
    };
    const staleReview = {
      ...historicalImportantReview,
      body: `${CODEX_REVIEW_MARKER}\n${historicalImportantReview.body.replace(/\n## LGTM$/u, '')}`,
      commit_id: HEAD_SHA,
    };
    const result = await runReviewGate({
      repo: 'owner/repo',
      pr: 1,
      headSha: HEAD_SHA,
      reviews: [[historicalImportantReview, fixedReview, intermediateReview, closingReview, staleReview]],
      classifyAndMintReviewFn: classifyCurrentDiff,
      changedPathsFn: () => [],
      mutate: false,
    });

    expect(result.approved).toBe(true);
    expect(result.reason).toMatch(/stale fallback/i);
  });

  it('accepts a Codex review only with strict evidence, marker and exact HEAD', async () => {
    const codexReview = {
      user: { type: 'Bot', login: 'github-actions[bot]' },
      body: `${CODEX_REVIEW_MARKER}\n## Findings (Important: 0, Nit: 0)\n\n## LGTM`,
      commit_id: HEAD_SHA,
    };
    const result = await runReviewGate({
      repo: 'owner/repo',
      pr: 1,
      headSha: HEAD_SHA,
      reviews: [[codexReview]],
      codexEvidence: {
        provider: 'codex',
        model: 'gpt-5.6-luna',
        effort: 'max',
        trigger: 'runtime-429',
        status: 'success',
      },
      mutate: false,
    });

    expect(result).toMatchObject({ approved: true, reviewCommit: HEAD_SHA });
  });

  it('fails closed when Codex evidence is requested but the marked review is absent', async () => {
    const result = await runReviewGate({
      repo: 'owner/repo',
      pr: 1,
      headSha: HEAD_SHA,
      reviews: [[approvingBotReview]],
      codexEvidence: {
        provider: 'codex',
        model: 'gpt-5.6-luna',
        effort: 'max',
        trigger: 'preflight-quota',
        status: 'success',
      },
      mutate: false,
    });

    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/review Codex marcata/i);
  });

  it('fails closed when a caller supplies only a Codex success status', async () => {
    const result = await runReviewGate({
      repo: 'owner/repo',
      pr: 1,
      headSha: HEAD_SHA,
      reviews: [[approvingBotReview]],
      codexEvidence: { status: 'success' },
      mutate: false,
    });

    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/evidenza Codex assente/i);
  });
});

describe('review gate: citazioni e conferme', () => {
  const bot = (body: string) => ({ user: { type: 'Bot', login: 'claude[bot]' }, body, commit_id: 'c'.repeat(40) });

  it('decodifica i separatori newline serializzati dalla review automation', async () => {
    const escaped = [
      CODEX_REVIEW_MARKER,
      '## Findings (Important: 0, Nit: 0)',
      'Fix di `src/changed.mjs:L12`: ok.',
      '## LGTM',
    ].join('\\n');

    expect(normalizeReviewBody(escaped)).toContain('\n## Findings');
    expect(normalizeReviewBody(escaped)).toContain('\nFix di');

    const result = await runReviewGate({
      repo: 'owner/repo',
      pr: 1,
      headSha: HEAD_SHA,
      reviews: [[
        historicalImportantReview,
        {
          ...approvingBotReview,
          body: escaped,
          commit_id: HEAD_SHA,
        },
      ]],
      classifyAndMintReviewFn: classifyCurrentDiff,
      mutate: false,
    });

    expect(result).toMatchObject({ approved: true, reviewCommit: HEAD_SHA });
  });

  it('keeps findingKey() and citationConfirmed() as direct moved-anchor contracts', () => {
    const citation = { path: 'scripts/ci/review-gate.mjs', line: 431 };
    const finding = { citations: [citation], text: 'moved review anchor' };
    const confirmation = {
      citations: [{ path: citation.path, line: 488 }],
      key: '',
      bodyAnchor: null,
    };

    expect(findingKey({ citations: [citation], text: 'ignored when anchored' }))
      .toBe('scripts/ci/review-gate.mjs:431');
    expect(citationConfirmed(citation, [confirmation], finding, [finding])).toBe(true);

    const concurrentFinding = { citations: [citation], text: 'another moved anchor' };
    expect(citationConfirmed(
      citation,
      [confirmation],
      finding,
      [finding, concurrentFinding],
    )).toBe(false);
  });


  it('recognizes a Markdown-escaped primary anchor without treating a mentioned helper as another finding', () => {
    const opened = bot('## Findings (Important: 1, Nit: 0)\n\n🔴 Important: `\\.github/actions/claude-codex-fallback/action.yml:L1065-L1079` — calls `claude-codex-fallback.mjs` without checking its exit.');
    expect(importantFindings(opened.body)[0].citations).toEqual([
      { path: '.github/actions/claude-codex-fallback/action.yml', line: 1065 },
    ]);
    const confirmed = bot('## Findings (Important: 0, Nit: 0)\nFix di `.github/actions/claude-codex-fallback/action.yml:L1065-L1079`: ok.\n## LGTM');
    expect(historicalImportantFindings([opened, confirmed], { includeLatest: true })).toHaveLength(0);
  });

  it('conserva la riga quando il reviewer chiude il code span prima di :L', () => {
    const opened = bot('## Findings (Important: 1, Nit: 0)\n\n`scripts/update-manor-jobs.mjs`:L275: 🔴 Important: il suffisso pipe non è ancorato al brand.');
    expect(importantFindings(opened.body)[0].citations).toEqual([
      { path: 'scripts/update-manor-jobs.mjs', line: 275 },
    ]);
    const confirmed = bot('## Findings (Important: 0, Nit: 0)\nFix di `scripts/update-manor-jobs.mjs:L275`: ok.\n## LGTM');
    expect(historicalImportantFindings([opened, confirmed], { includeLatest: true })).toHaveLength(0);
  });

  it('riconosce le citazioni delle Firebase rules nelle conferme storiche', () => {
    const opened = bot('## Findings (Important: 1, Nit: 0)\n\nfirestore.rules:L148: 🔴 Important: la regola di conferma non è coerente.');
    expect(extractFileCitations(opened.body)).toEqual([
      { path: 'firestore.rules', line: 148 },
    ]);
    expect(importantFindings(opened.body)[0].citations).toEqual([
      { path: 'firestore.rules', line: 148 },
    ]);
    const confirmed = bot('## Findings (Important: 0, Nit: 0)\nFix di `firestore.rules:L148`: ok.\n## LGTM');
    expect(historicalImportantFindings([opened, confirmed], { includeLatest: true })).toHaveLength(0);
  });

  it('retains every precise anchor and explicit companion path until each is confirmed', () => {
    const opened = bot('## Findings\n🔴 Important: `src/a.ts:L3` and `src/b.ts:L4` are broken; also fix `src/helper.ts`.');
    const partial = bot('## Findings\nFix di `src/a.ts:L3`: ok.\n## LGTM');
    const remaining = historicalImportantFindings([opened, partial], { includeLatest: true });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].citations).toHaveLength(3);
  });

  it('ignora i path-esempio nudi assenti dal tree dopo la conferma dell’anchor preciso', () => {
    const opened = bot([
      '## Findings (Important: 1, Nit: 0)',
      '',
      '`src/changed.mjs:L12`: 🔴 Important: the root fallback accepts `scripts/foo.mjs` even when `subdir/scripts/foo.mjs` is missing.',
    ].join('\n'));
    const confirmed = bot([
      '## Findings (Important: 0, Nit: 0)',
      '',
      'Fix di `src/changed.mjs:L12`: ok.',
      '',
      '## LGTM',
    ].join('\n'));

    expect(historicalImportantFindings([opened, confirmed], {
      includeLatest: true,
      repositoryPaths: ['src/changed.mjs'],
    })).toHaveLength(0);
  });

  it('closes a unique bare companion path when the follow-up confirms its fix line', () => {
    const opened = bot([
      '## Findings (Important: 1, Nit: 0)',
      '',
      '`functions/index.js:L344`: 🔴 Important: the consumer is in `build-plugins/borderWaitHydrationScript.ts`.',
    ].join('\n'));
    const confirmed = bot([
      '## Findings (Important: 0, Nit: 0)',
      '',
      'Fix di `functions/index.js:L344`: ok.',
      'Fix di `build-plugins/borderWaitHydrationScript.ts:L79`: ok.',
      '',
      '## LGTM',
    ].join('\n'));

    expect(historicalImportantFindings([opened, confirmed], { includeLatest: true })).toHaveLength(0);
  });

  it('closes a shared bare companion only after each finding anchor is confirmed', () => {
    const openedA = bot([
      '## Findings (Important: 1, Nit: 0)',
      '',
      '`src/a.mjs:L10`: 🔴 Important: the first consumer also needs `src/shared.mjs`.',
    ].join('\n'));
    const openedB = bot([
      '## Findings (Important: 1, Nit: 0)',
      '',
      '`src/b.mjs:L11`: 🔴 Important: the second consumer also needs `src/shared.mjs`.',
    ].join('\n'));
    const confirmed = bot([
      '## Findings (Important: 0, Nit: 0)',
      '',
      'Fix di `src/a.mjs:L10`: ok.',
      'Fix di `src/b.mjs:L11`: ok.',
      'Fix di `src/shared.mjs:L7`: ok.',
      '',
      '## LGTM',
    ].join('\n'));

    expect(historicalImportantFindings([openedA, openedB, confirmed], { includeLatest: true }))
      .toHaveLength(0);
  });

  it('treats a bare repeat of a precise path as context, not a second anchor', () => {
    const opened = bot([
      '## Findings (Important: 1, Nit: 0)',
      '',
      '`scripts/ci/refund-fix-round.mjs:L10`: 🔴 Important: il modulo non linka; controlla anche `scripts/ci/refund-fix-round.mjs`.',
    ].join('\n'));
    expect(importantFindings(opened.body)[0].citations).toEqual([
      { path: 'scripts/ci/refund-fix-round.mjs', line: 10 },
    ]);
    const confirmed = bot([
      '## Findings (Important: 0, Nit: 0)',
      '',
      'Fix di `scripts/ci/refund-fix-round.mjs:L10`: ok.',
      '',
      '## LGTM',
    ].join('\n'));
    expect(historicalImportantFindings([opened, confirmed], { includeLatest: true })).toHaveLength(0);
  });

  it('non tronca le estensioni piu lunghe di un prefisso valido', () => {
    // `ts` viene prima di `tsx` nell'alternanza: senza il lookahead il path
    // citato diventava un file che non esiste, e un path non risolvibile e'
    // bloccante per progetto.
    expect(extractFileCitations('`components/pages/Foo.tsx:L107`')).toEqual([
      { path: 'components/pages/Foo.tsx', line: 107 },
    ]);
    expect(extractFileCitations('`cfg/app.json`')).toEqual([{ path: 'cfg/app.json', line: null }]);
    expect(extractFileCitations('`x/Bar.jsx:L3`')).toEqual([{ path: 'x/Bar.jsx', line: 3 }]);
    // le estensioni corte restano intatte
    expect(extractFileCitations('`y/z.ts:L9`')).toEqual([{ path: 'y/z.ts', line: 9 }]);
    expect(extractFileCitations('`w/v.mjs`')).toEqual([{ path: 'w/v.mjs', line: null }]);
  });

  it('non interpreta un suffisso di filename come una citazione troncata', () => {
    expect(extractFileCitations('`lib/foo.js-old`')).toEqual([]);
    expect(extractFileCitations('`foo.ts.bak`')).toEqual([]);
    expect(extractFileCitations('`foo.ts_old`')).toEqual([]);
  });

  it('l audit storico segnala un path estensione-troncato ancora non risolvibile', () => {
    const review = bot('## Findings (Important: 1, Nit: 0)\n\n`src/Foo.ts:L7`: 🔴 Important: rotto.\n');
    const result = auditHistoricalCitations([review], ['src/Foo.tsx']);
    expect(result.truncatedUnresolvable).toEqual([
      expect.objectContaining({
        citation: { path: 'src/Foo.ts', line: 7 },
        candidate: 'src/Foo.tsx',
      }),
    ]);
    expect(result.openFindings).toHaveLength(1);
  });

  it('una conferma col path completo chiude un finding che citava il nome nudo', () => {
    const opened = bot('## Findings (Important: 1, Nit: 0)\n\n`helper.mjs:L7`: 🔴 Important: rotto.\n');
    const confirmed = bot('## Findings (Important: 0, Nit: 0)\n\nFix di `scripts/lib/helper.mjs:L7`: ok.\n\n## LGTM');
    expect(historicalImportantFindings([opened, confirmed], { includeLatest: true })).toHaveLength(0);
  });

  it('chiude un anchor spostato sulla riga nuova quando il path è univoco', () => {
    const opened = bot('## Findings (Important: 1, Nit: 0)\n\n`scripts/lib/helper.mjs:L7`: 🔴 Important: rotto.\n');
    const moved = bot('## Findings (Important: 0, Nit: 0)\n\nFix di `scripts/lib/helper.mjs:L99`: ok.\n\n## LGTM');
    expect(historicalImportantFindings([opened, moved], { includeLatest: true })).toHaveLength(0);
  });

  it('mantiene aperti finding distinti sullo stesso file quando la conferma cambia riga', () => {
    const first = bot('## Findings (Important: 1, Nit: 0)\n\n`scripts/lib/helper.mjs:L7`: 🔴 Important: primo difetto.\n');
    const second = bot('## Findings (Important: 1, Nit: 0)\n\n`scripts/lib/helper.mjs:L12`: 🔴 Important: secondo difetto.\n');
    const ambiguous = bot('## Findings (Important: 0, Nit: 0)\n\nFix di `scripts/lib/helper.mjs:L99`: ok.\n\n## LGTM');
    expect(historicalImportantFindings([first, second, ambiguous], { includeLatest: true })).toHaveLength(2);
  });

  it('chiude un finding a riga con una conferma senza riga solo quando il path è univoco', () => {
    const opened = bot('## Findings (Important: 1, Nit: 0)\n\n`x/y.mjs:L7-L9`: 🔴 Important: rotto.\n');
    const confirmed = bot('## Findings (Important: 0, Nit: 0)\n\nFix di `x/y.mjs`: ok.\n\n## LGTM');
    expect(historicalImportantFindings([opened, confirmed], { includeLatest: true })).toHaveLength(0);
  });

  it('mantiene aperte due citazioni dello stesso path quando la conferma non indica la riga', () => {
    const opened = bot('## Findings (Important: 1, Nit: 0)\n\n`x/y.mjs:L7` e `x/y.mjs:L12`: 🔴 Important: due difetti distinti.\n');
    const confirmed = bot('## Findings (Important: 0, Nit: 0)\n\nFix di `x/y.mjs`: ok.\n\n## LGTM');
    expect(historicalImportantFindings([opened, confirmed], { includeLatest: true })).toHaveLength(1);
  });

  it('non lascia che un basename senza riga chiuda finding aperti in cartelle diverse', () => {
    const first = bot('## Findings (Important: 1, Nit: 0)\n\n`src/helper.mjs:L7`: 🔴 Important: primo difetto.\n');
    const second = bot('## Findings (Important: 1, Nit: 0)\n\n`lib/helper.mjs:L7`: 🔴 Important: secondo difetto.\n');
    const confirmed = bot('## Findings (Important: 0, Nit: 0)\n\nFix di `helper.mjs:L7`: ok.\n\n## LGTM');
    expect(historicalImportantFindings([first, second, confirmed], { includeLatest: true })).toHaveLength(2);
  });

  it('non riusa un basename con riga quando due finding hanno companion path diversi', () => {
    const first = bot([
      '## Findings (Important: 1, Nit: 0)',
      '',
      '`helper.mjs:L7`: 🔴 Important: primo difetto; companion `src/a/other.mjs:L20`.',
    ].join('\n'));
    const second = bot([
      '## Findings (Important: 1, Nit: 0)',
      '',
      '`helper.mjs:L7`: 🔴 Important: secondo difetto; companion `src/b/other.mjs:L20`.',
    ].join('\n'));
    const confirmed = bot([
      '## Findings (Important: 0, Nit: 0)',
      '',
      'Fix di `helper.mjs:L7`: ok.',
      'Fix di `src/a/other.mjs:L20`: ok.',
      'Fix di `src/b/other.mjs:L20`: ok.',
      '',
      '## LGTM',
    ].join('\n'));

    expect(historicalImportantFindings([first, second, confirmed], { includeLatest: true })).toHaveLength(2);
  });

  it('NON chiude un finding se la conferma cita un file omonimo in un altra cartella', () => {
    // NB: non usare `a/` e `b/` come cartelle — sono i prefissi di diff che
    // normalizePath rimuove per progetto, quindi collasserebbero sullo stesso path.
    const opened = bot('## Findings (Important: 1, Nit: 0)\n\n`src/dup.mjs:L4`: 🔴 Important: rotto.\n');
    const other = bot('## Findings (Important: 0, Nit: 0)\n\nFix di `lib/dup.mjs:L4`: ok.\n\n## LGTM');
    expect(historicalImportantFindings([opened, other], { includeLatest: true })).toHaveLength(1);
  });
});
