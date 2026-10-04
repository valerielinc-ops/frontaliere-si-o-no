import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
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
  isLedgerAcceptanceFinding,
  logClassification,
  CODEX_REVIEW_MARKER,
  normalizeReviewBody,
  runReviewGate,
  unanchoredConfirmationTarget,
} from '../scripts/ci/review-gate.mjs';
import { stableFindingId } from '../scripts/ci/lib/review-findings.mjs';

const DIFF_FILES = ['src/changed.mjs'];
const TREE_FILES = ['src/changed.mjs', 'scripts/legacy.mjs', 'scripts/other.mjs'];
const REVIEW_REVISION = `body:${'c'.repeat(64)}`;
const OLD_REVIEW_REVISION = `body:${'d'.repeat(64)}`;
const REVIEW_INPUT_MARKER = `<!-- REVIEW_INPUT_REVISION: ${REVIEW_REVISION} -->`;
const OLD_REVIEW_INPUT_MARKER = `<!-- REVIEW_INPUT_REVISION: ${OLD_REVIEW_REVISION} -->`;

const reviewFor = (path: string, prose: string) =>
  `## Findings (Important: 1, Nit: 0)\n\n\`${path}:L12\`: 🔴 Important: ${prose}\n\n## LGTM`;

const HEAD_SHA = 'a'.repeat(40);
const PRIOR_SHA = 'b'.repeat(40);
const approvingBotReview = {
  id: 1,
  user: { type: 'Bot', login: 'claude[bot]' },
  state: 'COMMENTED',
  body: '## Findings (Important: 0, Nit: 0)\n\n## LGTM',
  commit_id: PRIOR_SHA,
};

const historicalImportantReview = {
  id: 2,
  user: { type: 'Bot', login: 'frontaliere-automation[bot]' },
  state: 'COMMENTED',
  body: reviewFor('src/changed.mjs', 'the unsafe branch is still present'),
  commit_id: PRIOR_SHA,
};

const unanchoredImportantReview = {
  id: 3,
  user: { type: 'Bot', login: 'frontaliere-automation[bot]' },
  state: 'COMMENTED',
  body: '## Findings (Important: 1, Nit: 0)\n\n🔴 Important: process contract remains unresolved\n\n## LGTM',
  commit_id: PRIOR_SHA,
};

const alignmentLgtmReview = {
  id: 4,
  user: { type: 'Bot', login: 'frontaliere-automation[bot]' },
  state: 'COMMENTED',
  body: '## Findings (Important: 0, Nit: 1)\n\nThe alignment changed no cited code.\n\n## LGTM',
  commit_id: HEAD_SHA,
};

const classifyCurrentDiff = async (body: string) => classifyReview(body, {
  files: DIFF_FILES,
  complete: true,
  repositoryPaths: TREE_FILES,
});

