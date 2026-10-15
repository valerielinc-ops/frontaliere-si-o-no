import { describe, expect, it, vi } from 'vitest';
import {
  buildLastminuteSlug,
  buildLastminuteSourceJob,
  extractLastminuteLocationFromContent,
  fetchLastminuteJobDetailUrls,
  hasLastminuteNextPageSignal,
  inferLastminuteLocation,
  normalizeLastminuteRow,
  prepareExistingJobs,
  LASTMINUTE_FABRICATED_DESCRIPTION_RE,
  lastminuteSourceBody,
  parseLastminuteDeclaredTotal,
  resolveSwissLastminuteLocation,
  syncLastminuteExistingLocation,
} from '@/scripts/update-lastminute-jobs.mjs';

const RICH_SOURCE_BODY = Array.from({ length: 60 }, (_, index) => `sourceword${index}`).join(' ');

describe('lastminute location normalization', () => {
  it('extracts Chiasso from the vacancy body instead of the corporate footer address', () => {
    const description = `
      The job in brief:
      - Working model - hybrid from Chiasso
      - Location - Chiasso, Switzerland
      © lastminute.com NV Rokin 92 - 96 1012 KZ Amsterdam, Netherlands
    `;

    expect(extractLastminuteLocationFromContent(description)).toBe('Chiasso');
  });

  it('falls back to the content location when the persisted location is the Amsterdam footer', () => {
    const location = inferLastminuteLocation({
      location: '1012 KZ Amsterdam',
      description:
        'Department: Technology Location: Chiasso, Switzerland Contract: Full-time Main Language: English',
    });

    expect(location).toBe('Chiasso');
    expect(buildLastminuteSlug('Software Engineer – ETLs & Microservices', location)).toBe(
      'software-engineer-etls-microservices-chiasso'
    );
  });

  it('keeps structured address fields present without restoring a city default', () => {
    const normalized = normalizeLastminuteRow({
      title: 'Software Engineer',
      companyKey: 'lastminute-com',
      url: 'https://corporate.lastminute.com/careers/jobs/job?id=744000149000001',
      location: 'Chiasso',
      country: 'CH',
      addressLocality: 'Chiasso',
      streetAddress: 'Chiasso',
      description: RICH_SOURCE_BODY,
      titleByLocale: { en: 'Software Engineer' },
      descriptionByLocale: { en: RICH_SOURCE_BODY },
    });

    expect(normalized).toMatchObject({
      location: 'Chiasso',
      canton: 'TI',
      addressLocality: 'Chiasso',
      postalCode: '6830',
      streetAddress: 'Corso San Gottardo 84',
      addressCountry: 'CH',
    });
    expect(normalized.streetAddress).not.toBe(normalized.addressLocality);
  });

  it('rejects a Swiss municipality paired with an explicit foreign country', () => {
    expect(resolveSwissLastminuteLocation({ location: 'Chiasso, Germany' })).toBeNull();
    expect(resolveSwissLastminuteLocation({ location: 'Chiasso, DE' })).toBeNull();
  });

  it('keeps non-target-canton Swiss listings at both Lastminute location gates', () => {
    expect(resolveSwissLastminuteLocation({ location: 'Zürich', country: 'CH' })).toMatchObject({
      location: 'Zürich',
      canton: 'ZH',
    });

    expect(normalizeLastminuteRow({
      title: 'Software Engineer',
      companyKey: 'lastminute-com',
      url: 'https://corporate.lastminute.com/careers/jobs/job?id=744000149000002',
      location: 'Zürich',
      country: 'CH',
      addressLocality: 'Zürich',
      description: RICH_SOURCE_BODY,
      titleByLocale: { en: 'Software Engineer' },
      descriptionByLocale: { en: RICH_SOURCE_BODY },
    })).toMatchObject({
      location: 'Zürich',
      canton: 'ZH',
    });
  });

  it('syncs a moved job location even when its description is unchanged', () => {
    const existing = {
      location: 'Zürich',
      addressLocality: 'Zürich',
      addressRegion: 'ZH',
      postalCode: '8001',
      streetAddress: 'Bahnhofstrasse 1',
      canton: 'ZH',
      country: 'CH',
      addressCountry: 'CH',
    };

    expect(syncLastminuteExistingLocation(existing, { location: 'Chiasso', canton: 'TI' })).toBe(true);
    expect(existing).toMatchObject({
      location: 'Chiasso',
      addressLocality: 'Chiasso',
      addressRegion: 'TI',
      postalCode: '',
      streetAddress: '',
      canton: 'TI',
      country: 'CH',
      addressCountry: 'CH',
    });
  });

  it('does not invent addressCountry when the existing source row omitted it', () => {
    const existing = {
      location: 'Zürich',
      addressLocality: 'Zürich',
      addressRegion: 'ZH',
      postalCode: '8001',
      streetAddress: 'Bahnhofstrasse 1',
      canton: 'ZH',
      country: 'CH',
    };

    expect(syncLastminuteExistingLocation(existing, { location: 'Chiasso', canton: 'TI' })).toBe(true);
    expect(existing).not.toHaveProperty('addressCountry');
  });

  it('fails closed when the listing parser returns zero detail URLs', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html><body>challenge</body></html>', { status: 200 }),
    );

    try {
      await expect(fetchLastminuteJobDetailUrls()).rejects.toThrow(
        'lastminute careers listing returned no detail URLs',
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('uses the source-declared total as a completeness proof', async () => {
    const listing = `
      <div>We currently have 1 open positions</div>
      <div>1 positions found</div>
      <a href="/careers/jobs/job?id=744000149000001&jobName=Software+Engineer">job</a>
    `;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('api.smartrecruiters.com')) {
        return new Response(JSON.stringify({
          name: 'Software Engineer',
          location: { city: 'Chiasso', country: 'Switzerland' },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(listing, { status: 200 });
    });

    try {
      const result = await fetchLastminuteJobDetailUrls();
      expect(result.seedUrls).toHaveLength(1);
      expect(result.seedUrls[0]).toContain('id=744000149000001');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('fails closed when links have no terminal total or next-page signal', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        '<a href="/careers/jobs/job?id=744000149000001&jobName=Software+Engineer">job</a>',
        { status: 200 },
      ),
    );

    try {
      await expect(fetchLastminuteJobDetailUrls()).rejects.toThrow(
        'source completeness is unverified',
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('fails closed when a later listing page returns zero detail URLs', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('page=1')) {
        return new Response(
          '<a href="/careers/jobs/job?id=744000149000001&jobName=Software+Engineer">job</a>'
            + '<a rel="next" href="/careers/jobs/?page=2">next</a>',
          { status: 200 },
        );
      }
      return new Response('<html><body>challenge</body></html>', { status: 200 });
    });

    try {
      await expect(fetchLastminuteJobDetailUrls()).rejects.toThrow(
        'lastminute careers listing returned no detail URLs on page 2',
      );
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('fails closed when a later listing page cannot be fetched', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('page=1')) {
        return new Response(
          '<a href="/careers/jobs/job?id=744000149000001&jobName=Software+Engineer">job</a>'
            + '<a rel="next" href="/careers/jobs/?page=2">next</a>',
          { status: 200 },
        );
      }
      throw new Error('connection reset');
    });

    try {
      await expect(fetchLastminuteJobDetailUrls()).rejects.toThrow(
        'lastminute careers listing pagination failed on page 2',
      );
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('fails closed when a paginated page repeats only previously seen links', async () => {
    const page = '<a href="/careers/jobs/job?id=744000149000001&jobName=Software+Engineer">job</a>'
      + '<a rel="next" href="/careers/jobs/?page=2">next</a>';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(page, { status: 200 }),
    );

    try {
      await expect(fetchLastminuteJobDetailUrls()).rejects.toThrow(
        'repeated only previously seen detail URLs',
      );
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('fails closed when the source still advertises another page at the safety limit', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const page = Number(new URL(String(input)).searchParams.get('page'));
      const nextPage = page + 1;
      return new Response(
        `<a href="/careers/jobs/job?id=${744000149000000 + page}&jobName=Software+Engineer">job</a>`
          + `<a rel="next" href="/careers/jobs/?page=${nextPage}">next</a>`,
        { status: 200 },
      );
    });

    try {
      await expect(fetchLastminuteJobDetailUrls()).rejects.toThrow(
        'reached the maximum page limit 20',
      );
      expect(fetchSpy).toHaveBeenCalledTimes(20);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('recognizes an explicit next-page signal without requiring a job-count threshold', () => {
    expect(hasLastminuteNextPageSignal('<a href="/careers/jobs/?page=2">next</a>', 2)).toBe(true);
    expect(hasLastminuteNextPageSignal('<a href="/careers/jobs/job?id=744000149000001">job</a>', 2)).toBe(false);
  });

  it('parses the listing total from the source count labels', () => {
    expect(parseLastminuteDeclaredTotal('We currently have 7 open positions. 7 positions found')).toBe(7);
    expect(parseLastminuteDeclaredTotal('We currently have 1 open position')).toBe(1);
    expect(parseLastminuteDeclaredTotal('1 position found')).toBe(1);
    expect(parseLastminuteDeclaredTotal('7 open positions; 6 positions found')).toBeNull();
    expect(parseLastminuteDeclaredTotal('<div>No count available</div>')).toBeNull();
  });

  it('keeps fresh title and slug only in the detected source slot', () => {
    const job = buildLastminuteSourceJob({
      title: 'Software Engineer',
      location: 'Chiasso',
      canton: 'TI',
      description: RICH_SOURCE_BODY,
    }, 'https://corporate.lastminute.com/careers/jobs/job?id=744000149000003');

    expect(job?.sourceLang).toBe('en');
    expect(job?.titleByLocale).toEqual({ en: 'Software Engineer' });
    expect(job?.slugByLocale).toEqual({ en: 'software-engineer-chiasso' });
    expect(job?.descriptionByLocale).toEqual({ en: RICH_SOURCE_BODY });
  });

  it('uses a saved source body or rejects a thin body', () => {
    expect(normalizeLastminuteRow({
      title: 'Software Engineer',
      companyKey: 'lastminute-com',
      url: 'https://corporate.lastminute.com/careers/jobs/job?id=744000149000004',
      location: 'Chiasso',
      country: 'CH',
      description: 'too thin',
      descriptionByLocale: { en: RICH_SOURCE_BODY },
    })?.description).toBe(RICH_SOURCE_BODY);
    expect(normalizeLastminuteRow({
      title: 'Intern',
      companyKey: 'lastminute-com',
      url: 'https://corporate.lastminute.com/careers/jobs/job?id=744000149000005',
      location: 'Chiasso',
      country: 'CH',
      description: 'too thin',
      descriptionByLocale: { en: 'too thin' },
    })).toBeNull();
  });

  it('purges the complete invented intro while preserving the saved source', () => {
    const intro = 'lastminute.com cerca per la sede di Chiasso un/a Software Engineer. Scopri i dettagli della posizione e candidati online tramite il portale aziendale.';
    const legacyDescription = `${intro}\n\n---\n\n${RICH_SOURCE_BODY}`;
    expect(LASTMINUTE_FABRICATED_DESCRIPTION_RE.test(legacyDescription)).toBe(true);
    const stored = {
      companyKey: 'lastminute-com',
      company: 'lastminute.com',
      url: 'https://corporate.lastminute.com/careers/jobs/job?id=744000149000006',
      sourceLang: 'en',
      description: legacyDescription,
      descriptionByLocale: {
        en: RICH_SOURCE_BODY,
        it: legacyDescription,
        de: 'lastminute.com sucht am Standort Chiasso eine/n Software Engineer. Entdecken Sie die Details der Stelle und bewerben Sie sich online über das Unternehmensportal.',
      },
      title: 'Software Engineer',
      slug: 'software-engineer-chiasso',
      slugByLocale: { en: 'software-engineer-chiasso', it: 'software-engineer-chiasso' },
    };
    const [prepared] = prepareExistingJobs([stored]);
    expect(prepared.description).toBe(RICH_SOURCE_BODY);
    expect(prepared.descriptionByLocale.it).toBeUndefined();
    expect(prepared.descriptionByLocale.de).toBeUndefined();
    expect(lastminuteSourceBody(prepared)).toEqual({ body: RICH_SOURCE_BODY, sourceLang: 'en' });
  });
});
