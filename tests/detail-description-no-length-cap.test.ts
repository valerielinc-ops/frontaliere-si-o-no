/**
 * Parsers that cut the vacancy text at a fixed character count (issue 5253,
 * lot J of the crawler-quality fleet): long postings were published without
 * their tail (profile, offer, contact), which the parser-quality audit reports
 * as `source-detail-mismatch` once the text drops under 45 % of the source.
 *
 * Fixtures are live detail pages minimised on 2026-09-29 (contacts replaced).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractTalentsoftOfferHtml } from '../scripts/lib/talentsoft-offer-detail.mjs';
import { extractMolecularPartnersDetailDescription } from '../scripts/lib/molecular-partners-job-parser.mjs';
import { extractAarrehaSchinznachDetailDescription } from '../scripts/lib/aarreha-schinznach-job-parser.mjs';
import { extractVictorinoxDetailDescription } from '../scripts/lib/victorinox-job-parser.mjs';
import { extractEpflDetailDescription } from '../scripts/lib/epfl-job-parser.mjs';
import { parseAlpiqDetailHtml } from '../scripts/lib/alpiq-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

describe('Talentsoft #contenu-ficheoffre container', () => {
  it('reads the container to its own closing tag, not to the end of the page', () => {
    const html = fixture('talentsoft-molecular-partners-detail.html');
    const inner = extractTalentsoftOfferHtml(html);
    expect(inner).toContain('fldjobdescription_longtext1');
    expect(inner).toContain('fldlocation_longtext1');
    expect(inner).not.toContain('Apply for vacancy');
    expect(inner).not.toContain('ts-offer-page__cta');
  });

  it('returns an empty string for a page without the container', () => {
    expect(extractTalentsoftOfferHtml('<html><body><main><p>Stellen</p></main></body></html>')).toBe('');
  });

  it('Molecular Partners: publishes the whole 6.2k-character posting (was cut at 6000)', () => {
    const text = extractMolecularPartnersDetailDescription(fixture('talentsoft-molecular-partners-detail.html'));
    expect(text.length).toBeGreaterThan(6000);
    expect(text).toContain('We only accept online applications.');
    expect(text.endsWith('www.molecularpartners.com')).toBe(true);
  });

  it('aarReha Schinznach: ends with the job location, without the footer menu bullet', () => {
    const text = extractAarrehaSchinznachDetailDescription(fixture('talentsoft-aarreha-schinznach-detail.html'));
    expect(text).toContain('Als Arbeitgeber punkten wir mit:');
    expect(text.endsWith('Standort Aargau, Schinznach-Bad')).toBe(true);
    expect(text).not.toMatch(/Rechtliche Hinweise|•\s*$/);
  });

  it('Victorinox: keeps tasks, profile and benefits as bullet lines and stops at the contact', () => {
    const text = extractVictorinoxDetailDescription(fixture('talentsoft-victorinox-detail.html'));
    expect(text).toMatch(/^• Weiterentwicklung und Optimierung der zentralen Daten/m);
    expect(text).toMatch(/^• Moderne Arbeitszeitmodelle$/m);
    expect(text.endsWith('Hauptansprechpartner Beispiel Kontakt')).toBe(true);
    expect(text).not.toMatch(/Rechtliche Hinweise|•\s*$/);
  });
});

describe('EPFL SuccessFactors jobdescription', () => {
  it('publishes an 11.5k-character posting whole (was cut at 4000)', () => {
    const text = extractEpflDetailDescription(fixture('epfl-sf-detail-long.html'));
    expect(text.length).toBeGreaterThan(11000);
    expect(text).toMatch(/Applications sent by email will not be considered formal applications$/);
    expect(text).not.toContain('Apply now');
  });
});

describe('Alpiq detail page', () => {
  it('publishes the whole role section (was cut at 3000)', () => {
    const detail = parseAlpiqDetailHtml(fixture('alpiq-detail-long.html'));
    expect(detail?.title).toBe('Technische:r Betriebsmitarbeiter:in Wasserkraftwerk Gösgen');
    expect(detail?.description.length).toBeGreaterThan(3000);
    expect(detail?.description).toMatch(/• Führerausweis Kategorie B\.$/);
    expect(detail?.description).not.toContain('Alpiq Holding AG');
  });
});

// The dedicated runners execute `main()` on import (network + dataset writes),
// so their description builders cannot be called from a test. Guard the
// removed construct instead: no fixed character cap on the published text.
describe('dedicated runners publish the detail text without a character cap', () => {
  const RUNNERS = [
    'update-caseificio-gottardo-jobs.mjs',
    'update-hamilton-jobs.mjs',
    'update-kempinski-jobs.mjs',
    'update-trumpf-jobs.mjs',
    'update-axpo-jobs.mjs',
  ];
  it.each(RUNNERS)('%s', (file) => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', file), 'utf8');
    expect(source).not.toMatch(/\.slice\(0,\s*[2-9]\d{3}\)/);
    expect(source).not.toMatch(/description\.length > \d{4}/);
  });
});
