import { describe, expect, it, vi } from 'vitest';

vi.mock('../scripts/assisted-application/lib/dossier.mjs', () => ({
  adPackaging: () => '',
  dossierMode: () => 'separate',
  draftCandidateType: () => null,
  packageAttachments: vi.fn(),
}));

import { openRequiredQuestions } from '../scripts/assisted-application/lib/submit.mjs';

describe('FU-2026-10-20-010 candidate answer gate', () => {
  it('treats whitespace-only personal answers as missing while accepting a real answer', () => {
    const draft = {
      questions: [{
        id: 'personal-motivation',
        question: 'Perché vuoi questa posizione?',
        required: true,
        source: 'candidate',
      }],
    };

    expect(openRequiredQuestions(draft, { 'personal-motivation': '   ' }).map(({ id }) => id))
      .toEqual(['personal-motivation']);
    expect(openRequiredQuestions(draft, { 'personal-motivation': 'Voglio crescere nel ruolo.' }))
      .toEqual([]);
  });
});
