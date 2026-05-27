/**
 * FRO-585: Tests for the crawler quality score computation.
 */
import { describe, it, expect } from 'vitest';
import {
  computeJobQualityScore,
  computeCrawlerQualityAggregate,
} from '../scripts/lib/dedicated-crawler-common.mjs';

// ─── Helper: minimal job factory ─────────────────────────────────────

function makeJob(overrides: Record<string, any> = {}) {
  return {
    title: 'Software Engineer',
    company: 'TestCo AG',
    description: '## Software Engineer\n\nWe are looking for a talented software engineer to join our team in Lugano. You will work on modern web technologies including React, TypeScript, and Node.js.\n\n## Requirements\n- 3+ years experience\n- Strong TypeScript skills\n- Team player\n\n## Benefits\n- Competitive salary\n- Flexible hours',
    location: 'Lugano, Ticino',
    addressLocality: 'Lugano',
    postalCode: '6900',
    streetAddress: 'Via Nassa 15',
    url: 'https://testco.ch/jobs/123',
    companyDomain: 'testco.ch',
    postedDate: '2026-03-20',
    baseSalary: { '@type': 'MonetaryAmount', currency: 'CHF', value: { minValue: 80000, maxValue: 100000 } },
    requirements: ['TypeScript', 'React'],
    titleByLocale: {
      it: 'Ingegnere Software',
      en: 'Software Engineer',
      de: 'Softwareingenieur',
      fr: 'Ingénieur Logiciel',
    },
    descriptionByLocale: {
      it: '## Ingegnere Software\n\nCerchiamo un ingegnere software talentuoso per unirsi al nostro team a Lugano. Lavorerai su tecnologie web moderne tra cui React, TypeScript e Node.js.\n\n## Requisiti\n- 3+ anni di esperienza\n- Forti competenze TypeScript\n- Giocatore di squadra\n\n## Vantaggi\n- Stipendio competitivo\n- Orari flessibili',
      en: '## Software Engineer\n\nWe are looking for a talented software engineer to join our team in Lugano. You will work on modern web technologies including React, TypeScript, and Node.js.\n\n## Requirements\n- 3+ years experience\n- Strong TypeScript skills\n- Team player\n\n## Benefits\n- Competitive salary\n- Flexible hours',
      de: '## Softwareingenieur\n\nWir suchen einen talentierten Softwareingenieur für unser Team in Lugano. Sie arbeiten mit modernen Webtechnologien wie React, TypeScript und Node.js.\n\n## Anforderungen\n- 3+ Jahre Erfahrung\n- Starke TypeScript-Kenntnisse\n- Teamplayer\n\n## Vorteile\n- Wettbewerbsfähiges Gehalt\n- Flexible Arbeitszeiten',
      fr: '## Ingénieur Logiciel\n\nNous recherchons un ingénieur logiciel talentueux pour rejoindre notre équipe à Lugano. Vous travaillerez sur des technologies web modernes dont React, TypeScript et Node.js.\n\n## Exigences\n- 3+ ans d\'expérience\n- Compétences TypeScript solides\n- Esprit d\'équipe\n\n## Avantages\n- Salaire compétitif\n- Horaires flexibles',
    },
    slug: 'software-engineer-testco-lugano',
    ...overrides,
  };
}

// ─── computeJobQualityScore ──────────────────────────────────────────

