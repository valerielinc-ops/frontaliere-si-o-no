import { describe, expect, it } from 'vitest';
import {
  buildSbbSourceHealth,
  fetchLoginSbbDetailUrls,
  mergeSbbJobsWithDiscoveryState,
} from '../scripts/update-sbb-jobs.mjs';

const AEM_URL = 'https://jobs.sbb.ch/v2/offene-stellen/macchinista/11111111-1111-4111-8111-111111111111';
const LOGIN_URL = 'https://www.login.org/it/123-macchinista';

function makeJob({
  id,
  url,
  title,
  slug,
}: {
  id: string;
  url: string;
  title: string;
  slug: string;
}) {
  return {
    id,
    url,
    title,
    slug,
    company: 'FFS Ferrovie federali svizzere',
    companyKey: 'ffs-officine-ferrovie-federali',
    sourceLang: 'it',
    titleByLocale: { it: title },
    description: `${title}: formazione professionale e attività operative presso le Ferrovie federali svizzere.`,
    descriptionByLocale: {
      it: `${title}: formazione professionale e attività operative presso le Ferrovie federali svizzere.`,
    },
    slugByLocale: { it: slug },
  };
}

function makeAemJob() {
  return makeJob({
    id: 'aem-stable-id',
    url: AEM_URL,
    title: 'Macchinista',
    slug: 'macchinista-ffs-bellinzona',
  });
}

function makeLoginJob() {
  return {
    ...makeJob({
      id: 'login-stable-id',
      url: LOGIN_URL,
      title: 'Apprendista macchinista',
      slug: 'apprendista-macchinista-ffs-bellinzona',
    }),
    previousSlugs: ['apprendista-macchinista-ffs-ticino'],
    previousSlugsByLocale: {
      it: ['apprendista-macchinista-ffs-ticino'],
    },
  };
}

describe('SBB secondary-source degraded contract (#6970)', () => {
  it('keeps partial pagination evidence observable instead of claiming source-zero', async () => {
    const nextHref = '/it/panoramica-dei-posti-di-tirocinio-disponibili-nel?start%3A20&facet_apprentice_partner%3ASBB%20CFF%20FFS';
    const failedPageUrl = new URL(nextHref, 'https://www.login.org').toString();
    let calls = 0;
    const fetchPageImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return [
          '<link rel="canonical" href="https://www.login.org/it/panoramica-dei-posti-di-tirocinio-disponibili-nel">',
          '<a href="/it/123-macchinista">Macchinista</a>',
          `<a href="${nextHref}">Pagina successiva</a>`,
        ].join('');
      }
      return null;
    };

    await expect(fetchLoginSbbDetailUrls({ fetchPageImpl, timeoutMs: 1000 })).resolves.toMatchObject({
      urls: [LOGIN_URL],
      sourceZero: false,
      degraded: true,
      pagesAttempted: 2,
      pagesFetched: 1,
      pagesSucceeded: 1,
      failureReason: 'listing-fetch-unavailable',
      failedPageUrl,
    });
  });

  it('persists secondary-source provenance in the summary health payload', () => {
    const sourceHealth = buildSbbSourceHealth(
      { urls: [AEM_URL], totalJobs: 1, targetJobs: 1, sourceZero: false },
      {
        urls: [LOGIN_URL],
        sourceZero: false,
        degraded: true,
        pagesAttempted: 2,
        pagesFetched: 1,
        failureReason: 'listing-fetch-unavailable',
        failedPageUrl: 'https://www.login.org/it/page-2',
      },
    );
    expect(sourceHealth).toEqual({
      status: 'degraded',
      degradedSources: ['login.org-apprenticeships'],
      sources: {
        aem: {
          id: 'sbb-aem',
          role: 'primary',
          status: 'healthy',
          sourceZero: false,
          aemUrlCount: 1,
        },
        loginOrg: {
          id: 'login.org-apprenticeships',
          role: 'secondary',
          status: 'degraded',
          sourceZero: false,
          apprenticeshipUrlCount: 1,
          pagesAttempted: 2,
          pagesFetched: 1,
          failureReason: 'listing-fetch-unavailable',
          failedPageUrl: 'https://www.login.org/it/page-2',
        },
      },
    });
  });

  it('does not advance miss streak or lose routes across three degraded runs', () => {
    let jobs: ReturnType<typeof makeJob>[] = [makeAemJob(), makeLoginJob()];
    const expectedIdentity = {
      id: 'login-stable-id',
      url: LOGIN_URL,
      slug: 'apprendista-macchinista-ffs-bellinzona',
      previousSlugs: ['apprendista-macchinista-ffs-ticino'],
    };

    for (let run = 0; run < 3; run += 1) {
      jobs = mergeSbbJobsWithDiscoveryState(
        jobs,
        [makeAemJob()],
        { loginDegraded: true },
      ).sbbJobs;
      const retained = jobs.find((job) => job.url === LOGIN_URL);
      expect(retained).toMatchObject(expectedIdentity);
      expect(retained).not.toHaveProperty('crawlerMissStreak');
    }
  });

  it('resets a prior real miss during degradation before applying the normal healthy grace period', () => {
    let jobs = [makeAemJob(), { ...makeLoginJob(), crawlerMissStreak: 1 }];

    jobs = mergeSbbJobsWithDiscoveryState(
      jobs,
      [makeAemJob()],
      { loginDegraded: true },
    ).sbbJobs;
    expect(jobs.find((job) => job.url === LOGIN_URL)).not.toHaveProperty('crawlerMissStreak');

    for (const expectedMissStreak of [1, 2]) {
      jobs = mergeSbbJobsWithDiscoveryState(
        jobs,
        [makeAemJob()],
        { loginDegraded: false },
      ).sbbJobs;
      expect(jobs.find((job) => job.url === LOGIN_URL)?.crawlerMissStreak).toBe(expectedMissStreak);
    }

    jobs = mergeSbbJobsWithDiscoveryState(
      jobs,
      [makeAemJob()],
      { loginDegraded: false },
    ).sbbJobs;
    expect(jobs.some((job) => job.url === LOGIN_URL)).toBe(false);
  });

  it('reconciles a recovered 200 without identity churn and still retires a verified removal', () => {
    const existing = [makeAemJob(), makeLoginJob()];
    const recovered = makeLoginJob();
    recovered.id = 'fresh-parser-id';
    const recoveredJobs = mergeSbbJobsWithDiscoveryState(
      existing,
      [makeAemJob(), recovered],
      { loginDegraded: false },
    ).sbbJobs;
    expect(recoveredJobs.find((job) => job.url === LOGIN_URL)).toMatchObject({
      id: 'login-stable-id',
      slug: 'apprendista-macchinista-ffs-bellinzona',
      previousSlugs: ['apprendista-macchinista-ffs-ticino'],
    });

    let healthyJobs = existing;
    for (let run = 0; run < 3; run += 1) {
      healthyJobs = mergeSbbJobsWithDiscoveryState(
        healthyJobs,
        [makeAemJob()],
        { loginDegraded: false },
      ).sbbJobs;
    }
    expect(healthyJobs.some((job) => job.url === LOGIN_URL)).toBe(false);
  });
});
