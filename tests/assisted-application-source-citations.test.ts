import { describe, expect, it } from 'vitest';
import { sourceCitations, citationSchema, resolveCitations } from '../functions/src/lib/sourceCitations.js';
import { MATCH_SCHEMA } from '../functions/src/assistedApplicationAiPrompts.js';
import { sanitizeMatch } from '../functions/src/assistedApplicationAiDraftCore.js';

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
});
