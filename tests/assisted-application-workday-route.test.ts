import { describe, expect, it } from 'vitest';
import {
  isWorkdayApplicationRouteBound,
  isWorkdayJobRouteBound,
  isWorkdayTenantAccountRoute,
  sameWorkdayJobRoute,
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
});
