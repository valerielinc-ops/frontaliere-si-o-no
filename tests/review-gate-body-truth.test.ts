import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  classifyReview,
  isContractDomainBodyFinding,
  renderStaleBodyFindingComment,
  runReviewGate,
} from '../scripts/ci/review-gate.mjs';

const HEAD = 'a'.repeat(40);
const BODY_RED = '## Findings (Important: 1, Nit: 0)\n\n`PR body:L13`: 🔴 Important: `blocked: configurazione owner-only` non chiude la voce.\n';
const CODE_RED = '## Findings (Important: 1, Nit: 0)\n\n`scripts/lib/foo.mjs:L12`: 🔴 Important: pagination is incomplete.\n';
const UNANCHORED_RED = '## Findings (Important: 1, Nit: 0)\n\n🔴 Important: il body dichiara per scelta senza motivo.\n';

const review = (body: string) => ({
  id: 7,
  user: { type: 'Bot', login: 'frontaliere-automation[bot]' },
  state: 'COMMENTED',
  body,
  commit_id: HEAD,
  submitted_at: '2026-09-19T12:00:00Z',
});

const PR_BODY = [
  '## Implementato', '', '- walk 20% più veloce', '', '- altro', '', '', '', '', '',
  '## Non implementato (ancora)', '',
  '- production-deploy — blocked: configurazione owner-only del ruleset',
].join('\n');
const IMPL_RED = '## Findings (Important: 1, Nit: 0)\n\n`PR body:L3`: 🔴 Important: la voce non corrisponde al diff.\n';
const files = { files: ['scripts/lib/foo.mjs'], complete: true, prBody: PR_BODY };

const STALE_BODY_FINDING = [
  '## Findings (Important: 1, Nit: 0)',
  '',
  '`PR body:L13`: 🔴 Important: la voce non è più presente nel body.',
  'Body citation: "testo rimosso dal body corrente"',
].join('\n');
const CURRENT_BODY_WITHOUT_CITATION = [
  '## Implementato',
  '',
  '- una modifica corrente',
  '',
  '- altro',
  '',
  '',
  '',
  '',
  '',
  '## Non implementato (ancora)',
  '',
  '- Nessuno.',
].join('\n');
const LOOSE_BODY_FINDING = [
  '## Findings (Important: 1, Nit: 0)',
  '',
  'nota `PR body:L13`: 🔴 Important: il claim non è più presente nel body.',
  'Body citation: "testo rimosso dal body corrente"',
].join('\n');
const PERFORMANCE_BODY = CURRENT_BODY_WITHOUT_CITATION.replace(
  '- Nessuno.',
  '- capacità dichiarata senza baseline pre-merge.',
);
const PERFORMANCE_STALE_FINDING = [
  '## Findings (Important: 1, Nit: 0)',
  '',
  '`PR body:L13`: 🔴 Important: la capacità dichiarata non ha una baseline.',
  'Body citation: "vecchia capacità dichiarata"',
].join('\n');

