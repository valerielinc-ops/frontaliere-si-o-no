import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hotelcareerEmptyEmployerPageEvidence } from '../scripts/lib/hotelcareer-employer-page.mjs';

// Real Hotelcareer employer pages (fetched 2026-10-01; scripts/styles removed,
// contact data and session ids replaced): Hotel Vereina without vacancies,
// Blatter's Hotel Arosa with one.
const fixture = (name: string) => fs.readFileSync(
  new URL(`./fixtures/hotelcareer/${name}`, import.meta.url),
  'utf8',
);
const VEREINA_PAGE = fixture('hotel-vereina-52746-no-vacancy.html');
const BLATTER_PAGE = fixture('blatter-s-hotel-arosa-4340-one-vacancy.html');
const VEREINA_PATH = '/jobs/hotel-vereina-52746';
const BLATTER_PATH = '/jobs/blatter-s-hotel-arosa-4340';

describe('hotelcareerEmptyEmployerPageEvidence', () => {
  it('reads the employer page empty-state statement as the source zero', () => {
    const evidence = hotelcareerEmptyEmployerPageEvidence(VEREINA_PAGE, VEREINA_PATH);
    expect(evidence).toContain('https://www.hotelcareer.ch/jobs/hotel-vereina-52746');
    expect(evidence).toContain('Dieses Unternehmen sucht aktuell nicht nach Verstärkung');
  });

  it('accepts the employer path with a trailing slash', () => {
    expect(hotelcareerEmptyEmployerPageEvidence(VEREINA_PAGE, `${VEREINA_PATH}/`)).not.toBeNull();
  });

  it('never reads a page that lists a vacancy as a zero', () => {
    expect(hotelcareerEmptyEmployerPageEvidence(BLATTER_PAGE, BLATTER_PATH)).toBeNull();
  });

  it('never reads another employer page as this employer zero', () => {
    expect(hotelcareerEmptyEmployerPageEvidence(VEREINA_PAGE, BLATTER_PATH)).toBeNull();
  });

  it('rejects the statement when a vacancy link below the employer path is on the page', () => {
    const withVacancy = VEREINA_PAGE.replace(
      '<div id="companyProfileMedia"',
      `<a href="${VEREINA_PATH}/chef-de-partie-3999999?rltr=comp">Chef de partie (m/w)</a><div id="companyProfileMedia"`,
    );
    expect(withVacancy).not.toBe(VEREINA_PAGE);
    expect(hotelcareerEmptyEmployerPageEvidence(withVacancy, VEREINA_PATH)).toBeNull();
  });

  it('rejects an unknown wording in the jobs box (no positive statement, no zero)', () => {
    const reworded = VEREINA_PAGE.replace('Dieses Unternehmen sucht aktuell nicht nach Verstärkung', 'Jobs werden geladen');
    expect(reworded).not.toBe(VEREINA_PAGE);
    expect(hotelcareerEmptyEmployerPageEvidence(reworded, VEREINA_PATH)).toBeNull();
  });

  it('rejects an anti-bot challenge and an empty body', () => {
    const challenge = '<html><head><title>Challenge Validation</title><link rel="canonical" '
      + `href="https://www.hotelcareer.ch${VEREINA_PATH}"></head><body><div id="companyProfileJobsSmall">`
      + 'Dieses Unternehmen sucht aktuell nicht nach Verstärkung</div>'
      + '<meta name="sec-cpt-if" content="provider=crypto"></body></html>';
    expect(hotelcareerEmptyEmployerPageEvidence(challenge, VEREINA_PATH)).toBeNull();
    expect(hotelcareerEmptyEmployerPageEvidence('', VEREINA_PATH)).toBeNull();
  });
});
