import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const review = readFileSync(new URL('../REVIEW.md', import.meta.url), 'utf8');
const lines = review.split('\n');

function headingsOutsideCodeFences(): string[] {
  let inFence = false;
  return lines.filter((line) => {
    if (line.startsWith('```')) {
      inFence = !inFence;
      return false;
    }
    return !inFence && /^#{1,3} /.test(line);
  });
}

const EXPECTED_HEADINGS = [
  '# Review Instructions',
  '## Esclusione dei test (policy del proprietario)',
  '## Scopo progetto = filtro "important"',
  '## Policy automazione bounded F1/F7',
  '## Severity',
  '### Disposizione 🟡 al review-time (anti-treadmill follow-up)',
  '## IGNORA (anche se veri)',
  '## Tier review (effort + adversarial depth)',
  '### CODE vs DATA nel diff',
  '## Completeness contract',
  '### Una sola fonte di verità sul body',
  '### Reviewer behavior',
  '### Pre-output adversarial check (tier high)',
  '## Verification',
  '## Identità di un finding',
  '### 🔴 nuovi su righe non cambiate',
  '## Igiene del body della review',
  '## Re-review convergence',
  '## Output format',
  '## Summary body',
];

describe('REVIEW.md compression contract', () => {
  it('stays below the workflow ceiling', () => {
    expect(Buffer.byteLength(review)).toBeLessThanOrEqual(19_000);
  });

  it('keeps the contract topology and numbered rules', () => {
    expect(headingsOutsideCodeFences()).toEqual(EXPECTED_HEADINGS);
    expect(lines.filter((line) => /^\d+\. /.test(line)).map((line) => line.match(/^\d+\. \*\*[^*]+/)?.[0])).toEqual([
      '1. **Monetizzazione',
      '2. **Traffico organico',
      '3. **Funnel reale',
      '1. **Implementato item',
      '2. **Non implementato item',
      '3. **Diff fa cose non dichiarate',
      '4. **Sezioni mancanti',
      '5. **Cross-file pattern repetition',
      '6. **Test plan compliance',
      '7. **Claim perf/optimization non validato',
    ]);
    expect(lines.filter((line) => line.startsWith('|'))).toHaveLength(21);
    expect(lines.filter((line) => line.startsWith('```'))).toEqual([
      '```markdown',
      '```',
      '```',
      '```',
      '```markdown',
      '```',
    ]);
  });

  it('keeps the machine-read literals and policy entrypoints', () => {
    for (const literal of [
      '## Implementato',
      '## Non implementato (ancora)',
      '## LGTM',
      '🔴 Important',
      'DECLASSIFIED-BODY',
      'DECLASSIFIED-UNCHANGED-LINE',
      'REVIEW_CARRY_FORWARD',
      'scripts/ci/lib/automation-risk-policy.mjs',
      'scripts/lib/pr-body-sections-check.mjs',
      'scripts/ci/lib/review-findings.mjs',
      'auto-merge-on-lgtm.yml',
    ]) {
      expect(review).toContain(literal);
    }
  });
});
