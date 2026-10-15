import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseMerianDetailContent } from '../scripts/lib/merian-iselin-job-parser.mjs';

// Real merianiselin.ch vacancy page (2026-09-29, "Köchin / Koch EFZ"),
// minimized to the job-detail container (content column + sidebar) and the
// address/directions cards that follow it. The sidebar contact is anonymized.
const DETAIL_HTML = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'merian-iselin', 'detail-koch.html'),
  'utf8',
);

describe('merian-iselin detail content', () => {
  it('reads every section of the content column with list items as line-start bullets', () => {
    const body = parseMerianDetailContent(DETAIL_HTML);
    expect(body).toMatch(/\nZutaten:\n• Abgeschlossene Ausbildung als Köchin \/ Koch EFZ\n• /);
    expect(body).toMatch(/\nZubereitung:\n• Beginnen Sie mit einer grossen Portion Leidenschaft/);
    expect(body).toMatch(/\nIhre Vorteile - unser Angebot:\n/);
    expect(body).toContain('• Jedes zweite Wochenende frei.');
    expect(body).toMatch(/dann bewerben Sie sich noch heute bei uns\.$/);
  });

  it('drops the hidden upload/consent form texts and the apply button', () => {
    const body = parseMerianDetailContent(DETAIL_HTML);
    expect(body).not.toMatch(/Dokumente hochladen|Ich bin damit einverstanden|Pflichtfelder|Online bewerben/);
  });

  it('stays out of the sidebar, the address cards and the page navigation', () => {
    const body = parseMerianDetailContent(DETAIL_HTML);
    expect(body).not.toMatch(/Job-Details|Haben Sie noch Fragen|Vorname Nachname|Föhrenstrasse|Google Maps|Jobs & Karriere/);
  });

  it('returns an empty string when the content column is missing', () => {
    expect(parseMerianDetailContent('<main><p>Seite nicht gefunden</p></main>')).toBe('');
  });
});
