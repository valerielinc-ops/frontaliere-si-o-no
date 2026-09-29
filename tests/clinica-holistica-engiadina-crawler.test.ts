import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractClinicaHolisticaDescription } from '../scripts/lib/clinica-holistica-engiadina-job-parser.mjs';

const fixture = readFileSync(
  path.join(__dirname, 'fixtures', 'clinica-holistica-engiadina-detail.html'),
  'utf8',
);

describe('clinica-holistica-engiadina detail body', () => {
  it('keeps every vacancy section of the job node in page order', () => {
    const description = extractClinicaHolisticaDescription(fixture);
    const order = ['Deine Hauptaufgaben', 'Dein Profil', 'sofort oder nach Vereinbarung', '80-100%', 'Unser Angebot'];
    const positions = order.map((marker) => description.indexOf(marker));
    expect(positions.every((index) => index >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(description).toContain('Leitung von Patientengruppen');
    expect(description).toContain('Ein einzigartiger Arbeitsort im Engadin');
  });

  it('preserves the lists as line-start bullets', () => {
    const description = extractClinicaHolisticaDescription(fixture);
    expect(description).toMatch(/^• Durchführen von Vorgesprächen$/m);
    expect(description).not.toMatch(/\n\n• /);
  });

  it('drops the page chrome around the vacancy (hero, button, brochure, staff contacts)', () => {
    const description = extractClinicaHolisticaDescription(fixture);
    for (const chrome of ['Bild', 'Jetzt bewerben', 'Infobroschüre', 'Arbeiten und Leben', 'Kontakt für Fragen', 'Max Muster', '@example.test', '+41']) {
      expect(description).not.toContain(chrome);
    }
  });

  it('returns an empty string for a page without the vacancy fields so the caller falls back', () => {
    expect(extractClinicaHolisticaDescription('<main><p>Keine offenen Stellen</p></main>')).toBe('');
  });
});
