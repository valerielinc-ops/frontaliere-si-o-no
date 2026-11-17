import { describe, expect, it } from 'vitest';
import {
  isWorkdayApplicationRouteBound,
  isWorkdayJobRouteBound,
  isWorkdayTenantAccountRoute,
  sameWorkdayJobRoute,
  workdayBareLocaleFallbackUrl,
  workdayJobRoute,
  workdayManualApplicationUrl,
} from '../scripts/assisted-application/lib/portal/workday-route.mjs';

const applyUrl = 'https://acme.wd3.myworkdayjobs.com/fr-FR/AcmeCareers/job/Mendrisio%2C-Outlet/Consultant_R-12345-1/apply/applyManually';

describe('Workday tenant account routes', () => {
  it.each(['login', 'createAccount', 'forgotPassword', 'passwordreset', 'resetPassword', 'verifyEmail', 'activate'])(
    'recognizes the same-site account route %s', (route) => {
      expect(isWorkdayTenantAccountRoute(`https://acme.wd3.myworkdayjobs.com/fr-FR/AcmeCareers/${route}`, applyUrl)).toBe(true);
    },
  );

  it('uses the same site parser when the account route omits the locale segment', () => {
    expect(isWorkdayTenantAccountRoute('https://acme.wd3.myworkdayjobs.com/AcmeCareers/login', applyUrl)).toBe(true);
  });

  it.each([
    'https://acme.wd3.myworkdayjobs.com/fr-FR/OtherSite/login',
    'https://other.wd3.myworkdayjobs.com/fr-FR/AcmeCareers/login',
    'https://acme.wd3.myworkdayjobs.com/fr-FR/AcmeCareers/introduceYourself',
    'https://acme.wd3.myworkdayjobs.com/fr-FR/AcmeCareers/job/Other-Location/Consultant_R-54321-2',
    'https://acme.wd3.myworkdayjobs.com/fr-FR/AcmeCareers/account/login',
  ])('rejects an unrelated route: %s', (pageUrl) => {
    expect(isWorkdayTenantAccountRoute(pageUrl, applyUrl)).toBe(false);
    expect(isWorkdayJobRouteBound(pageUrl, applyUrl)).toBe(false);
  });

  it('requires HTTPS and rejects credentials or fragments', () => {
    expect(isWorkdayTenantAccountRoute('http://acme.wd3.myworkdayjobs.com/fr-FR/AcmeCareers/login', applyUrl)).toBe(false);
    expect(isWorkdayTenantAccountRoute('https://user:pass@acme.wd3.myworkdayjobs.com/fr-FR/AcmeCareers/login', applyUrl)).toBe(false);
    expect(isWorkdayTenantAccountRoute('https://acme.wd3.myworkdayjobs.com/fr-FR/AcmeCareers/login#account', applyUrl)).toBe(false);
  });

  it('builds one canonical manual-apply URL tied to the selected requisition', () => {
    expect(workdayManualApplicationUrl(applyUrl)).toBe(applyUrl);
    expect(workdayManualApplicationUrl(applyUrl.replace('/apply/applyManually', '')))
      .toBe(applyUrl);
    expect(isWorkdayApplicationRouteBound(workdayManualApplicationUrl(applyUrl), applyUrl)).toBe(true);
  });

  it.each([
    'https://acme.wd3.myworkdayjobs.com/en-US/AcmeCareers/job/Lugano/Verkaufsberater_R15163',
    'https://acme.wd3.myworkdayjobs.com/en-US/AcmeCareers/job/Lugano/Store-Assistant_JR01234-1',
    'https://roche.wd3.myworkdayjobs.com/en-US/roche-ext/job/Basel/Technical-Product-Owner_202606-116471-2',
  ])('recognizes Workday requisition-id variants: %s', (postingUrl) => {
    expect(workdayJobRoute(postingUrl)).not.toBeNull();
    expect(isWorkdayJobRouteBound(`${postingUrl}/apply`, postingUrl)).toBe(true);
  });

  it.each([
    'https://roche.wd3.myworkdayjobs.com/en-US/roche-ext/details/Spcialiste-Biostatistiques---Data-Science-Mdical',
    'https://roche.wd3.myworkdayjobs.com/en-US/roche-ext/details/Technical-Product-Owner--Sites--SHE---Sustainability_202606-116471-2',
  ])('recognizes the Workday details posting route: %s', (detailsUrl) => {
    const route = workdayJobRoute(detailsUrl);
    expect(route).toMatchObject({ location: [], suffix: '' });
    expect(isWorkdayJobRouteBound(`${detailsUrl}/apply/applyManually`, detailsUrl)).toBe(true);
    expect(workdayManualApplicationUrl(detailsUrl)).toBe(`${detailsUrl}/apply/applyManually`);
  });

  it('binds a Workday details route to the same requisition job route', () => {
    const jobRoute = 'https://roche.wd3.myworkdayjobs.com/en-US/roche-ext/job/Basel/Technical-Product-Owner_202606-116471-2';
    const detailsRoute = 'https://roche.wd3.myworkdayjobs.com/en-US/roche-ext/details/Technical-Product-Owner_202606-116471-2';
    expect(sameWorkdayJobRoute(workdayJobRoute(jobRoute), workdayJobRoute(detailsRoute))).toBe(true);
  });

  it('strips a bare two-letter Workday locale segment as fallback', () => {
    expect(workdayBareLocaleFallbackUrl(
      'https://roche.wd3.myworkdayjobs.com/en/roche-ext/job/Rotkreuz/Associate-Business-Product-Owner_202611-128370-1',
    )).toBe('https://roche.wd3.myworkdayjobs.com/roche-ext/job/Rotkreuz/Associate-Business-Product-Owner_202611-128370-1');
    expect(workdayBareLocaleFallbackUrl(applyUrl)).toBe('');
  });

  it('recognizes Continue Application on a bound Workday requisition route', async () => {
    const { applicationEntryControls } = await import('../scripts/assisted-application/lib/portal/portal.mjs');
    const url = 'https://rituals.wd3.myworkdayjobs.com/en-US/Rituals/job/Sion/Conseiller-de-Vente--h-f-_R2420';
    const cont = { text: 'Continue Application', frame: 0 };
    expect(applicationEntryControls({
      url,
      fields: [],
      buttons: [cont, { text: 'Candidate Home', frame: 0 }],
    }, { applyUrl: url, postingUrl: url, allowSingleExternalApplicationEntry: true })).toEqual([cont]);
    expect(applicationEntryControls({
      url: 'https://rituals.wd3.myworkdayjobs.com/en-US/Rituals/job/Other/Role_R9999',
      fields: [],
      buttons: [cont],
    }, { applyUrl: url, postingUrl: url, allowSingleExternalApplicationEntry: true })).toEqual([]);
  });

  it('maps Workday From* and To* profile date fields to start and end', async () => {
    const { profileEntryAnswer } = await import('../scripts/assisted-application/lib/portal/portal.mjs');
    const entry = { role: 'Consultant', employer: 'ACME', start: '2021-03', end: '2024-06' };
    expect(profileEntryAnswer(entry, 'experience', { label: 'From*' })).toEqual({ value: '2021-03', source: 'profile' });
    expect(profileEntryAnswer(entry, 'experience', { label: 'To*' })).toEqual({ value: '2024-06', source: 'profile' });
    expect(profileEntryAnswer(entry, 'education', { label: 'From*' })).toEqual({ value: '2021-03', source: 'profile' });
  });

  it('clears prefilled Workday spinbuttons before writing Month and Year', async () => {
    const { fillWorkdayDate } = await import('../scripts/assisted-application/lib/portal/fill.mjs');
    const state = { Month: '03', Year: '2024' };
    const makeSpin = (key: 'Month' | 'Year') => ({
      count: async () => 1,
      first: () => makeSpin(key),
      evaluate: async () => true,
      fill: async (v: string) => { state[key] = v; },
      press: async () => {},
    });
    const wrapper = {
      locator: (sel: string) => {
        if (sel.includes('Month')) return makeSpin('Month');
        if (sel.includes('Year')) return makeSpin('Year');
        return { count: async () => 2, nth: (i: number) => makeSpin(i === 0 ? 'Month' : 'Year') };
      },
    };
    await fillWorkdayDate(wrapper as any, '05/2024');
    expect(state).toEqual({ Month: '05', Year: '2024' });
  });
});
