import { describe, expect, it } from 'vitest';
import { ATS_BOARD_HOSTS, recognizeAts } from '../scripts/assisted-application/lib/portal/ats-recognize.mjs';

describe('ATS recognition hints', () => {
  it('carries the common ATS host table from the MIT source data', () => {
    expect(ATS_BOARD_HOSTS.length).toBeGreaterThan(150);
    expect(ATS_BOARD_HOSTS).toEqual(expect.arrayContaining([
      expect.objectContaining({ host: 'greenhouse.io', provider: 'greenhouse' }),
      expect.objectContaining({ host: 'jobs.lever.co', provider: 'lever' }),
      expect.objectContaining({ host: 'jobs.ashbyhq.com', provider: 'ashby' }),
      expect.objectContaining({ host: 'myworkdayjobs.com', provider: 'workday' }),
      expect.objectContaining({ host: 'jobs.hr.cloud.sap', provider: 'successfactors' }),
    ]));
  });

  it('recognizes canonical ATS posting links embedded on a custom careers domain', () => {
    const result = recognizeAts({
      pageUrl: 'https://careers.example.test/open-role',
      html: '<a href="https://boards.greenhouse.io/acme/jobs/REQ-42">Payroll Specialist</a>',
      job: { title: 'Payroll Specialist', requirementId: 'REQ-42' },
    });
    expect(result).toMatchObject({
      provider: 'greenhouse',
      mode: 'direct_link',
      boardHint: 'acme',
      source: 'link',
      canonicalPostingUrl: 'https://boards.greenhouse.io/acme/jobs/REQ-42',
      searchUrl: 'https://careers.example.test/search?q=REQ-42+Payroll+Specialist',
    });
  });

  it('recognizes backend routes and derives a same-host search URL for a selected posting', () => {
    expect(recognizeAts({
      pageUrl: 'https://tenant.jobs.hr.cloud.sap/job/CH/REQ-42',
      job: { title: 'Payroll Specialist', requirementId: 'REQ-42' },
    })).toMatchObject({ provider: 'successfactors', mode: 'tenant_host', source: 'route' });
    expect(recognizeAts({
      pageUrl: 'https://careers.example.test/home',
      job: { title: 'Payroll Specialist', requirementId: 'REQ-42' },
    })).toMatchObject({
      provider: '', mode: '', source: 'unknown',
      searchUrl: 'https://careers.example.test/search?q=REQ-42+Payroll+Specialist',
    });
  });

  it('decodes only a numeric IdealTraits careers board key', () => {
    expect(recognizeAts({
      pageUrl: 'https://app.idealtraits.com/Comma-Insurance/MTE2MjI5Mg==/careers',
    })).toMatchObject({ provider: 'idealtraits', mode: 'encoded_careers', boardHint: '1162292', source: 'route' });
    expect(recognizeAts({
      pageUrl: 'https://app.idealtraits.com/Acme/YWJj/careers',
    })).toMatchObject({ provider: 'idealtraits', mode: 'encoded_careers', boardHint: '', source: 'route' });
  });

  it('does not accept a non-HTTPS destination as a canonical posting', () => {
    const result = recognizeAts({
      pageUrl: 'https://careers.example.test/open-role',
      html: '<a href="http://boards.greenhouse.io/acme/jobs/REQ-42">Payroll Specialist</a>',
      job: { title: 'Payroll Specialist', requirementId: 'REQ-42' },
    });
    expect(result.canonicalPostingUrl).toBe('');
  });
});
