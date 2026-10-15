import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractKispiSgDetailDescription, matchKispiSgJob } from '../../scripts/lib/kispi-sg-job-parser.mjs';

// Issue 5253: a keyword-window scraper over the whole page matched «Aufgaben»
// twice, cut sections at 1500 chars or at the next heading word, capped the
// result at 8 fragments and could run into the og:description meta tag. The
// ad is the `.job-detail` block of the oks.ch vacancy page (real page,
// minimised; contact card anonymised).
describe('Ostschweizer Kinderspital detail description', () => {
  const html = readFileSync(resolve(__dirname, '..', 'fixtures', 'kispi-sg', 'detail-praktikum-pflege.html'), 'utf8');
  const text = extractKispiSgDetailDescription(html);

  it('reads the intro and every heading block once, lists as bullets', () => {
    expect(text.startsWith('Wir suchen jeweils per 1. Februar und per 1. August Praktikantinnen')).toBe(true);
    expect(text.match(/Ihre Aufgaben/g)).toHaveLength(1);
    expect(text).toContain('Ihre Aufgaben\n• Sie führen einfache pflegerische Tätigkeiten');
    expect(text).toContain('• Sie unterstützen das Team durch die Erledigung verschiedener Aufgaben im Praxisalltag');
    expect(text).toContain('Ihr Profil\n• Sie möchten einen vertieften Einblick');
    expect(text).toContain('Wir bieten Ihnen\n• Verantwortung');
    expect(text).toContain('Ihr Arbeitsbereich\nFür eine Ausbildung in einem Pflegeberuf');
  });

  it('leaves out the apply button, contact card and page metadata', () => {
    expect(text).not.toMatch(/jetzt bewerben|Ansprechperson|Kontakt|og:description|<|>/);
  });

  it('returns empty when the page has no job-detail block', () => {
    expect(extractKispiSgDetailDescription('<html><body><p>Seite nicht gefunden</p></body></html>')).toBe('');
  });

  it('merges on the Pimcore-derived id, not on the URL that moved to oks.ch', () => {
    expect(matchKispiSgJob({ id: 'kispi-sg-f71361122f0c', url: 'https://www.oks.ch/de/stellen/x-1247' }))
      .toBe(matchKispiSgJob({ id: 'kispi-sg-f71361122f0c', url: 'https://recruitingapp-2979.umantis.com/Vacancies/376/Application/CheckLogin/1?lang=ger' }));
  });
});