// These scenarios exercise review-history classification, not the git diff
// implementation. Their synthetic SHAs do not exist in the checkout; keeping
// the delta unavailable avoids spawning a failing git process under the full
// suite's concurrent load (where it can consume the whole 15s test budget).
const noChangedLines = () => null;

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

  it('does not treat Fix confirmations as in-diff anchors of an outside finding', () => {
    const body = [
      'scripts/generate-crawler-group-workflows.mjs:L896: 🔴 Important: the detached launcher inherits the runner tracking id.',
      'Fix di `scripts/import-pharmacies-border.mjs:L175`: ok.',
      'Fix di `build-plugins/pharmacyDirectoryPagesPlugin.ts:L524`: ok.',
    ].join('\n');
    const result = classifyReview(body, {
      files: ['scripts/import-pharmacies-border.mjs', 'build-plugins/pharmacyDirectoryPagesPlugin.ts'],
      complete: true,
      repositoryPaths: [
        'scripts/generate-crawler-group-workflows.mjs',
        'scripts/import-pharmacies-border.mjs',
        'build-plugins/pharmacyDirectoryPagesPlugin.ts',
      ],
    });

    expect(result.blocking).toBe(false);
    expect(result.outsideOnly).toBe(true);
    expect(result.outside[0]?.resolvedFiles).toEqual(['scripts/generate-crawler-group-workflows.mjs']);
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

  it('parses a location-bound bare Important marker from the documented format', () => {
    const body = '## Findings\n\nsrc/changed.mjs:L12: 🔴 Important parser is unsafe\n\n## LGTM';
    expect(importantFindings(body)).toHaveLength(1);
    const result = classifyReview(body, {
      files: DIFF_FILES,
      complete: true,
      repositoryPaths: TREE_FILES,
    });
    expect(result.blocking).toBe(true);
    expect(result.inScope).toHaveLength(1);
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

  it('stops an Important finding before a PR-body Nit anchor', () => {
    const body = [
      '## Findings',
      '',
      '`scripts/legacy.mjs:L12`: 🔴 Important: old parser is unsafe.',
      'PR body:L10: 🟡 Nit: the implementation summary is stale.',
      '',
      '## LGTM',
    ].join('\n');

    const [finding] = importantFindings(body);
    expect(finding?.text).not.toContain('PR body:L10');
    expect(finding?.citations).toEqual([{ path: 'scripts/legacy.mjs', line: 12 }]);
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
      changedLinesFn: noChangedLines,
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
      changedLinesFn: noChangedLines,
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
      changedLinesFn: noChangedLines,
      mutate: false,
    });

    expect(result.approved).toBe(false);
    expect(result.classification.unresolved).toHaveLength(1);
  });

  it('emits the exact normalized key for an unresolved unanchored Important', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const classification = await classifyCurrentDiff(unanchoredImportantReview.body);
      logClassification(classification);

      const id = stableFindingId(classification.unresolved[0]);
      expect(log).toHaveBeenCalledWith(
        `review-gate: BLOCKING finding=1 reason=nessun file citato confirm="${id}" expectedKey="🔴 Important: process contract remains unresolved"`,
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

  it('allows an unanchored Important after its ledger id has an explicit confirmation', async () => {
    const [finding] = importantFindings(unanchoredImportantReview.body);
    const fixedReview = {
      ...alignmentLgtmReview,
      body: `## Findings (Important: 0, Nit: 0)\n\nFix di \`${stableFindingId(finding)}\`: ok.\n\n## LGTM`,
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

  it('closes an unanchored Important by id only when the whole confirmation target is that id', () => {
    const [finding] = importantFindings(unanchoredImportantReview.body);
    const id = stableFindingId(finding);
    const review = (confirmation: string) => ({
      ...alignmentLgtmReview,
      body: `## Findings (Important: 0, Nit: 0)\n${confirmation}\n## LGTM`,
    });
    for (const confirmation of [
      // L'id citato dentro una frase è contesto, non il target della conferma.
      `Fix di \`Historical finding ${id}: il bundle riporta il testo\`: ok.`,
      `Fix di \`${id.toUpperCase()}\`: ok.`,
      `Fix di \`${id.slice(0, 11)}\`: ok.`,
      'Fix di `000000000000`: ok.',
    ]) {
      expect(historicalImportantFindings([unanchoredImportantReview, review(confirmation)], { includeLatest: true }))
        .toHaveLength(1);
    }
    expect(historicalImportantFindings([unanchoredImportantReview, review(`Fix di \`${id}\`: ok.`)], { includeLatest: true }))
      .toHaveLength(0);
  });

  it('keeps the exact PR body anchor as the only id-free closure of a body finding', () => {
    // Review 5330340986: il ramo dell'id non deve scavalcare `PR body:L<n>`.
    const opened = { ...historicalImportantReview, body: 'PR body:L12: 🔴 Important: [process] runner measurements missing.' };
    const [finding] = importantFindings(opened.body);
    expect(unanchoredConfirmationTarget(finding)).toBe('PR body:L12');
    const review = (confirmation: string) => ({
      ...alignmentLgtmReview,
      body: `## Findings (Important: 0, Nit: 0)\n${confirmation}\n## LGTM`,
    });
    expect(historicalImportantFindings([opened, review(`Fix di \`${stableFindingId(finding)}\`: ok.`)], { includeLatest: true }))
      .toHaveLength(1);
    expect(historicalImportantFindings([opened, review('Fix di `PR body:L12`: ok.')], { includeLatest: true }))
      .toHaveLength(0);
  });

  it('prints the same confirmation target the gate accepts', () => {
    const [plain] = importantFindings(unanchoredImportantReview.body);
    expect(unanchoredConfirmationTarget(plain)).toBe(stableFindingId(plain));
    // `PR body:L7` a metà riga non è un anchor per il gate: il target resta l'id.
    const [midLine] = importantFindings('Historical finding abc: 🔴 Important: [process] vedi PR body:L7 per il claim.');
    expect(unanchoredConfirmationTarget(midLine)).toBe(stableFindingId(midLine));
    const [anchored] = importantFindings(reviewFor('src/changed.mjs', 'the parser drops the last row'));
    expect(unanchoredConfirmationTarget(anchored)).toBeNull();
  });

  it('closes a finding anchored on a file by id only together with its file re-confirmed (#10025)', () => {
    const anchored = { ...historicalImportantReview, body: reviewFor('src/changed.mjs', 'the parser drops the last row') };
    const [finding] = importantFindings(anchored.body);
    const review = (...confirmations: string[]) => ({
      ...alignmentLgtmReview,
      body: `## Findings (Important: 0, Nit: 0)\n${confirmations.join('\n')}\n## LGTM`,
    });
    const id = `Fix di \`${stableFindingId(finding)}\`: ok.`;
    // L'id da solo non prova che il file sia stato riaperto all'HEAD.
    expect(historicalImportantFindings([anchored, review(id)], { includeLatest: true })).toHaveLength(1);
    expect(historicalImportantFindings([anchored, review(id, 'Fix di `src/changed.mjs:L40`: ok.')], { includeLatest: true }))
      .toHaveLength(0);
    // L'id di un altro finding non chiude questo.
    const other = importantFindings(reviewFor('src/changed.mjs', 'the parser drops the first row').body)[0];
    expect(historicalImportantFindings([anchored, review(`Fix di \`${stableFindingId(other)}\`: ok.`)], { includeLatest: true }))
      .toHaveLength(1);
  });

  it('closes restated unanchored 🔴 by their printed id, never by a prose paraphrase', () => {
    // Forma delle review 5326530304 e 5326704826 (PR 9959): 🔴 senza file
    // riformulati a ogni giro con prefissi diversi. Il testo normalizzato
    // intero non viene mai ricopiato alla lettera; l'id sì. L'Accettazione qui
    // è verificabile sulla PR: quella sul solo ledger è declassata (sotto).
    const meta = (id: number, text: string) => ({
      ...historicalImportantReview,
      id,
      body: `## Findings (Important: 1, Nit: 0)\n${text}\n## Adversarial check\n- ❓ q: nessuna.`,
    });
    const history = [
      meta(10, 'Historical finding `c7a2dc47f1c0` (anchor non risolvibile): 🔴 Important: [process] Il body non dichiara la misura pre/post; non può essere chiuso per silenzio. Accettazione: il body riporta il delta pre/post.'),
      meta(11, '🔴 Important: [process] Il finding storico `e5269f0f9d49` non ha una risposta del fixer; non può essere chiuso per silenzio. Accettazione: `node scripts/ci/pr-body-check-gate.mjs --body-file body.md` esce 0.'),
    ];
    const open = historicalImportantFindings(history, { includeLatest: true });
    expect(open).toHaveLength(2);

    const narrative = {
      ...alignmentLgtmReview,
      body: `## Findings (Important: 0, Nit: 0)\n${open.map((finding) =>
        `Fix di \`Historical finding ${stableFindingId(finding)}: il bundle corrente riporta il testo completo\`: ok.`).join('\n')}\n## LGTM`,
    };
    expect(historicalImportantFindings([...history, narrative], { includeLatest: true })).toHaveLength(2);

    const byId = {
      ...alignmentLgtmReview,
      body: `## Findings (Important: 0, Nit: 0)\n${open.map((finding) =>
        `Fix di \`${stableFindingId(finding)}\`: ok.`).join('\n')}\n## LGTM`,
    };
    expect(historicalImportantFindings([...history, byId], { includeLatest: true })).toHaveLength(0);
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
      changedLinesFn: noChangedLines,
      mutate: false,
    });

    expect(result.approved).toBe(true);
    expect(result.classification.outside).toHaveLength(1);
    expect(result.classification.blocking).toBe(false);
  });

  it('requires an LGTM even for an applicable outside-only Important', async () => {
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

    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/manca ## LGTM/i);
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

  it('requires an LGTM beside an outside-only finding even for a non-funnel question', async () => {
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

    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/manca ## LGTM/i);
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
    expect(result.reason).toMatch(/nessuna review Codex/i);
  });

  it('does not treat a missing review state as COMMENTED', async () => {
    const missingState = { ...approvingBotReview } as Record<string, unknown>;
    delete missingState.state;
    const result = await runReviewGate({
      repo: 'owner/repo',
      pr: 1,
      headSha: HEAD_SHA,
      reviews: [[missingState]],
      mutate: false,
    });

    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/nessuna review Codex/i);
  });

  it('fails closed when a malformed decoded review is beside a valid verdict', async () => {
    const malformed = { ...approvingBotReview } as Record<string, unknown>;
    delete malformed.state;
    const result = await runReviewGate({
      repo: 'owner/repo',
      pr: 1,
      headSha: HEAD_SHA,
      reviews: [[approvingBotReview, malformed]],
      mutate: false,
    });

    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/malformato|non disponibile/i);
  });

  it('requires a current trusted body revision before reusing a same-HEAD verdict', async () => {
    const oldBodyReview = {
      ...approvingBotReview,
      body: `${OLD_REVIEW_INPUT_MARKER}\n## Findings (Important: 0, Nit: 0)\n\n## LGTM`,
      commit_id: HEAD_SHA,
    };
    const result = await runReviewGate({
      repo: 'owner/repo',
      pr: 1,
      headSha: HEAD_SHA,
      reviews: [[oldBodyReview]],
      reviewRevision: REVIEW_REVISION,
      mutate: false,
    });

    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/revisione body corrente/i);
  });

  it('keeps historical Important findings open until the current body revision confirms their fix', async () => {
    const historical = {
      ...historicalImportantReview,
      body: `${OLD_REVIEW_INPUT_MARKER}\n${historicalImportantReview.body}`,
      commit_id: PRIOR_SHA,
    };
    const currentClean = {
      ...approvingBotReview,
      body: `${REVIEW_INPUT_MARKER}\n## Findings (Important: 0, Nit: 0)\n\n## LGTM`,
      commit_id: HEAD_SHA,
    };
    const blocked = await runReviewGate({
      repo: 'owner/repo',
      pr: 1,
      headSha: HEAD_SHA,
      reviews: [[historical, currentClean]],
      reviewRevision: REVIEW_REVISION,
      repositoryPaths: TREE_FILES,
      classifyAndMintReviewFn: classifyCurrentDiff,
      changedLinesFn: noChangedLines,
      mutate: false,
    });
    expect(blocked.approved).toBe(false);
    expect(blocked.reason).toMatch(/finding Important/i);

    const currentFixed = {
      ...currentClean,
      body: [
        REVIEW_INPUT_MARKER,
        '## Findings (Important: 0, Nit: 0)',
        '',
        'Fix di `src/changed.mjs:L12`: ok.',
        '',
        '## LGTM',
      ].join('\n'),
    };
    const approved = await runReviewGate({
      repo: 'owner/repo',
      pr: 1,
      headSha: HEAD_SHA,
      reviews: [[historical, currentFixed]],
      reviewRevision: REVIEW_REVISION,
      repositoryPaths: TREE_FILES,
      classifyAndMintReviewFn: classifyCurrentDiff,
      changedLinesFn: noChangedLines,
      mutate: false,
    });
    expect(approved).toMatchObject({ approved: true, reviewCommit: HEAD_SHA });
  });

  it('blocks an identical-fingerprint review from a previous SHA', async () => {
    const result = await runReviewGate({
      repo: 'owner/repo',
      pr: 1,
      headSha: HEAD_SHA,
      reviews: [[approvingBotReview]],
      mutate: false,
    });

    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/non sulla HEAD|non applicabile|manca ## LGTM/i);
  });

  it('does not carry a stale Codex fallback across an autorebase', async () => {
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
    const staleFallback = {
      ...historicalImportantReview,
      body: `${CODEX_REVIEW_MARKER}\n${historicalImportantReview.body.replace(/\n## LGTM$/u, '')}`,
      commit_id: 'b'.repeat(40),
    };
    const result = await runReviewGate({
      repo: 'owner/repo',
      pr: 1,
      headSha: HEAD_SHA,
      reviews: [[historicalImportantReview, fixedReview, staleFallback]],
      classifyAndMintReviewFn: classifyCurrentDiff,
      changedPathsFn: () => [],
      mutate: false,
    });

    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/non sulla HEAD|manca ## LGTM|non applicabile/i);
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
      id: 5,
      user: { type: 'Bot', login: 'github-actions[bot]' },
      state: 'COMMENTED',
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

  it('REGRESSIONE #10580: accetta la copia riparata col marker di una prima LGTM senza marker', async () => {
    // Il modello posta la LGTM senza il marker Codex; lo step «Repair missing
    // Codex review marker» la riposta identica col marker. Il compattamento
    // «primo verdetto della HEAD» scartava la copia: gate rosso deterministico.
    const body = `${REVIEW_INPUT_MARKER}\n## Findings (Important: 0, Nit: 0)\n\n## LGTM\n`;
    const app = { type: 'Bot', login: 'frontaliere-automation[bot]' };
    const unmarked = { id: 5368550896, user: app, state: 'COMMENTED', body, commit_id: HEAD_SHA, submitted_at: '2026-09-30T15:39:20Z' };
    const repaired = { id: 5368555034, user: app, state: 'COMMENTED', body: `${CODEX_REVIEW_MARKER}\n${body}`, commit_id: HEAD_SHA, submitted_at: '2026-09-30T15:39:44Z' };
    const evidence = { provider: 'codex', model: 'gpt-5.6-luna', effort: 'max', trigger: 'runtime-429', status: 'success' };
    const result = await runReviewGate({
      repo: 'owner/repo',
      pr: 10580,
      headSha: HEAD_SHA,
      reviews: [[unmarked, repaired]],
      reviewRevision: REVIEW_REVISION,
      codexEvidence: evidence,
      mutate: false,
    });
    expect(result).toMatchObject({ approved: true, reviewCommit: HEAD_SHA });

    // Una review successiva DIVERSA resta fuori (storm #9066/#9074), anche se marcata.
    const laterImportant = {
      ...repaired,
      id: 5368555999,
      body: `${CODEX_REVIEW_MARKER}\n${REVIEW_INPUT_MARKER}\n## Findings (Important: 1, Nit: 0)\n\n\`src/changed.mjs:L12\`: 🔴 Important: rompe il contratto.\n`,
    };
    const storm = await runReviewGate({
      repo: 'owner/repo',
      pr: 10580,
      headSha: HEAD_SHA,
      reviews: [[unmarked, laterImportant]],
      reviewRevision: REVIEW_REVISION,
      codexEvidence: evidence,
      mutate: false,
    });
    expect(storm.approved).toBe(false);
    expect(storm.reason).toMatch(/review Codex marcata/i);
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
  const bot = (body: string) => ({ id: 6, user: { type: 'Bot', login: 'claude[bot]' }, state: 'COMMENTED', body, commit_id: 'c'.repeat(40) });

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

  it('ignora le citazioni adversarial deferred in uno storico Important ibrido', async () => {
    const changedFiles = [
      'scripts/ci/lib/automation-risk-policy.mjs',
      'scripts/lib/classify-issue.mjs',
      'scripts/ci/pr-autorebase.mjs',
      'scripts/ci/lib/reopen-breaker.mjs',
      'scripts/ci/review-test-policy.mjs',
    ];
    const historicalBody = [
      CODEX_REVIEW_MARKER,
      '',
      '## Scope',
      'Review of PR/issue automation policy changes affecting auto-merge, autorebase, and ledger fast-path (tier: high)',
      '',
      '## Findings (Important: 1, Nit: 0)',
      'scripts/ci/lib/automation-risk-policy.mjs:L258: 🔴 Important: il controllo `needs-human` è stato rimosso prima della distinzione `surface`, quindi `classifyAutomationRisk()` non tratta più una issue già marcata come veto issue-only; `scripts/lib/classify-issue.mjs:L149` continua a propagare `risk.needsHumanVeto`, ma ora riceve `false`. Ripristinare il controllo nel ramo `surface === \'issue\'` e limitarne la rimozione alla superficie `pull-request`, così la label PR resta tracking senza riattivare issue parcheggiate.\\n\\n## Adversarial check\\n- ❓ q: Dopo la rimozione di `decideNeedsHumanPass()`, non è verificato che `decideReopen()`/`REOPEN_BUDGET_MARKER` impediscano una nuova passata costosa a ogni tick per una PR `needs-human` invariata (`scripts/ci/pr-autorebase.mjs:L1092`) — deferred, non funnel-critical.\\n- ❓ q: `BREAKER_LABEL` resta `needs-human` (`scripts/ci/lib/reopen-breaker.mjs:L82`); non è verificato che ogni applicazione del breaker sia ancora accompagnata da un gate sticky indipendente dalla label — deferred, non funnel-critical.\\n- ❓ q: Il fast path ledger ora ammette una label `needs-human` preesistente (`scripts/ci/review-test-policy.mjs:L417`); non è verificato che nessun produttore di escalation possa far postare `## LGTM` automaticamente a una PR ledger-only ancora segnalata — deferred, non funnel-critical.',
    ].join('\n');
    const currentBody = [
      CODEX_REVIEW_MARKER,
      '## Scope',
      'Verifica della distinzione tra tracking `needs-human` sulle PR e veto/routing sulle issue, inclusi auto-merge, autorebase e fast path ledger (tier: high)',
      '',
      '## Findings (Important: 0, Nit: 0)',
      'Fix di `scripts/ci/lib/automation-risk-policy.mjs:L258`: ok.',
      'Fix di `scripts/lib/classify-issue.mjs:L149`: ok.',
      '',
      '## Adversarial check',
      '- ❓ q: autorebase invariata (scripts/ci/pr-autorebase.mjs:L1092) — deferred, non funnel-critical.',
      '- ❓ q: breaker sticky (scripts/ci/lib/reopen-breaker.mjs:L82) — deferred, non funnel-critical.',
      '- ❓ q: fast path ledger (scripts/ci/review-test-policy.mjs:L417) — deferred, non funnel-critical.',
      '',
      '## LGTM',
    ].join('\n');
    const historicalReview = {
      id: 7,
      user: { type: 'Bot', login: 'frontaliere-automation[bot]' },
      state: 'COMMENTED',
      body: historicalBody,
      commit_id: PRIOR_SHA,
    };
    const currentReview = {
      id: 8,
      user: { type: 'Bot', login: 'frontaliere-automation[bot]' },
      state: 'COMMENTED',
      body: currentBody,
      commit_id: HEAD_SHA,
    };

    expect(importantFindings(historicalBody)[0]?.citations).toEqual([
      { path: 'scripts/ci/lib/automation-risk-policy.mjs', line: 258 },
      { path: 'scripts/lib/classify-issue.mjs', line: 149 },
    ]);

    const result = await runReviewGate({
      repo: 'owner/repo',
      pr: 9030,
      headSha: HEAD_SHA,
      reviews: [[historicalReview, currentReview]],
      repositoryPaths: changedFiles,
      classifyAndMintReviewFn: async (body) => classifyReview(body, {
        files: changedFiles,
        complete: true,
        repositoryPaths: changedFiles,
      }),
      mutate: false,
    });

    expect(result.approved).toBe(true);
    expect(result.classification.findings).toHaveLength(0);
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

  // Accoppiamento per cardinalità (#9351). Un finding che cita lo stesso file su
  // due righe diventava non-confermabile per sempre appena le righe si
  // spostavano: `confirmationHasUniqueTarget(..., { ignoreLine: true })` trovava
  // due citazioni per quel path e rifiutava ogni conferma. Misurato su #9341:
  // due `## LGTM` consecutivi con `Important: 0` e gate BLOCKING invariato.
  it('chiude un finding che cita lo stesso path due volte quando le conferme sono due', () => {
    const opened = bot([
      '## Findings (Important: 1, Nit: 0)',
      '',
      '`.github/workflows/deploy.yml:L280`: 🔴 Important: `max-parallel: 2` occupa due runner; vedi anche `.github/workflows/deploy.yml:L142`.',
    ].join('\n'));
    const confirmed = bot([
      '## Findings (Important: 0, Nit: 0)',
      '',
      'Fix di `.github/workflows/deploy.yml:L308`: ok.',
      'Fix di `.github/workflows/deploy.yml:L165`: ok.',
      '',
      '## LGTM',
    ].join('\n'));

    expect(importantFindings(opened.body)[0].citations).toEqual([
      { path: '.github/workflows/deploy.yml', line: 280 },
      { path: '.github/workflows/deploy.yml', line: 142 },
    ]);
    expect(historicalImportantFindings([opened, confirmed], { includeLatest: true }))
      .toHaveLength(0);
  });

  // La proprietà da NON perdere: una sola conferma non può chiudere due punti
  // distinti che il reviewer ha chiesto di correggere entrambi.
  it('tiene aperto lo stesso finding quando le conferme di quel path sono meno delle citazioni', () => {
    const opened = bot([
      '## Findings (Important: 1, Nit: 0)',
      '',
      '`.github/workflows/deploy.yml:L280`: 🔴 Important: `max-parallel: 2` occupa due runner; vedi anche `.github/workflows/deploy.yml:L142`.',
    ].join('\n'));
    const partial = bot([
      '## Findings (Important: 0, Nit: 0)',
      '',
      'Fix di `.github/workflows/deploy.yml:L308`: ok.',
      '',
      '## LGTM',
    ].join('\n'));

    const remaining = historicalImportantFindings([opened, partial], { includeLatest: true });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].citations).toHaveLength(2);
  });

  // Guardia globale invariata: due finding aperti che citano lo stesso path
  // rendono l'anchor ambiguo FRA finding, e il conteggio non può scioglierlo.
  it('non chiude per cardinalità quando due finding aperti citano lo stesso path', () => {
    const first = bot([
      '## Findings (Important: 1, Nit: 0)',
      '',
      '`.github/workflows/deploy.yml:L280`: 🔴 Important: il cap è sbagliato; anche `.github/workflows/deploy.yml:L142`.',
    ].join('\n'));
    const second = bot([
      '## Findings (Important: 1, Nit: 0)',
      '',
      '`.github/workflows/deploy.yml:L281`: 🔴 Important: il timeout manca; anche `.github/workflows/deploy.yml:L143`.',
    ].join('\n'));
    const confirmed = bot([
      '## Findings (Important: 0, Nit: 0)',
      '',
      'Fix di `.github/workflows/deploy.yml:L308`: ok.',
      'Fix di `.github/workflows/deploy.yml:L165`: ok.',
      '',
      '## LGTM',
    ].join('\n'));

    expect(historicalImportantFindings([first, second, confirmed], { includeLatest: true }))
      .toHaveLength(2);
  });

  // La guardia globale vale sul CANDIDATO, non solo sulle citazioni del
  // gruppo: col suffix-matching un basename nudo denota anche un path omonimo
  // sotto un'altra directory, e quel path può appartenere a un altro finding
  // aperto. Senza il controllo per candidato la conferma su `foo.js` chiudeva
  // le due citazioni `src/foo.js` mentre `lib/foo.js` era ancora aperto altrove.
  it('non chiude per cardinalità quando la conferma è un basename che denota anche un altro finding aperto', () => {
    const first = bot([
      '## Findings (Important: 1, Nit: 0)',
      '',
      '`src/foo.js:L10`: 🔴 Important: il ramo è invertito; anche `src/foo.js:L20`.',
    ].join('\n'));
    const second = bot([
      '## Findings (Important: 1, Nit: 0)',
      '',
      '`lib/foo.js:L30`: 🔴 Important: il guard manca del tutto.',
    ].join('\n'));
    const confirmed = bot([
      '## Findings (Important: 0, Nit: 0)',
      '',
      'Fix di `foo.js:L11`: ok.',
      'Fix di `foo.js:L21`: ok.',
      '',
      '## LGTM',
    ].join('\n'));

    const remaining = historicalImportantFindings([first, second, confirmed], { includeLatest: true });
    expect(remaining).toHaveLength(2);
    expect(remaining.map((finding) => finding.citations.length).sort()).toEqual([1, 2]);
  });

  // Controllo: con una citazione sola il cammino è quello di prima, invariato.
  it('lascia invariato il caso a citazione singola, con riga esatta o spostata', () => {
    const opened = bot([
      '## Findings (Important: 1, Nit: 0)',
      '',
      '`.github/workflows/deploy.yml:L280`: 🔴 Important: il cap è sbagliato.',
    ].join('\n'));
    const exact = bot('## Findings (Important: 0, Nit: 0)\nFix di `.github/workflows/deploy.yml:L280`: ok.\n## LGTM');
    const moved = bot('## Findings (Important: 0, Nit: 0)\nFix di `.github/workflows/deploy.yml:L308`: ok.\n## LGTM');
    const unrelated = bot('## Findings (Important: 0, Nit: 0)\nFix di `.github/workflows/other.yml:L12`: ok.\n## LGTM');

    expect(historicalImportantFindings([opened, exact], { includeLatest: true })).toHaveLength(0);
    expect(historicalImportantFindings([opened, moved], { includeLatest: true })).toHaveLength(0);
    expect(historicalImportantFindings([opened, unrelated], { includeLatest: true })).toHaveLength(1);
  });

  // Replay di #9341 con gli anchor reali delle sei review: due citazioni su
  // `deploy-matrix-experiment.yml` più una su `cluster-pages-experiment.yml`,
  // chiuse da tre conferme su righe tutte spostate.
  it('replay #9341: tre conferme a righe spostate chiudono il finding a citazioni miste', () => {
    const opened = bot([
      '## Findings (Important: 1, Nit: 0)',
      '',
      '.github/workflows/deploy-matrix-experiment.yml:L280: 🔴 Important `max-parallel: 2` lets one run occupy two build runners; same for `.github/workflows/cluster-pages-experiment.yml:L40` and `.github/workflows/deploy-matrix-experiment.yml:L142`.',
    ].join('\n'));
    const confirmed = bot([
      '## Findings (Important: 0, Nit: 0)',
      '',
      'Fix di `.github/workflows/deploy-matrix-experiment.yml:L308`: ok.',
      'Fix di `.github/workflows/cluster-pages-experiment.yml:L39`: ok.',
      'Fix di `.github/workflows/deploy-matrix-experiment.yml:L165`: ok.',
      '',
      '## LGTM',
    ].join('\n'));

    expect(importantFindings(opened.body)[0].citations).toEqual([
      { path: '.github/workflows/deploy-matrix-experiment.yml', line: 280 },
      { path: '.github/workflows/cluster-pages-experiment.yml', line: 40 },
      { path: '.github/workflows/deploy-matrix-experiment.yml', line: 142 },
    ]);
    expect(historicalImportantFindings([opened, confirmed], { includeLatest: true }))
      .toHaveLength(0);
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

  it('treats a source snapshot path in an illustrative locality example as context', () => {
    const opened = bot([
      '## Findings (Important: 1, Nit: 0)',
      '',
      '`build-plugins/shared/jobPostingSchema.ts:L597`: 🔴 Important: resolvePostalCode() falls back incorrectly for a locality present in `data/swiss-postal-codes.json` such as `Novaggio`.',
    ].join('\n'));
    const confirmed = bot([
      '## Findings (Important: 0, Nit: 0)',
      '',
      'Fix di `build-plugins/shared/jobPostingSchema.ts:L597`: ok.',
      '',
      '## LGTM',
    ].join('\n'));

    expect(importantFindings(opened.body)[0]?.citations).toEqual([
      { path: 'build-plugins/shared/jobPostingSchema.ts', line: 597 },
    ]);
    expect(historicalImportantFindings([opened, confirmed], {
      includeLatest: true,
      repositoryPaths: [
        'build-plugins/shared/jobPostingSchema.ts',
        'data/swiss-postal-codes.json',
      ],
    })).toHaveLength(0);
  });

  it('retains a bare companion path when the same path is also illustrative context', () => {
    const opened = bot([
      '## Findings (Important: 1, Nit: 0)',
      '',
      '`build-plugins/shared/jobPostingSchema.ts:L597`: 🔴 Important: the locality is present only in `data/swiss-postal-codes.json` such as `Novaggio`; also fix `data/swiss-postal-codes.json`.',
    ].join('\n'));
    const partial = bot([
      '## Findings (Important: 0, Nit: 0)',
      '',
      'Fix di `build-plugins/shared/jobPostingSchema.ts:L597`: ok.',
      '',
      '## LGTM',
    ].join('\n'));
    const confirmed = bot([
      '## Findings (Important: 0, Nit: 0)',
      '',
      'Fix di `build-plugins/shared/jobPostingSchema.ts:L597`: ok.',
      'Fix di `data/swiss-postal-codes.json:L144`: ok.',
      '',
      '## LGTM',
    ].join('\n'));

    expect(importantFindings(opened.body)[0]?.citations).toEqual([
      { path: 'build-plugins/shared/jobPostingSchema.ts', line: 597 },
      { path: 'data/swiss-postal-codes.json', line: null },
    ]);
    expect(historicalImportantFindings([opened, partial], {
      includeLatest: true,
      repositoryPaths: [
        'build-plugins/shared/jobPostingSchema.ts',
        'data/swiss-postal-codes.json',
      ],
    })).toHaveLength(1);
    expect(historicalImportantFindings([opened, confirmed], {
      includeLatest: true,
      repositoryPaths: [
        'build-plugins/shared/jobPostingSchema.ts',
        'data/swiss-postal-codes.json',
      ],
    })).toHaveLength(0);
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

  it('abbina basename storico e path completo nelle conferme a righe spostate', () => {
    const first = bot('## Findings (Important: 1, Nit: 0)\n\n`review-gate.mjs:L465`: 🔴 Important: primo difetto.\n');
    const second = bot('## Findings (Important: 1, Nit: 0)\n\n`review-gate.mjs:L715`: 🔴 Important: secondo difetto.\n');
    const confirmed = bot([
      '## Findings (Important: 0, Nit: 0)',
      '',
      'Fix di `scripts/ci/review-gate.mjs:L472`: ok.',
      'Fix di `scripts/ci/review-gate.mjs:L733`: ok.',
      '',
      '## LGTM',
    ].join('\n'));

    expect(historicalImportantFindings([first, second, confirmed], { includeLatest: true })).toHaveLength(0);
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

describe('review gate: gitignored citations declass, everything else stays fail-closed', () => {
  const IGNORED = 'data/seo-health/latest.json';
  const ignoresOnly = (path: string) => path === IGNORED;

  it('keeps blocking a path that is absent from the tree and not ignored', () => {
    const result = classifyReview(reviewFor('scripts/ghost-typo.mjs', 'rotto'), {
      files: DIFF_FILES,
      complete: true,
      repositoryPaths: TREE_FILES,
      isIgnoredPath: ignoresOnly,
    });

    expect(result.blocking).toBe(true);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0].reason).toBe('file non risolto');
    expect(result.outside).toHaveLength(0);
    expect(result.ignoredCitations).toHaveLength(0);
  });

  it('still blocks an unknown path when no ignore proof is available at all', () => {
    const result = classifyReview(reviewFor(IGNORED, 'artefatto di run'), {
      files: DIFF_FILES,
      complete: true,
      repositoryPaths: TREE_FILES,
    });

    expect(result.blocking).toBe(true);
    expect(result.unresolved[0].reason).toBe('file non risolto');
  });

  it('declasses a finding whose only citation is a proven gitignored path', () => {
    const result = classifyReview(reviewFor(IGNORED, 'artefatto di run'), {
      files: DIFF_FILES,
      complete: true,
      repositoryPaths: TREE_FILES,
      isIgnoredPath: ignoresOnly,
    });

    expect(result.blocking).toBe(false);
    expect(result.outsideOnly).toBe(true);
    expect(result.unresolved).toHaveLength(0);
    expect(result.outside).toHaveLength(1);
    expect(result.outside[0].resolvedFiles).toEqual([IGNORED]);
    expect(result.ignoredCitations).toEqual([{ findingNumber: 1, path: IGNORED }]);
  });

  it('keeps blocking when an ignored path sits beside a real in-diff citation', () => {
    const body = `## Findings (Important: 1, Nit: 0)\n\n\`${IGNORED}\` and \`src/changed.mjs:L12\`: 🔴 Important: rotto.\n\n## LGTM`;
    const result = classifyReview(body, {
      files: DIFF_FILES,
      complete: true,
      repositoryPaths: TREE_FILES,
      isIgnoredPath: ignoresOnly,
    });

    expect(result.blocking).toBe(true);
    expect(result.inScope).toHaveLength(1);
  });

  it('logs the declassed ignored citation with its reason', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      logClassification(classifyReview(reviewFor(IGNORED, 'artefatto di run'), {
        files: DIFF_FILES,
        complete: true,
        repositoryPaths: TREE_FILES,
        isIgnoredPath: ignoresOnly,
      }));
      expect(log.mock.calls.map(([line]) => String(line)).join('\n'))
        .toContain(`DECLASSIFIED-IGNORED finding=1 path=${IGNORED}`);
    } finally {
      log.mockRestore();
    }
  });
});

describe('review gate: a fallback tree proves scope without tightening anchors', () => {
  const bot = (body: string, commit = HEAD_SHA) => ({
    id: 9,
    user: { type: 'Bot', login: 'frontaliere-automation[bot]' },
    state: 'COMMENTED',
    body,
    commit_id: commit,
  });
  // A precise anchor plus a bare companion path, both absent from the tree.
  // This is the only shape where `preciseAnchorsConfirmed` changes the verdict:
  // it gates the `isUnresolvableBareContext` escape hatch.
  const opened = bot('## Findings (Important: 1, Nit: 0)\n\n`scripts/vanished.mjs:L4` e `lib/ghost-helper.mjs`: 🔴 Important: rotto.\n');
  const confirmed = bot('## Findings (Important: 0, Nit: 0)\n\nFix di `scripts/vanished.mjs:L4`: ok.\n\n## LGTM');
  const openCount = (options: Record<string, unknown>) =>
    historicalImportantFindings([opened, confirmed], { includeLatest: true, ...options }).length;

  it('an authoritative API tree tightens the anchor and keeps the finding open', () => {
    expect(openCount({ repositoryPaths: TREE_FILES, repositoryPathsFromFallback: false })).toBe(1);
  });

  // The property the mitigation has to guarantee: a fallback tree may only
  // prove that a path is outside the diff. Inside `findingConfirmed` it is
  // inert, so it neither tightens the anchor check nor opens the bare-companion
  // escape hatch: the verdict is exactly the tree-unavailable one.
  it('is inert inside findingConfirmed, matching the tree-unavailable verdict', () => {
    const unavailable = openCount({});
    const fallback = openCount({ repositoryPaths: TREE_FILES, repositoryPathsFromFallback: true });
    expect(unavailable).toBe(1);
    expect(fallback).toBe(unavailable);
  });
});

describe('review gate: the ignore carve-out is narrow', () => {
  const alwaysIgnored = () => true;

  it('keeps blocking an ambiguous citation even when the path looks ignored', () => {
    // `dup.mjs` matches two tree paths, so nothing about it is proven.
    const tree = ['src/changed.mjs', 'a/dup.mjs', 'b/dup.mjs'];
    const result = classifyReview(reviewFor('dup.mjs', 'rotto'), {
      files: DIFF_FILES,
      complete: true,
      repositoryPaths: tree,
      isIgnoredPath: alwaysIgnored,
    });

    expect(result.blocking).toBe(true);
    expect(result.unresolved[0].reason).toBe('path ambiguo');
    expect(result.ignoredCitations).toHaveLength(0);
  });

  it('keeps blocking a citation that is in the changed list even if git ignores it', () => {
    // A deleted or newly ignored file is still part of this PR.
    const result = classifyReview(reviewFor('src/gone.mjs', 'rotto'), {
      files: ['src/gone.mjs'],
      complete: true,
      repositoryPaths: ['src/other.mjs'],
      isIgnoredPath: alwaysIgnored,
    });

    expect(result.blocking).toBe(true);
    expect(result.unresolved).toHaveLength(1);
    expect(result.ignoredCitations).toHaveLength(0);
  });
});

describe('review gate: fallback provenance reaches every authoritative consumer', () => {
  it('refuses a fallback tree inside auditHistoricalCitations, not just at the call site', () => {
    // The function is exported: the guard has to live in it, or a caller that
    // drops the provenance gets an authoritative verdict from a local tree.
    expect(() => auditHistoricalCitations([], TREE_FILES, { fromFallback: true }))
      .toThrow(/fallback non ammesso/u);
    expect(() => auditHistoricalCitations([], TREE_FILES)).not.toThrow();
  });

  it('never resolves the local tree against HEAD instead of the requested SHA', () => {
    // Pinned on the source: falling back to HEAD would resolve citations
    // against a tree other than the one under review.
    const src = readFileSync(new URL('../scripts/ci/review-gate.mjs', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('function localTreePaths'));
    const fn = body.slice(0, body.indexOf('\n}\n') + 3);
    expect(fn).toContain('ls-tree');
    expect(fn).not.toMatch(/['"`]HEAD['"`]/u);
  });

  it('routes persisted GitHub review pages through the shared strict parser', () => {
    const src = readFileSync(new URL('../scripts/ci/review-gate.mjs', import.meta.url), 'utf8');
    const read = src.slice(src.indexOf('function readReviews'));
    expect(read).toContain('parseReviewPages(pages)');
    expect(read).toContain('reviews PR: JSON/pagine/entry malformate');
  });
});

describe('review gate: an acceptance checked only on the review bundle/ledger is not a PR finding (PR 9959)', () => {
  const bot = (id: number, body: string, commit = PRIOR_SHA) => ({
    id,
    user: { type: 'Bot', login: 'frontaliere-automation[bot]' },
    state: 'COMMENTED',
    body,
    commit_id: commit,
  });
  // Forme reali, dalle review 5326530304, 5328450715 e 5330565944.
  const META = [
    'Historical finding `c7a2dc47f1c0` (anchor non risolvibile): 🔴 Important: [process] Il finding storico resta open nel bundle senza testo o anchor verificabile; non può essere chiuso per silenzio. Accettazione: risposta del fixer al finding `c7a2dc47f1c0` → il bundle successivo contiene il testo del finding, il suo anchor e una risoluzione esplicita.',
    'Historical finding 3e3cde56a33a: 🔴 Important: [process] Historical finding remains open in the bundle without a verifiable text or anchor. Accettazione: the next deterministic bundle contains the complete finding text, an anchor `path:L<line>` or `PR body:L<n>`, and an explicit resolution.',
    "Historical findings `e5269f0f9d49`, `3e3cde56a33a`: 🔴 Important: [process] Gli Important storici senza file restano aperti. Accettazione: `rg -n '\\*\\*open\\*\\*' /home/runner/work/_temp/codex-home.pqfaVw/scratch/review-ctx/review-bundle.md` produce nessun output e ogni ID elencato risulta `confirmed-fixed`.",
  ];
  // Stessa accettazione, ma ancorato al body: resta sulle regole del body e
  // sulla conferma esatta `PR body:L7` (review 5330691138).
  const BODY_META = 'PR body:L7: 🔴 Important: [process] Il bundle deterministico mantiene ancora open 45 entry storiche. Accettazione: il prossimo bundle deterministico riporta tutti i 34 stable ID come `confirmed-fixed` e nessun ledger entry `open`.';

  it('recognizes the review-ledger acceptances and nothing else', () => {
    for (const text of META) {
      const [finding] = importantFindings(text);
      expect(isLedgerAcceptanceFinding(finding), text.slice(0, 60)).toBe(true);
    }
    for (const text of [
      // Il rilievo vero di quella PR: resta bloccante.
      'PR body:L3: 🔴 Important: [process] Il claim di ottimizzazione resta non validato. Accettazione: baseline pre/post dello stesso diff da 404 path → il body riporta il delta.',
      // «bundle» e «ledger» del prodotto, non della review.
      '🔴 Important: [contract] il bundle del client importa ancora `node:fs`. Accettazione: `npm run build` → il bundle del client non contiene `node:fs`.',
      '🔴 Important: [process] il ledger dei crawler non registra la generazione. Accettazione: `data/crawler-generation-ledger.jsonl` contiene la riga della run.',
      // Una clausola vera accanto a una sul ledger: resta bloccante.
      '🔴 Important: [correctness] il conteggio è sbagliato. Accettazione: `npx vitest run tests/x.test.ts` passa.\nAccettazione: il prossimo bundle deterministico lo marca `confirmed-fixed`.',
      // Nessuna accettazione: nessuna prova che sia solo sul ledger.
      '🔴 Important: [process] il finding storico resta open nel bundle.',
      BODY_META,
      // Controesempi della review 5330691138: token nudo e clausola mista.
      '🔴 Important: [process] x. Accettazione: confirmed-fixed',
      '🔴 Important: [process] x. Accettazione: review-bundle.md exists and scripts/ci/review-gate.mjs is correct',
      '🔴 Important: [process] x. Accettazione: il prossimo bundle deterministico è rigenerato da `npx vitest run tests/review-gate.test.ts`.',
      // Review 11321: la clausola su più righe si legge fino alla fine del
      // finding, quindi il comando sulla riga di continuazione la tiene di codice
      // (senza un path: un file citato renderebbe il finding ancorato comunque).
      '🔴 Important: [process] x. Accettazione: il prossimo bundle deterministico lo marca `confirmed-fixed`\ndopo `npm run build`.',
    ]) {
      const [finding] = importantFindings(text);
      expect(isLedgerAcceptanceFinding(finding), text.slice(0, 60)).toBe(false);
    }
    // Un finding ancorato a un file non è mai toccato.
    const [anchored] = importantFindings('`scripts/ci/review-gate.mjs:L12`: 🔴 Important: il ledger perde voci. Accettazione: il prossimo bundle deterministico le mostra.');
    expect(isLedgerAcceptanceFinding(anchored)).toBe(false);
    // Il comando di accettazione della review costruisce il finding solo con `text`.
    expect(isLedgerAcceptanceFinding({ citations: [], text: 'PR body:L7: 🔴 Important: [contract] performance claim. Accettazione: review-bundle.md' })).toBe(false);
  });

  it('leaves a body-anchored ledger remark to its exact PR body confirmation', () => {
    const opened = bot(40, `## Findings (Important: 1, Nit: 0)\n${BODY_META}\n## Adversarial check`);
    expect(historicalImportantFindings([opened], { includeLatest: true })).toHaveLength(1);
    const confirmed = bot(41, '## Findings (Important: 0, Nit: 0)\nFix di `PR body:L7`: ok.\n## LGTM', HEAD_SHA);
    expect(historicalImportantFindings([opened, confirmed], { includeLatest: true })).toHaveLength(0);
  });

  it('keeps ledger-referential Important out of the historical ledger, and real ones in', () => {
    const history = META.map((text, index) => bot(10 + index, `## Findings (Important: 1, Nit: 0)\n${text}\n## Adversarial check`));
    expect(historicalImportantFindings(history, { includeLatest: true })).toHaveLength(0);
    const real = bot(20, '## Findings (Important: 1, Nit: 0)\n🔴 Important: [process] contract remains unresolved. Accettazione: `node scripts/ci/pr-body-check-gate.mjs --body-file body.md` esce 0.');
    expect(historicalImportantFindings([...history, real], { includeLatest: true })).toHaveLength(1);
  });

  it('does not approve a ledger-only Important without LGTM, and logs why', async () => {
    const history = META.map((text, index) => bot(10 + index, `## Findings (Important: 1, Nit: 0)\n${text}\n## Adversarial check`));
    const latest = bot(30, `## Findings (Important: 1, Nit: 0)\n${META[2]}\n\n## Adversarial check\n- ❓ q: nessuna. — deferred, non funnel-critical.`, HEAD_SHA);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await runReviewGate({
        repo: 'owner/repo',
        pr: 1,
        headSha: HEAD_SHA,
        reviews: [[...history, latest]],
        classifyAndMintReviewFn: async (body: string) => {
          const classification = await classifyCurrentDiff(body);
          logClassification(classification);
          return classification;
        },
        changedLinesFn: noChangedLines,
        mutate: false,
      });
      expect(result.approved).toBe(false);
      expect(result.reason).toMatch(/manca ## LGTM/i);
      expect(log.mock.calls.flat().join('\n')).toMatch(/review-gate: DECLASSIFIED-LEDGER finding=1 /u);
    } finally {
      log.mockRestore();
    }

    const withReal = bot(31, `## Findings (Important: 2, Nit: 0)\n${META[2]}\n🔴 Important: [process] contract remains unresolved.\n## Adversarial check`, HEAD_SHA);
    const blocked = await runReviewGate({
      repo: 'owner/repo',
      pr: 1,
      headSha: HEAD_SHA,
      reviews: [[...history, withReal]],
      classifyAndMintReviewFn: classifyCurrentDiff,
      changedLinesFn: noChangedLines,
      mutate: false,
    });
    expect(blocked.approved).toBe(false);
  });
});

describe('review gate: the stable id confirms a finding with cited files (#10025)', () => {
  const bot = (id: number, body: string, commit: string) => ({
    id,
    user: { type: 'Bot', login: 'frontaliere-automation[bot]' },
    state: 'COMMENTED',
    body,
    commit_id: commit,
  });
  const FP = '.github/workflows/fast-publish-article.yml';
  const RS = '.github/workflows/resync-cdn-article-chunks.yml';
  // Forma reale della review delle 14:01 su #10025: tre 🔴 sugli stessi due
  // workflow, ciascuno con una citazione per file.
  const opening = bot(1, [
    '## Findings (Important: 3, Nit: 0)',
    `- ${FP}:L196, ${RS}:L84: 🔴 Important: [correctness] il lease viene rilasciato senza verificare lo SHA esatto dell'oggetto.`,
    `- ${FP}:L212, ${RS}:L97: 🔴 Important: [correctness] il lease non viene rinnovato durante la pubblicazione lunga.`,
    `- ${FP}:L320, ${RS}:L121: 🔴 Important: [correctness] il rilascio non usa If-Match e può cancellare il lease di un altro writer.`,
  ].join('\n'), 'a'.repeat(40));
  const findings = importantFindings(opening.body);
  const ids = findings.map((finding) => stableFindingId(finding));
  const approving = (confirmations: string[]) => bot(2, [
    '## Findings (Important: 0, Nit: 0)',
    ...confirmations,
    '',
    '## LGTM',
  ].join('\n'), 'b'.repeat(40));

  it('replay: four moved-line confirmations per file for three findings close nothing', () => {
    const moved = [214, 241, 385, 393].map((line) => `Fix di \`${FP}:L${line}\`: ok.`)
      .concat([101, 126, 164, 172].map((line) => `Fix di \`${RS}:L${line}\`: ok.`));
    expect(findings).toHaveLength(3);
    expect(historicalImportantFindings([opening, approving(moved)])).toHaveLength(3);
  });

  it('the stable ids plus the re-confirmed files close exactly the confirmed findings', () => {
    expect(new Set(ids).size).toBe(3);
    const files = [`Fix di \`${FP}:L214\`: ok.`, `Fix di \`${RS}:L101\`: ok.`];
    const byId = (list: string[]) => list.map((id) => `Fix di \`${id}\`: ok.`);
    // Gli id senza nessun file riconfermato non chiudono nulla.
    expect(historicalImportantFindings([opening, approving(byId(ids))])).toHaveLength(3);
    expect(historicalImportantFindings([opening, approving([...byId(ids), ...files])])).toHaveLength(0);
    const open = historicalImportantFindings([opening, approving([...byId([ids[1]]), ...files])]);
    expect(open.map((finding) => stableFindingId(finding)).sort()).toEqual([ids[0], ids[2]].sort());
    // Un file citato senza conferma lascia il finding aperto.
    expect(historicalImportantFindings([opening, approving([...byId(ids), files[0]])])).toHaveLength(3);
  });

  it('acceptance of review 5331196488: one id for a two-file finding is not enough', () => {
    const twoFiles = bot(1, '## Findings (Important: 1, Nit: 0)\n- a.yml:L1, b.yml:L2: 🔴 Important: [correctness] il lock non viene ricontrollato prima del push.', 'a'.repeat(40));
    const [finding] = importantFindings(twoFiles.body);
    const id = `Fix di \`${stableFindingId(finding)}\`: ok.`;
    expect(historicalImportantFindings([twoFiles, approving([id])])).toHaveLength(1);
    expect(historicalImportantFindings([twoFiles, approving([id, 'Fix di `a.yml:L9`: ok.'])])).toHaveLength(1);
    expect(historicalImportantFindings([twoFiles, approving([id, 'Fix di `a.yml:L9`: ok.', 'Fix di `b.yml:L7`: ok.'])]))
      .toHaveLength(0);
  });

  it('an unknown or truncated id closes nothing', () => {
    expect(historicalImportantFindings([opening, approving([
      'Fix di `0123456789ab`: ok.',
      `Fix di \`${ids[0].slice(0, 11)}\`: ok.`,
    ])])).toHaveLength(3);
  });

  it('logs the id as the confirmation of a blocking in-diff finding', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const classification = classifyReview(opening.body, { files: [FP, RS], complete: true, repositoryPaths: [FP, RS] });
      logClassification(classification);
      expect(log.mock.calls.flat().join('\n'))
        .toContain(`review-gate: BLOCKING finding=1 path=${FP},${RS} reason=at least one cited file is in the current PR diff confirm="${ids[0]}"`);
    } finally {
      log.mockRestore();
    }
  });
});
