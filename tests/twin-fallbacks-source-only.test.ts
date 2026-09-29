/**
 * Parsers that wrote a description of their own when the posting's text was
 * not read (lot L 2, #5253): the onlyfy tenants Spitex Zürich and Vitrea
 * Gesundheit, Spitex Schweiz (spitex-ch), Centro Sanitario Bregaglia and OSCAM
 * Castelrotto (which also wrapped the PDF bando in lines of its own). They
 * now publish only the source's text; without it the job gets no description
 * and the pipeline quarantines it as thin-source. Jobs stored with the old
 * text are cleaned before the merge through `prepareExistingJobs`.
 *
 * Fixture: minimized stored rows of the main slices (2026-09-29).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { dropFabricatedDescription } from '../scripts/lib/drop-fabricated-description.mjs';
import { SPITEX_ZUERICH_FABRICATED_DESCRIPTION_RE } from '../scripts/lib/spitex-zuerich-job-parser.mjs';
import { VITREA_GESUNDHEIT_FABRICATED_DESCRIPTION_RE } from '../scripts/lib/vitrea-gesundheit-job-parser.mjs';
import { SPITEX_CH_FABRICATED_DESCRIPTION_RE } from '../scripts/lib/spitex-ch-job-parser.mjs';
import { CS_BREGAGLIA_FABRICATED_DESCRIPTION_RE } from '../scripts/lib/cs-bregaglia-job-parser.mjs';
import {
  buildDescription as buildOscamCastelrottoDescription,
  OSCAM_CASTELROTTO_FABRICATED_DESCRIPTION_RE,
} from '../scripts/lib/oscam-castelrotto-job-parser.mjs';

const FIXTURE = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures/crawler-fabricated-descriptions/twin-crawlers.json'),
  'utf8',
));

const PATTERN_BY_CRAWLER: Record<string, RegExp> = {
  'spitex-zuerich': SPITEX_ZUERICH_FABRICATED_DESCRIPTION_RE,
  'vitrea-gesundheit': VITREA_GESUNDHEIT_FABRICATED_DESCRIPTION_RE,
  'oscam-castelrotto': OSCAM_CASTELROTTO_FABRICATED_DESCRIPTION_RE,
};

// Source text of the same kind (an ad with its own bullets): no pattern may
// take it for text the parser wrote.
const SOURCE_TEXT = [
  'Ihre Aufgaben',
  '• Pflege und Betreuung der Klientinnen und Klienten zu Hause',
  '• Bewerbung bitte über unser Online-Formular',
  'Ihr Profil',
  '• Abgeschlossene Ausbildung als Pflegefachperson HF',
].join('\n');

describe('stored rows carrying parser-written text (main slices)', () => {
  const rows = Object.entries(FIXTURE).filter(([key]) => !key.startsWith('_')) as Array<[string, any]>;

  it('covers every crawler with stored rows', () => {
    expect(rows.map(([key]) => key).sort()).toEqual(Object.keys(PATTERN_BY_CRAWLER).sort());
  });

  for (const [key, row] of rows) {
    it(`${key}: the stored text is recognised and removed with its translations`, () => {
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
  }

  it('no pattern matches the text of a posting', () => {
    for (const pattern of [
      ...Object.values(PATTERN_BY_CRAWLER),
      SPITEX_CH_FABRICATED_DESCRIPTION_RE,
      CS_BREGAGLIA_FABRICATED_DESCRIPTION_RE,
    ]) {
      expect(pattern.test(SOURCE_TEXT)).toBe(false);
    }
  });

  it('spitex-ch and cs-bregaglia: the former substitutes are recognised (no stored rows today)', () => {
    expect(SPITEX_CH_FABRICATED_DESCRIPTION_RE.test(
      'Pflegefachperson HF bei Spitex Bern in Bern.\n\nSpitex-Stelle in der Schweizer Hauspflege. Diese Position bietet ein modernes Arbeitsumfeld, attraktive Anstellungsbedingungen und vielfältige Weiterbildungsmöglichkeiten.',
    )).toBe(true);
    expect(CS_BREGAGLIA_FABRICATED_DESCRIPTION_RE.test('Infermiere/a — Centro Sanitario Bregaglia, Promontogno (GR).')).toBe(true);
    // Only as the whole description: the source text may name the centre.
    expect(CS_BREGAGLIA_FABRICATED_DESCRIPTION_RE.test('Il Centro Sanitario Bregaglia, Promontogno (GR). Cerchiamo un infermiere.')).toBe(false);
  });
});

describe('oscam-castelrotto: the description is the bando only', () => {
  const bando = [
    'CONCORSO GENERALE 2026 L’Ospedale Malcantonese (con i suoi reparti di medicina e di psichiatria,',
    'centro di primo soccorso e servizi ambulatoriali) rende noto che è aperto il concorso generale',
    'per l\'assunzione del seguente personale: - personale di cura e terapeutico (infermieri, operatori sociosanitari).',
  ].join(' ');

  it('publishes the text of the PDF without lines of the parser', () => {
    const description = buildOscamCastelrottoDescription(bando);
    expect(description.startsWith('CONCORSO GENERALE 2026')).toBe(true);
    expect(OSCAM_CASTELROTTO_FABRICATED_DESCRIPTION_RE.test(description)).toBe(false);
    expect(description).not.toContain('Bando completo (PDF)');
    expect(description).not.toContain('presso l\'Ospedale Malcantonese OSCAM');
  });

  it('writes nothing when the PDF has no readable text (thin-source path)', () => {
    expect(buildOscamCastelrottoDescription('')).toBe('');
  });
});
