/**
 * #9314 (sibling of the job-alert fix) — the newsletter matcher must not redo
 * job-side work for every subscriber.
 *
 * `matchJobsForSubscriber` scores the prepared context's entries per
 * subscriber. Before #9314 its relevance scorer re-tokenized every job title,
 * re-normalized every job location (`locTokenHit`) and re-derived every job's
 * company identity keys (`sameCompanyDisplayIdentity`) once per subscriber:
 * 3.833 subscribers x up to ~20K entries in a full campaign. Those answers
 * depend only on the job and are now kept on the prepared entry.
 *
 * Observer: after one warm-up subscriber, the normalizations paid by a further
 * subscriber do not depend on the pool size (pre-#9314 they grew with it).
 * Behaviour: the existing newsletter matcher suites (company identity, location
 * pre-filter, ranking) run unchanged against the new scorer.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  matchJobsForSubscriber,
  prepareNewsletterJobContext,
} from '../services/newsletter-content.mjs';

const originalNormalize = String.prototype.normalize;
afterEach(() => {
  String.prototype.normalize = originalNormalize;
});

function countNormalizations(fn: () => unknown) {
  let count = 0;
  String.prototype.normalize = function (this: string, ...args: [string?]) {
    count++;
    return originalNormalize.apply(this, args as [string]);
  };
  try {
    fn();
  } finally {
    String.prototype.normalize = originalNormalize;
  }
  return count;
}

const COMPANIES = ['Clinica Sant’Anna SA', 'Ospedale Regionale', 'Coop Ticino', 'Banca Stato SA', 'Farmacia Centrale Sagl'];
const PLACES = ['Lugano', 'Lugano-Paradiso', 'Mendrisio', 'Chiasso', 'Bellinzona'];

function makeJobs(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    title: i % 3 === 0 ? `Infermiere reparto ${i}` : `Operatore sociosanitario ${i}`,
    company: COMPANIES[i % COMPANIES.length],
    companyKey: `azienda-${i % COMPANIES.length}`,
    location: PLACES[i % PLACES.length],
    addressLocality: i % 2 ? 'Canton Ticino' : '',
    canton: 'TI',
    category: 'Sanità',
    sector: 'Cure',
    slug: `job-${i}`,
    postedDate: new Date(Date.UTC(2026, 8, 1 + (i % 20))).toISOString(),
    description: 'Assistenza infermieristica e cure di base in reparto, turni diurni e notturni.',
  }));
}

describe('newsletter relevance scoring cost (#9314)', () => {
  it('pays job-side normalizations once per job, not once per subscriber', () => {
    const subscriber = {
      job_company: 'Clinica Sant’Anna',
      job_category: 'Sanità',
      job_slug: 'infermiere-lugano',
      locationInterest: 'Canton Ticino',
    };
    const marginal = (jobs: ReturnType<typeof makeJobs>) => {
      const context = prepareNewsletterJobContext(jobs, []);
      // Warm-up: fills the job-side answers kept on the prepared entries.
      const first = matchJobsForSubscriber(subscriber, context, 3, 'it');
      expect(first.length).toBe(3);
      return countNormalizations(() => matchJobsForSubscriber(subscriber, context, 3, 'it'));
    };
    const small = marginal(makeJobs(20));
    const large = marginal(makeJobs(120));
    // Pre-#9314: every further subscriber normalized each scored job's
    // location and company again, so `large` grew with the pool.
    expect(large).toBe(small);
  });

  it('ranks the same way with a warm and a cold prepared context', () => {
    const jobs = makeJobs(60);
    const subscribers = [
      { job_company: 'Coop Ticino', locationInterest: 'Mendrisio' },
      { job_slug: 'infermiere-bellinzona', job_category: 'Sanità' },
      { job_company: 'Banca Stato', job_search_query: 'operatore sociosanitario', locationInterest: 'lugano' },
      { locationInterest: 'Chiasso' },
      {},
    ];
    const warm = prepareNewsletterJobContext(jobs, []);
    for (const subscriber of subscribers) matchJobsForSubscriber(subscriber, warm, 3, 'it');
    for (const subscriber of subscribers) {
      const cold = prepareNewsletterJobContext(jobs, []);
      expect(matchJobsForSubscriber(subscriber, warm, 3, 'it')).toEqual(
        matchJobsForSubscriber(subscriber, cold, 3, 'it'),
      );
    }
  });
});
