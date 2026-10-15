import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseReflineDetail, reflineJsonLdDescriptionText } from '../scripts/lib/refline-common.mjs';
import { parseReflineDetail as parseHoheneggDetail } from '../scripts/lib/privatklinik-hohenegg-job-parser.mjs';
import { parseReflineDetail as parseCaritasDetail } from '../scripts/lib/caritas-schweiz-job-parser.mjs';
import { parseReflineDetail as parsePignaDetail } from '../scripts/lib/pigna-job-parser.mjs';
import { parseReflineDetail as parseSpitalDetail } from '../scripts/lib/spital-limmattal-job-parser.mjs';

// Real Refline page, minimised (contact anonymised): Privatklinik Hohenegg,
// tenant 640332, posting 0057. The standard Refline template ships the body as
// bare text inside `<div id="bIntro|bDescription|bDuty|…" class="smartEditable">`.
const HOHENEGG_0057 = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'crawler-quality-f', 'refline-hohenegg-0057.html'),
  'utf8',
);

describe('parseReflineDetail — body of the standard smartEditable template (#5253)', () => {
  const { title, description } = parseReflineDetail(HOHENEGG_0057);

  it('reads the full posting instead of the four <h3> headings the paragraph scan saw', () => {
    expect(title).toBe('Mitarbeiter/-in Hotellerie (80-100%)');
    expect(description.split(/\s+/).length).toBeGreaterThan(200);
    expect(description).toContain('Die Privatklinik Hohenegg ist eine Spezialklinik mit 95 Betten');
    expect(description).toContain('Im Team oder selbstständig erledigen Sie vielfältige Aufgaben');
    expect(description).toContain('abgeschlossene Ausbildung in der Hotellerie');
    expect(description).toContain('gute Entlöhnung sowie attraktive Sozialleistungen');
  });

  it('keeps the section headings on their own lines and drops the repeated <h1> title', () => {
    const lines = description.split('\n');
    expect(lines).toContain('Ihre Aufgaben');
    expect(lines).toContain('Ihr Profil');
    expect(lines).toContain('Ihre Vorteile');
    expect(lines).not.toContain('Mitarbeiter/-in Hotellerie (80-100%)');
  });

  it('is the same reader for the bespoke Hohenegg parser, which used to fall back to invented text', () => {
    expect(parseHoheneggDetail).toBe(parseReflineDetail);
    expect(parseHoheneggDetail(HOHENEGG_0057).description).not.toContain('Was die Hohenegg bietet');
  });

  it.each([
    ['caritas-schweiz', parseCaritasDetail],
    ['pigna', parsePignaDetail],
    ['spital-limmattal', parseSpitalDetail],
  ])('%s keeps its own scan but can no longer lose a bare-text posting', (_label, parse) => {
    const { description: text } = parse(HOHENEGG_0057);
    expect(text).toContain('Im Team oder selbstständig erledigen Sie vielfältige Aufgaben');
    expect(text.split(/\s+/).length).toBeGreaterThan(200);
  });

  it('keeps the paragraph scan when it reads more than the JSON-LD (no regression for <p>/<li> tenants)', () => {
    const items = Array.from({ length: 12 }, (_, i) => `<li>Aufgabe Nummer ${i + 1} mit genug Worten für den Scan</li>`).join('');
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting', title: 'Pflegefachperson', description: '<div>Kurzer Teaser.</div>',
    })}</script></head><body><h1>Pflegefachperson</h1><ul>${items}</ul></body></html>`;
    const { description: text } = parseReflineDetail(html);
    expect(text).toContain('• Aufgabe Nummer 12 mit genug Worten für den Scan');
    expect(text).not.toContain('Kurzer Teaser.');
  });

  it('turns JSON-LD lists into bullets', () => {
    expect(reflineJsonLdDescriptionText({ description: '<div>Profil</div><ul><li>Erfahrung</li><li>Deutsch</li></ul>' }))
      .toBe('Profil\n• Erfahrung\n• Deutsch');
    expect(reflineJsonLdDescriptionText(null)).toBe('');
  });
});
