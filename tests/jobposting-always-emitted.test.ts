import { describe, expect, it } from 'vitest';
import { buildJobPostingSchema, MANDATORY_JOBPOSTING_FIELDS } from '../build-plugins/shared/jobPostingSchema';

// Owner decision 2026-10-24: an active job ALWAYS emits JobPosting. This
// replaces the issue-12937 contract that granted a schema-only 1970 sentinel to
// six exact URLs (PR 13286) while every other unverified listing lost its
// JobPosting (PR 11394, 2026-10-04).
const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
const urls = [
  // the six URLs of the former allowlist …
  'https://frontaliereticino.ch/cerca-lavoro-berna/mansioni-richieste-hirslanden-klinik-search-a0f5e9/',
  'https://frontaliereticino.ch/de/jobs-im-wallis/personalberater-80-100-canton-du-valais-sion/',
  'https://frontaliereticino.ch/fr/trouver-emploi-soleure/mecanicien-de-maintenance-mecanicienne-de-maintenance-nouveau-batiment-oensingen-bell-schweiz-ag-oensingen/',
  // … and any other active listing, e.g. one that was live without JobPosting on 2026-10-24
  'https://frontaliereticino.ch/cerca-lavoro-appenzello/stagista-nella-comunicazione-aziendale-m-f-d-spitalverbund-appenzell-ausserrhoden-svar-herisau/',
  'https://frontaliereticino.ch/cerca-lavoro-berna/un-settimo-annuncio/',
] as const;

function readPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((cursor, segment) => (
    cursor && typeof cursor === 'object' ? (cursor as Record<string, unknown>)[segment] : undefined
  ), value);
}

const base = {
  title: 'Posizione attiva',
  description: 'Descrizione verificabile della posizione attiva con responsabilità, requisiti e modalità di candidatura.',
  company: 'Datore verificato',
  city: 'Bern',
  canton: 'BE',
};

describe('every active job emits JobPosting', () => {
  it.each(urls)('emits all mandatory fields in four locales for %s', (url) => {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      for (const postingDateSource of ['reported', 'unknown', undefined] as const) {
        const schema = buildJobPostingSchema({
          ...base,
          id: url,
          postingDateSource,
          datePosted: postingDateSource === 'reported' ? dayAgo : '',
        }, { locale, url, now: new Date() });
        expect(schema['@type']).toBe('JobPosting');
        for (const field of MANDATORY_JOBPOSTING_FIELDS) expect(readPath(schema, field), field).toBeTruthy();
      }
    }
  });

  // Regression of PR 11394: no verified publication date ⇒ JobPosting present,
  // datePosted = first-seen (when the listing appeared on the site).
  it('uses first-seen as datePosted when the source date is unverified', () => {
    const firstSeenAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const schema = buildJobPostingSchema({
      ...base,
      postingDateSource: 'unknown',
      datePosted: '',
      firstSeenAt,
      crawledAt: dayAgo,
    }, { locale: 'it', url: urls[3], now: new Date() });
    expect(schema.datePosted).toBe(firstSeenAt);
  });

  it('never emits a future or epoch-sentinel datePosted', () => {
    const now = new Date();
    const schema = buildJobPostingSchema({
      ...base,
      postingDateSource: 'unknown',
      firstSeenAt: '2099-12-31T23:59:59.000Z',
      crawledAt: '2099-12-31T23:59:59.000Z',
      scrapedAt: '2099-12-31T23:59:59.000Z',
    }, { locale: 'it', url: urls[0], now });
    expect(schema.datePosted).toBe(now.toISOString().slice(0, 10));
    expect(schema.datePosted).not.toContain('2099');
    expect(schema.datePosted).not.toBe('1970-01-01');
  });
});
