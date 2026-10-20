import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { extractAccordionSections, extractBenefitCards } from '../scripts/lib/spital-lachen-job-parser.mjs';

// Real spital-lachen.ch vacancy page (2026-09-29, "Fachfrau/-mann Gesundheit
// 80% – 100% auf der Intensivstation"), minimized to the accordion widget, the
// contact block (person anonymized) and the benefits cards grid.
const DETAIL_HTML = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'spital-lachen', 'detail-fage-intensivstation.html'),
  'utf8',
);

describe('spital-lachen detail sections', () => {
  it('reads tasks and profile from the accordion widget', () => {
    const sections = extractAccordionSections(DETAIL_HTML);
    expect(sections.map((s) => s.label)).toEqual(['Ihre Aufgaben', 'Ihr Profil']);
    expect(sections[1].text).toContain('• Berufserfahrung in der Intensivpflege');
  });

  it('reads the offer from the benefits cards grid, which is not an accordion', () => {
    const benefits = extractBenefitCards(DETAIL_HTML);
    expect(benefits?.label).toBe('Ihre Vorteile');
    const lines = benefits!.text.split('\n');
    expect(lines).toHaveLength(6);
    expect(lines.every((line) => line.startsWith('• '))).toBe(true);
    expect(benefits!.text).toContain('Ferien bis 49. Altersjahr: 25 Arbeitstage');
    expect(benefits!.text).toContain('Weltweite Unfalldeckung in der privaten Abteilung');
  });

  it('keeps the contact block out of the offer section', () => {
    const benefits = extractBenefitCards(DETAIL_HTML);
    expect(benefits!.text).not.toMatch(/Haben Sie Fragen|Vorname Nachname|055 000/);
  });

  it('returns null when the page has no benefits grid', () => {
    expect(extractBenefitCards('<main><h3 class="accordion__title">Ihre Aufgaben</h3></main>')).toBeNull();
  });
});
