/**
 * PDF-backed crawlers on the standard pipeline publish the text of the PDF (or the source's own page
 * text) and nothing of their own: no intro about the employer, no "Stelle:
 * <Titel>." line, no "Quelle (PDF): …" / "Karriereseite: …" / "Settore: …"
 * footer, no substitute sentence when the PDF has no text. Jobs stored before
 * the fix still carry that text, and the locale-preserving merge would keep
 * it — and every translation made from it — so each crawler removes it from
 * its stored jobs before the merge — `prepareExistingJobs` of
 * `runStandardCrawlerPipeline` — with its `*_FABRICATED_DESCRIPTION_RE`.
 *
 * Fixture: minimized stored rows of the main slices (2026-09-29).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { buildPdfBackedDescription } from '../scripts/lib/pdf-job-content.mjs';
import { dropFabricatedDescription } from '../scripts/lib/drop-fabricated-description.mjs';
import { PALLIATIVKLINIK_FABRICATED_DESCRIPTION_RE, buildPalliativklinikDescription } from '../scripts/lib/palliativklinik-job-parser.mjs';
import { SUCHTHILFE_REGION_BASEL_FABRICATED_DESCRIPTION_RE, buildSuchthilfeRegionBaselDescription } from '../scripts/lib/suchthilfe-region-basel-job-parser.mjs';
import { THURKLINIK_FABRICATED_DESCRIPTION_RE, buildThurklinikDescription } from '../scripts/lib/thurklinik-job-parser.mjs';
import { ERGOLZ_KLINIK_FABRICATED_DESCRIPTION_RE, buildErgolzKlinikDescription } from '../scripts/lib/ergolz-klinik-job-parser.mjs';
import { CLINICA_VARINI_FABRICATED_DESCRIPTION_RE, buildVariniDescription } from '../scripts/lib/clinica-varini-job-parser.mjs';
import { CLINICA_HILDEBRAND_FABRICATED_DESCRIPTION_RE, buildHildebrandDescription } from '../scripts/lib/clinica-hildebrand-job-parser.mjs';
import { REHA_ANDEER_FABRICATED_DESCRIPTION_RE, buildRehaAndeerDescription } from '../scripts/lib/reha-andeer-job-parser.mjs';
import { TZM_FABRICATED_DESCRIPTION_RE, buildTzmDescription } from '../scripts/lib/therapiezentrum-meggen-job-parser.mjs';
import { KLINIK_SUSENBERG_FABRICATED_DESCRIPTION_RE } from '../scripts/lib/klinik-susenberg-job-parser.mjs';
import { PROSENECTUTE_TI_FABRICATED_DESCRIPTION_RE, buildProSenectuteTiDescriptionFields } from '../scripts/lib/prosenectute-ti-job-parser.mjs';
import { CSVP_POSCHIAVO_FABRICATED_DESCRIPTION_RE } from '../scripts/lib/csvp-poschiavo-job-parser.mjs';
import { ECAM_FABRICATED_DESCRIPTION_RE } from '../scripts/lib/ecam-job-parser.mjs';

const FIXTURE = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures/crawler-fabricated-descriptions/pdf-backed-standard-crawlers.json'),
  'utf8',
));

const PATTERN_BY_CRAWLER: Record<string, RegExp> = {
  'prosenectute-ti': PROSENECTUTE_TI_FABRICATED_DESCRIPTION_RE,
  palliativklinik: PALLIATIVKLINIK_FABRICATED_DESCRIPTION_RE,
  ecam: ECAM_FABRICATED_DESCRIPTION_RE,
  'clinica-varini': CLINICA_VARINI_FABRICATED_DESCRIPTION_RE,
  'klinik-susenberg': KLINIK_SUSENBERG_FABRICATED_DESCRIPTION_RE,
  'reha-andeer': REHA_ANDEER_FABRICATED_DESCRIPTION_RE,
  'therapiezentrum-meggen': TZM_FABRICATED_DESCRIPTION_RE,
  'suchthilfe-region-basel': SUCHTHILFE_REGION_BASEL_FABRICATED_DESCRIPTION_RE,
  'clinica-hildebrand': CLINICA_HILDEBRAND_FABRICATED_DESCRIPTION_RE,
  thurklinik: THURKLINIK_FABRICATED_DESCRIPTION_RE,
  'ergolz-klinik': ERGOLZ_KLINIK_FABRICATED_DESCRIPTION_RE,
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

  it('csvp-poschiavo: the former footer is recognised (no stored rows today)', () => {
    expect(CSVP_POSCHIAVO_FABRICATED_DESCRIPTION_RE.test('Testo del bando.\n\nDettagli (PDF): https://www.csvp.ch/images/bando.pdf')).toBe(true);
    expect(CSVP_POSCHIAVO_FABRICATED_DESCRIPTION_RE.test('Centro Sanitario Valposchiavo — Ospedale San Sisto, Poschiavo (GR).')).toBe(true);
    expect(CSVP_POSCHIAVO_FABRICATED_DESCRIPTION_RE.test(PDF_ONLY)).toBe(false);
  });
});

describe('description builders: the PDF text and nothing else', () => {
  const cases: Array<[string, (pdfText: string) => string]> = [
    ['palliativklinik', (t) => buildPalliativklinikDescription({ pdfText: t })],
    ['suchthilfe-region-basel', (t) => buildSuchthilfeRegionBaselDescription({ pdfText: t })],
    ['thurklinik', (t) => buildThurklinikDescription({ pdfText: t })],
    ['ergolz-klinik', (t) => buildErgolzKlinikDescription({ pdfText: t })],
    ['clinica-varini', (t) => buildVariniDescription({ title: 'Infermiere/a', pdfText: t }).description],
    ['clinica-hildebrand', (t) => buildHildebrandDescription({ title: 'Infermiere/a', pdfText: t }).description],
    ['reha-andeer', (t) => buildRehaAndeerDescription({ title: 'Pflegehelferin', pdfText: t }).description],
    ['therapiezentrum-meggen', (t) => buildTzmDescription({ title: 'Psychotherapeut/in', pdfText: t }).description],
    ['prosenectute-ti', (t) => buildProSenectuteTiDescriptionFields(t).description],
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

  it('prosenectute-ti keys the text by its own language', () => {
    const fields = buildProSenectuteTiDescriptionFields('Infermieri. Concorso generale valido per l’anno 2026: requisiti, compiti e modalità di candidatura per il personale infermieristico.');
    expect(fields.sourceLang).toBe('it');
    expect(fields.descriptionByLocale).toEqual({ it: fields.description });
  });
});
