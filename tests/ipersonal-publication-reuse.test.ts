import { describe, expect, it } from 'vitest';
import { runIpersonalSpecInProduction } from '../scripts/lib/ipersonal-spec-runtime.mjs';

const DATE = `${new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)}T09:30:00+01:00`;
const FUTURE_DATE = new Date(Date.now() + 7 * 86_400_000).toISOString();
const DESCRIPTION = 'Eine ausführliche Aufgabenbeschreibung mit professioneller Verantwortung, enger Zusammenarbeit und dokumentierten Qualitätsstandards. Die Fachperson plant Einsätze, berät Kundinnen und Kunden, koordiniert Termine und hält alle Ergebnisse nachvollziehbar fest.\n• Ergebnisse zuverlässig dokumentieren';

type PreviousFields = Record<string, unknown>;

async function runOutage(previousFields: PreviousFields, identity: 'same' | 'different' | 'duplicate' = 'same') {
  const seedUrl = 'https://ipersonal-publication.example/';
  const failedUrl = `${seedUrl}jobs/failed/`;
  const acceptedUrls = Array.from({ length: 6 }, (_, index) => `${seedUrl}jobs/accepted-${index}/`);
  const previous = {
    url: identity === 'different' ? `${seedUrl}jobs/unrelated/` : failedUrl,
    title: 'Fachperson Zürich', description: DESCRIPTION,
    descriptionByLocale: { de: DESCRIPTION }, sourceLang: 'de',
    location: 'Zürich', canton: 'ZH', addressCountry: 'CH', company: 'MediPersonal',
    ...previousFields,
  };
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.endsWith('/robots.txt')) return new Response('', { status: 200 });
    if (url === seedUrl) return new Response([...acceptedUrls, failedUrl]
      .map((detailUrl) => `<a href="${detailUrl}">Fachperson Zürich</a>`).join(''));
    if (url === failedUrl) return new Response('upstream detail unavailable', { status: 500 });
    return new Response(`<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org', '@type': 'JobPosting',
      title: 'Fachperson Zürich', url, description: DESCRIPTION,
      jobLocation: { '@type': 'Place', address: {
        '@type': 'PostalAddress', addressLocality: 'Zürich', addressRegion: 'ZH', addressCountry: 'CH',
      } },
    })}</script><section class="job-profile-section"><div id="Jobdetails"><p>${DESCRIPTION}</p>
    <h3>Deine Aufgaben</h3><ul><li>Ergebnisse zuverlässig dokumentieren</li></ul></div></section>`);
  };
  const rows = await runIpersonalSpecInProduction({
    companyKey: 'ipersonal', companyName: 'MediPersonal', platform: 'med-ipersonal.ch',
    seedUrls: [seedUrl], mode: 'template', detailTemplate: '/jobs/*/', detailFetchWorkers: 1,
  }, {
    fetchImpl, lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    sleepImpl: async () => undefined, retries: 0,
    previousJobs: identity === 'duplicate' ? [previous, { ...previous }] : [previous],
  });
  expect(rows).toHaveLength(7);
  expect(rows.reusedDetailCount).toBe(1);
  expect(rows.reusedDetailUrls).toEqual([failedUrl.replace(/\/$/, '')]);
  const reused = rows.find((row) => row.url === failedUrl);
  expect(reused?.description).toBe(DESCRIPTION);
  return reused;
}

describe('iPersonal publication evidence through an exact-identity detail outage', () => {
  it.each([
    { name: 'both aliases', fields: { datePosted: DATE, postedDate: DATE } },
    { name: 'datePosted only', fields: { datePosted: DATE } },
    { name: 'postedDate only', fields: { postedDate: DATE } },
  ])('preserves reported source evidence with $name', async ({ fields }) => {
    expect(await runOutage({ ...fields, postingDateSource: 'reported' })).toMatchObject({
      datePosted: DATE, postedDate: DATE, postedAt: DATE, postingDateSource: 'reported',
    });
  });

  it.each([
    { name: 'legacy unmarked date', fields: { datePosted: DATE, postedDate: DATE } },
    { name: 'explicit unknown with stale aliases', fields: { postingDateSource: 'unknown', datePosted: DATE, postedDate: DATE } },
    { name: 'invalid reported calendar', fields: { postingDateSource: 'reported', datePosted: '2026-02-30' } },
    { name: 'future reported date', fields: { postingDateSource: 'reported', datePosted: FUTURE_DATE } },
  ])('does not promote $name', async ({ fields }) => {
    expect(await runOutage(fields)).toMatchObject({
      datePosted: '', postedDate: '', postedAt: null, postingDateSource: 'unknown',
    });
  });

  it.each(['different', 'duplicate'] as const)('rejects %s prior URL identity', async (identity) => {
    await expect(runOutage({ postingDateSource: 'reported', datePosted: DATE }, identity))
      .rejects.toThrow(/detail failure\/reuse policy rejected/);
  });
});
