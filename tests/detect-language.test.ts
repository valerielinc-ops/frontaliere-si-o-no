import { describe, it, expect } from 'vitest';
import { detectLanguage, detectLanguageWithConfidence, isSameLanguage } from '../scripts/lib/detect-language.mjs';

describe('detectLanguage', () => {
  describe('Italian texts', () => {
    it('detects Italian from a job description', () => {
      const text = 'Stiamo cercando un candidato con esperienza nel settore bancario. Requisiti: conoscenza della lingua italiana e competenze analitiche.';
      expect(detectLanguage(text)).toBe('it');
    });

    it('detects Italian from short text', () => {
      expect(detectLanguage('Offerta di lavoro per specialista')).toBe('it');
    });
  });

  describe('English texts', () => {
    it('detects English from a job description', () => {
      const text = 'We are looking for an experienced software engineer with strong skills in React and TypeScript. Requirements: 3+ years of experience.';
      expect(detectLanguage(text)).toBe('en');
    });

    it('detects English from short text', () => {
      expect(detectLanguage('Senior Software Engineer position available')).toBe('en');
    });

    it('detects English from requirements list', () => {
      const text = 'Requirements: proficiency in Python, experience with machine learning, ability to work in a team environment.';
      expect(detectLanguage(text)).toBe('en');
    });
  });

  describe('German texts', () => {
    it('detects German from a job description', () => {
      const text = 'Wir suchen einen erfahrenen Softwareentwickler. Anforderungen: Berufserfahrung mit Java und Spring. Vollzeit Festanstellung.';
      expect(detectLanguage(text)).toBe('de');
    });

    it('detects German from short text', () => {
      expect(detectLanguage('Wir suchen einen Softwareentwickler für unser Unternehmen')).toBe('de');
    });
  });

  describe('French texts', () => {
    it('detects French from a job description', () => {
      const text = 'Nous recherchons un développeur expérimenté pour notre entreprise. Compétences requises: expérience avec Python et formation en informatique.';
      expect(detectLanguage(text)).toBe('fr');
    });

    it('detects French from short text', () => {
      expect(detectLanguage('Poste de responsable des missions')).toBe('fr');
    });
  });

  describe('edge cases', () => {
    it('returns fallback for empty text', () => {
      expect(detectLanguage('', 'en')).toBe('en');
    });

    it('returns fallback for very short text', () => {
      expect(detectLanguage('Hi', 'en')).toBe('en');
    });

    it('uses custom fallback', () => {
      expect(detectLanguage('', 'de')).toBe('de');
    });

    it('defaults fallback to en', () => {
      expect(detectLanguage('')).toBe('en');
    });
  });
});

describe('detectLanguageWithConfidence', () => {
  it('returns high confidence for clear Italian text', () => {
    const result = detectLanguageWithConfidence(
      'Requisiti del candidato: esperienza nel settore finanziario, conoscenza della normativa fiscale italiana.'
    );
    expect(result.lang).toBe('it');
    expect(result.confidence).toBeGreaterThan(0.3);
  });

  it('returns correct language for clear English text', () => {
    const result = detectLanguageWithConfidence(
      'We are looking for a skilled software developer with strong problem-solving abilities and excellent communication skills to join our team.'
    );
    expect(result.lang).toBe('en');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('returns low confidence for very short text', () => {
    const result = detectLanguageWithConfidence('OK');
    expect(result.confidence).toBe(0);
  });

  it('returns scores object for debugging', () => {
    const result = detectLanguageWithConfidence(
      'Wir suchen einen Mitarbeiter für unser Team in der Schweiz.'
    );
    expect(result.lang).toBe('de');
    expect(result.scores).toBeDefined();
  });
});

describe('isSameLanguage', () => {
  it('returns true for two English texts', () => {
    expect(isSameLanguage(
      'We are looking for a software engineer',
      'Requirements include experience with React'
    )).toBe(true);
  });

  it('returns false for English vs Italian', () => {
    expect(isSameLanguage(
      'We are looking for a software engineer with experience',
      'Stiamo cercando un sviluppatore software con esperienza'
    )).toBe(false);
  });
});
