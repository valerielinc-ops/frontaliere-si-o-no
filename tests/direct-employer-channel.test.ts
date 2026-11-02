import { describe, expect, it } from 'vitest';
import {
  DIRECT_EMPLOYER_MIN_DESCRIPTION_WORDS,
  DIRECT_EMPLOYER_SOURCE_KEY,
  buildDirectEmployerJob,
  listDirectEmployerSubmissions,
  normalizeDirectEmployerSubmission,
  purgeDirectEmployerPii,
  renewDirectEmployerListing,
} from '../functions/src/directEmployerCore.js';
import { directEmployerSubmissionToRecords } from '../scripts/lib/directEmployerJobProjection.mjs';
import { projectPermanentEmployerFeed } from '../scripts/lib/permanentEmployerProjection.mjs';
import {
  filterDirectEmployerSitemapXml,
  isDirectEmployerBuildEnabled,
  isDirectEmployerSeoPath,
} from '../services/directEmployerFeature';

function daysFrom(reference: Date, days: number): Date {
  return new Date(reference.getTime() + days * 24 * 60 * 60 * 1000);
}

function description(wordCount = DIRECT_EMPLOYER_MIN_DESCRIPTION_WORDS): string {
  return Array.from({ length: wordCount }, (_, index) => `informazione-${index + 1}`).join(' ');
}

function submission(over: Record<string, unknown> = {}) {
  return {
    id: 'submission-direct-1',
    status: 'approved',
    companyName: 'Salumeria del Borgo SA',
    companyWebsite: 'https://salumeria.example.ch',
    title: 'Addetto banco gastronomia',
    locationLabel: 'Mendrisio',
    streetAddress: 'Via del Borgo 4',
    postalCode: '6850',
    canton: 'TI',
    employmentType: 'FULL_TIME',
    description: description(),
    contactEmail: 'datore@example.ch',
    approvedAt: daysFrom(new Date(), -1),
    expiresAt: daysFrom(new Date(), 29),
    ...over,
  };
}

function moderationDb(records: Array<{ id: string; data: Record<string, unknown> }>) {
  const docs = new Map(records.map(({ id, data }) => {
    const state = { ...data };
    const snapshot = { id, exists: true, data: () => state } as { id: string; exists: boolean; data: () => Record<string, unknown>; ref: { get: () => Promise<unknown>; update: (patch: Record<string, unknown>) => Promise<void> } };
    const ref = {
      get: async () => snapshot,
      update: async (patch: Record<string, unknown>) => Object.assign(state, patch),
    };
    snapshot.ref = ref;
    return [id, snapshot];
  }));
  const missing = (id: string) => ({ id, exists: false, data: () => undefined, get: async () => ({ id, exists: false, data: () => undefined }), update: async () => undefined });
  const collection = {
    doc(id: string) { return docs.get(id)?.ref || missing(id); },
    where(field: string, operator: string, value: unknown) {
      let cursor = '';
      let limit = 50;
      const query = {
        orderBy() { return query; },
        limit(value: number) { limit = value; return query; },
        startAfter(doc: { id: string }) { cursor = doc.id; return query; },
        async get() {
          const matching = [...docs.values()]
            .filter((doc) => {
              const candidate = doc.data()[field];
              if (operator === '==' && field === 'status') return candidate === value;
              if (operator === '<=') return candidate instanceof Date && candidate.getTime() <= new Date(String(value)).getTime();
              return true;
            })
            .sort((left, right) => left.id.localeCompare(right.id));
          const start = cursor ? matching.findIndex((doc) => doc.id === cursor) + 1 : 0;
          const page = matching.slice(Math.max(start, 0), Math.max(start, 0) + limit);
          return { docs: page, size: page.length, empty: page.length === 0 };
        },
      };
      return query;
    },
  };
  const updates: Array<{ ref: unknown; patch: Record<string, unknown> }> = [];
  return {
    collection: () => collection,
    batch: () => ({
      update(ref: unknown, patch: Record<string, unknown>) { updates.push({ ref, patch }); },
      commit: async () => updates.forEach(({ ref, patch }) => (ref as { update: (value: Record<string, unknown>) => Promise<void> }).update(patch)),
    }),
  };
}