describe('the deterministic body contract is the single source of truth', () => {
  it('does not declassify a body-anchored 🔴 without textual-citation proof', () => {
    const passed = classifyReview(BODY_RED, { ...files, bodyContractPassed: true });
    expect(passed.blocking).toBe(true);
    expect(passed.staleBodyDeclassified).toHaveLength(0);
  });

  it('keeps it blocking when the contract verdict is not green', () => {
    expect(classifyReview(BODY_RED, { ...files, bodyContractPassed: false }).blocking).toBe(true);
    expect(classifyReview(BODY_RED, files).blocking).toBe(true);
  });

  it('never declassifies a code finding or an unanchored one', () => {
    expect(classifyReview(CODE_RED, { ...files, bodyContractPassed: true }).blocking).toBe(true);
    expect(classifyReview(UNANCHORED_RED, { ...files, bodyContractPassed: true }).blocking).toBe(true);
    expect(isContractDomainBodyFinding({ text: '🔴 Important: body', line: '🔴 Important: body' }, PR_BODY)).toBe(false);
  });

  it('keeps blocking body findings the contract cannot judge', () => {
    const perf = classifyReview(PERFORMANCE_STALE_FINDING, {
      ...files,
      bodyContractPassed: true,
      prBody: PERFORMANCE_BODY,
    });
    expect(perf.blocking).toBe(true);
    expect(perf.staleBodyDeclassified).toHaveLength(0);
    expect(classifyReview(IMPL_RED, { ...files, bodyContractPassed: true }).blocking).toBe(true);
    expect(classifyReview(BODY_RED, { ...files, prBody: null, bodyContractPassed: true }).blocking).toBe(true);
  });

  it('requires LGTM even when the contract accepts its only 🔴', async () => {
    const classifyAndMintReviewFn = async (body: string, options: { bodyContractPassed?: boolean }) =>
      classifyReview(body, { ...files, bodyContractPassed: options.bodyContractPassed });
    // runReviewGate forwards the flag; the body is supplied by the classifier stub.
    const green = await runReviewGate({
      repo: 'owner/repo', pr: 1, headSha: HEAD, reviews: [[review(BODY_RED)]], mutate: false,
      classifyAndMintReviewFn, bodyContractPassed: true,
    });
    expect(green.approved).toBe(false);
    expect(green.reason).toMatch(/manca ## LGTM/i);
    const red = await runReviewGate({
      repo: 'owner/repo', pr: 1, headSha: HEAD, reviews: [[review(BODY_RED)]], mutate: false,
      classifyAndMintReviewFn, bodyContractPassed: false,
    });
    expect(red.approved).toBe(false);
  });
});

describe('stale PR-body findings require a current textual citation', () => {
  it('declassifies a finding whose cited body text is gone and renders an explicit comment', () => {
    const result = classifyReview(STALE_BODY_FINDING, {
      ...files,
      prBody: CURRENT_BODY_WITHOUT_CITATION,
    });

    expect(result.blocking).toBe(false);
    expect(result.staleBodyDeclassified).toHaveLength(1);
    expect(renderStaleBodyFindingComment(result.staleBodyDeclassified[0], 'a'.repeat(40)))
      .toContain('testo rimosso dal body corrente');
  });

  it('keeps a finding blocking when its citation is still present', () => {
    const result = classifyReview(STALE_BODY_FINDING, {
      ...files,
      prBody: `${CURRENT_BODY_WITHOUT_CITATION}\n- testo rimosso dal body corrente`,
    });

    expect(result.blocking).toBe(true);
    expect(result.staleBodyDeclassified).toHaveLength(0);
  });

  it('keeps a body finding without a citation blocking', () => {
    const result = classifyReview(STALE_BODY_FINDING.replace(/\nBody citation:.*/u, ''), {
      ...files,
      prBody: CURRENT_BODY_WITHOUT_CITATION,
    });

    expect(result.blocking).toBe(true);
    expect(result.staleBodyDeclassified).toHaveLength(0);
  });

  it('requires the PR-body anchor at the start of the finding first line', () => {
    const result = classifyReview(LOOSE_BODY_FINDING, {
      ...files,
      prBody: CURRENT_BODY_WITHOUT_CITATION,
    });

    expect(result.blocking).toBe(true);
    expect(result.staleBodyDeclassified).toHaveLength(0);
  });

  it('keeps the contract filter while the performance claim exists, then declassifies its removal', () => {
    const stillPresent = classifyReview(PERFORMANCE_STALE_FINDING, {
      ...files,
      prBody: PERFORMANCE_BODY,
    });
    expect(stillPresent.blocking).toBe(true);
    expect(stillPresent.staleBodyDeclassified).toHaveLength(0);

    const removed = classifyReview(PERFORMANCE_STALE_FINDING, {
      ...files,
      prBody: CURRENT_BODY_WITHOUT_CITATION,
    });
    expect(removed.blocking).toBe(false);
    expect(removed.staleBodyDeclassified).toHaveLength(1);
  });

  it('normalizes spaces and markdown before deciding that a citation is present', () => {
    const result = classifyReview(
      STALE_BODY_FINDING.replace('testo rimosso dal body corrente', 'blocked: owner-only'),
      {
        ...files,
        prBody: `${CURRENT_BODY_WITHOUT_CITATION}\n- **blocked:**   owner-only`,
      },
    );

    expect(result.blocking).toBe(true);
    expect(result.staleBodyDeclassified).toHaveLength(0);
  });

  it('non confonde i caratteri Markdown letterali nel confronto stale-body', () => {
    const result = classifyReview(
      STALE_BODY_FINDING.replace('testo rimosso dal body corrente', 'field_name'),
      {
        ...files,
        prBody: `${CURRENT_BODY_WITHOUT_CITATION}\n- fieldname`,
      },
    );

    expect(result.blocking).toBe(false);
    expect(result.staleBodyDeclassified).toHaveLength(1);
  });

  it('mantiene la citazione quando la destinazione Markdown contiene parentesi', () => {
    const result = classifyReview(
      STALE_BODY_FINDING.replace('testo rimosso dal body corrente', '[guida](https://example.test/a_(b))'),
      {
        ...files,
        prBody: `${CURRENT_BODY_WITHOUT_CITATION}\n- guida`,
      },
    );

    expect(result.blocking).toBe(true);
    expect(result.staleBodyDeclassified).toHaveLength(0);
  });
});

describe('tests.yml hands the verdict to the reviewer and to the gate', () => {
  const workflow = YAML.parse(readFileSync(new URL('../.github/workflows/tests.yml', import.meta.url), 'utf8'));
  const steps = workflow.jobs.vitest.steps as Array<{ id?: string; run?: string; env?: Record<string, string>; with?: Record<string, string> }>;
  const byId = (id: string) => steps.find((step) => step.id === id);

  it('passes the body contract outcome to the gate and the bundle', () => {
    expect(byId('review_gate')?.env?.BODY_CONTRACT_OUTCOME).toBe('${{ steps.body_contract.outcome }}');
    expect(byId('prefetch')?.env?.BODY_CONTRACT_OUTCOME).toBe('${{ steps.body_contract.outcome }}');
    expect(byId('prefetch')?.run).toContain('## Deterministic body contract');
  });

  it('tells the reviewer that a body 🔴 requires a textual citation', () => {
    const prompt = byId('codex_review')?.with?.prompt || '';
    expect(prompt).toContain('PR body: one source of truth');
    expect(prompt).toContain('Body citation: "<JSON string>"');
    expect(readFileSync(new URL('../REVIEW.md', import.meta.url), 'utf8')).toContain('Una sola fonte di verità sul body');
  });
});
