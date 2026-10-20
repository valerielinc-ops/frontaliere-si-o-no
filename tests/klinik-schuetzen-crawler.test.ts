import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseListing } from '../scripts/lib/klinik-schuetzen-job-parser.mjs';

// Real klinikschuetzen.ch careers page (2026-09-29), minimized to the first
// and the LAST job accordion plus the generic "Lehrstellen und
// Praktikumsplätze" accordion and list that follow the last job. Contacts are
// anonymized.
const PAGE_HTML = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'klinik-schuetzen', 'arbeiten-in-der-klinik.html'),
  'utf8',
);

describe('klinik-schuetzen careers page', () => {
  it('parses one job per accordion tab with its in-page deep link', () => {
    const jobs = parseListing(PAGE_HTML);
    expect(jobs.map((j) => j.id)).toEqual(['XH88AO1H', 'PLUT7122']);
    expect(jobs[1].title).toBe('Psychologiepraktikum 2028');
    expect(jobs[1].url).toBe('https://www.klinikschuetzen.ch/ueber-uns/arbeiten-in-der-klinik#job-PLUT7122');
  });

  it('stops the last job at its own accordion tab instead of running on to the footer', () => {
    const last = parseListing(PAGE_HTML).find((j) => j.id === 'PLUT7122')!;
    expect(last.description).toContain('Alle Praktika dauern mindestens 3 Monate');
    expect(last.description).toContain('Für weitere Auskünfte kontaktieren Sie bitte:');
    expect(last.description).not.toMatch(/Lehrstellen und Praktikumsplätze|Wir beschäftigen Mitarbeitende|Schützen Rheinfelden AG$/);
  });

  it('keeps list items as line-start bullets and drops the label and apply button', () => {
    const first = parseListing(PAGE_HTML)[0];
    expect(first.description).toMatch(/\nDas bringen Sie mit\n• Abgeschlossene Ausbildung auf Tertiärstufe in Pflege \(FH \/ HF\)\n• /);
    expect(first.description).toContain('Unseren 400 Mitarbeitenden bieten wir');
    expect(first.description).not.toMatch(/Jetzt bewerben/);
    expect(first.description.startsWith('Dipl. Pflegefachfrau')).toBe(false);
  });
});
