import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs helper, no types
import { buildSequence as fromShared, OPTOUT_EMAIL } from '../scripts/lib/cold-email-sequence.mjs';
// @ts-expect-error — plain .mjs script re-exports the shared sequence
import { buildSequence as fromGenerate, OPTOUT_EMAIL as OPTOUT_FROM_GENERATE } from '../scripts/generate-cold-emails.mjs';

// The admin dashboard preview (AdminPanel.tsx) imports buildSequence from the
// SAME shared module the sender uses. If a copy ever drifts, the preview lies
// about what we actually send — this guards the single-source invariant
// (AGENTS.md Non-Negotiable #6).
describe('cold-email sequence: single shared source (no drift)', () => {
  it('generate-cold-emails re-exports the exact shared buildSequence + OPTOUT_EMAIL', () => {
    expect(fromGenerate).toBe(fromShared);
    expect(OPTOUT_FROM_GENERATE).toBe(OPTOUT_EMAIL);
  });

  it('builds the full 4-touch sequence', () => {
    const seq = fromShared({ company: 'Casale SA', candidates: 49, periodLabel: 'Negli ultimi 3 mesi' });
    expect(seq).toHaveLength(4);
    expect(seq.map((t: { touch: number }) => t.touch)).toEqual([1, 2, 3, 4]);
  });

  it('personalizes touch-1 with real candidate count + tokenized placeholders + opt-out footer', () => {
    const [t1] = fromShared({ company: 'Casale SA', candidates: 49, periodLabel: 'Negli ultimi 3 mesi', contactName: 'Denise Rossi', topRole: 'Infermiere/a' });
    expect(t1.body).toContain('Ciao Denise,'); // first name only, no surname
    expect(t1.body).toContain('49 persone');
    expect(t1.body).toContain('pagina di "Infermiere/a"');
    expect(t1.body).toContain('{{INSIGHTS_URL}}'); // substituted at send/preview time
    expect(t1.body).toContain('{{UNSUB_URL}}');
    expect(t1.body).toContain(OPTOUT_EMAIL);
  });

  it('falls back to a neutral greeting + generic page label for missing/generic inputs', () => {
    const [t1] = fromShared({ company: 'Acme', candidates: 12, periodLabel: 'Negli ultimi 3 mesi', topRole: 'Lavora con noi' });
    expect(t1.body).toContain('Buongiorno,');
    expect(t1.body).toContain('pagina lavoro'); // generic role rejected
    expect(t1.body).not.toContain('pagina di "Lavora con noi"');
  });
});
