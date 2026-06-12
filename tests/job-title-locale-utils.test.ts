import { describe, expect, it } from 'vitest';
import { detectJobTitleLang, detectJobTitleLocaleDetails, pinnedTitleSourceLang } from '../scripts/lib/job-locale-utils.mjs';

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
