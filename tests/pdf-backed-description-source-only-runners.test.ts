/**
 * PDF-backed crawlers with their own runner publish the text of the PDF (or the source's own page
 * text) and nothing of their own: no intro about the employer, no "Stelle:
 * <Titel>." line, no "Quelle (PDF): …" / "Karriereseite: …" / "Settore: …"
 * footer, no substitute sentence when the PDF has no text. Jobs stored before
 * the fix still carry that text, and the locale-preserving merge would keep
 * it — and every translation made from it — so each crawler removes it from
 * its stored jobs in the runner's merge with its `*_FABRICATED_DESCRIPTION_RE`.
 *
 * Fixture: minimized stored rows of the main slices (2026-09-29).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { buildPdfBackedDescription } from '../scripts/lib/pdf-job-content.mjs';
import { dropFabricatedDescription } from '../scripts/lib/drop-fabricated-description.mjs';
import { KLINIK_WYSSHOLZLI_FABRICATED_DESCRIPTION_RE, buildKlinikWysshholzliDescription } from '../scripts/lib/klinik-wyssholzli-job-parser.mjs';
import { BERIT_KLINIK_FABRICATED_DESCRIPTION_RE, buildBeritKlinikDescription } from '../scripts/lib/berit-klinik-job-parser.mjs';
import { CLINIQUE_LE_NOIRMONT_FABRICATED_DESCRIPTION_RE, buildCliniqueLeNoirmontDescription } from '../scripts/lib/clinique-le-noirmont-job-parser.mjs';
import { FART_FABRICATED_DESCRIPTION_RE, buildFartDescription } from '../scripts/lib/fart-job-parser.mjs';
import { TPL_FABRICATED_DESCRIPTION_RE, buildTplDescription } from '../scripts/lib/tpl-lugano-job-parser.mjs';
import { LWPHR_FABRICATED_DESCRIPTION_RE } from '../scripts/lib/lwphr-job-parser.mjs';
import { CITTA_DI_LOCARNO_FABRICATED_DESCRIPTION_RE } from '../scripts/lib/citta-di-locarno-job-parser.mjs';
import { CITTA_DI_BELLINZONA_FABRICATED_DESCRIPTION_RE } from '../scripts/lib/citta-di-bellinzona-job-parser.mjs';
import { CITTA_DI_LUGANO_FABRICATED_DESCRIPTION_RE } from '../scripts/lib/citta-di-lugano-job-parser.mjs';
import { MENDRISIO_FABRICATED_DESCRIPTION_RE } from '../scripts/update-mendrisio-jobs.mjs';

const FIXTURE = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures/crawler-fabricated-descriptions/pdf-backed-runner-crawlers.json'),
  'utf8',
));

const PATTERN_BY_CRAWLER: Record<string, RegExp> = {
  'citta-di-mendrisio': MENDRISIO_FABRICATED_DESCRIPTION_RE,
  lwphr: LWPHR_FABRICATED_DESCRIPTION_RE,
  'citta-di-locarno': CITTA_DI_LOCARNO_FABRICATED_DESCRIPTION_RE,
  'citta-di-bellinzona': CITTA_DI_BELLINZONA_FABRICATED_DESCRIPTION_RE,
  'citta-di-lugano': CITTA_DI_LUGANO_FABRICATED_DESCRIPTION_RE,
  'klinik-wyssholzli': KLINIK_WYSSHOLZLI_FABRICATED_DESCRIPTION_RE,
  fart: FART_FABRICATED_DESCRIPTION_RE,
  'berit-klinik': BERIT_KLINIK_FABRICATED_DESCRIPTION_RE,
  'clinique-le-noirmont': CLINIQUE_LE_NOIRMONT_FABRICATED_DESCRIPTION_RE,
  'tpl-lugano': TPL_FABRICATED_DESCRIPTION_RE,
};

// A PDF text as the extractor returns it: the posting's own sections.
const PDF_TEXT = [
  'Wir suchen per sofort oder nach Vereinbarung eine Fachperson Gesundheit 80-100%.',
  '',
  'Ihre Aufgaben:',
  '- Pflege und Betreuung der Patientinnen und Patienten',
  '- Dokumentation im Klinikinformationssystem',
  '',
  'Ihr Profil:',
  '- Abgeschlossene Ausbildung als FaGe EFZ',
  '- Freude an der Arbeit im Team',
].join('\n');
const PDF_ONLY = buildPdfBackedDescription({ pdfText: PDF_TEXT });

describe('stored rows carrying crawler-written text (main slices)', () => {
  const rows = Object.entries(FIXTURE).filter(([key]) => !key.startsWith('_')) as Array<[string, any]>;

  it('covers every PDF-backed crawler that had stored rows', () => {
    expect(rows.map(([key]) => key).sort()).toEqual(Object.keys(PATTERN_BY_CRAWLER).sort());
  });

  for (const [key, row] of rows) {
    it(`${key}: the fossil pattern matches the stored text and the drop removes it with its translations`, () => {
      const pattern = PATTERN_BY_CRAWLER[key];
      expect(pattern.test(row.source)).toBe(true);
      const job: any = {
        sourceLang: row.sourceLang,
        description: row.source,
        descriptionByLocale: { [row.sourceLang]: row.source, ...(row.translation || {}) },
      };
      expect(dropFabricatedDescription(job, pattern)).toBe(true);
      expect(job.descriptionByLocale).toEqual({});
      expect(job.description).toBe('');
      expect(job.needsRetranslation).toBe(true);
    });

    it(`${key}: the fossil pattern does not match the posting text alone`, () => {
      expect(PATTERN_BY_CRAWLER[key].test(PDF_ONLY)).toBe(false);
    });
  }
});

describe('description builders: the PDF text and nothing else', () => {
  const cases: Array<[string, (pdfText: string) => string]> = [
    ['klinik-wyssholzli', (t) => buildKlinikWysshholzliDescription({ title: 'Psychiater/in', pdfText: t }).description],
    ['berit-klinik', (t) => buildBeritKlinikDescription({ title: 'Fachperson Gesundheit', pdfText: t }).description],
    ['clinique-le-noirmont', (t) => buildCliniqueLeNoirmontDescription({ title: 'Infirmier/ère', pdfText: t }).description],
    ['fart', (t) => buildFartDescription('Autista di bus', t).description],
    ['tpl-lugano', (t) => buildTplDescription('Addetto/a rimessa', t, '').description],
  ];

  for (const [key, build] of cases) {
    it(`${key}: publishes the PDF text alone`, () => {
      const out = build(PDF_TEXT);
      expect(out).toBe(PDF_ONLY);
      expect(PATTERN_BY_CRAWLER[key].test(out)).toBe(false);
    });

    it(`${key}: writes nothing of its own when the PDF has no text`, () => {
      expect(build('')).toBe('');
    });
  }
});
