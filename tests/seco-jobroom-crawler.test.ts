import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildJobPostingSchema } from '../build-plugins/shared/jobPostingSchema';
import { clearPoliteFetchStateForTests } from '../scripts/lib/prospector/polite-fetch.mjs';
import { fetchSecoAdSnapshot, fetchSecoEmployers } from '../scripts/lib/prospector/sources/seco-jobroom.mjs';
import {
  addJobsToCorpusIndex,
  buildCorpusIndex,
  emptyCorpusIndex,
  matchCorpus,
} from '../scripts/lib/seco-jobroom-corpus-index.mjs';
import {
  cantonsFromEnv,
  classifyAdvertisement,
  fetchAllSecoJobroomJobs,
  formatRunCounters,
  isTrustedDomain,
  scrubContactData,
  selectPublishableJobs,
} from '../scripts/lib/seco-jobroom-job-parser.mjs';
import { isTranslationHoldCrawlerKey } from '../scripts/lib/translation-publication-hold.mjs';

const NOW = new Date();
const day = (offset: number) => new Date(NOW.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
const BODY = Array.from({ length: 70 }, (_, i) => `aufgabe${i}`).join(' ');

function ad(id: string, overrides: Record<string, any> = {}) {
  const { jobContent = {}, publication = {}, ...rest } = overrides;
  return {
    jobAdvertisement: {
      id,
      status: 'PUBLISHED_PUBLIC',
      sourceSystem: 'API',
      fingerprint: `fp-${id}`,
      externalReference: null,
      reportingObligation: false,
      reportingObligationEndDate: null,
      ...rest,
      publication: {
        startDate: day(-3), endDate: day(50), publicDisplay: true, restrictedDisplay: true, companyAnonymous: false,
        ...publication,
      },
      jobContent: {
        externalUrl: `https://careers.acme-${id}.example/jobs/${id}`,
        jobDescriptions: [{ languageIsoCode: 'de', title: `Techniker ${id}`, description: `${BODY} ${id}` }],
        company: { name: `Acme ${id} AG`, street: 'Via Roma', houseNumber: '4', postalCode: '6900', city: 'Lugano', surrogate: false },
        employment: { workloadPercentageMin: '100', workloadPercentageMax: '100', permanent: true, shortEmployment: false },
        location: { city: 'Lugano', postalCode: '6900', cantonCode: 'TI', countryIsoCode: 'CH' },
        applyChannel: null,
        publicContact: null,
        ...jobContent,
      },
    },
  };
}

const classify = (row: unknown) => classifyAdvertisement(row, NOW) as any;
const lookupImpl = async () => [{ address: '93.184.216.34', family: 4 }];
const sleepImpl = async () => {};
const feedResponse = (url: string, status: number, body: string, total?: number) => {
  const response = new Response(body, {
    status,
    headers: total === undefined ? {} : { 'x-total-count': String(total) },
  });
  Object.defineProperty(response, 'url', { value: url });
  return response;
};

describe('classifyAdvertisement — what may be published', () => {
  it('publishes a public ad with the source fields the job page needs', () => {
    const { job } = classify(ad('a1')).candidate;
    expect(job).toMatchObject({
      companyKey: 'seco-jobroom',
      company: 'Acme a1 AG',
      employerDisclosed: true,
      url: 'https://www.job-room.ch/job-search/a1',
      applyUrl: 'https://careers.acme-a1.example/jobs/a1',
      location: 'Lugano',
      canton: 'TI',
      postalCode: '6900',
      streetAddress: 'Via Roma 4',
      employmentType: 'FULL_TIME',
      datePosted: day(-3),
      validThrough: day(50),
      sourceLang: 'de',
    });
    expect(isTrustedDomain(job.url)).toBe(true);
  });

  it('gives the JobPosting builder every field Non-Negotiable #3 requires', () => {
    const { job } = classify(ad('a2')).candidate;
    const schema = buildJobPostingSchema(job, { locale: 'it', url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/x/' }) as any;
    expect(schema.title).toBe(job.title);
    expect(schema.description.length).toBeGreaterThan(50);
    expect(schema.datePosted).toBeTruthy();
    expect(schema.hiringOrganization.name).toBe('Acme a2 AG');
    expect(schema.employmentType).toBeTruthy();
    expect(schema.baseSalary).toBeTruthy();
    const { address } = schema.jobLocation;
    expect(address.streetAddress).toBeTruthy();
    expect(address.postalCode).toBe('6900');
    expect(address.addressLocality).toBe('Lugano');
  });

  it.each([
    ['restricted status', { status: 'PUBLISHED_RESTRICTED' }],
    ['no public display', { publication: { publicDisplay: false } }],
  ])('keeps out %s', (_label, overrides) => {
    expect(classify(ad('r1', overrides)).reason).toBe('not-public');
  });

  it('keeps out the RAV window while it runs, including its last day and a missing date', () => {
    expect(classify(ad('r2', { reportingObligation: true, reportingObligationEndDate: day(3) })).reason).toBe('rav-exclusive');
    expect(classify(ad('r3', { reportingObligation: true, reportingObligationEndDate: day(1) })).reason).toBe('rav-exclusive');
    expect(classify(ad('r4', { reportingObligation: true, reportingObligationEndDate: null })).reason).toBe('rav-exclusive');
  });

  it('publishes a reportable ad once its window is over', () => {
    expect(classify(ad('r5', { reportingObligation: true, reportingObligationEndDate: day(-2) })).candidate).toBeTruthy();
  });

  it('keeps out an ad whose publication has ended and one with no Swiss workplace', () => {
    expect(classify(ad('e1', { publication: { endDate: day(-2) } })).reason).toBe('publication-ended');
    expect(classify(ad('e2', { jobContent: { location: { city: 'Vaduz', countryIsoCode: 'LI' } } })).reason).toBe('no-swiss-location');
  });

  it('never attributes an anonymous ad, whatever name the payload carries', () => {
    expect(classify(ad('n1', { publication: { companyAnonymous: true }, jobContent: { company: { name: 'ORP Martigny' } } })).reason)
      .toBe('anonymous-employer');
    expect(classify(ad('n2', { jobContent: { company: { name: 'Recruteur anonyme' } } })).reason).toBe('anonymous-employer');
  });

  it('refuses a job board as employer, not an agency posting through that board', () => {
    expect(classify(ad('b1', { jobContent: { company: { name: 'Jobup' }, externalUrl: 'https://www.jobup.ch/de/jobs/detail/1/' } })).reason)
      .toBe('job-board-as-employer');
    const agency = classify(ad('b2', { jobContent: { company: { name: 'Hamilton AG' }, externalUrl: 'https://www.jobup.ch/de/jobs/detail/2/' } }));
    expect(agency.candidate.job.company).toBe('Hamilton AG');
  });

  it('attributes an agency ad to the agency and records that the employer is not disclosed', () => {
    const { job } = classify(ad('s1', {
      jobContent: { company: { name: 'Temp Personal AG', street: 'Bahnhofstrasse', postalCode: '6900', surrogate: true } },
    })).candidate;
    expect(job).toMatchObject({ company: 'Temp Personal AG', employerDisclosed: false });
    expect(job.streetAddress).toBeUndefined();
  });

  it('prefers a real employer over the agency when the payload names one', () => {
    const { job } = classify(ad('s2', {
      jobContent: { company: { name: 'Temp Personal AG', surrogate: true }, employer: { name: 'Officine Rossi SA' } },
    })).candidate;
    expect(job).toMatchObject({ company: 'Officine Rossi SA', employerDisclosed: true });
  });

  it('does not take a head office elsewhere for the workplace', () => {
    const { job } = classify(ad('s3', {
      jobContent: { company: { name: 'Acme AG', street: 'Hauptstrasse', postalCode: '8001' } },
    })).candidate;
    expect(job.streetAddress).toBeUndefined();
    expect(job.postalCode).toBe('6900');
  });

  it('absolutises a scheme-less channel and sends a board channel to the job-room page', () => {
    const own = classify(ad('u1', { jobContent: { externalUrl: 'careers.acme.example/jobs/77' } })).candidate.job;
    expect(own.applyUrl).toBe('https://careers.acme.example/jobs/77');
    const board = classify(ad('u2', { jobContent: { externalUrl: 'www.jobscout24.ch/de/job/9' } })).candidate.job;
    expect(board.applyUrl).toBe(board.url);
    const none = classify(ad('u3', { jobContent: { externalUrl: null } })).candidate.job;
    expect(none.applyUrl).toBe(none.url);
    const form = classify(ad('u4', { jobContent: { externalUrl: null, applyChannel: { formUrl: 'https://apply.acme.example/9', emailAddress: 'x@acme.example' } } })).candidate.job;
    expect(form.applyUrl).toBe('https://apply.acme.example/9');
  });

  it('reads the workload bound and a short engagement', () => {
    const partTime = classify(ad('w1', { jobContent: { employment: { workloadPercentageMin: '40', workloadPercentageMax: '60' } } })).candidate.job;
    expect(partTime).toMatchObject({ employmentType: 'PART_TIME', contract: 'part-time' });
    const range = classify(ad('w2', { jobContent: { employment: { workloadPercentageMin: '80', workloadPercentageMax: '100' } } })).candidate.job;
    expect(range.employmentType).toBe('FULL_TIME');
    const short = classify(ad('w3', { jobContent: { employment: { workloadPercentageMax: '100', shortEmployment: true } } })).candidate.job;
    expect(short.employmentType).toBe('TEMPORARY');
  });

  it('applies the 50-word floor after the contact data is gone', () => {
    const words = Array.from({ length: 46 }, (_, i) => `wort${i}`).join(' ');
    const description = `${words}\nKontakt: Maria Muster, maria.muster@acme.example, 091 123 45 67`;
    expect(classify(ad('t1', {
      jobContent: {
        jobDescriptions: [{ languageIsoCode: 'de', title: 'Techniker', description }],
        publicContact: { firstName: 'Maria', lastName: 'Muster', email: 'maria.muster@acme.example' },
      },
    })).reason).toBe('thin-description');
  });

  it('carries no contact field into the job', () => {
    const { job } = classify(ad('p1', {
      jobContent: {
        applyChannel: { emailAddress: 'bewerbung.person@acme.example', phoneNumber: '+41911234567' },
        publicContact: { salutation: 'MS', firstName: 'Maria', lastName: 'Muster', phone: '+41911234567', email: 'maria.muster@acme.example' },
      },
    })).candidate;
    const serialized = JSON.stringify(job);
    expect(serialized).not.toMatch(/Muster|bewerbung\.person|41911234567/);
  });
});

describe('scrubContactData', () => {
  const contact = { firstName: 'Maria', lastName: 'Muster' };

  it('removes addresses, numbers and the named contact, keeping the sentence around them', () => {
    const text = 'Bewerbung bitte an unsere Personalabteilung senden, maria.muster@acme.example, sie antwortet gerne.\nTel. 091 123 45 67\nIhre Ansprechperson: Frau Maria Muster';
    const out = scrubContactData(text, contact);
    expect(out).not.toMatch(/@|123 45 67|Muster/);
    expect(out).toContain('Bewerbung bitte an unsere Personalabteilung senden');
  });

  it.each(['+41 91 123 45 67', '0041 91 123 45 67', '091/123.45.67', '079 123 45 67'])('removes %s', (number) => {
    expect(scrubContactData(`Sie erreichen uns während der Bürozeiten immer unter ${number} für alle Fragen.`)).not.toMatch(/\d{2}/);
  });

  it('does not touch a surname that is also a trade', () => {
    const text = 'Wir suchen einen Koch für unser Restaurant in Lugano.';
    expect(scrubContactData(text, { firstName: 'Anna', lastName: 'Koch' })).toBe(text);
  });

  it('removes a salutation with the surname even without the first name', () => {
    expect(scrubContactData('Für Fragen steht Ihnen Frau Muster gerne jederzeit zur Verfügung, Team Personal.', contact))
      .not.toContain('Muster');
  });

  it('removes the bare surname on a line that introduces the contact', () => {
    expect(scrubContactData('Für Auskünfte wenden Sie sich bitte an Muster aus unserem Personalbüro in Lugano.', contact))
      .not.toContain('Muster');
  });

  it('leaves dates, percentages and postal codes alone', () => {
    const text = 'Eintritt am 01.11.2026, Pensum 80-100%, Arbeitsort 6900 Lugano.';
    expect(scrubContactData(text)).toBe(text);
  });
});

describe('deduplication against the dedicated crawlers', () => {
  const dedicated = (url: string, extra: Record<string, any> = {}) => ({ url, company: 'Officine Rossi SA', title: 'Meccanico', ...extra });
  const candidate = (extra: Record<string, any> = {}) => ({
    company: 'Altra SA', title: 'Contabile', postalCode: '6500', city: 'Bellinzona', channelUrls: [], externalReference: null, ...extra,
  });

  it('matches the channel URL on the slice URL, applyUrl and stable id', () => {
    const index = addJobsToCorpusIndex(emptyCorpusIndex(), 'rossi', [
      dedicated('https://rossi.example/lavoro/meccanico-123456/', { applyUrl: 'https://apply.other.example/form/99' }),
    ]);
    addJobsToCorpusIndex(index, 'second', [dedicated('https://rossi.example/x')]);
    expect(matchCorpus(candidate({ channelUrls: ['https://rossi.example/lavoro/meccanico-123456'] }), index)).toBe('url');
    expect(matchCorpus(candidate({ channelUrls: ['https://apply.other.example/form/99'] }), index)).toBe('url');
    expect(matchCorpus(candidate({ channelUrls: ['https://rossi.example/annunci/altro-slug-123456'] }), index)).toBe('url');
  });

  it('does not take the same numeric id on another host for the same vacancy', () => {
    const index = addJobsToCorpusIndex(emptyCorpusIndex(), 'rossi', [dedicated('https://rossi.example/jobs/123456')]);
    addJobsToCorpusIndex(index, 'bianchi', [dedicated('https://rossi.example/other')]);
    expect(matchCorpus(candidate({ channelUrls: ['https://bianchi.example/jobs/123456'] }), index)).toBeNull();
  });

  it('lets a host read by one crawler claim the ad, never a shared ATS lobby or a job board', () => {
    const index = addJobsToCorpusIndex(emptyCorpusIndex(), 'rossi', [
      dedicated('https://jobs.rossi.example/1'),
      dedicated('https://ohws.prospective.ch/public/1'),
      dedicated('https://www.jobs.ch/de/stellenangebote/detail/1'),
    ]);
    addJobsToCorpusIndex(index, 'bianchi', [dedicated('https://ohws.prospective.ch/public/2')]);
    expect(matchCorpus(candidate({ channelUrls: ['https://jobs.rossi.example/nuovo'] }), index)).toBe('host');
    expect(matchCorpus(candidate({ channelUrls: ['https://ohws.prospective.ch/public/3'] }), index)).toBeNull();
    expect(matchCorpus(candidate({ channelUrls: ['https://www.jobs.ch/de/stellenangebote/detail/2'] }), index)).toBeNull();
  });

  it('matches the reference only inside the same employer', () => {
    const index = addJobsToCorpusIndex(emptyCorpusIndex(), 'rossi', [dedicated('https://rossi.example/jobs/ref-2026-77')]);
    addJobsToCorpusIndex(index, 'bianchi', [dedicated('https://rossi.example/other')]);
    expect(matchCorpus(candidate({ company: 'Officine Rossi AG', externalReference: 'ref-2026-77' }), index)).toBe('reference');
    expect(matchCorpus(candidate({ company: 'Altra SA', externalReference: 'ref-2026-77' }), index)).toBeNull();
  });

  it('matches employer, title up to the markers and place, on any stored locale', () => {
    const index = addJobsToCorpusIndex(emptyCorpusIndex(), 'rossi', [dedicated('https://rossi.example/1', {
      title: 'Mechaniker', titleByLocale: { it: 'Meccanico 80-100% (m/w/d)' }, postalCode: '6500', location: 'Bellinzona',
    })]);
    expect(matchCorpus(candidate({ company: 'Officine Rossi SA', title: 'Meccanico (m/f/d) 100%' }), index)).toBe('title');
    expect(matchCorpus(candidate({ company: 'Officine Rossi SA', title: 'Meccanico', postalCode: '6900', city: 'Lugano' }), index)).toBeNull();
    expect(matchCorpus(candidate({ company: 'Altra SA', title: 'Meccanico' }), index)).toBeNull();
  });

  describe('on disk', () => {
    let root = '';
    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'seco-corpus-')); });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it('reads the other slices and ignores its own', () => {
      const dir = path.join(root, 'data/jobs/by-crawler');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'rossi.json'), JSON.stringify({ jobs: [dedicated('https://rossi.example/1')] }));
      fs.writeFileSync(path.join(dir, 'seco-jobroom.json'), JSON.stringify({ jobs: [dedicated('https://mine.example/1')] }));
      const index = buildCorpusIndex(root, { excludeKey: 'seco-jobroom' });
      expect(index.sliceCount).toBe(1);
      expect(matchCorpus(candidate({ channelUrls: ['https://rossi.example/1'] }), index)).toBe('url');
      expect(matchCorpus(candidate({ channelUrls: ['https://mine.example/1'] }), index)).toBeNull();
    });

    it('fails rather than publish unchecked when no slice can be read', () => {
      expect(() => buildCorpusIndex(root, { excludeKey: 'seco-jobroom' })).toThrow(/no crawler slice/);
    });
  });
});

