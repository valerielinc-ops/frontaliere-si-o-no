import { describe, expect, it } from 'vitest';
import { filterAuthorizedEvidenceAtoms } from '../functions/src/assistedApplicationAiDraftCore.js';

describe('filterAuthorizedEvidenceAtoms', () => {
  it('accetta atomi inseriti manualmente dal candidato', () => {
    const atoms = [
      { id: 'a1', claim: '5 anni esperienza React', provenance: 'manual' }
    ];
    const authorized = filterAuthorizedEvidenceAtoms(atoms);
    expect(authorized).toHaveLength(1);
    expect(authorized[0].id).toBe('a1');
  });

  it('accetta atomi dichiarati esplicitamente in chat durante l onboarding', () => {
    const atoms = [
      { id: 'a2', claim: 'Disponibilità immediata permesso G', provenance: 'stated_in_chat' }
    ];
    const authorized = filterAuthorizedEvidenceAtoms(atoms);
    expect(authorized).toHaveLength(1);
    expect(authorized[0].id).toBe('a2');
  });

  it('accetta atomi inferiti dall agente SOLO se approvati dal candidato', () => {
    const atoms = [
      { id: 'a3', claim: 'Certificato Goethe B2', provenance: 'agent_inferred', approvedByCandidate: true },
      { id: 'a4', claim: 'Laurea Magistrale Politecnico', provenance: 'agent_inferred', approvedByCandidate: false },
      { id: 'a5', claim: 'Competenza Kubernetes avanzata', provenance: 'agent_inferred' }
    ];
    const authorized = filterAuthorizedEvidenceAtoms(atoms);
    expect(authorized).toHaveLength(1);
    expect(authorized[0].id).toBe('a3');
  });

  it('rigetta elementi non validi o nulli', () => {
    expect(filterAuthorizedEvidenceAtoms(null as any)).toEqual([]);
    expect(filterAuthorizedEvidenceAtoms([null, undefined, {} as any])).toEqual([]);
  });
});

import { matchUserText, documentsUserText } from '../functions/src/assistedApplicationAiPrompts.js';
import { tailoredCvUserText } from '../functions/src/assistedApplicationTailoredCv.js';

describe('prompt boundaries filter unapproved evidence atoms', () => {
  const atoms = [
    { id: 'auth1', claim: 'Approved claim', provenance: 'agent_inferred', approvedByCandidate: true },
    { id: 'unauth1', claim: 'Unapproved hallucination', provenance: 'agent_inferred', approvedByCandidate: false },
    { id: 'unauth2', claim: 'Unapproved missing prop', provenance: 'agent_inferred' },
  ];

  it('filters unapproved atoms from matchUserText', () => {
    const text = matchUserText({ profile: {}, requirements: { requirements: [] }, answers: {}, candidateEvidenceAtoms: atoms });
    expect(text).toContain('Approved claim');
    expect(text).not.toContain('Unapproved hallucination');
    expect(text).not.toContain('Unapproved missing prop');
  });

  it('filters unapproved atoms from documentsUserText', () => {
    const text = documentsUserText({ profile: {}, requirements: { requirements: [] }, matches: [], answers: {}, candidateEvidenceAtoms: atoms, postingExcerpt: '' });
    expect(text).toContain('Approved claim');
    expect(text).not.toContain('Unapproved hallucination');
    expect(text).not.toContain('Unapproved missing prop');
  });

  it('filters unapproved atoms from tailoredCvUserText', () => {
    const text = tailoredCvUserText({ profile: {}, requirements: [], roleTitle: 'Dev', postingExcerpt: '', answers: {}, candidateEvidenceAtoms: atoms });
    expect(text).toContain('Approved claim');
    expect(text).not.toContain('Unapproved hallucination');
    expect(text).not.toContain('Unapproved missing prop');
  });
});
