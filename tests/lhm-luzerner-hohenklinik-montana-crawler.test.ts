import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { extractBodyText } from '../scripts/lib/lhm-luzerner-hohenklinik-montana-job-parser.mjs';

// Real lhm.ch vacancy page (2026-09-29, "Koch / Köchin EFZ 100 %"), minimized
// to title, breadcrumb, the right-column contact portlets and the main column.
// Contacts are anonymized; the plain lowercase "zurück" anchor other LHM
// vacancies use is added next to the "Zurück" button.
const DETAIL_HTML = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'lhm-luzerner-hohenklinik-montana', 'detail-koch.html'),
  'utf8',
);

describe('lhm-luzerner-hohenklinik-montana detail body', () => {
  it('starts with the vacancy, not with the contact-person sidebar', () => {
    const body = extractBodyText(DETAIL_HTML);
    expect(body.startsWith('Zur Ergänzung unseres Teams suchen wir')).toBe(true);
    expect(body).not.toMatch(/Leiterin Hotellerie|Leiterin Personal|Sie sind hier/);
  });

  it('keeps every section of the posting as headings with line-start bullets', () => {
    const body = extractBodyText(DETAIL_HTML);
    expect(body).toMatch(/\nAufgabenbereich:\n• Produktion der Speisen in der Normal- und Diätkost\.\n• /);
    expect(body).toMatch(/\nIhr Profil\n• Ausbildung als Koch EFZ\./);
    expect(body).toMatch(/\nWir bieten Ihnen:\n• Attraktive Arbeitszeiten/);
    expect(body).toContain('Wir freuen uns auf Ihre vollständigen Bewerbungsunterlagen');
  });

  it('drops the back-to-listing links and the footer', () => {
    const body = extractBodyText(DETAIL_HTML);
    expect(body).not.toMatch(/zurück/i);
    expect(body).not.toMatch(/Luzerner Höhenklinik Montana AG/);
  });
});
