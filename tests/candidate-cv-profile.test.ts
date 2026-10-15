import { describe, expect, it, vi } from 'vitest';
import { parseCandidateCvText } from '../functions/src/candidateCvProfile.js';
import { proposalDocumentId, runApplicationConciergeMatching, scoreJobForProfile } from '../functions/src/applicationConciergeMatching.js';

function createMatchingDb(seed: Record<string, Record<string, unknown>>) {
  const documents = new Map(Object.entries(seed));
  let autoId = 0;
  const normalize = (path: string) => path.replace(/^\/+|\/+$/g, '');
  const write = (path: string, data: Record<string, unknown>, merge = false) => {
    const key = normalize(path);
    documents.set(key, merge ? { ...(documents.get(key) || {}), ...data } : { ...data });
  };
  const ref = (path: string): any => {
    const key = normalize(path);
    const parts = key.split('/');
    return {
      id: parts[parts.length - 1],
      async get() {
        return { exists: documents.has(key), data: () => documents.get(key) };
      },
      set(data: Record<string, unknown>, options?: { merge?: boolean }) {
        write(key, data, options?.merge === true);
      },
      collection(name: string) {
        return collection(`${key}/${name}`);
      },
    };
  };
  const collection = (path: string): any => {
    const key = normalize(path);
    return {
      doc(id?: string) {
        return ref(`${key}/${id || `auto-${++autoId}`}`);
      },
      async get() {
        const prefix = `${key}/`;
        return {
          docs: [...documents.keys()]
            .filter((candidate) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes('/'))
            .map((candidate) => ref(candidate)),
        };
      },
    };
  };
  return {
    db: {
      collection,
      batch() {
        const operations: Array<() => void> = [];
        return {
          set(target: any, data: Record<string, unknown>, options?: { merge?: boolean }) {
            operations.push(() => target.set(data, options));
          },
          async commit() {
            await new Promise((resolve) => setTimeout(resolve, 5));
            operations.forEach((operation) => operation());
          },
        };
      },
    },
    documents,
  };
}

describe('candidate CV profile projection', () => {
  it('extracts traceable contact, role, skills and language facts', () => {
    const profile = parseCandidateCvText(`
      Antonio Pangallo
      antonio@example.com · +41 79 123 45 67
      Infermiere diplomato
      ESPERIENZA
      2022 - oggi Infermiere reparto medicina, Lugano
      COMPETENZE
      triage, assistenza pazienti, cartella clinica
      LINGUE
      Italiano, tedesco B1
    `);

    expect(profile.fullName).toBe('Antonio Pangallo');
    expect(profile.email).toBe('antonio@example.com');
    expect(profile.phone).toContain('+41');
    expect(profile.workPosition).toContain('Infermiere');
    expect(profile.skills).toContain('triage');
    expect(profile.languages).toEqual(expect.arrayContaining(['italiano', 'tedesco']));
    expect(profile.searchText).toContain('Infermiere');
  });

  it('does not fabricate a profile from an empty or scanned document', () => {
    const profile = parseCandidateCvText('');
    expect(profile.extractedTextAvailable).toBe(false);
    expect(profile.workPosition).toBe('');
    expect(profile.skills).toEqual([]);
  });
});
describe('application concierge matching', () => {
  it('derives the same service-scoped proposal id for retries and concurrent runs', () => {
    const job = {
      id: 'job-42',
      slug: 'infermiere-lugano',
      url: 'https://jobs.example.test/job-42',
      title: 'Infermiere diplomato',
    };

    expect(proposalDocumentId('service-1', job)).toBe(proposalDocumentId('service-1', job));
    expect(proposalDocumentId('service-1', job)).not.toBe(proposalDocumentId('service-2', job));
  });

  it('converges concurrent runs to one proposal per job and respects the cap', async () => {
    const { db, documents } = createMatchingDb({
      'application_concierge_services/service-1': {
        userId: 'candidate-1',
        paymentStatus: 'paid',
        serviceStatus: 'active',
        maxPositions: 2,
        acceptedPositionsCount: 0,
        expiresAt: new Date(Date.now() + 60_000),
      },
      'user_cv_profiles/candidate-1': {
        status: 'ready',
        profile: {
          searchText: 'infermiere triage assistenza',
          workPosition: 'Infermiere',
          skills: ['triage', 'assistenza'],
          experienceSummary: ['reparto medicina'],
        },
      },
    });
    const jobs = [
      { id: 'job-1', url: 'https://jobs.example.test/job-1', title: 'Infermiere', requirements: 'triage assistenza', location: 'Lugano' },
      { id: 'job-2', url: 'https://jobs.example.test/job-2', title: 'Infermiere', requirements: 'triage assistenza', location: 'Bellinzona' },
      { id: 'job-3', url: 'https://jobs.example.test/job-3', title: 'Infermiere', requirements: 'triage assistenza', location: 'Locarno' },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, async json() { return jobs; } })));

    try {
      const results = await Promise.all([
        runApplicationConciergeMatching({ db: db as never, serviceId: 'service-1', jobIndexUrl: 'https://jobs.example.test/index.json' }),
        runApplicationConciergeMatching({ db: db as never, serviceId: 'service-1', jobIndexUrl: 'https://jobs.example.test/index.json' }),
      ]);
      const proposalPrefix = 'application_concierge_services/service-1/proposals/';
      const proposals = [...documents.entries()].filter(([path]) => path.startsWith(proposalPrefix));

      expect(results).toEqual([{ status: 'complete', proposals: 2 }, { status: 'complete', proposals: 2 }]);
      expect(proposals).toHaveLength(2);
      expect(new Set(proposals.map(([path]) => path)).size).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns an explainable match for overlapping role and skills', () => {
    const result = scoreJobForProfile(
      {
        title: 'Infermiere diplomato – reparto medicina',
        company: 'Clinica Example',
        location: 'Lugano',
        requirements: 'triage e assistenza pazienti',
      },
      {
        workPosition: 'Infermiere diplomato',
        headline: 'Infermiere',
        skills: ['triage', 'assistenza pazienti'],
        experienceSummary: ['2022 - oggi reparto medicina'],
      },
    );

    expect(result.score).toBeGreaterThan(0);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('rejects a job with no meaningful profile overlap', () => {
    const result = scoreJobForProfile(
      { title: 'Senior accountant', requirements: 'US GAAP and audit' },
      { workPosition: 'Infermiere', skills: ['triage'], experienceSummary: [] },
    );
    expect(result.score).toBe(0);
    expect(result.reasons).toEqual([]);
  });
});
// End of focused CV workflow coverage.
