import { describe, expect, it } from 'vitest';
import {
  isKnownDeadJobDestination,
  resolveJobApplicationUrl,
} from '../services/jobApplicationDestination';

describe('job application destination fallback', () => {
  it('moves EFG off the retired Oracle tenant', () => {
    const url = 'https://fa-eqai-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/6436';
    expect(isKnownDeadJobDestination(url)).toBe(true);
    expect(resolveJobApplicationUrl({ companyKey: 'efg-international', url })).toBe(
      'https://www.efginternational.com/us/about/careers',
    );
  });

  it('covers alternate EFG Oracle hostnames for the same employer', () => {
    expect(resolveJobApplicationUrl({
      companyKey: 'efg-international',
      url: 'https://efginternational.fa.em2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/12345',
    })).toBe('https://www.efginternational.com/us/about/careers');
  });

  it('moves UBP off the retired Oracle tenant', () => {
    const url = 'https://iaadtu.fa.ocs.oraclecloud.eu/hcmUI/CandidateExperience/en/sites/CX_1/job/383';
    expect(resolveJobApplicationUrl({ companyKey: 'ubp', applyUrl: url, url })).toBe(
      'https://www.ubp.com/en/about-us/careers/experienced-professionals',
    );
  });

  it('keeps Marriott on its live employer detail page', () => {
    const sourceUrl = 'https://careers.marriott.com/welcome-agent-intern-w-verbier/job/P1-6838759-0';
    const staleApplyUrl = 'https://ejwl.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/MI_CS_1/job/26115301/apply/email';
    expect(resolveJobApplicationUrl({ companyKey: 'marriott', url: sourceUrl, applyUrl: staleApplyUrl })).toBe(sourceUrl);
  });

  it('treats any Marriott Oracle candidate URL as stale when the detail page is live', () => {
    const sourceUrl = 'https://careers.marriott.com/welcome-agent-intern-w-verbier/job/P1-6838759-0';
    expect(resolveJobApplicationUrl({
      companyKey: 'marriott',
      url: sourceUrl,
      applyUrl: 'https://another.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/MI_CS_1/job/26115301/apply/email',
    })).toBe(sourceUrl);
  });

  it('does not replace a healthy direct application URL', () => {
    const url = 'https://careers.example.com/jobs/123/apply';
    expect(resolveJobApplicationUrl({ applyUrl: url, url: 'https://careers.example.com/jobs/123' })).toBe(url);
  });
});
