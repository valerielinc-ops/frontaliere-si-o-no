import { describe, it, expect } from 'vitest';
import { isImadSpontaneousApplication } from '../scripts/lib/imad-job-parser.mjs';

describe('imad SmartRecruiters posting classification', () => {
  it('recognises the generic spontaneous-application container by title and custom field', () => {
    expect(isImadSpontaneousApplication({
      name: 'Candidature spontanée / Autres',
      customField: [{ fieldLabel: 'Type de poste', valueLabel: 'Offres spontanées' }],
    })).toBe(true);
  });

  it('recognises spontaneous applications even when the title is generic', () => {
    expect(isImadSpontaneousApplication({
      name: 'Autres opportunités',
      customField: [{ fieldLabel: 'Department', valueLabel: 'Candidature spontanée' }],
    })).toBe(true);
  });

  it('keeps a role-specific vacancy', () => {
    expect(isImadSpontaneousApplication({
      name: 'Infirmier-ère diplômé-e',
      customField: [{ fieldLabel: 'Type de poste', valueLabel: 'Poste ouvert' }],
    })).toBe(false);
  });
});
