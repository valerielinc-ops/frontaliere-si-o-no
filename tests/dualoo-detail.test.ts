import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fetchDualooDetail, parseDualooDetail } from '../scripts/lib/dualoo-detail.mjs';

// Real page, minimised (contact card anonymised): cereneo, Dualoo portal muy5swcr.
const CERENEO_DETAIL = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'dualoo', 'cereneo-logopaede-detail.html'),
  'utf8',
);

describe('parseDualooDetail (#5253)', () => {
  const text = parseDualooDetail(CERENEO_DETAIL);

  it('starts with the ad intro that the per-tenant copies dropped', () => {
    expect(text.startsWith('Als eine der weltweit führenden Kliniken entwickeln wir')).toBe(true);
    expect(text).toContain('cereneo bietet hochspezialisierte Rehabilitationsprogramme');
  });

  it('keeps the headings the page renders, in page order', () => {
    const headings = text.split('\n\n').slice(1).map((block) => block.split('\n')[0]);
    expect(headings).toEqual(['Aufgaben:', 'Was solltest du mitbringen?', 'Wir bieten:']);
  });

  it('keeps one bullet per list item, with its label and body on the same line', () => {
    expect(text).toContain('\n• Fachgerechte Diagnostik und Therapie von Sprach-, Sprech-, Stimm- und Schluckstörungen');
    expect(text).toContain('\n• Attraktiver Arbeitsort: Moderne Infrastruktur an einzigartiger Lage');
  });

  it('keeps the paragraphs after the benefits list on their own lines instead of the last bullet', () => {
    expect(text).toContain('\nUnsere Kultur – das verbindet uns\n');
    expect(text.trimEnd().endsWith('Werde Teil unseres Teams und gestalte mit uns die Zukunft der neurologischen Rehabilitation.')).toBe(true);
  });

  it('leaves the recruiter contact card and page chrome out', () => {
    expect(text).not.toContain('Vorname Nachname');
    expect(text).not.toContain('Telefon');
    expect(text).not.toContain('Kontakt');
    expect(text).not.toContain('Bewerben');
  });

  it('falls back to the historic labels when a section renders no heading', () => {
    const html = `
      <div class="advertisementResponsibilitiesText"><ul><li>Planung</li></ul></div>
      <div class="advertisementBenefitsText"><div><p>Gutes Team</p></div><p>Und mehr</p></div>`;
    expect(parseDualooDetail(html)).toBe('Aufgaben:\n• Planung\n\nWir bieten:\nGutes Team\nUnd mehr');
  });

  it('returns an empty string for a page without Dualoo sections', () => {
    expect(parseDualooDetail('<html><body><p>Seite nicht gefunden</p></body></html>')).toBe('');
  });
});

describe('fetchDualooDetail', () => {
  it('reads the page through the injected fetcher', async () => {
    const text = await fetchDualooDetail('https://jobs.dualoo.com/portal/x/y/detail', {
      fetchPage: async () => CERENEO_DETAIL,
    });
    expect(text).toContain('Was solltest du mitbringen?');
  });

  it('returns an empty string when the fetch fails', async () => {
    await expect(fetchDualooDetail('https://jobs.dualoo.com/portal/x/y/detail', {
      fetchPage: async () => { throw new Error('HTTP 503'); },
    })).resolves.toBe('');
  });
});
