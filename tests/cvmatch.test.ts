import { describe, expect, it } from 'vitest';
import { computeCvMatch } from '../services/cvmatch';

const regulatoryRequirements = [
  'Minimo di 4-5 anni di esperienza negli affari regolatori nell’industria farmaceutica focalizzata sui medicinali finiti (piccole molecole).',
  'Una solida comprensione della legislazione farmaceutica e dei quadri normativi.',
  'Esperienza dimostrata con le procedure di registrazione UE (MRP/DCP MAAs, variazioni, estensioni e rinnovi).',
  'Esperienza precedente con registrazioni non UE è un vantaggio.',
  'Forte capacità organizzative e di pianificazione.',
  'Capacità di interpretare e comunicare efficacemente i requisiti normativi.',
  'Competenze di comunicazione scritte e verbali competenti in inglese.',
  'La conoscenza del francese e/o del tedesco è considerata un vantaggio.',
  'Alta attenzione ai dettagli e impegno alla qualità.',
];

describe('computeCvMatch', () => {
  it('non attribuisce a un annuncio competenze assenti dai suoi requisiti', () => {
    const result = computeCvMatch({
      candidateSkills: ['TypeScript', 'React', 'Git'],
      jobRequirements: regulatoryRequirements,
    });

    expect(result.status).toBe('ready');
    expect(result.overall).toBe(0);
    expect(result.matchedSkills).toEqual([]);
    expect(result.candidateOnlySkills).toEqual(['TypeScript', 'React', 'Git']);
    expect(result.jobSkills).toContain('Affari regolatori');
    expect(result.jobSkills).toContain('Registrazioni UE');
    expect(result.jobSkills).not.toContain('TypeScript');
    expect(result.jobSkills).not.toContain('React');
    expect(result.jobSkills).not.toContain('Git');
  });

  it('lascia il punteggio non calcolabile quando manca il profilo dichiarato', () => {
    const result = computeCvMatch({
      candidateSkills: [],
      jobRequirements: regulatoryRequirements,
    });

    expect(result.status).toBe('missing-profile');
    expect(result.overall).toBeNull();
  });

  it('calcola il 100% solo sulle competenze esplicite riconosciute in entrambi gli elenchi', () => {
    const result = computeCvMatch({
      candidateSkills: ['Regulatory Affairs', 'English'],
      jobRequirements: ['Esperienza negli affari regolatori e conoscenza della lingua inglese.'],
      locale: 'en',
    });

    expect(result.status).toBe('ready');
    expect(result.overall).toBe(100);
    expect(result.matchedSkills).toEqual(['Regulatory affairs', 'English']);
    expect(result.missingSkills).toEqual([]);
  });

  it('non confonde parole simili con una competenza richiesta', () => {
    const result = computeCvMatch({
      candidateSkills: ['React'],
      jobRequirements: ['Il ruolo richiede un approccio reattivo e tempi rapidi.'],
    });

    expect(result.status).toBe('no-job-skills');
    expect(result.overall).toBeNull();
    expect(result.jobSkills).toEqual([]);
  });

  it('distingue requisiti non dichiarati da competenze personali non citate nell’annuncio', () => {
    const result = computeCvMatch({
      candidateSkills: ['React'],
      jobRequirements: ['Conoscenza di TypeScript e Git.'],
    });

    expect(result.overall).toBe(0);
    expect(result.missingSkills).toEqual(['TypeScript', 'Git']);
    expect(result.candidateOnlySkills).toEqual(['React']);
  });
});
