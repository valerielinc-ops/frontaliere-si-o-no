import { describe, expect, it } from 'vitest';
import { sourceCitations, citationSchema, resolveCitations } from '../functions/src/lib/sourceCitations.js';
import { MATCH_SCHEMA } from '../functions/src/assistedApplicationAiPrompts.js';
import { sanitizeMatch } from '../functions/src/assistedApplicationAiDraftCore.js';
import { guardMobilityMatch } from '../functions/src/lib/mobilityRequirements.js';
import { conciergeProposalEligibility } from '../functions/src/assistedApplicationFitNotice.js';

describe('source-bound match evidence', () => {
  it('resolves an ID to the exact CV fragment while rejecting unknown IDs and paraphrases', () => {
    const cv = 'English B2\nResponsabile infrastrutture IT, équipe internazionale.';
    const sources = sourceCitations({ cv, answers: '', notes: 'Disponibile dal mese prossimo' });
    const raw = { matches: [
      { index: 0, status: 'met', evidence: sources.excerpts[1].id },
      { index: 1, status: 'met', evidence: '[[cv:9000]]' },
      { index: 2, status: 'met', evidence: 'International infrastructure leader' },
    ] };
    const match = sanitizeMatch(resolveCitations(raw, 'matches', 'evidence', sources), 3, `${cv}\nDisponibile dal mese prossimo`);
    expect(match.matches[0]).toMatchObject({ evidence: 'Responsabile infrastrutture IT, équipe internazionale.', evidenceUnverified: false });
    expect(match.matches.slice(1).every(item => item.evidence === '' && item.evidenceUnverified)).toBe(true);
    expect(citationSchema(MATCH_SCHEMA, 'matches', 'evidence', sources).properties.matches.items.properties.evidence.enum)
      .toEqual(['', ...sources.excerpts.map(item => item.id)]);
    expect(MATCH_SCHEMA.properties.matches.items.properties.evidence).not.toHaveProperty('enum');
  });
  it('preserves every character of long unbroken and accented sources within the verifier quote budget', () => {
    for (const text of ['é😀'.repeat(400), 'infrastructure management '.repeat(100)]) {
      const sources = sourceCitations({ cv: text });
      expect(sources.excerpts.every(item => item.text.length <= 360)).toBe(true);
      expect(sources.excerpts.map(item => item.text).join('').replace(/\s/gu, '')).toBe(text.replace(/\s/gu, ''));
      expect(sources.excerpts.every(item => !/[\uD800-\uDBFF]$/u.test(item.text))).toBe(true);
    }
  });

  it('rejects an unknown citation even when the literal token occurs in the CV', () => {
    const cv = 'Candidate experience includes the literal [[cv:999999]] token.';
    const sources = sourceCitations({ cv });
    const raw = { matches: [{ index: 0, status: 'met', evidence: '[[cv:999999]]' }] };
    expect(sanitizeMatch(resolveCitations(raw, 'matches', 'evidence', sources), 1, cv).matches[0])
      .toMatchObject({ evidence: '', evidenceUnverified: true });
  });

  it.each(['[[cv:999999]]', ''])('keeps a failed mobility citation as a technical retry: %s', evidence => {
    const cv = 'Candidate lives in Italy. Literal [[cv:999999]] appears in the source.';
    const requirements = { requirements: [{ requirement: 'Residence', quote: 'Resident in Switzerland or willingness to relocate.', importance: 'high', basis: 'stated' }] };
    const sources = sourceCitations({ cv });
    const raw = { verdict: 'good', questions: [], matches: [{ index: 0, status: 'met', evidence }] };
    const sanitized = sanitizeMatch(resolveCitations(raw, 'matches', 'evidence', sources), 1, cv);
    const context = { profile: { location: 'Exampletown, Italy' }, sourceText: cv };
    const guarded = guardMobilityMatch(requirements, sanitized, context);
    expect(guarded.matches[0].evidenceUnverified).toBe(true);
    expect(guarded.questions).toEqual([]);
    expect(conciergeProposalEligibility(requirements, guarded, context))
      .toMatchObject({ status: 'unverified', reason: 'evidence_incomplete' });
    // An actual candidate answer, unlike an invented citation, remains usable.
    const candidateGap = guardMobilityMatch(requirements, { ...sanitized,
      matches: [{ index: 0, status: 'partial', evidence: cv, evidenceUnverified: false }] }, context);
    expect(candidateGap.questions).toHaveLength(1);
    const question = candidateGap.questions[0];
    const confirmed = guardMobilityMatch(requirements, sanitized, { ...context, answers: { [question.id]: 'Sì' } });
    expect(confirmed.matches[0]).toMatchObject({ status: 'met', evidenceUnverified: false });
  });

  it('does not hide an omitted match row by generating a mobility gap', () => {
    const requirements = { requirements: [{ requirement: 'Residence', quote: 'Resident in Switzerland.', importance: 'high', basis: 'stated' }] };
    const guarded = guardMobilityMatch(requirements, { matches: [], questions: [], verdict: 'good' }, { profile: { location: 'Italy' } });
    expect(conciergeProposalEligibility(requirements, guarded)).toMatchObject({ status: 'unverified', reason: 'evidence_incomplete' });
    expect(guarded.questions).toEqual([]);
  });
});
