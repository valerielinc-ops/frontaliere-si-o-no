import { describe, expect, it } from 'vitest';
import { computeCvMatch } from '../services/cvmatch';

describe('computeCvMatch', () => {
  it('calcola punteggio elevato per candidato perfettamente allineato', () => {
    const input = {
      cvText: 'Senior Fullstack Developer con oltre 8 anni di esperienza in TypeScript, Node.js e React a Lugano.',
      cvSkills: ['TypeScript', 'Node.js', 'React', 'PostgreSQL'],
      jobTitle: 'Senior Fullstack Developer',
      jobSkills: ['TypeScript', 'React', 'Node.js'],
      jobSeniority: 'senior' as const,
      requirements: [
        { text: 'Esperienza con TypeScript e React', requiredSkills: ['TypeScript', 'React'] },
        { text: 'Conoscenza di backend Node.js', requiredSkills: ['Node.js'] }
      ]
    };

    const result = computeCvMatch(input);
    expect(result.overall).toBeGreaterThanOrEqual(90);
    expect(result.categories.requirements.earned).toBe(40);
    expect(result.categories.keyword.earned).toBe(30);
    expect(result.missingSkills).toHaveLength(0);
    expect(result.matchedSkills).toContain('TypeScript');
  });

  it('applica la Regola Aurea del Denominatore escludendo requisiti non verificabili', () => {
    const input = {
      cvText: 'Software Engineer esperto in Go e Docker.',
      cvSkills: ['Go', 'Docker'],
      jobTitle: 'Backend Engineer',
      jobSkills: ['Go', 'Docker', 'Kubernetes'],
      requirements: [
        { text: 'Esperienza Go', requiredSkills: ['Go'] },
        { text: 'Soft skill e attitudine propositiva', requiredSkills: [] } // Requisito non verificabile!
      ]
    };

    const result = computeCvMatch(input);
    // Il requisito con requiredSkills vuoto non deve penalizzare a zero:
    // 1 su 1 requisito verificabile coperto = 100% dei 40 punti della categoria
    expect(result.categories.requirements.earned).toBe(40);
    expect(result.matchedSkills).toContain('Go');
    expect(result.missingSkills).toContain('Kubernetes');
  });

  it('aggiusta il punteggio di seniority per mismatch evidente', () => {
    const inputJunior = {
      cvText: 'Trainee Junior Developer con stage di 6 mesi in Python.',
      cvSkills: ['Python'],
      jobTitle: 'Senior Cloud Architect',
      jobSkills: ['Python', 'AWS'],
      jobSeniority: 'senior' as const,
      requirements: [{ text: 'Python', requiredSkills: ['Python'] }]
    };

    const result = computeCvMatch(inputJunior);
    expect(result.categories.seniority.earned).toBeLessThan(10);
  });
});
