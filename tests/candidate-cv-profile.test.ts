import { describe, expect, it } from 'vitest';
import { parseCandidateCvText } from '../functions/src/candidateCvProfile.js';
import { scoreJobForProfile } from '../functions/src/applicationConciergeMatching.js';

describe('candidate CV profile projection', () => {
  it('extracts traceable contact, role, skills and language facts', () => {
    const profile = parseCandidateCvText(`
      Antonio Pangallo
      antonio@example.com · +41 79 123 45 67
      Infermiere diplomato
      ESPERIENZA
      2022 - oggi Infermiere reparto medicina, Lugano
      COMPETENZE
      triage, assistenza pazienti, cartella clinica
      LINGUE
      Italiano, tedesco B1
    `);

    expect(profile.fullName).toBe('Antonio Pangallo');
    expect(profile.email).toBe('antonio@example.com');
    expect(profile.phone).toContain('+41');
    expect(profile.workPosition).toContain('Infermiere');
    expect(profile.skills).toContain('triage');
    expect(profile.languages).toEqual(expect.arrayContaining(['italiano', 'tedesco']));
    expect(profile.searchText).toContain('Infermiere');
  });

  it('does not fabricate a profile from an empty or scanned document', () => {
    const profile = parseCandidateCvText('');
    expect(profile.extractedTextAvailable).toBe(false);
    expect(profile.workPosition).toBe('');
    expect(profile.skills).toEqual([]);
  });
});
describe('application concierge matching', () => {
  it('returns an explainable match for overlapping role and skills', () => {
    const result = scoreJobForProfile(
      {
        title: 'Infermiere diplomato – reparto medicina',
        company: 'Clinica Example',
        location: 'Lugano',
        requirements: 'triage e assistenza pazienti',
      },
      {
        workPosition: 'Infermiere diplomato',
        headline: 'Infermiere',
        skills: ['triage', 'assistenza pazienti'],
        experienceSummary: ['2022 - oggi reparto medicina'],
      },
    );

    expect(result.score).toBeGreaterThan(0);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('rejects a job with no meaningful profile overlap', () => {
    const result = scoreJobForProfile(
      { title: 'Senior accountant', requirements: 'US GAAP and audit' },
      { workPosition: 'Infermiere', skills: ['triage'], experienceSummary: [] },
    );
    expect(result.score).toBe(0);
    expect(result.reasons).toEqual([]);
  });
});
// End of focused CV workflow coverage.
