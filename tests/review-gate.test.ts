import { describe, expect, it } from 'vitest';
import {
  classifyReview,
  auditHistoricalCitations,
  followupIssueBody,
  followupItemsFromBody,
  extractFileCitations,
  historicalImportantFindings,
  importantFindings,
  CODEX_REVIEW_MARKER,
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

  it('allows an operational question without funnel markers beside an outside-only finding', async () => {
    const outsideOnlyReview = {
      ...historicalImportantReview,
      body: [
        reviewFor('scripts/legacy.mjs', 'the old parser is still unsafe').replace(/\n## LGTM$/u, ''),
        '- `scripts/ci/runtime.mjs:L151`: ❓ q: confirm the byte limit remains enforced before the Linux runtime copy.',
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


  it('recognizes a Markdown-escaped primary anchor without treating a mentioned helper as another finding', () => {
    const opened = bot('## Findings (Important: 1, Nit: 0)\n\n🔴 Important: `\\.github/actions/claude-codex-fallback/action.yml:L1065-L1079` — calls `claude-codex-fallback.mjs` without checking its exit.');
    expect(importantFindings(opened.body)[0].citations).toEqual([
      { path: '.github/actions/claude-codex-fallback/action.yml', line: 1065 },
    ]);
    const confirmed = bot('## Findings (Important: 0, Nit: 0)\nFix di `.github/actions/claude-codex-fallback/action.yml:L1065-L1079`: ok.\n## LGTM');
    expect(historicalImportantFindings([opened, confirmed], { includeLatest: true })).toHaveLength(0);
  });

  it('retains every precise anchor and explicit companion path until each is confirmed', () => {
    const opened = bot('## Findings\n🔴 Important: `src/a.ts:L3` and `src/b.ts:L4` are broken; also fix `src/helper.ts`.');
    const partial = bot('## Findings\nFix di `src/a.ts:L3`: ok.\n## LGTM');
    const remaining = historicalImportantFindings([opened, partial], { includeLatest: true });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].citations).toHaveLength(3);
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

  it('NON chiude un finding diverso sullo stesso file a un altra riga', () => {
    // Il caso negativo: la riga resta un uguaglianza esatta, altrimenti una
    // conferma su un difetto chiuderebbe anche il difetto accanto.
    const opened = bot('## Findings (Important: 1, Nit: 0)\n\n`scripts/lib/helper.mjs:L7`: 🔴 Important: rotto.\n');
    const other = bot('## Findings (Important: 0, Nit: 0)\n\nFix di `scripts/lib/helper.mjs:L99`: ok.\n\n## LGTM');
    expect(historicalImportantFindings([opened, other], { includeLatest: true })).toHaveLength(1);
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
