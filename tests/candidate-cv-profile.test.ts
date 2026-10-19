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
      data() {
        return documents.get(key);
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
      async runTransaction(callback: (transaction: any) => Promise<unknown>) {
        const operations: Array<() => void> = [];
        const transaction = {
          get: (target: any) => target.get(),
          set(target: any, data: Record<string, unknown>, options?: { merge?: boolean }) {
            operations.push(() => target.set(data, options));
          },
        };
        const result = await callback(transaction);
        operations.forEach((operation) => operation());
        return result;
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

  it('recognizes common technical and competency section headings without crossing into experience', () => {
    const profile = parseCandidateCvText([
      'Candidate Example',
      'Senior IT Manager, Group Application at Swatch Group',
      'Core Competencies',
      'SAP S/4HANA, ServiceNow, ITIL',
      'Professional Experience',
      '2020 - Present Senior IT Manager',
    ].join('\n'));

    expect(profile.skills).toEqual(['SAP S/4HANA', 'ServiceNow', 'ITIL']);
    expect(profile.workPosition).toContain('Senior IT Manager');
    expect(profile.skills).not.toContain('2020 - Present Senior IT Manager');
  });

  it('recognizes technical skills headings in English and French', () => {
    const english = parseCandidateCvText('Candidate Example\nTechnical Skills\nAzure, M365');
    const french = parseCandidateCvText('Candidate Example\nCompétences techniques\nSAP, ServiceNow');

    expect(english.skills).toEqual(['Azure', 'M365']);
    expect(french.skills).toEqual(['SAP', 'ServiceNow']);
  });

  it('keeps representative experience details as matching evidence when no skills section exists', () => {
    const profile = parseCandidateCvText([
      'Candidate Example',
      'IT Manager',
      'Professional Experience',
      '2022 - Present',
      'IT Manager',
      'Led SAP S/4HANA migration and established ServiceNow governance',
      'Coordinated application lifecycle controls across finance and supply chain',
      '2018 - 2022',
      'Application Specialist',
      'Managed CRM integrations and enterprise application support',
      'Education',
      'MBA Finance',
    ].join('\n'));

    expect(profile.skills).toEqual([]);
    expect(profile.experienceSummary).toEqual(expect.arrayContaining([
      '2022 - Present',
      '2018 - 2022',
      'Led SAP S/4HANA migration and established ServiceNow governance',
      'Managed CRM integrations and enterprise application support',
    ]));
    expect(profile.experienceSummary).not.toContain('MBA Finance');
    expect(profile.experienceSummary.length).toBeLessThanOrEqual(12);

    const longExperience = ['Candidate Example', 'Professional Experience'];
    for (let index = 0; index < 7; index += 1) {
      longExperience.push(`${2025 - index} - Present`);
      longExperience.push(`Delivered SAP platform modernization and governance for business teams ${index}`);
    }
    longExperience.push('Education', 'MBA Finance');
    const longProfile = parseCandidateCvText(longExperience.join('\n'));
    expect(longProfile.experienceSummary.length).toBeLessThanOrEqual(12);
    expect(longProfile.experienceSummary.filter((line) => line.startsWith('Delivered SAP'))).toHaveLength(6);

    const roleOnlyScore = scoreJobForProfile(
      { title: 'IT Manager', description: 'SAP S/4HANA ServiceNow governance' },
      { headline: 'IT Manager', workPosition: 'IT Manager', skills: [], experienceSummary: ['2022 - 2024'] },
    ).score;
    const evidenceScore = scoreJobForProfile(
      { title: 'IT Manager', description: 'SAP S/4HANA ServiceNow governance' },
      profile,
    ).score;
    expect(evidenceScore).toBeGreaterThan(roleOnlyScore);
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

      expect(results).toEqual([
        { status: 'complete', proposals: 2, retracted: 0 },
        { status: 'complete', proposals: 2, retracted: 0 },
      ]);
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

  it('matches an IT leadership role without letting seniority, employer or location inflate the score', () => {
    const profile = {
      workPosition: 'Senior IT Manager Group Application at Swatch Group',
      headline: 'Senior IT Manager Group Application at Swatch Group',
      skills: [],
      experienceSummary: [],
    };
    const job = {
      title: 'Senior IT Manager IT Strategy and Operating Model',
      company: 'Swatch Group',
      location: 'Zurigo',
    };

    const result = scoreJobForProfile(job, profile);
    const withoutLocation = scoreJobForProfile({ ...job, location: undefined }, profile);

    expect(result.score).toBe(28);
    expect(result.score).toBe(withoutLocation.score);
    expect(result.reasons).toContain('Ruolo compatibile: gestione IT');
    expect(result.reasons.join(' ').toLowerCase()).not.toMatch(/senior|manager|swatch|zurigo/);
    expect(scoreJobForProfile({ title: 'ICT Application Manager' }, profile).score).toBe(58);
    expect(scoreJobForProfile({ title: 'Application Manager' }, profile).score).toBe(28);
  });

  it('rejects generic manager overlap and penalizes a different job specialization', () => {
    const profile = {
      workPosition: 'Senior IT Manager Group Application at Swatch Group',
      headline: 'Senior IT Manager Group Application at Swatch Group',
      skills: [],
      experienceSummary: [],
    };

    expect(scoreJobForProfile({
      title: 'Senior Project Manager Engineering',
      company: 'Swatch Group',
      location: 'Lugano',
      description: 'Senior manager for a global group',
    }, profile)).toEqual({ score: 0, reasons: [] });
    expect(scoreJobForProfile({
      title: 'Senior IT Sales Manager Cloud M365 Cybersecurity',
    }, profile)).toEqual({ score: 0, reasons: [] });
    expect(scoreJobForProfile({
      title: 'Senior IT Project Manager',
    }, profile)).toEqual({ score: 0, reasons: [] });
    expect(scoreJobForProfile({
      title: 'ICT System Ingegnere Senior Application Platform',
    }, profile)).toEqual({ score: 0, reasons: [] });
    expect(scoreJobForProfile({
      title: 'Addetto alla ristorazione Responsabile Take it',
    }, profile)).toEqual({ score: 0, reasons: [] });
    expect(scoreJobForProfile({
      title: 'Payroll Specialist (IT/DE)',
    }, profile)).toEqual({ score: 0, reasons: [] });
    expect(scoreJobForProfile({
      title: 'Payroll Manager (IT/DE)',
    }, profile)).toEqual({ score: 0, reasons: [] });
  });

  it('does not treat CV date ranges as matching skills', () => {
    expect(scoreJobForProfile(
      { title: 'Senior Project Manager', description: 'Position available from 2024 to 2026' },
      { workPosition: 'Infermiere', skills: [], experienceSummary: ['2024 - 2026'] },
    )).toEqual({ score: 0, reasons: [] });
  });

  it('re-scores pending proposals and retracts weak legacy matches without changing decisions', async () => {
    const matchingProfile = {
      searchText: 'Senior IT Manager Group Application',
      workPosition: 'Senior IT Manager Group Application at Swatch Group',
      headline: 'Senior IT Manager Group Application at Swatch Group',
      skills: [],
      experienceSummary: [],
    };
    const { db, documents } = createMatchingDb({
      'application_concierge_services/service-1': {
        userId: 'candidate-1',
        paymentStatus: 'paid',
        serviceStatus: 'active',
        maxPositions: 10,
        acceptedPositionsCount: 0,
        expiresAt: new Date(Date.now() + 60_000),
      },
      'user_cv_profiles/candidate-1': { status: 'ready', profile: matchingProfile },
      'application_concierge_services/service-1/proposals/legacy-relevant': {
        jobId: 'job-it-manager',
        jobUrl: 'https://jobs.example.test/it-manager',
        status: 'proposed',
        matchScore: 99,
        matchReasons: ['senior, manager, group'],
      },
      'application_concierge_services/service-1/proposals/legacy-weak': {
        jobId: 'job-project-manager',
        jobUrl: 'https://jobs.example.test/project-manager',
        status: 'proposed',
        matchScore: 99,
        matchReasons: ['senior, manager'],
      },
      'application_concierge_services/service-1/proposals/already-accepted': {
        jobId: 'job-project-manager',
        jobUrl: 'https://jobs.example.test/accepted',
        status: 'accepted',
        matchScore: 99,
      },
    });
    const jobs = [
      { id: 'job-it-manager', url: 'https://jobs.example.test/it-manager', title: 'Senior IT Manager IT Strategy and Operating Model' },
      { id: 'job-project-manager', url: 'https://jobs.example.test/project-manager', title: 'Senior Project Manager Engineering' },
      { id: 'job-project-manager', url: 'https://jobs.example.test/accepted', title: 'Senior Project Manager Engineering' },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, async json() { return jobs; } })));

    try {
      const result = await runApplicationConciergeMatching({
        db: db as never,
        serviceId: 'service-1',
        jobIndexUrl: 'https://jobs.example.test/index.json',
      });
      const relevant = documents.get('application_concierge_services/service-1/proposals/legacy-relevant');
      const weak = documents.get('application_concierge_services/service-1/proposals/legacy-weak');
      const accepted = documents.get('application_concierge_services/service-1/proposals/already-accepted');

      expect(result).toEqual({ status: 'complete', proposals: 1, retracted: 1 });
      expect(relevant).toEqual(expect.objectContaining({
        status: 'proposed',
        matchingVersion: 'cv-relevance-v2',
        matchScore: expect.any(Number),
      }));
      expect((relevant?.matchScore as number)).toBeLessThan(99);
      expect(weak).toEqual(expect.objectContaining({
        status: 'retracted',
        retractionReason: 'match_below_threshold',
        matchScore: 0,
        matchReasons: [],
      }));
      expect(accepted).toEqual(expect.objectContaining({ status: 'accepted', matchScore: 99 }));
    } finally {
      vi.unstubAllGlobals();
    }
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
