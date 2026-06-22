import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs helper, no types
import { buildSequence, OPTOUT_EMAIL } from '../scripts/generate-cold-emails.mjs';

// Compliance guard: cold B2B outreach MUST carry an opt-out on every touch
// (Swiss nDSG/GDPR norm + deliverability). Regressing this risks the sending
// domain's reputation, so it's a hard invariant — not a stylistic nit.
describe('cold-email opt-out invariant', () => {
  const seq = buildSequence({
    company: 'Casale SA',
    candidates: 88,
    periodLabel: 'negli ultimi 3 mesi',
    contactName: 'Denise Rossi',
    topRole: 'Magazziniere',
  });

  it('builds the full 4-touch sequence', () => {
    expect(seq.map((m: any) => m.touch)).toEqual([1, 2, 3, 4]);
  });

  it('every touch includes a working opt-out footer', () => {
    expect(OPTOUT_EMAIL).toMatch(/@frontaliereticino\.ch$/);
    for (const m of seq) {
      expect(m.body, `touch ${m.touch} opt-out instruction`).toMatch(/rispondete con "STOP"/);
      expect(m.body, `touch ${m.touch} opt-out address`).toContain(OPTOUT_EMAIL);
    }
  });
});
