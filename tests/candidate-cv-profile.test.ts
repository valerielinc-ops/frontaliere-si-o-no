import { describe, expect, it, vi } from 'vitest';
import { parseCandidateCvText } from '../functions/src/candidateCvProfile.js';
import {
  proposalDocumentId,
  runApplicationConciergeMatching,
  scoreJobForProfile,
  shouldRunApplicationConciergeMatchingForServiceUpdate,
} from '../functions/src/applicationConciergeMatching.js';

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

  it('recognizes language names written in German, French and other common CV languages', () => {
    const profile = parseCandidateCvText([
      'Candidate Example',
      'Languages',
      'Deutschkenntnissen B2, Français C1, English C2',
    ].join('\n'));

    expect(profile.languages).toEqual(expect.arrayContaining(['deutsch', 'français', 'english']));
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
  it('adds a bounded locality bonus without using location as CV relevance evidence', () => {
    const profile = {
      workPosition: 'Infermiere diplomato',
      headline: 'Infermiere',
      skills: ['triage', 'assistenza pazienti'],
      experienceSummary: ['2022 - oggi reparto medicina'],
    };
    const job = { title: 'Infermiere diplomato – reparto medicina', requirements: 'triage e assistenza pazienti' };
    const relevanceOnly = scoreJobForProfile(job, profile);
    const sameLocality = scoreJobForProfile({ ...job, location: 'Mendrisio' }, profile, '6850 Mendrisio');
    const nearbyPostcode = scoreJobForProfile({ ...job, location: 'Chiasso', postalCode: '6830' }, profile, '6850 Mendrisio');
    const distantPostcode = scoreJobForProfile({ ...job, location: 'Zurigo', postalCode: '8000' }, profile, '6850 Mendrisio');

    expect(sameLocality.score).toBe(relevanceOnly.score + 8);
    expect(sameLocality.rankScore).toBe(relevanceOnly.rankScore + 8);
    expect(sameLocality.reasons).toContain('Località vicina alla zona di residenza');
    expect(nearbyPostcode.score).toBe(relevanceOnly.score + 4);
    expect(nearbyPostcode.rankScore).toBe(relevanceOnly.rankScore + 4);
    expect(distantPostcode.score).toBe(relevanceOnly.score);
    expect(distantPostcode.rankScore).toBe(relevanceOnly.rankScore);
    expect(scoreJobForProfile(job, profile).score).toBe(relevanceOnly.score);
  });

  it('keeps the proximity tie-breaker when the displayed match score is capped', () => {
    const profile = {
      workPosition: 'Technology applications management strategy director',
      headline: 'Information technology applications management strategy',
      skills: ['architecture', 'governance', 'portfolio', 'cloud', 'security', 'implementation'],
      experienceSummary: ['technology applications management strategy architecture governance portfolio'],
      languages: ['English', 'German'],
    };
    const job = {
      title: 'Technology applications management strategy director',
      requirements: 'architecture governance portfolio cloud security implementation',
      languages: ['English', 'German'],
      location: 'Mendrisio',
      postalCode: '6850',
    };
    const remote = scoreJobForProfile({ ...job, location: 'Zurich', postalCode: '8000' }, profile, '6850 Mendrisio');
    const nearby = scoreJobForProfile(job, profile, '6850 Mendrisio');

    expect(remote.score).toBe(99);
    expect(nearby.score).toBe(99);
    expect(nearby.rankScore).toBe(remote.rankScore + 8);
  });

  it('re-runs matching when the uploaded CV or the candidate locality changes', () => {
    const before = { cvStorageKey: 'application-concierge-uploads/service-1/cv.pdf', applicantLocation: 'Lugano 6900' };

    expect(shouldRunApplicationConciergeMatchingForServiceUpdate(before, { ...before, applicantLocation: 'Mendrisio 6850' })).toBe(true);
    expect(shouldRunApplicationConciergeMatchingForServiceUpdate(before, { ...before, matchingStatus: 'queued' })).toBe(false);
    expect(shouldRunApplicationConciergeMatchingForServiceUpdate(before, { ...before, cvStorageKey: 'application-concierge-uploads/service-1/new-cv.pdf' })).toBe(true);
    expect(shouldRunApplicationConciergeMatchingForServiceUpdate({ applicantLocation: 'Lugano 6900' }, { applicantLocation: 'Mendrisio 6850' })).toBe(false);
  });

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

  it('fails matching when an HTTP-200 job index has an unknown JSON shape', async () => {
    const { db, documents } = createMatchingDb({
      'application_concierge_services/service-shape': {
        userId: 'candidate-shape',
        paymentStatus: 'paid',
        serviceStatus: 'active',
        maxPositions: 10,
        acceptedPositionsCount: 0,
        expiresAt: new Date(Date.now() + 60_000),
      },
      'user_cv_profiles/candidate-shape': {
        status: 'ready',
        profile: { searchText: 'infermiere triage', workPosition: 'Infermiere', skills: ['triage'] },
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, async json() { return { error: 'upstream unavailable' }; } })));

    try {
      await expect(runApplicationConciergeMatching({
        db: db as never,
        serviceId: 'service-shape',
        jobIndexUrl: 'https://jobs.example.test/index.json',
      })).rejects.toThrow('job_index_invalid_shape');
      expect(documents.get('application_concierge_services/service-shape')).toMatchObject({
        matchingStatus: 'failed',
        matchingError: 'job_search_failed',
      });
      expect([...documents.keys()].some((path) => path.startsWith('application_concierge_services/service-shape/proposals/'))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('proposes the nearer compatible job first when the position cap is limited', async () => {
    const { db, documents } = createMatchingDb({
      'application_concierge_services/service-nearby': {
        userId: 'candidate-nearby',
        paymentStatus: 'paid',
        serviceStatus: 'active',
        maxPositions: 1,
        acceptedPositionsCount: 0,
        applicantLocation: 'Mendrisio 6850',
        expiresAt: new Date(Date.now() + 60_000),
      },
      'user_cv_profiles/candidate-nearby': {
        status: 'ready',
        profile: {
          searchText: 'infermiere triage assistenza reparto medicina',
          workPosition: 'Infermiere',
          skills: ['triage', 'assistenza'],
          experienceSummary: ['reparto medicina'],
        },
      },
    });
    const jobs = [
      { id: 'job-far', url: 'https://jobs.example.test/job-far', title: 'Infermiere reparto medicina', requirements: 'triage assistenza', location: 'Zurigo', postalCode: '8000' },
      { id: 'job-near', url: 'https://jobs.example.test/job-near', title: 'Infermiere reparto medicina', requirements: 'triage assistenza', location: 'Mendrisio', postalCode: '6850' },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, async json() { return jobs; } })));

    try {
      const result = await runApplicationConciergeMatching({ db: db as never, serviceId: 'service-nearby', jobIndexUrl: 'https://jobs.example.test/index.json' });
      const proposals = [...documents.entries()].filter(([path]) => path.startsWith('application_concierge_services/service-nearby/proposals/'));

      expect(result).toMatchObject({ status: 'complete', proposals: 1 });
      expect(proposals).toHaveLength(1);
      expect(proposals[0][1].jobId).toBe('job-near');
      expect(proposals[0][1].matchReasons).toContain('Località vicina alla zona di residenza');
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
      skills: ['governance'],
      experienceSummary: [],
    };
    const job = {
      title: 'Senior IT Manager IT Strategy and Operating Model',
      description: 'Governance responsibilities',
      company: 'Swatch Group',
      location: 'Zurigo',
    };

    const result = scoreJobForProfile(job, profile);
    const withoutLocation = scoreJobForProfile({ ...job, location: undefined }, profile);

    expect(result.score).toBe(37);
    expect(result.score).toBe(withoutLocation.score);
    expect(result.reasons).toContain('Ruolo compatibile: gestione IT');
    expect(result.reasons.join(' ').toLowerCase()).not.toMatch(/senior|manager|swatch|zurigo/);
    expect(scoreJobForProfile({ title: 'ICT Application Manager', description: 'Governance responsibilities' }, profile).score).toBe(67);
    expect(scoreJobForProfile({ title: 'Application Manager', description: 'Governance responsibilities' }, profile).score).toBe(37);
    expect(scoreJobForProfile({ title: 'IT Manager' }, {
      workPosition: 'IT Manager',
      headline: 'IT Manager',
      skills: [],
      experienceSummary: [],
    })).toEqual({ score: 0, reasons: [] });
    expect(scoreJobForProfile({ title: 'IT Manager' }, {
      workPosition: 'IT Manager',
      headline: 'IT Manager',
      skills: [],
      experienceSummary: ['2018 - 2024 IT Manager'],
    }).score).toBe(28);
  });

  it('gives a small bonus for CV languages explicitly required by a relevant role', () => {
    const profile = {
      workPosition: 'Senior IT Manager',
      headline: 'Senior IT Manager',
      skills: ['governance'],
      experienceSummary: [],
      languages: ['tedesco', 'inglese', 'francese'],
    };
    const scoreWithEvidence = (job: Record<string, unknown>) => scoreJobForProfile({
      ...job,
      description: [job.description, 'Governance'].filter(Boolean).join(' '),
    }, profile);
    const result = scoreWithEvidence({
      title: 'Senior IT Manager',
      requirements: 'Buona conoscenza del tedesco e dell’inglese richiesta.',
    });

    expect(result.score).toBe(45);
    expect(result.reasons).toContain('Lingue richieste: tedesco, inglese');
    expect(scoreWithEvidence({
      title: 'Senior IT Manager',
      requirements: 'Gute Deutschkenntnisse.',
    }).reasons).toContain('Lingue richieste: tedesco');
    expect(scoreWithEvidence({
      title: 'Senior IT Manager',
      requirements: 'Mit guten Deutschkenntnissen auf B2-Niveau.',
    }).reasons).toContain('Lingue richieste: tedesco');
    expect(scoreWithEvidence({
      title: 'Senior IT Manager',
      requirements: 'Verhandlungssicheres Deutsch und fliessendes Englisch.',
    }).reasons).toContain('Lingue richieste: tedesco, inglese');
    expect(scoreWithEvidence({
      title: 'Senior IT Manager',
      requirements: 'Mit fliessendem Deutsch und verhandlungssicherem Englisch.',
    }).reasons).toContain('Lingue richieste: tedesco, inglese');
    expect(scoreWithEvidence({
      title: 'Senior IT Manager',
      requirements: 'Languages: German, English',
    }).reasons).toContain('Lingue richieste: tedesco, inglese');
    expect(scoreWithEvidence({
      title: 'Senior IT Manager',
      requirements: 'German and English are required.',
    }).reasons).toContain('Lingue richieste: tedesco, inglese');
    expect(scoreWithEvidence({
      title: 'Senior IT Manager',
      requirements: 'Français courant exigé.',
    }).reasons).toContain('Lingue richieste: francese');
  });

  it('does not score passing language mentions or let a language requirement rescue an unrelated role', () => {
    const profile = {
      workPosition: 'Senior IT Manager',
      headline: 'Senior IT Manager',
      skills: ['governance'],
      experienceSummary: [],
      languages: ['tedesco', 'inglese', 'francese'],
    };
    const scoreWithEvidence = (job: Record<string, unknown>) => scoreJobForProfile({
      ...job,
      description: [job.description, 'Governance'].filter(Boolean).join(' '),
    }, profile);

    const passingMention = scoreWithEvidence({
      title: 'Senior IT Manager',
      description: 'IT management experience is required. German and English customers are in the portfolio.',
    });
    expect(passingMention.score).toBe(37);
    expect(passingMention.reasons).not.toContain('Lingue richieste: tedesco, inglese');
    const unrelatedRequirement = scoreWithEvidence({
      title: 'Senior IT Manager',
      description: 'Our German and English customers are a large part of the portfolio, and a degree is required.',
    });
    expect(unrelatedRequirement.score).toBe(37);
    expect(unrelatedRequirement.reasons).not.toContain('Lingue richieste: tedesco, inglese');
    const cuisineMention = scoreWithEvidence({
      title: 'Senior IT Manager',
      requirements: 'Excellent knowledge of French cuisine is required.',
    });
    expect(cuisineMention.score).toBe(37);
    expect(cuisineMention.reasons).not.toContain('Lingue richieste: francese');
    const waivedLanguage = scoreWithEvidence({
      title: 'Senior IT Manager',
      requirements: 'German proficiency is not required.',
    });
    expect(waivedLanguage.score).toBe(37);
    expect(waivedLanguage.reasons).not.toContain('Lingue richieste: tedesco');
    expect(scoreWithEvidence({
      title: 'Senior IT Manager',
      requirements: 'Languages: German and French are not required.',
    }).score).toBe(37);
    for (const requirements of ['No requirement for German.', 'No proficiency in German required.']) {
      const noLanguageRequirement = scoreWithEvidence({ title: 'Senior IT Manager', requirements });
      expect(noLanguageRequirement.score).toBe(37);
      expect(noLanguageRequirement.reasons).not.toContain('Lingue richieste: tedesco');
    }
    const contractedNoLanguageRequirement = scoreWithEvidence({
      title: 'Senior IT Manager',
      requirements: "German proficiency isn't required.",
    });
    expect(contractedNoLanguageRequirement.score).toBe(37);
    expect(contractedNoLanguageRequirement.reasons).not.toContain('Lingue richieste: tedesco');
    const mixedLanguageRequirement = scoreWithEvidence({
      title: 'Senior IT Manager',
      requirements: 'German is required, but French is not required.',
    });
    expect(mixedLanguageRequirement.score).toBe(41);
    expect(mixedLanguageRequirement.reasons).toContain('Lingue richieste: tedesco');
    expect(mixedLanguageRequirement.reasons).not.toContain('Lingue richieste: tedesco, francese');
    expect(scoreJobForProfile({
      title: 'Senior Project Manager Engineering',
      requirements: 'German and English are required.',
    }, profile)).toEqual({ score: 0, reasons: [] });
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
      skills: ['governance'],
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
      { id: 'job-it-manager', url: 'https://jobs.example.test/it-manager', title: 'Senior IT Manager IT Strategy and Operating Model', description: 'Governance responsibilities' },
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
        matchingVersion: 'cv-relevance-v4',
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
    expect(scoreJobForProfile(
      { title: 'Senior accountant', requirements: 'US GAAP and audit', location: 'Lugano', postalCode: '6900' },
      { workPosition: 'Infermiere', skills: ['triage'], experienceSummary: [] },
      'Lugano 6900',
    )).toEqual({ score: 0, reasons: [] });
  });
});
// End of focused CV workflow coverage.
