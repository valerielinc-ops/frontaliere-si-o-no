import { describe, it, expect } from 'vitest';
import { REDFLAG_IMPORTANT_RE } from '../scripts/ci/lib/constants.mjs';

// Locks the markdown-tolerant 🔴-Important detector shared by the JS auto-merge gate.
// The brittle literal `'🔴 Important'` missed the reviewer's bold form
// `🔴 **Important —` (PR #2211 round-2) → redflag-fixer skipped + PR stalled.
// pr-redflag-fixer.yml greps the SAME shape in bash; keep the two equivalent.
describe('REDFLAG_IMPORTANT_RE (markdown-tolerant 🔴 Important detector)', () => {
  it('matches the plain literal form', () => {
    expect(REDFLAG_IMPORTANT_RE.test('🔴 Important: missing canonical')).toBe(true);
  });

  it('matches the bolded form that broke the literal gate (PR #2211 round-2)', () => {
    expect(REDFLAG_IMPORTANT_RE.test('🔴 **Important —** sibling not swept')).toBe(true);
  });

  it('matches with no space and double-bold', () => {
    expect(REDFLAG_IMPORTANT_RE.test('🔴**Important** regression')).toBe(true);
  });

  it('matches inside a real multi-finding review body', () => {
    const body = '## Findings (Important: 1, Nit: 2)\n🔴 **Important — ** `x.mjs:L1`: bug\n🟡 **Nit** — tidy';
    expect(REDFLAG_IMPORTANT_RE.test(body)).toBe(true);
  });

  it('does NOT match a decorative 🔴 not followed by Important', () => {
    expect(REDFLAG_IMPORTANT_RE.test('Nessun 🔴 trovato — tutto pulito. ## LGTM')).toBe(false);
  });

  it('does NOT match the count header alone (Important without a 🔴 before it)', () => {
    expect(REDFLAG_IMPORTANT_RE.test('## Findings (Important: 0, Nit: 1)\n🟡 Nit — minor')).toBe(false);
  });

  it('does NOT match a clean LGTM review with no 🔴', () => {
    expect(REDFLAG_IMPORTANT_RE.test('Looks correct, tests cover it.\n\n## LGTM')).toBe(false);
  });
});
