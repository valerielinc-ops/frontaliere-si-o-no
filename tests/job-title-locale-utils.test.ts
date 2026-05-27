import { describe, expect, it } from 'vitest';
import { detectJobTitleLang, detectJobTitleLocaleDetails } from '../scripts/lib/job-locale-utils.mjs';

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