describe('direct employer submission validation', () => {
  it('accepts a named employer and rejects a thin or risky submission', () => {
    const valid = normalizeDirectEmployerSubmission({
      companyName: 'Salumeria del Borgo SA',
      companyWebsite: 'https://salumeria.example.ch',
      title: 'Addetto banco gastronomia',
      locationLabel: 'Mendrisio',
      employmentType: 'FULL_TIME',
      description: description(),
      contactEmail: 'datore@example.ch',
    });
    expect(valid.ok).toBe(true);
    expect(valid.input.descriptionWordCount).toBe(DIRECT_EMPLOYER_MIN_DESCRIPTION_WORDS);

    const thin = normalizeDirectEmployerSubmission({ ...valid.input, description: description(DIRECT_EMPLOYER_MIN_DESCRIPTION_WORDS - 1) });
    expect(thin.ok).toBe(false);
    expect(thin.errors).toContain('description_too_short');

    const risky = normalizeDirectEmployerSubmission({ ...valid.input, companyName: 'Anonimo', description: `${description()} lavoro multilevel` });
    expect(risky.ok).toBe(false);
    expect(risky.errors).toEqual(expect.arrayContaining(['company_not_identifiable', 'prohibited_recruitment_copy']));
  });

  it('keeps a honeypot submission out of moderation', () => {
    const result = normalizeDirectEmployerSubmission({
      companyName: 'Officina del Lago',
      title: 'Meccanico',
      locationLabel: 'Chiasso',
      employmentType: 'FULL_TIME',
      description: description(),
      contactEmail: 'datore@example.ch',
      websiteConfirm: 'https://bot.example',
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('honeypot');
  });
});

describe('direct employer job projection', () => {
  it('emits the mandatory structured-data source fields and no contact data', () => {
    const now = new Date();
    const [record] = directEmployerSubmissionToRecords(submission(), { now });
    expect(record.source).toBe(DIRECT_EMPLOYER_SOURCE_KEY);
    expect(record.description.split(/\s+/u)).toHaveLength(DIRECT_EMPLOYER_MIN_DESCRIPTION_WORDS);
    expect(record.datePosted).toBeTruthy();
    expect(record.validThrough).toBeTruthy();
    expect(record.company).toBeTruthy();
    expect(record.location).toBeTruthy();
    expect(record.employmentType).toBe('FULL_TIME');
    expect(record.applyUrl).toMatch(/\/\?job=/u);
    expect(record).not.toHaveProperty('contactEmail');
    expect(record).not.toHaveProperty('contactPhone');
  });

  it('excludes expired and thin approved submissions from the index', () => {
    const now = new Date();
    expect(directEmployerSubmissionToRecords(submission({ expiresAt: daysFrom(now, -1) }), { now })).toEqual([]);
    expect(directEmployerSubmissionToRecords(submission({ description: description(DIRECT_EMPLOYER_MIN_DESCRIPTION_WORDS - 1) }), { now })).toEqual([]);
  });

  it('excludes an approved listing after contact retention purges its contact', () => {
    const now = new Date();
    expect(directEmployerSubmissionToRecords(submission({ contactEmail: undefined, contactPhone: undefined }), { now })).toEqual([]);
  });

  it('fills safe address and salary defaults for structured data consumers', () => {
    const job = buildDirectEmployerJob(submission({ streetAddress: '', postalCode: '', salaryMin: null, salaryMax: null }), new Date());
    expect(job.addressRegion).toBe('TI');
    expect(job.addressCountry).toBe('CH');
    expect(job.currency).toBe('CHF');
    expect(job.employmentType).toBeTruthy();
  });
});

describe('direct employer SEO flag', () => {
  it('fails closed and filters both public feature routes until explicitly enabled', () => {
    const xml = [
      '<url><loc>https://frontaliereticino.ch/pubblica-offerta-gratuita/</loc></url>',
      '<url><loc>https://frontaliereticino.ch/aziende-candidature-spontanee/</loc></url>',
      '<url><loc>https://frontaliereticino.ch/chi-siamo/</loc></url>',
    ].join('');
    expect(isDirectEmployerBuildEnabled({})).toBe(false);
    expect(isDirectEmployerSeoPath('/pubblica-offerta-gratuita/')).toBe(true);
    expect(filterDirectEmployerSitemapXml(xml, false)).not.toContain('pubblica-offerta-gratuita');
    expect(filterDirectEmployerSitemapXml(xml, false)).not.toContain('aziende-candidature-spontanee');
    expect(filterDirectEmployerSitemapXml(xml, false)).toContain('/chi-siamo/');
    expect(isDirectEmployerBuildEnabled({ DIRECT_EMPLOYER_CHANNEL_ENABLED: 'true' })).toBe(true);
    expect(filterDirectEmployerSitemapXml(xml, true)).toContain('pubblica-offerta-gratuita');
  });
});

describe('direct employer moderation retention', () => {
  it('paginates moderation results with a stable cursor', async () => {
    const db = moderationDb([
      { id: 'a', data: { status: 'pending_moderation' } },
      { id: 'b', data: { status: 'pending_moderation' } },
    ]);
    const first = await listDirectEmployerSubmissions({ db, limit: 1 });
    const second = await listDirectEmployerSubmissions({ db, limit: 1, cursor: first.nextPageToken });
    expect(first.items.map((item) => item.id)).toEqual(['a']);
    expect(second.items.map((item) => item.id)).toEqual(['b']);
    expect(second.nextPageToken).toBeNull();
  });

  it('revokes an approved listing before removing retained contact data', async () => {
    const db = moderationDb([{ id: 'approved-1', data: { status: 'approved', contactEmail: 'datore@example.ch', piiRetentionUntil: new Date(Date.now() - 86400000) } }]);
    expect(await purgeDirectEmployerPii({ db, now: new Date() })).toBe(1);
    const page = await listDirectEmployerSubmissions({ db, status: 'expired' });
    expect(page.items[0]).toMatchObject({ id: 'approved-1', status: 'expired', publicEligible: false });
  });

  it('rejects renewal after contact retention has been purged', async () => {
    const db = moderationDb([{ id: 'approved-1', data: { status: 'approved', manageTokenHash: 'kept-capability-only' } }]);
    const result = await renewDirectEmployerListing({
      submissionId: 'approved-1',
      auth: { token: { phone_number: '+41791234567' } },
      db,
      now: new Date(),
    });
    expect(result).toEqual({ ok: false, error: 'contact_retention_expired' });
  });
});

describe('prospector permanent-employer projection', () => {
  it('publishes only explicit permanent signals and strips operational fields', () => {
    const feed = projectPermanentEmployerFeed({
      updatedAt: daysFrom(new Date(), -1).toISOString(),
      candidates: {
        'salumeria.example': {
          name: 'Salumeria del Borgo SA',
          domain: 'salumeria.example',
          careersUrl: 'https://salumeria.example/candidature/',
          city: 'Mendrisio',
          permanentApplicationOnly: true,
          email: 'must-not-leak@example.test',
        },
        'ordinary.example': {
          name: 'Ordinary Employer SA',
          domain: 'ordinary.example',
          careersUrl: 'https://ordinary.example/jobs/',
          permanentApplications: [],
        },
        'insecure.example': {
          name: 'Insecure Employer SA',
          domain: '',
          careersUrl: 'http://insecure.example/',
          permanentApplications: [{ label: 'Candidatura spontanea' }],
        },
      },
    });

    expect(feed.employers).toHaveLength(1);
    expect(feed.employers[0]).toMatchObject({
      companyName: 'Salumeria del Borgo SA',
      website: 'https://salumeria.example/candidature/',
      locationLabel: 'Mendrisio',
    });
    expect(feed.employers[0]).not.toHaveProperty('email');
    expect(JSON.stringify(feed)).not.toContain('must-not-leak');
  });
});
