/**
 * Bracco Suisse (Workday) runner — description fields.
 *
 * Fixture: the start of a live Workday `jobDescription` (Cadempino, 2026-09-29).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildBraccoDescriptionFields, dropBraccoFabricatedText } from '../scripts/update-bracco-jobs.mjs';
import { keepStoredSourceBodies } from '../scripts/lib/stored-source-body.mjs';

const TEXT = fs.readFileSync(path.join(__dirname, 'fixtures', 'bracco', 'workday-description-cadempino.txt'), 'utf8').trim();

describe('buildBraccoDescriptionFields', () => {
  it('publishes the Workday text alone, keyed by its language', () => {
    const fields = buildBraccoDescriptionFields('MEDICAL DEVICE SPECIALIST - ACIST', TEXT, 'Cadempino');
    expect(fields.description).toBe(TEXT);
    expect(fields.sourceLang).toBe('en');
    expect(fields.descriptionByLocale).toEqual({ en: TEXT });
    expect(fields.description).not.toContain('Bracco Suisse S.A. is part of the Bracco Group');
  });

  it('emits no body under the shared word floor, and such a job is not published', () => {
    for (const text of ['', 'Short Workday teaser for a QA Operator in Plan-les-Ouates.']) {
      const fields = buildBraccoDescriptionFields('QA Operator', text, 'Plan-les-Ouates');
      expect(fields.description).toBe('');
      expect(fields.description).not.toMatch(/position at Bracco/);
      const url = 'https://bracco.wd3.myworkdayjobs.com/en-US/Careers/job/Plan-les-Ouates/QA-Operator_R0001';
      // What the merge does with it: no stored source body → the job is omitted.
      expect(keepStoredSourceBodies([{ url, ...fields }], [], (u: string) => u)).toEqual([]);
      // A stored source body from an earlier read is kept instead.
      const kept = keepStoredSourceBodies([{ url, ...fields }], [{ url, sourceLang: 'en', description: TEXT, descriptionByLocale: { en: TEXT } }], (u: string) => u);
      expect(kept).toHaveLength(1);
      expect(kept[0].description).toBe(TEXT);
    }
  });
});

describe('dropBraccoFabricatedText', () => {
  it('removes the Italian blurb and the translations of the blurb-appended source', () => {
    const job: any = {
      sourceLang: 'en',
      descriptionByLocale: {
        en: `${TEXT}\n\nBracco Suisse S.A. is part of the Bracco Group, an international leader in diagnostic imaging and healthcare. Its Swiss vacancies are published from the complete Swiss source feed.`,
        it: "Posizione aperta presso Bracco Suisse S.A. a Cadempino.\nRuolo: MEDICAL DEVICE SPECIALIST.\n\nBracco Suisse S.A. fa parte del Gruppo Bracco, leader internazionale nell'imaging diagnostico.",
        de: 'Bracco ist eine internationale Gruppe … gehören zu den bekannten Büros.',
      },
    };
    expect(dropBraccoFabricatedText(job)).toBe(true);
    expect(Object.keys(job.descriptionByLocale)).toEqual(['en']);
    expect(job.needsRetranslation).toBe(true);
  });

  it('leaves a clean stored job alone', () => {
    const job: any = { sourceLang: 'en', descriptionByLocale: { en: TEXT, it: 'Bracco è un Gruppo internazionale attivo nel settore sanitario.' } };
    expect(dropBraccoFabricatedText(job)).toBe(false);
    expect(job.descriptionByLocale.it).toContain('Gruppo internazionale');
  });
});
