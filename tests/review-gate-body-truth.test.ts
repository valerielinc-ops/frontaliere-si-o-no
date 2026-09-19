import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { classifyReview, isContractDomainBodyFinding, runReviewGate } from '../scripts/ci/review-gate.mjs';

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
const PERF_RED = '## Findings (Important: 1, Nit: 0)\n\n`PR body:L13`: 🔴 Important: claim perf senza baseline pre-merge.\n';
const IMPL_RED = '## Findings (Important: 1, Nit: 0)\n\n`PR body:L3`: 🔴 Important: la voce non corrisponde al diff.\n';
const files = { files: ['scripts/lib/foo.mjs'], complete: true, prBody: PR_BODY };

describe('the deterministic body contract is the single source of truth', () => {
  it('declassifies a body-anchored 🔴 when the contract passed', () => {
    const passed = classifyReview(BODY_RED, { ...files, bodyContractPassed: true });
    expect(passed.blocking).toBe(false);
    expect(passed.bodyDeclassified).toHaveLength(1);
    expect(passed.outsideOnly).toBe(true);
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
    expect(classifyReview(PERF_RED, { ...files, bodyContractPassed: true }).blocking).toBe(true);
    expect(classifyReview(IMPL_RED, { ...files, bodyContractPassed: true }).blocking).toBe(true);
    expect(classifyReview(BODY_RED, { ...files, prBody: null, bodyContractPassed: true }).blocking).toBe(true);
  });

  it('approves a review whose only 🔴 is on a body the contract accepted', async () => {
    const classifyAndMintReviewFn = async (body: string, options: { bodyContractPassed?: boolean }) =>
      classifyReview(body, { ...files, bodyContractPassed: options.bodyContractPassed });
    // runReviewGate forwards the flag; the body is supplied by the classifier stub.
    const green = await runReviewGate({
      repo: 'owner/repo', pr: 1, headSha: HEAD, reviews: [[review(BODY_RED)]], mutate: false,
      classifyAndMintReviewFn, bodyContractPassed: true,
    });
    expect(green.approved).toBe(true);
    const red = await runReviewGate({
      repo: 'owner/repo', pr: 1, headSha: HEAD, reviews: [[review(BODY_RED)]], mutate: false,
      classifyAndMintReviewFn, bodyContractPassed: false,
    });
    expect(red.approved).toBe(false);
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

  it('tells the reviewer a green contract cannot produce a body 🔴', () => {
    const prompt = byId('codex_review')?.with?.prompt || '';
    expect(prompt).toContain('PR body: one source of truth');
    expect(prompt).toContain('never emit a `🔴 Important` about the body');
    expect(readFileSync(new URL('../REVIEW.md', import.meta.url), 'utf8')).toContain('Una sola fonte di verità sul body');
  });
});