describe('selectPublishableJobs', () => {
  it('accounts for every ad read, by reason', () => {
    const index = addJobsToCorpusIndex(emptyCorpusIndex(), 'acme', [{ url: 'https://careers.acme-d1.example/jobs/d1', company: 'Acme d1 AG', title: 'x' }]);
    const twin = ad('c2');
    twin.jobAdvertisement.fingerprint = 'fp-c1';
    const rows = [
      ad('c1'),
      twin,
      ad('d1'),
      ad('r1', { reportingObligation: true, reportingObligationEndDate: day(2) }),
      ad('n1', { publication: { companyAnonymous: true } }),
    ];
    const { jobs, stats } = selectPublishableJobs(rows, { corpusIndex: index, now: NOW });
    expect(jobs.map((job: any) => job.company)).toEqual(['Acme c1 AG']);
    expect(stats).toMatchObject({ read: 5, published: 1 });
    expect(stats.deduplicated).toMatchObject({ feed: 1, url: 1 });
    expect(stats.excluded).toMatchObject({ 'rav-exclusive': 1, 'anonymous-employer': 1 });
    const total = stats.published + Object.values<number>(stats.deduplicated).reduce((a, b) => a + b, 0)
      + Object.values<number>(stats.excluded).reduce((a, b) => a + b, 0);
    expect(total).toBe(stats.read);
    expect(formatRunCounters(stats)).toBe(
      '[seco-jobroom] letti=5 pubblicabili=1 deduplicati=2 (feed=1 url=1) esclusi=2 (rav-exclusive=1 anonymous-employer=1)',
    );
  });

  it('keeps the same copy whatever the feed order', () => {
    const first = ad('k1');
    const second = ad('k2');
    second.jobAdvertisement.fingerprint = first.jobAdvertisement.fingerprint;
    const pick = (rows: unknown[]) => selectPublishableJobs(rows, { corpusIndex: emptyCorpusIndex(), now: NOW }).jobs.map((job: any) => job.id);
    expect(pick([first, second])).toEqual(pick([second, first]));
  });

  it('does not take a careers landing page shared by different roles for one vacancy', () => {
    const listing = (id: string) => ad(id, { jobContent: { externalUrl: 'https://l-agence.example/emplois' } });
    const { stats } = selectPublishableJobs([listing('l1'), listing('l2')], { corpusIndex: emptyCorpusIndex(), now: NOW });
    expect(stats.published).toBe(2);
  });

  it('collapses the same vacancy URL advertised twice', () => {
    const twin = (id: string) => ad(id, {
      jobContent: {
        externalUrl: 'https://acme.example/jobs/1',
        jobDescriptions: [{ languageIsoCode: 'de', title: 'Techniker', description: `${BODY} ${id}` }],
      },
    });
    const { stats } = selectPublishableJobs([twin('t1'), twin('t2')], { corpusIndex: emptyCorpusIndex(), now: NOW });
    expect(stats).toMatchObject({ published: 1, deduplicated: { feed: 1 } });
  });

  it('collapses one advertisement reposted word for word at the same workplace', () => {
    const copy = (id: string) => ad(id, {
      jobContent: {
        company: { name: 'Acme AG' },
        jobDescriptions: [{ languageIsoCode: 'de', title: 'Techniker (m/w/d)', description: BODY }],
      },
    });
    const { stats } = selectPublishableJobs([copy('i1'), copy('i2')], { corpusIndex: emptyCorpusIndex(), now: NOW });
    expect(stats).toMatchObject({ published: 1, deduplicated: { feed: 1 } });
  });
});

