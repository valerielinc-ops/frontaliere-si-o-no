import { describe, expect, it } from 'vitest';

import { matchJobsForSubscriber } from '../services/newsletter-content.mjs';

const NOW = Date.now();
const description = 'A'.repeat(220);

const intentJob = {
  id: 'intent-job',
  slug: 'alpha-accountant',
  slugByLocale: { it: 'alpha-accountant' },
  companyKey: 'alpha',
  company: 'Alpha SA',
  title: 'Senior Accountant',
  category: 'Finance',
  sector: 'Finance',
  location: 'Lugano',
  canton: 'TI',
  description,
  firstSeenAt: new Date(NOW - 20 * 86400000).toISOString(),
};

const competitor = {
  id: 'competitor',
  slug: 'accountant-finance',
  slugByLocale: { it: 'accountant-finance' },
  companyKey: 'beta',
  company: 'Beta SA',
  title: 'Accountant Finance',
  category: 'Finance',
  sector: 'Finance',
  location: 'Lugano',
  canton: 'TI',
  description,
  firstSeenAt: new Date(NOW - 2 * 86400000).toISOString(),
};

describe('newsletter matching with application intent', () => {
  it('uses a verified-account application intent as a bounded exact-job boost', () => {
    const matched = matchJobsForSubscriber({
      applicationIntent: {
        optedOut: false,
        intents: [{
          jobKey: 'alpha:alpha-accountant',
          application_status: 'redirect_only',
          timestamp: NOW - 2 * 86400000,
          retentionUntil: NOW + 20 * 86400000,
        }],
      },
    }, [intentJob, competitor], 1, 'it');

    expect(matched[0].slug).toBe('alpha-accountant');
  });

  it('does not use the signal after its purpose-specific opt-out', () => {
    const matched = matchJobsForSubscriber({
      applicationIntent: {
        optedOut: true,
        intents: [{
          jobKey: 'alpha:alpha-accountant',
          application_status: 'redirect_only',
          timestamp: NOW - 2 * 86400000,
          retentionUntil: NOW + 20 * 86400000,
        }],
      },
    }, [intentJob, competitor], 1, 'it');

    expect(matched[0].slug).toBe('accountant-finance');
  });
});
