import { describe, expect, it } from 'vitest';
import { detectJobTitleLang, detectJobTitleLocaleDetails, pinnedTitleSourceLang, titleLooksUntranslatedFromSource } from '../scripts/lib/job-locale-utils.mjs';

describe('job title locale utils', () => {
  it('detects english titles even when the description source is different', () => {
    expect(detectJobTitleLang('Banking All-Rounder', 'it')).toBe('en');
    expect(detectJobTitleLang('Quality Technician (80-100%)', 'it')).toBe('en');
  });

  it('detects obvious german and italian job titles reliably', () => {
    expect(detectJobTitleLang('Arztsekretär:in Onkologie / Hämatologie', 'it')).toBe('de');
    expect(detectJobTitleLang('Tecnico/a di radiologia medica', 'en')).toBe('it');
  });

  it('returns confident locale details for titles with strong markers', () => {
    const detected = detectJobTitleLocaleDetails('Technicien Qualité (80-100%)', 'en');
    expect(detected.lang).toBe('fr');
    expect(detected.confidence).toBeGreaterThanOrEqual(0.55);
  });
});

describe('titleLooksUntranslatedFromSource (generic leftover-source-language check)', () => {
  it('flags DE-source titles left untranslated in the IT slot (klinik-lengg.json)', () => {
    expect(titleLooksUntranslatedFromSource(
      'Fachfrau / Fachmann Gesundheit Neurorehabilitation (a) im Früh- e Spätdienst', 'de', 'it'
    )).toBe(true);
  });

  it('does not flag same-locale or empty input', () => {
    expect(titleLooksUntranslatedFromSource('Infermiere', 'it', 'it')).toBe(false);
    expect(titleLooksUntranslatedFromSource('', 'de', 'it')).toBe(false);
  });

  // Regression (PR #4728 review): a correctly-translated title carrying a German
  // place name (e.g. "Zürich") must not be flagged as untranslated. The bare 'ü'
  // diacritic alone triggered TITLE_CHAR_HINTS.de with no actual German word-hint
  // match — detectJobTitleLocaleDetails now requires word-hint support before
  // granting the confident tiers, so a toponym alone can no longer cross the bar.
  it('does not flag an already-translated title that only contains a german toponym', () => {
    // real production record: data/jobs/by-crawler/banca-cler.json, job company-fje5to
    const detected = detectJobTitleLocaleDetails('Consulente clienti Individual Zürich (f/m) 80 - 100 %', 'it');
    expect(detected.method).toBe('char-hint-only');
    expect(detected.confidence).toBeLessThan(0.55);
    expect(titleLooksUntranslatedFromSource(
      'Consulente clienti Individual Zürich (f/m) 80 - 100 %', 'de', 'it'
    )).toBe(false);
    expect(titleLooksUntranslatedFromSource(
      'Customer consultant Individual Zürich (f/m) 80 - 100 %', 'de', 'en'
    )).toBe(false);
    expect(titleLooksUntranslatedFromSource(
      'Consultant client Zürich individuel (f/m) 80 - 100 %', 'de', 'fr'
    )).toBe(false);
  });
});

describe('pinnedTitleSourceLang (publisher-authored source-lang pin)', () => {
  // Regression: "Prompt engineer da remoto" (publisher-written ITALIAN title,
  // sourceLang:'it') is detected as EN by the title heuristics → the pipeline
  // "repaired" the IT slot to "Prompt Ingegnere da remoto", destroying the paid
  // copy on the live page. Publisher records pin their declared sourceLang.
  it('pins the declared sourceLang for publisher-submitted records', () => {
    const job = { source: 'publisher-submitted', sourceLang: 'it', title: 'Prompt engineer da remoto' };
    expect(pinnedTitleSourceLang(job)).toBe('it');
    // sanity: detection alone would have misclassified this title as EN
    expect(detectJobTitleLang(job.title, 'it')).toBe('en');
  });

  it('returns null for crawled jobs and invalid/missing sourceLang', () => {
    expect(pinnedTitleSourceLang({ source: 'lastminute', sourceLang: 'it' })).toBeNull();
    expect(pinnedTitleSourceLang({ source: 'publisher-submitted' })).toBeNull();
    expect(pinnedTitleSourceLang({ source: 'publisher-submitted', sourceLang: 'xx' })).toBeNull();
    expect(pinnedTitleSourceLang(null)).toBeNull();
  });
});