describe('computeJobQualityScore', () => {
  it('returns a total score between 0 and 100', () => {
    const result = computeJobQualityScore(makeJob());
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(result.total).toBeLessThanOrEqual(100);
  });

  it('returns all four breakdown dimensions', () => {
    const result = computeJobQualityScore(makeJob());
    expect(result.breakdown).toHaveProperty('cleanliness');
    expect(result.breakdown).toHaveProperty('richness');
    expect(result.breakdown).toHaveProperty('translation');
    expect(result.breakdown).toHaveProperty('completeness');
  });

  it('each breakdown dimension is 0–25', () => {
    const result = computeJobQualityScore(makeJob());
    for (const key of ['cleanliness', 'richness', 'translation', 'completeness'] as const) {
      expect(result.breakdown[key]).toBeGreaterThanOrEqual(0);
      expect(result.breakdown[key]).toBeLessThanOrEqual(25);
    }
  });

  it('total equals sum of breakdown dimensions', () => {
    const result = computeJobQualityScore(makeJob());
    const sum = result.breakdown.cleanliness + result.breakdown.richness +
      result.breakdown.translation + result.breakdown.completeness;
    expect(result.total).toBe(sum);
  });

  it('scores a complete, well-translated job highly (>75)', () => {
    const result = computeJobQualityScore(makeJob());
    expect(result.total).toBeGreaterThan(75);
  });

  it('penalizes HTML residue in text cleanliness', () => {
    const clean = computeJobQualityScore(makeJob());
    const dirty = computeJobQualityScore(makeJob({
      description: '<div>Some <b>HTML</b> residue</div> with content',
    }));
    expect(dirty.breakdown.cleanliness).toBeLessThan(clean.breakdown.cleanliness);
  });

  it('penalizes script tags heavily', () => {
    const result = computeJobQualityScore(makeJob({
      description: '<script>alert("xss")</script> Job description here',
    }));
    expect(result.breakdown.cleanliness).toBeLessThanOrEqual(10);
  });

  it('penalizes encoded entities', () => {
    const clean = computeJobQualityScore(makeJob());
    const encoded = computeJobQualityScore(makeJob({
      description: 'Software &amp; Engineering &lt;position&gt; with many &quot;benefits&quot; and a lot of content to make it long enough for richness scoring to work properly across the full description field',
    }));
    expect(encoded.breakdown.cleanliness).toBeLessThan(clean.breakdown.cleanliness);
  });

  it('gives low richness to thin/empty descriptions', () => {
    const result = computeJobQualityScore(makeJob({ description: 'Short.' }));
    expect(result.breakdown.richness).toBeLessThan(10);
  });

  it('gives low translation score when only one locale is present', () => {
    const result = computeJobQualityScore(makeJob({
      titleByLocale: { it: 'Ingegnere Software' },
      descriptionByLocale: { it: 'Descrizione lunga abbastanza per passare il test di ricchezza del contenuto' },
    }));
    expect(result.breakdown.translation).toBeLessThan(10);
  });

  it('gives low translation score when titles are identical across locales', () => {
    const sameTitle = 'Software Engineer';
    const result = computeJobQualityScore(makeJob({
      titleByLocale: { it: sameTitle, en: sameTitle, de: sameTitle, fr: sameTitle },
    }));
    // Even with all locales present, identical titles get fewer differentiation points
    expect(result.breakdown.translation).toBeLessThan(25);
  });

  it('gives low completeness when salary, location data are missing', () => {
    const result = computeJobQualityScore(makeJob({
      baseSalary: null,
      salaryMin: null,
      salaryMax: null,
      postalCode: '',
      streetAddress: '',
      companyDomain: '',
      url: '',
    }));
    expect(result.breakdown.completeness).toBeLessThan(15);
  });

  it('handles completely empty job without crashing', () => {
    const result = computeJobQualityScore({});
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(result.total).toBeLessThanOrEqual(100);
    expect(result.breakdown.cleanliness).toBe(25); // No bad content = clean
    expect(result.breakdown.richness).toBe(0);
    expect(result.breakdown.translation).toBe(0);
    expect(result.breakdown.completeness).toBe(0);
  });
});

// ─── computeCrawlerQualityAggregate ──────────────────────────────────

describe('computeCrawlerQualityAggregate', () => {
  it('returns zero scores for empty job array', () => {
    const result = computeCrawlerQualityAggregate([], 'test-crawler');
    expect(result.slug).toBe('test-crawler');
    expect(result.avgScore).toBe(0);
    expect(result.jobCount).toBe(0);
    expect(result.worstJobs).toHaveLength(0);
  });

  it('computes average scores across multiple jobs', () => {
    const jobs = [makeJob(), makeJob(), makeJob()];
    const result = computeCrawlerQualityAggregate(jobs, 'test-crawler');
    expect(result.jobCount).toBe(3);
    expect(result.avgScore).toBeGreaterThan(0);
    expect(result.slug).toBe('test-crawler');
    expect(result.lastUpdated).toBeTruthy();
  });

  it('identifies worst jobs (sorted by score ascending)', () => {
    const goodJob = makeJob();
    const badJob = makeJob({
      description: 'short',
      titleByLocale: {},
      descriptionByLocale: {},
      baseSalary: null,
      postalCode: '',
      streetAddress: '',
      url: '',
      slug: 'bad-job',
    });
    const result = computeCrawlerQualityAggregate([goodJob, badJob], 'test-crawler');
    expect(result.worstJobs.length).toBeGreaterThanOrEqual(1);
    expect(result.worstJobs[0].slug).toBe('bad-job');
    expect(result.worstJobs[0].score).toBeLessThan(result.avgScore);
  });

  it('limits worst jobs to 5', () => {
    const jobs = Array.from({ length: 10 }, (_, i) => makeJob({ slug: `job-${i}` }));
    const result = computeCrawlerQualityAggregate(jobs, 'test-crawler');
    expect(result.worstJobs.length).toBeLessThanOrEqual(5);
  });

  it('includes breakdown averages', () => {
    const jobs = [makeJob(), makeJob()];
    const result = computeCrawlerQualityAggregate(jobs, 'test-crawler');
    expect(result.breakdown).toHaveProperty('cleanliness');
    expect(result.breakdown).toHaveProperty('richness');
    expect(result.breakdown).toHaveProperty('translation');
    expect(result.breakdown).toHaveProperty('completeness');
    // Each dimension average should be roughly equal for identical jobs
    expect(result.breakdown.cleanliness).toBeGreaterThan(0);
  });
});
