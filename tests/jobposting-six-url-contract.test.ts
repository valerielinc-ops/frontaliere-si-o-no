import { describe, expect, it } from 'vitest';
import { buildJobPostingSchema, MANDATORY_JOBPOSTING_FIELDS } from '../build-plugins/shared/jobPostingSchema';
import { JOB_POSTING_DATE_SAFE_DEFAULT } from '../scripts/lib/job-posting-date.mjs';

const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
const scope = [
  ['https://frontaliereticino.ch/cerca-lavoro-berna/mansioni-richieste-hirslanden-klinik-search-a0f5e9/', 'reported'],
  ['https://frontaliereticino.ch/cerca-lavoro-turgovia/apprendistato-come-impiegata-impiegato-in-logistica-cfc-distribuzione-recapito-misto-lettere-e-pacchi-die-daac6e/', 'reported'],
  ['https://frontaliereticino.ch/de/jobs-im-wallis/personalberater-80-100-canton-du-valais-sion/', 'unknown'],
  ['https://frontaliereticino.ch/en/find-jobs-bern/internship-in-assisted-living-interessengemeinschaft-sozialpsychiatrie-bern-bern/', 'unknown'],
  ['https://frontaliereticino.ch/en/find-jobs-vaud/100-dpi-nurse-reference-hirslanden-klinik-hirslanden-clinique-cecil/', 'reported'],
  ['https://frontaliereticino.ch/fr/trouver-emploi-soleure/mecanicien-de-maintenance-mecanicienne-de-maintenance-nouveau-batiment-oensingen-bell-schweiz-ag-oensingen/', 'unknown'],
] as const;

function readPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((cursor, segment) => (
    cursor && typeof cursor === 'object' ? (cursor as Record<string, unknown>)[segment] : undefined
  ), value);
}

describe('issue 12937 six-URL JobPosting contract', () => {
  it.each(scope)('emits all mandatory fields in four locales for %s', (issueUrl, postingDateSource) => {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const job = {
        id: issueUrl,
        title: 'Posizione attiva',
        description: 'Descrizione verificabile della posizione attiva con responsabilità, requisiti e modalità di candidatura.',
        company: 'Datore verificato',
        city: 'Bern',
        canton: 'BE',
        postingDateSource,
        datePosted: postingDateSource === 'reported' ? dayAgo : '',
        firstSeenAt: '2099-12-31T23:59:59.000Z',
        crawledAt: '2099-12-31T23:59:59.000Z',
        scrapedAt: '2099-12-31T23:59:59.000Z',
      };
      const schema = buildJobPostingSchema(job, {
        locale,
        url: issueUrl,
        now: new Date(),
      });

      expect(schema['@type']).toBe('JobPosting');
      for (const field of MANDATORY_JOBPOSTING_FIELDS) expect(readPath(schema, field), field).toBeTruthy();
      expect(schema.datePosted).toBe(postingDateSource === 'reported' ? dayAgo : JOB_POSTING_DATE_SAFE_DEFAULT);
      expect(schema.datePosted).not.toContain('2099');
    }
  });

  it('does not emit the schema-only default for an unrelated URL', () => {
    const schema = buildJobPostingSchema({
      title: 'Posizione attiva',
      description: 'Descrizione verificabile della posizione attiva con responsabilità, requisiti e modalità di candidatura.',
      company: 'Datore verificato',
      city: 'Bern',
      canton: 'BE',
      postingDateSource: 'unknown',
    }, {
      locale: 'it',
      url: 'https://frontaliereticino.ch/cerca-lavoro-berna/un-settimo-annuncio/',
      now: new Date(),
    });

    expect(schema).toBeNull();
  });
});