describe('fetchAllSecoJobroomJobs', () => {
  const page = (url: unknown) => Number(new URL(String(url)).searchParams.get('page'));
  const options = (fetchImpl: unknown) => ({
    now: NOW,
    cantons: ['TI'],
    corpusIndex: emptyCorpusIndex(),
    fetchOptions: { pageSize: 2, fetchImpl, lookupImpl, sleepImpl },
  });

  beforeEach(() => {
    clearPoliteFetchStateForTests();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('reads every page, checks the declared total and logs the counters', async () => {
    const pages = [[ad('f1'), ad('f2')], [ad('f3')]];
    const result = await fetchAllSecoJobroomJobs(options(
      async (url: unknown) => feedResponse(String(url), 200, JSON.stringify(pages[page(url)] || []), 3),
    ));
    expect(result).toMatchObject({ discoveredCount: 3, fetchOutcome: 'ok' });
    expect(result.jobs).toHaveLength(3);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[seco-jobroom] letti=3 pubblicabili=3'));
  });

  it('counts an ad seen on two pages once, and tolerates what the moving total explains', async () => {
    let call = 0;
    const pages = [[ad('m1'), ad('m2')], [ad('m2'), ad('m3')], [ad('m3')]];
    const result = await fetchAllSecoJobroomJobs(options(async (url: unknown) => {
      call += 1;
      return feedResponse(String(url), 200, JSON.stringify(pages[page(url)] || []), 3 + Math.min(call - 1, 1));
    }));
    expect(result.discoveredCount).toBe(3);
  });

  it('refuses a short read after one retry', async () => {
    let requests = 0;
    await expect(fetchAllSecoJobroomJobs(options(async (url: unknown) => {
      requests += 1;
      return feedResponse(String(url), 200, JSON.stringify([ad(`s${requests}`)]), 50);
    }))).rejects.toThrow(/incomplete extraction/);
    expect(requests).toBe(2);
  });

  it('refuses a snapshot with a row it could never classify, even when the total matches', async () => {
    const noId = { jobAdvertisement: { jobContent: {} } };
    const noContent = { jobAdvertisement: { id: 'x1' } };
    for (const row of [noId, noContent]) {
      clearPoliteFetchStateForTests();
      await expect(fetchAllSecoJobroomJobs(options(
        async (url: unknown) => feedResponse(String(url), 200, JSON.stringify([row]), 1),
      ))).rejects.toThrow(/malformed row/);
    }
  });

  it('refuses a read with no declared total', async () => {
    await expect(fetchAllSecoJobroomJobs(options(
      async (url: unknown) => feedResponse(String(url), 200, JSON.stringify([ad('z1')])),
    ))).rejects.toThrow(/completeness unverifiable/);
  });

  it('marks a source outage as unavailable, so the stored slice is kept', async () => {
    await expect(fetchAllSecoJobroomJobs(options(async (url: unknown) => feedResponse(String(url), 503, 'down'))))
      .rejects.toMatchObject({ feedEndpointUnavailable: true });
  });

  it('lets a refused request surface as a real failure', async () => {
    await expect(fetchAllSecoJobroomJobs(options(async (url: unknown) => feedResponse(String(url), 403, 'no'))))
      .rejects.toMatchObject({ feedEndpointUnavailable: false });
  });

  it('reports a page failure mid-sweep as partial', async () => {
    const snapshot = await fetchSecoAdSnapshot({
      cantons: ['TI'],
      pageSize: 1,
      lookupImpl,
      sleepImpl,
      fetchImpl: async (url: unknown) => (page(url) === 0
        ? feedResponse(String(url), 200, JSON.stringify([ad('p1')]), 2)
        : feedResponse(String(url), 400, 'bad')),
    });
    expect(snapshot).toMatchObject({ outcome: 'partial', errorCode: 'http_400', pagesRead: 1, firstDeclaredTotal: 2 });
  });

  it('sends the public-only search and leaves the prospector reader on the same request', async () => {
    const bodies: any[] = [];
    await fetchSecoEmployers({
      cantons: ['TI'],
      lookupImpl,
      sleepImpl,
      fetchImpl: async (url: unknown, init: any) => {
        bodies.push(JSON.parse(init.body));
        return feedResponse(String(url), 200, '[]', 0);
      },
    });
    expect(bodies[0]).toMatchObject({ displayRestricted: false, onlineSince: 30, cantonCodes: ['TI'] });
  });
});

describe('crawler configuration', () => {
  it('starts on the cantons bordering Italy and widens through the environment', () => {
    expect(cantonsFromEnv({})).toEqual(['TI', 'GR', 'VS']);
    expect(cantonsFromEnv({ SECO_JOBROOM_CANTONS: 'ti, ge, TI' })).toEqual(['TI', 'GE']);
  });

  it('stays behind the translation admission threshold', () => {
    expect(isTranslationHoldCrawlerKey('seco-jobroom')).toBe(true);
  });
});
