import { describe, expect, it } from 'vitest';
import {
  redflagRoundsOfPr,
  renderSummary,
  summarizeRedflagRounds,
} from '../scripts/ci/measure-redflag-rounds.mjs';

const marker = (round: number, at: string) => ({ createdAt: at, body: `<!-- REDFLAG_FIX_ROUND: ${round} HEAD: abc BODY: body:x -->\n_🔴-fixer round ${round}/2 avviato (auto)._` });
const review = (at: string, lgtm: boolean, author = 'frontaliere-automation') => ({
  submittedAt: at,
  author,
  body: lgtm ? '## Findings (Important: 0, Nit: 0)\nNessuno.\n\n## LGTM' : '## Findings (Important: 1, Nit: 0)\nx.mjs:L1: 🔴 Important: [other] y.',
});

const convergedAt1 = {
  number: 1, state: 'MERGED',
  comments: [marker(1, '2026-09-20T10:00:00Z')],
  reviews: [review('2026-09-20T09:00:00Z', false), review('2026-09-20T11:00:00Z', true)],
};
const convergedAt2 = {
  number: 2, state: 'MERGED',
  comments: [marker(1, '2026-09-20T10:00:00Z'), marker(2, '2026-09-20T12:00:00Z')],
  reviews: [review('2026-09-20T09:00:00Z', false), review('2026-09-20T11:00:00Z', false), review('2026-09-20T13:00:00Z', true)],
};
const stuckAtCap = {
  number: 3, state: 'OPEN',
  comments: [marker(1, '2026-09-20T10:00:00Z'), marker(2, '2026-09-20T12:00:00Z'), { createdAt: '2026-09-20T14:00:00Z', body: '<!-- NEEDS_HUMAN_ESCALATION: redflag -->\n🛑' }],
  reviews: [review('2026-09-20T09:00:00Z', false), review('2026-09-20T11:00:00Z', false), review('2026-09-20T13:00:00Z', false)],
};
const noFixer = { number: 4, state: 'MERGED', comments: [], reviews: [review('2026-09-20T09:00:00Z', true)] };

describe('measure-redflag-rounds', () => {
  it('attribuisce il LGTM al round che lo precede', () => {
    expect(redflagRoundsOfPr(convergedAt1)).toMatchObject({ convergedAtRound: 1, maxRound: 1, merged: true });
    expect(redflagRoundsOfPr(convergedAt2)).toMatchObject({ convergedAtRound: 2, maxRound: 2 });
    expect(redflagRoundsOfPr(stuckAtCap)).toMatchObject({ convergedAtRound: 0, escalated: true });
  });

  it('ignora le PR senza round e le review di altri autori', () => {
    expect(redflagRoundsOfPr(noFixer)).toBeNull();
    const human = { ...convergedAt1, reviews: [review('2026-09-20T11:00:00Z', true, 'someone')] };
    expect(redflagRoundsOfPr(human)).toMatchObject({ convergedAtRound: 0 });
  });

  it('aggrega tentativi, convergenze e il costo di un round in più', () => {
    const s = summarizeRedflagRounds([convergedAt1, convergedAt2, stuckAtCap, noFixer], { cap: 2 });
    expect(s.prs).toBe(3);
    expect(s.roundsConsumed).toBe(5);
    expect(s.attempts).toEqual({ 1: 3, 2: 2 });
    expect(s.converged).toEqual({ 1: 1, 2: 1 });
    expect(s.stuckAtCap).toBe(1);
    expect(s.escalated).toBe(1);
    expect(s.perRoundConvergence).toBeCloseTo(2 / 5);
    expect(s.extraRoundEstimate).toEqual({ extraCodexRounds: 1, expectedConverged: 0.4 });
    expect(renderSummary(s, { repo: 'o/r', since: '2026-09-15', until: '2026-09-25', cap: 2 })).toContain('| 2 | 2 | 1 | 50% |');
  });
});
