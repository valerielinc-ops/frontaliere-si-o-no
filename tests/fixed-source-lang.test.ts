import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resyncStoredSourceLang, sourceLangOfBody } from '../scripts/lib/source-locale-slots.mjs';

// Pinned: a published Hirslanden posting (main slice, 2026-09-29) written in
// French and published with sourceLang `de`, #5253.
const samples = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'crawler-quality-f', 'fixed-source-lang-samples.json'),
  'utf8',
));

type Sample = {
  sourceLang: string,
  publishedSourceLang: string,
  title: string,
  location: string,
  description: string,
  slugByLocale: Record<string, string>,
};

const GERMAN = 'Wir suchen per sofort oder nach Vereinbarung eine engagierte Fachperson für unser Team. '
  + 'Sie betreuen unsere Kundinnen und Kunden kompetent, arbeiten eng mit den anderen Abteilungen zusammen '
  + 'und übernehmen Verantwortung für die täglichen Abläufe in der Filiale. Wir bieten Ihnen eine '
  + 'abwechslungsreiche Tätigkeit, ein motiviertes Team und fortschrittliche Anstellungsbedingungen.';

describe('source language read from the body, not a fixed key (#5253)', () => {
  it('reads the pinned French body as French, whatever key it was published under', () => {
    const sample: Sample = samples['hirslanden-fr'];
    expect(sample.publishedSourceLang).toBe('de');
    expect(sourceLangOfBody(sample.description, 'de')).toBe('fr');
  });

  // 33 of 339 Hirslanden postings on main: French, with the French body
  // under `de`, `it` and `en`.
  it('resyncStoredSourceLang moves a stored body filed under a fixed key to its own language', () => {
    const sample: Sample = samples['hirslanden-fr'];
    const body = sample.description;
    const job: any = {
      sourceLang: sample.publishedSourceLang,
      description: body,
      titleByLocale: { de: sample.title },
      descriptionByLocale: { de: body, it: body, en: body, fr: 'Traduction automatique du texte.' },
      slugByLocale: { ...sample.slugByLocale },
    };
    expect(resyncStoredSourceLang(job)).toBe(true);
    expect(job.sourceLang).toBe('fr');
    expect(job.descriptionByLocale).toEqual({ fr: body });
    expect(job.needsRetranslation).toBe(true);
    // Published slugs are left alone.
    expect(job.slugByLocale).toEqual(sample.slugByLocale);
    // Once in its own slot the body is not touched again.
    expect(resyncStoredSourceLang(job)).toBe(false);
  });

  it('leaves a body already in its own language alone', () => {
    const german: any = { sourceLang: 'de', descriptionByLocale: { de: GERMAN } };
    expect(resyncStoredSourceLang(german)).toBe(false);
    expect(german).toEqual({ sourceLang: 'de', descriptionByLocale: { de: GERMAN } });
    expect(resyncStoredSourceLang({ descriptionByLocale: { de: GERMAN } })).toBe(false);
  });

  // Runners and parsers whose builder runs inside main() or a network fetch:
  // no title or slug map of theirs may name a fixed locale again.
  const files = [
    'update-cedes-jobs.mjs',
    'update-davos-klosters-bergbahnen-jobs.mjs',
    'update-has-healthcare-jobs.mjs',
    'update-hilcona-jobs.mjs',
    'update-laderach-jobs.mjs',
    'update-otis-jobs.mjs',
    'update-prada-jobs.mjs',
    'update-rapelli-jobs.mjs',
    'lib/hirslanden-job-parser.mjs',
    'lib/wuerth-international-job-parser.mjs',
  ];
  it.each(files)('%s keys no locale map by a fixed locale', (file) => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', file), 'utf8');
    expect(source).not.toMatch(/(?:title|slug|description|requirements)ByLocale:\s*\{\s*(?:en|it|de|fr)\s*:/);
    // The language comes from the body (prada: from buildPradaDescriptionFields).
    if (file !== 'update-prada-jobs.mjs') expect(source).toMatch(/sourceLangOfBody\(description, '(?:en|it|de|fr)'\)/);
  });

  it('the Hirslanden runner re-keys stored jobs before the merge', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'update-hirslanden-jobs.mjs'), 'utf8');
    expect(source).toMatch(/prepareExistingJobs:[\s\S]*resyncStoredSourceLang\(job\)/);
  });
});
